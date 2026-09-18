use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Manager;

static SAVE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RolePreference {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreferences {
    #[serde(default)]
    pub organizations: HashMap<String, HashMap<String, RolePreference>>,
    #[serde(default)]
    pub projects: HashMap<String, HashMap<String, RolePreference>>,
    #[serde(default)]
    pub ticket_sources: TicketSources,
    #[serde(default)]
    pub integrations: Integrations,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct TicketSources {
    #[serde(default)]
    pub organizations: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub projects: HashMap<String, Vec<String>>,
}

/// What a person told Berdloop about one ticket provider. The access token is
/// not here: it lives in `integration_secrets`, in a file only its owner can
/// read. `connected` is the status the host writes once a token was saved.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Integration {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jira_site: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jira_email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asana_workspace: Option<String>,
    #[serde(default)]
    pub connected: bool,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Integrations {
    #[serde(default)]
    pub organizations: HashMap<String, HashMap<String, Integration>>,
    #[serde(default)]
    pub projects: HashMap<String, HashMap<String, Integration>>,
}

impl AgentPreferences {
    pub fn resolve(
        &self,
        organization_id: &str,
        project_id: &str,
        role: &str,
    ) -> Option<RolePreference> {
        let organization = self
            .organizations
            .get(organization_id)
            .and_then(|roles| roles.get(role));
        let project = self
            .projects
            .get(project_id)
            .and_then(|roles| roles.get(role));
        if organization.is_none() && project.is_none() {
            return None;
        }
        let choice = project
            .filter(|p| p.harness.is_some() || p.model.is_some())
            .or(organization);
        Some(RolePreference {
            harness: Some(
                choice
                    .and_then(|p| p.harness.clone())
                    .unwrap_or_else(|| "claude-code".into()),
            ),
            model: choice.and_then(|p| p.model.clone()),
            system_prompt: project
                .and_then(|p| p.system_prompt.clone())
                .or_else(|| organization.and_then(|p| p.system_prompt.clone())),
        })
    }

    /// The project's connection when the project has one for this provider,
    /// and the organization's otherwise. The same rule `resolve` follows.
    pub fn resolve_integration(
        &self,
        organization_id: &str,
        project_id: &str,
        provider: &str,
    ) -> Option<Integration> {
        self.integrations
            .projects
            .get(project_id)
            .and_then(|providers| providers.get(provider))
            .or_else(|| {
                self.integrations
                    .organizations
                    .get(organization_id)
                    .and_then(|providers| providers.get(provider))
            })
            .cloned()
    }
}

fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("agent-preferences.v1.json"))
        .map_err(|_| "Could not find the app data directory.".to_string())
}

pub fn read(app: &tauri::AppHandle) -> Result<AgentPreferences, String> {
    let path = path(app)?;
    if !path.exists() {
        return Ok(AgentPreferences::default());
    }
    let bytes = fs::read(path).map_err(|_| "Could not read agent preferences.".to_string())?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "Agent preferences contain invalid JSON.".to_string())
}

#[tauri::command]
pub fn load_agent_preferences(app: tauri::AppHandle) -> Result<AgentPreferences, String> {
    read(&app)
}

