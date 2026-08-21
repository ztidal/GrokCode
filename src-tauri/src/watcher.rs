//! Debounced filesystem watcher for Grok session on-disk state.
//!
//! Emits Tauri event `sessions-changed` when `~/.grok/sessions/**` or
//! `~/.grok/active_sessions.json` change. Live agent traffic still comes from ACP.

use crate::sessions;
use notify::event::{EventKind, ModifyKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// Debounce FS storms; keep short enough that Live can mirror Grok Build promptly.
const DEBOUNCE: Duration = Duration::from_millis(450);
const EVENT_NAME: &str = "sessions-changed";

/// Start a background thread that watches Grok home for session index changes.
pub fn start(app: AppHandle) {
    thread::Builder::new()
        .name("sessions-watcher".into())
        .spawn(move || run_loop(app))
        .expect("spawn sessions-watcher");
}

fn run_loop(app: AppHandle) {
    let home = sessions::grok_home();
    let sessions_dir = sessions::sessions_root();
    let _ = std::fs::create_dir_all(&sessions_dir);

    let (tx, rx) = mpsc::channel();
    let mut watcher: RecommendedWatcher = match notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    }) {
        Ok(w) => w,
        Err(e) => {
            tracing::error!(error = %e, "sessions watcher unavailable");
            return;
        }
    };

    if let Err(e) = watcher.watch(&sessions_dir, RecursiveMode::Recursive) {
        tracing::error!(
            path = %sessions_dir.display(),
            error = %e,
            "watch sessions dir failed"
        );
    }
    // Non-recursive on ~/.grok so active_sessions.json creates/writes are seen
    // without re-walking the whole sessions tree twice.
    if let Err(e) = watcher.watch(&home, RecursiveMode::NonRecursive) {
        tracing::error!(
            path = %home.display(),
            error = %e,
            "watch grok home failed"
        );
    }

    let mut pending: HashMap<(String, Option<String>), (Instant, String)> = HashMap::new();

    loop {
        let wait = if pending.is_empty() {
            Duration::from_secs(3600)
        } else {
            Duration::from_millis(80)
        };

        match rx.recv_timeout(wait) {
            Ok(Ok(event)) => {
                if !is_interesting(&event) {
                    continue;
                }
                for path in event.paths {
                    if let Some((category, session_id)) = classify_path(&path, &home, &sessions_dir)
                    {
                        pending.insert(
                            (category.to_string(), session_id),
                            (Instant::now(), path.display().to_string()),
                        );
                    }
                }
            }
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "sessions watch error");
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let ready: Vec<_> = pending
                    .iter()
                    .filter(|(_, (at, _))| at.elapsed() >= DEBOUNCE)
                    .map(|(key, (_, path))| (key.clone(), path.clone()))
                    .collect();
                for ((category, session_id), path) in ready {
                    pending.remove(&(category.clone(), session_id.clone()));
                    let _ = app.emit(
                        EVENT_NAME,
                        json!({
                            "reason": "fs",
                            "category": category,
                            "sessionId": session_id,
                            "path": path,
                            "ts": now_ms(),
                        }),
                    );
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    // Keep watcher alive for the thread lifetime (drop would stop watching).
    drop(watcher);
}

fn is_interesting(event: &notify::Event) -> bool {
    match event.kind {
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Any => true,
        EventKind::Modify(kind) => !matches!(
            kind,
            ModifyKind::Metadata(_) // chmod/atime — ignore
        ),
        EventKind::Access(_) | EventKind::Other => false,
    }
}

fn classify_path(
    path: &Path,
    home: &Path,
    sessions_root: &Path,
) -> Option<(&'static str, Option<String>)> {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    // Editor / OS temporaries (macOS + Windows)
    if name.ends_with('~')
        || name.ends_with(".tmp")
        || name.ends_with(".swp")
        || name.ends_with(".lock")
        || name.starts_with('.')
        || name == ".ds_store"
        || name == "thumbs.db"
        || name == "desktop.ini"
    {
        return None;
    }
    if path.parent() == Some(home) && name == "active_sessions.json" {
        return Some(("index", None));
    }
    if !path.starts_with(sessions_root) {
        return None;
    }
    // Anything behind a dot-directory belongs to a tool, not to a session: the
    // trash `session_trash` writes lives at `<sessions>/.trash`. The filter
    // above only sees the last component, and every walk in `sessions.rs` skips
    // these at any depth — so this one has to as well, or a touch inside the
    // trash would refresh a card whose session is no longer there.
    if path
        .strip_prefix(sessions_root)
        .map(|rest| {
            rest.components()
                .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
        })
        .unwrap_or(false)
    {
        return None;
    }
    if name.starts_with("session_search.sqlite") {
        return None;
    }
    let session_id = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
        .map(str::to_string);
    match name.as_str() {
        "summary.json" | "signals.json" => Some(("index", session_id)),
        "updates.jsonl" | "events.jsonl" => Some(("timeline", session_id)),
        "hunk_records.jsonl" => Some(("hunks", session_id)),
        "plan.md" => Some(("plan", session_id)),
        // A session's own directory appearing or going away. There is no file in
        // the event to recognise it by, and for a removal nothing is left to
        // stat, so it is recognised by shape alone.
        //
        // Reported without an id on purpose: given an id the frontend asks the
        // host for that one card, and a card whose session has just been deleted
        // cannot be fetched — the request fails and the stale card stays. No id
        // means "re-read the list", the only answer that is right for a session
        // that is gone. A newly created directory takes the same path and costs
        // one extra list read, which the debounce absorbs.
        _ if is_session_dir(path, sessions_root) => Some(("index", None)),
        _ => None,
    }
}

/// `<sessions>/<group>/<id>`: exactly two components below the store, which is
/// where a session's own directory sits. Shape only — the path may already be
/// gone by the time this is asked.
fn is_session_dir(path: &Path, sessions_root: &Path) -> bool {
    path.strip_prefix(sessions_root)
        .map(|rest| rest.components().count() == 2)
        .unwrap_or(false)
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Paths we care about (for tests / docs).
#[allow(dead_code)]
pub fn watched_roots() -> (PathBuf, PathBuf) {
    (sessions::grok_home(), sessions::sessions_root())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_session_streams_and_index() {
        let home = Path::new(r"C:\Users\test\.grok");
        let root = home.join("sessions");
        let session = root.join("workspace").join("session-1");
        assert_eq!(
            classify_path(&session.join("updates.jsonl"), home, &root),
            Some(("timeline", Some("session-1".into())))
        );
        assert_eq!(
            classify_path(&session.join("hunk_records.jsonl"), home, &root),
            Some(("hunks", Some("session-1".into())))
        );
        assert_eq!(
            classify_path(&home.join("active_sessions.json"), home, &root),
            Some(("index", None))
        );
        assert_eq!(
            classify_path(&session.join("session_search.sqlite-wal"), home, &root),
            None
        );
    }

    fn store() -> (&'static Path, PathBuf) {
        let home = Path::new(r"C:\Users\test\.grok");
        (home, home.join("sessions"))
    }

    #[test]
    fn a_session_directory_itself_asks_for_a_whole_list() {
        let (home, root) = store();
        // Deleting renames this directory; the event carries no file to go on.
        assert_eq!(
            classify_path(&root.join("workspace").join("session-1"), home, &root),
            Some(("index", None)),
            "no id, so the frontend re-reads instead of asking after one card"
        );
    }

    #[test]
    fn the_store_and_its_project_folders_are_not_sessions() {
        let (home, root) = store();
        assert_eq!(classify_path(&root, home, &root), None);
        assert_eq!(classify_path(&root.join("workspace"), home, &root), None);
    }

    #[test]
    fn nothing_in_the_trash_is_reported_at_any_depth() {
        let (home, root) = store();
        let trashed = root.join(".trash").join("workspace").join("session-1");
        // The dot is an ancestor here, not the last component, which is the case
        // the original filter could not see.
        assert_eq!(classify_path(&trashed, home, &root), None);
        assert_eq!(
            classify_path(&trashed.join("summary.json"), home, &root),
            None
        );
        assert_eq!(
            classify_path(&trashed.join("updates.jsonl"), home, &root),
            None
        );
    }

    #[test]
    fn a_file_inside_a_session_still_names_its_session() {
        let (home, root) = store();
        let session = root.join("workspace").join("session-1");
        // The new arm must not shadow the ones that carry an id.
        assert_eq!(
            classify_path(&session.join("summary.json"), home, &root),
            Some(("index", Some("session-1".into())))
        );
        assert_eq!(
            classify_path(&session.join("plan.md"), home, &root),
            Some(("plan", Some("session-1".into())))
        );
    }
}
