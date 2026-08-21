//! Type-safe ACP / x.ai JSON-RPC request and response payloads.
//!
//! Wire encoding stays JSON; call sites construct these structs instead of
//! hand-built `serde_json::Value` maps.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Identity string Grok Build uses for Desktop-hosted clients.
pub const CLIENT_IDENTIFIER: &str = "grok-desktop";

// ── Shared fragments ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsCapabilities {
    pub read_text_file: bool,
    pub write_text_file: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkTrackerMeta {
    pub mode: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClientCapabilitiesMeta {
    #[serde(rename = "x.ai/incrementalBashOutput")]
    pub incremental_bash_output: bool,
    #[serde(rename = "x.ai/bashOutputNoColor")]
    pub bash_output_no_color: bool,
    #[serde(rename = "x.ai/hunkTracker")]
    pub hunk_tracker: HunkTrackerMeta,
    #[serde(rename = "x.ai/fs_notify")]
    pub fs_notify: bool,
    #[serde(rename = "x.ai/gitHeadChanged")]
    pub git_head_changed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    pub fs: FsCapabilities,
    pub terminal: bool,
    pub meta: ClientCapabilitiesMeta,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientIdentifierMeta {
    pub client_identifier: String,
}

// ── initialize ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: u32,
    pub client_info: ClientInfo,
    pub client_capabilities: ClientCapabilities,
    pub meta: ClientIdentifierMeta,
}

impl InitializeParams {
    pub fn pinkcode() -> Self {
        Self {
            protocol_version: 1,
            client_info: ClientInfo {
                name: "pinkcode".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            client_capabilities: ClientCapabilities {
                fs: FsCapabilities {
                    read_text_file: true,
                    write_text_file: true,
                },
                terminal: false,
                meta: ClientCapabilitiesMeta {
                    incremental_bash_output: true,
                    bash_output_no_color: true,
                    hunk_tracker: HunkTrackerMeta {
                        mode: "agent_only".into(),
                    },
                    fs_notify: true,
                    git_head_changed: true,
                },
            },
            meta: ClientIdentifierMeta {
                client_identifier: CLIENT_IDENTIFIER.into(),
            },
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethodInfo {
    pub id: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResultMeta {
    #[serde(default)]
    pub default_auth_method_id: Option<String>,
    /// The agent build that answered the handshake. When grok changes its wire
    /// behaviour under us the first question is which version did it, and until
    /// this was kept the answer existed only in the reply serde had discarded.
    #[serde(default)]
    pub agent_version: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    #[serde(default)]
    pub auth_methods: Vec<AuthMethodInfo>,
    #[serde(default, rename = "_meta")]
    pub meta_underscore: Option<InitializeResultMeta>,
    #[serde(default)]
    pub meta: Option<InitializeResultMeta>,
}

impl InitializeResult {
    /// Grok answers under `_meta`; the bare spelling is read too because the
    /// same handshake already mixes both conventions elsewhere.
    fn meta_either(&self) -> Option<&InitializeResultMeta> {
        self.meta_underscore.as_ref().or(self.meta.as_ref())
    }

    pub fn default_auth_method_id(&self) -> Option<&str> {
        self.meta_either()
            .and_then(|m| m.default_auth_method_id.as_deref())
    }

    pub fn agent_version(&self) -> Option<&str> {
        self.meta_either().and_then(|m| m.agent_version.as_deref())
    }

    pub fn agent_id(&self) -> Option<&str> {
        self.meta_either().and_then(|m| m.agent_id.as_deref())
    }

    pub fn has_auth_method(&self, id: &str) -> bool {
        self.auth_methods.iter().any(|m| m.id == id)
    }
}

/// The handshake reply as one log line, with `authMethods` reduced to its ids.
///
/// The reply is the only statement grok makes about what it can do, and
/// `InitializeResult` models a handful of its fields — serde drops the rest
/// before anything can look at them. It has already diverged from what we model
/// once: capability keys arrive bare (`x.ai/fs_notify`) while the same methods
/// only answer underscored, which cost a long session to find because the reply
/// itself was gone by the time anyone asked. Logging it verbatim makes the next
/// divergence a grep instead of a re-run. Measured at 1.0.5 the line is ~3.5 KB
/// and `_meta` alone carries seventeen keys, of which this type reads three.
///
/// Names are not tokens: at 1.0.5 an entry is `{id, name, description}` and the
/// nearest thing to a secret is the description `"Cached token from
/// ~/.grok/auth.json"` — a path to the credential store, not its contents.
/// `_meta` on an entry is still a free-form bag, though, so only the ids are
/// kept: which methods were offered is the diagnostic part, and anything grok
/// starts attaching to one cannot reach a log file by surprise.
/// Field names that carry a credential wherever they appear.
///
/// The handshake has a slot for `mcpServers`, and an MCP server definition
/// carries an `env` map — which is where a teammate's GitHub or Linear token
/// lives. A log this line goes to is a file on disk that someone will attach to
/// a bug report, so the reduction has to hold for values nobody has looked at
/// yet, not only for the ones measured today.
const REDACTED_KEYS: &[&str] = &[
    "env",
    "headers",
    "token",
    "apiKey",
    "api_key",
    "authorization",
    "password",
    "secret",
];

fn redact_credentials(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if REDACTED_KEYS.iter().any(|k| k.eq_ignore_ascii_case(key)) {
                    *child = Value::String("<redacted>".into());
                } else {
                    redact_credentials(child);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_credentials),
        _ => {}
    }
}

pub fn initialize_reply_log_line(raw: &Value) -> String {
    let mut body = raw.clone();
    if let Some(methods) = body.get_mut("authMethods") {
        if let Some(ids) = methods.as_array().map(|list| {
            list.iter()
                .map(|m| m.get("id").cloned().unwrap_or(Value::Null))
                .collect()
        }) {
            *methods = Value::Array(ids);
        }
    }
    redact_credentials(&mut body);
    // Compact, and serde escapes any newline inside a string value.
    body.to_string()
}

#[cfg(test)]
mod handshake_contract_tests {

    /// The handshake has a slot for `mcpServers`, and an MCP server definition
    /// carries the `env` map a teammate's API tokens live in. The log line goes
    /// to a file people attach to bug reports.
    #[test]
    fn a_token_in_the_handshake_never_reaches_the_log() {
        let reply = json!({
            "_meta": {
                "mcpServers": [{
                    "name": "github",
                    "command": "npx",
                    "env": { "GITHUB_TOKEN": "ghp_thisMustNotBeLogged" }
                }]
            }
        });
        let line = initialize_reply_log_line(&reply);
        assert!(
            !line.contains("ghp_thisMustNotBeLogged"),
            "credential reached the log: {line}"
        );
        // Still worth logging: the server is named, so the shape stays legible.
        assert!(
            line.contains("github"),
            "reduction lost the diagnostic: {line}"
        );
    }
    use super::{initialize_reply_log_line, InitializeResult};
    use serde_json::json;

    /// The reply measured against agentVersion 1.0.5, trimmed to the parts this
    /// client reads plus a few it does not — the second half is the point.
    fn measured_reply() -> serde_json::Value {
        json!({
            "authMethods": [
                {
                    "id": "grok.com",
                    "name": "Grok",
                    "_meta": { "someFutureToken": "must-not-be-logged" }
                },
                { "id": "cached_token", "name": "Cached token" }
            ],
            "agentCapabilities": {
                "loadSession": true,
                "_meta": { "x.ai/fs_notify": true }
            },
            "_meta": {
                "defaultAuthMethodId": "cached_token",
                "agentVersion": "1.0.5",
                "agentId": "grok-build",
                "hostname": "desk-01",
                "modelState": { "currentModelId": "grok-4.6" }
            }
        })
    }

    #[test]
    fn handshake_keeps_the_agent_build_that_answered() {
        let parsed: InitializeResult =
            serde_json::from_value(measured_reply()).expect("handshake should deserialize");
        assert_eq!(parsed.agent_version(), Some("1.0.5"));
        assert_eq!(parsed.agent_id(), Some("grok-build"));
        // Additive: the two fields that were already read still resolve.
        assert_eq!(parsed.default_auth_method_id(), Some("cached_token"));
        assert!(parsed.has_auth_method("grok.com"));
    }

    /// A reply from an agent that publishes neither must still parse — the
    /// version is a diagnostic, never a gate.
    #[test]
    fn handshake_without_version_still_parses() {
        let parsed: InitializeResult = serde_json::from_value(json!({
            "authMethods": [{ "id": "cached_token" }]
        }))
        .expect("bare handshake should deserialize");
        assert_eq!(parsed.agent_version(), None);
        assert_eq!(parsed.agent_id(), None);
    }

    #[test]
    fn handshake_log_line_is_one_line_and_carries_no_auth_material() {
        let line = initialize_reply_log_line(&measured_reply());
        assert!(!line.contains('\n'), "must stay one line: {line}");
        assert!(
            !line.contains("must-not-be-logged"),
            "authMethods must not reach a log file: {line}"
        );
        assert!(line.contains(r#""authMethods":["grok.com","cached_token"]"#));
        // The reason the line exists: keys this client does not model survive it.
        assert!(line.contains("x.ai/fs_notify"));
        assert!(line.contains(r#""agentVersion":"1.0.5""#));
    }
}

// ── authenticate ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticateParams {
    pub method_id: String,
}

// ── session/new & session/load ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNewParams {
    pub cwd: String,
    pub mcp_servers: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLoadParams {
    pub session_id: String,
    pub cwd: String,
    pub mcp_servers: Vec<Value>,
}

/// One entry in ACP `SessionModelState.availableModels`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcpModelInfo {
    /// Wire field is `modelId` (string id, e.g. `grok-4.6`).
    #[serde(default, alias = "id")]
    pub model_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Grok publishes reasoning capability + options in standard ACP metadata.
    #[serde(default, rename = "_meta")]
    pub meta: Option<Value>,
}

/// ACP `SessionModelState` — used by `session/new`|`load` `models` and by
/// `x.ai/models/update` params. Catalog may be empty right after non-blocking
/// agent startup, then filled via a later models/update notification.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelsInfo {
    #[serde(default)]
    pub current_model_id: Option<String>,
    #[serde(default)]
    pub available_models: Vec<AcpModelInfo>,
}

/// Shared shape for `session/new` and `session/load` results.
///
/// ACP `session/new` returns `sessionId`. `session/load` (Grok
/// `LoadSessionResponse`) often omits it — the client already knows the id —
/// so the field is optional and callers should fall back to the request id.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBootstrapResult {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub models: Option<SessionModelsInfo>,
    #[serde(default, rename = "_meta")]
    pub meta: Option<Value>,
}

impl SessionBootstrapResult {
    pub fn running_prompt_id(&self) -> Option<&str> {
        self.meta
            .as_ref()
            .and_then(|meta| meta.get("x.ai/runningPromptId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
    }

    /// Prefer response `sessionId`; if missing/empty, use `fallback` (load path).
    pub fn resolve_session_id(&self, fallback: Option<&str>) -> Option<String> {
        self.session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| {
                fallback
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            })
    }
}

// ── session/prompt ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTextBlock {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptMeta {
    pub prompt_id: String,
    pub client_identifier: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptParams {
    pub session_id: String,
    pub prompt: Vec<PromptTextBlock>,
    #[serde(rename = "_meta")]
    pub meta: PromptMeta,
}

impl SessionPromptParams {
    pub fn text(
        session_id: impl Into<String>,
        prompt_id: impl Into<String>,
        text: impl Into<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            prompt: vec![PromptTextBlock {
                kind: "text",
                text: text.into(),
            }],
            meta: PromptMeta {
                prompt_id: prompt_id.into(),
                client_identifier: CLIENT_IDENTIFIER.into(),
            },
        }
    }
}

// ── session/set_mode ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSetModeParams {
    pub session_id: String,
    pub mode_id: String,
}

// ── session/cancel ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCancelParams {
    pub session_id: String,
    pub reason: String,
}

// ── session/close ───────────────────────────────────────────────────────────

/// ACP `session/close` — cancel in-flight work, reap children, finalize replica.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCloseParams {
    pub session_id: String,
}

/// `CloseSessionResponse` is empty aside from optional `_meta` (`x.ai/closeOutcome`).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionCloseResult {
    #[serde(default, rename = "_meta")]
    pub meta: Option<Value>,
}

impl SessionCloseResult {
    /// Wire outcome: `closed` | `notResident` | `superseded`.
    pub fn close_outcome(&self) -> Option<&str> {
        self.meta
            .as_ref()
            .and_then(|meta| meta.get("x.ai/closeOutcome"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }
}

// ── x.ai/interject ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterjectParams {
    pub session_id: String,
    pub text: String,
    pub interjection_id: String,
}

// ── queue notifications ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueRemoveParams {
    pub session_id: String,
    pub id: String,
    pub expected_version: u64,
    pub client_identifier: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueReorderParams {
    pub session_id: String,
    pub ordered_ids: Vec<String>,
    pub client_identifier: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueClearParams {
    pub session_id: String,
    pub client_identifier: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEditParams {
    pub session_id: String,
    pub id: String,
    pub new_text: String,
    pub client_identifier: String,
}

// ── session/set_model (ACP standard, not x.ai/*) ────────────────────────────

/// ACP `session/set_model` request. Reasoning effort rides in `_meta.reasoningEffort`
/// (same key Grok pager uses via REASONING_EFFORT_META_KEY).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSessionModelParams {
    pub session_id: String,
    pub model_id: String,
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

impl SetSessionModelParams {
    pub fn new(session_id: impl Into<String>, model_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            model_id: model_id.into(),
            meta: None,
        }
    }

    pub fn with_reasoning_effort(mut self, effort: Option<&str>) -> Self {
        if let Some(effort) = effort.map(str::trim).filter(|s| !s.is_empty()) {
            self.meta = Some(serde_json::json!({ "reasoningEffort": effort }));
        }
        self
    }
}

/// ACP `session/set_model` response is essentially empty (`_meta` only).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SetSessionModelResult {
    #[serde(default, rename = "_meta")]
    pub meta: Option<Value>,
}

// ── x.ai/session/usage ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageParams {
    pub session_id: String,
}

/// Wire totals nested under `usage` (Grok `SessionUsageResponse` / `PromptUsage`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PromptUsageTotals {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cached_read_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
    /// Absent when scrubbed / partial; never treat absence as free.
    #[serde(default)]
    pub cost_usd_ticks: Option<i64>,
    #[serde(default)]
    pub num_turns: u64,
}

