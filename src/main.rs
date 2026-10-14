//! CASE — Claude Account Switcher Engine.
//!
//! A profile directory *is* an account: point Claude Desktop's userData at one
//! and the signed-in account lives there. Which knob does the pointing has
//! changed with Claude's builds — platform::launch_claude carries the current
//! answer. There is no single-instance lock in Claude, so profiles run side by
//! side.

// No console window behind a release build on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod archive;
mod chrome;
mod health;
mod platform;
mod store;
mod tray;
mod update;
mod usage;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use store::Account;
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

/// The bundle identifier, and on Windows the AppUserModelID toasts are matched by.
pub const APP_ID: &str = "local.launcher.case";

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// The profile Claude uses when nothing points it elsewhere — Application
/// Support on a Mac and %APPDATA% on Windows.
fn default_profile() -> PathBuf {
    platform::app_data().join("Claude")
}

fn is_default(a: &Account) -> bool {
    a.dir == default_profile()
}

// ---------------------------------------------------------------- runtime ---

/// What the app knows that is not in accounts.json. Never held across a call
/// into a window, the tray or a plugin: those may wait on the main thread, which
/// may be waiting on this.
#[derive(Default)]
struct Runtime {
    /// The accelerator actually registered, which is not the setting: a shortcut
    /// another app owns stays in the settings but does nothing.
    hotkey: Option<String>,
    last_update: Option<update::Check>,
    /// Banners the renderer shows need room the account count does not account for.
    extra_height: f64,
    seen_issues: HashSet<String>,
    issue_count: usize,
    /// Launched at login, the point is to be ready for the hotkey, not to appear.
    start_hidden: bool,
}

static RT: LazyLock<Mutex<Runtime>> = LazyLock::new(Default::default);

fn rt() -> MutexGuard<'static, Runtime> {
    RT.lock().unwrap_or_else(|e| e.into_inner())
}

// ----------------------------------------------------------------- probing ---

#[derive(Serialize)]
struct Status {
    id: String,
    running: bool,
    sessions: usize,
    exists: bool,
    usage: Option<usage::Usage>,
}

fn session_count(dir: &Path) -> usize {
    let entries = |d: &Path| std::fs::read_dir(d).into_iter().flatten().flatten();
    entries(&dir.join("claude-code-sessions"))
        .flat_map(|acct| entries(&acct.path()).collect::<Vec<_>>())
        .flat_map(|org| entries(&org.path()).collect::<Vec<_>>())
        .filter(|f| {
            let n = f.file_name();
            let n = n.to_string_lossy();
            n.starts_with("local_") && n.ends_with(".json")
        })
        .count()
}

/// Running state, session counts and usage, one thread per account: on a Mac
/// each running check is a handful of lsof calls, the slowest thing this app does.
fn probe(accounts: &[Account]) -> Vec<Status> {
    std::thread::scope(|s| {
        let probes: Vec<_> = accounts
            .iter()
            .map(|a| {
                s.spawn(move || Status {
                    id: a.id.clone(),
                    running: platform::is_running(&a.dir),
                    sessions: session_count(&a.dir),
                    exists: a.dir.exists(),
                    usage: usage::read(&a.dir),
                })
            })
            .collect();
        probes
            .into_iter()
            .map(|h| h.join().expect("probe thread"))
            .collect()
    })
}

/// Recency order, when it is switched on. The sort is stable, so accounts that
/// have never been opened keep their configured order at the bottom.
fn sorted(accounts: &[Account]) -> Vec<Account> {
    let mut list = accounts.to_vec();
    if store::settings().sort_by_recent {
        list.sort_by_key(|a| std::cmp::Reverse(a.last_used_at.unwrap_or(0)));
    }
    list
}

fn merged(a: &Account, extra: impl Serialize) -> Value {
    let mut v = serde_json::to_value(a).unwrap_or_default();
    if let (Some(o), Value::Object(e)) = (
        v.as_object_mut(),
        serde_json::to_value(extra).unwrap_or_default(),
    ) {
        o.extend(e);
    }
    v
}

/// Config order and flags only — no probing, so it returns immediately.
fn stored_list(accounts: &[Account]) -> Vec<Value> {
    sorted(accounts)
        .iter()
        .map(|a| merged(a, json!({ "isDefault": is_default(a) })))
        .collect()
}

/// The list with everything probed folded in.
fn decorated(accounts: &[Account]) -> Vec<Value> {
    let list = sorted(accounts);
    let status = probe(&list);
    list.iter()
        .zip(status)
        .map(|(a, s)| {
            let mut v = merged(a, s);
            v["isDefault"] = is_default(a).into();
            v
        })
        .collect()
}

fn find(id: &str) -> Option<Account> {
    store::accounts()?.into_iter().find(|a| a.id == id)
}

fn error(msg: impl Into<String>) -> Value {
    json!({ "error": msg.into() })
}

