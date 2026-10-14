//! Session safety net.
//!
//! Claude Desktop keeps a session *index* inside each profile:
//!
//!     <profile>/claude-code-sessions/<accountUuid>/<orgUuid>/local_*.json
//!
//! The conversation itself lives somewhere else entirely — Claude Code writes
//! transcripts to ~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl. The two
//! are joined by the index entry's cliSessionId.
//!
//! That split is why sessions can disappear while every message survives: if the
//! app cannot write the index (a symlinked storage dir makes ensureStorageDir
//! fail with ENOTDIR), it keeps the session in memory, logs the failure, and
//! carries on. Nothing looks wrong until it restarts, and then the session is
//! simply not in the list.
//!
//! This module is deliberately additive. It reads Claude's data, copies it, and
//! creates missing index entries. It never edits or deletes anything of Claude's.

use crate::store::Account;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

const KEEP_BACKUPS: usize = 10;

/// The three places outside a profile that a scan reads. A value rather than
/// constants, so a test can point them at a fixture.
pub struct Places {
    pub projects: PathBuf,
    /// The profile Claude uses when nothing points it elsewhere.
    pub default_profile: PathBuf,
    /// The log Electron gives the app — on macOS shared by every profile since
    /// Claude 1.34493.1.
    pub shared_log: PathBuf,
}

impl Places {
    pub fn system() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let default_profile = crate::platform::app_data().join("Claude");
        // On Windows Electron's default log directory is <userData>/logs, so for
        // the default profile the shared log sits inside the profile itself.
        let shared_log = if cfg!(windows) {
            default_profile.join("logs").join("main.log")
        } else {
            home.join("Library/Logs/Claude/main.log")
        };
        Self {
            projects: home.join(".claude").join("projects"),
            default_profile,
            shared_log,
        }
    }
}

// ------------------------------------------------------------------ file io ---

