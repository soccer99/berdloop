//! Ticket publication and independent review lifecycle.
use crate::{git, workspace};
use serde::Serialize;
use serde_json::{json, Value};
use std::{path::Path, process::Command};

/// The forge command line tool. Tests hand in a fake, so no real PR is ever
/// made by a test; the app uses `gh` from PATH, or `BERDLOOP_GH` if set.
pub struct Forge {
    program: String,
    env: Vec<(String, String)>,
}

impl Default for Forge {
    fn default() -> Self {
        Self {
            program: std::env::var("BERDLOOP_GH").unwrap_or_else(|_| "gh".into()),
            env: Vec::new(),
        }
    }
}

impl Forge {
    fn run(&self, dir: &Path, args: &[&str]) -> Result<String, String> {
        let output = Command::new(&self.program)
            .args(args)
            .envs(self.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .current_dir(dir)
            .output()
            .map_err(|error| format!("Could not run {}: {error}. Install the GitHub CLI and sign in with `gh auth login`.", self.program))?;
        if !output.status.success() {
            return Err(format!(
                "{}: {}",
                self.program,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }
}

fn command(dir: &Path, program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|error| format!("Could not run {program}: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn safe(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReviewContext {
    pub path: String,
    pub head: String,
    pub base_branch: String,
    pub url: String,
}

#[tauri::command]
pub fn publish_ticket_pr(
    app: tauri::AppHandle,
    project_id: String,
    ticket_id: String,
    source: String,
) -> Result<ReviewContext, String> {
    publish(
        &workspace::for_app(&app)?,
        &git::staging_for(&app, &project_id)?,
        &project_id,
        &ticket_id,
        &source,
        &Forge::default(),
    )
}

/// Push the finished ticket branch and make sure exactly one PR exists for it.
///
/// Safe to call again: an existing PR is reused, and a head that was already
/// published and reviewed keeps its review. A new head starts a new review.
pub fn publish(
    store: &workspace::Store,
    staging: &git::Staging,
    project_id: &str,
    ticket_id: &str,
    source: &str,
    forge: &Forge,
) -> Result<ReviewContext, String> {
    let current = store.load()?;
    let ticket = current["tasks"]
        .as_array()
        .ok_or("Invalid tickets")?
        .iter()
        .find(|item| item["id"] == ticket_id && item["projectId"] == project_id)
        .ok_or("Ticket not found")?;
    let key = ticket["ticket"]
        .as_str()
        .ok_or("Ticket has no key")?
        .to_owned();
    let title = ticket["title"].as_str().unwrap_or(&key).to_owned();
    let criteria = ticket["criteria"].as_str().unwrap_or("").to_owned();
    let tasks: Vec<_> = current["agentTasks"]
        .as_array()
        .ok_or("Invalid tasks")?
        .iter()
        .filter(|task| task["parentTaskId"] == ticket_id)
        .collect();
    if tasks.is_empty() || tasks.iter().any(|task| task["status"] != "complete") {
        return Err("Complete all ticket tasks before publishing the PR.".into());
    }
    let prepared = staging.prepare(Path::new(source))?;
    staging.start_ticket(&key, &prepared.base_branch)?;
    let branch = git::ticket_branch(&key);
    let head = command(
        &staging.root.join("staging.git"),
        "git",
        &["rev-parse", &branch],
    )?;
    let previous = ticket.get("pullRequest");
    if previous.and_then(|p| p["head"].as_str()) == Some(&head)
        && previous.and_then(|p| p["review"].as_str()) != Some("changes-requested")
    {
        return review_context(staging, &key, &head, previous.unwrap());
    }
    // The staging `local` remote is the user's own checkout. Push to it first, then to
    // its configured remote so GitHub can create or update the pull request.
    // `publish` makes the branch name safe for a remote, so the name it hands
    // back is the one to push onward and to open the PR from.
    let published = staging.publish(&key, &branch, &prepared.base_branch)?;
    let source_path = Path::new(source);
    command(
        source_path,
        "git",
        &[
            "push",
            "origin",
            &format!("{published}:refs/heads/{published}"),
        ],
    )?;
    let body_path = staging.root.join(format!("{}-pr-body.md", safe(&key)));
    std::fs::write(&body_path, &criteria).map_err(|e| e.to_string())?;
    let url = if let Some(url) = previous.and_then(|p| p["url"].as_str()) {
        url.to_owned()
    } else {
        match forge.run(
            source_path,
            &["pr", "view", &published, "--json", "url", "--jq", ".url"],
        ) {
            Ok(url) if !url.is_empty() => url,
            _ => forge.run(
                source_path,
                &[
                    "pr",
                    "create",
                    "--head",
                    &published,
                    "--base",
                    &prepared.base_branch,
                    "--title",
                    &format!("{}: {}", key, title),
                    "--body-file",
                    &body_path.to_string_lossy(),
                ],
            )?,
        }
    };
    // The published commit changed, so any earlier approval no longer applies.
    let pull = json!({"url":url,"head":head,"baseBranch":prepared.base_branch,"review":"pending","merged":false});
    store.change(|w| {
        let tasks = w["agentTasks"].as_array().ok_or("Invalid tasks")?;
        let siblings: Vec<_> = tasks
            .iter()
            .filter(|task| task["parentTaskId"] == ticket_id)
            .collect();
        if siblings.is_empty() || siblings.iter().any(|task| task["status"] != "complete") {
            return Err("Ticket tasks changed while the PR was publishing.".into());
        }
        let item = w["tasks"]
            .as_array_mut()
            .ok_or("Invalid tickets")?
            .iter_mut()
            .find(|item| item["id"] == ticket_id && item["projectId"] == project_id)
            .ok_or("Ticket disappeared")?;
        item["pullRequest"] = pull.clone();
        item["status"] = json!("review");
        item["stage"] = json!("Review");
        item["updatedAt"] = json!(workspace::now());
        Ok(())
    })?;
    review_context(staging, &key, &head, &pull)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullState {
    /// One of: merged, open, checks-pending, checks-failed, blocked, closed,
    /// head-moved, waiting-for-human.
    pub state: String,
    pub url: String,
}

/// Bring the ticket in line with its pull request on the forge.
///
/// This is the only place a final merge happens, and it happens only for an
/// automatic policy, only for the exact reviewed head, and only when the forge
/// itself says the branch is clean and every check passed. A manual policy
/// leaves the PR alone and reports when a person merged it.
#[tauri::command]
pub fn ticket_pr_sync(
    app: tauri::AppHandle,
    project_id: String,
    ticket_id: String,
    source: String,
) -> Result<PullState, String> {
    pr_sync(
        &workspace::for_app(&app)?,
        &project_id,
        &ticket_id,
        Path::new(&source),
        &Forge::default(),
    )
}

pub fn pr_sync(
    store: &workspace::Store,
    project_id: &str,
    ticket_id: &str,
    source: &Path,
    forge: &Forge,
) -> Result<PullState, String> {
    let current = store.load()?;
    let ticket = current["tasks"]
        .as_array()
        .ok_or("Invalid tickets")?
        .iter()
        .find(|item| item["id"] == ticket_id && item["projectId"] == project_id)
        .ok_or("Ticket not found")?;
    let pull = ticket.get("pullRequest").ok_or("Ticket has no PR")?;
    let url = pull["url"].as_str().ok_or("PR has no URL")?.to_owned();
    let head = pull["head"].as_str().ok_or("PR has no head")?.to_owned();
    let policy = ticket["mergePolicy"].as_str().unwrap_or("manual");
    let raw = forge.run(
        source,
        &[
            "pr",
            "view",
            &url,
            "--json",
            "state,headRefOid,mergeStateStatus,statusCheckRollup",
        ],
    )?;
    let view: Value =
        serde_json::from_str(&raw).map_err(|e| format!("gh returned invalid JSON: {e}"))?;
    let mut state = pull_state(
        &view,
        &head,
        pull["review"].as_str().unwrap_or("pending"),
        policy,
    );
    if state == "ready-to-merge" {
        forge.run(
            source,
            &["pr", "merge", &url, "--merge", "--match-head-commit", &head],
        )?;
        state = "merged".into();
    }
    store.change(|w| {
        let item = w["tasks"]
            .as_array_mut()
            .ok_or("Invalid tickets")?
            .iter_mut()
            .find(|item| item["id"] == ticket_id && item["projectId"] == project_id)
            .ok_or("Ticket disappeared")?;
        match state.as_str() {
            "merged" => {
                item["pullRequest"]["merged"] = json!(true);
                item["status"] = json!("complete");
                item["stage"] = json!("Deploy");
            }
            "head-moved" => {
                // Somebody pushed to the PR branch outside Berdloop. Nothing
                // recorded about the old commit applies to the new one.
                item["pullRequest"]["head"] = view["headRefOid"].clone();
                item["pullRequest"]["review"] = json!("pending");
            }
            _ => return Ok(()),
        }
        item["updatedAt"] = json!(workspace::now());
        Ok(())
    })?;
    Ok(PullState { state, url })
}

/// Decide what the PR needs from what the forge reports. Pure, so it is tested
/// without a forge.
pub fn pull_state(view: &Value, head: &str, review: &str, policy: &str) -> String {
    match view["state"].as_str().unwrap_or("") {
        "MERGED" => return "merged".into(),
        "CLOSED" => return "closed".into(),
        _ => {}
    }
    if view["headRefOid"].as_str().is_some_and(|sha| sha != head) {
        return "head-moved".into();
    }
    if review != "approved" {
        return "open".into();
    }
    if policy != "automatic" {
        return "waiting-for-human".into();
    }
    let checks = view["statusCheckRollup"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let verdict = |check: &Value| {
        check["conclusion"]
            .as_str()
            .or(check["state"].as_str())
            .unwrap_or("")
            .to_uppercase()
    };
    if checks.iter().any(|c| {
        verdict(c).is_empty()
            || ["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED"].contains(&verdict(c).as_str())
    }) {
        return "checks-pending".into();
    }
    if checks
        .iter()
        .any(|c| !["SUCCESS", "SKIPPED", "NEUTRAL"].contains(&verdict(c).as_str()))
    {
        return "checks-failed".into();
    }
    // The forge applies its own branch protection. Anything but CLEAN means a
    // rule it enforces is not met, and forcing past it is never our call.
    if view["mergeStateStatus"].as_str() != Some("CLEAN") {
        return "blocked".into();
    }
    "ready-to-merge".into()
}

fn review_context(
    staging: &git::Staging,
    key: &str,
    head: &str,
    pull: &Value,
) -> Result<ReviewContext, String> {
    let path = staging.root.join("review").join(safe(key)).join(head);
    if !path.exists() {
        std::fs::create_dir_all(path.parent().ok_or("Invalid review path")?)
            .map_err(|e| e.to_string())?;
        command(
            &staging.root.join("staging.git"),
            "git",
            &[
                "worktree",
                "add",
                "--detach",
                "--quiet",
                &path.to_string_lossy(),
                head,
            ],
        )?;
    }
    Ok(ReviewContext {
        path: path.to_string_lossy().into_owned(),
        head: head.into(),
        base_branch: pull["baseBranch"].as_str().unwrap_or("main").into(),
        url: pull["url"].as_str().unwrap_or("").into(),
    })
}

#[tauri::command]
pub fn pr_review_context(
    app: tauri::AppHandle,
    project_id: String,
    ticket_id: String,
) -> Result<ReviewContext, String> {
    let w = workspace::for_app(&app)?.load()?;
    let ticket = w["tasks"]
        .as_array()
        .ok_or("Invalid tickets")?
        .iter()
        .find(|item| item["id"] == ticket_id && item["projectId"] == project_id)
        .ok_or("Ticket not found")?;
    let pull = ticket.get("pullRequest").ok_or("Ticket has no PR")?;
    if pull["review"] != "pending" {
        return Err("This PR is not awaiting review".into());
    }
    review_context(
        &git::staging_for(&app, &project_id)?,
        ticket["ticket"].as_str().ok_or("Ticket has no key")?,
        pull["head"].as_str().ok_or("PR has no head")?,
        pull,
    )
}

pub fn submit(
    app: &tauri::AppHandle,
    scope: &crate::conversations::Scope,
    head: &str,
    summary: &str,
    findings: &str,
) -> Result<String, String> {
    submit_to(&workspace::for_app(app)?, scope, head, summary, findings)
}

pub fn submit_to(
    store: &workspace::Store,
    scope: &crate::conversations::Scope,
    head: &str,
    summary: &str,
    findings: &str,
) -> Result<String, String> {
    if scope.role != "pr-code-review" {
        return Err("Only the PR review agent may submit a review".into());
    }
    let ticket_id = scope.ticket_id.as_deref().ok_or("Review has no ticket")?;
    let findings: Vec<Value> = serde_json::from_str(findings)
        .map_err(|_| "--findings must be a JSON array".to_string())?;
    if findings.len() > 30 || summary.trim().is_empty() || summary.len() > 10_000 {
        return Err("Review summary or findings exceed limits".into());
    }
    for finding in &findings {
        if finding["title"]
            .as_str()
            .is_none_or(|s| s.trim().is_empty() || s.len() > 300)
            || finding["criteria"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty() || s.len() > 4000)
        {
            return Err("Each finding needs a title and criteria".into());
        }
    }
    store.change(|w| apply_review(w, scope, ticket_id, head, summary, &findings))?;
    // The reviewed commit is recorded with the verdict, so a later push can be
    // told apart from the one that was actually read.
    store.change(|w| {
        if let Some(item) = w["tasks"]
            .as_array_mut()
            .and_then(|t| t.iter_mut().find(|t| t["id"] == ticket_id))
        {
            item["pullRequest"]["reviewedHead"] = json!(head);
        }
        Ok(())
    })?;
    Ok(format!(
        "Review recorded; {} priority fix task(s) queued.",
        findings.len()
    ))
}

fn apply_review(
    w: &mut Value,
    scope: &crate::conversations::Scope,
    ticket_id: &str,
    head: &str,
    summary: &str,
    findings: &[Value],
) -> Result<(), String> {
    let ticket = w["tasks"]
        .as_array_mut()
        .ok_or("Invalid tickets")?
        .iter_mut()
        .find(|ticket| ticket["id"] == ticket_id && ticket["projectId"] == scope.project_id)
        .ok_or("Ticket not found")?;
    if ticket["status"] != "review"
        || ticket["pullRequest"]["review"] != "pending"
        || ticket["pullRequest"]["head"] != head
    {
        return Err("The PR changed or this review was already submitted".into());
    }
    ticket["pullRequest"]["review"] = json!(if findings.is_empty() {
        "approved"
    } else {
        "changes-requested"
    });
    ticket["pullRequest"]["summary"] = json!(summary.trim());
    ticket["updatedAt"] = json!(workspace::now());
    if !findings.is_empty() {
        ticket["status"] = json!("running");
    }
    if !findings.is_empty() {
        let tickets = w["tasks"].as_array_mut().ok_or("Invalid tickets")?;
        let position = tickets
            .iter()
            .position(|item| item["id"] == ticket_id)
            .ok_or("Ticket disappeared")?;
        let prioritized = tickets.remove(position);
        tickets.insert(0, prioritized);
    }
    let now = workspace::now();
    let tasks = w["agentTasks"].as_array_mut().ok_or("Invalid tasks")?;
    for finding in findings.iter().rev() {
        tasks.insert(0,json!({"id":uuid::Uuid::new_v4().to_string(),"parentTaskId":ticket_id,
                "title":finding["title"],"criteria":finding["criteria"],"prompt":finding["criteria"],
                "dependencyIds":[],"status":"ready","reviewFix":true,"createdAt":now,"updatedAt":now}));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversations::Scope;
    use std::process::Command;

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new(args[0])
            .args(&args[1..])
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A user's checkout with a bare "GitHub" behind it, a fake `gh` that logs
    /// what it is asked and answers from a file, and a staging area.
    struct Bench {
        root: std::path::PathBuf,
        source: std::path::PathBuf,
        remote: std::path::PathBuf,
        store: workspace::Store,
        staging: git::Staging,
    }

    impl Bench {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("berdloop-forge-{}", uuid::Uuid::new_v4()));
            let source = root.join("checkout");
            let remote = root.join("github.git");
            std::fs::create_dir_all(&source).unwrap();
            std::fs::create_dir_all(&remote).unwrap();
            sh(&remote, &["git", "init", "--bare", "--quiet"]);
            sh(&source, &["git", "init", "--quiet", "-b", "main"]);
            sh(&source, &["git", "config", "user.email", "t@t.t"]);
            sh(&source, &["git", "config", "user.name", "T"]);
            std::fs::write(source.join("a.txt"), "one\n").unwrap();
            sh(&source, &["git", "add", "-A"]);
            sh(&source, &["git", "commit", "--quiet", "-m", "start"]);
            sh(
                &source,
                &["git", "remote", "add", "origin", remote.to_str().unwrap()],
            );
            sh(&source, &["git", "push", "--quiet", "origin", "main"]);
            let fake = root.join("gh");
            std::fs::write(
                &fake,
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$BERDLOOP_GH_LOG\"\ncase \"$1 $2\" in\n  \"pr view\") cat \"$BERDLOOP_GH_VIEW\" ;;\n  \"pr create\") echo https://example.test/pr/1 ;;\n  \"pr merge\") echo '{\"state\":\"MERGED\"}' > \"$BERDLOOP_GH_VIEW\" ;;\nesac\n",
            )
            .unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
            std::fs::write(root.join("view.json"), "").unwrap();
            let store = workspace::Store(root.join("tasks.json"));
            let staging = git::Staging::new(root.join("staging"));
            Self {
                root,
                source,
                remote,
                store,
                staging,
            }
        }

        fn forge(&self) -> Forge {
            Forge {
                program: self.root.join("gh").to_string_lossy().into_owned(),
                env: vec![
                    (
                        "BERDLOOP_GH_LOG".into(),
                        self.root.join("gh.log").to_string_lossy().into_owned(),
                    ),
                    (
                        "BERDLOOP_GH_VIEW".into(),
                        self.root.join("view.json").to_string_lossy().into_owned(),
                    ),
                ],
            }
        }

        fn gh_log(&self) -> String {
            std::fs::read_to_string(self.root.join("gh.log")).unwrap_or_default()
        }

        fn view(&self, json: &str) {
            std::fs::write(self.root.join("view.json"), json).unwrap();
        }

        fn ticket(&self) -> Value {
            self.store.load().unwrap()["tasks"][0].clone()
        }
    }

    impl Drop for Bench {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn finished_ticket(bench: &Bench, policy: &str) {
        bench
            .store
            .change(|w| {
                w["tasks"] = json!([{"id":"t1","projectId":"p","title":"Ticket","criteria":"Do it","ticket":"T-1","source":"Local","stage":"Engineer","status":"running","mergePolicy":policy}]);
                w["agentTasks"] = json!([{"id":"a","parentTaskId":"t1","title":"a","criteria":"c","status":"complete","dependencyIds":[],"createdAt":"x","updatedAt":"x"}]);
                Ok(())
            })
            .unwrap();
        let ready = bench.staging.prepare(&bench.source).unwrap();
        bench
            .staging
            .start_ticket("T-1", &ready.base_branch)
            .unwrap();
        let tree = bench.staging.open_task("T-1", "a").unwrap();
        std::fs::write(Path::new(&tree.path).join("b.txt"), "two\n").unwrap();
        bench.staging.commit_task("a", "work").unwrap();
        bench.staging.sync_from_ticket("T-1", "a").unwrap();
        assert!(bench.staging.land("T-1", "a").unwrap().merged);
        bench.staging.close_task("T-1", "a").unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn publishing_makes_one_pr_and_automatic_merge_needs_the_exact_reviewed_head() {
        let bench = Bench::new();
        finished_ticket(&bench, "automatic");
        let first = publish(
            &bench.store,
            &bench.staging,
            "p",
            "t1",
            bench.source.to_str().unwrap(),
            &bench.forge(),
        )
        .unwrap();
        let ticket = bench.ticket();
        assert_eq!(ticket["status"], "review");
        assert_eq!(ticket["pullRequest"]["url"], "https://example.test/pr/1");
        assert_eq!(ticket["pullRequest"]["review"], "pending");
        assert_eq!(ticket["pullRequest"]["head"], first.head);
        // The ticket branch reached the remote, and nothing else did.
        let branches = sh(&bench.remote, &["git", "branch", "--list"]);
        assert!(branches.contains("berdloop-T-1"), "{branches}");
        assert!(!branches.contains("berdloop-work"), "{branches}");
        // The checkout is still on main and clean.
        assert_eq!(
            sh(&bench.source, &["git", "symbolic-ref", "--short", "HEAD"]),
            "main"
        );
        assert!(sh(&bench.source, &["git", "status", "--porcelain"]).is_empty());
        // Publishing again reuses the PR: gh pr create ran exactly once.
        let again = publish(
            &bench.store,
            &bench.staging,
            "p",
            "t1",
            bench.source.to_str().unwrap(),
            &bench.forge(),
        )
        .unwrap();
        assert_eq!(again.url, first.url);
        assert_eq!(bench.gh_log().matches("pr create").count(), 1);

        // Not approved yet: nothing merges whatever the forge says.
        bench.view(&format!(r#"{{"state":"OPEN","headRefOid":"{}","mergeStateStatus":"CLEAN","statusCheckRollup":[]}}"#, first.head));
        assert_eq!(
            pr_sync(&bench.store, "p", "t1", &bench.source, &bench.forge())
                .unwrap()
                .state,
            "open"
        );
        assert!(!bench.gh_log().contains("pr merge"));

        // Approve the exact head.
        let scope = Scope {
            organization_id: "o".into(),
            project_id: "p".into(),
            role: "pr-code-review".into(),
            ticket_id: Some("t1".into()),
            task_id: None,
        };
        submit_to(&bench.store, &scope, &first.head, "Looks right", "[]").unwrap();
        assert_eq!(bench.ticket()["pullRequest"]["review"], "approved");

        // A pending check holds the merge; a failed one refuses it.
        bench.view(&format!(r#"{{"state":"OPEN","headRefOid":"{}","mergeStateStatus":"CLEAN","statusCheckRollup":[{{"conclusion":"","status":"IN_PROGRESS"}}]}}"#, first.head));
        assert_eq!(
            pr_sync(&bench.store, "p", "t1", &bench.source, &bench.forge())
                .unwrap()
                .state,
            "checks-pending"
        );
        bench.view(&format!(r#"{{"state":"OPEN","headRefOid":"{}","mergeStateStatus":"CLEAN","statusCheckRollup":[{{"conclusion":"FAILURE"}}]}}"#, first.head));
        assert_eq!(
            pr_sync(&bench.store, "p", "t1", &bench.source, &bench.forge())
                .unwrap()
                .state,
            "checks-failed"
        );
        // Branch protection on the forge is respected, never forced.
        bench.view(&format!(r#"{{"state":"OPEN","headRefOid":"{}","mergeStateStatus":"BLOCKED","statusCheckRollup":[{{"conclusion":"SUCCESS"}}]}}"#, first.head));
        assert_eq!(
            pr_sync(&bench.store, "p", "t1", &bench.source, &bench.forge())
                .unwrap()
                .state,
            "blocked"
        );
        // A commit pushed behind our back invalidates the approval.
        bench.view(r#"{"state":"OPEN","headRefOid":"someone-else","mergeStateStatus":"CLEAN","statusCheckRollup":[{"conclusion":"SUCCESS"}]}"#);
        assert_eq!(
            pr_sync(&bench.store, "p", "t1", &bench.source, &bench.forge())
                .unwrap()
                .state,
            "head-moved"
        );
        assert_eq!(bench.ticket()["pullRequest"]["review"], "pending");
        assert_eq!(bench.ticket()["pullRequest"]["head"], "someone-else");
        assert!(!bench.gh_log().contains("pr merge"));

        // Back on the reviewed head, approved, green and clean: it merges, and
        // only with the head pinned.
        bench
            .store
            .change(|w| {
                w["tasks"][0]["pullRequest"]["head"] = json!(first.head);
                w["tasks"][0]["pullRequest"]["review"] = json!("approved");
                Ok(())
            })
            .unwrap();
        bench.view(&format!(r#"{{"state":"OPEN","headRefOid":"{}","mergeStateStatus":"CLEAN","statusCheckRollup":[{{"conclusion":"SUCCESS"}},{{"state":"SUCCESS"}}]}}"#, first.head));
        assert_eq!(
            pr_sync(&bench.store, "p", "t1", &bench.source, &bench.forge())
                .unwrap()
                .state,
            "merged"
        );
        assert!(
            bench.gh_log().contains(&format!(
                "pr merge https://example.test/pr/1 --merge --match-head-commit {}",
                first.head
            )),
            "{}",
            bench.gh_log()
        );
        let done = bench.ticket();
        assert_eq!(done["status"], "complete");
        assert_eq!(done["pullRequest"]["merged"], true);
    }

    #[test]
    #[cfg(unix)]
    fn manual_policy_leaves_the_pr_to_a_person_and_notices_their_merge() {
        let bench = Bench::new();
        finished_ticket(&bench, "manual");
        let published = publish(
            &bench.store,
            &bench.staging,
            "p",
            "t1",
            bench.source.to_str().unwrap(),
            &bench.forge(),
        )
        .unwrap();
        let scope = Scope {
            organization_id: "o".into(),
            project_id: "p".into(),
            role: "pr-code-review".into(),
            ticket_id: Some("t1".into()),
            task_id: None,
        };
        submit_to(&bench.store, &scope, &published.head, "Fine", "[]").unwrap();
        bench.view(&format!(r#"{{"state":"OPEN","headRefOid":"{}","mergeStateStatus":"CLEAN","statusCheckRollup":[{{"conclusion":"SUCCESS"}}]}}"#, published.head));
        assert_eq!(
            pr_sync(&bench.store, "p", "t1", &bench.source, &bench.forge())
                .unwrap()
                .state,
            "waiting-for-human"
        );
        assert!(!bench.gh_log().contains("pr merge"));
        assert_eq!(bench.ticket()["status"], "review");
        bench.view(r#"{"state":"MERGED"}"#);
        assert_eq!(
            pr_sync(&bench.store, "p", "t1", &bench.source, &bench.forge())
                .unwrap()
                .state,
            "merged"
        );
        assert_eq!(bench.ticket()["status"], "complete");
    }

    #[test]
    #[cfg(unix)]
    fn a_forge_that_cannot_be_reached_is_an_error_not_a_merge() {
        let bench = Bench::new();
        finished_ticket(&bench, "automatic");
        let missing = Forge {
            program: bench.root.join("missing-gh").to_string_lossy().into_owned(),
            env: vec![],
        };
        let refused = publish(
            &bench.store,
            &bench.staging,
            "p",
            "t1",
            bench.source.to_str().unwrap(),
            &missing,
        );
        assert!(refused.unwrap_err().contains("Could not run"));
        // The ticket is untouched and can be retried.
        assert_eq!(bench.ticket()["status"], "running");
        assert!(bench.ticket().get("pullRequest").is_none());
    }

    #[test]
    fn what_the_forge_reports_decides_what_happens() {
        let head = "abc";
        let view = |state: &str, sha: &str, merge: &str, checks: &str| {
            serde_json::from_str::<Value>(&format!(r#"{{"state":"{state}","headRefOid":"{sha}","mergeStateStatus":"{merge}","statusCheckRollup":{checks}}}"#)).unwrap()
        };
        assert_eq!(
            pull_state(
                &view("MERGED", head, "CLEAN", "[]"),
                head,
                "pending",
                "manual"
            ),
            "merged"
        );
        assert_eq!(
            pull_state(
                &view("CLOSED", head, "CLEAN", "[]"),
                head,
                "approved",
                "automatic"
            ),
            "closed"
        );
        assert_eq!(
            pull_state(
                &view("OPEN", "other", "CLEAN", "[]"),
                head,
                "approved",
                "automatic"
            ),
            "head-moved"
        );
        assert_eq!(
            pull_state(
                &view("OPEN", head, "CLEAN", "[]"),
                head,
                "pending",
                "automatic"
            ),
            "open"
        );
        assert_eq!(
            pull_state(
                &view("OPEN", head, "CLEAN", "[]"),
                head,
                "approved",
                "manual"
            ),
            "waiting-for-human"
        );
        assert_eq!(
            pull_state(
                &view("OPEN", head, "CLEAN", r#"[{"state":"PENDING"}]"#),
                head,
                "approved",
                "automatic"
            ),
            "checks-pending"
        );
        assert_eq!(
            pull_state(
                &view("OPEN", head, "CLEAN", r#"[{"conclusion":"CANCELLED"}]"#),
                head,
                "approved",
                "automatic"
            ),
            "checks-failed"
        );
        assert_eq!(
            pull_state(
                &view("OPEN", head, "BEHIND", r#"[{"conclusion":"SUCCESS"}]"#),
                head,
                "approved",
                "automatic"
            ),
            "blocked"
        );
        assert_eq!(
            pull_state(
                &view(
                    "OPEN",
                    head,
                    "CLEAN",
                    r#"[{"conclusion":"SUCCESS"},{"conclusion":"SKIPPED"}]"#
                ),
                head,
                "approved",
                "automatic"
            ),
            "ready-to-merge"
        );
        // No checks configured at all is not a failure; the forge's own
        // protection rules still have to say CLEAN.
        assert_eq!(
            pull_state(
                &view("OPEN", head, "CLEAN", "[]"),
                head,
                "approved",
                "automatic"
            ),
            "ready-to-merge"
        );
    }

    #[test]
    fn findings_preempt_the_next_ticket_and_stale_reviews_are_rejected() {
        let scope = Scope {
            organization_id: "org".into(),
            project_id: "p".into(),
            role: "pr-code-review".into(),
            ticket_id: Some("old".into()),
            task_id: None,
        };
        let mut w = json!({"schemaVersion":1,"tasks":[
            {"id":"next","projectId":"p","title":"Next","criteria":"B","status":"running"},
            {"id":"old","projectId":"p","title":"Old","criteria":"A","status":"review",
                "pullRequest":{"url":"https://example.test/pr","head":"abc","review":"pending"}}
        ],"agentTasks":[]});
        let findings =
            vec![json!({"title":"Fix regression","criteria":"Restore the old behavior"})];
        assert!(apply_review(&mut w, &scope, "old", "stale", "summary", &findings).is_err());
        assert_eq!(w["tasks"][0]["id"], "next");
        apply_review(&mut w, &scope, "old", "abc", "summary", &findings).unwrap();
        assert_eq!(w["tasks"][0]["id"], "old");
        assert_eq!(w["tasks"][0]["status"], "running");
        assert_eq!(w["agentTasks"][0]["reviewFix"], true);
        assert_eq!(w["agentTasks"][0]["status"], "ready");
        assert!(apply_review(&mut w, &scope, "old", "abc", "again", &findings).is_err());
    }
}
