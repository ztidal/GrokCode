//! Which sessions are pinned, and which are archived.
//!
//! Both sets started in the browser's localStorage, beside the titles, and
//! they leave it for the same reason the titles did: that store is a
//! write-behind cache, so a window that is killed rather than closed takes its
//! last batched writes with it, and two windows each hold the whole set and
//! overwrite each other wholesale — and a second window is a first-class
//! feature here, not a corner case. "Per-machine preference" was the argument
//! for leaving them there; it answers cross-machine sync, not same-machine
//! durability.
//!
//! One document holds both sets: they are flipped from the same card menu, and
//! one document means one lock and one merge call for a window folding its old
//! localStorage in. Every write goes through `fs_atomic` whole and re-reads
//! inside `multi_instance`'s lock first, because serializing an in-memory copy
//! is exactly how one window drops what another just flagged.
//!
//! A pin or an archive mark is a note **about** `grok`'s session, never a
//! write to it (ADR-0001). Trashing is the one sidebar action that touches the
//! session itself, and it lives in `session_trash`.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::session_trash::is_safe_id;
use crate::{fs_atomic, multi_instance};

/// Both sets, whole — what the file holds and what every command answers.
///
/// `BTreeSet`s so the file has one spelling for one pair of sets: sorted
/// arrays with no duplicates, which keeps every diff and every sync between
/// two machines free of rewrite noise. Each list defaults independently, so a
/// hand-edited file holding only one of them does not read as both empty.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SessionFlags {
    #[serde(default)]
    pub pinned: BTreeSet<String>,
    #[serde(default)]
    pub archived: BTreeSet<String>,
}

/// Which of the two sets a mutation addresses. `"pinned"` / `"archived"` on
/// the wire, the same words as the fields they select.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Flag {
    Pinned,
    Archived,
}

fn flags_path() -> PathBuf {
    crate::config::app_home().join("session_flags.json")
}

