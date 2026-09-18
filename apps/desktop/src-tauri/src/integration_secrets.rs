//! Access tokens for the ticket providers.
//!
//! A token is not a preference. It never enters `agent-preferences.v1.json`,
//! which is plain, readable settings a person may copy between machines, and
//! it never comes back out of a command: the window can ask for a token to be
//! saved or cleared, and can see whether one exists, but cannot read it.
//!
//! ```text
//! <app data dir>/integration-secrets.v1.json   mode 0600, owner only
//! ```
//!
//! Keys are `{scope}/{scopeId}/{provider}`, so one organization and one of its
//! projects can hold different tokens for the same provider. A project's token
//! wins when it has one, matching how every other setting resolves.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::Manager;

use crate::agent_preferences;

static SAVE_LOCK: Mutex<()> = Mutex::new(());

const ORGANIZATIONS: &str = "organizations";
const PROJECTS: &str = "projects";
const PROVIDERS: [&str; 3] = ["Linear", "Jira", "Asana"];

/// No message in this module ever carries a token, so a failure can be shown
/// to a person or written to a log without leaking what was being saved.
fn check(scope: &str, scope_id: &str, provider: &str) -> Result<String, String> {
    if scope != ORGANIZATIONS && scope != PROJECTS {
        return Err("Integrations are scoped to an organization or a project.".to_string());
    }
    if scope_id.is_empty() || scope_id.len() > 128 || scope_id.contains('/') {
        return Err("Choose an organization or project to connect.".to_string());
    }
    if !PROVIDERS.contains(&provider) {
        return Err("Unsupported task provider.".to_string());
    }
    Ok(format!("{scope}/{scope_id}/{provider}"))
}

fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("integration-secrets.v1.json"))
        .map_err(|_| "Could not find the app data directory.".to_string())
}

fn read_file(path: &Path) -> Result<HashMap<String, String>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let bytes = fs::read(path).map_err(|_| "Could not read the saved connections.".to_string())?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "The saved connections contain invalid JSON.".to_string())
}

/// The same atomic write `save_agent_preferences` uses, with the owner-only
/// mode set on the temporary file before anything is written to it, so the
/// token is never on disk for a moment where another account could read it.
fn write_file(path: &Path, secrets: &HashMap<String, String>) -> Result<(), String> {
    let bytes = serde_json::to_vec(secrets)
        .map_err(|_| "Could not encode the saved connections.".to_string())?;
    fs::create_dir_all(path.parent().ok_or("Invalid app data path.")?)
        .map_err(|_| "Could not create the app data directory.".to_string())?;
    let temporary = path.with_extension("json.tmp");
    let mut file =
        fs::File::create(&temporary).map_err(|_| "Could not open the connections.".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|_| "Could not restrict the connections to this account.".to_string())?;
    }
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Could not write the connections.".to_string())?;
    fs::rename(temporary, path).map_err(|_| "Could not save the connections.".to_string())
}

fn save_at(
    path: &Path,
    scope: &str,
    scope_id: &str,
    provider: &str,
    token: &str,
) -> Result<(), String> {
    let key = check(scope, scope_id, provider)?;
    let token = token.trim();
    if token.is_empty() || token.len() > 8192 {
        return Err("Enter the access token for this provider.".to_string());
    }
    let _guard = SAVE_LOCK
        .lock()
        .map_err(|_| "The saved connections are locked.".to_string())?;
    let mut secrets = read_file(path)?;
    secrets.insert(key, token.to_string());
    write_file(path, &secrets)
}

fn clear_at(path: &Path, scope: &str, scope_id: &str, provider: &str) -> Result<(), String> {
    let key = check(scope, scope_id, provider)?;
    let _guard = SAVE_LOCK
        .lock()
        .map_err(|_| "The saved connections are locked.".to_string())?;
    let mut secrets = read_file(path)?;
    if secrets.remove(&key).is_none() {
        return Ok(());
    }
    write_file(path, &secrets)
}

fn resolve_at(
    path: &Path,
    organization_id: &str,
    project_id: &str,
    provider: &str,
) -> Option<String> {
    let secrets = read_file(path).ok()?;
    secrets
        .get(&format!("{PROJECTS}/{project_id}/{provider}"))
        .or_else(|| secrets.get(&format!("{ORGANIZATIONS}/{organization_id}/{provider}")))
        .cloned()
}

