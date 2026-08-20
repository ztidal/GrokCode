//! Project-group index: Grok sessions rolled up by the folder they ran in.
//!
//! Sessions live at `~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/`, so the
//! group directory name already *is* the project key — nothing has to be opened
//! to know which project a session belongs to. Keying on `summary.json`'s
//! `info.cwd` instead would make a roll-up cost one JSON parse per session.
//!
//! The directory walk below is a deliberate copy of the one in `sessions.rs`
//! rather than a shared helper. `sessions.rs` is upstream-owned and churns; a
//! self-contained module survives merges untouched (ADR-0001).

use crate::models::SessionCard;
use crate::sessions;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Default page size for `list_project_group_sessions`.
const DEFAULT_PAGE: usize = 50;

/// One project folder, with everything a sidebar row needs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGroup {
    /// Normalized folder path. Stable id to hand back to
    /// `list_project_group_sessions`; not meant to be displayed.
    pub key: String,
    /// Folder basename, widened with parent segments when two groups share one.
    pub label: String,
    /// The cwd as Grok recorded it — original case and separators.
    pub path: String,
    /// Sessions the Tasks board would show here. Never zero: a group with no
    /// visible sessions is dropped rather than rendered as an empty project.
    pub session_count: usize,
    /// Newest `summary.json` mtime in the group, epoch milliseconds.
    pub last_activity_ms: u64,
    /// False once the project folder itself has been moved or deleted.
    pub exists: bool,
}

/// Project groups, most recently active first.
pub fn project_groups() -> std::io::Result<Vec<ProjectGroup>> {
    let scanned = scan_groups(None)?;

    // HashMap order is not stable across runs and labels are assigned relative to
    // each other, so fix an order before anything depends on it.
    let mut keys: Vec<String> = scanned.keys().cloned().collect();
    keys.sort();

    let paths: Vec<String> = keys.iter().map(|key| scanned[key].path.clone()).collect();
    let labels = disambiguate_labels(&paths);

    let mut groups: Vec<ProjectGroup> = keys
        .into_iter()
        .zip(paths)
        .zip(labels)
        .map(|((key, path), label)| {
            let sessions = &scanned[&key].sessions;
            ProjectGroup {
                exists: Path::new(&path).is_dir(),
                session_count: sessions.len(),
                last_activity_ms: sessions
                    .iter()
                    .map(|session| epoch_ms(session.modified))
                    .max()
                    .unwrap_or(0),
                key,
                label,
                path,
            }
        })
        .collect();

    groups.sort_by(|a, b| {
        b.last_activity_ms
            .cmp(&a.last_activity_ms)
            .then_with(|| a.key.cmp(&b.key))
    });
    Ok(groups)
}

/// Session cards for one project, newest first.
///
/// Paging here rather than over the global list is the whole point: a page costs
/// this group's `summary.json` files plus card construction for the page itself,
/// where `sessions::list_sessions` builds every card in the tree to return the
/// same slice.
pub fn group_sessions(key: &str, offset: usize, limit: usize) -> std::io::Result<Vec<SessionCard>> {
    // Normalize, so the UI may pass either a group key or a raw cwd.
    let key = group_key(key);
    let Some(group) = scan_groups(Some(&key))?.remove(&key) else {
        return Ok(Vec::new());
    };

    let mut sessions_in_group = group.sessions;
    sessions_in_group.sort_by_key(|session| std::cmp::Reverse(session.modified));

    let mut cards = Vec::new();
    for session in sessions_in_group.into_iter().skip(offset) {
        if cards.len() >= limit {
            break;
        }
        // A session that vanished mid-scan is skipped, not fatal — same tolerance
        // the board's own listing has.
        let Ok(card) = sessions::get_session_card(&session.id) else {
            continue;
        };
        if crate::session_noise::is_noise_session(&card) {
            continue;
        }
        cards.push(card);
    }
    Ok(cards)
}

