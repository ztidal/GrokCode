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

use crate::agent_types::PermissionMode;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

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

/// Initialize tracing from layered config. Safe to call once at startup.
///
/// `RUST_LOG` (if set) wins over config `log_level` for the EnvFilter.
pub fn init_tracing() {
    use tracing_subscriber::EnvFilter;

    let cfg = resolve();
    let filter = match EnvFilter::try_from_default_env() {
        Ok(f) => f,
        Err(_) => {
            // Config may be a bare level ("info") or a full directive ("pinkcode=debug").
            let directive = cfg.log_level.trim();
            let filter_str = if directive.contains('=') || directive.contains(',') {
                directive.to_string()
            } else {
                format!("pinkcode={directive},info")
            };
            EnvFilter::try_new(&filter_str).unwrap_or_else(|_| EnvFilter::new("info"))
        }
    };

    let result = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_writer(std::io::stderr)
        .try_init();

    if let Err(error) = result {
        // Already initialized (tests / double run) — not fatal.
        eprintln!("[ztidalcode] tracing init skipped: {error}");
    } else {
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

    #[test]
    fn missing_file_is_empty_layer() {
        let dir = temp_dir();
        let loaded = load_layer_file(&dir.join("config.json")).expect("load");
        assert!(loaded.log_level.is_none());
        assert!(loaded.default_permission_mode.is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