// Claude's own, and not an account: on Windows it keeps the third-party config
// library in %LOCALAPPDATA%\Claude-3p, which the prefix scan below would
// otherwise offer up as an account called "3p".
const NOT_A_PROFILE: &str = "Claude-3p";

/// Profiles present on disk that the config does not know about yet.
fn discover_profiles() -> Vec<Value> {
    let mut found = Vec::new();
    if default_profile().exists() {
        found.push(json!({ "name": "Main", "dir": default_profile(), "isDefault": true }));
    }
    let mut roots = vec![platform::app_data()];
    if !roots.contains(&platform::profile_root()) {
        roots.push(platform::profile_root());
    }
    for root in roots {
        let mut names: Vec<String> = std::fs::read_dir(&root)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            // An archived profile is deliberately set aside; offering it back here
            // would undo the archive by accident.
            .filter(|n| {
                n.starts_with("Claude-") && n != NOT_A_PROFILE && !archive::is_archive_path(n)
            })
            .collect();
        names.sort();
        for n in names {
            found.push(
                json!({ "name": &n["Claude-".len()..], "dir": root.join(&n), "isDefault": false }),
            );
        }
    }
    found
}

// ---------------------------------------------------------------- launching ---

/// Stamp an account as just used. Activating a running one counts.
fn touch(id: &str) {
    store::edit(|c| {
        if let Some(a) = c.accounts_mut().iter_mut().find(|a| a.id == id) {
            a.last_used_at = Some(now_ms());
        }
    });
}

fn launch_account(a: &Account) -> Value {
    touch(&a.id);
    if platform::is_running(&a.dir) {
        // Two instances on one profile corrupt its LevelDB stores, so this fronts
        // the one already open rather than starting a second.
        platform::activate_profile(&a.dir);
        open_paired_chrome(a);
        return json!({ "ok": true, "alreadyRunning": true });
    }
    // Snapshot the session index before handing control to Claude. This is the
    // cheap insurance against the failure mode health.rs exists to catch.
    let _ = health::backup_index(a, &store::backup_root());
    let _ = std::fs::create_dir_all(&a.dir);
    let launched = platform::launch_claude(&a.dir, is_default(a));
    open_paired_chrome(a);
    json!({ "ok": launched.is_ok(), "error": launched.err().flatten(), "alreadyRunning": false })
}

/// Bring the account's browser context along, if one is paired and enabled.
fn open_paired_chrome(a: &Account) {
    if let Some(c) = a
        .chrome
        .as_ref()
        .filter(|c| c.open_on_launch && !c.dir.is_empty())
    {
        chrome::launch(&c.dir, None);
    }
}

/// A folder name from an account name. Letters outside ASCII are kept rather
/// than folded: both filesystems take them, and folding without a Unicode
/// normaliser would only turn "Café" into "Caf".
fn slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.chars() {
        if c.is_alphanumeric() {
            s.push(c);
        } else if !s.ends_with('-') {
            s.push('-');
        }
    }
    let s: String = s.trim_matches('-').chars().take(40).collect();
    if s.is_empty() { "account".into() } else { s }
}

fn unique_dir(name: &str) -> PathBuf {
    let base = format!("Claude-{}", slug(name));
    let root = platform::profile_root();
    (1..)
        .map(|i| {
            root.join(if i == 1 {
                base.clone()
            } else {
                format!("{base}-{i}")
            })
        })
        .find(|d| !d.exists())
        .expect("a free name")
}

/// A name not already taken, for restoring an archive alongside a namesake.
fn free_name(name: &str, accounts: &[Account]) -> String {
    let taken: HashSet<String> = accounts.iter().map(|a| a.name.to_lowercase()).collect();
    std::iter::once(name.to_owned())
        .chain((2..).map(|i| format!("{name} {i}")))
        .find(|c| !taken.contains(&c.to_lowercase()))
        .expect("a free name")
}

/// Decimal units, to match what Finder reports for the same folder.
fn fmt_bytes(bytes: Option<u64>) -> String {
    let Some(b) = bytes else {
        return "an unknown amount".into();
    };
    let units = ["bytes", "KB", "MB", "GB", "TB"];
    let (mut n, mut i) = (b as f64, 0);
    while n >= 1000.0 && i < units.len() - 1 {
        n /= 1000.0;
        i += 1;
    }
    match i {
        0 => format!("{b} bytes"),
        _ if n < 10.0 => format!("{n:.1} {}", units[i]),
        _ => format!("{n:.0} {}", units[i]),
    }
}

