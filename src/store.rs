//! accounts.json: the account list, the settings and the archive records, in one
//! plain-JSON file in CASE's own data directory. Safe to edit by hand.

use crate::platform;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChromePair {
    pub dir: String,
    #[serde(default = "yes")]
    pub open_on_launch: bool,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    pub dir: PathBuf,
    #[serde(
        default,
        deserialize_with = "lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub emoji: Option<String>,
    #[serde(
        default,
        deserialize_with = "lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub hue: Option<i64>,
    #[serde(
        default,
        deserialize_with = "lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub chrome: Option<ChromePair>,
    #[serde(
        default,
        deserialize_with = "lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_used_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Archived {
    pub id: String,
    pub name: String,
    #[serde(
        default,
        deserialize_with = "lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub emoji: Option<String>,
    #[serde(
        default,
        deserialize_with = "lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub hue: Option<i64>,
    #[serde(
        default,
        deserialize_with = "lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub chrome: Option<ChromePair>,
    pub dir: PathBuf,
    pub original_dir: PathBuf,
    #[serde(default)]
    pub archived_at: i64,
    #[serde(default, deserialize_with = "lenient")]
    pub bytes: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub hotkey: String,
    pub hotkey_enabled: bool,
    pub menu_bar: bool,
    pub hide_dock: bool,
    /// Off by default: reordering the list also reorders ⌘1–9, and with two
    /// accounts the order would flip on every switch.
    pub sort_by_recent: bool,
    /// Checks only — nothing is ever downloaded or installed without being asked.
    pub auto_update_check: bool,
    pub last_update_check: i64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: platform::DEFAULT_HOTKEY.into(),
            hotkey_enabled: true,
            menu_bar: true,
            hide_dock: false,
            sort_by_recent: false,
            auto_update_check: true,
            last_update_check: 0,
        }
    }
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Config {
    #[serde(default)]
    pub version: u32,
    /// None until the first-run setup has been finished or skipped. Writing a
    /// setting before then must not answer that question on the user's behalf.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accounts: Option<Vec<Account>>,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub archived: Vec<Archived>,
}

impl Config {
    pub fn accounts(&self) -> &[Account] {
        self.accounts.as_deref().unwrap_or_default()
    }

    pub fn accounts_mut(&mut self) -> &mut Vec<Account> {
        self.accounts.get_or_insert_default()
    }
}

/// An optional field that is the wrong shape reads as absent, rather than failing
/// the whole file: a hand-edited `"hue": "200"` should cost a colour, not the
/// account list.
fn lenient<'de, D: Deserializer<'de>, T: DeserializeOwned>(d: D) -> Result<Option<T>, D::Error> {
    Ok(serde_json::from_value(serde_json::Value::deserialize(d)?).ok())
}

// --------------------------------------------------------------------- io ---

/// CASE's own directory, named by product rather than bundle id so it is the same
/// one every earlier version used.
pub fn conf_dir() -> PathBuf {
    platform::app_data().join("CASE")
}

fn conf() -> PathBuf {
    conf_dir().join("accounts.json")
}

pub fn backup_root() -> PathBuf {
    conf_dir().join("session-index-backups")
}

// Every change is a read-modify-write of the whole file, and commands run on a
// thread pool, so two of them interleaving would drop one change.
static LOCK: Mutex<()> = Mutex::new(());

pub fn load() -> Config {
    load_from(&conf()).unwrap_or_default()
}

/// The config, or the error that kept it from being read. A file that is not
/// there is a first run, not an error; one that is there but will not parse is
/// set aside and also reads as a first run.
fn load_from(file: &Path) -> std::io::Result<Config> {
    let bytes = match std::fs::read(file) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Config::default()),
        Err(e) => return Err(e),
    };
    Ok(serde_json::from_slice(&bytes).unwrap_or_else(|_| {
        // Kept rather than overwritten: whatever is wrong with it, the first save
        // after this would otherwise replace someone's account list with nothing.
        let _ = std::fs::rename(file, file.with_extension("json.unreadable"));
        Config::default()
    }))
}

fn save_to(file: &Path, c: &Config) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_string_pretty(&Config {
            version: 2,
            ..c.clone()
        })?,
    )?;
    std::fs::rename(tmp, file)
}

/// Read, change and write back, with nobody else doing the same in between.
///
/// A file that exists but cannot be read right now — locked, unreadable, a disk
/// error — is left exactly as it is: the change is made to an empty config and
/// thrown away, rather than saved over a config it never saw.
pub fn edit<R>(f: impl FnOnce(&mut Config) -> R) -> R {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let file = conf();
    match load_from(&file) {
        Ok(mut c) => {
            let r = f(&mut c);
            let _ = save_to(&file, &c);
            r
        }
        Err(_) => f(&mut Config::default()),
    }
}

/// The account list, migrating anything older first. None means first run.
pub fn accounts() -> Option<Vec<Account>> {
    let c = load();
    if c.accounts.is_some() {
        return c.accounts;
    }
    let legacy = read_tsv(&conf_dir().join("accounts.tsv"))?;
    edit(|c| c.accounts = Some(legacy.clone()));
    Some(legacy)
}

