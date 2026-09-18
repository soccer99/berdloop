//! Questions a worker cannot answer on its own.
//!
//! Agents run with permissions bypassed, so nothing stops them; that makes it
//! more important, not less, that they have a way to stop themselves. A worker
//! that is about to do something it cannot undo, or that has to choose between
//! two people's work, asks here and waits.
//!
//! Requests live on disk beside the merge queue, for the same reason: workers
//! are separate processes and a question must outlive the window being closed.
//!
//! ```text
//! <staging root>/requests/<id>.json   what the worker asked
//! <staging root>/answers/<id>.json    what the person said
//! ```

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    pub task_id: String,
    pub ticket: String,
    /// "approval" when a command is waiting, "question" otherwise.
    pub kind: String,
    /// What the worker wants to know, in its own words.
    pub question: String,
    /// The exact command awaiting approval, when there is one.
    #[serde(default)]
    pub command: String,
    pub at: u128,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub id: String,
    /// Meaningless for a plain question; the person's decision for an approval.
    pub approved: bool,
    pub text: String,
    pub at: u128,
}

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn safe(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// The questions and answers for one project.
pub struct Desk {
    root: PathBuf,
}

impl Desk {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn requests(&self) -> PathBuf {
        self.root.join("requests")
    }

    fn answers(&self) -> PathBuf {
        self.root.join("answers")
    }

    pub fn ask(&self, request: &Request) -> Result<(), String> {
        let dir = self.requests();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let body = serde_json::to_vec(request).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(format!("{}.json", safe(&request.id))), body)
            .map_err(|e| e.to_string())
    }

    /// Everything still waiting on a person, oldest first.
    pub fn waiting(&self) -> Vec<Request> {
        let Ok(entries) = self.requests().read_dir() else {
            return Vec::new();
        };
        let mut open: Vec<Request> = entries
            .flatten()
            .filter_map(|entry| {
                let text = std::fs::read_to_string(entry.path()).ok()?;
                serde_json::from_str::<Request>(&text).ok()
            })
            .filter(|request| self.answer(&request.id).is_none())
            .collect();
        open.sort_by_key(|request| request.at);
        open
    }

    pub fn answer(&self, id: &str) -> Option<Answer> {
        let path = self.answers().join(format!("{}.json", safe(id)));
        let text = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn reply(&self, answer: &Answer) -> Result<(), String> {
        let dir = self.answers();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let body = serde_json::to_vec(answer).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(format!("{}.json", safe(&answer.id))), body)
            .map_err(|e| e.to_string())
    }

    /// The directory this desk uses. For tests that need a second handle.
    #[cfg(test)]
    pub fn root_for_test(&self) -> PathBuf {
        self.root.clone()
    }

    /// Task ids that are waiting on a person, for the status shown in the list.
    pub fn waiting_tasks(&self) -> Vec<String> {
        let mut tasks: Vec<String> = self
            .waiting()
            .into_iter()
            .map(|request| request.task_id)
            .collect();
        tasks.dedup();
        tasks
    }
}

fn desk_for(app: &tauri::AppHandle, project_id: &str) -> Result<Desk, String> {
    Ok(Desk::new(crate::git::staging_for(app, project_id)?.root))
}

/// Everything waiting on a person right now.
#[tauri::command]
pub fn human_requests(app: tauri::AppHandle, project_id: String) -> Result<Vec<Request>, String> {
    Ok(desk_for(&app, &project_id)?.waiting())
}

/// Answer one request. The worker is polling for this and carries on.
#[tauri::command]
pub fn human_answer(
    app: tauri::AppHandle,
    project_id: String,
    id: String,
    approved: bool,
    text: String,
) -> Result<(), String> {
    desk_for(&app, &project_id)?.reply(&Answer {
        id,
        approved,
        text,
        at: now_ms(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn desk() -> Desk {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("berdloop-desk-{n}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Desk::new(dir)
    }

    fn request(id: &str, task: &str) -> Request {
        Request {
            id: id.to_string(),
            task_id: task.to_string(),
            ticket: "T-1".to_string(),
            kind: "approval".to_string(),
            question: "May I drop the other worker's change?".to_string(),
            command: "git checkout --ours app.txt".to_string(),
            at: now_ms(),
        }
    }

    #[test]
    fn nothing_is_waiting_before_anyone_asks() {
        assert!(desk().waiting().is_empty());
    }

    #[test]
    fn a_question_waits_until_it_is_answered() {
        let desk = desk();
        desk.ask(&request("r1", "task-a")).unwrap();
        assert_eq!(desk.waiting().len(), 1);
        assert_eq!(desk.waiting_tasks(), ["task-a"]);

        desk.reply(&Answer {
            id: "r1".to_string(),
            approved: true,
            text: "go ahead".to_string(),
            at: now_ms(),
        })
        .unwrap();

        // Answered means gone from the list, and readable by the worker.
        assert!(desk.waiting().is_empty());
        let answer = desk.answer("r1").unwrap();
        assert!(answer.approved);
        assert_eq!(answer.text, "go ahead");
    }

    #[test]
    fn a_refusal_is_an_answer_too() {
        let desk = desk();
        desk.ask(&request("r2", "task-b")).unwrap();
        desk.reply(&Answer {
            id: "r2".to_string(),
            approved: false,
            text: "no, keep both".to_string(),
            at: now_ms(),
        })
        .unwrap();
        assert!(desk.waiting().is_empty());
        assert!(!desk.answer("r2").unwrap().approved);
    }

    #[test]
    fn questions_come_back_oldest_first() {
        let desk = desk();
        let mut first = request("r1", "task-a");
        first.at = 100;
        let mut second = request("r2", "task-b");
        second.at = 200;
        desk.ask(&second).unwrap();
        desk.ask(&first).unwrap();
        let ids: Vec<_> = desk.waiting().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, ["r1", "r2"]);
    }

    #[test]
    fn an_unanswered_question_survives_a_restart() {
        let desk = desk();
        desk.ask(&request("r1", "task-a")).unwrap();
        // A second process reading the same directory sees the same question.
        let reopened = Desk::new(desk.root.clone());
        assert_eq!(reopened.waiting().len(), 1);
        assert_eq!(reopened.waiting()[0].command, "git checkout --ours app.txt");
    }
}
