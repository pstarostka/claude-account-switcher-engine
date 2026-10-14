//! Self-update from GitHub releases.
//!
//! Neither build is signed by an identity the OS recognises, so there is no
//! platform updater to lean on: the update is done by hand — download the release
//! zip, check it against the checksum published beside it, unpack it, and swap
//! the app while it is on its way out.
//!
//! The fetching is the system's own curl, which ships with macOS and with
//! Windows since 1803. A useful side effect of downloading it ourselves: the
//! quarantine flag and the mark of the web are set by browsers, not by curl, so
//! updates install cleanly even though the *first* download needs the OS talked
//! round. See README.
//!
//! Everything here is opt-in and reversible: the old app is moved aside, not
//! deleted, and put back if the copy fails.

use crate::platform;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn repo() -> &'static str {
    env!("CARGO_PKG_REPOSITORY").trim_start_matches("https://github.com/")
}

pub fn releases_page() -> String {
    format!("https://github.com/{}/releases/latest", repo())
}

// ------------------------------------------------------------------ version ---

pub fn cmp_parts(a: &[u64], b: &[u64]) -> Ordering {
    (0..a.len().max(b.len()))
        .map(|i| a.get(i).unwrap_or(&0).cmp(b.get(i).unwrap_or(&0)))
        .find(|o| o.is_ne())
        .unwrap_or(Ordering::Equal)
}

/// Compare dotted numeric versions. Any pre-release suffix loses to the release.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let parse = |v: &str| -> Vec<u64> {
        let core = v
            .trim_start_matches('v')
            .split(['-', '+'])
            .next()
            .unwrap_or("");
        core.split('.')
            .map(|n| {
                n.trim()
                    .chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect()
    };
    let release = |v: &str| !v.contains('-');
    cmp_parts(&parse(a), &parse(b)).then(release(a).cmp(&release(b)))
}

#[derive(Deserialize, Clone, Debug)]
pub struct Asset {
    pub name: String,
    #[serde(default)]
    pub browser_download_url: String,
    #[serde(default)]
    pub size: u64,
}

/// This platform's zip out of a release, and the checksum published for *that*
/// zip.
///
/// Both halves matter once a release carries more than one build. Taking the
/// first `.zip` would hand a Mac a Windows build; taking the first `.sha256`
/// would check one platform's download against the other's checksum, and the
/// only symptom would be a corrupt-download error that never goes away.
///
/// `tag` is a parameter so this can be tested in both directions from either
/// machine.
pub fn pick_asset<'a>(assets: &'a [Asset], tag: &str) -> (Option<&'a Asset>, Option<&'a Asset>) {
    let zip = assets.iter().find(|a| {
        let n = a.name.to_lowercase();
        n.ends_with(".zip") && n.contains(tag)
    });
    let sum = zip.and_then(|z| {
        assets
            .iter()
            .find(|a| a.name == format!("{}.sha256", z.name))
    });
    (zip, sum)
}

// -------------------------------------------------------------------- fetch ---

/// GET a URL with curl, answering the status and the body.
fn get(url: &str, accept_json: bool) -> Result<(u16, String), String> {
    let mut cmd = Command::new(platform::curl());
    cmd.args([
        "-sSL",
        "--max-time",
        "30",
        "-w",
        "\n%{http_code}",
        "-H",
        &format!("User-Agent: CASE/{VERSION}"),
    ]);
    if accept_json {
        cmd.args(["-H", "Accept: application/vnd.github+json"]);
    }
    platform::hide_console(&mut cmd);
    let out = cmd
        .arg(url)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run curl: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.trim().trim_start_matches("curl: ").to_owned());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let (body, code) = text.rsplit_once('\n').ok_or("no response")?;
    Ok((code.trim().parse().unwrap_or(0), body.to_owned()))
}

#[derive(Serialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub ok: bool,
    pub current: String,
    pub version: Option<String>,
    pub available: bool,
    pub unverifiable: bool,
    pub no_build: bool,
    pub none: bool,
    pub notes: Option<String>,
    pub published_at: Option<f64>,
    pub url: Option<String>,
    pub bytes: Option<u64>,
    pub sha256_url: Option<String>,
    pub page: String,
    pub error: Option<String>,
}

