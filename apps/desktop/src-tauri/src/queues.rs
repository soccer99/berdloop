//! The waiting lines, kept on disk.
//!
//! Agents are separate processes. A ticket agent orders the ticket queue, a
//! task agent orders its ticket's tasks, and the window shows both. None of
//! them share memory, so the line itself lives in a file and every one of
//! them reads and writes that file.
//!
//! ```text
//! <staging root>/queues/ticket.json           the project's tickets, in order
//! <staging root>/queues/agent-task/<key>.json one ticket's tasks, in order
//! <staging root>/queues/worker/<key>.json     workers waiting on a ticket
//! ```
//!
//! One file per line, never one file for all of them: two agents ordering two
//! different tickets at the same moment must not overwrite each other.
//!
//! The merge queue is not here. It is a lock with many writers racing for it,
//! so it stays a directory of slot files. See `merge_queue`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::git::Staging;
use crate::merge_queue::Queue;

/// Which line. The names match the queues the interface keeps.
#[derive(Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Ticket,
    AgentTask,
    Worker,
}

impl Kind {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "ticket" => Ok(Self::Ticket),
            "agentTask" | "agent-task" => Ok(Self::AgentTask),
            "worker" => Ok(Self::Worker),
            other => Err(format!(
                "Unknown queue {other}. Use ticket, agent-task or worker."
            )),
        }
    }

    fn dir(self) -> &'static str {
        match self {
            Self::Ticket => "ticket",
            Self::AgentTask => "agent-task",
            Self::Worker => "worker",
        }
    }
}

/// Every line of one project, in the shape the interface keeps them.
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Keyed by project ID. One project per staging area, so one entry.
    pub ticket: BTreeMap<String, Vec<String>>,
    /// Keyed by ticket.
    pub agent_task: BTreeMap<String, Vec<String>>,
    /// Keyed by ticket. Read from the merge queue's slot files.
    pub merge: BTreeMap<String, Vec<String>>,
    /// Keyed by ticket.
    pub worker: BTreeMap<String, Vec<String>>,
}

/// Names that arrive from an agent become one path segment and nothing else.
fn safe(key: &str) -> String {
    key.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

pub struct Queues {
    dir: PathBuf,
    staging: Staging,
}

impl Queues {
    pub fn new(staging: Staging) -> Self {
        Self {
            dir: staging.root.join("queues"),
            staging,
        }
    }

    /// The directory to watch. It is made now so a watcher can be set on it
    /// before any agent has written a line.
    pub fn dir(&self) -> Result<&Path, String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        Ok(&self.dir)
    }

    fn path(&self, kind: Kind, key: &str) -> PathBuf {
        match kind {
            // A project has one ticket queue, so its key adds nothing.
            Kind::Ticket => self.dir.join("ticket.json"),
            _ => self
                .dir
                .join(kind.dir())
                .join(format!("{}.json", safe(key))),
        }
    }

    /// Who is in line, in order. A line nobody has written yet is empty.
    pub fn line(&self, kind: Kind, key: &str) -> Vec<String> {
        std::fs::read_to_string(self.path(kind, key))
            .ok()
            .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
            .unwrap_or_default()
    }

    /// Replace a line.
    ///
    /// The file is written beside itself and then renamed, so a reader either
    /// sees the line as it was or the line as it now is, never half of it.
    pub fn set(&self, kind: Kind, key: &str, ids: &[String]) -> Result<(), String> {
        let path = self.path(kind, key);
        let parent = path.parent().ok_or("A queue needs a directory.")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let text = serde_json::to_string(ids).map_err(|e| e.to_string())?;
        let temporary = path.with_extension("json.writing");
        std::fs::write(&temporary, text).map_err(|e| e.to_string())?;
        std::fs::rename(&temporary, &path).map_err(|e| e.to_string())
    }

    /// The tickets that have a line of their own, whatever kind.
    fn keys(&self, kind: Kind) -> Vec<String> {
        let Ok(entries) = self.dir.join(kind.dir()).read_dir() else {
            return Vec::new();
        };
        let mut keys: Vec<String> = entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_str()?.to_string();
                Some(name.strip_suffix(".json")?.to_string())
            })
            .collect();
        keys.sort();
        keys
    }

    /// Every line of this project, ready to hand to the interface.
    pub fn snapshot(&self, project_id: &str) -> Snapshot {
        let mut snapshot = Snapshot::default();
        snapshot
            .ticket
            .insert(project_id.to_string(), self.line(Kind::Ticket, ""));
        for key in self.keys(Kind::AgentTask) {
            let line = self.line(Kind::AgentTask, &key);
            snapshot.agent_task.insert(key, line);
        }
        for key in self.keys(Kind::Worker) {
            let line = self.line(Kind::Worker, &key);
            snapshot.worker.insert(key, line);
        }
        // The merge queue keeps its own files. Read it where it lives.
        if let Ok(entries) = self.staging.root.join("merge-queue").read_dir() {
            for entry in entries.flatten() {
                if let Some(ticket) = entry.file_name().to_str() {
                    let line = Queue::new(entry.path()).line();
                    snapshot.merge.insert(ticket.to_string(), line);
                }
            }
        }
        snapshot
    }
}

