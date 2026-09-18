//! A small request/reply channel from coding CLI processes to their Tauri host.
//! Each launch gets a private directory whose scope is held by Rust, not supplied
//! in requests. Coordinator commands use the same workspace as UI get/set calls.
use crate::{
    conversations::{Scope, UserMessage},
    workspace::{self},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

pub const COMMANDS: &[&str] = &[
    // The same six operations on each queue. A planner agent gets one set.
    "ticket-add",
    "ticket-edit",
    "ticket-remove",
    "ticket-split",
    "ticket-merge",
    "ticket-reorder",
    "task-add",
    "task-edit",
    "task-remove",
    "task-split",
    "task-merge",
    "task-reorder",
    "queue-show",
    // One-sided: a ticket holds running workers, a task is one of them.
    "ticket-pause",
    "ticket-resume",
    "ticket-replan",
    "task-steer",
    "task-stop",
    "pr-review-submit",
];
#[derive(Deserialize, Serialize)]
pub struct Request {
    pub command: String,
    pub args: HashMap<String, String>,
}
#[derive(Deserialize, Serialize)]
struct Reply {
    result: Option<String>,
    error: Option<String>,
}

pub struct Channel {
    alive: Arc<AtomicBool>,
}
impl Drop for Channel {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
    }
}

pub fn open(app: &tauri::AppHandle, scope: Scope) -> Result<(Channel, PathBuf), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("control")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let alive = Arc::new(AtomicBool::new(true));
    let watching = alive.clone();
    let root = dir.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        while watching.load(Ordering::SeqCst) {
            serve_once(&root, |request| execute(&app, &scope, request));
            std::thread::sleep(Duration::from_millis(50));
        }
        // Completed replies can still be read by the exiting CLI. Retain them.
    });
    Ok((Channel { alive }, dir))
}

fn serve_once(dir: &Path, mut handler: impl FnMut(Request) -> Result<String, String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("request") {
            continue;
        }
        let claimed = path.with_extension("working");
        if fs::rename(&path, &claimed).is_err() {
            continue;
        }
        let result = fs::read(&claimed)
            .map_err(|e| e.to_string())
            .and_then(|bytes| {
                if bytes.len() > 1024 * 1024 {
                    return Err("Command is too large".into());
                }
                let request = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                handler(request)
            });
        let reply = match result {
            Ok(result) => Reply {
                result: Some(result),
                error: None,
            },
            Err(error) => Reply {
                result: None,
                error: Some(error),
            },
        };
        let _ = workspace::atomic_write(
            &path.with_extension("reply"),
            &serde_json::to_vec(&reply).unwrap(),
        );
        let _ = fs::remove_file(claimed);
    }
}