#[tauri::command]
pub async fn list_project_groups() -> Result<Vec<ProjectGroup>, String> {
    tauri::async_runtime::spawn_blocking(project_groups)
        .await
        .map_err(|e| format!("project group scan task failed: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_project_group_sessions(
    key: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Vec<SessionCard>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        group_sessions(&key, offset.unwrap_or(0), limit.unwrap_or(DEFAULT_PAGE))
    })
    .await
    .map_err(|e| format!("project group session task failed: {e}"))?
    .map_err(|e| e.to_string())
}

/// A session directory the Tasks board would show.
struct VisibleSession {
    id: String,
    modified: SystemTime,
}

struct GroupAccum {
    /// First spelling seen for this key — two encoded directory names can
    /// normalize to one group (e.g. with and without a trailing separator).
    path: String,
    sessions: Vec<VisibleSession>,
}

/// Walk `~/.grok/sessions`, optionally stopping at a single group key.
///
/// Groups with no visible session are dropped: they are directories left behind
/// by subagent-only or pruned work, and a project row with nothing to click is
/// worse than no row.
fn scan_groups(only: Option<&str>) -> std::io::Result<HashMap<String, GroupAccum>> {
    let root = sessions::sessions_root();
    let mut groups: HashMap<String, GroupAccum> = HashMap::new();
    if !root.is_dir() {
        return Ok(groups);
    }

    for group in fs::read_dir(&root)? {
        let Ok(group) = group else {
            continue;
        };
        if !group.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let encoded_name = group.file_name().to_string_lossy().into_owned();
        if encoded_name.starts_with('.') {
            continue;
        }
        let cwd = group_cwd(&group.path(), &encoded_name);
        let key = group_key(&cwd);
        if key.is_empty() || only.is_some_and(|wanted| wanted != key) {
            continue;
        }
        let in_system_temp = crate::session_noise::is_system_temp_cwd(&cwd);
        let accum = groups.entry(key).or_insert_with(move || GroupAccum {
            path: cwd,
            sessions: Vec::new(),
        });
        collect_visible_sessions(&group.path(), in_system_temp, &mut accum.sessions);
    }

    groups.retain(|_, accum| !accum.sessions.is_empty());
    Ok(groups)
}

/// The project folder a group directory stands for.
///
/// Mirrors `sessions.rs`: the url-encoded directory name, unless the group
/// carries a `.cwd` override file. That read is per *group*, not per session, and
/// skipping it would key a group differently from the `cwd` its own session cards
/// report — which is the one thing that would break grouping in the UI.
fn group_cwd(dir: &Path, encoded_name: &str) -> String {
    if let Ok(raw) = fs::read_to_string(dir.join(".cwd")) {
        let cwd = raw.trim();
        if !cwd.is_empty() {
            return cwd.to_string();
        }
    }
    urlencoding::decode(encoded_name)
        .map(|decoded| decoded.into_owned())
        .unwrap_or_else(|_| encoded_name.to_string())
}

/// The identity two sessions must share to land in the same group.
///
/// Today: the normalized folder path, so `D:\000_project` and
/// `D:\000_project\000_tmp` stay two projects even when one is a worktree or
/// submodule of the other. A git-aware mode would fold both onto their common
/// repository root here — this function is the only place that decision has to be
/// made — but it would cost a `git rev-parse` per group, which is exactly the
/// per-group work the directory-name key exists to avoid. Not built.
fn group_key(cwd: &str) -> String {
    normalize_path_key(cwd)
}

/// Normalize a cwd into a comparable key.
///
/// Modelled on `session_noise::normalize_path_key`, plus two things a noise
/// filter does not need: the Windows `\\?\` verbatim prefix is stripped (Grok
/// records it for long paths, and `D:\p` and `\\?\D:\p` are one project), and the
/// case fold applies only where the filesystem is actually case-insensitive.
fn normalize_path_key(path: &str) -> String {
    let trimmed = path.trim();
    let stripped = trimmed.strip_prefix(r"\\?\").unwrap_or(trimmed);
    let unified = stripped.replace('/', "\\");
    fold_case(unified.trim_end_matches('\\'))
}

fn fold_case(value: &str) -> String {
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value.to_string()
    }
}

