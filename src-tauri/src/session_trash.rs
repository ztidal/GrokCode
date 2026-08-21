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
fn locate(root: &Path, session_id: &str) -> Result<(PathBuf, String), String> {
    if !root.is_dir() {
        return Err(format!("No session store at {}", root.display()));
    }
    let entries = fs::read_dir(root).map_err(|e| format!("Cannot read {}: {e}", root.display()))?;
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
    trash_session_in(&sessions_root(), session_id)
}

/// [`trash_session`] against a given store, so a test can build one rather than
/// redirect `GROK_HOME` — a process-global that the rest of this suite reads.
fn trash_session_in(root: &Path, session_id: &str) -> Result<PathBuf, String> {
    if !is_safe_id(session_id) {
        return Err(format!("{session_id:?} is not a session id"));
    }
    let (from, group) = locate(root, session_id)?;
    let parent = root.join(".trash").join(&group);
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

    fn store(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("ztidalcode-store-{name}"));
        let _ = fs::remove_dir_all(&root);
        root
    }

    #[test]
    fn moving_a_session_takes_it_out_of_every_walk() {
        let root = store("move");
        let group = "D%3A%5Cproj";
        let id = "01a01d2e-dfda-7460-9343-518ad1acf115";
        let from = root.join(group).join(id);
        fs::create_dir_all(&from).expect("session dir");
        fs::write(from.join("summary.json"), "{}").expect("summary");

        let to = trash_session_in(&root, id).expect("trash");

        assert!(!from.exists(), "the session left its project");
        assert!(to.join("summary.json").is_file(), "and arrived whole");
        assert_eq!(to, root.join(".trash").join(group).join(id));

        // The property every walk in sessions.rs relies on: a trashed session is
        // behind a component starting with a dot, and they all skip those.
        let relative = to.strip_prefix(&root).expect("under the store");
        assert!(
            relative
                .components()
                .any(|c| c.as_os_str().to_string_lossy().starts_with('.')),
            "{relative:?} must sit behind a dot-directory"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_session_that_is_not_there_is_an_error_not_a_move() {
        let root = store("missing");
        fs::create_dir_all(root.join("D%3A%5Cproj")).expect("group");
        let err = trash_session_in(&root, "01a01d2e-dfda-7460-9343-518ad1acf115")
            .expect_err("nothing to move");
        assert!(err.contains("not on disk"), "{err}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_to_trash_something_already_in_the_trash() {
        let root = store("recursive");
        let id = "01a01d2e-dfda-7460-9343-518ad1acf115";
        fs::create_dir_all(root.join(".trash").join("g").join(id)).expect("trashed");
        // Walking into `.trash` would find it and move it onto itself.
        assert!(trash_session_in(&root, id).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