/// What the latest release is, and whether it is newer than what is running.
/// Never fails at the caller: a check that cannot reach GitHub is not an error
/// worth interrupting anyone over.
pub fn check() -> Check {
    let base = Check {
        current: VERSION.into(),
        page: releases_page(),
        ..Default::default()
    };
    let (status, body) = match get(
        &format!("https://api.github.com/repos/{}/releases/latest", repo()),
        true,
    ) {
        Ok(r) => r,
        Err(error) => {
            return Check {
                error: Some(error),
                ..base
            };
        }
    };
    // A repo with no releases yet answers 404 here. GitHub was reached and
    // answered honestly, so reporting it as unreachable would be a lie.
    if status == 404 {
        return Check {
            ok: true,
            none: true,
            ..base
        };
    }
    if status != 200 {
        return Check {
            error: Some(format!("GitHub returned {status}")),
            ..base
        };
    }
    let Ok(rel) = serde_json::from_str::<Value>(&body) else {
        return Check {
            error: Some("GitHub answered with something that is not a release".into()),
            ..base
        };
    };
    if rel["draft"] == true {
        return Check { ok: true, ..base };
    }
    from_release(&rel, platform::ASSET_TAG, base)
}

fn from_release(rel: &Value, tag: &str, base: Check) -> Check {
    let version = rel["tag_name"]
        .as_str()
        .unwrap_or("")
        .trim_start_matches('v')
        .to_owned();
    let assets: Vec<Asset> = serde_json::from_value(rel["assets"].clone()).unwrap_or_default();
    let (zip, sum) = pick_asset(&assets, tag);
    let newer = compare_versions(&version, VERSION).is_gt();
    Check {
        ok: true,
        // A release with no checksum beside it cannot be installed — download()
        // refuses it — so it is reported as found rather than offered. Calling it
        // unavailable would amount to saying this version is the latest, which is
        // not true and is the one thing a version check must not get wrong.
        available: newer && zip.is_some() && sum.is_some(),
        unverifiable: newer && zip.is_some() && sum.is_none(),
        // Same reasoning, one step earlier: a release built for the other platform
        // only is still a newer release.
        no_build: newer && zip.is_none(),
        notes: rel["body"].as_str().map(|s| s.chars().take(2000).collect()),
        published_at: rel["published_at"]
            .as_str()
            .and_then(crate::health::parse_iso),
        url: zip.map(|a| a.browser_download_url.clone()),
        bytes: zip.map(|a| a.size),
        sha256_url: sum.map(|a| a.browser_download_url.clone()),
        page: rel["html_url"]
            .as_str()
            .map_or(base.page.clone(), str::to_owned),
        version: Some(version),
        ..base
    }
}

// ----------------------------------------------------------------- download ---

pub struct Staged {
    pub stage: PathBuf,
    zip: PathBuf,
}

fn sha256(file: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(file)?;
    let mut h = Sha256::new();
    let mut buf = vec![0; 1 << 16];
    loop {
        match f.read(&mut buf)? {
            0 => break,
            n => h.update(&buf[..n]),
        }
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Stream the release to disk with curl, reporting progress by watching the file
/// grow. curl gives up on a connection that stalls for thirty seconds.
fn fetch_to(url: &str, file: &Path, total: u64, on_progress: &dyn Fn(f64)) -> Result<(), String> {
    let mut cmd = Command::new(platform::curl());
    cmd.args([
        "-fsSL",
        "--speed-time",
        "30",
        "--speed-limit",
        "1",
        "-H",
        &format!("User-Agent: CASE/{VERSION}"),
        "-o",
    ])
    .arg(file)
    .arg(url)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped());
    platform::hide_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not run curl: {e}"))?;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if total > 0 {
            let seen = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
            on_progress((seen as f64 / total as f64).min(1.0));
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    if status.success() {
        return Ok(());
    }
    let mut err = String::new();
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut err);
    }
    Err(format!(
        "Download failed: {}",
        err.trim().trim_start_matches("curl: ")
    ))
}