/// Wire response: `{ "usage": { ... } }` (bare, no ExtMethodResult envelope).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageWire {
    #[serde(default)]
    pub usage: PromptUsageTotals,
}

/// Flattened shape for the PinkCode UI / Tauri bridge.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageResult {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_read_tokens: u64,
    pub total_tokens: u64,
    /// 0 when cost is scrubbed/partial (UI treats 0 as “no cost label”).
    pub cost_usd_ticks: u64,
    pub turn_count: u64,
}

impl From<SessionUsageWire> for SessionUsageResult {
    fn from(wire: SessionUsageWire) -> Self {
        let u = wire.usage;
        let cost = u.cost_usd_ticks.unwrap_or(0);
        Self {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            cached_read_tokens: u.cached_read_tokens,
            total_tokens: if u.total_tokens > 0 {
                u.total_tokens
            } else {
                u.input_tokens.saturating_add(u.output_tokens)
            },
            // Scrubbed/partial costs stay 0; UI hides the cost chip when 0.
            cost_usd_ticks: cost.clamp(0, i64::MAX) as u64,
            turn_count: u.num_turns,
        }
    }
}

// ── x.ai/recap ──────────────────────────────────────────────────────────────

/// Fire-and-forget: recap text arrives later as `session_recap` notification.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecapParams {
    pub session_id: String,
    #[serde(default)]
    pub auto: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecapResult {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub disabled: bool,
}

