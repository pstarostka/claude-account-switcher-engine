//! Pairing a Claude account with a Chrome profile.
//!
//! Chrome keeps its profile list in Local State under profile.info_cache, keyed
//! by directory name ("Default", "Profile 8") with the display name and signed-in
//! address alongside. That file, and the "Profile N" naming, are the same on
//! every platform — only where Chrome keeps them differs, and where it is
//! launched from, both of which come from the platform module.
//!
//! Extensions are per-profile, so the Claude extension being present in one
//! profile says nothing about another.

use crate::platform::chrome as host;
use serde::Serialize;
use serde_json::Value;

// Claude in Chrome.
const EXTENSION_ID: &str = "fcoeoabgfenejglbffodgkkbkcdhcgfn";

pub use host::{installed, launch};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub dir: String,
    pub name: String,
    pub user_name: Option<String>,
    pub has_extension: bool,
    pub last_used: bool,
}

/// Every Chrome profile, newest-used first.
pub fn list_profiles() -> Vec<Profile> {
    if !installed() {
        return Vec::new();
    }
    let root = host::root();
    let Some(state) = std::fs::read(root.join("Local State"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    else {
        return Vec::new();
    };
    let last_used = state["profile"]["last_used"].as_str();
    let mut out: Vec<Profile> = state["profile"]["info_cache"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(dir, _)| root.join(dir).exists())
        .map(|(dir, info)| Profile {
            dir: dir.clone(),
            name: info["name"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(dir)
                .to_owned(),
            user_name: info["user_name"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            has_extension: root
                .join(dir)
                .join("Extensions")
                .join(EXTENSION_ID)
                .exists(),
            last_used: Some(dir.as_str()) == last_used,
        })
        .collect();
    out.sort_by(|a, b| {
        b.last_used
            .cmp(&a.last_used)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

/// The next unused "Profile N" directory, for creating a fresh profile.
pub fn next_profile_dir() -> String {
    let root = host::root();
    (1..500)
        .map(|i| format!("Profile {i}"))
        .find(|d| !root.join(d).exists())
        .unwrap_or_else(|| format!("Profile {}", crate::now_ms()))
}

/// Suggest a Chrome profile for a Claude account by name or address. Both of
/// these are things a person named their profiles, so an exact-ish match is a
/// strong signal — but it is only ever a default, never applied automatically.
pub fn suggest_for<'a>(account_name: &str, profiles: &'a [Profile]) -> Option<&'a Profile> {
    let want = account_name.trim().to_lowercase();
    if want.is_empty() {
        return None;
    }
    let name = |p: &Profile| p.name.to_lowercase();
    profiles
        .iter()
        .find(|p| name(p) == want)
        .or_else(|| {
            profiles.iter().find(|p| {
                p.user_name
                    .as_deref()
                    .unwrap_or("")
                    .to_lowercase()
                    .split('@')
                    .next()
                    == Some(&want)
            })
        })
        .or_else(|| {
            profiles
                .iter()
                .find(|p| name(p).contains(&want) || want.contains(&name(p)))
        })
}

/// Open the extension's Web Store page in the given profile so it is one click away.
pub fn open_extension_page(profile_dir: &str) {
    launch(
        profile_dir,
        Some(&format!(
            "https://chromewebstore.google.com/detail/{EXTENSION_ID}"
        )),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(name: &str, user: Option<&str>) -> Profile {
        Profile {
            dir: name.into(),
            name: name.into(),
            user_name: user.map(Into::into),
            has_extension: false,
            last_used: false,
        }
    }

    #[test]
    fn a_suggestion_prefers_the_name_then_the_address_then_a_partial_match() {
        let profiles = [
            p("Personal", Some("work@example.com")),
            p("Work stuff", None),
            p("work", None),
        ];
        assert_eq!(suggest_for("Work", &profiles).unwrap().name, "work");
        assert_eq!(
            suggest_for("work", &profiles[..2]).unwrap().name,
            "Personal",
            "by the address before @"
        );
        assert_eq!(suggest_for("stuff", &profiles).unwrap().name, "Work stuff");
        assert!(suggest_for("  ", &profiles).is_none());
    }
}