/// At most `bytes` from the start (or the end) of a file, as text — without
/// pulling in a 14 MB transcript. A file that is not there reads as empty.
fn read_part(file: &Path, bytes: u64, from_end: bool) -> String {
    let Ok(mut f) = std::fs::File::open(file) else {
        return String::new();
    };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let len = bytes.min(size);
    if from_end && f.seek(SeekFrom::Start(size - len)).is_err() {
        return String::new();
    }
    let mut buf = Vec::with_capacity(len as usize);
    let _ = f.take(len).read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

// Split on either ending: Claude writes this log on Windows too, and a stray \r
// left on the end of a line both trails into the reason shown in the UI and
// defeats the `$` anchor the failure pattern relies on.
fn lines(text: &str) -> Vec<&str> {
    text.lines().filter(|l| !l.is_empty()).collect()
}

/// A partial read almost always slices a line in half at one end, so the last
/// line is dropped, and the first too when reading from the end.
fn parse_jsonl(text: &str, skip_first: bool) -> Vec<Value> {
    let ls = lines(text);
    let end = if ls.len() > 1 { ls.len() - 1 } else { ls.len() };
    ls.get(usize::from(skip_first)..end)
        .unwrap_or_default()
        .iter()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

fn ms(t: std::io::Result<std::time::SystemTime>) -> f64 {
    t.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// Milliseconds since the epoch for an RFC 3339 timestamp, as Date.parse reads one.
pub fn parse_iso(s: &str) -> Option<f64> {
    let t = time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok()?;
    Some((t.unix_timestamp_nanos() / 1_000_000) as f64)
}

fn read_dir(dir: &Path) -> impl Iterator<Item = std::fs::DirEntry> {
    std::fs::read_dir(dir).into_iter().flatten().flatten()
}

fn is_dir(e: &std::fs::DirEntry) -> bool {
    e.file_type().is_ok_and(|t| t.is_dir())
}

fn name(e: &std::fs::DirEntry) -> String {
    e.file_name().to_string_lossy().into_owned()
}

// ------------------------------------------------------------------- index ---

struct Namespace {
    account: String,
    org: String,
    dir: PathBuf,
}

/// Every namespace directory in a profile's session index.
fn namespaces(profile: &Path) -> Vec<Namespace> {
    let mut out = Vec::new();
    for a in read_dir(&profile.join("claude-code-sessions")).filter(is_dir) {
        for o in read_dir(&a.path()).filter(is_dir) {
            out.push(Namespace {
                account: name(&a),
                org: name(&o),
                dir: o.path(),
            });
        }
    }
    out
}

fn is_entry(file: &str) -> bool {
    file.starts_with("local_") && file.ends_with(".json")
}

struct Entry {
    ns_account: String,
    ns_org: String,
    file: PathBuf,
    session_id: Option<String>,
    cli_session_id: Option<String>,
}

fn index_entries(profile: &Path) -> Vec<Entry> {
    let mut out = Vec::new();
    for ns in namespaces(profile) {
        for f in read_dir(&ns.dir).filter(|f| is_entry(&name(f))) {
            let Ok(raw) = std::fs::read(f.path()) else {
                continue;
            };
            let Ok(v) = serde_json::from_slice::<Value>(&raw) else {
                continue;
            };
            let field = |k: &str| v[k].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
            out.push(Entry {
                ns_account: ns.account.clone(),
                ns_org: ns.org.clone(),
                file: f.path(),
                session_id: field("sessionId"),
                cli_session_id: field("cliSessionId"),
            });
        }
    }
    out
}

/// Where a rebuilt entry should go: the busiest namespace, matching the signed-in
/// account when known.
fn target_namespace(profile: &Path) -> Option<Namespace> {
    let preferred = std::fs::read(profile.join("config.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|c| c["lastKnownAccountUuid"].as_str().map(str::to_owned));
    let mut scored: Vec<_> = namespaces(profile)
        .into_iter()
        .map(|ns| {
            let n = read_dir(&ns.dir)
                .filter(|f| name(f).starts_with("local_"))
                .count();
            (preferred.as_deref() == Some(ns.account.as_str()), n, ns)
        })
        .collect();
    // Stable, so ties keep directory order, as before.
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    scored.into_iter().next().map(|(_, _, ns)| ns)
}

#[derive(Serialize)]
pub struct Storage {
    pub ok: bool,
    pub reason: Option<&'static str>,
}

/// Is the index writable right now? The log keeps every historical failure, so
/// without this a fixed problem would raise a warning for ever.
fn storage_health(profile: &Path) -> Storage {
    let Some(ns) = target_namespace(profile) else {
        return Storage {
            ok: false,
            reason: Some("no session index yet"),
        };
    };
    // Not on Windows: an NTFS junction reads as a symbolic link, and a junctioned
    // storage directory does not reproduce the ENOTDIR failure this check exists
    // to catch. The trial write below answers the real question.
    if !cfg!(windows)
        && std::fs::symlink_metadata(&ns.dir).is_ok_and(|m| m.file_type().is_symlink())
    {
        return Storage {
            ok: false,
            reason: Some("the storage directory is a symlink, which the app refuses to write into"),
        };
    }
    if !writable(&ns.dir) {
        return Storage {
            ok: false,
            reason: Some("the storage directory is not writable"),
        };
    }
    Storage {
        ok: true,
        reason: None,
    }
}

/// Whether a directory can actually be written to.
///
/// On Windows the read-only attribute says nothing about the ACL, so a directory
/// nothing may write to still passes — which would make this whole check report
/// "fine" for the exact failure it exists to catch. The only honest test there is
/// to write something.
///
/// Everywhere else access(2) is a good enough approximation and is left alone,
/// because this scan runs every two minutes and the promise above is that it does
/// not put anything into Claude's directories.
fn writable(dir: &Path) -> bool {
    if !cfg!(windows) {
        return crate::platform::can_write(dir);
    }
    // Created and removed in the same breath. The pid is in the name so two
    // copies cannot collide.
    let probe = dir.join(format!(".case-write-probe-{}", std::process::id()));
    let ok = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

// --------------------------------------------------------------------- logs ---

static MAP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"Mapping internal session (local_[0-9a-f-]+) to CLI session ([0-9a-f-]+)").unwrap()
});
static FAIL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(\S+ \S+) \[error\] Failed to save session (local_[0-9a-f-]+): (.+)$").unwrap()
});

struct Failure {
    at: String,
    reason: String,
}

struct Log {
    /// cliSessionId → localId, in the order the log first named each.
    mappings: Vec<(String, String)>,
    failures: Vec<Failure>,
    file: PathBuf,
    exists: bool,
}

/// The app logs every internal-session → CLI-session pairing. That log is the
/// only record that a transcript ever belonged to a *desktop* session, which is
/// what separates a genuinely lost session from an ordinary CLI transcript.
fn read_log(profile: &Path, places: &Places) -> Log {
    // Profiles launched with CLAUDE_USER_DATA_DIR got a log of their own at
    // <profile>/Logs. Claude 1.34493.1 drops that variable, so accounts started
    // under --user-data-dir write to the shared log instead and this finds
    // nothing for them. That silence is the right answer, not a gap: only the
    // default profile may fall back to the shared log, because for any other one
    // reading it would report every session in there as this account's, none of
    // them in this account's index — the whole of someone else's history called
    // lost.
    let own = profile.join("Logs").join("main.log");
    let file = if !own.exists() && profile == places.default_profile {
        places.shared_log.clone()
    } else {
        own
    };
    let text = read_part(&file, 8 * 1024 * 1024, true);

    let mut mappings: Vec<(String, String)> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for m in MAP_RE.captures_iter(&text) {
        let (local, cli) = (m[1].to_owned(), m[2].to_owned());
        match at.get(&cli) {
            Some(&i) => mappings[i].1 = local,
            None => {
                at.insert(cli.clone(), mappings.len());
                mappings.push((cli, local));
            }
        }
    }

    let failures = lines(&text)
        .into_iter()
        .filter_map(|l| FAIL_RE.captures(l))
        .map(|m| Failure {
            at: m[1].to_owned(),
            // The log escapes newlines inside a message; the first line is the reason.
            reason: m[3]
                .split("\\n")
                .next()
                .unwrap_or_default()
                .chars()
                .take(200)
                .collect(),
        })
        .collect();

    let exists = file.exists();
    Log {
        mappings,
        failures,
        file,
        exists,
    }
}

// --------------------------------------------------------------- transcripts ---

/// Index every transcript on disk by its session id.
fn transcript_index(projects: &Path) -> HashMap<String, PathBuf> {
    let mut by_id = HashMap::new();
    for d in read_dir(projects).filter(is_dir) {
        for f in read_dir(&d.path()) {
            if let Some(id) = name(&f).strip_suffix(".jsonl") {
                by_id.insert(id.to_owned(), f.path());
            }
        }
    }
    by_id
}

struct Transcript {
    title: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    created_at: f64,
    last_activity_at: f64,
    bytes: u64,
}

/// Pull the details needed to rebuild an index entry, reading only the ends of the file.
fn describe_transcript(file: &Path) -> Option<Transcript> {
    let head = parse_jsonl(&read_part(file, 65536, false), false);
    let tail = parse_jsonl(&read_part(file, 262144, true), true);
    let stat = std::fs::metadata(file).ok()?;
    let both = || head.iter().chain(&tail);
    let text = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_owned);

    Some(Transcript {
        title: head
            .iter()
            .find(|r| r["type"] == "custom-title")
            .and_then(|r| text(&r["customTitle"])),
        cwd: both().find_map(|r| text(&r["cwd"])),
        model: tail.iter().rev().find_map(|r| text(&r["message"]["model"])),
        created_at: both()
            .find_map(|r| r["timestamp"].as_str().filter(|s| !s.is_empty()))
            .and_then(parse_iso)
            .unwrap_or_else(|| ms(stat.created())),
        last_activity_at: ms(stat.modified()),
        bytes: stat.len(),
    })
}

