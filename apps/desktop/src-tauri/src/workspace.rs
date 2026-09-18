//! One transactional workspace for UI edits and coordinator commands.
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub fn empty() -> Value {
    json!({"schemaVersion":1,"tasks":[],"agentTasks":[]})
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub struct Store(pub PathBuf);
impl Store {
    pub fn load(&self) -> Result<Value, String> {
        if !self.0.exists() {
            return Ok(empty());
        }
        serde_json::from_slice(&fs::read(&self.0).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    }
    pub fn change<T>(
        &self,
        change: impl FnOnce(&mut Value) -> Result<T, String>,
    ) -> Result<(Value, T), String> {
        fs::create_dir_all(self.0.parent().ok_or("Invalid workspace path")?)
            .map_err(|e| e.to_string())?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.0.with_extension("lock"))
            .map_err(|e| e.to_string())?;
        lock.lock().map_err(|e| e.to_string())?;
        let mut value = self.load()?;
        let result = change(&mut value)?;
        validate(&mut value)?;
        let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        if bytes.len() > 10 * 1024 * 1024 {
            return Err("Workspace is too large".into());
        }
        atomic_write(&self.0, &bytes)?;
        Ok((value, result))
    }
    pub fn patch(&self, base: &Value, next: &Value) -> Result<Value, String> {
        self.change(|current| {
            for collection in ["tasks", "agentTasks"] {
                let before = base[collection]
                    .as_array()
                    .ok_or("Invalid base workspace")?;
                let after = next[collection].as_array().ok_or("Invalid workspace")?;
                let records = current[collection]
                    .as_array_mut()
                    .ok_or("Invalid stored workspace")?;
                records.retain(|r| {
                    !before.iter().any(|b| b["id"] == r["id"])
                        || after.iter().any(|a| a["id"] == r["id"])
                });
                for record in after {
                    let old = before.iter().find(|b| b["id"] == record["id"]);
                    if old == Some(record) {
                        continue;
                    }
                    if let Some(existing) = records.iter_mut().find(|r| r["id"] == record["id"]) {
                        let fields = record.as_object().ok_or("Invalid record")?;
                        let object = existing.as_object_mut().ok_or("Invalid stored record")?;
                        for (key, value) in fields {
                            if old.and_then(|r| r.get(key)) != Some(value) {
                                object.insert(key.clone(), value.clone());
                            }
                        }
                        if let Some(old) = old.and_then(Value::as_object) {
                            for key in old.keys() {
                                if !fields.contains_key(key) {
                                    object.remove(key);
                                }
                            }
                        }
                    } else if old.is_none() {
                        records.push(record.clone());
                    } else {
                        return Err(
                            "This record was deleted by another editor. Reload before editing."
                                .into(),
                        );
                    }
                }
                let before_ids: Vec<_> = before.iter().map(|r| &r["id"]).collect();
                let after_ids: Vec<_> = after.iter().map(|r| &r["id"]).collect();
                if before_ids != after_ids {
                    // Preserve newly added agent records that this UI has not seen yet.
                    records.sort_by_key(|r| {
                        after_ids
                            .iter()
                            .position(|id| **id == r["id"])
                            .unwrap_or(usize::MAX)
                    });
                }
            }
            if next.get("cloudUserId") != base.get("cloudUserId") {
                current["cloudUserId"] = next["cloudUserId"].clone();
            }
            Ok(())
        })
        .map(|(value, _)| value)
    }
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

pub fn validate(workspace: &mut Value) -> Result<(), String> {
    if workspace["schemaVersion"] != 1 {
        return Err("Unsupported workspace version".into());
    }
    let tickets = workspace["tasks"]
        .as_array()
        .ok_or("Invalid tickets")?
        .clone();
    let tasks = workspace["agentTasks"]
        .as_array()
        .ok_or("Invalid tasks")?
        .clone();
    for list in [&tickets, &tasks] {
        let mut ids = std::collections::HashSet::new();
        for row in list.iter() {
            let id = row["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or("A record needs an ID")?;
            if !ids.insert(id) {
                return Err("Duplicate record ID".into());
            }
            if !row["title"].is_string() || !row["criteria"].is_string() {
                return Err("A record needs a title and criteria".into());
            }
        }
    }
    for task in &tasks {
        if !tickets.iter().any(|t| t["id"] == task["parentTaskId"]) {
            return Err("Task has no parent ticket".into());
        }
        let dependencies = task["dependencyIds"]
            .as_array()
            .ok_or("Invalid dependencies")?;
        for id in dependencies {
            if !tasks.iter().any(|t| {
                t["id"] == *id && t["parentTaskId"] == task["parentTaskId"] && t["id"] != task["id"]
            }) {
                return Err("Dependencies must be other tasks on the same ticket".into());
            }
        }
        let mut pending = dependencies.clone();
        let mut seen = std::collections::HashSet::new();
        while let Some(id) = pending.pop() {
            if id == task["id"] {
                return Err("Task dependencies contain a cycle".into());
            }
            if seen.insert(id.to_string()) {
                if let Some(dep) = tasks.iter().find(|t| t["id"] == id) {
                    pending.extend(
                        dep["dependencyIds"]
                            .as_array()
                            .ok_or("Invalid dependencies")?
                            .clone(),
                    );
                }
            }
        }
        let satisfied = dependencies.iter().all(|id| {
            tasks
                .iter()
                .any(|t| t["id"] == *id && t["status"] == "complete")
        });
        if !satisfied
            && ["running", "review", "complete"].contains(&task["status"].as_str().unwrap_or(""))
        {
            return Err(
                "Finish dependencies before starting or completing their dependent task".into(),
            );
        }
        let record = workspace["agentTasks"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|t| t["id"] == task["id"])
            .unwrap();
        if ["queued", "ready"].contains(&task["status"].as_str().unwrap_or("")) {
            record["status"] = json!(if satisfied { "ready" } else { "queued" });
        }
    }
    Ok(())
}

pub fn for_app(app: &tauri::AppHandle) -> Result<Store, String> {
    Ok(Store(crate::workspace_path(app)?))
}

#[tauri::command]
pub fn patch_task_workspace(
    app: tauri::AppHandle,
    base: Value,
    workspace: Value,
) -> Result<Value, String> {
    for_app(&app)?.patch(&base, &workspace)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ui_patch_keeps_concurrent_agent_changes() {
        let dir = std::env::temp_dir().join(format!("berdloop-store-{}", uuid::Uuid::new_v4()));
        let store = Store(dir.join("tasks.json"));
        let mut base = empty();
        base["tasks"] = json!([{"id":"t","title":"old","criteria":"original","projectId":"p"}]);
        store.patch(&empty(), &base).unwrap();
        store
            .change(|w| {
                w["tasks"][0]["criteria"] = json!("agent requirements");
                Ok(())
            })
            .unwrap();
        let mut edit = base.clone();
        edit["tasks"][0]["title"] = json!("user title");
        let result = store.patch(&base, &edit).unwrap();
        assert_eq!(result["tasks"][0]["criteria"], "agent requirements");
        assert_eq!(result["tasks"][0]["title"], "user title");
        fs::remove_dir_all(dir).unwrap();
    }
}
