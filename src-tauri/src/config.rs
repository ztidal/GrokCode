//! Layered ZtidalCode host configuration (log level + default permission mode).
//!
//! Priority for [`resolve`] (later wins):
//! 1. Built-in defaults
//! 2. Environment (`PINKCODE_*`) — seed when files omit a field; files override env
//! 3. Global file `~/.ztidalcode/config.json`
//!
//! There is deliberately no project-level layer. Upstream reads
//! `<cwd>/.pinkcode/config.json`, which lets a cloned repository choose the
//! permission mode its own tasks start in, with no prompt. Config is host state,
//! not repository content — do not reintroduce a workspace layer when merging
//! upstream.
//!
//! Session-scoped permission / plan prefs live in [`crate::task_prefs`] and are
//! **not** merged here. Callers should use
//! [`crate::task_prefs::effective_permission_mode`] (session → last-spawn → this
//! resolve) rather than inventing their own fallback chain.
//!
//! The built-in default is [`DEFAULT_PERMISSION_MODE`] — full permissions. It is
//! the weakest layer in the stack, so env, the global file and the per-task
//! choice all still move away from it. See ADR-0002.
//!
//! Startup tracing uses `resolve()` (env + global only). Config files are
//! read-only from the host today (no settings UI); write path lives in tests
//! via [`crate::fs_atomic`].
//!
//! [`init_tracing`] also owns the host's log file, because it is the one place
//! that runs before `tauri::Builder` and already knows [`app_home`]. See
//! [`LOG_DIR`] for why a release build has nowhere else to write.

use crate::agent_types::PermissionMode;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

/// Permission mode a task starts in when nothing else has chosen one.
///
/// `BypassPermissions` — the team runs the agent on repositories it already
/// trusts, and an approval prompt on every tool call was answered "yes" often
/// enough that the prompt stopped carrying information. It is not a ceiling:
/// env, the global file and the task's own choice each override it, and moving
/// down to `Default` is one click in the New Task modal.
///
/// It is also the *only* thing a fresh task reads. Upstream let the previous
/// task's mode seed the next one; that seed is gone, so the mode on screen is
/// always either this value or a choice made for that task — never a residue of
/// some earlier one. Config still takes no working directory either, so a
/// repository cannot pick its own mode. See ADR-0002.
const DEFAULT_PERMISSION_MODE: PermissionMode = PermissionMode::BypassPermissions;

/// On-disk / env-mergeable config document (all fields optional).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigLayer {
    /// Tracing / log level directive fragment, e.g. `info`, `debug`, `pinkcode=trace`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_level: Option<String>,
    /// Default host permission mode for new tasks / seed when no last-spawn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_permission_mode: Option<PermissionMode>,
}

impl ConfigLayer {
    fn merge_from(&mut self, other: &ConfigLayer) {
        if other.log_level.is_some() {
            self.log_level = other.log_level.clone();
        }
        if other.default_permission_mode.is_some() {
            self.default_permission_mode = other.default_permission_mode;
        }
    }
}

/// Fully resolved host settings after layer merge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedConfig {
    pub log_level: String,
    pub default_permission_mode: PermissionMode,
}

impl Default for ResolvedConfig {
    fn default() -> Self {
        Self {
            log_level: default_log_level().to_string(),
            default_permission_mode: DEFAULT_PERMISSION_MODE,
        }
    }
}

fn default_log_level() -> &'static str {
    if cfg!(debug_assertions) {
        "debug"
    } else {
        "info"
    }
}

/// `~/.ztidalcode` — host state for this build only. Upstream PinkCode uses
/// `~/.pinkcode`; the two apps ship separate bundle identifiers and must not
/// share a config file.
pub fn app_home() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ztidalcode")
}

pub fn global_config_path() -> PathBuf {
    app_home().join("config.json")
}

fn load_layer_file(path: &Path) -> Result<ConfigLayer, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ConfigLayer::default());
        }
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    if raw.trim().is_empty() {
        return Ok(ConfigLayer::default());
    }
    serde_json::from_str(&raw).map_err(|error| format!("parse {}: {error}", path.display()))
}

/// Environment layer (`PINKCODE_LOG_LEVEL`, `PINKCODE_DEFAULT_PERMISSION_MODE`).
pub fn layer_from_env() -> ConfigLayer {
    layer_from_env_reader(|key| std::env::var(key))
}