/// The two paths that cannot be undone get a native warning, not the page's own
/// sheet. Must not be called on the main thread; commands never are.
///
/// Cancel goes first because the first button is the one Return presses, and
/// only the delete button itself, by name, counts as a yes — closing the dialog
/// any other way, Escape included, deletes nothing.
fn confirm_delete(app: &AppHandle, message: &str, detail: &str) -> bool {
    const DELETE: &str = "Delete Permanently";
    let mut d = app
        .dialog()
        .message(detail)
        .title(message)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Cancel".into(),
            DELETE.into(),
        ));
    if let Some(w) = main_window(app) {
        d = d.parent(&w);
    }
    matches!(d.blocking_show_with_result(), MessageDialogResult::Custom(b) if b == DELETE)
}

// --------------------------------------------------------------- commands ---
//
// Sync functions marked async run on Tauri's thread pool rather than the main
// thread, which is what keeps lsof, du and the dialogs off the UI.

// Fast path: config only, no probing. The window must paint immediately.
#[tauri::command(async)]
fn accounts_list() -> Value {
    let Some(stored) = store::accounts() else {
        // First run: nothing configured. Offer what is already on disk.
        return json!({ "needsSetup": true, "discovered": discover_profiles(), "accounts": [] });
    };
    json!({
        "needsSetup": false,
        "discovered": [],
        "accounts": stored_list(&stored),
        "chromeProfiles": chrome::list_profiles(),
        "archived": archive::with_status(&store::load().archived),
    })
}

// Slow path: running state and session counts, folded in once they resolve.
#[tauri::command(async)]
fn accounts_status() -> Vec<Status> {
    probe(&store::accounts().unwrap_or_default())
}

#[derive(Deserialize)]
struct Picked {
    name: String,
    dir: PathBuf,
}

#[tauri::command(async)]
fn accounts_adopt(app: AppHandle, picked: Vec<Picked>) -> Vec<Value> {
    let accounts: Vec<Account> = picked
        .into_iter()
        .map(|p| store::new_account(&p.name, p.dir))
        .collect();
    store::edit(|c| c.accounts = Some(accounts.clone()));
    fit_window(&app);
    tray::refresh(&app);
    decorated(&accounts)
}

#[tauri::command(async)]
fn accounts_add(app: AppHandle, name: String) -> Value {
    let name = name.trim().to_owned();
    if name.is_empty() {
        return error("Name cannot be empty.");
    }
    let added = store::edit(|c| {
        if c.accounts()
            .iter()
            .any(|a| a.name.to_lowercase() == name.to_lowercase())
        {
            return Err("An account with that name already exists.".to_owned());
        }
        let dir = unique_dir(&name);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Could not create the profile folder: {e}"))?;
        c.accounts_mut().push(store::new_account(&name, dir));
        Ok(c.accounts().to_vec())
    });
    match added {
        Ok(accounts) => {
            fit_window(&app);
            tray::refresh(&app);
            json!({ "accounts": decorated(&accounts) })
        }
        Err(e) => error(e),
    }
}

// Name, emoji and colour move together, because they are edited together — the
// edit sheet always sends all three.
#[tauri::command(async)]
fn accounts_update(
    app: AppHandle,
    id: String,
    name: String,
    emoji: String,
    hue: Option<f64>,
) -> Value {
    let name = name.trim().to_owned();
    if name.is_empty() {
        return error("Name cannot be empty.");
    }
    let updated = store::edit(|c| {
        if c.accounts()
            .iter()
            .any(|x| x.id != id && x.name.to_lowercase() == name.to_lowercase())
        {
            return Err("An account with that name already exists.");
        }
        let a = c
            .accounts_mut()
            .iter_mut()
            .find(|x| x.id == id)
            .ok_or("Account not found.")?;
        a.name = name;
        // Bounded rather than validated against a list: a ZWJ sequence is many
        // code points, and there is no reason to refuse one the picker does not offer.
        let e: String = emoji.trim().chars().take(16).collect();
        a.emoji = (!e.is_empty()).then_some(e);
        // None is "derive it from the name".
        a.hue = hue
            .filter(|h| h.is_finite())
            .map(|h| (h.round() as i64).rem_euclid(360));
        Ok(c.accounts().to_vec())
    });
    match updated {
        Ok(accounts) => {
            tray::refresh(&app);
            // Deliberately not probed: lsof would put two seconds between pressing
            // Save and seeing the new name. The renderer keeps the status it has.
            json!({ "accounts": stored_list(&accounts) })
        }
        Err(e) => error(e),
    }
}

