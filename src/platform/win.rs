//! Windows plumbing, the counterpart to mac.rs. Same names, same meanings.
//!
//! Every console helper spawned here goes through `run`, which hides its window:
//! CASE is a GUI-subsystem binary, so a console child without that flashes a
//! black window.

use super::{Output, hide_console, newest_app_dir, pq, run, secs};
use std::collections::HashSet;
use std::ffi::OsString;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Runtime, WebviewWindow, image::Image};

// Not Ctrl+Alt+C: on Polish and most other European layouts AltGr *is* Ctrl+Alt,
// so that combination would swallow a character people type.
pub const DEFAULT_HOTKEY: &str = "Alt+Shift+C";
/// Which of a release's assets this build can install.
pub const ASSET_TAG: &str = "-win-";

const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

fn local_app_data() -> PathBuf {
    dirs::data_local_dir().unwrap_or_default()
}

/// %APPDATA% — where Claude keeps its default profile and CASE its own data.
pub fn app_data() -> PathBuf {
    dirs::data_dir().unwrap_or_default()
}

/// Where a profile CASE creates goes. Deliberately not %APPDATA%: a Chromium
/// profile runs to several gigabytes, and Roaming is synchronised at logon on a
/// domain-joined machine and swept up by OneDrive's folder redirection. Claude's
/// own default profile stays where Claude put it; only new ones land in Local.
pub fn profile_root() -> PathBuf {
    local_app_data()
}

fn system32(file: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    PathBuf::from(root).join("System32").join(file)
}

fn read_dir_names(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

// ------------------------------------------------------------------ claude ---

fn claude_root() -> PathBuf {
    local_app_data().join("AnthropicClaude")
}

/// Claude Desktop's executable.
///
/// The versioned payload rather than the stub at the root of the install: the
/// stub re-launches the real exe and exits immediately, so its pid is dead by the
/// time there is anything to record — and that pid is the only handle Windows
/// gives us on "which Claude is this account".
fn claude_exe() -> Option<PathBuf> {
    let root = claude_root();
    if let Some(dir) = newest_app_dir(&read_dir_names(&root)) {
        let exe = root.join(dir).join("claude.exe");
        if exe.exists() {
            return Some(exe);
        }
    }
    // A stub-only install still launches; quitting one account degrades to the
    // "could not find the process" path, which is the honest answer there.
    Some(root.join("claude.exe")).filter(|p| p.exists())
}

/// Whether Claude is installed from the Microsoft Store.
///
/// An MSIX package is activated through the app model, which builds the child's
/// environment itself — CLAUDE_USER_DATA_DIR would be dropped on the way, and
/// every account would silently open the same profile.
fn store_installed() -> bool {
    read_dir_names(&local_app_data().join("Packages"))
        .iter()
        .any(|n| n.to_lowercase().starts_with("claude_"))
}

pub fn claude_installed() -> bool {
    claude_exe().is_some()
}

pub fn claude_hint() -> String {
    if store_installed() {
        "Claude is installed from the Microsoft Store, which cannot be opened with a separate profile. Install the standalone download from claude.ai/download.".into()
    } else {
        "Claude Desktop is not installed — accounts cannot be launched.".into()
    }
}

// -------------------------------------------------------- launch and quit ---

// Written by CASE when it starts Claude, and the only way back from a profile to
// a process id: Windows will not hand out another process's environment, so
// there is nothing to match a running claude.exe against. It lives in the
// profile, so archiving or restoring one carries its own record along.
const PID_FILE: &str = "case-instance.json";

fn write_pid(dir: &Path, pid: u32, exe: &Path) {
    let rec = serde_json::json!({ "pid": pid, "at": crate::now_ms(), "dir": dir, "exe": exe });
    let _ = std::fs::write(
        dir.join(PID_FILE),
        serde_json::to_string_pretty(&rec).unwrap_or_default(),
    );
}

fn read_pid(dir: &Path) -> Option<u32> {
    let raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join(PID_FILE)).ok()?).ok()?;
    raw["pid"].as_u64().and_then(|p| u32::try_from(p).ok())
}

static PID_CACHE: Mutex<Option<(Instant, HashSet<u32>)>> = Mutex::new(None);

