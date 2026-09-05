//! Session model catalog merge + models/update method matching.

use crate::acp::protocol::SessionModelsInfo;
use crate::agent_types::{AvailableModelInfo, ManagedAgentInfo, ReasoningEffortOption};
use serde_json::Value;

/// Grok may emit `x.ai/models/update` or a leading-underscore ext form.
pub(crate) fn is_models_update_method(method: &str) -> bool {
    matches!(method.trim_start_matches('_'), "x.ai/models/update")
}

/// Effort a newly created session should start on: Extra High when listed.
pub(crate) fn default_new_session_effort(
    catalog: &[AvailableModelInfo],
    model_id: Option<&str>,
) -> Option<String> {
    let id = nonempty(model_id)?;
    let model = catalog.iter().find(|model| model.model_id == id)?;
    if model
        .reasoning_efforts
        .iter()
        .any(|option| option.value == "xhigh")
    {
        return Some("xhigh".into());
    }
    model
        .reasoning_efforts
        .first()
        .map(|option| option.value.clone())
        .filter(|value| !value.is_empty())
}

/// Advertised catalog default for `model_id`, if the entry lists one.
pub(crate) fn advertised_effort_for(
    catalog: &[AvailableModelInfo],
    model_id: Option<&str>,
) -> Option<String> {
    let id = nonempty(model_id)?;
    catalog
        .iter()
        .find(|model| model.model_id == id)
        .and_then(|model| nonempty(model.reasoning_effort.as_deref()).map(str::to_string))
}

/// Merge ACP model state from `session/new`, `session/load`, or reconnect.
///
/// Empty `availableModels` does **not** clear a non-empty catalog (non-blocking
/// startup may emit an empty list first, then a full `x.ai/models/update`).
pub(crate) fn apply_models_info(info: &mut ManagedAgentInfo, models: &SessionModelsInfo) {
    adopt_current_model(info, models);
    let catalog = parse_catalog(models);
    if catalog.is_empty() {
        return;
    }
    if let Some(effort) = advertised_effort_for(&catalog, info.model_id.as_deref()) {
        info.reasoning_effort = Some(effort);
    }
    info.available_models = catalog;
}

