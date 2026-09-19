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
//! One file per merge attempt:
//!
//! ```text
//! <staging root>/merge-queue/<ticket>/<nanoseconds>-<task id>.<ending>
//! ```
//!
//! Only `.slot` waits for a turn. Sorting the names gives first in, first
//! out, and the oldest `.slot` holds the lock.
//!
//! Nothing here is ever deleted. An attempt that landed, gave up or died is
//! renamed, not removed, so the directory is the ticket's whole merge history
//! and can be read back weeks later:
//!
//! | ending       | what happened                                   |
//! |--------------|-------------------------------------------------|
//! | `.slot`      | still in the line, or merging right now          |
//! | `.merged`    | landed on the ticket branch                      |
//! | `.left`      | gave up its turn without landing                 |
//! | `.abandoned` | held the turn until it was assumed dead          |
//!
//! The holder writes a word inside its own `.slot` file to say what it is
//! doing, which is how a conflict resolution shows up as more than a gap.

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

/// One merge attempt, finished or not.
///
/// Every attempt stays here rather than vanishing, whatever became of it: the
/// directory is the record of what happened to this ticket, and a merge that
/// was abandoned says as much as one that landed. Only `.slot` files decide
/// whose turn it is, so a kept entry can never hold up the workers behind it.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub task_id: String,
    /// `waiting`, `merging`, `conflict`, `merged`, `left` or `abandoned`.
    pub status: &'static str,
    /// When this attempt joined the line. Milliseconds since the epoch.
    pub at: u64,
}

/// Endings a place is renamed to when it leaves the line. Kept, never counted.
const MERGED: &str = "merged";
const LEFT: &str = "left";
const ABANDONED: &str = "abandoned";

