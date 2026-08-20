//! Per-task (Grok session) preferences persisted by PinkCode.
//!
//! Stored under `~/.ztidalcode/task_prefs.json` so permission mode and Plan
//! arming survive restarts and re-attach, independent of Grok's own session files.
//! This is the **session** layer of the layered config stack (see `config`).
//!
//! Several ZtidalCode windows are several OS processes sharing this one file
//! (see `multi_instance`), and every setter rewrites the whole document. Reads
//! come from a cache that revalidates against the file's stamp; writes take the
//! cross-process lock and re-read inside it, so a sibling window's edit is
//! never overwritten by a stale in-memory map.

use crate::agent_types::PermissionMode;
use crate::fs_atomic;
use crate::multi_instance;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskPrefsFile {
    /// session_id → permission mode
    #[serde(default)]
    sessions: HashMap<String, PermissionMode>,
    /// session_id → Plan Pending (Grok Plan is orthogonal to permission).
    #[serde(default)]
    plan_armed: HashMap<String, bool>,
}

/// Cheap identity of the file a cached copy was read from — the same
/// (mtime, len) pair `sessions` uses for its JSON caches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    modified_nanos: Option<u64>,
    len: u64,
}

/// Last known contents plus the stamp they came from. `loaded` separates "the
/// file does not exist" — a legitimate empty state — from "never read yet".
#[derive(Default)]
struct Cache {
    data: TaskPrefsFile,
    stamp: Option<Stamp>,
    loaded: bool,
}

struct Store {
    path: PathBuf,
    cache: Mutex<Cache>,
}

static STORE: OnceLock<Store> = OnceLock::new();
const PREFS_PRUNE_THRESHOLD: usize = 2_048;

fn prefs_dir() -> PathBuf {
    crate::config::app_home()
}

fn store() -> &'static Store {
    STORE.get_or_init(|| Store {
        path: prefs_dir().join("task_prefs.json"),
        cache: Mutex::new(Cache::default()),
    })
}

fn load_file(path: &Path) -> Result<TaskPrefsFile, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TaskPrefsFile::default());
        }
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    serde_json::from_str(&raw).map_err(|error| format!("parse {}: {error}", path.display()))
}

fn save_locked(path: &Path, data: &TaskPrefsFile) -> Result<(), String> {
    fs_atomic::write_json_atomic(path, data)
}

/// `None` when the file is absent or unstattable — both mean "reload".
fn stamp_of(path: &Path) -> Option<Stamp> {
    let metadata = fs::metadata(path).ok()?;
    Some(Stamp {
        modified_nanos: metadata
            .modified()
            .ok()
            .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
            .and_then(|since| u64::try_from(since.as_nanos()).ok()),
        len: metadata.len(),
    })
}

/// Reload when the file no longer matches the stamp the cache was built from.
///
/// The stamp is taken *before* the read: a sibling write landing in between
/// then leaves the cache looking older than the file and costs one extra
/// reload, whereas stamping afterwards would pair a fresh stamp with stale
/// content and pin the cache to it.
fn refresh_locked(path: &Path, cache: &mut Cache) {
    let stamp = stamp_of(path);
    if cache.loaded && cache.stamp == stamp {
        return;
    }
    match load_file(path) {
        Ok(data) => cache.data = data,
        // Keep the last good copy: a corrupt file should not blank out the
        // modes the UI is showing. Writes re-read under the lock and refuse on
        // the same error, so nothing gets overwritten on the strength of it.
        Err(error) => tracing::warn!(error = %error, "task preferences could not be read"),
    }
    cache.stamp = stamp;
    cache.loaded = true;
}

fn with_data<T>(read: impl FnOnce(&TaskPrefsFile) -> T) -> T {
    let store = store();
    let mut cache = store.cache.lock();
    refresh_locked(&store.path, &mut cache);
    read(&cache.data)
}

