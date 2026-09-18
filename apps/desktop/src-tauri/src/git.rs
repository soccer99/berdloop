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
//! Where work can travel, plainly:
//!
//! * Task branches never leave the staging repository. They are scratch space
//!   and `close_task` deletes them.
//! * The ticket branch reaches the user's repository through the `local`
//!   remote only. That remote is the user's own folder on disk, never GitHub,
//!   which is why it is not called `origin`.
//! * GitHub is only touched later, from the user's own repository, to open the
//!   pull request.
//!
//! The user's own repository is read once when the project is prepared, and
//! written only when a finished ticket is published.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The remote inside the staging repository that points at the user's folder.
const LOCAL: &str = "local";

/// Tail of a prepare log kept for the window. Enough to show why an install
/// failed without holding a whole build log in the app's state.
const PREPARE_TAIL: usize = 4000;

/// Branch that collects the finished work for one ticket.
pub(crate) fn ticket_branch(ticket: &str) -> String {
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
    /// What happened while the directory was made ready for an agent. `None`
    /// when the worktree already existed, so nothing was run.
    pub prepare: Option<Prepare>,
    /// The ports, tenants and env this worker was given. `None` for a project
    /// that has no `.berd/`, and for a worktree that already existed.
    #[serde(default)]
    pub provision: Option<crate::devenv::Provision>,
    /// True when this call made the directory. Only a fresh worktree is
    /// provisioned: re-running migrations under a working agent would undo it.
    #[serde(default)]
    pub fresh: bool,
}

/// The install step run once, before an agent is let into a fresh worktree.
///
/// A failure is reported rather than raised: the directory is still usable and
/// the agent can install what it needs itself.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepare {
    pub command: String,
    pub ok: bool,
    pub output: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    /// One of `ticket`, `commit` or `turn`.
    pub base: String,
    pub base_label: String,
    pub files: Vec<ChangedFile>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// `A`, `M`, `D` or `R`.
    pub status: String,
    /// The destination blob id, or `deleted`. The window can tell whether a
    /// file really changed without comparing whole patches.
    pub fingerprint: String,
    pub diff: String,
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

/// Run git against a throwaway index, leaving the worker's real one alone.
///
/// Staging everything to answer "what has changed?" would otherwise fight the
/// agent for its own index while it is working.
fn git_with_index(dir: &Path, index: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_INDEX_FILE", index)
        .output()
        .map_err(|e| format!("git could not run: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// A per-repository agent file, under `.delta/` or `.agents/`.
///
/// `.delta/` wins, so a repository already set up for Delta needs no second
/// copy of the same list or script.
fn agent_file(root: &Path, name: &str) -> Option<PathBuf> {
    [".delta", ".agents"]
        .iter()
        .map(|dir| root.join(dir).join(name))
        .find(|path| path.exists())
}

#[cfg(unix)]
fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    if target.is_dir() {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    }
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.exists()
    }
}

fn tail(text: &str) -> String {
    let skip = text.chars().count().saturating_sub(PREPARE_TAIL);
    text.chars().skip(skip).collect()
}

/// Share heavy, uncommitted directories with the source repository.
///
/// `node_modules` and friends cost minutes to install per worktree and are the
/// same for every worker, so they are symlinked instead of copied. Only paths
/// git ignores are linked: a tracked file behind a symlink would be committed
/// and pushed to the user, which is exactly what the staging repository exists
/// to prevent. Returns one note per path that was refused.
fn link_shared_files(source: &Path, worktree: &Path) -> Vec<String> {
    let Some(list) = agent_file(source, "linked") else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(&list) else {
        return vec![format!("Could not read {}.", list.display())];
    };
    let mut notes = Vec::new();
    for line in text.lines() {
        let entry = line.trim().trim_end_matches('/');
        if entry.is_empty() || entry.starts_with('#') {
            continue;
        }
        let target = source.join(entry);
        if !target.exists() {
            continue;
        }
        // The link itself must be ignored, and a symlink is never a directory
        // to git, so a `node_modules/` rule does not cover one. Ask about the
        // plain path, which is what will actually sit there.
        if !git_try(worktree, &["check-ignore", "-q", entry]).0 {
            notes.push(format!(
                "Not linked, git does not ignore it: {entry}. A rule ending in `/` does not match a symlink."
            ));
            continue;
        }
        let link = worktree.join(entry);
        if let Some(parent) = link.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // An existing real file must go, or the symlink cannot be made.
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&link);
        if let Err(error) = symlink(&target, &link) {
            notes.push(format!("Could not link {entry}: {error}"));
        }
    }
    notes
}