/// Non-empty path segments, original case preserved for display.
fn path_segments(path: &str) -> Vec<&str> {
    let trimmed = path.trim();
    let stripped = trimmed.strip_prefix(r"\\?\").unwrap_or(trimmed);
    stripped
        .split(['\\', '/'])
        .filter(|segment| !segment.is_empty())
        .collect()
}

/// The last `depth` segments, joined. Empty when there is nothing to name.
fn label_at(segments: &[&str], depth: usize) -> String {
    if segments.is_empty() {
        return String::new();
    }
    let depth = depth.clamp(1, segments.len());
    segments[segments.len() - depth..].join("\\")
}

/// Basename labels, widened with parent segments until no two collide.
///
/// `D:\a\web` and `D:\b\web` become `a\web` and `b\web`. Only colliding groups
/// widen, so the ordinary case stays a bare folder name; groups that stay
/// ambiguous after exhausting their segments (identical paths) simply stop.
fn disambiguate_labels(paths: &[String]) -> Vec<String> {
    let segments: Vec<Vec<&str>> = paths.iter().map(|path| path_segments(path)).collect();
    let mut depths = vec![1usize; paths.len()];

    loop {
        let mut buckets: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, segs) in segments.iter().enumerate() {
            buckets
                .entry(fold_case(&label_at(segs, depths[index])))
                .or_default()
                .push(index);
        }

        let mut widened = false;
        for colliding in buckets.values().filter(|bucket| bucket.len() > 1) {
            for &index in colliding {
                if depths[index] < segments[index].len() {
                    depths[index] += 1;
                    widened = true;
                }
            }
        }
        if !widened {
            break;
        }
    }

    segments
        .iter()
        .enumerate()
        .map(|(index, segs)| {
            let label = label_at(segs, depths[index]);
            if label.is_empty() {
                paths[index].clone()
            } else {
                label
            }
        })
        .collect()
}

/// Session directories in one group that the Tasks board would show.
///
/// Grok writes a `summary.json` per session, subagent runs included — on a
/// working machine 848 of 878 session directories are subagents. A raw directory
/// count would put "663 sessions" beside a project whose board lists 7, so the
/// summary is read and the same hidden test `sessions.rs` applies is applied
/// here. Those files are ~700 bytes; the multi-megabyte `updates.jsonl` beside
/// them is never opened.
fn collect_visible_sessions(group_dir: &Path, in_system_temp: bool, out: &mut Vec<VisibleSession>) {
    let Ok(entries) = fs::read_dir(group_dir) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let summary_path = entry.path().join("summary.json");
        let Ok(metadata) = fs::metadata(&summary_path) else {
            continue;
        };
        let Ok(raw) = fs::read_to_string(&summary_path) else {
            continue;
        };
        let Ok(summary) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if summary_is_hidden(&summary) || !survives_noise_filter(&summary, in_system_temp) {
            continue;
        }
        out.push(VisibleSession {
            id: entry.file_name().to_string_lossy().into_owned(),
            modified: metadata.modified().unwrap_or(UNIX_EPOCH),
        });
    }
}

/// Cheap stand-in for `session_noise::is_noise_session`, which needs a whole
/// card (signals plus a token-usage snapshot over `updates.jsonl`) to decide.
///
/// It only ever fires under the OS temp root, where every session is an ACP
/// probe or a unit test until proven otherwise, so the approximation is confined
/// there: a probe writes no messages. Without it the temp group leads the sidebar
/// with a count of a dozen that the board resolves to nothing — `cargo test`
/// alone adds two per run. `group_sessions` still applies the real filter to the
/// cards it returns, so this only shapes the count and the activity timestamp.
fn survives_noise_filter(summary: &Value, in_system_temp: bool) -> bool {
    !in_system_temp
        || summary
            .get("num_messages")
            .and_then(Value::as_u64)
            .is_some_and(|messages| messages > 0)
}