// ------------------------------------------------------------------ backups ---

/// The time as JavaScript's toISOString wrote it, with `:` and `.` swapped for
/// `-` so it can name a directory — the format every earlier backup used, which
/// keeps rotation sorting old and new together.
fn stamp() -> String {
    let t = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}-{:02}-{:02}-{:03}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
        t.millisecond()
    )
}

/// Snapshot the index before each launch. It is a few hundred KB of JSON, so the
/// copy is nearly free — and it is the exact thing that goes missing when the app
/// cannot write to its storage directory.
pub fn backup_index(account: &Account, backup_root: &Path) -> std::io::Result<()> {
    let entries = index_entries(&account.dir);
    if entries.is_empty() {
        return Ok(());
    }
    let parent = backup_root.join(&account.id);
    let dest = parent.join(stamp());
    for e in &entries {
        let sub = dest.join(&e.ns_account).join(&e.ns_org);
        std::fs::create_dir_all(&sub)?;
        std::fs::copy(&e.file, sub.join(e.file.file_name().unwrap_or_default()))?;
    }

    // Rotate.
    let mut kept: Vec<String> = read_dir(&parent).map(|e| name(&e)).collect();
    kept.sort();
    for old in &kept[..kept.len().saturating_sub(KEEP_BACKUPS)] {
        let _ = std::fs::remove_dir_all(parent.join(old));
    }
    Ok(())
}