/// The install command for a project, chosen by the lockfile it carries.
///
/// First match wins, so a repository with two lockfiles gets the one its
/// developers most likely use rather than an ambiguous failure.
fn fallback_install(worktree: &Path) -> Option<&'static [&'static str]> {
    const BY_LOCKFILE: &[(&str, &[&str])] = &[
        ("bun.lock", &["bun", "install", "--frozen-lockfile"]),
        ("bun.lockb", &["bun", "install", "--frozen-lockfile"]),
        ("pnpm-lock.yaml", &["pnpm", "install", "--frozen-lockfile"]),
        ("yarn.lock", &["yarn", "install", "--immutable"]),
        ("package-lock.json", &["npm", "ci"]),
        ("uv.lock", &["uv", "sync"]),
        ("poetry.lock", &["poetry", "install"]),
    ];
    BY_LOCKFILE
        .iter()
        .find(|(file, _)| worktree.join(file).exists())
        .map(|(_, argv)| *argv)
}

/// Make a fresh worktree usable: a project's own script, else a plain install.
fn run_prepare(worktree: &Path, notes: Vec<String>) -> Option<Prepare> {
    let script = agent_file(worktree, "prepare").filter(|path| is_executable(path));
    let (label, mut command) = match &script {
        Some(path) => (path.display().to_string(), Command::new(path)),
        None => match fallback_install(worktree) {
            Some(argv) => {
                let mut command = Command::new(argv[0]);
                command.args(&argv[1..]);
                (argv.join(" "), command)
            }
            // Nothing to install. Still report if a link was refused.
            None if notes.is_empty() => return None,
            None => {
                return Some(Prepare {
                    command: String::new(),
                    ok: true,
                    output: tail(notes.join("\n").trim()),
                })
            }
        },
    };
    let result = command.current_dir(worktree).env("BERDLOOP", "1").output();
    let mut log = notes.join("\n");
    let ok = match result {
        Ok(output) => {
            if !log.is_empty() {
                log.push('\n');
            }
            log.push_str(&String::from_utf8_lossy(&output.stdout));
            log.push_str(&String::from_utf8_lossy(&output.stderr));
            output.status.success()
        }
        Err(error) => {
            if !log.is_empty() {
                log.push('\n');
            }
            log.push_str(&format!("{label} could not run: {error}"));
            false
        }
    };
    Some(Prepare {
        command: label,
        ok,
        output: tail(log.trim()),
    })
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
        let revision = git(&bare, &["rev-parse", &branch])?;
        let marker = self
            .root
            .join("tasks")
            .join(format!("{}.landed", safe_ref(task_id)));
        Ok(std::fs::read_to_string(marker)
            .ok()
            .is_some_and(|saved| saved.trim() == revision)
            && git_try(&bare, &["merge-base", "--is-ancestor", &branch, &target]).0)
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

    /// The user's own checkout, which is what the `local` remote points at.
    ///
    /// Read only: `.berd/config.json` lives there, and nothing in this module
    /// ever writes to it.
    pub fn source(&self) -> Option<PathBuf> {
        git(&self.bare(), &["remote", "get-url", LOCAL])
            .ok()
            .map(PathBuf::from)
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
            git(&bare, &["remote", "add", LOCAL, &source.to_string_lossy()])?;
        }
        // Staging areas made before the remote was renamed still say `origin`,
        // which reads as GitHub and is not what this points at.
        let remotes = git(&bare, &["remote"]).unwrap_or_default();
        if !remotes.lines().any(|name| name == LOCAL)
            && remotes.lines().any(|name| name == "origin")
        {
            git(&bare, &["remote", "rename", "origin", LOCAL])?;
        }
        // Refresh from the source every time, so a worker always branches
        // from what the user has actually committed.
        git(&bare, &["fetch", "--quiet", LOCAL])?;

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
            let start = format!("{LOCAL}/{base_branch}");
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
            prepare: None,
            provision: None,
            fresh: false,
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
                prepare: None,
                provision: None,
                fresh: false,
            });
        }
        let _ = std::fs::remove_file(notes.join(format!("{}.landed", safe_ref(task_id))));
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
        // Only a brand new directory needs this, and only once: it costs an
        // install, and a worker that is already running would lose its work if
        // its dependencies were reinstalled underneath it.
        let notes = match git(&bare, &["remote", "get-url", LOCAL]) {
            Ok(source) => link_shared_files(Path::new(&source), &path),
            Err(error) => vec![format!("Could not find the source repository: {error}")],
        };
        Ok(Worktree {
            path: path.to_string_lossy().into_owned(),
            branch,
            prepare: run_prepare(&path, notes),
            provision: None,
            fresh: true,
        })
    }

    /// The tree the worker's directory would make if it committed right now.
    ///
    /// Untracked files are included, because half of an agent's work is new
    /// files it has not committed yet. The agent's own index is copied first
    /// and the copy is what gets staged, so nothing here disturbs a worker
    /// that is in the middle of a commit.
    fn snapshot_tree(&self, task_id: &str) -> Result<String, String> {
        let path = self.work(task_id);
        if !path.exists() {
            return Err("That task has no worktree.".to_string());
        }
        // A worktree of a bare repository keeps its index under
        // `staging.git/worktrees/<name>/index`, so ask git where it is.
        let index = path.join(git(&path, &["rev-parse", "--git-path", "index"])?);
        let scratch = self.turns_dir();
        std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
        let copy = scratch.join(format!("{}.index", safe_ref(task_id)));
        std::fs::copy(&index, &copy).map_err(|e| e.to_string())?;
        let tree = git_with_index(&path, &copy, &["add", "-A"])
            .and_then(|_| git_with_index(&path, &copy, &["write-tree"]));
        let _ = std::fs::remove_file(&copy);
        tree
    }

    fn turns_dir(&self) -> PathBuf {
        self.root.join("turns")
    }

    fn turn_file(&self, task_id: &str) -> PathBuf {
        self.turns_dir().join(format!("{}.tree", safe_ref(task_id)))
    }

    /// Remember what the worker's directory looked like before it was spoken to.
    ///
    /// This is what "what changed this turn?" is measured against, so it is
    /// written at every point an instruction reaches an agent.
    pub fn mark_turn(&self, task_id: &str) -> Result<(), String> {
        let tree = self.snapshot_tree(task_id)?;
        std::fs::create_dir_all(self.turns_dir()).map_err(|e| e.to_string())?;
        std::fs::write(self.turn_file(task_id), tree).map_err(|e| e.to_string())
    }

    /// What a worker has changed, for the window to show as a diff.
    ///
    /// Both sides are trees, never the working directory, so untracked files
    /// appear and the answer does not shift while the agent is writing.
    pub fn changes(&self, ticket: &str, task_id: &str, base: &str) -> Result<Changes, String> {
        let path = self.work(task_id);
        let snapshot = self.snapshot_tree(task_id)?;
        let head = || git(&path, &["rev-parse", "HEAD"]);
        let (from, label) = match base {
            "ticket" => {
                let branch = ticket_branch(ticket);
                let start = git(&path, &["merge-base", &branch, "HEAD"])?;
                (start, format!("{branch} (merge base)"))
            }
            "commit" => (head()?, "HEAD".to_string()),
            "turn" => match std::fs::read_to_string(self.turn_file(task_id)) {
                Ok(tree) if !tree.trim().is_empty() => {
                    (tree.trim().to_string(), "start of last turn".to_string())
                }
                _ => (head()?, "HEAD".to_string()),
            },
            other => return Err(format!("{other} is not a diff base.")),
        };

        let raw = git(
            &path,
            &["diff", "--raw", "--no-abbrev", "-M", &from, &snapshot],
        )?;
        let mut files = Vec::new();
        for line in raw.lines() {
            // `:<old mode> <new mode> <old blob> <new blob> <status>\t<path>`,
            // with a second tab separated path when git detected a rename.
            let Some(rest) = line.strip_prefix(':') else {
                continue;
            };
            let mut parts = rest.split('\t');
            let fields: Vec<&str> = parts
                .next()
                .unwrap_or_default()
                .split_whitespace()
                .collect();
            let paths: Vec<&str> = parts.collect();
            let (Some(blob), Some(status), Some(name)) =
                (fields.get(3), fields.get(4), paths.last())
            else {
                continue;
            };
            let mut args = vec![
                "diff",
                "--no-color",
                "--no-ext-diff",
                "-M",
                &from,
                &snapshot,
                "--",
            ];
            // A rename needs both names, or git sees a delete and an add.
            args.extend(&paths);
            files.push(ChangedFile {
                path: (*name).to_string(),
                status: status.chars().next().unwrap_or('M').to_string(),
                fingerprint: if blob.chars().all(|c| c == '0') {
                    "deleted".to_string()
                } else {
                    (*blob).to_string()
                },
                diff: git(&path, &args).unwrap_or_default(),
            });
        }
        Ok(Changes {
            base: base.to_string(),
            base_label: label,
            files,
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
        if ok {
            let revision = git(&self.bare(), &["rev-parse", &branch])?;
            let marker = self
                .root
                .join("tasks")
                .join(format!("{}.landed", safe_ref(task_id)));
            std::fs::write(marker, revision).map_err(|e| e.to_string())?;
        }
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
        let _ = std::fs::remove_file(
            self.root
                .join("tasks")
                .join(format!("{}.landed", safe_ref(task_id))),
        );
        let _ = std::fs::remove_file(self.turn_file(task_id));
        Ok(())
    }

    pub fn ticket_status(&self, ticket: &str, base_branch: &str) -> Result<TicketStatus, String> {
        let bare = self.bare();
        let branch = ticket_branch(ticket);
        let range = format!("{LOCAL}/{base_branch}..{branch}");
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
        git(&self.bare(), &["push", LOCAL, &refspec])?;
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

/// Open a worker's directory, then give it its ports, tenants and env.
///
/// Provisioning happens here rather than inside `open_task` because it needs
/// the admin credentials, and those live in the app, deliberately out of reach
/// of anything a worker can read. A project with no `.berd/` skips all of it.
#[tauri::command]
pub fn git_open_task(
    app: tauri::AppHandle,
    project_id: String,
    ticket: String,
    task_id: String,
) -> Result<Worktree, String> {
    let staging = staging_for(&app, &project_id)?;
    let mut tree = staging.open_task(&ticket, &task_id)?;
    if tree.fresh {
        if let Some(source) = staging.source() {
            let data = tauri::Manager::path(&app)
                .app_data_dir()
                .map_err(|_| "Could not find the app data directory.".to_string())?;
            let admin = crate::broker::read_admin(&data, &project_id);
            tree.provision = Some(crate::devenv::provision(
                &staging.root,
                &source,
                &task_id,
                Path::new(&tree.path),
                &admin,
            ));
        }
    }
    Ok(tree)
}

/// What one worker has changed, against the ticket, its last commit, or the
/// point where it was last given an instruction.
#[tauri::command]
pub fn git_task_changes(
    app: tauri::AppHandle,
    project_id: String,
    ticket: String,
    task_id: String,
    base: String,
) -> Result<Changes, String> {
    staging_for(&app, &project_id)?.changes(&ticket, &task_id, &base)
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

/// Close a task and give back everything it held.
///
/// The dev server is stopped, the tenants are dropped and the slot is freed
/// before the worktree goes, so nothing is left running against a directory
/// that no longer exists.
#[tauri::command]
pub fn git_close_task(
    app: tauri::AppHandle,
    project_id: String,
    ticket: String,
    task_id: String,
) -> Result<(), String> {
    let staging = staging_for(&app, &project_id)?;
    if let Some(source) = staging.source() {
        let admin = tauri::Manager::path(&app)
            .app_data_dir()
            .map(|data| crate::broker::read_admin(&data, &project_id))
            .unwrap_or_default();
        crate::devenv::release(&staging.root, &source, &task_id, &admin);
    }
    staging.close_task(&ticket, &task_id)
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

    /// Everything a worker needs before it can be opened on a fresh ticket.
    fn ready(ticket: &str) -> (PathBuf, Staging, String) {
        let source = source_repo();
        let staging = staging();
        let base = staging.prepare(&source).unwrap().base_branch;
        staging.start_ticket(ticket, &base).unwrap();
        (source, staging, base)
    }

    #[test]
    fn the_staging_remote_is_named_for_what_it_points_at() {
        let source = source_repo();
        let staging = staging();
        staging.prepare(&source).unwrap();
        assert_eq!(git(&staging.bare(), &["remote"]).unwrap(), "local");
        assert_eq!(
            git(&staging.bare(), &["remote", "get-url", "local"]).unwrap(),
            source.to_string_lossy()
        );

        // Staging areas made by an older version still say `origin`.
        git(&staging.bare(), &["remote", "rename", "local", "origin"]).unwrap();
        staging.prepare(&source).unwrap();
        assert_eq!(git(&staging.bare(), &["remote"]).unwrap(), "local");
        // And the ticket branch still starts from the user's branch.
        assert!(staging.start_ticket("PROJ-11", "main").is_ok());
    }

    #[test]
    fn only_ignored_files_are_linked_into_a_worktree() {
        let source = source_repo();
        std::fs::write(source.join(".gitignore"), "node_modules\nsecret.env\n").unwrap();
        std::fs::create_dir_all(source.join("node_modules/pkg")).unwrap();
        std::fs::write(source.join("node_modules/pkg/index.js"), "shared\n").unwrap();
        std::fs::write(source.join("secret.env"), "KEY=1\n").unwrap();
        std::fs::create_dir_all(source.join(".agents")).unwrap();
        std::fs::write(
            source.join(".agents/linked"),
            "# heavy, and the same for everyone\nnode_modules/\nsecret.env\napp.txt\nmissing.txt\n",
        )
        .unwrap();
        git(&source, &["add", "-A"]).unwrap();
        git(&source, &["commit", "--quiet", "-m", "ignore"]).unwrap();

        let staging = staging();
        let base = staging.prepare(&source).unwrap().base_branch;
        staging.start_ticket("PROJ-20", &base).unwrap();
        let tree = staging.open_task("PROJ-20", "linky").unwrap();
        let work = Path::new(&tree.path);

        assert!(std::fs::symlink_metadata(work.join("node_modules"))
            .unwrap()
            .is_symlink());
        assert_eq!(
            std::fs::read_to_string(work.join("node_modules/pkg/index.js")).unwrap(),
            "shared\n"
        );
        assert!(std::fs::symlink_metadata(work.join("secret.env"))
            .unwrap()
            .is_symlink());
        // A tracked file must stay real, or the link would be committed.
        assert!(!std::fs::symlink_metadata(work.join("app.txt"))
            .unwrap()
            .is_symlink());
        let report = tree.prepare.expect("a refused link is worth reporting");
        assert!(report.output.contains("app.txt"), "{}", report.output);
        // The worker's own directory still looks clean to git.
        assert!(git(work, &["status", "--porcelain"]).unwrap().is_empty());
    }

    #[test]
    fn a_prepare_script_runs_in_the_worktree_and_a_failure_is_survivable() {
        let source = source_repo();
        std::fs::create_dir_all(source.join(".agents")).unwrap();
        std::fs::write(
            source.join(".agents/prepare"),
            "#!/bin/sh\npwd > prepared.txt\necho \"berdloop=$BERDLOOP\"\nexit 3\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                source.join(".agents/prepare"),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        git(&source, &["add", "-A"]).unwrap();
        git(&source, &["commit", "--quiet", "-m", "prepare"]).unwrap();

        let staging = staging();
        let base = staging.prepare(&source).unwrap().base_branch;
        staging.start_ticket("PROJ-21", &base).unwrap();
        // A failing prepare still hands back a usable worktree.
        let tree = staging.open_task("PROJ-21", "setup").unwrap();
        let report = tree.prepare.expect("the script ran");
        assert!(!report.ok, "{}", report.output);
        assert!(report.output.contains("berdloop=1"), "{}", report.output);
        let where_it_ran = std::fs::read_to_string(Path::new(&tree.path).join("prepared.txt"))
            .unwrap()
            .trim()
            .to_string();
        assert!(
            std::fs::canonicalize(&where_it_ran).unwrap()
                == std::fs::canonicalize(&tree.path).unwrap(),
            "{where_it_ran}"
        );

        // Opening it again changes nothing: the install already happened.
        assert!(staging
            .open_task("PROJ-21", "setup")
            .unwrap()
            .prepare
            .is_none());
    }

    #[test]
    fn the_lockfile_chooses_the_install_command() {
        let dir = temp("locks");
        assert!(fallback_install(&dir).is_none());
        std::fs::write(dir.join("package-lock.json"), "{}").unwrap();
        assert_eq!(fallback_install(&dir).unwrap(), ["npm", "ci"]);
        // Bun is checked first, so it wins over an npm lockfile left behind.
        std::fs::write(dir.join("bun.lock"), "").unwrap();
        assert_eq!(
            fallback_install(&dir).unwrap(),
            ["bun", "install", "--frozen-lockfile"]
        );
    }

    #[test]
    fn changes_cover_committed_and_untracked_work() {
        let (_source, staging, _base) = ready("PROJ-22");
        let tree = staging.open_task("PROJ-22", "diffy").unwrap();
        write(&tree.path, "app.txt", "one\nchanged\nthree\n");
        staging.commit_task("diffy", "edit").unwrap();
        write(&tree.path, "fresh.txt", "brand new\n");

        // Against the ticket: everything this worker did, committed or not.
        let all = staging.changes("PROJ-22", "diffy", "ticket").unwrap();
        assert_eq!(all.base_label, "berdloop/PROJ-22 (merge base)");
        let mut seen: Vec<_> = all
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status.as_str()))
            .collect();
        seen.sort();
        assert_eq!(seen, [("app.txt", "M"), ("fresh.txt", "A")]);
        assert!(all.files[0].diff.contains("changed") || all.files[1].diff.contains("changed"));
        assert!(all.files.iter().all(|f| f.fingerprint.len() == 40));

        // Against the last commit: only the file that is not committed yet.
        let since_commit = staging.changes("PROJ-22", "diffy", "commit").unwrap();
        assert_eq!(since_commit.base_label, "HEAD");
        assert_eq!(since_commit.files.len(), 1);
        assert_eq!(since_commit.files[0].path, "fresh.txt");

        // A deleted file is reported as such.
        std::fs::remove_file(Path::new(&tree.path).join("app.txt")).unwrap();
        let removed = staging.changes("PROJ-22", "diffy", "commit").unwrap();
        let gone = removed.files.iter().find(|f| f.path == "app.txt").unwrap();
        assert_eq!(gone.status, "D");
        assert_eq!(gone.fingerprint, "deleted");

        assert!(staging.changes("PROJ-22", "diffy", "sideways").is_err());
    }

    #[test]
    fn a_turn_shows_only_what_happened_after_the_agent_was_spoken_to() {
        let (_source, staging, _base) = ready("PROJ-23");
        let tree = staging.open_task("PROJ-23", "turny").unwrap();
        write(&tree.path, "before.txt", "earlier\n");

        // With no turn recorded yet this falls back to the last commit.
        let fallback = staging.changes("PROJ-23", "turny", "turn").unwrap();
        assert_eq!(fallback.base_label, "HEAD");
        assert_eq!(fallback.files.len(), 1);

        staging.mark_turn("turny").unwrap();
        write(&tree.path, "after.txt", "later\n");

        let turn = staging.changes("PROJ-23", "turny", "turn").unwrap();
        assert_eq!(turn.base_label, "start of last turn");
        assert_eq!(turn.files.len(), 1, "{:?}", turn.files[0].path);
        assert_eq!(turn.files[0].path, "after.txt");
        assert_eq!(turn.files[0].status, "A");

        // Snapshots never disturb the worker's own index.
        assert!(
            git(Path::new(&tree.path), &["diff", "--cached", "--name-only"])
                .unwrap()
                .is_empty()
        );

        staging.close_task("PROJ-23", "turny").unwrap();
        assert!(!staging.turn_file("turny").exists());
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