/// Fetch the release zip and prove it is what the release says it is. Without a
/// signature to lean on, the published checksum is what stands between a
/// download and running whatever arrived — so a release with no .sha256 beside
/// it is refused rather than trusted.
///
/// Note what this does and does not buy: the checksum is fetched from the same
/// release as the zip, so it proves the bytes arrived intact from GitHub, not
/// that GitHub served something trustworthy. A signature would prove the latter;
/// this proves the former, which is the part a transfer can get wrong.
pub fn download(info: &Check, on_progress: &dyn Fn(f64)) -> Result<Staged, String> {
    let url = info
        .url
        .as_deref()
        .ok_or("That release has no download attached.")?;
    let sum_url = info
        .sha256_url
        .as_deref()
        .ok_or("That release has no checksum published, so it will not be installed.")?;

    let stage = platform::temp_dir("case-update-").map_err(|e| e.to_string())?;
    let staged = Staged {
        zip: stage.join("CASE.zip"),
        stage,
    };
    let verify = || -> Result<(), String> {
        fetch_to(url, &staged.zip, info.bytes.unwrap_or(0), on_progress)?;
        let (status, text) = get(sum_url, false)?;
        let expected = text.split_whitespace().next().unwrap_or("").to_lowercase();
        let actual = sha256(&staged.zip).map_err(|e| e.to_string())?;
        let hex = expected.len() == 64 && expected.bytes().all(|b| b.is_ascii_hexdigit());
        if status != 200 || !hex || expected != actual {
            return Err(
                "The download did not match its published checksum, so it was discarded.".into(),
            );
        }
        Ok(())
    };
    // Every way out of here other than a verified download would leave ~20 MB of
    // nothing in the temp directory.
    verify().inspect_err(|_| discard(&staged)).map(|()| staged)
}

/// Throw away a staged download that will not be installed after all.
pub fn discard(staged: &Staged) {
    let _ = std::fs::remove_dir_all(&staged.stage);
}

// -------------------------------------------------------------------- apply ---

/// Swap the installed app and relaunch.
///
/// The replacement cannot happen in-process — the code doing it lives inside what
/// is being replaced — so each platform hands it to a detached script that waits
/// for this process to exit first. What is common to both lives here; how a
/// bundle or a folder is actually unpacked, identified and swapped is in the
/// platform module.
pub fn apply(staged: &Staged) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("Updates only apply to an installed release build, not to a debug run.".into());
    }
    let dest = platform::install_path()
        .filter(|p| platform::install_looks_sane(p))
        .ok_or("Could not work out where this app is installed.")?;
    if !dest.parent().is_some_and(platform::can_write) {
        return Err(format!(
            "No permission to replace {}. Move the app somewhere you own.",
            dest.display()
        ));
    }
    let unpacked = staged.stage.join("unpacked");
    platform::unpack(&staged.zip, &unpacked)
        .map_err(|e| format!("Could not unpack the download: {e}"))?;
    // Refuse anything that is not recognisably this app, however it got here.
    let fresh = platform::find_fresh(&unpacked)?;
    platform::swap_and_relaunch(&dest, &fresh, &staged.stage, std::process::id())
}

#[cfg(test)]
mod tests {
    //! Version ordering decides whether anyone is offered an update at all, and
    //! asset matching decides which of a release's builds each platform installs.

    use super::*;

    fn newer(a: &str, b: &str) -> bool {
        compare_versions(a, b).is_gt()
    }

    #[test]
    fn ordering_is_numeric_not_lexicographic() {
        assert!(
            newer("3.10.0", "3.2.0"),
            "10 is a later minor than 2, though it sorts earlier as text"
        );
        assert!(newer("3.1.1", "3.1.0"));
        assert!(
            !newer("3.1.0", "3.1.0"),
            "the running version is not an update"
        );
        assert!(!newer("3.1.0", "3.1.1"), "nor is an older one");
    }

