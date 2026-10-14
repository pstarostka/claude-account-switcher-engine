//! Plan usage, read from Claude's own bookkeeping.
//!
//! Every profile carries `plan-usage-history.json`: `{version, samples}`, where
//! each sample is `{t, org, u:{fh, sd}}` — a timestamp, an org UUID, and two
//! integers from 0 to 100.
//!
//! The key names are suggestive but were not taken on trust. Across 25 days and
//! 3283 samples of one profile, runs of non-zero `fh` cap at 4.83–5.14 hours and
//! then drop to zero within a single 5-minute sampling interval — a fixed
//! five-hour window that resets, not a rolling one. Runs of non-zero `sd` last
//! 4.9–6.9 days. So `fh` is percent of the five-hour limit and `sd` percent of
//! the weekly one.
//!
//! Read-only, and the file is Claude's to write. We never touch it.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

pub const FIVE_HOURS: i64 = 5 * 60 * 60 * 1000;
pub const ONE_WEEK: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Clone, Copy)]
struct Sample {
    at: i64,
    fh: u8,
    sd: u8,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Usage {
    pub at: i64,
    pub age: i64,
    pub fh: u8,
    pub sd: u8,
}

// The file is ~280 KB and is rewritten every five minutes, but the status poll
// runs every 2.5 seconds. Keyed on mtime and size so the parse happens at
// Claude's rate.
type Cached = (Option<SystemTime>, u64, Option<Sample>);
static CACHE: Mutex<Option<HashMap<PathBuf, Cached>>> = Mutex::new(None);

fn pct(v: &Value) -> u8 {
    v.as_f64()
        .filter(|n| *n >= 0.0)
        .map_or(0, |n| n.round().min(100.0) as u8)
}

/// The most recent sample in the file, whichever org it belongs to.
fn newest(file: &Path) -> Option<Sample> {
    let raw: Value = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    let mut last: Option<(f64, &Value)> = None;
    for s in raw["samples"].as_array()? {
        if let Some(t) = s["t"].as_f64()
            && last.is_none_or(|(lt, _)| t > lt)
        {
            last = Some((t, s));
        }
    }
    last.map(|(t, s)| Sample {
        at: t as i64,
        fh: pct(&s["u"]["fh"]),
        sd: pct(&s["u"]["sd"]),
    })
}

/// A sample describes the moment it was taken, so it is only ever a statement
/// about the past. Once a whole window has passed since then, that window has
/// certainly reset and the figure is known to be zero; before that, all we can
/// honestly say is "this was the reading as of `at`".
fn as_of_now(s: Sample) -> Usage {
    let age = crate::now_ms() - s.at;
    Usage {
        at: s.at,
        age,
        fh: if age >= FIVE_HOURS { 0 } else { s.fh },
        sd: if age >= ONE_WEEK { 0 } else { s.sd },
    }
}

/// Latest usage for a profile, or None if Claude has never recorded any.
pub fn read(dir: &Path) -> Option<Usage> {
    let file = dir.join("plan-usage-history.json");
    let st = std::fs::metadata(&file).ok()?;
    let key = (st.modified().ok(), st.len());

    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let cache = cache.get_or_insert_default();
    if let Some((m, n, v)) = cache.get(dir)
        && (*m, *n) == key
    {
        return v.map(as_of_now);
    }
    let value = newest(&file);
    cache.insert(dir.to_path_buf(), (key.0, key.1, value));
    value.map(as_of_now)
}

#[cfg(test)]
mod tests {
    //! The non-obvious part is not reading the file, it is what a sample still
    //! means some time after it was taken.

    use super::*;
    use crate::now_ms;

    /// A throwaway profile directory holding the given samples.
    fn profile(samples: Value) -> PathBuf {
        let dir = crate::platform::temp_dir("case-usage-").unwrap();
        std::fs::write(
            dir.join("plan-usage-history.json"),
            serde_json::json!({ "version": 1, "samples": samples }).to_string(),
        )
        .unwrap();
        dir
    }

    #[test]
    fn a_fresh_sample_is_reported_as_it_was_recorded() {
        let u = read(&profile(
            serde_json::json!([{ "t": now_ms() - 60_000, "org": "o", "u": { "fh": 42, "sd": 7 } }]),
        ))
        .unwrap();
        assert_eq!((u.fh, u.sd), (42, 7));
    }

    #[test]
    fn the_five_hour_figure_is_known_to_be_zero_once_that_window_has_passed() {
        let u = read(&profile(
            serde_json::json!([{ "t": now_ms() - FIVE_HOURS - 1000, "u": { "fh": 90, "sd": 30 } }]),
        ))
        .unwrap();
        assert_eq!(u.fh, 0, "that window has certainly reset since the sample");
        assert_eq!(u.sd, 30, "but the weekly one has not, so it still stands");
    }

    #[test]
    fn the_weekly_figure_follows_once_a_week_has_passed() {
        let u = read(&profile(
            serde_json::json!([{ "t": now_ms() - ONE_WEEK - 1000, "u": { "fh": 90, "sd": 30 } }]),
        ))
        .unwrap();
        assert_eq!((u.fh, u.sd), (0, 0));
    }

    #[test]
    fn the_newest_sample_wins_wherever_it_sits_in_the_file() {
        let now = now_ms();
        let u = read(&profile(serde_json::json!([
            { "t": now - 600_000, "u": { "fh": 10, "sd": 1 } },
            { "t": now - 60_000, "u": { "fh": 55, "sd": 5 } },
            { "t": now - 300_000, "u": { "fh": 30, "sd": 3 } }
        ])))
        .unwrap();
        assert_eq!(u.fh, 55);
    }

    #[test]
    fn readings_outside_0_to_100_are_clamped_rather_than_shown() {
        let u = read(&profile(
            serde_json::json!([{ "t": now_ms(), "u": { "fh": 140, "sd": -5 } }]),
        ))
        .unwrap();
        assert_eq!((u.fh, u.sd), (100, 0));
    }

    #[test]
    fn a_profile_claude_has_never_recorded_usage_for_reads_as_nothing() {
        assert_eq!(
            read(&crate::platform::temp_dir("case-usage-").unwrap()),
            None
        );
    }

    #[test]
    fn a_corrupt_history_file_is_not_fatal() {
        let dir = crate::platform::temp_dir("case-usage-").unwrap();
        std::fs::write(dir.join("plan-usage-history.json"), "{ not json").unwrap();
        assert_eq!(read(&dir), None);
    }
}