// ── x.ai/rewind/points ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindPointsParams {
    pub session_id: String,
}

/// Grok shell serializes rewind DTOs in snake_case (no rename_all).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RewindPoint {
    pub prompt_index: u64,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub num_file_snapshots: u64,
    #[serde(default)]
    pub has_file_changes: bool,
    #[serde(default)]
    pub prompt_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RewindPointsResult {
    #[serde(default)]
    pub rewind_points: Vec<RewindPoint>,
}

// ── x.ai/rewind/execute ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindExecuteParams {
    pub session_id: String,
    pub target_prompt_index: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub force: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RewindExecuteResult {
    #[serde(default)]
    pub success: bool,
    #[serde(default)]
    pub target_prompt_index: u64,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub reverted_files: Vec<String>,
    #[serde(default)]
    pub clean_files: Vec<String>,
    #[serde(default)]
    pub prompt_text: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

// ── x.ai/subagent/cancel ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelSubagentParams {
    /// Optional; pager also sends it, agent only requires subagent_id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub subagent_id: String,
}

/// Payload under ExtMethodResult.result.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CancelSubagentResult {
    #[serde(default)]
    pub subagent_id: Option<String>,
    #[serde(default)]
    pub cancelled: bool,
    /// Tagged outcome (`cancelled` / `already_finished` / `not_found`) or raw JSON.
    #[serde(default)]
    pub outcome: Option<Value>,
}