#[tauri::command(async)]
fn accounts_remove(app: AppHandle, id: String, delete_data: bool) -> Value {
    let Some(a) = find(&id) else {
        return error("Account not found.");
    };
    if delete_data {
        if is_default(&a) {
            return error(
                "The default profile is Claude’s own data directory and cannot be deleted.",
            );
        }
        if platform::is_running(&a.dir) {
            return error("That account is open. Quit it first, then try again.");
        }
        let n = session_count(&a.dir);
        let detail = format!(
            "This erases the profile directory and everything in it, including {n} saved session{} and the signed-in account.\n\n\
             Your ~/.claude data — skills, plugins, settings and transcripts — is not affected.\n\n{}",
            if n == 1 { "" } else { "s" },
            a.dir.display()
        );
        if !confirm_delete(
            &app,
            &format!("Delete “{}” and all of its data?", a.name),
            &detail,
        ) {
            return json!({ "cancelled": true });
        }
        if let Err(e) = std::fs::remove_dir_all(&a.dir).or_else(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(e)
            }
        }) {
            return error(format!("Could not delete the profile: {e}"));
        }
    }
    let next = store::edit(|c| {
        c.accounts_mut().retain(|x| x.id != id);
        c.accounts().to_vec()
    });
    fit_window(&app);
    tray::refresh(&app);
    json!({ "accounts": decorated(&next) })
}

#[tauri::command(async)]
fn accounts_size(id: String) -> Value {
    json!({ "bytes": find(&id).and_then(|a| platform::profile_size(&a.dir)) })
}

#[tauri::command(async)]
fn accounts_archive(app: AppHandle, id: String) -> Value {
    let Some(a) = find(&id) else {
        return error("Account not found.");
    };
    if is_default(&a) {
        return error(
            "The default profile is Claude’s own data directory and cannot be moved aside.",
        );
    }
    // Renaming a directory out from under a running app is how you corrupt one.
    if platform::is_running(&a.dir) {
        return error("That account is open. Quit it first, then try again.");
    }
    // No second confirmation: archiving deletes nothing and restores in a click,
    // and the picker's own menu already spelled out what it does.
    let record = match archive::archive(&a, platform::profile_size(&a.dir)) {
        Ok(r) => r,
        Err(e) => return error(e),
    };
    let moved_to = record
        .dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned());
    let (accounts, archived) = store::edit(|c| {
        c.accounts_mut().retain(|x| x.id != id);
        c.archived.push(record);
        (c.accounts().to_vec(), c.archived.clone())
    });
    fit_window(&app);
    tray::refresh(&app);
    // Unprobed for the same reason as the edit path; the renderer polls right after.
    json!({ "accounts": stored_list(&accounts), "archived": archive::with_status(&archived), "movedTo": moved_to })
}

#[tauri::command(async)]
fn archive_restore(app: AppHandle, id: String) -> Value {
    let Some(r) = store::load().archived.into_iter().find(|x| x.id == id) else {
        return error("That archive is no longer listed.");
    };
    let dir = match archive::restore(&r) {
        Ok(d) => d,
        Err(e) => return error(e),
    };
    let renamed = (dir != r.original_dir).then(|| dir.clone());
    let (accounts, archived) = store::edit(|c| {
        // A fresh id: the archived one may since have been reused by a new account.
        let mut a = store::new_account(&free_name(&r.name, c.accounts()), dir);
        (a.emoji, a.hue, a.chrome) = (r.emoji.clone(), r.hue, r.chrome.clone());
        c.accounts_mut().push(a);
        c.archived.retain(|x| x.id != id);
        (c.accounts().to_vec(), c.archived.clone())
    });
    fit_window(&app);
    tray::refresh(&app);
    json!({ "accounts": stored_list(&accounts), "archived": archive::with_status(&archived), "renamed": renamed })
}

#[tauri::command(async)]
fn archive_delete(app: AppHandle, id: String) -> Value {
    let Some(r) = store::load().archived.into_iter().find(|x| x.id == id) else {
        return error("That archive is no longer listed.");
    };
    let detail = format!(
        "This erases {} — the profile folder and everything in it, including its signed-in account. It cannot be undone.\n\n\
         Your ~/.claude data — skills, plugins, settings and transcripts — is not affected.\n\n{}",
        fmt_bytes(r.bytes),
        r.dir.display()
    );
    if !confirm_delete(
        &app,
        &format!("Delete the archive of “{}”?", r.name),
        &detail,
    ) {
        return json!({ "cancelled": true });
    }
    if let Err(e) = archive::destroy(&r) {
        return error(e);
    }
    let archived = store::edit(|c| {
        c.archived.retain(|x| x.id != id);
        c.archived.clone()
    });
    json!({ "archived": archive::with_status(&archived) })
}

#[tauri::command(async)]
fn accounts_launch(id: String) -> Value {
    match find(&id) {
        Some(a) => launch_account(&a),
        None => error("Account not found."),
    }
}

#[tauri::command(async)]
fn accounts_reveal(id: String) {
    if let Some(a) = find(&id) {
        platform::reveal(&a.dir);
    }
}