/// Read-modify-write of the prefs document at `path`, atomic against other
/// processes. Returns what landed on disk and the stamp it landed with, both
/// taken while the lock is still held — a stamp read after the release could
/// already belong to a sibling's newer write.
///
/// Re-reading inside the lock is the point of the exercise: the whole map is
/// serialized on every setter, so writing from an in-memory copy silently drops
/// whatever a second window changed since this process last read the file.
fn update_at(
    path: &Path,
    mutate: impl FnOnce(&mut TaskPrefsFile),
) -> Result<(TaskPrefsFile, Option<Stamp>), String> {
    let _lock = multi_instance::lock_sidecar(path)?;
    let mut data = load_file(path).map_err(|error| {
        format!("preferences were not loaded; refusing to overwrite them: {error}")
    })?;
    mutate(&mut data);
    save_locked(path, &data)?;
    Ok((data, stamp_of(path)))
}

fn update(mutate: impl FnOnce(&mut TaskPrefsFile)) -> Result<(), String> {
    let store = store();
    // In-process mutex first, then the file lock — one order everywhere, and
    // readers never take the file lock, so the two cannot deadlock.
    let mut cache = store.cache.lock();
    let (data, stamp) = update_at(&store.path, mutate)?;
    cache.data = data;
    cache.stamp = stamp;
    cache.loaded = true;
    Ok(())
}

fn prune_stale_sessions(data: &mut TaskPrefsFile, keep_id: &str) {
    if data.sessions.len().max(data.plan_armed.len()) <= PREFS_PRUNE_THRESHOLD {
        return;
    }
    let existing = crate::sessions::session_ids_on_disk();
    data.sessions
        .retain(|id, _| id == keep_id || existing.contains(id));
    data.plan_armed
        .retain(|id, _| id == keep_id || existing.contains(id));
}

/// Look up a persisted mode for a Grok session id.
pub fn get_permission_mode(session_id: &str) -> Option<PermissionMode> {
    let id = session_id.trim();
    if id.is_empty() {
        return None;
    }
    with_data(|data| data.sessions.get(id).copied())
}

/// Persist permission mode for a session (and optionally refresh last-spawn seed).
pub fn set_permission_mode(session_id: &str, mode: PermissionMode) -> Result<(), String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Err("session id is empty".into());
    }
    update(|data| {
        data.sessions.insert(id.to_string(), mode);
        prune_stale_sessions(data, id);
    })
}

/// Canonical permission mode: this session's own choice, else the configured
/// default.
///
/// - `session_id`: when set, use that session's stored mode if present.
///
/// Nothing sits between the two. A task carries the mode it was given; every
/// other task starts from [`crate::config`], which is a value someone wrote
/// down. Upstream kept a "last spawn" seed here so a new task inherited
/// whatever the previous one happened to run as — with full permissions as the
/// configured default that seed could only ever hand a *narrower* mode forward,
/// silently, from a task the user had long forgotten. It is gone.
///
/// New Task: `effective_permission_mode(None)`.
/// Attach without request mode: `effective_permission_mode(Some(id))`.
///
/// Takes no working directory: the workspace has no say in the mode its own
/// tasks start in (see [`crate::config`]).
pub fn effective_permission_mode(session_id: Option<&str>) -> PermissionMode {
    if let Some(id) = session_id {
        if let Some(mode) = get_permission_mode(id) {
            return mode;
        }
    }
    crate::config::resolve().default_permission_mode
}

/// Snapshot of all session → mode mappings (for UI hydration).
pub fn all_permission_modes() -> HashMap<String, PermissionMode> {
    with_data(|data| data.sessions.clone())
}

/// Whether Plan mode is armed (Pending) for this session.
pub fn get_plan_armed(session_id: &str) -> bool {
    let id = session_id.trim();
    if id.is_empty() {
        return false;
    }
    with_data(|data| data.plan_armed.get(id).copied().unwrap_or(false))
}

/// Persist Plan arming (true = Pending until next free-text `/plan …`).
pub fn set_plan_armed(session_id: &str, armed: bool) -> Result<(), String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Err("session id is empty".into());
    }
    update(|data| {
        if armed {
            data.plan_armed.insert(id.to_string(), true);
        } else {
            data.plan_armed.remove(id);
        }
        prune_stale_sessions(data, id);
    })
}