/// What the holder writes in its slot file while it resolves conflicts.
const CONFLICT: &str = "conflict";

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
    fn lock(&self) -> Result<std::fs::File, String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.dir.join("queue.lock"))
            .map_err(|e| e.to_string())?;
        file.lock().map_err(|e| e.to_string())?;
        Ok(file)
    }

    pub fn line(&self) -> Vec<String> {
        let Ok(_lock) = self.lock() else {
            return Vec::new();
        };
        self.line_locked()
    }

    fn line_locked(&self) -> Vec<String> {
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

        // Ownership starts on promotion, independently of time spent waiting.
        let holder_file = self.dir.join("holder");
        let previous = std::fs::read_to_string(&holder_file).unwrap_or_default();
        if let Some((_, path, task)) = slots.first() {
            if previous == *task
                && age_secs(path) > MAX_HOLD_SECS
                && std::fs::rename(path, path.with_extension(ABANDONED)).is_ok()
            {
                slots.remove(0);
            }
        }
        let next = slots
            .first()
            .map(|(_, _, task)| task.as_str())
            .unwrap_or("");
        if previous != next {
            if let Some((_, path, _)) = slots.first() {
                // Fail closed if promotion cannot be persisted.
                if filetime_now(path).is_err() {
                    return Vec::new();
                }
            }
            if std::fs::write(&holder_file, next).is_err() {
                return Vec::new();
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
    /// Everyone this ticket's merge queue has seen, oldest first.
    ///
    /// The app shows this. Workers only ever ask about `line`, which is the
    /// part that decides turns.
    pub fn entries(&self) -> Vec<Entry> {
        let Ok(_lock) = self.lock() else {
            return Vec::new();
        };
        let waiting = self.line_locked();
        let holder = waiting.first().cloned().unwrap_or_default();
        let Ok(read) = self.dir.read_dir() else {
            return Vec::new();
        };
        let mut all: Vec<(String, Entry)> = read
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                let (name, ending) = path.file_name()?.to_str()?.rsplit_once('.')?;
                let (stamp, task) = name.split_once('-')?;
                let status = match ending {
                    MERGED => "merged",
                    LEFT => "left",
                    ABANDONED => "abandoned",
                    "slot" if state(&path) == CONFLICT => "conflict",
                    "slot" if task == holder => "merging",
                    "slot" => "waiting",
                    // queue.lock, holder, and anything else that is not a place.
                    _ => return None,
                };
                Some((
                    stamp.to_string(),
                    Entry {
                        task_id: task.to_string(),
                        status,
                        at: joined_at(stamp),
                    },
                ))
            })
            .collect();
        all.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.task_id.cmp(&b.1.task_id)));
        all.into_iter().map(|(_, entry)| entry).collect()
    }

    /// Give up the place, having landed. The place is kept, marked merged.
    pub fn release_merged(&self, task_id: &str) -> Option<String> {
        self.leave(task_id, true)
    }

    /// Asking twice is safe. A worker that retries keeps its original place
    /// rather than going to the back.
    pub fn acquire(&self, task_id: &str) -> Result<Slot, String> {
        let _lock = self.lock()?;
        let task = file_name(task_id);
        let line = self.line_locked();
        if !line.contains(&task) {
            // A reopened task joins again and keeps every earlier attempt
            // beside the new one, newest last. Two rows for one task is the
            // truth: it merged twice.
            std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos();
            let path = self.dir.join(format!("{stamp:020}-{task}.slot"));
            // create_new fails rather than overwriting, so two workers racing
            // can never end up sharing one place.
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|e| e.to_string())?;
        }
        let line = self.line_locked();
        if !line.contains(&task) {
            return Err("Could not persist merge ownership".into());
        }
        Ok(self.slot(task_id, &line))
    }

    /// Give up the place. Returns the worker whose turn it now is.
    ///
    /// A worker that leaves while still waiting simply drops out, so an
    /// abandoned task never blocks the ones behind it.
    pub fn release(&self, task_id: &str) -> Option<String> {
        self.leave(task_id, false)
    }

    /// Take a task out of the running, keeping the place either way. A worker
    /// that gave up is as much a part of the ticket's history as one that
    /// landed, so it is renamed, never removed.
    fn leave(&self, task_id: &str, merged: bool) -> Option<String> {
        let _lock = self.lock().ok()?;
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
                if !matches {
                    continue;
                }
                let ending = if merged { MERGED } else { LEFT };
                let _ = std::fs::rename(&path, path.with_extension(ending));
            }
        }
        self.line_locked().into_iter().next()
    }

    /// Record what the holder is doing inside its turn.
    ///
    /// A conflict resolution can take longer than the merge itself. Without
    /// this the record shows only a gap between joining and landing, so the
    /// one part a person most wants to read back is the part not written down.
    fn mark(&self, task_id: &str, doing: &str) {
        let Ok(_lock) = self.lock() else {
            return;
        };
        let task = file_name(task_id);
        if let Ok(entries) = self.dir.read_dir() {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.to_string_lossy().ends_with(&format!("-{task}.slot")) {
                    let _ = write_state(&path, doing);
                }
            }
        }
    }

    /// Say whether the holder is resolving conflicts right now.
    pub fn conflicted(&self, task_id: &str, yes: bool) {
        self.mark(task_id, if yes { CONFLICT } else { "" });
    }

    /// Say the holder is still alive, so it is not reaped mid-merge.
    pub fn touch(&self, task_id: &str) {
        let Ok(_lock) = self.lock() else {
            return;
        };
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

/// Move the file's modification time forward without losing what it says.
fn filetime_now(path: &Path) -> std::io::Result<()> {
    write_state(path, &state(path))
}

/// What the holder last said it was doing. Empty until it says anything.
fn state(path: &Path) -> String {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Rewrite the whole file, which also moves its modification time forward.
fn write_state(path: &Path, doing: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)?;
    file.write_all(if doing.is_empty() { "alive" } else { doing }.as_bytes())?;
    file.sync_all()
}

/// When a place joined the line, from the nanoseconds in its name.
fn joined_at(stamp: &str) -> u64 {
    stamp
        .parse::<u128>()
        .map(|nanos| (nanos / 1_000_000) as u64)
        .unwrap_or(0)
}

/// Who is waiting to merge on this ticket, oldest first.
///
/// The app only reads the line. Joining and leaving it belongs to the
/// workers, through the `berdloop-worker` command.
#[tauri::command]
pub async fn merge_line(
    app: tauri::AppHandle,
    project_id: String,
    ticket: String,
) -> Result<Vec<Entry>, String> {
    crate::offload(move || merge_line_blocking(app, project_id, ticket)).await
}

fn merge_line_blocking(
    app: tauri::AppHandle,
    project_id: String,
    ticket: String,
) -> Result<Vec<Entry>, String> {
    let staging = crate::git::staging_for(&app, &project_id)?;
    Ok(Queue::new(staging.queue_dir(&ticket)).entries())
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

    /// Task ids are UUIDs, which are full of the separator the file names use.
    /// The record is what the window shows, so it must survive a real one.
    #[test]
    fn a_uuid_task_keeps_its_record_when_it_leaves() {
        let queue = queue();
        let task = "ec2cf859-7a79-4ed3-814b-a78834adcac5";
        queue.acquire(task).unwrap();
        queue.release_merged(task);
        assert_eq!(
            queue
                .entries()
                .into_iter()
                .map(|e| (e.task_id, e.status))
                .collect::<Vec<_>>(),
            [(task.to_string(), "merged")]
        );
        assert!(queue.line().is_empty());
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

    /// Every attempt stays on the record, whatever became of it. This is what
    /// a person reads back weeks later, so nothing may go missing from it.
    #[test]
    fn every_attempt_stays_on_the_record() {
        let queue = queue();
        for task in ["a", "b", "c"] {
            queue.acquire(task).unwrap();
        }
        let shown = |q: &Queue| {
            q.entries()
                .into_iter()
                .map(|e| (e.task_id, e.status))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            shown(&queue),
            [
                ("a".into(), "merging"),
                ("b".into(), "waiting"),
                ("c".into(), "waiting"),
            ]
        );

        // "a" lands. It keeps its place, and "b" is promoted behind it.
        assert_eq!(queue.release_merged("a"), Some("b".to_string()));
        assert_eq!(queue.line(), ["b", "c"], "a no longer waits for a turn");
        assert_eq!(
            shown(&queue),
            [
                ("a".into(), "merged"),
                ("b".into(), "merging"),
                ("c".into(), "waiting"),
            ]
        );

        // "b" gives up without landing. It is kept, and marked as what it was.
        assert_eq!(queue.release("b"), Some("c".to_string()));
        assert_eq!(
            shown(&queue),
            [
                ("a".into(), "merged"),
                ("b".into(), "left"),
                ("c".into(), "merging"),
            ]
        );

        // "c" resolves conflicts before it lands. The record says so while it
        // is happening, rather than showing a gap.
        queue.conflicted("c", true);
        assert_eq!(
            shown(&queue),
            [
                ("a".into(), "merged"),
                ("b".into(), "left"),
                ("c".into(), "conflict"),
            ]
        );

        // A reopened task merges a second time. Both attempts are listed, in
        // the order they ran: two rows for one task is the truth.
        assert!(!queue.acquire("a").unwrap().holder);
        assert_eq!(
            shown(&queue),
            [
                ("a".into(), "merged"),
                ("b".into(), "left"),
                ("c".into(), "conflict"),
                ("a".into(), "waiting"),
            ]
        );
    }

    /// The record outlives the app. A ticket reviewed weeks later reads the
    /// same directory, with the times each attempt joined the line.
    #[test]
    fn the_record_survives_and_is_dated() {
        let queue = queue();
        queue.acquire("a").unwrap();
        queue.release_merged("a");
        queue.acquire("b").unwrap();
        queue.release("b");

        let reopened = Queue::new(queue.dir.clone());
        let entries = reopened.entries();
        assert_eq!(
            entries
                .iter()
                .map(|e| (e.task_id.as_str(), e.status))
                .collect::<Vec<_>>(),
            [("a", "merged"), ("b", "left")],
            "nothing waits for a turn, and nothing is gone"
        );
        assert!(reopened.line().is_empty());
        assert!(entries[0].at > 0 && entries[1].at >= entries[0].at);
    }

    /// A holder assumed dead stops blocking the line, but is still recorded.
    #[test]
    fn a_reaped_holder_is_kept_as_abandoned() {
        let queue = queue();
        queue.acquire("dead").unwrap();
        queue.acquire("next").unwrap();
        let old = SystemTime::now() - std::time::Duration::from_secs(MAX_HOLD_SECS + 60);
        set_modified(&slot_path(&queue, "dead"), old);

        assert_eq!(queue.line(), ["next"]);
        assert_eq!(
            queue
                .entries()
                .into_iter()
                .map(|e| (e.task_id, e.status))
                .collect::<Vec<_>>(),
            [("dead".into(), "abandoned"), ("next".into(), "merging")]
        );
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
        assert_eq!(queue.release("holder").as_deref(), Some("patient"));
        assert!(queue.acquire("patient").unwrap().holder);
    }

    fn slot_path(queue: &Queue, task: &str) -> PathBuf {
        queue
            .dir
            .read_dir()
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .find(|p| p.to_string_lossy().contains(&format!("-{task}.slot")))
            .unwrap()
    }

    #[test]
    fn a_promoted_worker_keeps_its_turn_even_when_every_slot_is_old() {
        let queue = queue();
        queue.acquire("dead").unwrap();
        queue.acquire("patient").unwrap();
        let old = SystemTime::now() - std::time::Duration::from_secs(MAX_HOLD_SECS * 4);
        set_modified(&slot_path(&queue, "dead"), old);
        set_modified(&slot_path(&queue, "patient"), old);

        // The dead holder is reaped; the patient one is promoted with a fresh
        // clock, so the very next read must not reap it too.
        assert_eq!(queue.line(), ["patient"]);
        assert_eq!(queue.line(), ["patient"]);
        assert!(queue.acquire("patient").unwrap().holder);
        assert!(age_secs(&slot_path(&queue, "patient")) < MAX_HOLD_SECS);
    }

    #[test]
    fn racing_workers_never_share_a_place() {
        let queue = queue();
        let dir = queue.dir.clone();
        let workers: Vec<_> = (0..8)
            .map(|n| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    let queue = Queue::new(dir);
                    for _ in 0..5 {
                        queue.acquire(&format!("w{n}")).unwrap();
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        let line = queue.line();
        assert_eq!(line.len(), 8, "{line:?}");
        let mut unique = line.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), 8);
        // Exactly one holder, and it stays the holder across reads.
        let holders = line
            .iter()
            .filter(|t| queue.acquire(t).unwrap().holder)
            .count();
        assert_eq!(holders, 1);
    }

    #[test]
    fn a_line_that_cannot_be_locked_grants_nobody_a_turn() {
        // A file where the directory should be: the lock cannot be created.
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path =
            std::env::temp_dir().join(format!("berdloop-queue-file-{n}-{}", std::process::id()));
        std::fs::write(&path, b"not a directory").unwrap();
        let queue = Queue::new(path.clone());
        assert!(queue.acquire("a").is_err());
        assert!(queue.line().is_empty());
        assert_eq!(queue.release("a"), None);
        std::fs::remove_file(path).unwrap();
    }

    fn set_modified(path: &Path, when: SystemTime) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(when).unwrap();
    }
}