/// Copy of the `sessions.rs` rule, which is private there. Subagent runs and
/// explicitly hidden sessions never reach the board, so they must not reach a
/// project's count either.
fn summary_is_hidden(summary: &Value) -> bool {
    if let Some(hidden) = summary.get("hidden").and_then(Value::as_bool) {
        return hidden;
    }
    ["sessionKind", "session_kind"]
        .iter()
        .find_map(|key| summary.get(*key).and_then(Value::as_str))
        .is_some_and(|kind| kind.starts_with("subagent"))
}

fn epoch_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(paths: &[&str]) -> Vec<String> {
        let owned: Vec<String> = paths.iter().map(|p| p.to_string()).collect();
        disambiguate_labels(&owned)
    }

    #[test]
    fn separators_are_unified_and_trailing_ones_dropped() {
        let expected = group_key(r"D:\000_project");
        assert_eq!(group_key("D:/000_project"), expected);
        assert_eq!(group_key(r"D:\000_project\"), expected);
        assert_eq!(group_key("D:/000_project/"), expected);
        assert_eq!(group_key(r"  D:\000_project\\  "), expected);
    }

    #[test]
    fn verbatim_prefix_is_stripped() {
        assert_eq!(
            group_key(r"\\?\D:\000_project"),
            group_key(r"D:\000_project")
        );
    }

    #[test]
    fn separator_only_paths_have_no_key() {
        assert!(group_key("").is_empty());
        assert!(group_key("   ").is_empty());
        assert!(group_key(r"\").is_empty());
        assert!(group_key("///").is_empty());
    }

    #[test]
    fn drive_root_keeps_its_drive_letter() {
        assert_eq!(group_key(r"D:\"), group_key("D:"));
        assert_ne!(group_key(r"D:\"), group_key(r"C:\"));
    }

    /// The decision this module is built on: nesting is not merging. A worktree
    /// under a repository is its own project until a git-aware mode says otherwise.
    #[test]
    fn nested_project_folders_stay_separate() {
        assert_ne!(
            group_key(r"D:\000_project"),
            group_key(r"D:\000_project\000_tmp")
        );
        assert_ne!(
            group_key(r"D:\000_project\000_tmp"),
            group_key(r"D:\000_project\000_tmp\PinkCode")
        );
    }

    #[test]
    fn non_ascii_paths_survive_normalization() {
        let key = group_key(r"C:\Users\dev\Downloads\深围井源码\深围井源码\");
        assert!(key.ends_with(r"深围井源码\深围井源码"));
        assert_eq!(
            key,
            group_key(r"C:/Users/dev/Downloads/深围井源码/深围井源码")
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_keys_are_case_insensitive() {
        assert_eq!(group_key(r"D:\000_Project"), group_key(r"d:\000_project"));
    }

    #[cfg(not(windows))]
    #[test]
    fn posix_keys_are_case_sensitive() {
        assert_ne!(
            group_key("/home/dev/Project"),
            group_key("/home/dev/project")
        );
    }

    #[test]
    fn segments_ignore_separator_runs_and_prefixes() {
        assert_eq!(path_segments(r"D:\000_project"), vec!["D:", "000_project"]);
        assert_eq!(path_segments("D:/000_project/"), vec!["D:", "000_project"]);
        assert_eq!(
            path_segments(r"\\?\D:\a\\b"),
            vec!["D:", "a", "b"],
            "verbatim prefix and doubled separators are not segments"
        );
        assert_eq!(
            path_segments(r"\\server\share\proj"),
            vec!["server", "share", "proj"]
        );
        assert!(path_segments(r"\\").is_empty());
    }

    #[test]
    fn distinct_basenames_stay_bare() {
        assert_eq!(
            labels(&[
                r"D:\000_project",
                r"D:\000_project\000_tmp",
                r"C:\WINDOWS\System32"
            ]),
            vec!["000_project", "000_tmp", "System32"]
        );
    }

    #[test]
    fn colliding_basenames_gain_one_parent() {
        assert_eq!(
            labels(&[r"D:\alpha\web", r"D:\beta\web"]),
            vec![r"alpha\web", r"beta\web"]
        );
    }

    #[test]
    fn only_colliding_groups_widen() {
        assert_eq!(
            labels(&[r"D:\alpha\web", r"D:\beta\web", r"D:\000_project"]),
            vec![r"alpha\web", r"beta\web", "000_project"]
        );
    }

    #[test]
    fn widening_repeats_until_unique() {
        // `alpha\web` collides again at depth 2, so both widen a second time while
        // the third keeps the shortest label that already distinguishes it.
        assert_eq!(
            labels(&[r"C:\alpha\web", r"D:\alpha\web", r"D:\beta\web"]),
            vec![r"C:\alpha\web", r"D:\alpha\web", r"beta\web"]
        );
    }

    #[test]
    fn shorter_path_widens_to_its_full_length() {
        // `web` cannot widen past its own root; the deeper one keeps going.
        assert_eq!(
            labels(&[r"web", r"D:\alpha\web"]),
            vec!["web", r"alpha\web"]
        );
    }

    #[test]
    fn identical_paths_terminate_rather_than_widen_forever() {
        assert_eq!(
            labels(&[r"D:\alpha\web", r"D:\alpha\web"]),
            vec![r"D:\alpha\web", r"D:\alpha\web"]
        );
    }

    #[test]
    fn drive_roots_are_labelled_by_their_drive() {
        assert_eq!(labels(&[r"D:\", r"C:\"]), vec!["D:", "C:"]);
    }

    #[test]
    fn unnameable_paths_fall_back_to_the_path() {
        assert_eq!(labels(&[r"\", r"D:\alpha"]), vec![r"\", "alpha"]);
    }

    #[cfg(windows)]
    #[test]
    fn case_only_differences_still_collide_on_windows() {
        // Distinct keys, but a sidebar showing "Web" twice is unreadable.
        assert_eq!(
            labels(&[r"D:\alpha\Web", r"D:\beta\web"]),
            vec![r"alpha\Web", r"beta\web"]
        );
    }

    #[test]
    fn labels_are_independent_of_input_order() {
        let mut forward = labels(&[r"D:\alpha\web", r"D:\beta\web", r"D:\gamma"]);
        let mut reverse = labels(&[r"D:\gamma", r"D:\beta\web", r"D:\alpha\web"]);
        forward.sort();
        reverse.sort();
        assert_eq!(forward, reverse);
    }

    #[test]
    fn hidden_matches_grok_summary_semantics() {
        assert!(summary_is_hidden(&serde_json::json!({"hidden": true})));
        assert!(summary_is_hidden(
            &serde_json::json!({"session_kind": "subagent"})
        ));
        assert!(summary_is_hidden(
            &serde_json::json!({"session_kind": "subagent_resume"})
        ));
        assert!(!summary_is_hidden(
            &serde_json::json!({"hidden": false, "session_kind": "subagent"})
        ));
        assert!(!summary_is_hidden(
            &serde_json::json!({"sessionKind": "interactive"})
        ));
        assert!(!summary_is_hidden(&serde_json::json!({})));
    }

    #[test]
    fn temp_probes_are_counted_only_once_they_have_messages() {
        let probe = serde_json::json!({"num_messages": 0});
        let worked = serde_json::json!({"num_messages": 12});
        assert!(!survives_noise_filter(&probe, true));
        assert!(survives_noise_filter(&worked, true));
        // A real project's quiet session is still a session.
        assert!(survives_noise_filter(&probe, false));
        assert!(survives_noise_filter(&serde_json::json!({}), false));
        // Missing counter under temp is treated as a probe, matching the board.
        assert!(!survives_noise_filter(&serde_json::json!({}), true));
    }

    #[test]
    fn groups_are_sorted_by_most_recent_activity() {
        // Whatever is on this machine, the contract holds: newest first, every
        // group non-empty, and every key normalized.
        let groups = project_groups().expect("scan");
        for pair in groups.windows(2) {
            assert!(pair[0].last_activity_ms >= pair[1].last_activity_ms);
        }
        for group in &groups {
            assert!(group.session_count > 0);
            assert_eq!(group.key, group_key(&group.path));
            assert!(!group.label.is_empty());
        }
    }
}