#[derive(Serialize)]
pub struct Backups {
    pub count: usize,
    pub latest: Option<String>,
    pub dir: PathBuf,
}

fn backup_summary(account: &Account, backup_root: &Path) -> Backups {
    let dir = backup_root.join(&account.id);
    let mut stamps: Vec<String> = read_dir(&dir).map(|e| name(&e)).collect();
    stamps.sort();
    Backups {
        count: stamps.len(),
        latest: stamps.pop(),
        dir,
    }
}

// --------------------------------------------------------------------- scan ---

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Orphan {
    pub local_id: String,
    pub cli_session_id: String,
    #[serde(default)]
    pub transcript: PathBuf,
    pub title: String,
    #[serde(default)]
    pub has_custom_title: bool,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    pub created_at: f64,
    pub last_activity_at: f64,
    #[serde(default)]
    pub bytes: u64,
}

#[derive(Serialize)]
pub struct Failures {
    pub count: usize,
    pub last: String,
    pub reason: String,
    /// Historical unless the index is still unwritable.
    pub resolved: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountHealth {
    pub id: String,
    pub name: String,
    pub log_exists: bool,
    pub log_file: PathBuf,
    pub storage: Storage,
    pub failures: Option<Failures>,
    pub orphans: Vec<Orphan>,
    pub can_rebuild: bool,
    pub backups: Backups,
}

impl AccountHealth {
    pub fn failing(&self) -> bool {
        self.failures.as_ref().is_some_and(|f| !f.resolved)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub accounts: Vec<AccountHealth>,
    pub transcript_count: usize,
}

impl Scan {
    /// What is worth acting on: every orphan, and each failure still happening. A
    /// resolved failure is history.
    pub fn issue_count(&self) -> usize {
        self.accounts
            .iter()
            .map(|a| a.orphans.len() + usize::from(a.failing()))
            .sum()
    }
}

fn scan_account(
    account: &Account,
    transcripts: &HashMap<String, PathBuf>,
    places: &Places,
) -> (Log, Vec<Orphan>) {
    let log = read_log(&account.dir, places);
    let entries = index_entries(&account.dir);
    let known: HashSet<&str> = entries
        .iter()
        .filter_map(|e| e.cli_session_id.as_deref())
        .collect();
    // One desktop session spans several CLI transcripts as it compacts, all
    // sharing one internal id. If that id is already indexed the session is not
    // lost — the list shows it, pointing at its latest transcript.
    let known_local: HashSet<&str> = entries
        .iter()
        .filter_map(|e| e.session_id.as_deref())
        .collect();

    let mut orphans: Vec<Orphan> = log
        .mappings
        .iter()
        .filter(|(cli, local)| {
            !known.contains(cli.as_str()) && !known_local.contains(local.as_str())
        })
        // A mapping whose transcript is already gone has nothing to restore from.
        .filter_map(|(cli, local)| {
            let file = transcripts.get(cli)?;
            let d = describe_transcript(file)?;
            let fallback = d
                .cwd
                .as_deref()
                .and_then(|c| Path::new(c).file_name())
                .map(|n| n.to_string_lossy().into_owned());
            Some(Orphan {
                local_id: local.clone(),
                cli_session_id: cli.clone(),
                transcript: file.clone(),
                has_custom_title: d.title.is_some(),
                title: d
                    .title
                    .or(fallback)
                    .unwrap_or_else(|| "Untitled session".into()),
                cwd: d.cwd,
                model: d.model,
                created_at: d.created_at,
                last_activity_at: d.last_activity_at,
                bytes: d.bytes,
            })
        })
        .collect();
    orphans.sort_by(|a, b| b.last_activity_at.total_cmp(&a.last_activity_at));
    (log, orphans)
}

pub fn scan(accounts: &[Account], backup_root: &Path, places: &Places) -> Scan {
    let transcripts = transcript_index(&places.projects);
    let accounts = accounts
        .iter()
        .map(|a| {
            let (log, orphans) = scan_account(a, &transcripts, places);
            let storage = storage_health(&a.dir);
            let failures = log.failures.last().map(|last| Failures {
                count: log.failures.len(),
                last: last.at.clone(),
                reason: last.reason.clone(),
                resolved: storage.ok,
            });
            AccountHealth {
                id: a.id.clone(),
                name: a.name.clone(),
                log_exists: log.exists,
                log_file: log.file,
                storage,
                failures,
                orphans,
                can_rebuild: target_namespace(&a.dir).is_some(),
                backups: backup_summary(a, backup_root),
            }
        })
        .collect();
    Scan {
        accounts,
        transcript_count: transcripts.len(),
    }
}

// ------------------------------------------------------------------ rebuild ---

/// Recreate a missing index entry so the session reappears in Claude's list.
///
/// titleSource MUST be "user". The app clears any title whose source is not
/// "user" when it loads the entry — a rebuilt session would come back untitled.
pub fn rebuild(account: &Account, orphan: &Orphan) -> Result<PathBuf, String> {
    let ns = target_namespace(&account.dir).ok_or(
        "This profile has no session index yet. Open the account in Claude once, then try again.",
    )?;
    let dest = ns.dir.join(format!("{}.json", orphan.local_id));
    if dest.exists() {
        return Err("An entry for that session already exists.".into());
    }
    let home = dirs::home_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let cwd = orphan.cwd.clone().unwrap_or(home);
    let entry = serde_json::json!({
        "sessionId": orphan.local_id,
        "cliSessionId": orphan.cli_session_id,
        "cwd": cwd,
        "originCwd": cwd,
        "lastFocusedAt": orphan.last_activity_at.round() as i64,
        "createdAt": orphan.created_at.round() as i64,
        "lastActivityAt": orphan.last_activity_at.round() as i64,
        "model": orphan.model.as_deref().unwrap_or("claude-opus-5"),
        "effort": "high",
        "isArchived": false,
        "title": orphan.title,
        "titleSource": "user",
        "permissionMode": "auto",
        "remoteMcpServersConfig": [],
        "chromePermissionMode": "skip_all_permission_checks",
        "completedTurns": 0,
        "alwaysAllowedReasons": [],
        "sessionPermissionUpdates": [],
        "classifierSummaryEnabled": true,
        "spawnSeed": {}
    });
    std::fs::create_dir_all(&ns.dir).map_err(|e| e.to_string())?;
    std::fs::write(
        &dest,
        serde_json::to_string_pretty(&entry).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    //! A scan reads three separate places — the log, the session index and the
    //! transcripts — and only the combination says whether a session is lost. The
    //! fixture below is the smallest arrangement where that holds.

    use super::*;

    const CLI_ID: &str = "11111111-2222-3333-4444-555555555555";

    struct Fixture {
        root: PathBuf,
        places: Places,
    }

    impl Fixture {
        fn new() -> Self {
            let root = crate::platform::temp_dir("case-health-").unwrap();
            let places = Places {
                projects: root.join(".claude/projects"),
                default_profile: root.join("Support/Claude"),
                shared_log: root.join("Logs/Claude/main.log"),
            };
            // The shared log records one desktop session…
            std::fs::create_dir_all(places.shared_log.parent().unwrap()).unwrap();
            std::fs::write(&places.shared_log, format!("2026-08-12 10:00:00 [info] Mapping internal session local_abc to CLI session {CLI_ID}\n")).unwrap();
            // …the default profile has an index that does not mention it…
            std::fs::create_dir_all(places.default_profile.join("claude-code-sessions/acct/org"))
                .unwrap();
            // …and the transcript is still on disk, which is what makes it restorable.
            std::fs::create_dir_all(places.projects.join("proj")).unwrap();
            std::fs::write(
                places.projects.join(format!("proj/{CLI_ID}.jsonl")),
                "{\"type\":\"user\",\"cwd\":\"/tmp/work\",\"timestamp\":\"2026-08-12T10:00:00Z\"}\n\
                 {\"type\":\"assistant\",\"timestamp\":\"2026-08-12T10:05:00Z\"}\n",
            )
            .unwrap();
            // A second account, added but never opened: no log of its own, and no index.
            std::fs::create_dir_all(root.join("Support/Claude-Unopened")).unwrap();
            Self { root, places }
        }

        fn scan(&self) -> Scan {
            let account = |id: &str, name: &str, dir: PathBuf| Account {
                id: id.into(),
                ..crate::store::new_account(name, dir)
            };
            let accounts = [
                account("default", "Main", self.places.default_profile.clone()),
                account("new", "Unopened", self.root.join("Support/Claude-Unopened")),
            ];
            scan(&accounts, &self.root.join("backups"), &self.places)
        }

        fn find(&self, id: &str) -> AccountHealth {
            self.scan()
                .accounts
                .into_iter()
                .find(|a| a.id == id)
                .unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn a_session_in_the_log_but_not_in_the_index_is_an_orphan() {
        let main = Fixture::new().find("default");
        assert_eq!(main.orphans.len(), 1);
        assert_eq!(main.orphans[0].cli_session_id, CLI_ID);
        assert_eq!(main.orphans[0].local_id, "local_abc");
        assert_eq!(
            main.orphans[0].cwd.as_deref(),
            Some("/tmp/work"),
            "read back out of the transcript"
        );
        assert_eq!(
            main.orphans[0].title, "work",
            "named after its folder when it has no title"
        );
        assert_eq!(
            main.orphans[0].created_at, 1_786_528_800_000.0,
            "from the first timestamp, not the file"
        );
    }

    #[test]
    fn an_account_that_has_never_been_opened_inherits_nothing_from_the_shared_log() {
        // Regression: the shared log belongs to the *default* profile. Falling back
        // to it for any other profile reported every one of Main's sessions as that
        // account's — all of them missing from an index that did not exist yet.
        let fresh = Fixture::new().find("new");
        assert_eq!(fresh.orphans.len(), 0);
        assert!(
            !fresh.log_exists,
            "so the UI can say to open it once and rescan"
        );
    }

    #[test]
    fn a_session_already_in_the_index_is_not_reported_as_lost() {
        let f = Fixture::new();
        let entry = f
            .places
            .default_profile
            .join("claude-code-sessions/acct/org/local_abc.json");
        std::fs::write(
            entry,
            format!("{{\"sessionId\":\"local_abc\",\"cliSessionId\":\"{CLI_ID}\"}}"),
        )
        .unwrap();
        assert_eq!(f.find("default").orphans.len(), 0);
    }

    #[test]
    fn a_log_with_windows_line_endings_reads_the_same_as_any_other() {
        // Splitting on \n alone left a \r on the end of every line: it trailed into
        // the reason shown in the UI, and it sat between the reason and the `$` the
        // failure pattern anchors on, so no failure was ever recognised.
        let f = Fixture::new();
        std::fs::write(
            &f.places.shared_log,
            format!(
                "2026-08-12 10:00:00 [info] Mapping internal session local_abc to CLI session {CLI_ID}\r\n\
                 2026-08-12 10:01:00 [error] Failed to save session local_abc: ENOTDIR: not a directory\r\n"
            ),
        )
        .unwrap();
        let main = f.find("default");
        assert_eq!(main.orphans.len(), 1, "the mapping is still found");
        let failures = main
            .failures
            .expect("and so is the failure that follows it");
        assert_eq!(failures.count, 1);
        assert_eq!(
            failures.reason, "ENOTDIR: not a directory",
            "with no carriage return left on the end"
        );
        assert_eq!(failures.last, "2026-08-12 10:01:00");
    }

    #[test]
    fn a_mapping_whose_transcript_is_gone_is_not_offered_for_restore() {
        let f = Fixture::new();
        std::fs::remove_file(f.places.projects.join(format!("proj/{CLI_ID}.jsonl"))).unwrap();
        assert_eq!(
            f.find("default").orphans.len(),
            0,
            "there would be nothing to restore from"
        );
    }

    #[test]
    fn a_rebuilt_entry_lands_in_the_index_and_ends_the_orphan() {
        let f = Fixture::new();
        let orphan = f.find("default").orphans.remove(0);
        let account = crate::store::new_account("Main", f.places.default_profile.clone());
        let file = rebuild(&account, &orphan).unwrap();
        let entry: Value = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
        assert_eq!(
            entry["titleSource"], "user",
            "anything else is cleared when Claude loads it"
        );
        assert_eq!(entry["createdAt"], 1_786_528_800_000_i64);
        assert_eq!(f.find("default").orphans.len(), 0);
        assert!(
            rebuild(&account, &orphan).is_err(),
            "and a second rebuild does not overwrite it"
        );
    }

    #[test]
    fn backups_rotate_down_to_the_newest_ten() {
        let f = Fixture::new();
        let mut account = crate::store::new_account("Main", f.places.default_profile.clone());
        account.id = "default".into();
        std::fs::write(
            f.places
                .default_profile
                .join("claude-code-sessions/acct/org/local_x.json"),
            "{}",
        )
        .unwrap();
        let root = f.root.join("backups");
        for i in 0..12 {
            std::fs::create_dir_all(root.join(format!("default/2026-01-01T00-00-{i:02}-000Z")))
                .unwrap();
        }
        backup_index(&account, &root).unwrap();
        let summary = backup_summary(&account, &root);
        assert_eq!(summary.count, KEEP_BACKUPS);
        assert!(
            summary.latest.unwrap().as_str() > "2026-01-01",
            "the fresh one survives the rotation"
        );
    }

    #[test]
    fn partial_reads_drop_the_line_they_may_have_cut() {
        assert_eq!(parse_jsonl("{\"a\":1}\n{\"a\":2}\n{\"a\"", false).len(), 2);
        assert_eq!(parse_jsonl("{\"a\"\n{\"a\":2}\n{\"a\":3}", true).len(), 1);
        assert_eq!(
            parse_jsonl("{\"a\":1}", false).len(),
            1,
            "a single line is kept whole"
        );
        assert_eq!(stamp().len(), "2026-08-12T10-00-00-000Z".len());
    }
}
