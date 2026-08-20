//! Running several ZtidalCode windows at once, each as its own OS process.
//!
//! A second window cannot be a `WebviewWindow`: `capabilities/default.json`
//! scopes every permission to the window label `main`, so an in-process sibling
//! comes up with no IPC at all. Nothing stops a second *process* — there is no
//! single-instance plugin — so what this module provides is not the ability to
//! run two windows but the mutual exclusion that makes it safe: the processes
//! share `~/.ztidalcode`, and the documents there are rewritten whole.
//!
//! `fs_atomic` already makes each replace all-or-nothing, which rules out torn
//! files but not lost updates: two processes that each serialize their own copy
//! of a map keep deleting each other's entries. The advisory sidecar lock below
//! is the same shape as `auth::acquire_auth_lock`, so a read-modify-write can be
//! made atomic against other windows rather than only against a crash.

use crate::agent_runtime::now_unix_secs;
use serde::Serialize;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

/// Must exceed the longest time a holder legitimately keeps the lock. Holders
/// here re-read, edit and re-write one small JSON document — sub-millisecond
/// work — so this is generous by orders of magnitude and still fails long
/// before a user reads the error. `auth` waits 20s because its holder spans an
/// OIDC round trip; nothing under this lock touches the network, so waiting
/// that long would only turn a real deadlock into a frozen menu.
pub const LOCK_WAIT: Duration = Duration::from_secs(5);
const LOCK_POLL: Duration = Duration::from_millis(20);

/// A held advisory lock. Released on drop, and by the OS if the process dies —
/// which is why the marker inside the file is diagnostics, never the lock.
#[derive(Debug)]
pub struct InstanceLock {
    file: File,
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

/// `<target>.lock` beside the file it guards (`task_prefs.json.lock`, …).
///
/// A sidecar rather than the document itself: the document is replaced by
/// rename, and a lock on a file that gets replaced guards the old inode.
fn sidecar_path(target: &Path) -> Result<PathBuf, String> {
    let name = target
        .file_name()
        .ok_or_else(|| format!("{} has no file name to lock", target.display()))?;
    let mut lock_name = name.to_os_string();
    lock_name.push(".lock");
    Ok(target.with_file_name(lock_name))
}

/// Exclusive cross-process lock guarding writes to `target`, waiting [`LOCK_WAIT`].
pub fn lock_sidecar(target: &Path) -> Result<InstanceLock, String> {
    lock_sidecar_within(target, LOCK_WAIT)
}

/// [`lock_sidecar`] with a caller-chosen deadline, for holders that would rather
/// skip their write than make a person wait for it.
pub fn lock_sidecar_within(target: &Path, wait: Duration) -> Result<InstanceLock, String> {
    let path = sidecar_path(target)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    // truncate(false): opening a shared path must not wipe the current holder's
    // marker; we rewrite it only once the lock is ours (mirrors `auth`).
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|error| format!("Cannot open {}: {error}", path.display()))?;

    let deadline = Instant::now() + wait;
    loop {
        match file.try_lock() {
            Ok(()) => {
                let marker = format!("{}:{}\n", std::process::id(), now_unix_secs());
                let _ = file.set_len(0);
                let _ = file.write_all(marker.as_bytes());
                return Ok(InstanceLock { file });
            }
            Err(TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "{} is busy (another window is writing). Retry shortly.",
                        path.display()
                    ));
                }
                thread::sleep(LOCK_POLL);
            }
            Err(TryLockError::Error(error)) => {
                return Err(format!("{} lock failed: {error}", path.display()));
            }
        }
    }
}

/// The OS process now serving a newly opened window.
#[derive(Debug, Clone, Serialize)]
pub struct NewInstance {
    /// Process id, so a support report can tell two windows apart.
    pub pid: u32,
}

/// Start another instance of this application: same executable, fresh process.
///
/// The child inherits our environment and working directory and opens its own
/// dashboard; projects are chosen per window, so nothing is passed on the
/// command line.
pub fn launch_sibling_instance() -> Result<NewInstance, String> {
    let exe = std::env::current_exe()
        .map_err(|error| format!("Cannot locate this application: {error}"))?;
    let mut child = Command::new(&exe)
        .spawn()
        .map_err(|error| format!("Cannot start {}: {error}", exe.display()))?;
    let pid = child.id();
    // Reap on a parked thread: on Unix an unwaited child stays a zombie for as
    // long as this process lives, and windows outlive each other by design.
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(NewInstance { pid })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn temp_target(name: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "pinkcode_lock_{name}_{}_{n}.json",
            std::process::id()
        ))
    }

    fn cleanup(target: &Path) {
        let _ = fs::remove_file(target);
        let _ = fs::remove_file(sidecar_path(target).expect("sidecar"));
    }

    #[test]
    fn lock_lives_beside_the_document_it_guards() {
        let sidecar = sidecar_path(Path::new("/tmp/task_prefs.json")).expect("sidecar");
        assert_eq!(sidecar.file_name().unwrap(), "task_prefs.json.lock");
        assert_eq!(sidecar.parent(), Path::new("/tmp/task_prefs.json").parent());
    }

    /// The lock has to exclude *another handle*, not another thread: a second
    /// window is a second process, and process-local mutexes do not see it.
    #[test]
    fn a_second_holder_is_refused_until_the_first_releases() {
        let target = temp_target("exclusive");
        cleanup(&target);

        let held = lock_sidecar(&target).expect("first holder");
        let busy = lock_sidecar_within(&target, Duration::from_millis(80))
            .expect_err("second holder must wait, then give up");
        assert!(busy.contains("busy"), "{busy}");

        drop(held);
        lock_sidecar_within(&target, Duration::from_millis(500)).expect("lock is free again");
        cleanup(&target);
    }

    /// The marker is for post-mortem diagnosis of a lock file left behind, not
    /// for arbitration — Windows refuses reads through another handle while the
    /// range is locked, so it can only be read once the holder has let go.
    #[test]
    fn lock_file_records_the_holding_process() {
        let target = temp_target("marker");
        cleanup(&target);

        drop(lock_sidecar(&target).expect("holder"));
        let marker = fs::read_to_string(sidecar_path(&target).expect("sidecar")).expect("marker");
        assert!(
            marker.starts_with(&format!("{}:", std::process::id())),
            "{marker}"
        );
        cleanup(&target);
    }
}