#[tauri::command(async)]
fn accounts_quit(id: String) -> Value {
    let Some(a) = find(&id) else {
        return error("Account not found.");
    };
    match platform::quit_profile(&a.dir) {
        Ok(count) => json!({ "ok": true, "count": count }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command(async)]
fn app_hide(app: AppHandle) {
    if let Some(w) = main_window(&app) {
        let _ = w.close();
    }
}

// After picking an account the launcher gets out of the way but stays running,
// so the next pick is instant instead of a cold start. Hidden rather than
// minimized: a minimized window leaves a second thumbnail in the Dock.
#[tauri::command(async)]
fn app_dismiss(app: AppHandle) {
    if let Some(w) = main_window(&app) {
        let _ = w.hide();
    }
}

// A list modal needs more room than a two-account window has. Grow for it, then
// fit_window() puts things back when the modal closes.
#[tauri::command(async)]
fn app_ensure_height(app: AppHandle, min: f64) {
    if let Some(w) = main_window(&app) {
        let (width, height) = logical_size(&w);
        if height < min - CONTENT_OFFSET {
            let _ = w.set_size(LogicalSize::new(width, min - CONTENT_OFFSET));
        }
    }
}

#[tauri::command(async)]
fn app_fit_window(app: AppHandle) {
    fit_window(&app);
}

#[tauri::command(async)]
fn app_extra_height(app: AppHandle, px: f64) {
    rt().extra_height = px.max(0.0);
    fit_window(&app);
}

// The reason travels with the answer: "not installed" and "installed, but from
// the Microsoft Store, which cannot be given its own profile" need different
// words, and only the platform knows which applies.
#[tauri::command(async)]
fn app_claude_installed() -> Value {
    json!({ "installed": platform::claude_installed(), "hint": platform::claude_hint() })
}

#[tauri::command(async)]
fn settings_get() -> Value {
    let mut v = serde_json::to_value(store::settings()).unwrap_or_default();
    v["version"] = update::VERSION.into();
    v["openAtLogin"] = platform::open_at_login().into();
    v
}

#[tauri::command(async)]
fn settings_set_hotkey(app: AppHandle, hotkey: String, enabled: bool) -> Value {
    if let Err(e) = register_hotkey(&app, enabled.then_some(hotkey.as_str())) {
        apply_hotkey_from_settings(&app); // keep whatever was working before
        return error(e);
    }
    store::edit(|c| {
        c.settings.hotkey = hotkey;
        c.settings.hotkey_enabled = enabled;
    });
    json!({ "ok": true })
}

#[tauri::command(async)]
fn settings_set_presentation(app: AppHandle, menu_bar: bool, hide_dock: bool) -> Value {
    // No menu bar means the Dock icon has to stay, or the app becomes unreachable.
    let hide_dock = menu_bar && hide_dock;
    store::edit(|c| (c.settings.menu_bar, c.settings.hide_dock) = (menu_bar, hide_dock));
    apply_presentation(&app);
    json!({ "menuBar": menu_bar, "hideDock": hide_dock })
}

#[tauri::command(async)]
fn settings_set_sorting(app: AppHandle, sort_by_recent: bool) -> Value {
    store::edit(|c| c.settings.sort_by_recent = sort_by_recent);
    tray::refresh(&app);
    json!({ "sortByRecent": sort_by_recent })
}

#[tauri::command(async)]
fn settings_set_login_item(enabled: bool) -> Value {
    platform::set_open_at_login(enabled);
    json!({ "openAtLogin": platform::open_at_login() })
}

#[tauri::command(async)]
fn settings_set_auto_update(enabled: bool) -> Value {
    store::edit(|c| c.settings.auto_update_check = enabled);
    json!({ "autoUpdateCheck": enabled })
}

// Both platforms answer both: pinning to the Dock and adding a Start menu entry
// are the same offer in different words.
#[tauri::command(async)]
fn shortcut_status() -> Value {
    let s = platform::shortcut_status();
    json!({ "supported": true, "present": s.present, "blurb": s.blurb, "cta": s.cta, "tip": s.tip })
}

#[tauri::command(async)]
fn shortcut_create() -> Value {
    match platform::shortcut_create() {
        Ok(already) => json!({ "ok": true, "already": already }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command(async)]
fn chrome_list(account_id: String) -> Value {
    let profiles = chrome::list_profiles();
    let a = find(&account_id);
    json!({
        "installed": chrome::installed(),
        "suggestion": a.as_ref().and_then(|a| chrome::suggest_for(&a.name, &profiles)).map(|p| p.dir.clone()),
        "current": a.and_then(|a| a.chrome),
        "profiles": profiles,
    })
}

#[tauri::command(async)]
fn chrome_pair(account_id: String, dir: Option<String>, open_on_launch: Option<bool>) -> Value {
    let paired = store::edit(|c| {
        let a = c.accounts_mut().iter_mut().find(|x| x.id == account_id)?;
        a.chrome = dir.filter(|d| !d.is_empty()).map(|dir| store::ChromePair {
            dir,
            open_on_launch: open_on_launch != Some(false),
        });
        Some(c.accounts().to_vec())
    });
    match paired {
        Some(accounts) => json!({ "accounts": decorated(&accounts) }),
        None => error("Account not found."),
    }
}

#[tauri::command(async)]
fn chrome_extension(dir: String) {
    chrome::open_extension_page(&dir);
}

#[tauri::command(async)]
fn chrome_new_profile() -> Value {
    json!({ "dir": chrome::next_profile_dir() })
}

#[tauri::command(async)]
fn health_scan() -> health::Scan {
    health::scan(
        &store::accounts().unwrap_or_default(),
        &store::backup_root(),
        &health::Places::system(),
    )
}

#[tauri::command(async)]
fn health_rebuild(account_id: String, orphan: health::Orphan) -> Value {
    let Some(a) = find(&account_id) else {
        return error("Account not found.");
    };
    match health::rebuild(&a, &orphan) {
        Ok(file) => json!({ "ok": true, "file": file }),
        Err(e) => error(e),
    }
}

#[tauri::command(async)]
fn health_reveal(target: Option<PathBuf>) {
    if let Some(t) = target {
        platform::reveal(&t);
    }
}

// -------------------------------------------------------------- self-update ---

#[tauri::command(async)]
fn update_check() -> Value {
    let res = update::check();
    rt().last_update = Some(res.clone());
    if res.available {
        store::edit(|c| c.settings.last_update_check = now_ms());
    }
    merged_check(&res)
}

fn merged_check(res: &update::Check) -> Value {
    let mut v = serde_json::to_value(res).unwrap_or_default();
    v["packaged"] = (!cfg!(debug_assertions)).into();
    v
}

#[tauri::command(async)]
fn update_install(app: AppHandle) -> Value {
    let Some(info) = rt().last_update.clone().filter(|u| u.available) else {
        return error("No update to install.");
    };
    let staged = match update::download(&info, &|p| {
        let _ = app.emit("update:progress", p);
    }) {
        Ok(s) => s,
        Err(e) => return error(e),
    };
    if let Err(e) = update::apply(&staged) {
        // A download that never reached the swap script is a release's worth of nothing.
        update::discard(&staged);
        return error(e);
    }
    // The swap script waits for this process to exit before replacing the app.
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        app2.exit(0);
    });
    json!({ "ok": true, "relaunching": true })
}

#[tauri::command(async)]
fn update_page() {
    platform::open_url(&update::releases_page());
}

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// A quiet daily check. It only ever *looks* — installing stays a decision, and
/// a launcher that cannot reach GitHub should behave exactly as it always did.
fn update_tick(app: &AppHandle) {
    let s = store::settings();
    if cfg!(debug_assertions) || !s.auto_update_check || now_ms() - s.last_update_check < DAY_MS {
        return;
    }
    let res = update::check();
    rt().last_update = Some(res.clone());
    if !res.ok {
        return;
    }
    store::edit(|c| c.settings.last_update_check = now_ms());
    if res.available {
        let _ = app.emit("update:available", &res);
    }
}

// ---------------------------------------------------------------- hotkey ---

fn register_hotkey(app: &AppHandle, accel: Option<&str>) -> Result<(), String> {
    let gs = app.global_shortcut();
    let current = rt().hotkey.take();
    if let Some(cur) = current {
        let _ = gs.unregister(cur.as_str());
    }
    let Some(accel) = accel else { return Ok(()) };
    // Refused when the combination cannot be parsed or another app owns it.
    gs.register(accel)
        .map_err(|_| "That shortcut is already taken by another app.".to_owned())?;
    rt().hotkey = Some(accel.to_owned());
    Ok(())
}

/// A stored accelerator this platform can actually register. A config written on
/// a Mac names Command, which does not exist on a Windows keyboard — register()
/// would refuse it and report the shortcut as taken by another app, which is both
/// wrong and unfixable from the settings sheet.
fn usable_hotkey(accel: &str) -> &str {
    let foreign = if cfg!(windows) { "Command" } else { "Super" };
    if accel.split('+').any(|k| k == foreign) {
        platform::DEFAULT_HOTKEY
    } else {
        accel
    }
}

fn apply_hotkey_from_settings(app: &AppHandle) {
    let s = store::settings();
    let _ = register_hotkey(app, s.hotkey_enabled.then(|| usable_hotkey(&s.hotkey)));
}

// ------------------------------------------------------------------ window ---

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

pub fn open_window(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Summon the launcher, or put it away if it is already in front.
fn toggle_window(app: &AppHandle) {
    match main_window(app) {
        Some(w) if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) => {
            let _ = w.hide();
        }
        _ => open_window(app),
    }
}

pub fn reveal_health(app: &AppHandle) {
    open_window(app);
    let _ = app.emit("health:show", ());
}

/// On Windows the page's own 52 px titlebar is hidden in favour of the native
/// one, which sits outside the inner size the heights below describe.
const CONTENT_OFFSET: f64 = if cfg!(windows) { 52.0 } else { 0.0 };

/// Size the window to its content so it never opens as a half-empty panel.
fn preferred_height() -> f64 {
    let Some(stored) = store::accounts() else {
        return 560.0 - CONTENT_OFFSET;
    }; // setup carries its own copy
    let chrome = 52.0 + 16.0 + 60.0; // titlebar + list padding + footer
    (chrome + stored.len() as f64 * 66.0 + rt().extra_height).clamp(260.0, 760.0) - CONTENT_OFFSET
}

fn logical_size(w: &WebviewWindow) -> (f64, f64) {
    let size = w
        .inner_size()
        .unwrap_or_default()
        .to_logical::<f64>(w.scale_factor().unwrap_or(1.0));
    (size.width, size.height)
}

/// Re-fit the window after the account count changes, so the list never scrolls.
fn fit_window(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.set_size(LogicalSize::new(logical_size(&w).0, preferred_height()));
    }
}

/// With a global hotkey, a menu bar or launch at login there is still a way back
/// in, so closing the window only hides it — the app has to outlive its window,
/// or the shortcut dies the first time the window is dismissed.
fn keeps_running() -> bool {
    let s = store::settings();
    rt().hotkey.is_some() || s.menu_bar || platform::open_at_login()
}

fn create_window(app: &AppHandle) -> tauri::Result<()> {
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("CASE")
        .inner_size(440.0, preferred_height())
        .min_inner_size(380.0, 240.0 - CONTENT_OFFSET)
        .visible(false)
        .on_page_load(|w, p| {
            if p.event() == PageLoadEvent::Finished && !std::mem::take(&mut rt().start_hidden) {
                let _ = w.show();
                let _ = w.set_focus();
            }
        });
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(14.0, 18.0));
    let win = builder.build()?;

    let app = app.clone();
    win.on_window_event(move |e| match e {
        WindowEvent::CloseRequested { api, .. } if keeps_running() => {
            api.prevent_close();
            if let Some(w) = main_window(&app) {
                let _ = w.hide();
            }
        }
        // Windows picks its tray icon by taskbar theme; macOS recolours a template.
        WindowEvent::ThemeChanged(_) => {
            platform::forget_theme();
            tray::reload(&app);
        }
        _ => {}
    });
    Ok(())
}