/// Every live claude.exe, memoised for a second. The status poll asks once per
/// account every 2.5 s, so without this a five-account list is five spawns a tick.
fn live_pids() -> HashSet<u32> {
    let mut cache = PID_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, pids)) = cache.as_ref()
        && at.elapsed() < Duration::from_secs(1)
    {
        return pids.clone();
    }
    let Output { ok, out } = run(
        system32("tasklist.exe"),
        &["/FI", "IMAGENAME eq claude.exe", "/FO", "CSV", "/NH"],
        secs(4),
    );
    let pids: HashSet<u32> = if ok {
        // "claude.exe","1234","Console","1","123,456 K"
        out.lines()
            .filter_map(|l| l.strip_prefix('"')?.split("\",\"").nth(1)?.parse().ok())
            .collect()
    } else {
        HashSet::new()
    };
    *cache = Some((Instant::now(), pids.clone()));
    pids
}

/// Uncached, for the quit loop — a one-second-stale answer there reads as a hang.
fn pid_live(pid: u32) -> bool {
    let Output { ok, out } = run(
        system32("tasklist.exe"),
        &["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"],
        secs(4),
    );
    ok && out.contains(&format!("\",\"{pid}\",\""))
}

/// The recorded pid for a profile, if that process is still alive.
fn live_pid_for(dir: &Path) -> Option<u32> {
    read_pid(dir).filter(|pid| live_pids().contains(pid))
}

/// Whether anything holds the profile's leveldb locks.
///
/// leveldb opens LOCK with no sharing, so a competing open comes back
/// ERROR_SHARING_VIOLATION. That is the one exclusive marker in a Chromium
/// profile: Cookies is SQLite and is opened shared, so probing it would call a
/// running profile idle.
fn lock_busy(dir: &Path) -> bool {
    [
        dir.join("Local Storage").join("leveldb").join("LOCK"),
        dir.join("Session Storage").join("LOCK"),
    ]
    .iter()
    .filter(|f| f.exists())
    .any(|f| match std::fs::File::open(f) {
        Ok(_) => false,
        // 32 sharing violation, 33 lock violation, 5 access denied.
        Err(e) => matches!(e.raw_os_error(), Some(32 | 33 | 5)),
    })
}

/// The lock answers for any instance, including ones CASE did not start; the
/// recorded pid covers the seconds between spawning Claude and leveldb opening,
/// when the profile is claimed but nothing is locked yet.
pub fn is_running(dir: &Path) -> bool {
    lock_busy(dir) || live_pid_for(dir).is_some()
}

pub fn launch_claude(dir: &Path, is_default: bool) -> Result<(), Option<String>> {
    let exe = claude_exe().ok_or_else(|| Some(claude_hint()))?;
    let mut cmd = Command::new(&exe);
    // Removed rather than merely not set. Claude's own test is
    // `if (process.env.CLAUDE_USER_DATA_DIR)`, so a value inherited from whatever
    // started CASE would send every default-profile launch into another account.
    if is_default {
        cmd.env_remove("CLAUDE_USER_DATA_DIR");
    } else {
        // The switch as well as the variable, for the reason mac.rs gives: current
        // Claude builds strip the variable at startup, and nothing strips a switch.
        let mut switch = OsString::from("--user-data-dir=");
        switch.push(dir);
        cmd.env("CLAUDE_USER_DATA_DIR", dir).arg(switch);
    }
    let child = cmd
        .current_dir(exe.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Outlives CASE, which is the point of a launcher. Not CREATE_NO_WINDOW:
        // Claude is a GUI app, and its window is the one thing that must show.
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map_err(|e| Some(format!("Could not start Claude: {e}")))?;
    write_pid(dir, child.id(), &exe);
    Ok(())
}

pub fn activate_profile(dir: &Path) {
    let Some(pid) = live_pid_for(dir) else { return };
    // Windows' foreground lock may turn this into a flashing taskbar button rather
    // than a raised window. That is the OS deciding, not a failure to report.
    run(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("(New-Object -ComObject WScript.Shell).AppActivate({pid})"),
        ],
        secs(8),
    );
}