/// Apply a live `x.ai/models/update` catalog without changing the session's
/// current model or reasoning effort.
pub(crate) fn apply_catalog_refresh(info: &mut ManagedAgentInfo, models: &SessionModelsInfo) {
    if !has_current_model(info) {
        adopt_current_model(info, models);
    }
    let catalog = parse_catalog(models);
    if catalog.is_empty() {
        return;
    }
    if !has_session_effort(info) {
        if let Some(effort) = advertised_effort_for(&catalog, info.model_id.as_deref()) {
            info.reasoning_effort = Some(effort);
        }
    }
    info.available_models = catalog;
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn has_current_model(info: &ManagedAgentInfo) -> bool {
    nonempty(info.model_id.as_deref()).is_some()
}

fn has_session_effort(info: &ManagedAgentInfo) -> bool {
    nonempty(info.reasoning_effort.as_deref()).is_some()
}

fn adopt_current_model(info: &mut ManagedAgentInfo, models: &SessionModelsInfo) {
    if let Some(id) = nonempty(models.current_model_id.as_deref()) {
        info.model_id = Some(id.to_string());
    }
}

fn parse_catalog(models: &SessionModelsInfo) -> Vec<AvailableModelInfo> {
    models
        .available_models
        .iter()
        .filter_map(|m| {
            let id = m.model_id.trim();
            if id.is_empty() {
                return None;
            }
            let name = nonempty(m.name.as_deref()).map(str::to_string);
            let meta = m.meta.as_ref().and_then(Value::as_object);
            let supports_reasoning_effort = meta
                .and_then(|meta| meta.get("supportsReasoningEffort"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let reasoning_effort = meta
                .and_then(|meta| meta.get("reasoningEffort"))
                .and_then(Value::as_str)
                .and_then(|value| nonempty(Some(value)).map(str::to_string));
            let reasoning_efforts = meta
                .and_then(|meta| meta.get("reasoningEfforts"))
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(|option| {
                            let value = option
                                .as_str()
                                .or_else(|| option.get("value").and_then(Value::as_str))?;
                            let value = nonempty(Some(value))?;
                            let label = option
                                .get("label")
                                .and_then(Value::as_str)
                                .and_then(|label| nonempty(Some(label)))
                                .unwrap_or(value)
                                .to_string();
                            Some(ReasoningEffortOption {
                                value: value.to_string(),
                                label,
                                description: option
                                    .get("description")
                                    .and_then(Value::as_str)
                                    .and_then(|description| nonempty(Some(description)))
                                    .map(str::to_string),
                                default: option
                                    .get("default")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(AvailableModelInfo {
                model_id: id.to_string(),
                name,
                supports_reasoning_effort,
                reasoning_effort,
                reasoning_efforts,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::protocol::AcpModelInfo;
    use crate::agent_types::{ManagedStatus, PermissionMode, ReasoningEffortOption};

    fn sample_agent(model_id: &str, effort: Option<&str>) -> ManagedAgentInfo {
        ManagedAgentInfo {
            handle_id: "h1".into(),
            session_id: Some("s1".into()),
            cwd: "/tmp".into(),
            pid: None,
            status: ManagedStatus::Ready,
            permission_mode: PermissionMode::Default,
            always_approve: false,
            model_id: Some(model_id.into()),
            reasoning_effort: effort.map(str::to_string),
            available_models: vec![AvailableModelInfo {
                model_id: model_id.into(),
                name: Some(format!("Grok {model_id}")),
                supports_reasoning_effort: true,
                reasoning_effort: effort.map(str::to_string),
                reasoning_efforts: vec![],
            }],
            last_error: None,
            title: None,
            created_at: "t".into(),
            pending_permission_count: 0,
        }
    }

    fn grok_46_catalog(advertised_effort: &str) -> SessionModelsInfo {
        SessionModelsInfo {
            current_model_id: Some("grok-4.6".into()),
            available_models: vec![AcpModelInfo {
                model_id: "grok-4.6".into(),
                name: Some("Grok 4.6".into()),
                description: None,
                meta: Some(serde_json::json!({
                    "supportsReasoningEffort": true,
                    "reasoningEffort": advertised_effort,
                    "reasoningEfforts": [
                        { "value": "xhigh", "label": "Extra High Effort" },
                        {
                            "value": "high",
                            "label": "High Effort",
                            "default": true
                        },
                        { "value": "medium", "label": "Medium Effort" },
                        { "value": "low", "label": "Low Effort" }
                    ]
                })),
            }],
        }
    }

    #[test]
    fn models_update_method_matches_prefixed_and_plain() {
        assert!(is_models_update_method("x.ai/models/update"));
        assert!(is_models_update_method("_x.ai/models/update"));
        assert!(!is_models_update_method("session/update"));
        assert!(!is_models_update_method("x.ai/queue/changed"));
        assert!(!is_models_update_method("foo/x.ai/models/update"));
    }

    #[test]
    fn apply_models_info_keeps_catalog_when_update_is_empty() {
        let mut info = sample_agent("grok-4", Some("high"));
        apply_models_info(
            &mut info,
            &SessionModelsInfo {
                current_model_id: Some("grok-4.5".into()),
                available_models: vec![],
            },
        );
        assert_eq!(info.model_id.as_deref(), Some("grok-4.5"));
        assert_eq!(info.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(info.available_models.len(), 1);

        apply_models_info(
            &mut info,
            &SessionModelsInfo {
                current_model_id: Some("grok-4.5".into()),
                available_models: vec![AcpModelInfo {
                    model_id: "grok-4.5".into(),
                    name: Some("Grok 4.5".into()),
                    description: None,
                    meta: Some(serde_json::json!({
                        "supportsReasoningEffort": true,
                        "reasoningEffort": "medium",
                        "reasoningEfforts": [
                            {
                                "value": "medium",
                                "label": "Medium",
                                "description": "Balanced",
                                "default": true
                            },
                            { "value": "low", "label": "Low" },
                            "high"
                        ]
                    })),
                }],
            },
        );
        assert_eq!(info.available_models.len(), 1);
        assert_eq!(info.available_models[0].model_id, "grok-4.5");
        assert_eq!(info.reasoning_effort.as_deref(), Some("medium"));
        assert_eq!(
            info.available_models[0].reasoning_effort.as_deref(),
            Some("medium")
        );
        assert!(info.available_models[0].supports_reasoning_effort);
        assert_eq!(info.available_models[0].reasoning_efforts.len(), 3);
    }

    #[test]
    fn catalog_refresh_keeps_session_model() {
        let mut info = sample_agent("grok-4.5", Some("medium"));
        apply_catalog_refresh(&mut info, &grok_46_catalog("high"));
        assert_eq!(info.model_id.as_deref(), Some("grok-4.5"));
        assert_eq!(info.available_models.len(), 1);
        assert_eq!(info.available_models[0].model_id, "grok-4.6");
    }

    #[test]
    fn catalog_refresh_does_not_clobber_session_xhigh() {
        let mut info = sample_agent("grok-4.6", Some("xhigh"));
        apply_catalog_refresh(&mut info, &grok_46_catalog("high"));
        assert_eq!(info.model_id.as_deref(), Some("grok-4.6"));
        assert_eq!(info.reasoning_effort.as_deref(), Some("xhigh"));
        assert_eq!(info.available_models[0].reasoning_efforts.len(), 4);
    }

    #[test]
    fn catalog_refresh_adopts_current_when_session_has_none() {
        let mut info = sample_agent("grok-4.6", None);
        info.model_id = None;
        info.available_models.clear();
        apply_catalog_refresh(&mut info, &grok_46_catalog("high"));
        assert_eq!(info.model_id.as_deref(), Some("grok-4.6"));
        assert_eq!(info.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn apply_models_info_adopts_snapshot_effort() {
        let mut info = sample_agent("grok-4.6", Some("xhigh"));
        apply_models_info(&mut info, &grok_46_catalog("high"));
        assert_eq!(info.model_id.as_deref(), Some("grok-4.6"));
        assert_eq!(info.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn new_session_effort_is_extra_high_when_listed() {
        let catalog = parse_catalog(&grok_46_catalog("high"));
        assert_eq!(
            default_new_session_effort(&catalog, Some("grok-4.6")).as_deref(),
            Some("xhigh")
        );
    }

    #[test]
    fn new_session_effort_follows_the_list_when_xhigh_is_absent() {
        let mut info = sample_agent("grok-4.5", None);
        info.available_models = vec![AvailableModelInfo {
            model_id: "grok-4.5".into(),
            name: None,
            supports_reasoning_effort: true,
            reasoning_effort: Some("high".into()),
            reasoning_efforts: vec![
                ReasoningEffortOption {
                    value: "high".into(),
                    label: "High Effort".into(),
                    description: None,
                    default: true,
                },
                ReasoningEffortOption {
                    value: "medium".into(),
                    label: "Medium Effort".into(),
                    description: None,
                    default: false,
                },
            ],
        }];
        assert_eq!(
            default_new_session_effort(&info.available_models, Some("grok-4.5")).as_deref(),
            Some("high")
        );
    }
}
