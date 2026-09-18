mod agent;
mod agent_preferences;
mod extensions;
pub mod git;
mod harness_settings;
pub mod human;
pub mod integration_secrets;
pub mod mcp;
pub mod merge_queue;
mod projects;
pub mod queues;
mod sessions;
pub mod tickets;

use serde::Serialize;
use serde_json::Value;
use std::{fs, io::Write, sync::Mutex};
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
            integration_secrets::save_integration_secret,
            integration_secrets::clear_integration_secret,
            tickets::fetch_external_issue,
            tickets::search_external_issues,
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