/// Apply the menu-bar / Dock presentation. Hiding the Dock icon is only offered
/// alongside the menu bar — without either, the app would have no way back. The
/// Windows equivalent of a hidden Dock tile is a window kept off the taskbar.
fn apply_presentation(app: &AppHandle) {
    let s = store::settings();
    if s.menu_bar {
        tray::enable(app);
    } else {
        tray::disable(app);
    }
    let hide = s.menu_bar && s.hide_dock;
    #[cfg(target_os = "macos")]
    let _ = app.set_dock_visibility(!hide);
    #[cfg(windows)]
    if let Some(w) = main_window(app) {
        let _ = w.set_skip_taskbar(hide);
    }
}

// ------------------------------------------------------------ health watch ---

// A scan costs ~50 ms, so checking every couple of minutes is free. The point is
// latency: the failure this catches is invisible while the app runs, so the gap
// between "it started failing" and "you were told" is the whole value.
// CLAUDE_ACCOUNTS_WATCH_MS shortens this for testing.
fn watch_interval() -> Duration {
    let ms = std::env::var("CLAUDE_ACCOUNTS_WATCH_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(120_000);
    Duration::from_millis(ms)
}

fn issue_keys(data: &health::Scan) -> HashSet<String> {
    let mut keys = HashSet::new();
    for a in &data.accounts {
        // Keyed on the account, not the last failure timestamp: a continuing
        // failure must not re-notify on every tick.
        if a.failing() {
            keys.insert(format!("fail:{}", a.id));
        }
        for o in &a.orphans {
            keys.insert(format!("orphan:{}:{}", a.id, o.cli_session_id));
        }
    }
    keys
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

fn health_tick(app: &AppHandle, first: bool) {
    let data = health_scan();
    let n = data.issue_count();
    let keys = issue_keys(&data);
    let fresh: Vec<String> = {
        let mut rt = rt();
        rt.issue_count = n;
        let fresh = keys.difference(&rt.seen_issues).cloned().collect();
        rt.seen_issues = keys;
        fresh
    };
    if let Some(w) = main_window(app) {
        platform::set_badge(&w, n);
    }
    tray::refresh(app);
    let _ = app.emit("health:update", &data);

    let failing: Vec<&str> = data
        .accounts
        .iter()
        .filter(|a| a.failing())
        .map(|a| a.name.as_str())
        .collect();
    if !failing.is_empty() && (first || fresh.iter().any(|k| k.starts_with("fail:"))) {
        // Worth interrupting for: while this lasts, every session is memory-only.
        notify(
            app,
            "Claude is not saving sessions",
            &format!(
                "{} — sessions will be lost when Claude restarts.",
                failing.join(", ")
            ),
        );
        return;
    }

    // Pre-existing orphans are old news at startup; the badge already carries them.
    let lost = if first {
        0
    } else {
        fresh.iter().filter(|k| k.starts_with("orphan:")).count()
    };
    if lost > 0 {
        let title = if lost == 1 {
            "A session went missing from Claude’s list".to_owned()
        } else {
            format!("{lost} sessions went missing from Claude’s list")
        };
        notify(
            app,
            &title,
            "Their transcripts survived. Open CASE to restore them.",
        );
    }
}

fn start_watching(app: AppHandle) {
    let app2 = app.clone();
    std::thread::spawn(move || {
        health_tick(&app, true);
        loop {
            std::thread::sleep(watch_interval());
            health_tick(&app, false);
        }
    });
    // Behind the first paint: an update check is never worth delaying the window.
    // Asked hourly, acted on daily, so a launcher left running for weeks still looks.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(4));
        loop {
            update_tick(&app2);
            std::thread::sleep(Duration::from_secs(3600));
        }
    });
}

