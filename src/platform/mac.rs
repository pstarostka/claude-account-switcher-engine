//! macOS plumbing: the things that need the shell or LaunchServices. Its
//! counterpart is win.rs.

use super::{Output, run, secs, sq};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{Runtime, WebviewWindow, image::Image};

pub const DEFAULT_HOTKEY: &str = "Alt+Command+C";
/// Which of a release's assets this build can install.
pub const ASSET_TAG: &str = "-mac-";

/// ~/Library/Application Support — where Claude keeps its default profile, where
/// CASE keeps its own data, and where the profiles it creates go.
pub fn app_data() -> PathBuf {
    dirs::data_dir().unwrap_or_default()
}

pub fn profile_root() -> PathBuf {
    app_data()
}

// ------------------------------------------------------------------ claude ---

const CLAUDE_APP: &str = "/Applications/Claude.app";

pub fn claude_installed() -> bool {
    Path::new(CLAUDE_APP).exists()
}

pub fn claude_hint() -> String {
    "Claude is not installed in /Applications — accounts cannot be launched.".into()
}

/// Open Claude on a profile.
///
/// `-n` is what gets a second instance out of a bundle that would otherwise just
/// front the first, and `--env` is the only way to hand a launched .app an
/// environment — macOS gives a GUI app the login session's, not this process's.
pub fn launch_claude(dir: &Path, is_default: bool) -> Result<(), Option<String>> {
    let mut args: Vec<OsString> = vec!["-n".into(), "-a".into(), "Claude".into()];
    if !is_default {
        // Both knobs, because neither is enough on its own. Claude 1.34493.1
        // deletes CLAUDE_USER_DATA_DIR during startup unless a signed
        // CLAUDE_CDP_AUTH token vouches for it, so on current builds the variable
        // alone lands every account on the default profile. --user-data-dir is a
        // Chromium switch Electron applies before any of the app's code runs, so
        // nothing can strip it. The variable stays because older builds honour it,
        // and because when it survives Claude keeps claude_desktop_config.json in
        // the profile rather than a sibling directory.
        //
        // --args goes last: open hands everything after it to the application.
        args.push("--env".into());
        args.push(prefixed("CLAUDE_USER_DATA_DIR=", dir));
        args.push("--args".into());
        args.push(prefixed("--user-data-dir=", dir));
    }
    if run("/usr/bin/open", &args, secs(15)).ok {
        Ok(())
    } else {
        Err(None)
    }
}

fn prefixed(prefix: &str, path: &Path) -> OsString {
    let mut s = OsString::from(prefix);
    s.push(path);
    s
}

/// Front the instance already holding a profile. macOS cannot raise one instance
/// of a bundle, so this fronts whichever Claude the window server picks — hence
/// the ignored argument, which win.rs does use.
pub fn activate_profile(_dir: &Path) {
    run(
        "/usr/bin/osascript",
        &["-e", "tell application \"Claude\" to activate"],
        secs(8),
    );
}

// ---------------------------------------------------------------- processes ---

const PROBES: [&str; 3] = [
    "Cookies",
    "Local Storage/leveldb/LOCK",
    "Network Persistent State",
];

fn probe_files(dir: &Path) -> Vec<PathBuf> {
    PROBES
        .iter()
        .map(|p| dir.join(p))
        .filter(|f| f.exists())
        .collect()
}

/// macOS hides process environments, so there is no way to ask a running Claude
/// which profile it uses. The profile's own open files are the reliable signal.
pub fn is_running(dir: &Path) -> bool {
    let probes = probe_files(dir);
    // In parallel: lsof is the slowest thing this app does.
    std::thread::scope(|s| {
        let probes: Vec<_> = probes
            .iter()
            .map(|f| {
                s.spawn(move || {
                    run("/usr/sbin/lsof", &[OsString::from("--"), f.into()], secs(3)).ok
                })
            })
            .collect();
        probes.into_iter().any(|h| h.join().unwrap_or(false))
    })
}

/// The Claude process holding a given profile directory. Helper processes turn up
/// too, so the list is filtered down to the main binary; ending that takes its
/// helpers with it.
fn pids_for_profile(dir: &Path) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for f in probe_files(dir) {
        let Output { ok, out } = run(
            "/usr/sbin/lsof",
            &[OsString::from("-t"), "--".into(), f.into()],
            secs(4),
        );
        if !ok {
            continue;
        }
        for pid in out
            .lines()
            .map(str::trim)
            .filter(|l| l.parse::<u32>().is_ok())
        {
            if !found.iter().any(|p| p == pid) {
                found.push(pid.to_owned());
            }
        }
    }
    if found.is_empty() {
        return found;
    }
    // comm, not command: the executable alone. The full command line of every
    // account but the default one ends in --user-data-dir=…, not in the binary.
    let ps = run(
        "/bin/ps",
        &["-o", "pid=,comm=", "-p", &found.join(",")],
        secs(8),
    );
    ps.out
        .lines()
        .filter_map(|l| l.trim().split_once(char::is_whitespace))
        .filter(|(_, exe)| exe.trim().ends_with("Claude.app/Contents/MacOS/Claude"))
        .map(|(pid, _)| pid.to_owned())
        .collect()
}