fn layer_from_env_reader(
    reader: impl Fn(&str) -> Result<String, std::env::VarError>,
) -> ConfigLayer {
    let mut layer = ConfigLayer::default();
    if let Ok(level) = reader("PINKCODE_LOG_LEVEL") {
        let level = level.trim();
        if !level.is_empty() {
            layer.log_level = Some(level.to_string());
        }
    }
    if let Ok(mode) = reader("PINKCODE_DEFAULT_PERMISSION_MODE") {
        if let Some(m) = parse_permission_mode_env(mode.trim()) {
            layer.default_permission_mode = Some(m);
        } else if !mode.trim().is_empty() {
            tracing::warn!(
                value = %mode.trim(),
                "PINKCODE_DEFAULT_PERMISSION_MODE is not a known mode; ignoring"
            );
        }
    }
    layer
}

fn parse_permission_mode_env(raw: &str) -> Option<PermissionMode> {
    match raw.to_ascii_lowercase().as_str() {
        "default" | "ask" | "normal" => Some(PermissionMode::Default),
        "acceptedits" | "accept_edits" | "accept-edits" => Some(PermissionMode::AcceptEdits),
        "auto" => Some(PermissionMode::Auto),
        "bypasspermissions" | "bypass_permissions" | "bypass-permissions" | "yolo"
        | "alwaysapprove" | "always-approve" => Some(PermissionMode::BypassPermissions),
        "dontask" | "dont_ask" | "dont-ask" => Some(PermissionMode::DontAsk),
        _ => None,
    }
}

fn defaults_layer() -> ConfigLayer {
    ConfigLayer {
        log_level: Some(default_log_level().to_string()),
        default_permission_mode: Some(DEFAULT_PERMISSION_MODE),
    }
}

/// Collapse a fully merged layer into concrete defaults.
fn finalize(merged: ConfigLayer) -> ResolvedConfig {
    ResolvedConfig {
        log_level: merged
            .log_level
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| default_log_level().to_string()),
        default_permission_mode: merged
            .default_permission_mode
            .unwrap_or(DEFAULT_PERMISSION_MODE),
    }
}

/// Merge defaults → env → global (later wins).
/// Session-level prefs live in `task_prefs` and are applied by callers.
///
/// Takes no working directory: nothing a repository ships may influence the
/// permission mode its tasks start in.
pub fn resolve() -> ResolvedConfig {
    let mut merged = defaults_layer();
    merged.merge_from(&layer_from_env());
    match load_layer_file(&global_config_path()) {
        Ok(global) => merged.merge_from(&global),
        Err(error) => {
            tracing::warn!(error = %error, "failed to load global ZtidalCode config");
        }
    }
    finalize(merged)
}

/// `~/.ztidalcode/logs` — the second sink, and in an installed build the only
/// one. `main.rs` sets `windows_subsystem = "windows"` for release, so the app
/// a teammate launches from the Start Menu has no console behind stderr and
/// every `warn!`/`error!` in the crate went nowhere.
const LOG_DIR: &str = "logs";

/// How long a log file outlives its last write. Retention is ours: the file
/// name is per process, so nothing ever renames or replaces one, and without a
/// prune the directory only grows.
const LOG_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// `app-<date>-<pid>.log`.
///
/// Per process, not per day. Several ZtidalCode windows run as separate OS
/// processes over one `~/.ztidalcode` (see [`crate::multi_instance`]), and the
/// usual daily rollover works by renaming the current file — which on Windows
/// fails while another process holds it open, and fails *inside the writer*,
/// where nobody is watching. The pid means no two windows ever share a file.
/// The date is for the human reading the directory; [`prune_old_logs`] goes by
/// mtime, not by this.
fn log_file_name(now_secs: u64, pid: u32) -> String {
    let stamp = crate::agent_runtime::unix_to_rfc3339_z(now_secs);
    let date = stamp.split('T').next().unwrap_or("unknown");
    format!("app-{date}-{pid}.log")
}