pub fn settings() -> Settings {
    load().settings
}

/// The v1 tab-separated file, preserving the names already chosen.
fn read_tsv(file: &Path) -> Option<Vec<Account>> {
    let accounts: Vec<Account> = std::fs::read_to_string(file)
        .ok()?
        .lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| {
            let (name, dir) = l.split_once('\t')?;
            let dir = dir.split('\t').next()?.trim();
            (!name.trim().is_empty()).then(|| new_account(name.trim(), dir.into()))
        })
        .collect();
    (!accounts.is_empty()).then_some(accounts)
}

pub fn new_account(name: &str, dir: PathBuf) -> Account {
    Account {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        dir,
        emoji: None,
        hue: None,
        chrome: None,
        last_used_at: None,
    }
}

/// Carry a pre-rename install across before anything reads it. What moves is the
/// three things this app keeps there — never over something already present, so
/// a half-finished migration cannot overwrite a working config on the next run.
pub fn migrate_legacy() {
    if conf().exists() {
        return;
    }
    let legacy = platform::app_data().join("Claude Accounts");
    let _ = std::fs::create_dir_all(conf_dir());
    for name in ["accounts.json", "accounts.tsv", "session-index-backups"] {
        let (from, to) = (legacy.join(name), conf_dir().join(name));
        if from.exists() && !to.exists() {
            let _ = std::fs::rename(from, to);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        platform::temp_dir("case-store-").unwrap()
    }

    #[test]
    fn a_config_written_by_the_electron_build_reads_back_whole() {
        let dir = scratch();
        let file = dir.join("accounts.json");
        std::fs::write(
            &file,
            r#"{ "version": 2,
                 "accounts": [{ "id": "a", "name": "Work", "dir": "/p/Claude-Work", "emoji": "💼", "hue": 202,
                                "chrome": { "dir": "Profile 2", "openOnLaunch": false }, "lastUsedAt": 1760000000000 }],
                 "settings": { "hotkey": "Alt+Command+K", "sortByRecent": true },
                 "archived": [{ "id": "b", "name": "Old", "dir": "/p/Claude-Old.archived", "originalDir": "/p/Claude-Old",
                                "archivedAt": 1, "bytes": null }] }"#,
        )
        .unwrap();
        let c = load_from(&file).unwrap();
        let a = &c.accounts()[0];
        assert_eq!(
            (a.name.as_str(), a.hue, a.last_used_at),
            ("Work", Some(202), Some(1760000000000))
        );
        assert!(!a.chrome.as_ref().unwrap().open_on_launch);
        assert_eq!(c.settings.hotkey, "Alt+Command+K");
        assert!(
            c.settings.sort_by_recent && c.settings.menu_bar,
            "an unset setting takes its default"
        );
        assert_eq!(c.archived[0].bytes, None);
    }

    #[test]
    fn a_field_of_the_wrong_shape_costs_that_field_not_the_list() {
        let dir = scratch();
        let file = dir.join("accounts.json");
        std::fs::write(
            &file,
            r#"{ "accounts": [{ "id": "a", "name": "W", "dir": "/p", "hue": "red" }] }"#,
        )
        .unwrap();
        let c = load_from(&file).unwrap();
        assert_eq!(c.accounts().len(), 1);
        assert_eq!(c.accounts()[0].hue, None);
    }

    #[test]
    fn an_unreadable_file_is_set_aside_rather_than_overwritten() {
        let dir = scratch();
        let file = dir.join("accounts.json");
        std::fs::write(&file, "{ not json").unwrap();
        assert!(load_from(&file).unwrap().accounts.is_none());
        assert_eq!(
            std::fs::read_to_string(dir.join("accounts.json.unreadable")).unwrap(),
            "{ not json"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_config_that_cannot_be_read_is_not_mistaken_for_a_first_run() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch();
        let file = dir.join("accounts.json");
        std::fs::write(&file, r#"{ "accounts": [] }"#).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        let read = load_from(&file);
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            read.is_err(),
            "so edit() leaves it alone instead of saving defaults over it"
        );
        assert!(file.exists());
    }

    #[test]
    fn saving_settings_before_setup_leaves_setup_to_be_done() {
        let dir = scratch();
        let file = dir.join("accounts.json");
        save_to(&file, &Config::default()).unwrap();
        assert!(load_from(&file).unwrap().accounts.is_none());
    }

    #[test]
    fn the_v1_tsv_is_migrated_with_its_names() {
        let dir = scratch();
        let file = dir.join("accounts.tsv");
        std::fs::write(
            &file,
            "# name\tdir\nWork\t/p/Claude-Work\n\t/p/nameless\nHome\t/p/Claude-Home\textra\n",
        )
        .unwrap();
        let got: Vec<_> = read_tsv(&file)
            .unwrap()
            .into_iter()
            .map(|a| (a.name, a.dir))
            .collect();
        assert_eq!(
            got,
            [
                ("Work".into(), "/p/Claude-Work".into()),
                ("Home".into(), "/p/Claude-Home".into())
            ]
        );
    }
}