/// Ask one Claude instance to quit, leaving any other account running.
pub fn quit_profile(dir: &Path) -> Result<usize, String> {
    let pids = pids_for_profile(dir);
    if pids.is_empty() {
        return Err("Could not find the process for that account.".into());
    }
    for pid in &pids {
        run("/bin/kill", &["-TERM", pid], secs(4));
    }
    Ok(pids.len())
}

// ---------------------------------------------------------------- shortcut ---

/// This launcher's .app bundle, derived from the running executable:
/// …/CASE.app/Contents/MacOS/CASE → …/CASE.app
pub fn install_path() -> Option<PathBuf> {
    Some(
        std::env::current_exe()
            .ok()?
            .parent()?
            .parent()?
            .parent()?
            .to_path_buf(),
    )
}

pub fn install_looks_sane(p: &Path) -> bool {
    p.extension().is_some_and(|e| e == "app")
}

fn is_pinned() -> bool {
    let Some(app) = install_path() else {
        return false;
    };
    let Output { ok, out } = run(
        "/usr/bin/defaults",
        &["read", "com.apple.dock", "persistent-apps"],
        secs(8),
    );
    if !ok {
        return false;
    }
    // The Dock rewrites entries percent-encoded ("Claude%20Accounts.app"), so a
    // literal path never matches what it stored. Decode before comparing.
    let re = regex::Regex::new(r#""_CFURLString"\s*=\s*"([^"]+)""#).expect("valid pattern");
    re.captures_iter(&out).any(|m| {
        let url = percent_decode(&m[1]);
        Path::new(url.trim_start_matches("file://").trim_end_matches('/')) == app
    })
}

pub struct ShortcutStatus {
    pub present: bool,
    pub blurb: &'static str,
    pub cta: &'static str,
    pub tip: &'static str,
}

pub fn shortcut_status() -> ShortcutStatus {
    ShortcutStatus {
        present: is_pinned(),
        blurb: "Keep this in your Dock so an account is always one click away.",
        cta: "Keep in Dock",
        tip: "Add to the Dock permanently (restarts the Dock)",
    }
}

/// Add the launcher to the Dock permanently. The Dock only re-reads its
/// preferences on restart, so `killall Dock` is part of the operation, not an
/// optional extra — without it the tile does not appear until the next login.
/// Answers whether it was already there.
pub fn shortcut_create() -> Result<bool, String> {
    if is_pinned() {
        return Ok(true);
    }
    let app = install_path().ok_or("Could not work out where this app is installed.")?;
    let tile = format!(
        "<dict><key>tile-data</key><dict><key>file-data</key><dict>\
         <key>_CFURLString</key><string>file://{}/</string>\
         <key>_CFURLStringType</key><integer>15</integer>\
         </dict></dict><key>tile-type</key><string>file-tile</string></dict>",
        percent_encode(&app.to_string_lossy())
    );
    let w = run(
        "/usr/bin/defaults",
        &[
            "write",
            "com.apple.dock",
            "persistent-apps",
            "-array-add",
            &tile,
        ],
        secs(8),
    );
    if !w.ok {
        return Err("Could not write Dock preferences.".into());
    }
    run("/usr/bin/killall", &["Dock"], secs(8));
    // The Dock takes a moment to come back and rewrite its plist.
    std::thread::sleep(std::time::Duration::from_millis(1500));
    if is_pinned() {
        Ok(false)
    } else {
        Err("The Dock did not take the shortcut.".into())
    }
}

/// encodeURI: everything but the characters a URL may carry as they are.
fn percent_encode(s: &str) -> String {
    let keep = |b: u8| b.is_ascii_alphanumeric() || b";,/?:@&=+$-_.!~*'()#".contains(&b);
    s.bytes()
        .map(|b| {
            if keep(b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// decodeURIComponent, keeping the input as it was if it is not valid.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            match b
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok())
            {
                Some(v) => {
                    out.push(v);
                    i += 3;
                    continue;
                }
                None => return s.to_owned(),
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_owned())
}

// ------------------------------------------------------------- login item ---

/// A LaunchAgent rather than a login item: it is a file, so whether it is there
/// is a question with a plain answer, and it can carry --hidden.
fn launch_agent() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join("Library/LaunchAgents/local.launcher.case.plist")
}

pub fn open_at_login() -> bool {
    launch_agent().exists()
}

pub fn set_open_at_login(on: bool) {
    let file = launch_agent();
    if !on {
        let _ = std::fs::remove_file(&file);
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.launcher.case</string>
  <key>ProgramArguments</key>
  <array><string>{}</string><string>--hidden</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
"#,
        esc(&exe.to_string_lossy())
    );
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(file, plist);
}

// ------------------------------------------------------------- self-update ---

/// `ditto`, not `unzip`: the bundle contains symlinks inside its framework and
/// signature metadata beside them, and only ditto puts both back as they were —
/// which is also what the release build used to make the archive.
pub fn unpack(zip: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let out = Command::new("/usr/bin/ditto")
        .arg("-x")
        .arg("-k")
        .arg(zip)
        .arg(dest)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
    }
}

/// The app inside an unpacked download, refused unless it is recognisably ours.
pub fn find_fresh(unpacked: &Path) -> Result<PathBuf, String> {
    let fresh = std::fs::read_dir(unpacked)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .find(|p| install_looks_sane(p))
        .ok_or("The download did not contain an app.")?;
    match std::fs::read_to_string(fresh.join("Contents/Info.plist")) {
        Ok(plist) if plist.contains("local.launcher.case") => Ok(fresh),
        Ok(_) => Err("The download is not CASE, so it was not installed.".into()),
        Err(_) => Err("The download does not look like a macOS app bundle.".into()),
    }
}

/// Replace the bundle and relaunch. This cannot happen in-process — the code
/// doing it lives inside the bundle being replaced — so it is handed to a
/// detached shell script that waits for this process to exit first. The old
/// bundle is moved aside rather than deleted, and moved back if the copy fails,
/// so a failure here leaves a working app rather than none.
pub fn swap_and_relaunch(dest: &Path, fresh: &Path, stage: &Path, pid: u32) -> Result<(), String> {
    use std::os::unix::{fs::PermissionsExt, process::CommandExt};
    let script = stage.join("swap.sh");
    let body = format!(
        r#"#!/bin/sh
# Wait for CASE to exit before touching its own bundle.
for i in $(seq 1 200); do
  kill -0 {pid} 2>/dev/null || break
  sleep 0.1
done

DEST={dest}
FRESH={fresh}
STAGE={stage}

rm -rf "$DEST.old"
mv "$DEST" "$DEST.old" || exit 1
if ! cp -R "$FRESH" "$DEST"; then
  rm -rf "$DEST"
  mv "$DEST.old" "$DEST"
  exit 1
fi
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null
rm -rf "$DEST.old"
open "$DEST"
rm -rf "$STAGE"
"#,
        dest = sq(&dest.to_string_lossy()),
        fresh = sq(&fresh.to_string_lossy()),
        stage = sq(&stage.to_string_lossy()),
    );
    std::fs::write(&script, body).map_err(|e| e.to_string())?;
    let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
    Command::new("/bin/sh")
        .arg(&script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0) // outlives CASE, which is the point
        .spawn()
        .map(drop)
        .map_err(|e| e.to_string())
}

pub fn curl() -> &'static str {
    "/usr/bin/curl"
}

