//! The names people give their sessions.
//!
//! These started out in the browser's localStorage, next to the pins and the
//! collapse state, and that was wrong. A pin is a preference — cheap to lose and
//! cheaper to redo. A name is something someone typed, and the browser store is
//! a cache: it batches to disk, so a window that is killed rather than closed
//! takes the last few writes with it, and two windows each hold their own copy
//! of the whole map and overwrite each other's.
//!
//! So a name lives where `task_prefs` lives, and for the same reasons: written
//! whole through `fs_atomic`, and re-read inside `multi_instance`'s lock before
//! every write, because serializing an in-memory copy is exactly how one window
//! drops what another just renamed.
//!
//! The title is a **label over** `grok`'s own, never a write to it (ADR-0001).
//! Clearing it brings the agent's title back, which is why the absence of an
//! entry has to mean something and an empty string is never stored.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::{fs_atomic, multi_instance};

/// session id → the name to show instead of the agent's.
///
/// A `BTreeMap` so the file has one spelling for one set of names: an unordered
/// map would rewrite the whole document on any rehash, which makes every diff
/// and every sync between two machines noise.
pub type Titles = BTreeMap<String, String>;

fn titles_path() -> PathBuf {
    crate::config::app_home().join("session_titles.json")
}

/// Missing or unreadable both mean "nobody has renamed anything": a name is not
/// worth failing a window's startup over, and refusing to start because one
/// preference file is corrupt would be worse than showing the agent's titles.
fn load_at(path: &Path) -> Titles {
    let Ok(raw) = fs::read_to_string(path) else {
        return Titles::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn load() -> Titles {
    load_at(&titles_path())
}

/// Store, replace, or (with `None`) drop one name. Returns the whole map, so a
/// caller repaints with everything every window has done, not only its own edit.
pub fn set(session_id: &str, title: Option<String>) -> Result<Titles, String> {
    set_at(&titles_path(), session_id, title)
}

fn set_at(path: &Path, session_id: &str, title: Option<String>) -> Result<Titles, String> {
    if session_id.is_empty() {
        return Err("a session id is required".into());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    // Lock, then re-read: the map is written whole, so anything a sibling window
    // renamed since this process last read would be dropped by an in-memory copy.
    let _lock = multi_instance::lock_sidecar(path)?;
    let mut titles = load_at(path);
    match title.map(|t| t.trim().to_string()) {
        Some(name) if !name.is_empty() => {
            titles.insert(session_id.to_string(), name);
        }
        // Blank is how the field says "give me the agent's title back".
        _ => {
            titles.remove(session_id);
        }
    }
    fs_atomic::write_json_atomic(path, &titles)?;
    Ok(titles)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("ztidalcode-titles-{name}.json"));
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("json.lock"));
        path
    }

    #[test]
    fn nothing_renamed_is_not_an_error() {
        assert!(load_at(&scratch("absent")).is_empty());
    }

    #[test]
    fn a_corrupt_file_reads_as_nothing_renamed() {
        let path = scratch("corrupt");
        fs::write(&path, "{not json").expect("write");
        // Better than refusing to start a window over one preference file.
        assert!(load_at(&path).is_empty());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_name_survives_being_written_and_read_back() {
        let path = scratch("roundtrip");
        let map = set_at(&path, "session-1", Some("  My name  ".into())).expect("set");
        assert_eq!(map.get("session-1").map(String::as_str), Some("My name"));
        assert_eq!(load_at(&path), map, "and it is on disk, not only returned");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn clearing_a_name_removes_it_rather_than_storing_an_empty_one() {
        let path = scratch("clear");
        set_at(&path, "session-1", Some("My name".into())).expect("set");
        for blank in [None, Some(String::new()), Some("   ".into())] {
            set_at(&path, "session-1", Some("My name".into())).expect("re-set");
            let map = set_at(&path, "session-1", blank).expect("clear");
            assert!(
                map.is_empty(),
                "an absent entry is what restores grok's title"
            );
        }
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn renaming_one_session_leaves_the_others_alone() {
        let path = scratch("others");
        set_at(&path, "a", Some("First".into())).expect("a");
        set_at(&path, "b", Some("Second".into())).expect("b");
        let map = set_at(&path, "a", Some("Changed".into())).expect("a again");
        assert_eq!(map.get("a").map(String::as_str), Some("Changed"));
        assert_eq!(map.get("b").map(String::as_str), Some("Second"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_write_re_reads_what_another_window_left_behind() {
        let path = scratch("sibling");
        set_at(&path, "a", Some("Mine".into())).expect("ours");
        // Stand in for the other window: it wrote while we held nothing.
        let mut theirs = load_at(&path);
        theirs.insert("b".into(), "Theirs".into());
        fs_atomic::write_json_atomic(&path, &theirs).expect("their write");

        let map = set_at(&path, "c", Some("Later".into())).expect("later write");
        assert_eq!(
            map.get("b").map(String::as_str),
            Some("Theirs"),
            "a write must not serialize a copy taken before the other window's"
        );
        let _ = fs::remove_file(&path);
    }
}