/// Missing or unreadable both mean "nothing flagged": a preference file is not
/// worth failing a window's startup over, and refusing to start because it is
/// corrupt would cost more than an empty pinned group does.
fn load_at(path: &Path) -> SessionFlags {
    let Ok(raw) = fs::read_to_string(path) else {
        return SessionFlags::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn load() -> SessionFlags {
    load_at(&flags_path())
}

/// Put `session_id` into one set (`value`) or drop it (`!value`). Returns the
/// whole store, so a caller repaints with everything every window has done,
/// not only its own edit.
pub fn set(session_id: &str, flag: Flag, value: bool) -> Result<SessionFlags, String> {
    set_at(&flags_path(), session_id, flag, value)
}

fn set_at(path: &Path, session_id: &str, flag: Flag, value: bool) -> Result<SessionFlags, String> {
    // The id is about to be stored and handed back to lookups; the same shape
    // check the trash applies keeps anything path-like out of the file.
    if !is_safe_id(session_id) {
        return Err(format!("{session_id:?} is not a session id"));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    // Lock, then re-read: the document is written whole, so anything a sibling
    // window flagged since this process last read would be dropped by an
    // in-memory copy.
    let _lock = multi_instance::lock_sidecar(path)?;
    let mut flags = load_at(path);
    let set = match flag {
        Flag::Pinned => &mut flags.pinned,
        Flag::Archived => &mut flags.archived,
    };
    if value {
        set.insert(session_id.to_string());
    } else {
        set.remove(session_id);
    }
    fs_atomic::write_json_atomic(path, &flags)?;
    Ok(flags)
}

/// Fold a window's pre-upgrade localStorage sets in, as a union.
///
/// A union rather than a replace is what makes the migration safe to race: two
/// windows folding the same profile in at once each add what they hold, and
/// neither can erase the other's half — running the same merge twice changes
/// nothing. The price is that a union only adds, so an id un-flagged elsewhere
/// during the once-ever migration window can come back; chosen over any shape
/// that can lose one.
pub fn merge(pinned: Vec<String>, archived: Vec<String>) -> Result<SessionFlags, String> {
    merge_at(&flags_path(), pinned, archived)
}

fn merge_at(
    path: &Path,
    pinned: Vec<String>,
    archived: Vec<String>,
) -> Result<SessionFlags, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let _lock = multi_instance::lock_sidecar(path)?;
    let mut flags = load_at(path);
    // Garbage ids are dropped, not refused: the source is localStorage, which
    // anyone can edit in devtools, and one bad entry refusing the whole call
    // would wedge the migration behind an error on every launch.
    flags
        .pinned
        .extend(pinned.into_iter().filter(|id| is_safe_id(id)));
    flags
        .archived
        .extend(archived.into_iter().filter(|id| is_safe_id(id)));
    fs_atomic::write_json_atomic(path, &flags)?;
    Ok(flags)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("ztidalcode-flags-{name}.json"));
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("json.lock"));
        path
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn nothing_flagged_is_not_an_error() {
        assert_eq!(load_at(&scratch("absent")), SessionFlags::default());
    }

    #[test]
    fn a_corrupt_file_reads_as_nothing_flagged() {
        let path = scratch("corrupt");
        fs::write(&path, "{not json").expect("write");
        // Better than refusing to start a window over one preference file.
        assert_eq!(load_at(&path), SessionFlags::default());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_file_holding_only_one_list_still_reads_whole() {
        let path = scratch("partial");
        fs::write(&path, r#"{"pinned":["a"]}"#).expect("write");
        let flags = load_at(&path);
        assert!(flags.pinned.contains("a"));
        assert!(flags.archived.is_empty(), "absent is empty, not corrupt");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_flag_survives_being_written_and_read_back() {
        let path = scratch("roundtrip");
        let flags = set_at(&path, "session-1", Flag::Pinned, true).expect("set");
        assert!(flags.pinned.contains("session-1"));
        assert_eq!(
            load_at(&path),
            flags,
            "and it is on disk, not only returned"
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn clearing_a_flag_removes_the_id_rather_than_leaving_a_tombstone() {
        let path = scratch("clear");
        set_at(&path, "session-1", Flag::Archived, true).expect("set");
        let flags = set_at(&path, "session-1", Flag::Archived, false).expect("clear");
        assert_eq!(flags, SessionFlags::default());
        // Clearing what was never set is a no-op, not an error.
        let flags = set_at(&path, "session-1", Flag::Archived, false).expect("re-clear");
        assert_eq!(flags, SessionFlags::default());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn pinning_and_archiving_do_not_disturb_each_other() {
        let path = scratch("independent");
        set_at(&path, "both", Flag::Pinned, true).expect("pin");
        set_at(&path, "both", Flag::Archived, true).expect("archive");
        let flags = set_at(&path, "both", Flag::Pinned, false).expect("unpin");
        assert!(!flags.pinned.contains("both"));
        assert!(
            flags.archived.contains("both"),
            "the other set keeps its entry"
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn the_file_spells_each_set_sorted() {
        let path = scratch("sorted");
        set_at(&path, "b", Flag::Pinned, true).expect("b");
        set_at(&path, "a", Flag::Pinned, true).expect("a");
        let raw = fs::read_to_string(&path).expect("read");
        let a = raw.find("\"a\"").expect("a is in the file");
        let b = raw.find("\"b\"").expect("b is in the file");
        assert!(a < b, "insertion order must not leak into the file: {raw}");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn an_id_that_could_escape_a_lookup_is_refused() {
        let path = scratch("refused");
        for bad in ["", "..", "../escape", "a/b", "has space"] {
            assert!(
                set_at(&path, bad, Flag::Pinned, true).is_err(),
                "{bad:?} should be refused"
            );
        }
        assert!(!path.exists(), "a refused id must not create the file");
    }

    #[test]
    fn a_write_re_reads_what_another_window_left_behind() {
        let path = scratch("sibling");
        set_at(&path, "a", Flag::Pinned, true).expect("ours");
        // Stand in for the other window: it wrote while we held nothing.
        let mut theirs = load_at(&path);
        theirs.archived.insert("b".into());
        fs_atomic::write_json_atomic(&path, &theirs).expect("their write");

        let flags = set_at(&path, "c", Flag::Pinned, true).expect("later write");
        assert!(
            flags.archived.contains("b"),
            "a write must not serialize a copy taken before the other window's"
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_merge_unions_with_what_is_already_there() {
        let path = scratch("union");
        set_at(&path, "kept", Flag::Pinned, true).expect("seed");
        let flags = merge_at(&path, ids(&["new-pin"]), ids(&["new-archive"])).expect("merge");
        assert!(flags.pinned.contains("kept"), "a merge must not replace");
        assert!(flags.pinned.contains("new-pin"));
        assert!(flags.archived.contains("new-archive"));
        // The same merge again changes nothing — which is what lets two
        // windows migrate the same localStorage without coordinating.
        let again = merge_at(&path, ids(&["new-pin"]), ids(&["new-archive"])).expect("again");
        assert_eq!(again, flags);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_merge_drops_garbage_rather_than_refusing_the_good_ids() {
        let path = scratch("garbage");
        let flags = merge_at(&path, ids(&["../escape", "good-id"]), ids(&["has space"]))
            .expect("localStorage junk must not wedge the migration");
        assert_eq!(flags.pinned, BTreeSet::from(["good-id".to_string()]));
        assert!(flags.archived.is_empty());
        let _ = fs::remove_file(&path);
    }
}