/// Ask one Claude instance to quit, leaving any other account running.
pub fn quit_profile(dir: &Path) -> Result<usize, String> {
    let pid = live_pid_for(dir).ok_or("Could not find the process for that account.")?;
    let taskkill = system32("taskkill.exe");
    let pid_s = pid.to_string();
    // /T without /F posts WM_CLOSE through the tree, so Electron raises its close
    // event and Claude saves on the way out. Force is the escalation, not the plan.
    run(&taskkill, &["/PID", &pid_s, "/T"], secs(8));
    for _ in 0..25 {
        if !pid_live(pid) {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    if pid_live(pid) {
        run(&taskkill, &["/PID", &pid_s, "/T", "/F"], secs(8));
    }
    Ok(1)
}

// ---------------------------------------------------------------- shortcut ---

fn start_menu_link() -> PathBuf {
    app_data().join(r"Microsoft\Windows\Start Menu\Programs\CASE.lnk")
}

pub struct ShortcutStatus {
    pub present: bool,
    pub blurb: &'static str,
    pub cta: &'static str,
    pub tip: &'static str,
}

pub fn shortcut_status() -> ShortcutStatus {
    ShortcutStatus {
        present: start_menu_link().exists(),
        blurb: "Add CASE to your Start menu so an account is always one click away.",
        cta: "Add to Start menu",
        tip: "Creates a Start menu shortcut, which is also what lets Windows show notifications",
    }
}

/// Windows has not allowed an app to pin itself to the taskbar since 8.1, so the
/// Start menu is the equivalent gesture. The shortcut carries the AppUserModelID,
/// and that is not decoration: Windows drops every toast from an app it cannot
/// tie to a shortcut, silently. Answers whether it was already there.
pub fn shortcut_create() -> Result<bool, String> {
    let link = start_menu_link();
    if link.exists() {
        return Ok(true);
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create the shortcut: {e}"))?;
    }
    write_shortcut(&link, &exe).map_err(|e| format!("Could not create the shortcut: {e}"))?;
    Ok(false)
}

fn write_shortcut(link: &Path, target: &Path) -> windows::core::Result<()> {
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        IPersistFile,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    use windows::core::{HSTRING, Interface};

    // SAFETY: plain COM calls on interfaces this function created and owns.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let sl: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        sl.SetPath(&HSTRING::from(target.as_os_str()))?;
        if let Some(dir) = target.parent() {
            sl.SetWorkingDirectory(&HSTRING::from(dir.as_os_str()))?;
        }
        sl.SetDescription(&HSTRING::from("CASE — Claude Account Switcher Engine"))?;
        let store: IPropertyStore = sl.cast()?;
        store.SetValue(&PKEY_AppUserModel_ID, &PROPVARIANT::from(crate::APP_ID))?;
        store.Commit()?;
        let file: IPersistFile = sl.cast()?;
        file.Save(&HSTRING::from(link.as_os_str()), true)
    }
}

/// Toasts are matched to a Start menu shortcut by this id, so it has to be set
/// before any window, and it is the same string the shortcut carries.
pub fn set_app_user_model_id() {
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    // SAFETY: takes a string and stores it for this process.
    let _ = unsafe {
        SetCurrentProcessExplicitAppUserModelID(&windows::core::HSTRING::from(crate::APP_ID))
    };
}

// ------------------------------------------------------------- login item ---

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
// The value name Electron gave it, so an entry written by a 3.x build is the
// one this reads and removes.
const RUN_VALUE: &str = crate::APP_ID;

pub fn open_at_login() -> bool {
    run(
        system32("reg.exe"),
        &["query", RUN_KEY, "/v", RUN_VALUE],
        secs(4),
    )
    .ok
}

pub fn set_open_at_login(on: bool) {
    let reg = system32("reg.exe");
    if !on {
        run(&reg, &["delete", RUN_KEY, "/v", RUN_VALUE, "/f"], secs(4));
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let value = format!("\"{}\" --hidden", exe.display());
    run(
        &reg,
        &[
            "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &value, "/f",
        ],
        secs(4),
    );
}

// ------------------------------------------------------------- self-update ---

pub fn install_path() -> Option<PathBuf> {
    Some(std::env::current_exe().ok()?.parent()?.to_path_buf())
}

pub fn install_looks_sane(p: &Path) -> bool {
    p.join("CASE.exe").exists()
}

/// bsdtar has shipped in Windows since 1803 and reads zips. Expand-Archive is the
/// obvious alternative and spends most of an extraction drawing a progress bar at
/// a console nobody is looking at.
pub fn unpack(zip: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(system32("tar.exe"));
    cmd.arg("-xf").arg(zip).arg("-C").arg(dest);
    hide_console(&mut cmd);
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
    }
}

/// The app inside an unpacked download, refused unless it is recognisably ours:
/// the bundle identifier is compiled into the executable.
pub fn find_fresh(unpacked: &Path) -> Result<PathBuf, String> {
    let dir = std::fs::read_dir(unpacked)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .find(|p| install_looks_sane(p))
        .ok_or("The download did not contain an app.")?;
    if super::file_contains(&dir.join("CASE.exe"), crate::APP_ID.as_bytes()) {
        Ok(dir)
    } else {
        Err("The download is not CASE, so it was not installed.".into())
    }
}

/// Replace the install and relaunch. This cannot happen in-process — the code
/// doing it is inside the folder being replaced — so it is handed to a detached
/// PowerShell script that waits for this process to exit first.
///
/// The install is moved aside rather than mirrored over: /MIR onto a live folder
/// has no way back, and a failure half-way would leave a mixture of two versions.
/// A rename on the same volume is instantaneous, and gives the same rollback the
/// macOS script has.
pub fn swap_and_relaunch(dest: &Path, fresh: &Path, stage: &Path, pid: u32) -> Result<(), String> {
    // Not inside `stage`: the shell keeps a handle on the script it is running,
    // and the script's last act is to delete `stage`.
    let own = super::temp_dir("case-swap-").map_err(|e| e.to_string())?;
    let script = own.join("swap.ps1");
    let p = |p: &Path| pq(&p.to_string_lossy());
    let mut old = dest.as_os_str().to_owned();
    old.push(".old");
    let body = format!(
        r#"$ErrorActionPreference = 'Stop'

# Wait for CASE to exit before replacing its own folder.
Wait-Process -Id {pid} -Timeout 60 -ErrorAction SilentlyContinue

$DEST  = {dest}
$OLD   = {old}
$FRESH = {fresh}
$STAGE = {stage}
$OWN   = {own}

Remove-Item -LiteralPath $OLD -Recurse -Force -ErrorAction SilentlyContinue
Move-Item -LiteralPath $DEST -Destination $OLD

# robocopy reports success with a non-zero code (1 means "files were copied"),
# so the exit code is read rather than trusted to mean failure. Anything under 8
# is a success of some kind; 8 and above is the first real error.
robocopy $FRESH $DEST /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) {{
  Remove-Item -LiteralPath $DEST -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $OLD -Destination $DEST
  exit 1
}}

Remove-Item -LiteralPath $OLD -Recurse -Force -ErrorAction SilentlyContinue
Start-Process -FilePath (Join-Path $DEST 'CASE.exe')
Remove-Item -LiteralPath $STAGE -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $OWN -Recurse -Force -ErrorAction SilentlyContinue
"#,
        dest = p(dest),
        old = p(Path::new(&old)),
        fresh = p(fresh),
        stage = p(stage),
        own = p(&own),
    );
    std::fs::write(&script, body).map_err(|e| e.to_string())?;
    // powershell.exe, not pwsh: Windows PowerShell is always present, and it does
    // not turn robocopy's non-zero success codes into thrown errors the way
    // PowerShell 7.4 does. cwd must be outside DEST, or the move fails on the
    // shell's own handle.
    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ])
    .arg(&script)
    .current_dir(std::env::temp_dir())
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .creation_flags(0x0800_0000 | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    cmd.spawn().map(drop).map_err(|e| e.to_string())
}