pub fn call(request: Request) -> Result<String, String> {
    let dir = std::env::var("BERDLOOP_CONTROL")
        .map_err(|_| "Start this coordinator from Berdloop to connect its tools.".to_string())?;
    call_at(Path::new(&dir), request, Duration::from_secs(30))
}
fn call_at(dir: &Path, request: Request, timeout: Duration) -> Result<String, String> {
    let path = dir.join(format!("{}.request", uuid::Uuid::new_v4()));
    workspace::atomic_write(
        &path,
        &serde_json::to_vec(&request).map_err(|e| e.to_string())?,
    )?;
    let reply = path.with_extension("reply");
    let start = Instant::now();
    loop {
        if reply.exists() {
            let answer: Reply =
                serde_json::from_slice(&fs::read(&reply).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            let _ = fs::remove_file(reply);
            return answer
                .result
                .ok_or_else(|| answer.error.unwrap_or("Command failed".into()));
        }
        if start.elapsed() > timeout {
            // Do not remove the request: a mutation may already be in progress.
            return Err("The app did not respond in time. Check the workspace before retrying this command.".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
fn required<'a>(args: &'a HashMap<String, String>, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .map(String::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("--{key} is required"))
}
fn ticket_id(w: &Value, scope: &Scope, reference: Option<&str>) -> Result<String, String> {
    let found = w["tasks"]
        .as_array()
        .ok_or("Invalid tickets")?
        .iter()
        .find(|t| {
            t["projectId"] == scope.project_id
                && reference.map_or_else(
                    || scope.ticket_id.as_deref() == t["id"].as_str(),
                    |id| t["id"] == id || t["ticket"] == id,
                )
        });
    let ticket = found.ok_or("Ticket is not in this project")?;
    let id = ticket["id"].as_str().ok_or("Invalid ticket ID")?;
    if scope.role == "task-agent" && scope.ticket_id.as_deref() != Some(id) {
        return Err("A task agent can only change its own ticket".into());
    }
    Ok(id.into())
}
fn task_scope(w: &Value, scope: &Scope, task: &str) -> Result<Scope, String> {
    let item = w["agentTasks"]
        .as_array()
        .ok_or("Invalid tasks")?
        .iter()
        .find(|t| t["id"] == task)
        .ok_or("Unknown task")?;
    let ticket = ticket_id(w, scope, item["parentTaskId"].as_str())?;
    Ok(Scope {
        organization_id: scope.organization_id.clone(),
        project_id: scope.project_id.clone(),
        role: "worker".into(),
        ticket_id: Some(ticket),
        task_id: Some(task.into()),
    })
}
fn authorize(scope: &Scope, command: &str) -> Result<(), String> {
    let allowed = match scope.role.as_str() {
        "ticket-agent" => command.starts_with("ticket-") || command == "queue-show",
        "task-agent" => command.starts_with("task-") || command == "queue-show",
        "pr-code-review" => command == "pr-review-submit",
        _ => false,
    };
    if allowed && COMMANDS.contains(&command) {
        Ok(())
    } else {
        Err("This command is not available to this agent role".into())
    }
}

fn ticket_key(w: &Value, ticket_id: &str) -> Result<String, String> {
    w["tasks"]
        .as_array()
        .and_then(|tickets| tickets.iter().find(|t| t["id"] == ticket_id))
        .and_then(|t| t["ticket"].as_str())
        .map(str::to_string)
        .ok_or_else(|| "Ticket has no key".to_string())
}

/// A stopped worker must not keep its merge turn; the ones behind it wait on it.
fn release_merge_place(app: &tauri::AppHandle, w: &Value, scope: &Scope, ticket: &str, task: &str) {
    let Ok(key) = ticket_key(w, ticket) else {
        return;
    };
    if let Ok(staging) = crate::git::staging_for(app, &scope.project_id) {
        crate::merge_queue::Queue::new(staging.queue_dir(&key)).release(task);
    }
}

fn instruct(app: &tauri::AppHandle, scope: Scope, text: String) -> Result<(), String> {
    crate::agent::queue_instruction(
        app,
        scope,
        UserMessage {
            id: uuid::Uuid::new_v4().to_string(),
            text,
            target: None,
        },
    )
}

pub fn execute(app: &tauri::AppHandle, scope: &Scope, request: Request) -> Result<String, String> {
    authorize(scope, &request.command)?;
    if request.command == "pr-review-submit" {
        return crate::pr_review::submit(
            app,
            scope,
            required(&request.args, "head")?,
            required(&request.args, "summary")?,
            required(&request.args, "findings")?,
        );
    }
    let store = workspace::for_app(app)?;
    let w = store.load()?;
    let args = &request.args;
    match request.command.as_str() {
        "task-steer" => {
            let ticket = ticket_id(&w, scope, None)?;
            let scopes: Vec<_> = w["agentTasks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|t| {
                    t["parentTaskId"] == ticket
                        && t["status"] != "complete"
                        && args.get("task").is_none_or(|id| t["id"] == *id)
                })
                .map(|t| task_scope(&w, scope, t["id"].as_str().unwrap()))
                .collect::<Result<_, _>>()?;
            if scopes.is_empty() {
                return Err("No matching worker on this ticket".into());
            }
            for target in &scopes {
                instruct(app, target.clone(), required(args, "message")?.into())?;
            }
            return Ok(format!("Instruction recorded for {} workers", scopes.len()));
        }
        "task-stop" => {
            let target = task_scope(&w, scope, required(args, "task")?)?;
            let reason = required(args, "reason")?;
            crate::agent::stop_and_wait(app, &target)?;
            // The reason stays in the worker's chat, where the next attempt and
            // the person watching it can both read it.
            crate::agent::note(app, &target, format!("Stopped by the task agent: {reason}"));
            let ticket = ticket_id(&w, scope, target.ticket_id.as_deref())?;
            release_merge_place(app, &w, scope, &ticket, target.task_id.as_deref().unwrap());
        }
        "queue-show" if args.get("kind").map(String::as_str) == Some("worker") => {
            // Workers wait in the merge queue, not in the task list.
            let ticket = ticket_id(&w, scope, args.get("ticket").map(String::as_str))?;
            let key = ticket_key(&w, &ticket)?;
            let staging = crate::git::staging_for(app, &scope.project_id)?;
            let line = crate::merge_queue::Queue::new(staging.queue_dir(&key)).line();
            return Ok(Value::Array(line.into_iter().map(Value::String).collect()).to_string());
        }
        "ticket-remove" => {
            let ticket = ticket_id(&w, scope, Some(required(args, "ticket")?))?;
            for task in w["agentTasks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|t| t["parentTaskId"] == ticket)
            {
                crate::agent::stop_and_wait(
                    app,
                    &task_scope(&w, scope, task["id"].as_str().unwrap())?,
                )?;
            }
            crate::agent::stop_and_wait(
                app,
                &Scope {
                    role: "task-agent".into(),
                    ticket_id: Some(ticket),
                    task_id: None,
                    ..scope.clone()
                },
            )?;
        }
        "ticket-replan" => {
            let ticket = ticket_id(&w, scope, Some(required(args, "ticket")?))?;
            instruct(
                app,
                Scope {
                    role: "task-agent".into(),
                    ticket_id: Some(ticket),
                    task_id: None,
                    ..scope.clone()
                },
                required(args, "message")?.into(),
            )?;
            return Ok("Planning instruction queued for the ticket's planner".into());
        }
        _ => {}
    }
    let (saved, result) = store.change(|w| mutate(w, scope, &request))?;
    if request.command == "ticket-edit" && args.contains_key("requirements") {
        let ticket = ticket_id(&saved, scope, Some(required(args, "ticket")?))?;
        let message = format!(
            "Ticket requirements changed. Use these from now on:\n{}",
            required(args, "requirements")?
        );
        for task in saved["agentTasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["parentTaskId"] == ticket && t["status"] != "complete")
        {
            instruct(
                app,
                task_scope(&saved, scope, task["id"].as_str().unwrap())?,
                message.clone(),
            )?;
        }
        instruct(
            app,
            Scope {
                role: "task-agent".into(),
                ticket_id: Some(ticket),
                task_id: None,
                ..scope.clone()
            },
            message,
        )?;
    }
    Ok(result)
}

/// Both queues are one idea. A ticket is a record owned by a project; a task is
/// a record owned by a ticket. Everything an agent does to a queue — add, edit,
/// remove, split, merge, reorder, show — is written once against this, so the
/// ticket agent and the task agent cannot drift apart.
struct Queue {
    /// Where the records live in the workspace.
    collection: &'static str,
    /// The field naming a record's owner, and the value it must hold.
    owner_field: &'static str,
    owner_id: String,
    /// What the agent calls one record, and the flag it names one with.
    noun: &'static str,
    arg: &'static str,
    plural: &'static str,
    /// Tickets have requirements; tasks have criteria. Same field, same idea.
    criteria_arg: &'static str,
    /// Tasks wait on each other. Tickets do not.
    dependent: bool,
}

impl Queue {
    /// Which queue a command speaks to. `ticket-*` is the project's ticket
    /// queue; anything else is one ticket's task queue.
    fn of(
        w: &Value,
        scope: &Scope,
        command: &str,
        args: &HashMap<String, String>,
    ) -> Result<Self, String> {
        let tickets = if command == "queue-show" {
            required(args, "kind")? == "ticket"
        } else {
            command.starts_with("ticket-")
        };
        if tickets {
            if scope.role != "ticket-agent" {
                return Err("Only the ticket agent owns the ticket queue".into());
            }
            return Ok(Self {
                collection: "tasks",
                owner_field: "projectId",
                owner_id: scope.project_id.clone(),
                noun: "Ticket",
                arg: "ticket",
                plural: "tickets",
                criteria_arg: "requirements",
                dependent: false,
            });
        }
        Ok(Self {
            collection: "agentTasks",
            owner_field: "parentTaskId",
            owner_id: ticket_id(w, scope, args.get("ticket").map(String::as_str))?,
            noun: "Task",
            arg: "task",
            plural: "tasks",
            criteria_arg: "criteria",
            dependent: true,
        })
    }

    fn mine(&self, item: &Value) -> bool {
        item[self.owner_field] == json!(self.owner_id)
    }

    /// Where this queue's records sit in the workspace array, in queue order.
    fn positions(&self, w: &Value) -> Vec<usize> {
        w[self.collection].as_array().map_or_else(Vec::new, |list| {
            list.iter()
                .enumerate()
                .filter(|(_, t)| self.mine(t))
                .map(|(i, _)| i)
                .collect()
        })
    }

    /// A ticket answers to its key as well as its id. A task answers to its id.
    fn resolve(&self, w: &Value, reference: &str) -> Result<String, String> {
        w[self.collection]
            .as_array()
            .ok_or("Invalid queue")?
            .iter()
            .find(|t| {
                self.mine(t) && (t["id"] == json!(reference) || t["ticket"] == json!(reference))
            })
            .and_then(|t| t["id"].as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("{} is not in this queue", self.noun))
    }

    /// Every id named by a comma separated flag, in the order given.
    fn resolve_all(&self, w: &Value, references: &str) -> Result<Vec<String>, String> {
        let mut ids = Vec::new();
        for reference in references.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let id = self.resolve(w, reference)?;
            if ids.contains(&id) {
                return Err(format!("{} named twice", self.noun));
            }
            ids.push(id);
        }
        Ok(ids)
    }

    fn get<'a>(&self, w: &'a Value, id: &str) -> Result<&'a Value, String> {
        w[self.collection]
            .as_array()
            .ok_or("Invalid queue")?
            .iter()
            .find(|t| t["id"] == json!(id))
            .ok_or_else(|| format!("Unknown {}", self.noun.to_lowercase()))
    }

    /// Splitting or merging a ticket rewrites which ticket exists, so any task
    /// already planned under it would be left pointing at nothing. The task
    /// agent reshapes those through `ticket-replan`, which knows what is running.
    fn detached(&self, w: &Value, ids: &[String]) -> Result<(), String> {
        if self.dependent {
            return Ok(());
        }
        let planned = w["agentTasks"].as_array().is_some_and(|list| {
            list.iter()
                .any(|t| ids.iter().any(|id| t["parentTaskId"] == json!(id)))
        });
        if planned {
            return Err(
                "This ticket already has tasks. Use ticket-replan, or remove them first".into(),
            );
        }
        Ok(())
    }

    /// Work that has started or finished is not the queue's to rearrange.
    fn changeable(&self, w: &Value, id: &str) -> Result<(), String> {
        match self.get(w, id)?["status"].as_str().unwrap_or("") {
            "complete" => Err("Completed work is immutable".into()),
            "running" | "review" => Err(format!(
                "Stop this {} before changing it",
                self.noun.to_lowercase()
            )),
            _ => Ok(()),
        }
    }

    /// One new record, shaped for whichever queue this is.
    fn record(&self, title: &str, criteria: &str, prompt: Option<&str>, after: Vec<Value>) -> Value {
        let id = uuid::Uuid::new_v4().to_string();
        let now = workspace::now();
        if !self.dependent {
            return json!({"id": id, "projectId": self.owner_id, "title": title,
                "criteria": criteria, "source": "Local", "ticket": format!("LOCAL-{}", &id[..8]),
                "stage": "Branch", "status": "queued", "updatedAt": now});
        }
        let written = format!("{title}\n\n{criteria}");
        json!({"id": id, "parentTaskId": self.owner_id, "title": title, "criteria": criteria,
            "prompt": prompt.unwrap_or(&written), "dependencyIds": after,
            "status": "queued", "createdAt": now, "updatedAt": now})
    }

    /// Work that waited on records being replaced must wait on what replaced
    /// them, or a split silently drops the order somebody depended on.
    fn rewire(&self, w: &mut Value, gone: &[String], now: &[Value]) {
        if !self.dependent {
            return;
        }
        let vanished: Vec<Value> = gone.iter().map(|id| json!(id)).collect();
        let Some(list) = w[self.collection].as_array_mut() else {
            return;
        };
        for item in list {
            let Some(deps) = item["dependencyIds"].as_array() else {
                continue;
            };
            if !deps.iter().any(|d| vanished.contains(d)) {
                continue;
            }
            let mut kept: Vec<Value> = deps
                .iter()
                .filter(|d| !vanished.contains(d))
                .cloned()
                .collect();
            for replacement in now {
                if !kept.contains(replacement) && *replacement != item["id"] {
                    kept.push(replacement.clone());
                }
            }
            item["dependencyIds"] = Value::Array(kept);
        }
    }

    /// Put `records` where `gone` used to be, so a split or a merge keeps the
    /// position the person had already chosen for that work.
    fn replace(&self, w: &mut Value, gone: &[String], records: Vec<Value>) -> Result<(), String> {
        let list = w[self.collection].as_array_mut().ok_or("Invalid queue")?;
        let at = list
            .iter()
            .position(|t| gone.iter().any(|id| t["id"] == json!(id)))
            .ok_or("Nothing to replace")?;
        list.retain(|t| !gone.iter().any(|id| t["id"] == json!(id)));
        let at = at.min(list.len());
        list.splice(at..at, records);
        Ok(())
    }
}

pub fn mutate(w: &mut Value, scope: &Scope, request: &Request) -> Result<String, String> {
    authorize(scope, &request.command)?;
    let args = &request.args;
    let command = request.command.as_str();
    // `ticket-add` and `task-add` are one operation on two queues. Everything a
    // planner does is named this way, so it is written once below.
    let operation = command.split_once('-').map_or(command, |(_, rest)| rest);

    // Pausing belongs to the ticket alone: a ticket holds running workers, and
    // a queued task holds nothing to pause.
    if let "pause" | "resume" = operation {
        let id = ticket_id(w, scope, Some(required(args, "ticket")?))?;
        let ticket = w["tasks"]
            .as_array_mut()
            .ok_or("Invalid tickets")?
            .iter_mut()
            .find(|t| t["id"] == json!(id))
            .ok_or("Unknown ticket")?;
        if ticket["status"] == json!("complete") {
            return Err("This ticket is complete".into());
        }
        ticket["status"] = json!(if operation == "pause" { "paused" } else { "running" });
        ticket["updatedAt"] = json!(workspace::now());
        return Ok(format!("Ticket {operation}d"));
    }

    let queue = Queue::of(w, scope, command, args)?;
    match operation {
        "add" => {
            let after: Vec<Value> = args
                .get("after")
                .map(|v| {
                    v.split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|id| json!(id))
                        .collect()
                })
                .unwrap_or_default();
            let record = queue.record(
                required(args, "title")?,
                required(args, queue.criteria_arg)?,
                args.get("prompt").map(String::as_str),
                after,
            );
            let reply = json!({"id": record["id"], "ticket": record["ticket"]});
            w[queue.collection]
                .as_array_mut()
                .ok_or("Invalid queue")?
                .push(record);
            Ok(reply.to_string())
        }
        "edit" => {
            let id = queue.resolve(w, required(args, queue.arg)?)?;
            queue.changeable(w, &id)?;
            let item = w[queue.collection]
                .as_array_mut()
                .ok_or("Invalid queue")?
                .iter_mut()
                .find(|t| t["id"] == json!(id))
                .ok_or("Unknown record")?;
            for (flag, field) in [
                ("title", "title"),
                (queue.criteria_arg, "criteria"),
                ("prompt", "prompt"),
            ] {
                if let Some(value) = args.get(flag) {
                    if value.trim().is_empty() {
                        return Err(format!("{flag} cannot be empty"));
                    }
                    item[field] = json!(value);
                }
            }
            item["updatedAt"] = json!(workspace::now());
            Ok(format!("{} updated", queue.noun))
        }
        "stop" => {
            let id = queue.resolve(w, required(args, queue.arg)?)?;
            if queue.get(w, &id)?["status"] == json!("complete") {
                return Err("Completed work is immutable".into());
            }
            let item = w[queue.collection]
                .as_array_mut()
                .ok_or("Invalid queue")?
                .iter_mut()
                .find(|t| t["id"] == json!(id))
                .ok_or("Unknown record")?;
            item["status"] = json!("queued");
            item["updatedAt"] = json!(workspace::now());
            Ok(format!("{} returned to the queue", queue.noun))
        }
        "remove" => {
            let id = queue.resolve(w, required(args, queue.arg)?)?;
            queue.changeable(w, &id)?;
            if queue.dependent
                && w[queue.collection]
                    .as_array()
                    .is_some_and(|list| {
                        list.iter().any(|t| {
                            t["dependencyIds"]
                                .as_array()
                                .is_some_and(|d| d.contains(&json!(id)))
                        })
                    })
            {
                return Err("Remove dependencies on this task first".into());
            }
            w[queue.collection]
                .as_array_mut()
                .ok_or("Invalid queue")?
                .retain(|t| t["id"] != json!(id));
            if !queue.dependent {
                // A ticket owns its tasks; leaving them behind orphans them.
                w["agentTasks"]
                    .as_array_mut()
                    .ok_or("Invalid tasks")?
                    .retain(|t| t["parentTaskId"] != json!(id));
            }
            Ok(format!("{} removed", queue.noun))
        }
        "split" => {
            let id = queue.resolve(w, required(args, queue.arg)?)?;
            queue.changeable(w, &id)?;
            queue.detached(w, std::slice::from_ref(&id))?;
            let parts: Vec<Value> = serde_json::from_str(required(args, "parts")?)
                .map_err(|error| format!("--parts is not valid JSON: {error}"))?;
            if parts.len() < 2 {
                return Err("Give at least two parts, or edit it instead".into());
            }
            // Every part starts where the original started, so nothing it was
            // waiting for is lost.
            let after = queue.get(w, &id)?["dependencyIds"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let mut records = Vec::new();
            for part in &parts {
                let title = part["title"].as_str().filter(|s| !s.trim().is_empty());
                let criteria = part[queue.criteria_arg]
                    .as_str()
                    .or_else(|| part["criteria"].as_str())
                    .filter(|s| !s.trim().is_empty());
                let (Some(title), Some(criteria)) = (title, criteria) else {
                    return Err(format!(
                        "Every part needs a title and {}",
                        queue.criteria_arg
                    ));
                };
                records.push(queue.record(
                    title,
                    criteria,
                    part["prompt"].as_str(),
                    after.clone(),
                ));
            }
            let ids: Vec<Value> = records.iter().map(|r| r["id"].clone()).collect();
            queue.rewire(w, std::slice::from_ref(&id), &ids);
            queue.replace(w, std::slice::from_ref(&id), records)?;
            Ok(Value::Array(ids).to_string())
        }
        "merge" => {
            let ids = queue.resolve_all(w, required(args, queue.plural)?)?;
            if ids.len() < 2 {
                return Err(format!("Name at least two {} to merge", queue.plural));
            }
            queue.detached(w, &ids)?;
            let mut titles = Vec::new();
            let mut criteria = Vec::new();
            let mut after: Vec<Value> = Vec::new();
            for id in &ids {
                queue.changeable(w, id)?;
                let item = queue.get(w, id)?;
                titles.push(item["title"].as_str().unwrap_or_default().to_string());
                criteria.push(item["criteria"].as_str().unwrap_or_default().to_string());
                for dependency in item["dependencyIds"].as_array().into_iter().flatten() {
                    // A wait on something being merged in is satisfied by the merge.
                    if !after.contains(dependency) && !ids.contains(&dependency.to_string()) {
                        after.push(dependency.clone());
                    }
                }
            }
            let record = queue.record(
                args.get("title")
                    .map(String::as_str)
                    .unwrap_or(&titles.join(" + ")),
                args.get(queue.criteria_arg)
                    .map(String::as_str)
                    .unwrap_or(&criteria.join("\n\n")),
                None,
                after,
            );
            let new = vec![record["id"].clone()];
            queue.rewire(w, &ids, &new);
            queue.replace(w, &ids, vec![record])?;
            Ok(Value::Array(new).to_string())
        }
        "reorder" | "show" => {
            let positions = queue.positions(w);
            let list = w[queue.collection].as_array_mut().ok_or("Invalid queue")?;
            if operation == "show" {
                return Ok(
                    Value::Array(positions.iter().map(|i| list[*i].clone()).collect()).to_string()
                );
            }
            let mut selected: Vec<Value> = Vec::new();
            for reference in required(args, "order")?
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let value = positions
                    .iter()
                    .map(|i| &list[*i])
                    .find(|t| t["id"] == json!(reference) || t["ticket"] == json!(reference))
                    .ok_or("Order contains a record outside this queue")?;
                if selected.iter().any(|v| v["id"] == value["id"]) {
                    return Err("Order repeats a record".into());
                }
                selected.push(value.clone());
            }
            // Anything the order left out keeps its place behind what it named.
            for i in &positions {
                if !selected.iter().any(|t| t["id"] == list[*i]["id"]) {
                    selected.push(list[*i].clone());
                }
            }
            for (i, value) in positions.into_iter().zip(selected) {
                list[i] = value;
            }
            Ok("Queue reordered".into())
        }
        _ => Err("This command needs the live agent runtime".into()),
    }
}

#[tauri::command]
pub fn ticket_control(
    app: tauri::AppHandle,
    scope: Scope,
    ticket: String,
    paused: bool,
) -> Result<String, String> {
    execute(
        &app,
        &scope,
        Request {
            command: if paused {
                "ticket-pause"
            } else {
                "ticket-resume"
            }
            .into(),
            args: HashMap::from([("ticket".into(), ticket)]),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::Store;
    fn request(command: &str, args: &[(&str, &str)]) -> Request {
        Request {
            command: command.into(),
            args: args
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }
    #[test]
    fn planning_creates_real_tasks_and_reorders_the_execution_array() {
        let dir = std::env::temp_dir().join(format!("berdloop-planning-{}", uuid::Uuid::new_v4()));
        let store = Store(dir.join("tasks.json"));
        let mut scope = Scope {
            organization_id: "org".into(),
            project_id: "p".into(),
            role: "ticket-agent".into(),
            ticket_id: None,
            task_id: None,
        };
        let (w, _) = store
            .change(|w| {
                mutate(
                    w,
                    &scope,
                    &request(
                        "ticket-add",
                        &[("title", "Ticket"), ("requirements", "Build")],
                    ),
                )
            })
            .unwrap();
        scope.ticket_id = w["tasks"][0]["id"].as_str().map(str::to_string);
        scope.role = "task-agent".into();
        for title in ["first", "second"] {
            store
                .change(|w| {
                    mutate(
                        w,
                        &scope,
                        &request(
                            "task-add",
                            &[
                                ("title", title),
                                ("criteria", "Check"),
                                ("prompt", "Actual instructions"),
                            ],
                        ),
                    )
                })
                .unwrap();
        }
        let w = store.load().unwrap();
        let second = w["agentTasks"][1]["id"].as_str().unwrap();
        let (w, _) = store
            .change(|w| mutate(w, &scope, &request("task-reorder", &[("order", second)])))
            .unwrap();
        assert_eq!(w["agentTasks"][0]["title"], "second");
        assert_eq!(w["agentTasks"][0]["prompt"], "Actual instructions");
        assert_eq!(w["agentTasks"][0]["status"], "ready");
        let other = Scope {
            project_id: "other".into(),
            ..scope.clone()
        };
        assert!(store
            .change(|w| mutate(
                w,
                &other,
                &request("task-edit", &[("task", second), ("title", "wrong")])
            ))
            .is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    fn scope(role: &str, ticket: Option<&str>) -> Scope {
        Scope {
            organization_id: "org".into(),
            project_id: "p".into(),
            role: role.into(),
            ticket_id: ticket.map(str::to_string),
            task_id: None,
        }
    }

    /// Split and merge are the two operations that move dependencies around, so
    /// they are the two worth proving. Both queues run the same code.
    #[test]
    fn splitting_and_merging_keep_queue_order_and_dependencies() {
        let dir = std::env::temp_dir().join(format!("berdloop-split-{}", uuid::Uuid::new_v4()));
        let store = Store(dir.join("tasks.json"));
        let mut at = scope("ticket-agent", None);
        let (w, _) = store
            .change(|w| {
                mutate(
                    w,
                    &at,
                    &request("ticket-add", &[("title", "T"), ("requirements", "R")]),
                )
            })
            .unwrap();
        at.ticket_id = w["tasks"][0]["id"].as_str().map(str::to_string);
        let tt = Scope {
            role: "task-agent".into(),
            ..at.clone()
        };
        for title in ["one", "two"] {
            store
                .change(|w| {
                    mutate(
                        w,
                        &tt,
                        &request("task-add", &[("title", title), ("criteria", "C")]),
                    )
                })
                .unwrap();
        }
        let w = store.load().unwrap();
        let (one, two) = (
            w["agentTasks"][0]["id"].as_str().unwrap().to_string(),
            w["agentTasks"][1]["id"].as_str().unwrap().to_string(),
        );
        // "two" waits for "one".
        store
            .change(|w| {
                mutate(
                    w,
                    &tt,
                    &request("task-remove", &[("task", &two)]),
                )
            })
            .unwrap();
        store
            .change(|w| {
                mutate(
                    w,
                    &tt,
                    &request(
                        "task-add",
                        &[("title", "two"), ("criteria", "C"), ("after", &one)],
                    ),
                )
            })
            .unwrap();

        // Splitting "one" puts both halves in its place, and "two" now waits for both.
        let (w, _) = store
            .change(|w| {
                mutate(
                    w,
                    &tt,
                    &request(
                        "task-split",
                        &[
                            ("task", &one),
                            (
                                "parts",
                                r#"[{"title":"a","criteria":"C"},{"title":"b","criteria":"C"}]"#,
                            ),
                        ],
                    ),
                )
            })
            .unwrap();
        let titles: Vec<_> = w["agentTasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["title"].as_str().unwrap())
            .collect();
        assert_eq!(titles, ["a", "b", "two"], "halves take the original's place");
        let (a, b) = (
            w["agentTasks"][0]["id"].clone(),
            w["agentTasks"][1]["id"].clone(),
        );
        assert_eq!(w["agentTasks"][2]["dependencyIds"], json!([a, b]));

        // Merging them back leaves one task that "two" waits for.
        let (w, _) = store
            .change(|w| {
                mutate(
                    w,
                    &tt,
                    &request(
                        "task-merge",
                        &[(
                            "tasks",
                            &format!("{},{}", a.as_str().unwrap(), b.as_str().unwrap()),
                        )],
                    ),
                )
            })
            .unwrap();
        assert_eq!(w["agentTasks"].as_array().unwrap().len(), 2);
        assert_eq!(w["agentTasks"][0]["title"], "a + b");
        assert_eq!(
            w["agentTasks"][1]["dependencyIds"],
            json!([w["agentTasks"][0]["id"]])
        );

        // A ticket whose tasks are already planned cannot be reshaped from here.
        assert!(store
            .change(|w| mutate(
                w,
                &at,
                &request(
                    "ticket-split",
                    &[
                        ("ticket", at.ticket_id.as_deref().unwrap()),
                        ("parts", r#"[{"title":"x","requirements":"R"},{"title":"y","requirements":"R"}]"#),
                    ],
                )
            ))
            .is_err());

        // The ticket queue runs the same code, so splitting an unplanned one works.
        let (w, _) = store
            .change(|w| {
                mutate(
                    w,
                    &at,
                    &request("ticket-add", &[("title", "fresh"), ("requirements", "R")]),
                )
            })
            .unwrap();
        let fresh = w["tasks"][1]["id"].as_str().unwrap().to_string();
        let (w, _) = store
            .change(|w| {
                mutate(
                    w,
                    &at,
                    &request(
                        "ticket-split",
                        &[
                            ("ticket", &fresh),
                            (
                                "parts",
                                r#"[{"title":"x","requirements":"R"},{"title":"y","requirements":"R"}]"#,
                            ),
                        ],
                    ),
                )
            })
            .unwrap();
        let titles: Vec<_> = w["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["title"].as_str().unwrap())
            .collect();
        assert_eq!(titles, ["T", "x", "y"], "halves take the original's place");
        assert!(w["tasks"][1]["ticket"].as_str().unwrap().starts_with("LOCAL-"));

        // A task agent may never touch the ticket queue.
        assert!(store
            .change(|w| mutate(w, &tt, &request("ticket-split", &[("ticket", &fresh)])))
            .is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_role_is_refused_every_command_that_is_not_its_own() {
        // A worker has no planning commands at all.
        assert!(authorize(&scope("worker", Some("t")), "task-add").is_err());
        assert!(authorize(&scope("ticket-agent", None), "task-add").is_err());
        assert!(authorize(&scope("task-agent", Some("t")), "ticket-pause").is_err());
        assert!(authorize(&scope("task-agent", Some("t")), "pr-review-submit").is_err());
        assert!(authorize(&scope("pr-code-review", Some("t")), "task-add").is_err());
        assert!(authorize(&scope("pr-code-review", Some("t")), "pr-review-submit").is_ok());
        assert!(authorize(&scope("ticket-agent", None), "queue-show").is_ok());
        assert!(authorize(&scope("ticket-agent", None), "merge-land").is_err());
    }

    #[test]
    fn a_refused_mutation_leaves_the_workspace_untouched() {
        let dir = std::env::temp_dir().join(format!("berdloop-rollback-{}", uuid::Uuid::new_v4()));
        let store = Store(dir.join("tasks.json"));
        let ticket_agent = scope("ticket-agent", None);
        let (w, _) = store
            .change(|w| {
                mutate(
                    w,
                    &ticket_agent,
                    &request("ticket-add", &[("title", "T"), ("requirements", "R")]),
                )
            })
            .unwrap();
        let planner = scope("task-agent", w["tasks"][0]["id"].as_str());
        store
            .change(|w| {
                mutate(
                    w,
                    &planner,
                    &request("task-add", &[("title", "base"), ("criteria", "c")]),
                )
            })
            .unwrap();
        let base = store.load().unwrap()["agentTasks"][0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        store
            .change(|w| {
                mutate(
                    w,
                    &planner,
                    &request(
                        "task-add",
                        &[("title", "dependent"), ("criteria", "c"), ("after", &base)],
                    ),
                )
            })
            .unwrap();
        let before = store.load().unwrap();
        assert_eq!(before["agentTasks"][1]["status"], "queued");
        // Dropping a task something else waits on is refused, and the file is
        // exactly what it was.
        let refused =
            store.change(|w| mutate(w, &planner, &request("task-remove", &[("task", &base)])));
        assert!(refused.is_err());
        assert_eq!(store.load().unwrap(), before);
        // A dependency on a task from nowhere fails validation, and rolls back too.
        let refused = store.change(|w| {
            mutate(
                w,
                &planner,
                &request(
                    "task-add",
                    &[("title", "x"), ("criteria", "c"), ("after", "ghost")],
                ),
            )
        });
        assert!(refused.is_err());
        assert_eq!(store.load().unwrap(), before);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn requests_travel_through_the_channel_and_back() {
        let dir = std::env::temp_dir().join(format!("berdloop-control-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let served = dir.clone();
        let server = std::thread::spawn(move || {
            let start = Instant::now();
            let mut answered = 0;
            while answered < 2 && start.elapsed() < Duration::from_secs(5) {
                serve_once(&served, |request| {
                    answered += 1;
                    match request.command.as_str() {
                        "task-add" => Ok(format!("added {}", request.args["title"])),
                        other => Err(format!("no such command {other}")),
                    }
                });
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let ok = call_at(
            &dir,
            request("task-add", &[("title", "hello")]),
            Duration::from_secs(5),
        );
        assert_eq!(ok.unwrap(), "added hello");
        let refused = call_at(&dir, request("nope", &[]), Duration::from_secs(5));
        assert_eq!(refused.unwrap_err(), "no such command nope");
        server.join().unwrap();
        // Nothing is left to be replayed by a later server.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".request") || n.ends_with(".working"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        // With nobody listening the caller times out, and the request stays
        // put rather than being silently discarded.
        let timed_out = call_at(&dir, request("task-add", &[]), Duration::from_millis(100));
        assert!(timed_out.unwrap_err().contains("did not respond"));
        assert!(fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .any(|e| e.path().extension().is_some_and(|x| x == "request")));
        fs::remove_dir_all(dir).unwrap();
    }
}
