//! One narrow surface for the plumbing that differs by operating system.
//!
//! The rule for what belongs here: anything that spawns a process or asks the OS
//! a question. Anything that is only a *path* stays in the module that uses it —
//! health.rs and chrome.rs read their own roots.
//!
//! mac.rs and win.rs export the same names. The compiler holds them to it on
//! whichever machine builds, and CI builds on both.
//!
//! The pure helpers below are compiled everywhere, whichever platform uses them,
//! so their tests run on both.

use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
pub use mac::*;

#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use win::*;

pub struct Output {
    pub ok: bool,
    pub out: String,
}

/// Run a helper to completion and collect its stdout, giving up after `timeout`.
/// Never fails at the caller: a helper that cannot start reads as `ok: false`.
pub fn run<S: AsRef<OsStr>>(cmd: impl AsRef<OsStr>, args: &[S], timeout: Duration) -> Output {
    let mut c = Command::new(cmd);
    c.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_console(&mut c);
    let Ok(mut child) = c.spawn() else {
        return Output {
            ok: false,
            out: String::new(),
        };
    };

    // Drained on a thread of its own, or a chatty helper fills the pipe and
    // blocks for ever while this side waits for it to exit.
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let out = reader.join().unwrap_or_default();
    Output {
        ok: status.is_some_and(|s| s.success()),
        out: String::from_utf8_lossy(&out).into_owned(),
    }
}

/// The main binary is a GUI-subsystem exe on Windows, so a console child
/// started without this flashes a black window.
pub fn hide_console(_c: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        _c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
}

pub const fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

/// A fresh, empty directory under the system temp dir.
pub fn temp_dir(prefix: &str) -> std::io::Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("{prefix}{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Whether `file` contains `needle` anywhere. Used as an identity check on a
/// downloaded build: the bundle identifier is compiled into the executable.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn file_contains(file: &Path, needle: &[u8]) -> bool {
    std::fs::read(file).is_ok_and(|b| b.windows(needle.len()).any(|w| w == needle))
}

/// Quote a string for /bin/sh. Single quotes are the only ones sh does nothing
/// inside, so the single quote itself is the one character needing care.
#[cfg_attr(not(unix), allow(dead_code))]
pub fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Quote a string for PowerShell. Single quotes are the only ones PowerShell does
/// nothing inside, and the single quote itself escapes by doubling — so unlike
/// sh, there is no backslash involved.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn pq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// The highest-versioned `app-<version>` directory in a Squirrel install.
///
/// Squirrel keeps every version it has installed side by side and only the newest
/// is current. Picking that by sorting the names as text is wrong the first time
/// a minor reaches 10 — `app-0.9.9` sorts after `app-0.10.0` — and the symptom
/// would be CASE quietly launching a stale Claude for ever.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn newest_app_dir<S: AsRef<str>>(names: &[S]) -> Option<String> {
    let version =
        |n: &str| -> Vec<u64> { n[4..].split('.').map(|x| x.parse().unwrap_or(0)).collect() };
    names
        .iter()
        .map(AsRef::as_ref)
        .filter(|n| n.starts_with("app-") && n[4..].starts_with(|c: char| c.is_ascii_digit()))
        .max_by(|a, b| crate::update::cmp_parts(&version(a), &version(b)))
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Both swap scripts are built around paths the app does not choose: it can be
    // installed anywhere and named anything. Nothing in a path may execute.
    const HOSTILE: &[&str] = &[
        "it's here",
        "two words",
        "CA$(id -un)SE",
        "`id -un`",
        "$HOME",
        "x;touch /tmp/case-quoting-canary",
        r"back\slash",
        "%APPDATA%",
        "a&b",
        "100% done",
    ];

    #[cfg(unix)]
    #[test]
    fn paths_reach_the_sh_swap_script_literally() {
        for p in HOSTILE {
            let out = Command::new("/bin/sh")
                .arg("-c")
                .arg(format!("P={}; printf %s \"$P\"", sq(p)))
                .output()
                .unwrap();
            assert_eq!(
                String::from_utf8_lossy(&out.stdout),
                *p,
                "{p} did not survive quoting intact"
            );
        }
        assert!(
            !Path::new("/tmp/case-quoting-canary").exists(),
            "a path with a ; must not run a command"
        );
    }

    #[test]
    fn the_powershell_quoting_doubles_the_only_character_that_escapes() {
        assert_eq!(pq("plain"), "'plain'");
        assert_eq!(pq("it's"), "'it''s'");
        assert_eq!(pq("$HOME `x` %A% & ;"), "'$HOME `x` %A% & ;'");
    }

    #[cfg(windows)]
    #[test]
    fn paths_reach_the_powershell_swap_script_literally() {
        for p in HOSTILE {
            let out = Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    &format!("Write-Output {}", pq(p)),
                ])
                .output()
                .unwrap();
            assert_eq!(
                String::from_utf8_lossy(&out.stdout).trim_end_matches(['\r', '\n']),
                *p
            );
        }
    }

    #[test]
    fn a_squirrel_install_is_ordered_by_version_not_by_name() {
        assert_eq!(
            newest_app_dir(&["app-0.9.9", "app-0.10.0", "app-0.9.10"]).as_deref(),
            Some("app-0.10.0")
        );
        assert_eq!(
            newest_app_dir(&["app-1.2.3", "app-1.2.10"]).as_deref(),
            Some("app-1.2.10")
        );
        assert_eq!(
            newest_app_dir(&["app-2.0.0", "app-10.0.0"]).as_deref(),
            Some("app-10.0.0")
        );
    }

    #[test]
    fn only_version_directories_count_as_an_install() {
        assert_eq!(
            newest_app_dir(&["Update.exe", "packages", "app-1.0.0"]).as_deref(),
            Some("app-1.0.0")
        );
        assert_eq!(newest_app_dir(&["Update.exe", "packages"]), None);
        assert_eq!(newest_app_dir::<&str>(&[]), None);
    }

    #[test]
    fn a_helper_that_overruns_is_cut_off() {
        #[cfg(unix)]
        let started = Instant::now();
        #[cfg(unix)]
        assert!(!run("/bin/sleep", &["5"], Duration::from_millis(200)).ok);
        #[cfg(unix)]
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!run("/no/such/helper", &[] as &[&str], secs(1)).ok);
    }
}
