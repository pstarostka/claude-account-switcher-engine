//! Menu-bar mode: the whole picker as a menu, so switching account never needs a
//! window at all.
//!
//! Every tray object is created, used and dropped on the main thread. Dropping
//! the last handle to the icon removes its status item, and AppKit aborts the
//! process when that happens anywhere else; the slow part — probing each
//! account — happens on a thread of its own, and only its result crosses over.

use crate::{platform, store};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter};

const ID: &str = "main";

pub fn enable(app: &AppHandle) {
    let (icon, template) = platform::tray_image();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if handle.tray_by_id(ID).is_some() {
            return;
        }
        let _ = TrayIconBuilder::with_id(ID)
            .icon(icon)
            .icon_as_template(template)
            .tooltip("CASE — Claude Account Switcher Engine")
            .show_menu_on_left_click(true)
            // Rebuilt as the pointer arrives, so running state is current when
            // the menu opens rather than as of the last change. The menu shows on
            // the click itself, too soon for a rebuild started by that click.
            .on_tray_icon_event(|tray, e| {
                if let TrayIconEvent::Enter { .. } = e {
                    refresh(tray.app_handle());
                }
            })
            .build(&handle);
    });
    refresh(app);
}

pub fn disable(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || drop(handle.remove_tray_by_id(ID)));
}

/// Swap in a fresh icon, for a theme change. Windows picks one per taskbar theme,
/// which takes a registry read, so that happens before the main thread is asked.
pub fn reload(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let (icon, template) = platform::tray_image();
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(tray) = handle.tray_by_id(ID) {
                let _ = tray.set_icon(Some(icon));
                let _ = tray.set_icon_as_template(template);
            }
        });
    });
}

static BUSY: AtomicBool = AtomicBool::new(false);
static PENDING: AtomicBool = AtomicBool::new(false);

/// Rebuild the menu. One probe at a time — hovering back and forth must not stack
/// up lsof calls — but a request that arrives during one is not dropped: it runs
/// again afterwards, since what it asked about may be a rename the running one
/// read too early to see.
pub fn refresh(app: &AppHandle) {
    if !store::settings().menu_bar {
        return;
    }
    PENDING.store(true, Ordering::SeqCst);
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            while PENDING.swap(false, Ordering::SeqCst) {
                rebuild(&app);
            }
            BUSY.store(false, Ordering::SeqCst);
            // A request may have landed between the last check and letting go.
            if !PENDING.load(Ordering::SeqCst) || BUSY.swap(true, Ordering::SeqCst) {
                break;
            }
        }
    });
}

fn rebuild(app: &AppHandle) {
    // Same order as the picker, so the menu and ⌘1–9 never disagree.
    let accounts = crate::sorted(&store::accounts().unwrap_or_default());
    let status = crate::probe(&accounts);
    // A checkmark would imply a selection; the dot just marks what is open.
    let rows: Vec<(String, String)> = accounts
        .iter()
        .zip(&status)
        .map(|(a, s)| {
            let emoji = a
                .emoji
                .as_ref()
                .map(|e| format!("{e}  "))
                .unwrap_or_default();
            let dot = if s.running { "  ●" } else { "" };
            (format!("acct:{}", a.id), format!("{emoji}{}{dot}", a.name))
        })
        .collect();
    let issues = crate::rt().issue_count;

    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let (Some(tray), Ok(menu)) = (handle.tray_by_id(ID), menu(&handle, &rows, issues)) {
            let _ = tray.set_menu(Some(menu));
        }
    });
}

fn menu(
    app: &AppHandle,
    rows: &[(String, String)],
    issues: usize,
) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, label: &str| MenuItem::with_id(app, id, label, true, None::<&str>);
    let menu = Menu::new(app)?;
    if rows.is_empty() {
        menu.append(&MenuItem::with_id(
            app,
            "none",
            "No accounts yet",
            false,
            None::<&str>,
        )?)?;
    }
    for (id, label) in rows {
        menu.append(&item(id, label)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let health = if issues > 0 {
        format!("Session health ({issues})")
    } else {
        "Session health".into()
    };
    menu.append(&item("health", &health)?)?;
    menu.append(&item("settings", "Settings…")?)?;
    menu.append(&item("open", "Open CASE")?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "Quit CASE",
        true,
        Some("CmdOrCtrl+Q"),
    )?)?;
    Ok(menu)
}

/// Registered once, for the whole app: a handler given to the tray builder is
/// kept app-wide too, so one per build would answer each click once for every
/// time the menu bar had been switched on.
pub fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "health" => crate::reveal_health(app),
        "settings" => {
            crate::open_window(app);
            let _ = app.emit("settings:show", ());
        }
        "open" => crate::open_window(app),
        "quit" => app.exit(0),
        _ => {
            let Some(id) = id.strip_prefix("acct:").map(str::to_owned) else {
                return;
            };
            // Menu events arrive on the main thread; a launch probes and spawns.
            let app = app.clone();
            std::thread::spawn(move || {
                if let Some(a) = crate::find(&id) {
                    crate::launch_account(&a);
                }
                refresh(&app);
            });
        }
    }
}