// -------------------------------------------------------------------- main ---

fn main() {
    // Notifications are dropped outright for an app Windows cannot tie to a Start
    // menu shortcut, and it matches them up by this id. Set before any window.
    #[cfg(windows)]
    platform::set_app_user_model_id();
    store::migrate_legacy();

    tauri::Builder::default()
        // Windows has no `activate` event, so without this a second click on the
        // Start menu entry starts a second launcher — two processes writing
        // accounts.json. First, so it runs before anything else does.
        // A second copy started at login, by an entry an older build left behind,
        // stays as quiet as the first.
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !args.iter().any(|a| a == "--hidden") {
                open_window(app);
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _, event| {
                    if event.state == ShortcutState::Pressed {
                        toggle_window(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            accounts_list,
            accounts_status,
            accounts_adopt,
            accounts_add,
            accounts_update,
            accounts_remove,
            accounts_size,
            accounts_archive,
            archive_restore,
            archive_delete,
            accounts_launch,
            accounts_reveal,
            accounts_quit,
            app_hide,
            app_dismiss,
            app_ensure_height,
            app_fit_window,
            app_extra_height,
            app_claude_installed,
            settings_get,
            settings_set_hotkey,
            settings_set_presentation,
            settings_set_sorting,
            settings_set_login_item,
            settings_set_auto_update,
            shortcut_status,
            shortcut_create,
            chrome_list,
            chrome_pair,
            chrome_extension,
            chrome_new_profile,
            health_scan,
            health_rebuild,
            health_reveal,
            update_check,
            update_install,
            update_page,
        ])
        .setup(|app| {
            // The LaunchAgent and the Run key both start CASE with --hidden.
            rt().start_hidden = std::env::args().any(|a| a == "--hidden");
            let handle = app.handle().clone();
            handle.on_menu_event(|app, e| tray::on_menu(app, e.id().as_ref()));
            create_window(&handle)?;
            apply_hotkey_from_settings(&handle);
            apply_presentation(&handle);
            // A click on a notification opens the panel it is about.
            let h = handle.clone();
            app.notification().on_action(move |_| reveal_health(&h))?;
            start_watching(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("CASE could not start")
        .run(|app, event| {
            // The window survives a pick (hidden, not closed), so clicking the Dock
            // icon has to reveal it.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                open_window(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_names_keep_letters_and_collapse_the_rest() {
        assert_eq!(slug("Work"), "Work");
        assert_eq!(slug("  Side / project!! "), "Side-project");
        assert_eq!(slug("Café"), "Café");
        assert_eq!(slug("!!!"), "account");
        assert_eq!(slug(&"x".repeat(60)).len(), 40);
    }

    #[test]
    fn a_restored_name_steps_around_its_namesakes() {
        let taken = [
            store::new_account("Work", "/a".into()),
            store::new_account("work 2", "/b".into()),
        ];
        assert_eq!(free_name("Work", &taken), "Work 3");
        assert_eq!(free_name("Home", &taken), "Home");
    }

    #[test]
    fn sizes_read_as_finder_reads_them() {
        assert_eq!(fmt_bytes(Some(999)), "999 bytes");
        assert_eq!(fmt_bytes(Some(8_400_000_000)), "8.4 GB");
        assert_eq!(fmt_bytes(Some(26_000)), "26 KB");
        assert_eq!(fmt_bytes(None), "an unknown amount");
    }

    #[test]
    fn a_hotkey_from_the_other_platform_falls_back_to_this_ones_default() {
        let foreign = if cfg!(windows) {
            "Alt+Command+C"
        } else {
            "Super+Alt+C"
        };
        assert_eq!(usable_hotkey(foreign), platform::DEFAULT_HOTKEY);
        assert_eq!(usable_hotkey("Alt+Shift+K"), "Alt+Shift+K");
    }
}
