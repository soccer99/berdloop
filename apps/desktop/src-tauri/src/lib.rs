mod agent;
mod agent_preferences;
pub mod broker;
pub mod control;
mod conversations;
pub mod devenv;
mod extensions;
pub mod git;
mod harness_models;
mod harness_settings;
pub mod human;
pub mod integration_secrets;
pub mod jev;
pub mod mcp;
pub mod merge_queue;
mod pr_review;
mod projects;
mod sessions;
pub mod tickets;
pub mod workspace;

use serde::Serialize;
use serde_json::Value;
use std::{fs, sync::Mutex};
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
    let _guard = lock.0.lock().map_err(|e| e.to_string())?;
    workspace::for_app(&app)?.change(|current| {
        *current = workspace;
        Ok(())
    })?;
    Ok(())
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
            devenv::devenv_setup,
            devenv::devenv_preview,
            devenv::devenv_servers,
            devenv::devenv_serve,
            load_task_workspace,
            save_task_workspace,
            workspace::patch_task_workspace,
            control::ticket_control,
            agent_preferences::load_agent_preferences,
            agent_preferences::save_agent_preferences,
            integration_secrets::save_integration_secret,
            integration_secrets::clear_integration_secret,
            tickets::fetch_external_issue,
            tickets::search_external_issues,
            sessions::sessions_list,
            agent::agent_start,
            agent::agent_stop,
            agent::agent_conversations,
            agent::agent_send_message,
            agent::worker_command,
            agent::harness_home,
            extensions::extensions_scan,
            harness_models::load_harness_catalog,
            harness_settings::load_harness_settings,
            harness_settings::save_harness_settings,
            harness_settings::harness_mcp_config,
            jev::jev_decide,
            jev::jev_provider,
            human::human_requests,
            human::human_answer,
            git::git_prepare,
            git::git_start_ticket,
            git::git_open_task,
            git::git_task_changes,
            git::git_sync_from_ticket,
            git::git_land,
            git::git_close_task,
            git::git_ticket_status,
            git::git_publish,
            pr_review::publish_ticket_pr,
            pr_review::pr_review_context,
            pr_review::ticket_pr_sync,
            git::git_task_reports,
            merge_queue::merge_line
        ])
        .run(tauri::generate_context!())
        .expect("Berdloop could not start");
}