/// curl has shipped in Windows since 1803, beside tar.
pub fn curl() -> PathBuf {
    system32("curl.exe")
}

// -------------------------------------------------------------------- misc ---

/// The Dock badge has no Windows equivalent; an overlay on the taskbar button is
/// the gesture. A number does not survive 16 px, so the dot says "something",
/// and the tray menu's "Session health (n)" carries the count.
pub fn set_badge<R: Runtime>(win: &WebviewWindow<R>, n: usize) {
    let icon = (n > 0)
        .then(|| Image::from_bytes(include_bytes!("../../assets/badge.png")).ok())
        .flatten();
    let _ = win.set_overlay_icon(icon);
}

/// Disk usage in bytes, as the sum of file lengths. Windows has no `du`, and
/// robocopy's summary table has localised row labels, which is not a thing to
/// find out from a bug report.
pub fn profile_size(dir: &Path) -> Option<u64> {
    fn walk(dir: &Path) -> u64 {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return 0;
        };
        rd.flatten()
            .map(|e| match e.file_type() {
                Ok(t) if t.is_dir() => walk(&e.path()),
                Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
                _ => 0,
            })
            .sum()
    }
    dir.exists().then(|| walk(dir))
}

static TASKBAR_LIGHT: Mutex<Option<bool>> = Mutex::new(None);