/// One project's queues.
pub fn queues_for(app: &tauri::AppHandle, project_id: &str) -> Result<Queues, String> {
    Ok(Queues::new(crate::git::staging_for(app, project_id)?))
}

/// Every line of one project.
#[tauri::command]
pub fn queues_snapshot(app: tauri::AppHandle, project_id: String) -> Result<Snapshot, String> {
    Ok(queues_for(&app, &project_id)?.snapshot(&project_id))
}

/// The directories that hold this project's lines, for the window to watch.
///
/// Two of them: the lines the agents write, and the merge queue's slot files.
/// Never the staging area as a whole, because the worktrees under it change
/// on every keystroke of every worker.
#[tauri::command]
pub fn queues_watch_paths(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<Vec<String>, String> {
    let queues = queues_for(&app, &project_id)?;
    let merge = queues.staging.root.join("merge-queue");
    std::fs::create_dir_all(&merge).map_err(|e| e.to_string())?;
    Ok(vec![
        queues.dir()?.to_string_lossy().to_string(),
        merge.to_string_lossy().to_string(),
    ])
}

/// Replace one line. The same write an agent makes through its own command.
#[tauri::command]
pub fn queues_set(
    app: tauri::AppHandle,
    project_id: String,
    kind: String,
    key: String,
    ids: Vec<String>,
) -> Result<(), String> {
    queues_for(&app, &project_id)?.set(Kind::parse(&kind)?, &key, &ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn queues() -> Queues {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("berdloop-queues-{n}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        Queues::new(Staging::new(root))
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn a_line_nobody_has_written_is_empty() {
        assert!(queues().line(Kind::Ticket, "").is_empty());
    }

    #[test]
    fn a_line_survives_a_restart() {
        let queues = queues();
        queues
            .set(Kind::Ticket, "", &ids(&["ENG-2", "ENG-1"]))
            .unwrap();
        // A second process reading the same directory sees the same order.
        let reopened = Queues::new(Staging::new(queues.staging.root.clone()));
        assert_eq!(reopened.line(Kind::Ticket, ""), ids(&["ENG-2", "ENG-1"]));
    }

    #[test]
    fn two_tickets_keep_separate_task_lines() {
        let queues = queues();
        queues
            .set(Kind::AgentTask, "ENG-1", &ids(&["a", "b"]))
            .unwrap();
        queues.set(Kind::AgentTask, "ENG-2", &ids(&["c"])).unwrap();
        assert_eq!(queues.line(Kind::AgentTask, "ENG-1"), ids(&["a", "b"]));
        assert_eq!(queues.line(Kind::AgentTask, "ENG-2"), ids(&["c"]));
    }

    #[test]
    fn a_key_from_an_agent_cannot_leave_its_directory() {
        let queues = queues();
        queues
            .set(Kind::AgentTask, "../../escape", &ids(&["a"]))
            .unwrap();
        let written = queues.dir.join("agent-task");
        let names: Vec<String> = written
            .read_dir()
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, ["------escape.json"]);
    }

    #[test]
    fn a_snapshot_carries_every_line() {
        let queues = queues();
        queues.set(Kind::Ticket, "", &ids(&["ENG-1"])).unwrap();
        queues
            .set(Kind::AgentTask, "ENG-1", &ids(&["a", "b"]))
            .unwrap();
        queues.set(Kind::Worker, "ENG-1", &ids(&["a"])).unwrap();
        Queue::new(queues.staging.queue_dir("ENG-1"))
            .acquire("a")
            .unwrap();

        let snapshot = queues.snapshot("project-1");
        assert_eq!(snapshot.ticket["project-1"], ids(&["ENG-1"]));
        assert_eq!(snapshot.agent_task["ENG-1"], ids(&["a", "b"]));
        assert_eq!(snapshot.worker["ENG-1"], ids(&["a"]));
        assert_eq!(snapshot.merge["ENG-1"], ids(&["a"]));
    }

    #[test]
    fn replacing_a_line_leaves_nothing_half_written() {
        let queues = queues();
        queues
            .set(Kind::Ticket, "", &ids(&["ENG-1", "ENG-2"]))
            .unwrap();
        queues.set(Kind::Ticket, "", &ids(&["ENG-2"])).unwrap();
        assert_eq!(queues.line(Kind::Ticket, ""), ids(&["ENG-2"]));
        // The file it was written through is not left behind.
        assert!(!queues.dir.join("ticket.json.writing").exists());
    }

    #[test]
    fn an_unknown_queue_is_refused_by_name() {
        assert!(Kind::parse("tickets").is_err());
        assert!(Kind::parse("agent-task").is_ok());
        assert!(Kind::parse("agentTask").is_ok());
    }
}
