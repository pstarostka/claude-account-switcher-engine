//! Profile lifecycle: move one aside without deleting it, and back again.
//!
//! Archiving is a rename inside the same directory, never a copy-then-delete.
//! That matters for more than speed: a rename is atomic and reversible, so there
//! is no window where the data exists in two half-states, and no path where a
//! failure half-way through loses anything. A profile is 0.5–8 GB, so copying it
//! would also be minutes of I/O to achieve strictly less.
//!
//! Nothing here deletes, with one exception that is named as such and sits behind
//! its own confirmation.

use crate::store::{Account, Archived};
use std::path::{Path, PathBuf};

const SUFFIX: &str = ".archived";

/// First free path of the form `base`, `base-2`, `base-3`…
fn free_path(base: &Path) -> PathBuf {
    let mut p = base.to_path_buf();
    for i in 2.. {
        if !p.exists() {
            break;
        }
        let mut s = base.as_os_str().to_owned();
        s.push(format!("-{i}"));
        p = s.into();
    }
    p
}

pub fn is_archive_path(name: &str) -> bool {
    name.contains(SUFFIX)
}

/// Rename, with a few attempts before giving up.
///
/// The rename *is* the operation here, and on Windows it fails outright while any
/// file inside the directory is held open — which Defender, Windows Search or an
/// Explorer preview will do briefly, for reasons that have nothing to do with us.
/// macOS renames a directory with open files without complaint, so on a Mac this
/// loop only ever runs once.
fn rename(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match std::fs::rename(from, to) {
            Err(e)
                if attempt < 3
                    && (e.kind() == std::io::ErrorKind::PermissionDenied
                        || e.raw_os_error() == Some(32)) =>
            {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            r => return r,
        }
    }
}

/// Move a profile aside, returning the record to store. The caller is
/// responsible for the guards that make this safe to offer at all — not the
/// default profile, not while it is running.
pub fn archive(account: &Account, bytes: Option<u64>) -> Result<Archived, String> {
    if !account.dir.exists() {
        return Err("That profile folder is no longer there.".into());
    }
    let mut base = account.dir.as_os_str().to_owned();
    base.push(SUFFIX);
    let dest = free_path(Path::new(&base));
    rename(&account.dir, &dest).map_err(|e| format!("Could not move the profile aside: {e}"))?;
    Ok(Archived {
        id: account.id.clone(),
        name: account.name.clone(),
        emoji: account.emoji.clone(),
        hue: account.hue,
        chrome: account.chrome.clone(),
        dir: dest,
        original_dir: account.dir.clone(),
        archived_at: crate::now_ms(),
        bytes,
    })
}

/// Move an archived profile back. If something has since taken its old path — a
/// new account of the same name, say — it lands beside it rather than over it.
/// Answers where it went.
pub fn restore(record: &Archived) -> Result<PathBuf, String> {
    if !record.dir.exists() {
        return Err("The archived folder is no longer there.".into());
    }
    let dest = free_path(&record.original_dir);
    rename(&record.dir, &dest).map_err(|e| format!("Could not move the profile back: {e}"))?;
    Ok(dest)
}

/// The one destructive call here. Named plainly; confirmed by the caller.
pub fn destroy(record: &Archived) -> Result<(), String> {
    match std::fs::remove_dir_all(&record.dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(format!("Could not delete the archive: {e}"))
        }
        _ => Ok(()),
    }
}

/// Records whose folder has gone missing are reported, not silently dropped.
pub fn with_status(records: &[Archived]) -> serde_json::Value {
    records
        .iter()
        .map(|r| {
            let mut v = serde_json::to_value(r).unwrap_or_default();
            v["exists"] = r.dir.exists().into();
            v
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archiving_renames_aside_and_restoring_steps_around_a_namesake() {
        let root = crate::platform::temp_dir("case-archive-").unwrap();
        let account = crate::store::new_account("Work", root.join("Claude-Work"));
        std::fs::create_dir_all(account.dir.join("Cookies")).unwrap();
        // A previous archive is already in the way.
        std::fs::create_dir_all(root.join("Claude-Work.archived")).unwrap();

        let record = archive(&account, Some(5)).unwrap();
        assert_eq!(record.dir, root.join("Claude-Work.archived-2"));
        assert!(record.dir.join("Cookies").exists() && !account.dir.exists());

        // A new account has since taken the old name.
        std::fs::create_dir_all(&account.dir).unwrap();
        assert_eq!(restore(&record).unwrap(), root.join("Claude-Work-2"));
        let _ = std::fs::remove_dir_all(root);
    }
}