// -------------------------------------------------------------------- misc ---

pub fn set_badge<R: Runtime>(win: &WebviewWindow<R>, n: usize) {
    let _ = win.set_badge_count((n > 0).then_some(n as i64));
}

/// Disk usage in bytes. `du` beats walking the tree: 8 GB measured in ~110 ms,
/// and it counts what Finder counts.
pub fn profile_size(dir: &Path) -> Option<u64> {
    if !dir.exists() {
        return None;
    }
    let out = run(
        "/usr/bin/du",
        &[OsString::from("-sk"), dir.into()],
        secs(20),
    );
    let kb: u64 = out.out.split_whitespace().next()?.parse().ok()?;
    out.ok.then_some(kb * 1024)
}

/// Template images are recoloured by macOS to suit the menu bar, including when
/// it inverts for dark mode or a highlighted menu.
pub fn tray_image() -> (Image<'static>, bool) {
    let img = Image::from_bytes(include_bytes!("../../assets/trayTemplate@2x.png"))
        .expect("bundled tray icon");
    (img, true)
}

/// Nothing to re-read on a theme change: the template recolours itself.
pub fn forget_theme() {}

pub fn reveal(path: &Path) {
    run(
        "/usr/bin/open",
        &[OsString::from("-R"), path.into()],
        secs(8),
    );
}

pub fn open_url(url: &str) {
    run("/usr/bin/open", &[url], secs(8));
}

/// Whether the current user may write into `dir`, without writing anything.
pub fn can_write(dir: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: a valid NUL-terminated path; access(2) only reads it.
    unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
}

pub mod chrome {
    use super::*;

    pub fn installed() -> bool {
        Path::new("/Applications/Google Chrome.app").exists()
    }

    pub fn root() -> PathBuf {
        app_data().join("Google/Chrome")
    }

    /// Open a Chrome window on a profile. Creates the profile if it does not exist.
    pub fn launch(profile_dir: &str, url: Option<&str>) {
        let mut args = vec![
            "-na".to_owned(),
            "Google Chrome".into(),
            "--args".into(),
            format!("--profile-directory={profile_dir}"),
        ];
        args.extend(url.map(str::to_owned));
        run("/usr/bin/open", &args, secs(15));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dock_urls_round_trip_through_percent_encoding() {
        let p = "/Users/me/Applications/CASE copy é.app";
        assert_eq!(percent_decode(&percent_encode(p)), p);
        assert_eq!(percent_encode("/a b"), "/a%20b");
        assert_eq!(
            percent_decode("bad%zz"),
            "bad%zz",
            "an invalid escape leaves the input alone"
        );
    }
}
