//! Agent harness settings, for the whole installation.
//!
//! These sit beside the app rather than inside a project, because they are
//! about how much of this machine an agent may touch. A person decides once.
//!
//! Everything here defaults to off. Agents run with permissions bypassed, so
//! what they are allowed to load is the thing keeping a person safe.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use tauri::Manager;

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessSettings {
    /// "full" (the default) or "workspace" for the tightest sandbox.
    #[serde(default = "full_trust")]
    pub trust: String,
    /// MCP servers, by name, that agents may load.
    #[serde(default)]
    pub mcp_servers: Vec<String>,
    /// Whether the user's own skills may load. All or nothing.
    #[serde(default)]
    pub user_skills: bool,
}

fn full_trust() -> String {
    "full".to_string()
}

impl Default for HarnessSettings {
    fn default() -> Self {
        Self {
            trust: full_trust(),
            mcp_servers: Vec::new(),
            user_skills: false,
        }
    }
}

fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("harness-settings.v1.json"))
        .map_err(|_| "Could not find the app data directory.".to_string())
}

pub fn read(app: &tauri::AppHandle) -> HarnessSettings {
    path(app)
        .ok()
        .filter(|p| p.exists())
        .and_then(|p| fs::read(p).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn load_harness_settings(app: tauri::AppHandle) -> HarnessSettings {
    read(&app)
}

#[tauri::command]
pub fn save_harness_settings(
    app: tauri::AppHandle,
    settings: HarnessSettings,
) -> Result<(), String> {
    if settings.trust != "full" && settings.trust != "workspace" {
        return Err("Trust must be full or workspace.".to_string());
    }
    let path = path(&app)?;
    let parent = path.parent().ok_or("Invalid app data path.")?;
    fs::create_dir_all(parent).map_err(|_| "Could not create app data directory.".to_string())?;
    let bytes =
        serde_json::to_vec(&settings).map_err(|_| "Could not encode settings.".to_string())?;
    let temporary = path.with_extension("json.tmp");
    let mut file =
        fs::File::create(&temporary).map_err(|_| "Could not open settings.".to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Could not write settings.".to_string())?;
    fs::rename(temporary, path).map_err(|_| "Could not save settings.".to_string())
}

/// Write a config holding only the MCP servers that were turned on.
///
/// Returns the file path, or an empty string when none are enabled, in which
/// case `--strict-mcp-config` on its own means "none at all".
#[tauri::command]
pub fn harness_mcp_config(app: tauri::AppHandle) -> Result<String, String> {
    let settings = read(&app);
    if settings.mcp_servers.is_empty() {
        return Ok(String::new());
    }
    let wanted: std::collections::HashSet<&str> =
        settings.mcp_servers.iter().map(String::as_str).collect();

    // Take the definitions from wherever the user already has them, so a
    // person does not have to describe a server twice.
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let mut chosen = serde_json::Map::new();
    for source in [".claude.json", ".claude/settings.json"] {
        let Ok(text) = fs::read_to_string(PathBuf::from(&home).join(source)) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        if let Some(servers) = value.get("mcpServers").and_then(|v| v.as_object()) {
            for (name, entry) in servers {
                if wanted.contains(name.as_str()) {
                    chosen.insert(name.clone(), entry.clone());
                }
            }
        }
    }

    let path = path(&app)?.with_file_name("harness-mcp.v1.json");
    let body = serde_json::json!({ "mcpServers": chosen });
    fs::write(&path, serde_json::to_vec(&body).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_to_trusting_nothing_of_the_users() {
        let settings = HarnessSettings::default();
        assert_eq!(settings.trust, "full");
        assert!(settings.mcp_servers.is_empty());
        assert!(!settings.user_skills);
    }

    #[test]
    fn missing_fields_fall_back_rather_than_failing() {
        // A settings file written by an older version must still load.
        let settings: HarnessSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.trust, "full");
        assert!(!settings.user_skills);
    }

    #[test]
    fn a_saved_choice_reads_back() {
        let json = r#"{"trust":"workspace","mcpServers":["perplexity"],"userSkills":true}"#;
        let settings: HarnessSettings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.trust, "workspace");
        assert_eq!(settings.mcp_servers, ["perplexity"]);
        assert!(settings.user_skills);
    }
}
