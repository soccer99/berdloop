//! A private staging repository, so agents never touch the user's checkout.
//!
//! Git is already distributed, so no server is needed. A bare repository on
//! disk is a complete remote: it can be cloned, fetched, pushed and merged
//! through a plain file path.
//!
//! Layout under the app data directory:
//!
//! ```text
//! repos/<project id>/
//!   staging.git              bare, the shared integration point
//!   integration/<ticket>/    worktree holding the ticket branch
//!   work/<task id>/          worktree for one worker, isolated
//! ```
//!
//! The user's own repository is read once when the project is prepared, and
//! written only when a finished ticket is published.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Branch that collects the finished work for one ticket.
fn ticket_branch(ticket: &str) -> String {
    format!("berdloop/{}", safe_ref(ticket))
}

/// Branch one worker commits to.
///
/// Git stores references as directories, so a task branch may not sit under a
/// ticket branch: `berdloop/PROJ-1` being a file blocks `berdloop/PROJ-1/task`.
/// Worker branches therefore live in their own namespace.
fn task_branch(ticket: &str, task_id: &str) -> String {
    format!("berdloop-work/{}/{}", safe_ref(ticket), safe_ref(task_id))
}

/// Make a string usable inside a git reference name.
fn safe_ref(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(['-', '.']).to_string();
    if trimmed.is_empty() {
        "item".to_string()
    } else {
        trimmed
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub staging: String,
    pub base_branch: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub merged: bool,
    /// Files git could not merge on its own. Empty when `merged` is true.
    pub conflicts: Vec<String>,
    pub detail: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketStatus {
    pub branch: String,
    pub commits: usize,
    pub files_changed: usize,
    pub summary: String,
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git could not run: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Run git where a non-zero exit is an expected answer, not a failure.
fn git_try(dir: &Path, args: &[&str]) -> (bool, String) {
    match Command::new("git").args(args).current_dir(dir).output() {
        Ok(out) => {
            let mut text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let errors = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if !errors.is_empty() {
                text = format!("{text}\n{errors}").trim().to_string();
            }
            (out.status.success(), text)
        }
        Err(e) => (false, format!("git could not run: {e}")),
    }
}

/// One project's private staging area.
pub struct Staging {
    pub root: PathBuf,
}

impl Staging {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// Find the staging area a worker is standing in.
    ///
    /// A worktree always lives at `<root>/work/<task>`, so the root is two
    /// levels up. Checking for `staging.git` proves it, which means a worker
    /// needs no environment variable and no argument to find its way home.
    pub fn locate(from: &Path) -> Option<(Staging, String)> {
        let task = from.file_name()?.to_str()?.to_string();
        let root = from.parent()?.parent()?.to_path_buf();
        if !root.join("staging.git").exists() {
            return None;
        }
        Some((Staging::new(root), task))
    }

    /// Where the merge queue for one ticket keeps its files.
    pub fn queue_dir(&self, ticket: &str) -> PathBuf {
        self.root.join("merge-queue").join(safe_ref(ticket))
    }

    /// The ticket a task belongs to, written when its worktree was made.
    pub fn ticket_of(&self, task_id: &str) -> Result<String, String> {
        let path = self
            .root
            .join("tasks")
            .join(format!("{}.txt", safe_ref(task_id)));
        std::fs::read_to_string(path)
            .map(|text| text.trim().to_string())
            .map_err(|_| format!("Task {task_id} has no worktree in this project."))
    }

    /// Where a worker records what happened, for the app to read.
    pub fn reports(&self) -> PathBuf {
        self.root.join("reports.jsonl")
    }

    /// A completed report is valid only after the worker's commit reached the ticket.
    pub fn task_landed(&self, ticket: &str, task_id: &str) -> Result<bool, String> {
        let branch = task_branch(ticket, task_id);
        let target = ticket_branch(ticket);
        let bare = self.bare();
        if git(&bare, &["rev-parse", "--verify", "--quiet", &branch]).is_err() {
            return Ok(false);
        }
        Ok(git_try(&bare, &["merge-base", "--is-ancestor", &branch, &target]).0)
    }

    pub fn append_report(
        &self,
        ticket: &str,
        task: &str,
        status: &str,
        detail: &str,
        run_id: &str,
    ) -> Result<(), String> {
        let line = serde_json::json!({
            "ticket": ticket,
            "task": task,
            "status": status,
            "detail": detail,
            "runId": run_id,
            "at": crate::human::now_ms(),
        });
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.reports())
            .map_err(|e| e.to_string())?;
        writeln!(file, "{line}").map_err(|e| e.to_string())
    }

    pub fn has_report_for_run(&self, task: &str, run_id: &str) -> bool {
        std::fs::read_to_string(self.reports())
            .ok()
            .is_some_and(|text| {
                text.lines().any(|line| {
                    serde_json::from_str::<serde_json::Value>(line)
                        .ok()
                        .is_some_and(|report| {
                            report["task"].as_str() == Some(task)
                                && report["runId"].as_str() == Some(run_id)
                        })
                })
            })
    }

    fn bare(&self) -> PathBuf {
        self.root.join("staging.git")
    }

    fn integration(&self, ticket: &str) -> PathBuf {
        self.root.join("integration").join(safe_ref(ticket))
    }

    fn work(&self, task_id: &str) -> PathBuf {
        self.root.join("work").join(safe_ref(task_id))
    }

    /// Copy the user's repository into a private bare mirror.
    ///
    /// Nothing is written to the source. Its working tree, its index and its
    /// checked out branch are all left exactly as they were.
    pub fn prepare(&self, source: &Path) -> Result<Prepared, String> {
        if !source.join(".git").exists() && git(source, &["rev-parse", "--git-dir"]).is_err() {
            return Err(format!("{} is not a git repository.", source.display()));
        }
        let base = git(source, &["symbolic-ref", "--short", "HEAD"])
            .map_err(|_| "The project repository has no branch checked out.".to_string())?;

        let bare = self.bare();
        if !bare.exists() {
            std::fs::create_dir_all(&bare).map_err(|e| e.to_string())?;
            git(&bare, &["init", "--bare", "--quiet"])?;
            git(
                &bare,
                &["remote", "add", "origin", &source.to_string_lossy()],
            )?;
        }
        // Refresh from the source every time, so a worker always branches
        // from what the user has actually committed.
        git(&bare, &["fetch", "--quiet", "origin"])?;

        Ok(Prepared {
            staging: bare.to_string_lossy().into_owned(),
            base_branch: base,
        })
    }

    /// Open the ticket's collecting branch and its worktree.
    pub fn start_ticket(&self, ticket: &str, base_branch: &str) -> Result<Worktree, String> {
        let bare = self.bare();
        let branch = ticket_branch(ticket);
        let path = self.integration(ticket);

        if git(&bare, &["rev-parse", "--verify", "--quiet", &branch]).is_err() {
            let start = format!("origin/{base_branch}");
            git(&bare, &["branch", &branch, &start])?;
        }
        if !path.exists() {
            std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
            git(
                &bare,
                &[
                    "worktree",
                    "add",
                    "--quiet",
                    &path.to_string_lossy(),
                    &branch,
                ],
            )?;
        }
        Ok(Worktree {
            path: path.to_string_lossy().into_owned(),
            branch,
        })
    }

    /// Give one worker its own branch and directory.
    ///
    /// Workers never share a worktree, so two agents cannot overwrite each
    /// other's files or fight over one git index.
    pub fn open_task(&self, ticket: &str, task_id: &str) -> Result<Worktree, String> {
        let bare = self.bare();
        let branch = task_branch(ticket, task_id);
        let path = self.work(task_id);

        // A worker only knows its own task id, so record the ticket next to
        // the staging area for it to look up later.
        let notes = self.root.join("tasks");
        std::fs::create_dir_all(&notes).map_err(|e| e.to_string())?;
        std::fs::write(notes.join(format!("{}.txt", safe_ref(task_id))), ticket)
            .map_err(|e| e.to_string())?;

        if path.exists() {
            return Ok(Worktree {
                path: path.to_string_lossy().into_owned(),
                branch,
            });
        }
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        let from = ticket_branch(ticket);
        git(
            &bare,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                &branch,
                &path.to_string_lossy(),
                &from,
            ],
        )?;
        Ok(Worktree {
            path: path.to_string_lossy().into_owned(),
            branch,
        })
    }

    /// Files git could not merge on its own, still awaiting a human or agent.
    fn unresolved(&self, path: &Path) -> Vec<String> {
        git(path, &["diff", "--name-only", "--diff-filter=U"])
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// Commit whatever the worker left behind. Agents forget to commit.
    ///
    /// It refuses while a merge is still conflicted. Staging everything with
    /// `add -A` during a conflict would commit the markers themselves and
    /// call the merge resolved, which would then fast forward straight onto
    /// the ticket branch. Every caller goes through here, so one guard covers
    /// them all.
    pub fn commit_task(&self, task_id: &str, message: &str) -> Result<bool, String> {
        let path = self.work(task_id);
        if !path.exists() {
            return Err("That task has no worktree.".to_string());
        }
        let stuck = self.unresolved(&path);
        if !stuck.is_empty() {
            return Err(format!(
                "Resolve these conflicted files before committing:\n{}",
                stuck.join("\n")
            ));
        }
        if git(&path, &["status", "--porcelain"])?.is_empty() {
            return Ok(false);
        }
        git(&path, &["add", "-A"])?;
        git(&path, &["commit", "--quiet", "-m", message])?;
        Ok(true)
    }

    /// Bring the ticket's current state down into the worker's own worktree.
    ///
    /// This is the first half of a merge queue turn. Conflicts are left in
    /// place on purpose: the worker fixes them in its own directory, where no
    /// other agent is working, and nothing has touched the ticket branch yet.
    /// A failed sync therefore costs nobody else anything.
    pub fn sync_from_ticket(&self, ticket: &str, task_id: &str) -> Result<MergeOutcome, String> {
        let path = self.work(task_id);
        if !path.exists() {
            return Err("That task has no worktree.".to_string());
        }
        let into = ticket_branch(ticket);
        let (ok, detail) = git_try(
            &path,
            &["merge", "--no-edit", "-m", &format!("Merge {into}"), &into],
        );
        if ok {
            return Ok(MergeOutcome {
                merged: true,
                conflicts: Vec::new(),
                detail,
            });
        }
        let conflicts = git(&path, &["diff", "--name-only", "--diff-filter=U"])
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect();
        Ok(MergeOutcome {
            merged: false,
            conflicts,
            detail,
        })
    }

    /// Move the ticket branch forward onto the worker's finished branch.
    ///
    /// This is the second half of a merge queue turn. Because the worker has
    /// already merged the ticket into itself, this can only ever be a fast
    /// forward, so the ticket branch cannot end up in a conflicted state. The
    /// `--ff-only` flag makes that a rule rather than a hope: if the ticket
    /// moved while this worker was resolving, the landing is refused and the
    /// worker syncs again.
    pub fn land(&self, ticket: &str, task_id: &str) -> Result<MergeOutcome, String> {
        let path = self.work(task_id);
        let into = self.integration(ticket);
        if !into.exists() {
            return Err("Open the ticket before landing work on it.".to_string());
        }
        let unresolved = self.unresolved(&path);
        if !unresolved.is_empty() {
            return Ok(MergeOutcome {
                merged: false,
                conflicts: unresolved,
                detail: "Conflicts are still unresolved in the worktree.".to_string(),
            });
        }
        if !git(&path, &["status", "--porcelain"])?.is_empty() {
            return Ok(MergeOutcome {
                merged: false,
                conflicts: Vec::new(),
                detail: "The worktree has uncommitted changes.".to_string(),
            });
        }

        let branch = task_branch(ticket, task_id);
        let (ok, detail) = git_try(&into, &["merge", "--ff-only", &branch]);
        Ok(MergeOutcome {
            merged: ok,
            conflicts: Vec::new(),
            detail: if ok {
                detail
            } else {
                format!("{detail}\nThe ticket moved. Sync again and retry.")
            },
        })
    }

    /// Drop a finished worker's directory and its branch.
    ///
    /// A task branch is scratch space. Once it is merged into the ticket the
    /// merge commit holds the history, so the branch itself is removed and
    /// never reaches the user's repository. The worktree goes first, because
    /// git will not delete a branch that is still checked out somewhere.
    pub fn close_task(&self, ticket: &str, task_id: &str) -> Result<(), String> {
        let bare = self.bare();
        let path = self.work(task_id);
        if path.exists() {
            git(
                &bare,
                &["worktree", "remove", "--force", &path.to_string_lossy()],
            )?;
        }
        let branch = task_branch(ticket, task_id);
        if git(&bare, &["rev-parse", "--verify", "--quiet", &branch]).is_ok() {
            git(&bare, &["branch", "-D", &branch])?;
        }
        Ok(())
    }

    pub fn ticket_status(&self, ticket: &str, base_branch: &str) -> Result<TicketStatus, String> {
        let bare = self.bare();
        let branch = ticket_branch(ticket);
        let range = format!("origin/{base_branch}..{branch}");
        let commits = git(&bare, &["rev-list", "--count", &range])
            .unwrap_or_default()
            .parse()
            .unwrap_or(0);
        let files = git(&bare, &["diff", "--name-only", &range]).unwrap_or_default();
        let files_changed = files.lines().filter(|l| !l.is_empty()).count();
        Ok(TicketStatus {
            branch,
            commits,
            files_changed,
            summary: git(&bare, &["diff", "--stat", &range]).unwrap_or_default(),
        })
    }

    /// Push the finished ticket to the user's repository as one new branch.
    ///
    /// This is the last step of a ticket and the only write that ever reaches
    /// the real project. Per-task branches never travel: they are deleted by
    /// `close_task` long before this runs, so a ticket arrives as a single
    /// branch to open a pull request from. It refuses to touch the branch the
    /// user has checked out.
    pub fn publish(
        &self,
        ticket: &str,
        remote_branch: &str,
        protected: &str,
    ) -> Result<String, String> {
        let target = safe_ref(remote_branch);
        if target == safe_ref(protected) {
            return Err(format!("Refusing to push onto {protected}."));
        }
        let refspec = format!("{}:refs/heads/{target}", ticket_branch(ticket));
        git(&self.bare(), &["push", "origin", &refspec])?;
        Ok(target)
    }
}

pub fn staging_for(app: &tauri::AppHandle, project_id: &str) -> Result<Staging, String> {
    use tauri::Manager;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not find the app data directory.".to_string())?
        .join("repos")
        .join(safe_ref(project_id));
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(Staging::new(root))
}

#[tauri::command]
pub fn git_prepare(
    app: tauri::AppHandle,
    project_id: String,
    source: String,
) -> Result<Prepared, String> {
    staging_for(&app, &project_id)?.prepare(Path::new(&source))
}

#[tauri::command]
pub fn git_start_ticket(
    app: tauri::AppHandle,
    project_id: String,
    ticket: String,
    base_branch: String,
) -> Result<Worktree, String> {
    staging_for(&app, &project_id)?.start_ticket(&ticket, &base_branch)
}

#[tauri::command]
pub fn git_open_task(
    app: tauri::AppHandle,
    project_id: String,
    ticket: String,
    task_id: String,
) -> Result<Worktree, String> {
    staging_for(&app, &project_id)?.open_task(&ticket, &task_id)
}

#[tauri::command]
pub fn git_sync_from_ticket(
    app: tauri::AppHandle,
    project_id: String,
    ticket: String,
    task_id: String,
    message: String,
) -> Result<MergeOutcome, String> {
    let staging = staging_for(&app, &project_id)?;
    staging.commit_task(&task_id, &message)?;
    staging.sync_from_ticket(&ticket, &task_id)
}

#[tauri::command]
pub fn git_land(
    app: tauri::AppHandle,
    project_id: String,
    ticket: String,
    task_id: String,
    message: String,
) -> Result<MergeOutcome, String> {
    let staging = staging_for(&app, &project_id)?;
    staging.commit_task(&task_id, &message)?;
    staging.land(&ticket, &task_id)
}

#[tauri::command]
pub fn git_close_task(
    app: tauri::AppHandle,
    project_id: String,
    ticket: String,
    task_id: String,
) -> Result<(), String> {
    staging_for(&app, &project_id)?.close_task(&ticket, &task_id)
}

#[tauri::command]
pub fn git_ticket_status(
    app: tauri::AppHandle,
    project_id: String,
    ticket: String,
    base_branch: String,
) -> Result<TicketStatus, String> {
    staging_for(&app, &project_id)?.ticket_status(&ticket, &base_branch)
}

/// What finished workers reported, oldest first.
///
/// Workers write these from their own processes through `berdloop-worker`, so
/// this is how the loop learns an outcome even if the window was closed while
/// the work ran.
#[tauri::command]
pub fn git_task_reports(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let path = staging_for(&app, &project_id)?.reports();
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(Vec::new());
    };
    Ok(text
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect())
}

#[tauri::command]
pub fn git_publish(
    app: tauri::AppHandle,
    project_id: String,
    ticket: String,
    remote_branch: String,
    protected: String,
) -> Result<String, String> {
    staging_for(&app, &project_id)?.publish(&ticket, &remote_branch, &protected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path =
            std::env::temp_dir().join(format!("berdloop-git-{label}-{n}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    /// A stand-in for the user's own project repository.
    fn source_repo() -> PathBuf {
        let dir = temp("source");
        git(&dir, &["init", "--quiet", "-b", "main"]).unwrap();
        git(&dir, &["config", "user.email", "test@test.test"]).unwrap();
        git(&dir, &["config", "user.name", "Test"]).unwrap();
        std::fs::write(dir.join("app.txt"), "one\ntwo\nthree\n").unwrap();
        git(&dir, &["add", "-A"]).unwrap();
        git(&dir, &["commit", "--quiet", "-m", "start"]).unwrap();
        dir
    }

    fn write(worktree: &str, name: &str, body: &str) {
        std::fs::write(Path::new(worktree).join(name), body).unwrap();
    }

    fn staging() -> Staging {
        Staging::new(temp("staging"))
    }

    /// One whole merge queue turn: sync down, then land.
    fn take_turn(staging: &Staging, ticket: &str, task: &str) -> MergeOutcome {
        staging.commit_task(task, "work").unwrap();
        let synced = staging.sync_from_ticket(ticket, task).unwrap();
        assert!(synced.merged, "sync failed: {}", synced.detail);
        staging.land(ticket, task).unwrap()
    }

    #[test]
    fn reference_names_are_made_safe() {
        assert_eq!(safe_ref("PROJ-12"), "PROJ-12");
        assert_eq!(safe_ref("feat/new thing"), "feat-new-thing");
        assert_eq!(safe_ref("--"), "item");
        assert_eq!(ticket_branch("PROJ-1"), "berdloop/PROJ-1");
        // A worker branch must not nest under the ticket branch.
        assert_eq!(task_branch("PROJ-1", "abc"), "berdloop-work/PROJ-1/abc");
    }

    #[test]
    fn preparing_never_writes_to_the_source() {
        let source = source_repo();
        let before = git(&source, &["rev-parse", "HEAD"]).unwrap();
        let ready = staging().prepare(&source).unwrap();

        assert_eq!(ready.base_branch, "main");
        assert_eq!(git(&source, &["rev-parse", "HEAD"]).unwrap(), before);
        // The source keeps a clean working tree and no extra branches.
        assert!(git(&source, &["status", "--porcelain"]).unwrap().is_empty());
        assert_eq!(
            git(&source, &["branch", "--list"]).unwrap().trim(),
            "* main"
        );
    }

    #[test]
    fn a_plain_directory_is_rejected() {
        assert!(staging().prepare(&temp("plain")).is_err());
    }

    #[test]
    fn a_worker_can_find_its_way_home_from_its_worktree() {
        let source = source_repo();
        let staging = staging();
        let ready = staging.prepare(&source).unwrap();
        staging.start_ticket("PROJ-8", &ready.base_branch).unwrap();
        let tree = staging.open_task("PROJ-8", "lost").unwrap();

        let (found, task) = Staging::locate(Path::new(&tree.path)).unwrap();
        assert_eq!(task, "lost");
        assert_eq!(found.root, staging.root);
        // And from there it can work out which ticket it is serving.
        assert_eq!(found.ticket_of("lost").unwrap(), "PROJ-8");

        // Somewhere that is not a worktree is refused.
        assert!(Staging::locate(&source).is_none());
    }

    #[test]
    fn completion_requires_the_task_branch_on_the_ticket() {
        let source = source_repo();
        let staging = staging();
        let ready = staging.prepare(&source).unwrap();
        staging.start_ticket("PROJ-10", &ready.base_branch).unwrap();
        let tree = staging.open_task("PROJ-10", "task-a").unwrap();
        write(&tree.path, "work.txt", "finished\n");
        staging.commit_task("task-a", "work").unwrap();
        assert!(!staging.task_landed("PROJ-10", "task-a").unwrap());
        staging.sync_from_ticket("PROJ-10", "task-a").unwrap();
        assert!(!staging.task_landed("PROJ-10", "task-a").unwrap());
        staging.land("PROJ-10", "task-a").unwrap();
        assert!(staging.task_landed("PROJ-10", "task-a").unwrap());
    }

    #[test]
    fn reports_from_an_earlier_run_do_not_cover_an_unreported_exit() {
        let staging = staging();
        staging
            .append_report("PROJ-1", "task-a", "blocked", "old", "old-run")
            .unwrap();
        assert!(staging.has_report_for_run("task-a", "old-run"));
        assert!(!staging.has_report_for_run("task-a", "new-run"));
    }

    #[test]
    fn workers_get_separate_directories() {
        let source = source_repo();
        let staging = staging();
        let ready = staging.prepare(&source).unwrap();
        staging.start_ticket("PROJ-1", &ready.base_branch).unwrap();

        let one = staging.open_task("PROJ-1", "task-a").unwrap();
        let two = staging.open_task("PROJ-1", "task-b").unwrap();
        assert_ne!(one.path, two.path);
        assert_ne!(one.branch, two.branch);

        // A file written by one worker is invisible to the other.
        write(&one.path, "one.txt", "from a\n");
        assert!(!Path::new(&two.path).join("one.txt").exists());
    }

    #[test]
    fn closing_a_task_removes_its_branch_and_directory() {
        let source = source_repo();
        let staging = staging();
        let ready = staging.prepare(&source).unwrap();
        staging.start_ticket("PROJ-5", &ready.base_branch).unwrap();

        let tree = staging.open_task("PROJ-5", "scratch").unwrap();
        write(&tree.path, "note.txt", "work\n");
        take_turn(&staging, "PROJ-5", "scratch");
        staging.close_task("PROJ-5", "scratch").unwrap();

        assert!(!Path::new(&tree.path).exists());
        let branches = git(&staging.bare(), &["branch", "--list"]).unwrap();
        assert!(!branches.contains("scratch"), "branch survived: {branches}");
        // The merged work is still there, held by the merge commit.
        let status = staging.ticket_status("PROJ-5", &ready.base_branch).unwrap();
        assert_eq!(status.files_changed, 1);
    }

    #[test]
    fn closing_twice_is_harmless() {
        let source = source_repo();
        let staging = staging();
        let ready = staging.prepare(&source).unwrap();
        staging.start_ticket("PROJ-6", &ready.base_branch).unwrap();
        staging.open_task("PROJ-6", "gone").unwrap();
        staging.close_task("PROJ-6", "gone").unwrap();
        assert!(staging.close_task("PROJ-6", "gone").is_ok());
    }

    #[test]
    fn independent_work_lands_cleanly() {
        let source = source_repo();
        let staging = staging();
        let ready = staging.prepare(&source).unwrap();
        staging.start_ticket("PROJ-1", &ready.base_branch).unwrap();

        for (task, file) in [("task-a", "one.txt"), ("task-b", "two.txt")] {
            let tree = staging.open_task("PROJ-1", task).unwrap();
            write(&tree.path, file, "hello\n");
            let landed = take_turn(&staging, "PROJ-1", task);
            assert!(landed.merged, "{task} did not land: {}", landed.detail);
        }

        let status = staging.ticket_status("PROJ-1", &ready.base_branch).unwrap();
        assert_eq!(status.files_changed, 2);
    }

    #[test]
    fn a_clash_surfaces_in_the_workers_own_worktree() {
        let source = source_repo();
        let staging = staging();
        let ready = staging.prepare(&source).unwrap();
        staging.start_ticket("PROJ-2", &ready.base_branch).unwrap();

        for (task, body) in [
            ("task-a", "A wins\ntwo\nthree\n"),
            ("task-b", "B wins\ntwo\nthree\n"),
        ] {
            let tree = staging.open_task("PROJ-2", task).unwrap();
            write(&tree.path, "app.txt", body);
            staging.commit_task(task, "edit the same line").unwrap();
        }

        // First worker takes its turn and lands.
        assert!(staging.sync_from_ticket("PROJ-2", "task-a").unwrap().merged);
        assert!(staging.land("PROJ-2", "task-a").unwrap().merged);

        // Second worker syncs and hits the clash inside its own directory.
        let clash = staging.sync_from_ticket("PROJ-2", "task-b").unwrap();
        assert!(!clash.merged);
        assert_eq!(clash.conflicts, ["app.txt"]);

        // The ticket branch is untouched, so other workers are unaffected.
        let integration = staging.integration("PROJ-2");
        assert!(git(&integration, &["status", "--porcelain"])
            .unwrap()
            .is_empty());

        // Landing is refused while the clash is unresolved.
        let refused = staging.land("PROJ-2", "task-b").unwrap();
        assert!(!refused.merged);
        assert_eq!(refused.conflicts, ["app.txt"]);

        // The worker fixes it live, exactly where it is already working.
        let worktree = staging.work("task-b");
        write(
            &worktree.to_string_lossy(),
            "app.txt",
            "A wins\nB wins too\ntwo\nthree\n",
        );
        git(&worktree, &["add", "-A"]).unwrap();
        git(&worktree, &["commit", "--quiet", "--no-edit"]).unwrap();

        let landed = staging.land("PROJ-2", "task-b").unwrap();
        assert!(landed.merged, "{}", landed.detail);

        let merged =
            std::fs::read_to_string(staging.integration("PROJ-2").join("app.txt")).unwrap();
        assert!(merged.contains("A wins") && merged.contains("B wins too"));
    }

    #[test]
    fn conflict_markers_can_never_reach_the_ticket_branch() {
        let source = source_repo();
        let staging = staging();
        let ready = staging.prepare(&source).unwrap();
        staging.start_ticket("PROJ-9", &ready.base_branch).unwrap();

        for (task, body) in [
            ("first", "FIRST\ntwo\nthree\n"),
            ("second", "SECOND\ntwo\nthree\n"),
        ] {
            let tree = staging.open_task("PROJ-9", task).unwrap();
            write(&tree.path, "app.txt", body);
            staging.commit_task(task, "edit").unwrap();
        }
        assert!(take_turn(&staging, "PROJ-9", "first").merged);

        // "second" syncs and is left with markers in its worktree.
        assert!(!staging.sync_from_ticket("PROJ-9", "second").unwrap().merged);

        // Committing now must be refused. Staging everything would turn the
        // markers into a resolved merge and land them on the ticket.
        let refused = staging.commit_task("second", "give up").unwrap_err();
        assert!(refused.contains("app.txt"), "{refused}");

        // Landing is refused too.
        assert!(!staging.land("PROJ-9", "second").unwrap().merged);

        // The ticket branch never saw a marker.
        let landed =
            std::fs::read_to_string(staging.integration("PROJ-9").join("app.txt")).unwrap();
        assert!(!landed.contains("<<<<<<<"), "{landed}");
        assert!(landed.contains("FIRST"));
    }

    #[test]
    fn landing_is_refused_when_the_ticket_moved() {
        let source = source_repo();
        let staging = staging();
        let ready = staging.prepare(&source).unwrap();
        staging.start_ticket("PROJ-7", &ready.base_branch).unwrap();

        let slow = staging.open_task("PROJ-7", "slow").unwrap();
        write(&slow.path, "slow.txt", "slow\n");
        staging.commit_task("slow", "work").unwrap();
        // "slow" synced against the ticket as it was a moment ago.
        assert!(staging.sync_from_ticket("PROJ-7", "slow").unwrap().merged);

        // Another worker lands first, moving the ticket underneath it.
        let quick = staging.open_task("PROJ-7", "quick").unwrap();
        write(&quick.path, "quick.txt", "quick\n");
        assert!(take_turn(&staging, "PROJ-7", "quick").merged);

        // A stale fast forward must be refused, not forced.
        let stale = staging.land("PROJ-7", "slow").unwrap();
        assert!(!stale.merged);
        assert!(stale.detail.contains("Sync again"), "{}", stale.detail);

        // Syncing again fixes it.
        assert!(staging.sync_from_ticket("PROJ-7", "slow").unwrap().merged);
        assert!(staging.land("PROJ-7", "slow").unwrap().merged);
    }

    #[test]
    fn nothing_to_commit_is_not_an_error() {
        let source = source_repo();
        let staging = staging();
        let ready = staging.prepare(&source).unwrap();
        staging.start_ticket("PROJ-3", &ready.base_branch).unwrap();
        staging.open_task("PROJ-3", "idle").unwrap();
        assert_eq!(staging.commit_task("idle", "nothing"), Ok(false));
    }

    #[test]
    fn publishing_sends_one_branch_and_spares_the_checked_out_one() {
        let source = source_repo();
        let staging = staging();
        let ready = staging.prepare(&source).unwrap();
        staging.start_ticket("PROJ-4", &ready.base_branch).unwrap();
        let tree = staging.open_task("PROJ-4", "only").unwrap();
        write(&tree.path, "new.txt", "done\n");
        take_turn(&staging, "PROJ-4", "only");

        // The branch the user has checked out is never a valid target.
        assert!(staging.publish("PROJ-4", "main", "main").is_err());

        staging.close_task("PROJ-4", "only").unwrap();
        let pushed = staging
            .publish("PROJ-4", "berdloop/PROJ-4", "main")
            .unwrap();
        let branches = git(&source, &["branch", "--list"]).unwrap();
        assert!(branches.contains(&pushed), "{branches}");
        // Exactly two branches reach the user: their own, and the finished
        // ticket. No per-task branch ever arrives.
        assert_eq!(branches.lines().count(), 2, "{branches}");
        assert!(!branches.contains("only"), "{branches}");
        // The user's own checkout is still on main and still clean.
        assert_eq!(
            git(&source, &["symbolic-ref", "--short", "HEAD"]).unwrap(),
            "main"
        );
        assert!(git(&source, &["status", "--porcelain"]).unwrap().is_empty());
    }
}