// ── x.ai/subagent/list_running ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSubagentsParams {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubagentInfo {
    #[serde(default)]
    pub subagent_id: Option<String>,
    #[serde(default)]
    pub child_session_id: Option<String>,
    #[serde(default)]
    pub parent_session_id: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub subagent_type: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub activity_label: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub tool_call_count: Option<u32>,
    #[serde(default)]
    pub turn_count: Option<u32>,
    #[serde(default)]
    pub tokens_used: Option<u64>,
    #[serde(default)]
    pub tools_used: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListSubagentsResult {
    #[serde(default)]
    pub subagents: Vec<SubagentInfo>,
}

// ── x.ai/task/kill ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillTaskParams {
    pub session_id: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KillTaskResult {
    #[serde(default)]
    pub task_id: Option<String>,
    /// `killed` | `already_exited` | `not_found` (string) or raw.
    #[serde(default)]
    pub outcome: Option<Value>,
}

// ── x.ai/task/list ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTasksParams {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BgTaskInfo {
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub display_command: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub completed: Option<bool>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub signal: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListTasksResult {
    #[serde(default)]
    pub tasks: Vec<BgTaskInfo>,
}

/// Grok shell wraps many ext methods as `{ "result": T, "error"?: ... }`.
#[derive(Debug, Clone, Deserialize)]
pub struct ExtMethodEnvelope<T> {
    pub result: Option<T>,
    #[serde(default)]
    pub error: Option<Value>,
}