#[tauri::command]
pub fn save_agent_preferences(
    app: tauri::AppHandle,
    preferences: AgentPreferences,
) -> Result<(), String> {
    let _guard = SAVE_LOCK
        .lock()
        .map_err(|_| "Agent preferences are locked.".to_string())?;
    let bytes = serde_json::to_vec(&preferences)
        .map_err(|_| "Could not encode agent preferences.".to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("Agent preferences are too large.".to_string());
    }
    let path = path(&app)?;
    fs::create_dir_all(path.parent().ok_or("Invalid app data path.")?)
        .map_err(|_| "Could not create the app data directory.".to_string())?;
    let temporary = path.with_extension("json.tmp");
    let mut file = fs::File::create(&temporary)
        .map_err(|_| "Could not open agent preferences.".to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Could not write agent preferences.".to_string())?;
    fs::rename(temporary, path).map_err(|_| "Could not save agent preferences.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_preferences_load_without_a_harness() {
        let choice: RolePreference =
            serde_json::from_str(r#"{"model":"sonnet","systemPrompt":""}"#).unwrap();
        assert!(choice.harness.is_none());
        assert_eq!(choice.model.as_deref(), Some("sonnet"));
    }

    #[test]
    fn ticket_sources_and_prompts_round_trip() {
        let mut settings = AgentPreferences::default();
        settings
            .ticket_sources
            .organizations
            .insert("org".into(), vec!["Linear".into()]);
        settings
            .organizations
            .entry("org".into())
            .or_default()
            .insert(
                "ticket-agent".into(),
                RolePreference {
                    harness: Some("codex".into()),
                    model: Some("opus".into()),
                    system_prompt: Some("Plan small tasks".into()),
                },
            );
        let json = serde_json::to_value(&settings).unwrap();
        assert!(json.get("ticketSources").is_some());
        let restored: AgentPreferences = serde_json::from_value(json).unwrap();
        assert_eq!(restored.ticket_sources.organizations["org"], ["Linear"]);
        assert_eq!(
            restored
                .resolve("org", "", "ticket-agent")
                .unwrap()
                .harness
                .as_deref(),
            Some("codex")
        );
        assert_eq!(
            restored
                .resolve("org", "", "ticket-agent")
                .unwrap()
                .system_prompt
                .as_deref(),
            Some("Plan small tasks")
        );
    }

    #[test]
    fn project_inherits_model_choice_independently_of_prompt_and_can_restore_defaults() {
        let mut settings: AgentPreferences = serde_json::from_value(serde_json::json!({
            "organizations": { "org": { "worker": { "harness": "codex", "model": "org-model", "systemPrompt": "Org rules" } } },
            "projects": { "project": { "worker": { "systemPrompt": "Project rules" } } }
        })).unwrap();
        let inherited = settings.resolve("org", "project", "worker").unwrap();
        assert_eq!(inherited.harness.as_deref(), Some("codex"));
        assert_eq!(inherited.model.as_deref(), Some("org-model"));
        assert_eq!(inherited.system_prompt.as_deref(), Some("Project rules"));
        let project = settings
            .projects
            .get_mut("project")
            .unwrap()
            .get_mut("worker")
            .unwrap();
        project.harness = Some("claude-code".into());
        project.model = Some(String::new());
        let overridden = settings.resolve("org", "project", "worker").unwrap();
        assert_eq!(overridden.harness.as_deref(), Some("claude-code"));
        assert_eq!(overridden.model.as_deref(), Some(""));
        let project = settings
            .projects
            .get_mut("project")
            .unwrap()
            .get_mut("worker")
            .unwrap();
        project.harness = None;
        project.model = None;
        settings
            .organizations
            .get_mut("org")
            .unwrap()
            .get_mut("worker")
            .unwrap()
            .model = Some("new-model".into());
        let restored: AgentPreferences =
            serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
        assert_eq!(
            restored
                .resolve("org", "project", "worker")
                .unwrap()
                .model
                .as_deref(),
            Some("new-model")
        );
        assert!(
            serde_json::to_value(&restored).unwrap()["projects"]["project"]["worker"]
                .get("model")
                .is_none()
        );
    }

    #[test]
    fn project_role_overrides_organization_role() {
        let mut settings = AgentPreferences::default();
        settings
            .organizations
            .entry("org".into())
            .or_default()
            .insert(
                "worker".into(),
                RolePreference {
                    harness: Some("codex".into()),
                    model: Some("org-model".into()),
                    system_prompt: Some(String::new()),
                },
            );
        settings
            .projects
            .entry("project".into())
            .or_default()
            .insert(
                "worker".into(),
                RolePreference {
                    harness: Some("codex".into()),
                    model: Some("project-model".into()),
                    system_prompt: Some(String::new()),
                },
            );
        assert_eq!(
            settings
                .resolve("org", "project", "worker")
                .unwrap()
                .model
                .as_deref(),
            Some("project-model")
        );
        assert_eq!(
            settings
                .resolve("org", "other", "worker")
                .unwrap()
                .model
                .as_deref(),
            Some("org-model")
        );
    }

    fn connection(site: &str) -> Integration {
        Integration {
            jira_site: Some(site.into()),
            jira_email: Some("person@example.com".into()),
            asana_workspace: None,
            connected: true,
        }
    }

    #[test]
    fn a_project_integration_overrides_the_organization_one() {
        let mut settings = AgentPreferences::default();
        settings
            .integrations
            .organizations
            .entry("org".into())
            .or_default()
            .insert("Jira".into(), connection("https://org.atlassian.net"));
        settings
            .integrations
            .projects
            .entry("project".into())
            .or_default()
            .insert("Jira".into(), connection("https://project.atlassian.net"));
        assert_eq!(
            settings
                .resolve_integration("org", "project", "Jira")
                .unwrap()
                .jira_site
                .unwrap(),
            "https://project.atlassian.net"
        );
        assert_eq!(
            settings
                .resolve_integration("org", "other", "Jira")
                .unwrap()
                .jira_site
                .unwrap(),
            "https://org.atlassian.net"
        );
        assert!(settings
            .resolve_integration("org", "project", "Linear")
            .is_none());
    }

    #[test]
    fn preferences_written_before_integrations_existed_still_load() {
        let json = r#"{
            "organizations": {},
            "projects": {},
            "ticketSources": { "organizations": {}, "projects": {} }
        }"#;
        let restored: AgentPreferences = serde_json::from_str(json).unwrap();
        assert!(restored.integrations.organizations.is_empty());
        assert!(restored
            .resolve_integration("org", "project", "Jira")
            .is_none());
    }

    #[test]
    fn an_integration_round_trips_without_carrying_a_token() {
        let mut settings = AgentPreferences::default();
        settings
            .integrations
            .organizations
            .entry("org".into())
            .or_default()
            .insert(
                "Asana".into(),
                Integration {
                    asana_workspace: Some("1234".into()),
                    connected: true,
                    ..Integration::default()
                },
            );
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"asanaWorkspace\":\"1234\""));
        assert!(!json.contains("token"));
        let restored: AgentPreferences = serde_json::from_str(&json).unwrap();
        assert_eq!(
            restored.resolve_integration("org", "", "Asana").unwrap(),
            Integration {
                asana_workspace: Some("1234".into()),
                connected: true,
                ..Integration::default()
            }
        );
    }
}
