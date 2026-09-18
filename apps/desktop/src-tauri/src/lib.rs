mod agent;
mod agent_preferences;
mod extensions;
pub mod git;
mod harness_settings;
pub mod human;
pub mod mcp;
pub mod merge_queue;
mod projects;
pub mod queues;
mod sessions;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::Write, sync::Mutex, time::Duration};
use tauri::Manager;

#[derive(Serialize)]
struct RuntimeInfo {
    version: &'static str,
    platform: &'static str,
    execution: &'static str,
}

#[tauri::command]
fn runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        execution: "local",
    }
}

struct WorkspaceLock(Mutex<()>);

fn workspace_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("tasks.v1.json"))
        .map_err(|_| "Could not find the app data directory.".to_string())
}

#[tauri::command]
fn load_task_workspace(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let path = workspace_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|_| "Could not read local tasks.".to_string())?;
    let data: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Local tasks contain invalid JSON.".to_string())?;
    if data["schemaVersion"] != 1 {
        return Err("Local tasks use an unsupported version.".to_string());
    }
    Ok(Some(data))
}

#[tauri::command]
fn save_task_workspace(
    app: tauri::AppHandle,
    lock: tauri::State<'_, WorkspaceLock>,
    workspace: Value,
) -> Result<(), String> {
    if workspace["schemaVersion"] != 1
        || !workspace["tasks"].is_array()
        || !workspace["agentTasks"].is_array()
    {
        return Err("Invalid task workspace.".to_string());
    }
    let bytes =
        serde_json::to_vec(&workspace).map_err(|_| "Could not encode local tasks.".to_string())?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("Local task workspace is too large.".to_string());
    }
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Local task store is locked.".to_string())?;
    let path = workspace_path(&app)?;
    let parent = path.parent().ok_or("Invalid app data path.")?;
    fs::create_dir_all(parent).map_err(|_| "Could not create app data directory.".to_string())?;
    let temporary = path.with_extension("json.tmp");
    let mut file =
        fs::File::create(&temporary).map_err(|_| "Could not open local task store.".to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Could not write local tasks.".to_string())?;
    fs::rename(temporary, path).map_err(|_| "Could not save local tasks.".to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportRequest {
    provider: String,
    reference: String,
    token: String,
    jira_site: Option<String>,
    jira_email: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalIssue {
    provider: String,
    id: String,
    key: String,
    url: String,
    title: String,
    description: String,
    status: String,
}

fn plain_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(plain_text).collect::<Vec<_>>().join("\n"),
        Value::Object(map) => {
            let own = map.get("text").and_then(Value::as_str).unwrap_or("");
            let nested = map.get("content").map(plain_text).unwrap_or_default();
            if own.is_empty() {
                nested
            } else {
                own.to_string()
            }
        }
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::plain_text;
    use serde_json::json;

    #[test]
    fn jira_description_becomes_plain_text() {
        let description = json!({
            "type": "doc",
            "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "First" }] },
                { "type": "paragraph", "content": [{ "type": "text", "text": "Second" }] }
            ]
        });
        assert_eq!(plain_text(&description), "First\nSecond");
    }
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("Provider response is missing {key}."))
}

