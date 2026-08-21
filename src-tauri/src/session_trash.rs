//! Move a session out of the way, reversibly.
//!
//! Deleting is the one action in the sidebar that touches `grok`'s own data
//! rather than our view of it (ADR-0001), and there is no undo stack to put it
//! on. So it is not a delete: the session directory is moved to
//! `<sessions>/.trash/<group>/<id>/`, which takes it out of the sidebar and out
//! of `grok`'s reach while leaving every byte on disk. Restoring is moving the
//! directory back, with no tool required.
//!
//! `.trash` is not a name this module has to defend: `sessions.rs` already skips
//! any group whose name starts with a dot when it walks the tree, so a trashed
//! session disappears from the sidebar without the walker learning anything
//! about this module.
//!
//! The lookup here is deliberately its own, rather than `pub`-ing the one in
//! `sessions.rs`: that file is upstream's, and a one-word change to it is still
//! a change that has to survive every merge.

use std::fs;
use std::path::{Path, PathBuf};

use crate::sessions::sessions_root;

/// Where trashed sessions go.
pub fn trash_root() -> PathBuf {
    sessions_root().join(".trash")
}

/// A session id that cannot escape the directory it is looked up in.
///
/// Shared with `multi_instance`, which pastes an id into a child process's
/// command line: same value, same reasons, so it gets checked the same way.
///
/// The id arrives from the frontend and is about to be pasted into a path that
/// something then moves. `..` or a separator in it would move whatever the
/// resulting path happened to land on, so ids are checked rather than trusted:
/// `grok`'s are UUIDs, and nothing that is not one has any business here.
pub(crate) fn is_safe_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 128
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The session's directory and the group directory holding it.
fn locate(session_id: &str) -> Result<(PathBuf, String), String> {
    let root = sessions_root();
    if !root.is_dir() {
        return Err(format!("No session store at {}", root.display()));
    }
    let entries =
        fs::read_dir(&root).map_err(|e| format!("Cannot read {}: {e}", root.display()))?;
    for group in entries.flatten() {
        if !group.path().is_dir() {
            continue;
        }
        let group_name = group.file_name().to_string_lossy().to_string();
        // Same skip the walker uses; without it a session could be "trashed"
        // from inside the trash, which is a move onto itself.
        if group_name.starts_with('.') {
            continue;
        }
        let candidate = group.path().join(session_id);
        if candidate.is_dir() {
            return Ok((candidate, group_name));
        }
    }
    Err(format!("Session {session_id} is not on disk"))
}

/// First free name under `parent` for `id`, so a second trashing of the same id
/// cannot land on the first one and destroy it.
fn free_destination(parent: &Path, id: &str) -> PathBuf {
    let first = parent.join(id);
    if !first.exists() {
        return first;
    }
    for n in 2..1000 {
        let candidate = parent.join(format!("{id}-{n}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{id}-full"))
}

/// Move one session into the trash. Returns where it landed, so the caller can
/// tell the user what to move back.
pub fn trash_session(session_id: &str) -> Result<PathBuf, String> {
    if !is_safe_id(session_id) {
        return Err(format!("{session_id:?} is not a session id"));
    }
    let (from, group) = locate(session_id)?;
    let parent = trash_root().join(&group);
    fs::create_dir_all(&parent).map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    let to = free_destination(&parent, session_id);
    // Both paths sit under the same store, so this is a rename, not a copy —
    // which is what makes it atomic and instant even for a long session.
    fs::rename(&from, &to)
        .map_err(|e| format!("Cannot move {} to {}: {e}", from.display(), to.display()))?;
    Ok(to)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_ids_grok_writes() {
        assert!(is_safe_id("01a01d2e-dfda-7460-9343-518ad1acf115"));
        assert!(is_safe_id("simple_id-1"));
    }

    #[test]
    fn refuses_anything_that_could_leave_its_directory() {
        for bad in [
            "",
            "..",
            "../escape",
            "..\\escape",
            "a/b",
            "a\\b",
            "a:b",
            "with space",
            ".hidden",
        ] {
            assert!(!is_safe_id(bad), "{bad:?} should be refused");
        }
    }

    #[test]
    fn refuses_an_id_long_enough_to_be_an_attack_on_the_path_limit() {
        assert!(!is_safe_id(&"a".repeat(129)));
    }

    #[test]
    fn trash_sits_inside_the_store_where_the_walker_skips_it() {
        let root = trash_root();
        assert_eq!(root.parent(), Some(sessions_root().as_path()));
        assert_eq!(
            root.file_name().and_then(|n| n.to_str()),
            Some(".trash"),
            "the leading dot is what keeps the walker out"
        );
    }

    #[test]
    fn a_second_trashing_does_not_land_on_the_first() {
        let base = std::env::temp_dir().join("ztidalcode-trash-test");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("temp dir");

        let id = "01a01d2e-dfda-7460-9343-518ad1acf115";
        assert_eq!(free_destination(&base, id), base.join(id));

        fs::create_dir_all(base.join(id)).expect("first");
        assert_eq!(free_destination(&base, id), base.join(format!("{id}-2")));

        fs::create_dir_all(base.join(format!("{id}-2"))).expect("second");
        assert_eq!(free_destination(&base, id), base.join(format!("{id}-3")));

        let _ = fs::remove_dir_all(&base);
    }
}