/// Delete `app-*.log` files last written before `cutoff`.
///
/// mtime rather than the date in the name: a window left open for a fortnight
/// keeps appending to a file named for the day it started, so mtime is the only
/// reading of "old" that cannot pull the file out from under a live process.
fn prune_old_logs(dir: &Path, cutoff: SystemTime) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with("app-") || !name.ends_with(".log") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|meta| meta.modified()) else {
            continue;
        };
        if modified < cutoff {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Make the log directory, drop what has aged out, and name this process's
/// file. `None` leaves the host on stderr alone — where it was before.
fn prepare_log_file() -> Option<PathBuf> {
    let dir = app_home().join(LOG_DIR);
    if let Err(error) = fs::create_dir_all(&dir) {
        eprintln!("[ztidalcode] no log file ({}): {error}", dir.display());
        return None;
    }
    if let Some(cutoff) = SystemTime::now().checked_sub(LOG_RETENTION) {
        prune_old_logs(&dir, cutoff);
    }
    Some(dir.join(log_file_name(
        crate::agent_runtime::now_unix_secs(),
        std::process::id(),
    )))
}

/// Appends one formatted event per `OpenOptions` open, synchronously.
///
/// Holding no handle between events costs an open per line — nothing at the
/// volume this filter admits — and buys two things a background appender would
/// take back: another window's startup prune can remove the file without
/// wedging this process (the next event recreates it), and there is no queue to
/// lose when a panic aborts.
#[derive(Clone)]
struct AppendFile(Arc<PathBuf>);

struct AppendWriter(Arc<PathBuf>);

impl std::io::Write for AppendWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.0.as_path())?;
        file.write_all(buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for AppendFile {
    type Writer = AppendWriter;

    fn make_writer(&'a self) -> Self::Writer {
        AppendWriter(Arc::clone(&self.0))
    }
}

/// Write a panic to the log file with a handle opened on the spot, then hand
/// the panic to whoever had the hook before us.
///
/// Deliberately not routed through tracing: a panic may abort, and anything
/// still buffered is gone at exactly the moment its contents are the whole
/// message. `force_capture` rather than `capture` because `RUST_BACKTRACE` is
/// never set for an app started from a Start Menu shortcut, which is every
/// install the team runs.
fn install_panic_hook(path: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(
                file,
                "\n{} PANIC pid={} {info}\n{backtrace}",
                crate::agent_runtime::now_iso(),
                std::process::id()
            );
        }
        previous(info);
    }));
}

/// The directive string both sinks are built from. `RUST_LOG` still wins over
/// the resolved `log_level`, as it did when stderr was the only sink.
fn tracing_directives(cfg: &ResolvedConfig) -> String {
    use tracing_subscriber::EnvFilter;

    if let Ok(raw) = std::env::var(EnvFilter::DEFAULT_ENV) {
        if EnvFilter::try_new(&raw).is_ok() {
            return raw;
        }
    }
    config_directives(&cfg.log_level)
}

/// Config may be a bare level (`info`) or a full directive (`pinkcode=debug`).
///
/// A bare level raises *this crate* and pins everything else at `info`. That is
/// what keeps the agent off our disk now that events reach one: `acp::gateway`
/// pipes every line of `grok`'s stderr through
/// `tracing::debug!(target: "grok_agent", …)`, so a global `debug` would write a
/// teammate's entire agent session to a file.
///
/// This holds for the *config* path only. `RUST_LOG` bypasses it entirely — a
/// bare `RUST_LOG=debug` is global and does put the agent's stderr on disk.
/// That is a deliberate escape hatch for someone debugging the transport on
/// their own machine, not a setting to hand a teammate.
fn config_directives(log_level: &str) -> String {
    let directive = log_level.trim();
    if directive.contains('=') || directive.contains(',') {
        directive.to_string()
    } else {
        format!("pinkcode={directive},info")
    }
}