/// Snapshot of session → plan-armed flags (only `true` entries are stored).
pub fn all_plan_armed() -> HashMap<String, bool> {
    with_data(|data| data.plan_armed.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Only two things decide a task's mode: its own stored choice, and the
    /// configured default. Guards the removal of upstream's last-spawn seed —
    /// a task must never inherit what some earlier task happened to run as.
    #[test]
    fn a_task_inherits_nothing_from_the_task_before_it() {
        let fields = serde_json::to_value(TaskPrefsFile::default()).expect("serialize");
        let object = fields.as_object().expect("object");
        assert!(
            !object.keys().any(|key| key.contains("astSpawn")),
            "a last-spawn seed is back in the document: {:?}",
            object.keys().collect::<Vec<_>>()
        );
    }

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    fn temp_store_path() -> PathBuf {
        let n = TEST_SEQ.fetch_add(1, Ordering::SeqCst);
        let t = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("pinkcode_prefs_test_{t}_{n}.json"))
    }

    /// Remove the document and the lock file that sits beside it.
    fn cleanup(path: &Path) {
        let _ = fs::remove_file(path);
        let mut lock = path.as_os_str().to_os_string();
        lock.push(".lock");
        let _ = fs::remove_file(PathBuf::from(lock));
    }

    #[test]
    fn roundtrip_session_mode() {
        let path = temp_store_path();
        let _ = fs::remove_file(&path);
        let mut data = TaskPrefsFile::default();
        data.sessions
            .insert("sess-1".into(), PermissionMode::AcceptEdits);
        data.plan_armed.insert("sess-1".into(), true);
        save_locked(&path, &data).expect("save");
        let loaded = load_file(&path).expect("load");
        assert_eq!(
            loaded.sessions.get("sess-1").copied(),
            Some(PermissionMode::AcceptEdits)
        );
        assert_eq!(loaded.plan_armed.get("sess-1").copied(), Some(true));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn plan_armed_defaults_empty() {
        let path = temp_store_path();
        let _ = fs::remove_file(&path);
        let data = TaskPrefsFile::default();
        save_locked(&path, &data).expect("save");
        let loaded = load_file(&path).expect("load");
        assert!(loaded.plan_armed.is_empty());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn corrupt_preferences_are_reported_and_left_untouched() {
        let path = temp_store_path();
        fs::write(&path, "{broken").expect("fixture");
        let before = fs::read(&path).expect("before");
        assert!(load_file(&path).expect_err("parse error").contains("parse"));
        assert_eq!(fs::read(&path).expect("after"), before);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn a_write_refuses_to_replace_preferences_it_could_not_read() {
        let path = temp_store_path();
        cleanup(&path);
        fs::write(&path, "{broken").expect("fixture");

        let error = update_at(&path, |data| {
            data.sessions.insert("scratch".into(), PermissionMode::Auto);
        })
        .expect_err("must refuse");
        assert!(error.contains("refusing to overwrite"), "{error}");
        assert_eq!(fs::read_to_string(&path).expect("after"), "{broken");
        cleanup(&path);
    }

    /// The regression the lock exists for: a second window's edit lands between
    /// two of ours and has to survive our next write.
    #[test]
    fn a_sibling_windows_edit_survives_our_next_write() {
        let path = temp_store_path();
        cleanup(&path);

        update_at(&path, |data| {
            data.sessions.insert("ours".into(), PermissionMode::Default);
        })
        .expect("first write");

        // Exactly what the other process runs: its own locked read-edit-write.
        update_at(&path, |data| {
            data.sessions.insert("theirs".into(), PermissionMode::Auto);
            data.plan_armed.insert("theirs".into(), true);
        })
        .expect("sibling write");

        update_at(&path, |data| {
            data.sessions
                .insert("ours".into(), PermissionMode::AcceptEdits);
        })
        .expect("second write");

        let on_disk = load_file(&path).expect("load");
        assert_eq!(
            on_disk.sessions.get("ours").copied(),
            Some(PermissionMode::AcceptEdits)
        );
        assert_eq!(
            on_disk.sessions.get("theirs").copied(),
            Some(PermissionMode::Auto),
            "the sibling's permission mode was clobbered"
        );
        assert_eq!(on_disk.plan_armed.get("theirs").copied(), Some(true));
        cleanup(&path);
    }

    /// Writers hammering one document keep every entry. Threads stand in for
    /// processes here: the lock is held on a file handle, so it excludes both.
    #[test]
    fn concurrent_writers_do_not_lose_entries() {
        let path = temp_store_path();
        cleanup(&path);

        let writers = 4usize;
        let per_writer = 6usize;
        std::thread::scope(|scope| {
            for writer in 0..writers {
                let path = path.clone();
                scope.spawn(move || {
                    for n in 0..per_writer {
                        let id = format!("w{writer}-s{n}");
                        update_at(&path, |data| {
                            data.sessions.insert(id, PermissionMode::Auto);
                        })
                        .expect("write under contention");
                    }
                });
            }
        });

        let on_disk = load_file(&path).expect("load");
        assert_eq!(on_disk.sessions.len(), writers * per_writer);
        for writer in 0..writers {
            for n in 0..per_writer {
                assert!(
                    on_disk.sessions.contains_key(&format!("w{writer}-s{n}")),
                    "lost w{writer}-s{n}"
                );
            }
        }
        cleanup(&path);
    }

    #[test]
    fn cached_reads_follow_the_file_across_processes() {
        let path = temp_store_path();
        cleanup(&path);
        let mut cache = Cache::default();

        // An absent file is a real state, not "unread": it reads as empty.
        refresh_locked(&path, &mut cache);
        assert!(cache.loaded);
        assert!(cache.data.sessions.is_empty());

        update_at(&path, |data| {
            data.sessions.insert("one".into(), PermissionMode::Auto);
        })
        .expect("sibling creates the file");
        refresh_locked(&path, &mut cache);
        assert_eq!(
            cache.data.sessions.get("one").copied(),
            Some(PermissionMode::Auto)
        );

        // Unchanged file → no reload, so a value only this cache holds survives.
        cache
            .data
            .sessions
            .insert("scratch".into(), PermissionMode::DontAsk);
        refresh_locked(&path, &mut cache);
        assert!(cache.data.sessions.contains_key("scratch"));

        // Changed file → reload, and the scratch value goes with it.
        update_at(&path, |data| {
            data.sessions
                .insert("two".into(), PermissionMode::AcceptEdits);
        })
        .expect("sibling appends");
        refresh_locked(&path, &mut cache);
        assert_eq!(
            cache.data.sessions.get("two").copied(),
            Some(PermissionMode::AcceptEdits)
        );
        assert!(!cache.data.sessions.contains_key("scratch"));
        cleanup(&path);
    }
}

#[cfg(test)]
mod compatibility {
    //! The prefs document outlives the build that wrote it — a user upgrading
    //! carries one written by the previous version.
    use super::*;

    /// Removing `lastSpawnMode` from the struct must not cost anyone their
    /// stored per-task modes. `TaskPrefsFile` sets no `deny_unknown_fields`, so
    /// the stale key is ignored and disappears on the next write; this pins that
    /// so a later `deny_unknown_fields` cannot silently wipe the document.
    #[test]
    fn a_document_written_by_an_older_build_still_loads() {
        let raw = r#"{"sessions":{"abc":"auto"},"planArmed":{"abc":true},"lastSpawnMode":"default"}"#;
        let parsed: TaskPrefsFile = serde_json::from_str(raw).expect("legacy doc must still load");
        assert_eq!(
            parsed.sessions.get("abc").copied(),
            Some(PermissionMode::Auto),
            "stored per-session modes must survive the field removal"
        );
        assert!(parsed.plan_armed.get("abc").copied().unwrap_or(false));
    }
}
