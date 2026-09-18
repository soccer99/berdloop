//! One merge at a time, per ticket.
//!
//! Workers run in parallel, but a merge is different: two agents resolving
//! conflicts against the same ticket branch at once would each be fixing a
//! target the other is still moving. So a worker takes a place in line, waits
//! its turn, merges, then gives the place up.
//!
//! The line lives on disk, not in memory, because the workers that use it are
//! separate processes. It also has to outlive the window being closed.
//!
//! One file per waiting worker:
//!
//! ```text
//! <staging root>/merge-queue/<nanoseconds>-<task id>.slot
//! ```
//!
//! Sorting the names gives first in, first out. The oldest holds the lock.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// A worker that holds the lock this long without finishing is assumed dead.
///
/// ponytail: fixed timeout, replace with a heartbeat if workers ever run
/// merges longer than this.
const MAX_HOLD_SECS: u64 = 30 * 60;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    pub task_id: String,
    /// 0 means it is this worker's turn right now.
    pub position: usize,
    pub holder: bool,
    /// How many workers are in the line, this one included.
    pub waiting: usize,
}

fn file_name(task_id: &str) -> String {
    task_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// The waiting line for one ticket.
pub struct Queue {
    dir: PathBuf,
}

impl Queue {
    /// `root` is the ticket's own queue directory.
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Everyone in line, oldest first. Abandoned places are dropped.
    pub fn line(&self) -> Vec<String> {
        let Ok(entries) = self.dir.read_dir() else {
            return Vec::new();
        };
        let mut slots: Vec<(String, PathBuf, String)> = entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                let name = path
                    .file_name()?
                    .to_str()?
                    .strip_suffix(".slot")?
                    .to_string();
                let (stamp, task) = name.split_once('-')?;
                Some((stamp.to_string(), path, task.to_string()))
            })
            .collect();
        slots.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.2.cmp(&b.2)));

        // Only the holder can be stale. A worker further back is simply
        // waiting, however long it has been there.
        if let Some((_, path, _)) = slots.first() {
            if age_secs(path) > MAX_HOLD_SECS {
                let _ = std::fs::remove_file(path);
                slots.remove(0);
            }
        }
        slots.into_iter().map(|(_, _, task)| task).collect()
    }

    fn slot(&self, task_id: &str, line: &[String]) -> Slot {
        let task = file_name(task_id);
        let position = line.iter().position(|id| *id == task).unwrap_or(0);
        Slot {
            task_id: task,
            position,
            holder: position == 0,
            waiting: line.len(),
        }
    }

    /// Join the line, or report the place already held.
    ///
    /// Asking twice is safe. A worker that retries keeps its original place
    /// rather than going to the back.
    pub fn acquire(&self, task_id: &str) -> Result<Slot, String> {
        let task = file_name(task_id);
        let line = self.line();
        if !line.contains(&task) {
            std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos();
            let path = self.dir.join(format!("{stamp:020}-{task}.slot"));
            // create_new fails rather than overwriting, so two workers racing
            // can never end up sharing one place.
            std::fs::File::create(&path).map_err(|e| e.to_string())?;
        }
        let line = self.line();
        Ok(self.slot(task_id, &line))
    }

    /// Give up the place. Returns the worker whose turn it now is.
    ///
    /// A worker that leaves while still waiting simply drops out, so an
    /// abandoned task never blocks the ones behind it.
    pub fn release(&self, task_id: &str) -> Option<String> {
        let task = file_name(task_id);
        if let Ok(entries) = self.dir.read_dir() {
            for entry in entries.flatten() {
                let path = entry.path();
                let matches = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .and_then(|n| n.strip_suffix(".slot"))
                    .and_then(|n| n.split_once('-').map(|(_, t)| t == task))
                    .unwrap_or(false);
                if matches {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        self.line().into_iter().next()
    }

    /// Say the holder is still alive, so it is not reaped mid-merge.
    pub fn touch(&self, task_id: &str) {
        let task = file_name(task_id);
        if let Ok(entries) = self.dir.read_dir() {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.to_string_lossy().contains(&format!("-{task}.slot")) {
                    let _ = filetime_now(&path);
                }
            }
        }
    }
}

fn age_secs(path: &Path) -> u64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Rewrite the file's contents to move its modification time forward.
fn filetime_now(path: &Path) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().write(true).open(path)?;
    file.write_all(b"alive")?;
    file.sync_all()
}