#[tauri::command]
async fn fetch_external_issue(input: ImportRequest) -> Result<ExternalIssue, String> {
    let reference = input.reference.trim();
    let token = input.token.trim();
    if reference.is_empty()
        || reference.len() > 128
        || !reference
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
        || token.is_empty()
    {
        return Err("Enter a valid ticket ID and access token.".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "Could not start the provider request.".to_string())?;
    let response = match input.provider.as_str() {
        "Linear" => {
            client
                .post("https://api.linear.app/graphql")
                .header("Authorization", token)
                .json(&json!({
                    "query": "query Issue($id: String!) { issue(id: $id) { id identifier title description url state { name } } }",
                    "variables": { "id": reference }
                }))
                .send()
                .await
        }
        "Asana" => {
            if !reference.chars().all(|c| c.is_ascii_digit()) {
                return Err("Enter the numeric Asana task GID.".to_string());
            }
            client
                .get(format!("https://app.asana.com/api/1.0/tasks/{reference}"))
                .bearer_auth(token)
                .query(&[("opt_fields", "gid,name,notes,permalink_url,completed")])
                .send()
                .await
        }
        "Jira" => {
            let site = input.jira_site.as_deref().unwrap_or("").trim();
            let email = input.jira_email.as_deref().unwrap_or("").trim();
            let url = reqwest::Url::parse(site)
                .map_err(|_| "Enter the full HTTPS Jira Cloud site URL.".to_string())?;
            let host = url.host_str().unwrap_or("");
            if url.scheme() != "https"
                || !host.ends_with(".atlassian.net")
                || url.port().is_some()
                || url.path() != "/"
                || url.query().is_some()
                || !url.username().is_empty()
                || email.is_empty()
            {
                return Err("Enter a Jira Cloud site URL and account email.".to_string());
            }
            let auth = base64::engine::general_purpose::STANDARD.encode(format!("{email}:{token}"));
            client
                .get(format!("https://{host}/rest/api/3/issue/{reference}"))
                .header("Authorization", format!("Basic {auth}"))
                .query(&[("fields", "summary,description,status")])
                .send()
                .await
        }
        _ => return Err("Unsupported task provider.".to_string()),
    }
    .map_err(|_| "Could not reach the task provider.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Provider returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| "Provider returned invalid JSON.".to_string())?;
    match input.provider.as_str() {
        "Linear" => {
            if body["errors"]
                .as_array()
                .is_some_and(|errors| !errors.is_empty())
            {
                return Err("Linear could not load this issue.".to_string());
            }
            let issue = &body["data"]["issue"];
            Ok(ExternalIssue {
                provider: input.provider,
                id: required_string(issue, "id")?.to_string(),
                key: required_string(issue, "identifier")?.to_string(),
                url: required_string(issue, "url")?.to_string(),
                title: required_string(issue, "title")?.to_string(),
                description: issue["description"].as_str().unwrap_or("").to_string(),
                status: issue["state"]["name"].as_str().unwrap_or("").to_string(),
            })
        }
        "Asana" => {
            let issue = &body["data"];
            Ok(ExternalIssue {
                provider: input.provider,
                id: required_string(issue, "gid")?.to_string(),
                key: required_string(issue, "gid")?.to_string(),
                url: required_string(issue, "permalink_url")?.to_string(),
                title: required_string(issue, "name")?.to_string(),
                description: issue["notes"].as_str().unwrap_or("").to_string(),
                status: if issue["completed"].as_bool().unwrap_or(false) {
                    "Complete"
                } else {
                    "Open"
                }
                .to_string(),
            })
        }
        "Jira" => {
            let key = required_string(&body, "key")?;
            let site = input.jira_site.unwrap_or_default();
            Ok(ExternalIssue {
                provider: input.provider,
                id: required_string(&body, "id")?.to_string(),
                key: key.to_string(),
                url: format!("{}/browse/{key}", site.trim_end_matches('/')),
                title: required_string(&body["fields"], "summary")?.to_string(),
                description: plain_text(&body["fields"]["description"]),
                status: body["fields"]["status"]["name"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
            })
        }
        _ => unreachable!(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(WorkspaceLock(Mutex::new(())))
        .manage(agent::Running::default())
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            projects::project_inspect,
            projects::project_init,
            projects::project_clone,
            load_task_workspace,
            save_task_workspace,
            agent_preferences::load_agent_preferences,
            agent_preferences::save_agent_preferences,
            fetch_external_issue,
            sessions::sessions_list,
            agent::agent_start,
            agent::agent_stop,
            agent::agent_steer,
            agent::worker_command,
            agent::harness_home,
            extensions::extensions_scan,
            harness_settings::load_harness_settings,
            harness_settings::save_harness_settings,
            harness_settings::harness_mcp_config,
            human::human_requests,
            human::human_answer,
            agent::agent_steer_command,
            git::git_prepare,
            git::git_start_ticket,
            git::git_open_task,
            git::git_sync_from_ticket,
            git::git_land,
            git::git_close_task,
            git::git_ticket_status,
            git::git_publish,
            git::git_task_reports,
            merge_queue::merge_line,
            queues::queues_snapshot,
            queues::queues_watch_paths,
            queues::queues_set
        ])
        .run(tauri::generate_context!())
        .expect("Berdloop could not start");
}