impl<T> ExtMethodEnvelope<T> {
    pub fn into_result(self) -> std::result::Result<T, String> {
        if let Some(err) = self.error {
            if !err.is_null() {
                let msg = err
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| err.to_string());
                return Err(msg);
            }
        }
        self.result
            .ok_or_else(|| "ext method response missing result".into())
    }
}

#[cfg(test)]
mod lifecycle_contract_tests {
    use super::{ListSubagentsResult, ListTasksResult};

    #[test]
    fn subagent_list_preserves_camel_case_topology_and_metrics() {
        let parsed: ListSubagentsResult = serde_json::from_value(serde_json::json!({
            "subagents": [{
                "subagentId": "sa-1",
                "parentSessionId": "parent",
                "childSessionId": "child",
                "description": "scan",
                "subagentType": "explore",
                "durationMs": 1200,
                "toolCallCount": 3,
                "turnCount": 2,
                "tokensUsed": 400,
                "toolsUsed": ["read_file"]
            }]
        }))
        .expect("subagent snapshot should deserialize");
        let value = serde_json::to_value(parsed).expect("subagent snapshot should serialize");
        assert_eq!(value["subagents"][0]["parentSessionId"], "parent");
        assert_eq!(value["subagents"][0]["toolCallCount"], 3);
    }

    #[test]
    fn task_list_preserves_upstream_snake_case_snapshot_fields() {
        let parsed: ListTasksResult = serde_json::from_value(serde_json::json!({
            "tasks": [{
                "task_id": "task-1",
                "command": "wrapped",
                "display_command": "npm test",
                "cwd": "D:/code/PinkCode",
                "completed": false,
                "kind": "bash",
                "exit_code": null,
                "signal": null,
                "description": "tests"
            }]
        }))
        .expect("task snapshot should deserialize");
        let value = serde_json::to_value(parsed).expect("task snapshot should serialize");
        assert_eq!(value["tasks"][0]["task_id"], "task-1");
        assert_eq!(value["tasks"][0]["display_command"], "npm test");
        assert_eq!(value["tasks"][0]["completed"], false);
    }
}

// ── x.ai/yolo_mode_changed ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct YoloModeChangedParams {
    pub yolo_mode: bool,
    pub auto_mode: bool,
    pub permission_mode: &'static str,
}

// ── JSON-RPC envelopes (internal wire helpers) ──────────────────────────────

#[derive(Debug, Serialize)]
pub struct JsonRpcNotification<'a, P: Serialize> {
    pub jsonrpc: &'static str,
    /// Borrowed, not `'static`: a private extension's wire name is computed
    /// from the bare one at the call site rather than written out twice.
    pub method: &'a str,
    pub params: P,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcResultResponse<R: Serialize> {
    pub jsonrpc: &'static str,
    pub id: Value,
    pub result: R,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcErrorBody {
    pub code: i64,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcErrorResponse {
    pub jsonrpc: &'static str,
    pub id: Value,
    pub error: JsonRpcErrorBody,
}