/// Who is waiting to merge on this ticket, oldest first.
///
/// The app only reads the line. Joining and leaving it belongs to the
/// workers, through the `berdloop-worker` command.
#[tauri::command]
pub fn merge_line(
    app: tauri::AppHandle,
    project_id: String,
    ticket: String,
) -> Result<Vec<String>, String> {
    let staging = crate::git::staging_for(&app, &project_id)?;
    Ok(Queue::new(staging.queue_dir(&ticket)).line())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn queue() -> Queue {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("berdloop-queue-{n}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Queue::new(dir)
    }

    #[test]
    fn the_first_worker_in_line_holds_the_lock() {
        let queue = queue();
        let first = queue.acquire("a").unwrap();
        assert!(first.holder);
        assert_eq!(first.position, 0);

        let second = queue.acquire("b").unwrap();
        assert!(!second.holder);
        assert_eq!(second.position, 1);
        assert_eq!(second.waiting, 2);
    }

    #[test]
    fn asking_twice_keeps_the_original_place() {
        let queue = queue();
        queue.acquire("a").unwrap();
        queue.acquire("b").unwrap();
        assert_eq!(queue.acquire("b").unwrap().position, 1);
        assert_eq!(queue.line(), ["a", "b"]);
    }

    #[test]
    fn releasing_promotes_the_next_worker() {
        let queue = queue();
        queue.acquire("a").unwrap();
        queue.acquire("b").unwrap();
        assert_eq!(queue.release("a"), Some("b".to_string()));
        assert!(queue.acquire("b").unwrap().holder);
    }

    #[test]
    fn a_worker_that_leaves_while_waiting_does_not_block_the_line() {
        let queue = queue();
        for task in ["a", "b", "c"] {
            queue.acquire(task).unwrap();
        }
        queue.release("b");
        assert_eq!(queue.line(), ["a", "c"]);
        assert_eq!(queue.release("a"), Some("c".to_string()));
    }

    #[test]
    fn an_empty_line_is_forgotten() {
        let queue = queue();
        queue.acquire("a").unwrap();
        assert_eq!(queue.release("a"), None);
        assert!(queue.line().is_empty());
        assert_eq!(queue.release("ghost"), None);
    }

    #[test]
    fn a_line_read_before_anyone_joins_is_empty() {
        // The directory does not exist yet. That is not an error.
        assert!(queue().line().is_empty());
    }

    #[test]
    fn the_line_survives_a_restart() {
        let queue = queue();
        queue.acquire("a").unwrap();
        queue.acquire("b").unwrap();
        // A second process reading the same directory sees the same line.
        let reopened = Queue::new(queue.dir.clone());
        assert_eq!(reopened.line(), ["a", "b"]);
        assert!(reopened.acquire("a").unwrap().holder);
    }

    #[test]
    fn a_dead_holder_is_reaped_so_the_line_can_move() {
        let queue = queue();
        queue.acquire("dead").unwrap();
        queue.acquire("alive").unwrap();

        // Age the holder's slot past the limit.
        let stale = queue
            .dir
            .read_dir()
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .find(|p| p.to_string_lossy().contains("-dead.slot"))
            .unwrap();
        let old = SystemTime::now() - std::time::Duration::from_secs(MAX_HOLD_SECS + 60);
        set_modified(&stale, old);

        assert_eq!(queue.line(), ["alive"]);
        assert!(queue.acquire("alive").unwrap().holder);
    }

    #[test]
    fn a_waiting_worker_is_never_reaped_for_being_patient() {
        let queue = queue();
        queue.acquire("holder").unwrap();
        queue.acquire("patient").unwrap();

        let waiting = queue
            .dir
            .read_dir()
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .find(|p| p.to_string_lossy().contains("-patient.slot"))
            .unwrap();
        let old = SystemTime::now() - std::time::Duration::from_secs(MAX_HOLD_SECS * 4);
        set_modified(&waiting, old);

        // Only the holder can go stale. Waiting a long time is normal.
        assert_eq!(queue.line(), ["holder", "patient"]);
    }

    fn set_modified(path: &Path, when: SystemTime) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(when).unwrap();
    }
}