/// Initialize tracing from layered config. Safe to call once at startup.
///
/// `RUST_LOG` (if set) wins over config `log_level` for the EnvFilter.
pub fn init_tracing() {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::EnvFilter;

    let cfg = resolve();
    let directives = tracing_directives(&cfg);
    let filter = EnvFilter::try_new(&directives).unwrap_or_else(|_| EnvFilter::new("info"));

    let log_file = prepare_log_file();
    let file_layer = log_file.clone().map(|path| {
        tracing_subscriber::fmt::layer()
            .with_target(true)
            .with_ansi(false)
            .with_writer(AppendFile(Arc::new(path)))
    });

    // One filter above both layers rather than a filter per layer: the file must
    // not carry a level of its own, or raising it lands `grok_agent` on disk.
    let result = tracing_subscriber::registry()
        .with(filter)
        .with(
            tracing_subscriber::fmt::layer()
                .with_target(true)
                .with_writer(std::io::stderr),
        )
        .with(file_layer)
        .try_init();

    if let Err(error) = result {
        // Already initialized (tests / double run) — not fatal.
        eprintln!("[ztidalcode] tracing init skipped: {error}");
    } else {
        if let Some(path) = log_file {
            install_panic_hook(path.clone());
            tracing::info!(path = %path.display(), "host log file");
        }
        tracing::info!(
            log_level = %cfg.log_level,
            default_permission = ?cfg.default_permission_mode,
            "ZtidalCode config resolved"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("pinkcode_cfg_{}_{n}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// Test-only atomic write (production has no settings UI yet).
    fn write_layer(path: &Path, layer: &ConfigLayer) -> Result<(), String> {
        crate::fs_atomic::write_json_atomic(path, layer)
    }

    #[test]
    fn merge_later_wins() {
        let mut base = ConfigLayer {
            log_level: Some("info".into()),
            default_permission_mode: Some(PermissionMode::Default),
        };
        base.merge_from(&ConfigLayer {
            log_level: Some("debug".into()),
            default_permission_mode: None,
        });
        assert_eq!(base.log_level.as_deref(), Some("debug"));
        assert_eq!(base.default_permission_mode, Some(PermissionMode::Default));
        base.merge_from(&ConfigLayer {
            log_level: None,
            default_permission_mode: Some(PermissionMode::Auto),
        });
        assert_eq!(base.default_permission_mode, Some(PermissionMode::Auto));
        assert_eq!(base.log_level.as_deref(), Some("debug"));
    }

    #[test]
    fn env_layer_parses_modes() {
        let layer = layer_from_env_reader(|key| match key {
            "PINKCODE_LOG_LEVEL" => Ok("trace".into()),
            "PINKCODE_DEFAULT_PERMISSION_MODE" => Ok("auto".into()),
            _ => Err(std::env::VarError::NotPresent),
        });
        assert_eq!(layer.log_level.as_deref(), Some("trace"));
        assert_eq!(layer.default_permission_mode, Some(PermissionMode::Auto));
    }

    #[test]
    fn global_file_roundtrip() {
        // Disk load only — does not call resolve() (avoids real home/env).
        let dir = temp_dir();
        let layer = ConfigLayer {
            log_level: Some("warn".into()),
            default_permission_mode: Some(PermissionMode::AcceptEdits),
        };
        let path = dir.join("config.json");
        write_layer(&path, &layer).expect("write");
        assert!(path.is_file());
        let loaded = load_layer_file(&path).expect("load");
        assert_eq!(loaded, layer);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A repository may ship any config it likes; none of it is a config layer.
    /// Guards the deliberate removal of upstream's `<cwd>/.pinkcode` layer.
    #[test]
    fn repository_config_is_not_a_layer() {
        let dir = temp_dir();
        for name in [".pinkcode", ".ztidalcode"] {
            let planted = dir.join(name).join("config.json");
            write_layer(
                &planted,
                &ConfigLayer {
                    log_level: None,
                    default_permission_mode: Some(PermissionMode::BypassPermissions),
                },
            )
            .expect("write");
            assert!(planted.is_file(), "fixture not written for {name}");
        }
        // The only file `resolve` consults is the global one.
        assert_eq!(global_config_path(), app_home().join("config.json"));
        assert!(
            !global_config_path().starts_with(&dir),
            "global config must not resolve inside a workspace"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_then_finalize_later_layer_wins() {
        // Isolated pure merge — no real ~/.ztidalcode or process env.
        let mut merged = defaults_layer();
        merged.merge_from(&ConfigLayer {
            log_level: Some("trace".into()),
            default_permission_mode: Some(PermissionMode::Auto),
        });
        merged.merge_from(&ConfigLayer {
            log_level: Some("warn".into()),
            default_permission_mode: Some(PermissionMode::AcceptEdits),
        });
        let resolved = finalize(merged);
        assert_eq!(resolved.log_level, "warn");
        assert_eq!(
            resolved.default_permission_mode,
            PermissionMode::AcceptEdits
        );
    }

    /// The stated posture of the fork: a task nobody has configured starts with
    /// full permissions (ADR-0002).
    #[test]
    fn a_task_nobody_configured_starts_with_full_permissions() {
        assert_eq!(
            finalize(defaults_layer()).default_permission_mode,
            PermissionMode::BypassPermissions
        );
        // The struct default is the same decision, for callers that skip resolve().
        assert_eq!(
            ResolvedConfig::default().default_permission_mode,
            PermissionMode::BypassPermissions
        );
    }

    /// Full permissions is a Seed, not a ceiling — any later layer moves off it,
    /// including back down to Ask.
    #[test]
    fn a_later_layer_can_take_the_default_back_down_to_ask() {
        let mut merged = defaults_layer();
        merged.merge_from(&ConfigLayer {
            log_level: None,
            default_permission_mode: Some(PermissionMode::Default),
        });
        assert_eq!(
            finalize(merged).default_permission_mode,
            PermissionMode::Default
        );
    }

    /// A task with no stored choice of its own reads this file and nothing
    /// else. Guards the removal of upstream's last-spawn seed: if that ever
    /// comes back, a new task stops starting where this constant says.
    #[test]
    fn a_fresh_task_starts_at_the_configured_default() {
        assert_eq!(
            crate::task_prefs::effective_permission_mode(None),
            finalize(defaults_layer()).default_permission_mode,
            "a fresh task must start at the configured default"
        );
    }

    /// The writer is the whole point of the file layer, and it is the piece the
    /// fmt layer swallows the errors of: if it silently failed to create or to
    /// append, the sink would look installed and stay empty.
    #[test]
    fn the_writer_creates_the_file_and_appends_to_it() {
        use tracing_subscriber::fmt::MakeWriter;

        let dir = temp_dir();
        let path = dir.join(log_file_name(0, std::process::id()));
        let make = AppendFile(Arc::new(path.clone()));

        make.make_writer().write_all(b"first\n").expect("create");
        make.make_writer().write_all(b"second\n").expect("append");

        assert_eq!(
            fs::read_to_string(&path).expect("read back"),
            "first\nsecond\n",
            "the second open must append, not truncate"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// Two windows are two OS processes over one `~/.ztidalcode`; a shared file
    /// name is what would make one of them the writer that silently stops.
    #[test]
    fn each_window_writes_to_a_file_of_its_own() {
        assert_eq!(log_file_name(0, 4242), "app-1970-01-01-4242.log");
        assert_ne!(log_file_name(0, 1), log_file_name(0, 2));
    }

    #[test]
    fn prune_drops_aged_logs_and_leaves_everything_else() {
        let dir = temp_dir();
        let ours = dir.join(log_file_name(0, std::process::id()));
        let other = dir.join("notes.txt");
        fs::write(&ours, "x").expect("write log");
        fs::write(&other, "x").expect("write other");

        prune_old_logs(&dir, SystemTime::now() - Duration::from_secs(3600));
        assert!(ours.is_file(), "a log inside the window must survive");

        prune_old_logs(&dir, SystemTime::now() + Duration::from_secs(3600));
        assert!(!ours.exists(), "an aged log must go");
        assert!(other.is_file(), "only app-*.log is ours to delete");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_bare_level_raises_this_crate_and_pins_the_rest_at_info() {
        assert_eq!(config_directives("debug"), "pinkcode=debug,info");
        assert_eq!(config_directives(" trace "), "pinkcode=trace,info");
        // A directive is the operator's own words — passed through untouched.
        assert_eq!(
            config_directives("pinkcode=trace,grok_agent=debug"),
            "pinkcode=trace,grok_agent=debug"
        );
    }

    /// The reason the file layer may share the resolved level: `acp::gateway`
    /// pipes every line of `grok`'s stderr through
    /// `tracing::debug!(target: "grok_agent", …)`, so turning the log up must
    /// not put a teammate's whole agent session on disk. Asserted against a
    /// real subscriber rather than the directive string, because the string is
    /// only evidence if `EnvFilter` reads it the way the comment claims.
    #[test]
    fn turning_the_log_up_does_not_put_the_agents_stderr_on_disk() {
        use tracing_subscriber::layer::SubscriberExt;
        use tracing_subscriber::EnvFilter;

        let dir = temp_dir();
        let path = dir.join(log_file_name(0, std::process::id()));
        let subscriber = tracing_subscriber::registry()
            .with(EnvFilter::new(config_directives("debug")))
            .with(
                tracing_subscriber::fmt::layer()
                    .with_target(true)
                    .with_ansi(false)
                    .with_writer(AppendFile(Arc::new(path.clone()))),
            );

        tracing::subscriber::with_default(subscriber, || {
            tracing::debug!(target: "grok_agent", "a line of the agent's stderr");
            tracing::warn!("a host warning");
        });

        let written = fs::read_to_string(&path).expect("the layer wrote a file");
        assert!(written.contains("a host warning"), "{written}");
        assert!(
            !written.contains("a line of the agent's stderr"),
            "the agent's stderr must not reach our disk: {written}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_is_empty_layer() {
        let dir = temp_dir();
        let loaded = load_layer_file(&dir.join("config.json")).expect("load");
        assert!(loaded.log_level.is_none());
        assert!(loaded.default_permission_mode.is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