    #[test]
    fn a_leading_v_is_ignored_and_a_shorter_version_is_padded() {
        assert!(
            compare_versions("v3.1.0", "3.1.0").is_eq(),
            "tags carry a v, Cargo.toml does not"
        );
        assert!(compare_versions("3.1", "3.1.0").is_eq());
        assert!(newer("3.2", "3.1.9"));
    }

    #[test]
    fn a_pre_release_loses_to_the_release_it_precedes() {
        assert!(newer("3.2.0", "3.2.0-beta.1"));
        assert!(!newer("3.2.0-beta.1", "3.2.0"));
        assert!(
            newer("3.2.0-beta.1", "3.1.0"),
            "but still beats a genuinely older release"
        );
    }

    fn release(names: &[&str]) -> Vec<Asset> {
        names
            .iter()
            .map(|n| Asset {
                name: (*n).into(),
                browser_download_url: format!("https://x/{n}"),
                size: 1,
            })
            .collect()
    }

    const BOTH: &[&str] = &[
        "CASE-4.0.0-mac-universal.zip",
        "CASE-4.0.0-mac-universal.zip.sha256",
        "CASE-4.0.0-win-x64.zip",
        "CASE-4.0.0-win-x64.zip.sha256",
    ];

    #[test]
    fn each_platform_takes_its_own_zip_and_the_checksum_published_for_it() {
        let assets = release(BOTH);
        let (zip, sum) = pick_asset(&assets, "-mac-");
        assert_eq!(
            (zip.unwrap().name.as_str(), sum.unwrap().name.as_str()),
            (
                "CASE-4.0.0-mac-universal.zip",
                "CASE-4.0.0-mac-universal.zip.sha256"
            )
        );
        let (zip, sum) = pick_asset(&assets, "-win-");
        assert_eq!(
            (zip.unwrap().name.as_str(), sum.unwrap().name.as_str()),
            ("CASE-4.0.0-win-x64.zip", "CASE-4.0.0-win-x64.zip.sha256")
        );
    }

    #[test]
    fn a_release_built_for_the_other_platform_yields_nothing_at_all() {
        let mac_only = release(&BOTH[..2]);
        let (zip, sum) = pick_asset(&mac_only, "-win-");
        assert!(zip.is_none() && sum.is_none());
        assert!(pick_asset(&[], "-mac-").0.is_none());
    }

    #[test]
    fn a_checksum_belonging_to_the_other_build_is_not_accepted_as_this_ones() {
        let assets = release(&[
            "CASE-4.0.0-win-x64.zip",
            "CASE-4.0.0-mac-universal.zip.sha256",
        ]);
        let (zip, sum) = pick_asset(&assets, "-win-");
        assert_eq!(zip.unwrap().name, "CASE-4.0.0-win-x64.zip");
        assert!(
            sum.is_none(),
            "an unpaired checksum reads as none, so download() refuses it"
        );
    }

    #[test]
    fn a_sha256_is_never_mistaken_for_the_zip_itself() {
        assert!(
            pick_asset(&release(&["CASE-4.0.0-mac-universal.zip.sha256"]), "-mac-")
                .0
                .is_none()
        );
    }

    #[test]
    fn a_newer_release_is_offered_named_or_refused_by_what_it_carries() {
        let rel = |names: &[&str]| {
            let assets: Vec<Value> = names
                .iter()
                .map(|n| serde_json::json!({ "name": n, "browser_download_url": "u", "size": 1 }))
                .collect();
            from_release(
                &serde_json::json!({ "tag_name": "v99.0.0", "assets": assets }),
                "-mac-",
                Check::default(),
            )
        };
        assert!(rel(&BOTH[..2]).available);
        let bare = rel(&BOTH[..1]);
        assert!(
            !bare.available && bare.unverifiable,
            "newer but unchecked is named, not offered, and not 'latest'"
        );
        assert!(
            rel(&BOTH[2..]).no_build,
            "a release for the other platform only is still not 'latest'"
        );
    }
}