pub fn save(
    app: &tauri::AppHandle,
    scope: &str,
    scope_id: &str,
    provider: &str,
    token: &str,
) -> Result<(), String> {
    save_at(&path(app)?, scope, scope_id, provider, token)
}

pub fn clear(
    app: &tauri::AppHandle,
    scope: &str,
    scope_id: &str,
    provider: &str,
) -> Result<(), String> {
    clear_at(&path(app)?, scope, scope_id, provider)
}

/// The token to use for this provider here, for the host's own requests. It is
/// never handed to the window.
pub fn resolve(
    app: &tauri::AppHandle,
    organization_id: &str,
    project_id: &str,
    provider: &str,
) -> Option<String> {
    resolve_at(&path(app).ok()?, organization_id, project_id, provider)
}

/// Record in the preferences that this scope now has, or no longer has, a
/// token for this provider. Only the flag is written; the token stays here.
fn mark_connected(
    app: &tauri::AppHandle,
    scope: &str,
    scope_id: &str,
    provider: &str,
    connected: bool,
) -> Result<(), String> {
    let mut preferences = agent_preferences::read(app)?;
    let scoped = if scope == PROJECTS {
        &mut preferences.integrations.projects
    } else {
        &mut preferences.integrations.organizations
    };
    scoped
        .entry(scope_id.to_string())
        .or_default()
        .entry(provider.to_string())
        .or_default()
        .connected = connected;
    agent_preferences::save_agent_preferences(app.clone(), preferences)
}

#[tauri::command]
pub fn save_integration_secret(
    app: tauri::AppHandle,
    scope: String,
    scope_id: String,
    provider: String,
    token: String,
) -> Result<(), String> {
    save(&app, &scope, &scope_id, &provider, &token)?;
    mark_connected(&app, &scope, &scope_id, &provider, true)
}

#[tauri::command]
pub fn clear_integration_secret(
    app: tauri::AppHandle,
    scope: String,
    scope_id: String,
    provider: String,
) -> Result<(), String> {
    clear(&app, &scope, &scope_id, &provider)?;
    mark_connected(&app, &scope, &scope_id, &provider, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn store() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("berdloop-secrets-{n}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir.join("integration-secrets.v1.json")
    }

    #[test]
    #[cfg(unix)]
    fn the_secret_file_is_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let path = store();
        save_at(&path, "organizations", "org", "Linear", "lin_secret").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_project_token_wins_and_the_organization_is_the_fallback() {
        let path = store();
        save_at(&path, "organizations", "org", "Jira", "org-token").unwrap();
        save_at(&path, "projects", "project", "Jira", "project-token").unwrap();
        assert_eq!(
            resolve_at(&path, "org", "project", "Jira").unwrap(),
            "project-token"
        );
        assert_eq!(
            resolve_at(&path, "org", "other", "Jira").unwrap(),
            "org-token"
        );
        assert!(resolve_at(&path, "org", "project", "Asana").is_none());
    }

    #[test]
    fn clearing_one_provider_leaves_the_others_connected() {
        let path = store();
        save_at(&path, "organizations", "org", "Jira", "jira-token").unwrap();
        save_at(&path, "organizations", "org", "Asana", "asana-token").unwrap();
        clear_at(&path, "organizations", "org", "Jira").unwrap();
        assert!(resolve_at(&path, "org", "", "Jira").is_none());
        assert_eq!(
            resolve_at(&path, "org", "", "Asana").unwrap(),
            "asana-token"
        );
        clear_at(&path, "organizations", "org", "Jira").unwrap();
    }

    #[test]
    fn nothing_that_can_be_refused_says_what_the_token_was() {
        let path = store();
        for refusal in [
            save_at(&path, "everyone", "org", "Jira", "secret-token"),
            save_at(&path, "organizations", "", "Jira", "secret-token"),
            save_at(&path, "organizations", "a/b", "Jira", "secret-token"),
            save_at(&path, "organizations", "org", "Trello", "secret-token"),
            save_at(&path, "organizations", "org", "Jira", "   "),
        ] {
            assert!(!refusal.clone().unwrap_err().contains("secret-token"));
            assert!(refusal.is_err());
        }
        assert!(!path.exists());
    }
}