/// Whether the taskbar is light. This is not the same setting as the app theme —
/// Windows 11 ships light apps over a dark taskbar by default, so trusting the app
/// theme here would put a black icon on a black background for most people.
fn taskbar_is_light() -> bool {
    let mut cached = TASKBAR_LIGHT.lock().unwrap_or_else(|e| e.into_inner());
    *cached.get_or_insert_with(|| {
        let Output { ok, out } = run(
            system32("reg.exe"),
            &[
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
                "/v",
                "SystemUsesLightTheme",
            ],
            secs(4),
        );
        ok && out
            .split_whitespace()
            .skip_while(|w| *w != "REG_DWORD")
            .nth(1)
            == Some("0x1")
    })
}

/// Forget the cached taskbar theme, so the next tray build re-reads it.
pub fn forget_theme() {
    *TASKBAR_LIGHT.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// A light taskbar needs the dark glyph, and the other way round. Windows does
/// not recolour a tray icon the way macOS recolours a template.
pub fn tray_image() -> (Image<'static>, bool) {
    let bytes: &'static [u8] = if taskbar_is_light() {
        include_bytes!("../../assets/tray-win.ico")
    } else {
        include_bytes!("../../assets/tray-win-dark.ico")
    };
    (Image::from_bytes(bytes).expect("bundled tray icon"), false)
}

/// Explorer parses its own command line: the path has to follow `/select,` with
/// its own quotes, which ordinary argument quoting would wrap the wrong way.
pub fn reveal(path: &Path) {
    let mut cmd = Command::new("explorer.exe");
    cmd.raw_arg(format!("/select,\"{}\"", path.display()));
    let _ = cmd.spawn();
}

pub fn open_url(url: &str) {
    let _ = Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn();
}

/// On Windows the honest test of a directory is the ACL, which nothing short of
/// writing consults; this answers only the read-only attribute.
pub fn can_write(dir: &Path) -> bool {
    std::fs::metadata(dir).is_ok_and(|m| !m.permissions().readonly())
}

pub mod chrome {
    use super::*;

    fn exe() -> Option<PathBuf> {
        [
            std::env::var_os("ProgramFiles"),
            std::env::var_os("ProgramFiles(x86)"),
            Some(local_app_data().into()),
        ]
        .into_iter()
        .flatten()
        .map(|root| PathBuf::from(root).join(r"Google\Chrome\Application\chrome.exe"))
        .find(|p| p.exists())
    }

    pub fn installed() -> bool {
        exe().is_some()
    }

    pub fn root() -> PathBuf {
        local_app_data().join(r"Google\Chrome\User Data")
    }

    /// Open a Chrome window on a profile. Creates the profile if it does not
    /// exist. Chrome routes by profile itself, so a second launch on a profile
    /// already open just raises its window.
    pub fn launch(profile_dir: &str, url: Option<&str>) {
        let Some(exe) = exe() else { return };
        let _ = Command::new(exe)
            .arg(format!("--profile-directory={profile_dir}"))
            .args(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .spawn();
    }
}
