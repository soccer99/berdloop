//! Ticket publication and independent review lifecycle.
use crate::forge::{self, Forge, Pull};
use crate::{git, workspace};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::Path, process::Command, sync::Mutex, time::Duration};
use tauri::{Emitter, Manager};

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
pub async fn publish_ticket_pr(
    app: tauri::AppHandle,
    project_id: String,
    ticket_id: String,
    source: String,
) -> Result<ReviewContext, String> {
    crate::offload(move || publish_ticket_pr_blocking(app, project_id, ticket_id, source)).await
}

fn publish_ticket_pr_blocking(
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
        forge::for_repo(Path::new(&source))?.as_ref(),
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
    forge: &dyn Forge,
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
    // A pull request this ticket already has is reused. Otherwise the host is
    // asked whether the branch has one, because a person may have opened it.
    let url = match previous.and_then(|p| p["url"].as_str()) {
        Some(url) => url.to_owned(),
        None => match forge.find(&published)? {
            Some(pull) => pull.url,
            None => {
                forge
                    .create(
                        &published,
                        &prepared.base_branch,
                        &format!("{key}: {title}"),
                        &criteria,
                    )?
                    .url
            }
        },
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
    /// One of: merged, open, checks-pending, checks-failed, conflicts,
    /// blocked, closed, head-moved, waiting-for-human.
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
pub async fn ticket_pr_sync(
    app: tauri::AppHandle,
    project_id: String,
    ticket_id: String,
    source: String,
) -> Result<PullState, String> {
    crate::offload(move || ticket_pr_sync_blocking(app, project_id, ticket_id, source)).await
}

fn ticket_pr_sync_blocking(
    app: tauri::AppHandle,
    project_id: String,
    ticket_id: String,
    source: String,
) -> Result<PullState, String> {
    pr_sync(
        &workspace::for_app(&app)?,
        &git::staging_for(&app, &project_id)?,
        Path::new(&source),
        &project_id,
        &ticket_id,
        forge::for_repo(Path::new(&source))?.as_ref(),
    )
}

pub fn pr_sync(
    store: &workspace::Store,
    staging: &git::Staging,
    source: &Path,
    project_id: &str,
    ticket_id: &str,
    forge: &dyn Forge,
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
    let pull_ref = Pull::from_url(&url)?;
    let view = forge.view(&pull_ref)?;
    let mut state = pull_state(
        &view,
        &head,
        pull["review"].as_str().unwrap_or("pending"),
        policy,
    );
    if state == "ready-to-merge" {
        forge.merge(&pull_ref, &head)?;
        state = "merged".into();
    }
    // A broken build is treated as a reviewer would be: it says what is wrong,
    // and the ticket goes back to the workers with that as its next work. A
    // branch that will not merge is the same thing said by the host instead of
    // by a job, and it goes back the same way.
    let findings = match state.as_str() {
        "checks-failed" => ci_findings(&view, &head),
        "conflicts" => {
            let base = pull["baseBranch"].as_str().unwrap_or("main");
            conflict_findings(&staging.forge_base(source, base), base, &head)
        }
        _ => Vec::new(),
    };
    if !findings.is_empty() {
        store.change(|w| queue_fix_tasks(w, project_id, ticket_id, &findings))?;
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

/// One entry per check, keeping only the newest run of each.
///
/// A commit can carry more than one run of the same job: a rerun, or a `push`
/// and a `pull_request` trigger firing together. The forge reports every one
/// of them, so a stale failure sits in the rollup beside the green rerun that
/// replaced it. Reading them all would call the pull request broken for as
/// long as that stale entry lives.
pub fn latest_checks(view: &Value) -> Vec<Value> {
    let mut newest: std::collections::BTreeMap<String, ((String, i64), Value)> = Default::default();
    for check in view["statusCheckRollup"]
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        let key = format!(
            "{}/{}",
            check["workflowName"].as_str().unwrap_or(""),
            check_name(&check)
        );
        // These stamps are ISO 8601 in UTC, so the newest is also the largest
        // string. A rerun still running has no end, but a later start.
        let at = ["completedAt", "startedAt", "createdAt"]
            .iter()
            .filter_map(|field| check[*field].as_str())
            .max()
            .unwrap_or("")
            .to_owned();
        // Two runs of one job really do finish in the same second, and then
        // the timestamps cannot separate them. Every host numbers a newer run
        // higher, so that number is the tie-break.
        let rank = (at, check["order"].as_i64().unwrap_or_default());
        match newest.get(&key) {
            Some((seen, _)) if *seen >= rank => {}
            _ => {
                newest.insert(key, (rank, check));
            }
        }
    }
    newest.into_values().map(|(_, check)| check).collect()
}

fn check_name(check: &Value) -> &str {
    check["name"]
        .as_str()
        .or(check["context"].as_str())
        .unwrap_or("check")
}

fn verdict(check: &Value) -> String {
    check["conclusion"]
        .as_str()
        .or(check["state"].as_str())
        .unwrap_or("")
        .to_uppercase()
}

fn check_failed(check: &Value) -> bool {
    !["SUCCESS", "SKIPPED", "NEUTRAL"].contains(&verdict(check).as_str())
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
    // A branch that cannot merge is read before its build is. The host runs
    // most checks against the merge it cannot make, so a conflicted pull
    // request reports whatever the last mergeable commit reported, or nothing
    // at all, and waiting on that build left it sitting still forever.
    if view["mergeStateStatus"].as_str() == Some("DIRTY") {
        return "conflicts".into();
    }
    // The build is read before the review is. A failing build is work whoever
    // reviews it, and waiting for a verdict that may never come left every
    // broken pull request sitting still.
    let checks = latest_checks(view);
    if checks.iter().any(|c| {
        verdict(c).is_empty()
            || ["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED"].contains(&verdict(c).as_str())
    }) {
        return "checks-pending".into();
    }
    if checks.iter().any(check_failed) {
        return "checks-failed".into();
    }
    if review != "approved" {
        return "open".into();
    }
    if policy != "automatic" {
        return "waiting-for-human".into();
    }
    // The forge applies its own branch protection. Anything but CLEAN means a
    // rule it enforces is not met, and forcing past it is never our call.
    if view["mergeStateStatus"].as_str() != Some("CLEAN") {
        return "blocked".into();
    }
    "ready-to-merge".into()
}

/// One fix task for each failing job.
///
/// The log is not read here. The worker is given the job's own address and
/// reads exactly as much of the failure as it needs; copying a truncated log
/// into the task would only take that choice away.
pub fn ci_findings(view: &Value, head: &str) -> Vec<Value> {
    latest_checks(view)
        .iter()
        .filter(|check| check_failed(check))
        .map(|check| {
            let name = check_name(check);
            let workflow = check["workflowName"].as_str().unwrap_or("");
            let url = check["detailsUrl"]
                .as_str()
                .or(check["targetUrl"].as_str())
                .unwrap_or("");
            // No command line tool is named. The job's own page holds the log,
            // and a worker may have neither `gh` nor `glab` installed.
            let where_from = if url.is_empty() {
                "Find the failing job on the pull request.".to_string()
            } else {
                format!("The job and its log are at: {url}")
            };
            let criteria = [
                if workflow.is_empty() {
                    format!("The CI job \"{name}\" failed on commit {head}.")
                } else {
                    format!("The CI job \"{name}\" of workflow \"{workflow}\" failed on commit {head}.")
                },
                where_from,
                "Fix the cause in the repository. Never change the CI settings to hide the failure."
                    .into(),
                format!("Done when \"{name}\" passes for this ticket's branch."),
            ]
            .join("\n");
            json!({
                "title": format!("Fix failing CI job: {name}"),
                "criteria": criteria,
                // Polling reports the same broken job over and over. This is
                // what keeps it from becoming a new task every time.
                "ciKey": format!("{head}:{name}"),
            })
        })
        .collect()
}

/// One task to bring the base branch in and resolve what clashes.
///
/// The conflicting files are not listed. The host reports that a merge fails,
/// never which hunks lose, and only the merge itself can say: the worker runs
/// it in its own worktree and reads exactly what comes out.
///
/// Keyed by the head, so the same broken commit is queued once however often
/// it is polled, and a new head that still conflicts gets a fresh attempt.
pub fn conflict_findings(base_ref: &str, base_branch: &str, head: &str) -> Vec<Value> {
    let criteria = [
        format!("The pull request cannot merge: commit {head} conflicts with {base_branch}."),
        format!(
            "In your worktree run `git merge {base_ref}`, resolve every conflicted file, and commit."
        ),
        "Keep both intentions. Never drop the base branch's work to make the merge go through."
            .to_string(),
        "Then land as usual: merge_sync, then merge_land.".to_string(),
        format!("Done when `git merge {base_ref}` reports nothing left to merge."),
    ]
    .join("\n");
    vec![json!({
        "title": format!("Resolve conflicts with {base_branch}"),
        "criteria": criteria,
        "ciKey": format!("conflict:{head}"),
    })]
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
pub async fn pr_review_context(
    app: tauri::AppHandle,
    project_id: String,
    ticket_id: String,
) -> Result<ReviewContext, String> {
    crate::offload(move || pr_review_context_blocking(app, project_id, ticket_id)).await
}

fn pr_review_context_blocking(
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
    if findings.is_empty() {
        return Ok(());
    }
    queue_fix_tasks(w, &scope.project_id, ticket_id, findings)
}

/// Put fix tasks at the front of a ticket's queue and send it back to work.
///
/// Both the reviewer and a failing build arrive here, because the answer to
/// each is the same: work this ticket before any other. A finding that
/// carries a `ciKey` is queued once only. The build is polled again and
/// again, and the same broken job must not become a new task every time.
pub fn queue_fix_tasks(
    w: &mut Value,
    project_id: &str,
    ticket_id: &str,
    findings: &[Value],
) -> Result<(), String> {
    let queued: std::collections::HashSet<String> = w["agentTasks"]
        .as_array()
        .ok_or("Invalid tasks")?
        .iter()
        .filter(|task| task["parentTaskId"] == ticket_id)
        .filter_map(|task| task["ciKey"].as_str().map(str::to_owned))
        .collect();
    let fresh: Vec<&Value> = findings
        .iter()
        .filter(|finding| {
            finding["ciKey"]
                .as_str()
                .is_none_or(|key| !queued.contains(key))
        })
        .collect();
    if fresh.is_empty() {
        return Ok(());
    }

    let now = workspace::now();
    let tickets = w["tasks"].as_array_mut().ok_or("Invalid tickets")?;
    let position = tickets
        .iter()
        .position(|item| item["id"] == ticket_id && item["projectId"] == project_id)
        .ok_or("Ticket disappeared")?;
    // The ticket has work again, so it leaves review and goes to the front.
    tickets[position]["status"] = json!("running");
    tickets[position]["stage"] = json!("Engineer");
    tickets[position]["updatedAt"] = json!(now);
    let prioritized = tickets.remove(position);
    tickets.insert(0, prioritized);

    let tasks = w["agentTasks"].as_array_mut().ok_or("Invalid tasks")?;
    for finding in fresh.iter().rev() {
        let mut task = json!({"id":uuid::Uuid::new_v4().to_string(),"parentTaskId":ticket_id,
                "title":finding["title"],"criteria":finding["criteria"],"prompt":finding["criteria"],
                "dependencyIds":[],"status":"ready","reviewFix":true,"createdAt":now,"updatedAt":now});
        if let Some(key) = finding["ciKey"].as_str() {
            task["ciKey"] = json!(key);
        }
        tasks.insert(0, task);
    }
    Ok(())
}

/// A project the watcher may run the forge tool in.
///
/// Projects live in the window, not here, so the window hands them over. A
/// project it has not named is simply not watched.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchedProject {
    pub id: String,
    pub path: String,
}

#[derive(Default)]
pub struct Watched(pub Mutex<Vec<WatchedProject>>);

#[tauri::command]
pub fn watch_projects(watched: tauri::State<'_, Watched>, projects: Vec<WatchedProject>) {
    *watched.0.lock().unwrap() = projects;
}

/// How often every open pull request is compared with the forge.
const WATCH_SECS: u64 = 30;

/// Follow every open pull request, in every project, for as long as the app
/// runs.
///
/// The Ralph loop does this for one project only, and only while a person has
/// it running. A build finishes on its own schedule, so waiting for the loop
/// left failing pull requests sitting untouched. This asks the forge instead,
/// and `pr_sync` turns each answer into the same records the loop reads: fix
/// tasks for a broken build, a completed ticket for a merge.
///
/// Starting review agents is still the window's job. Only the records are
/// kept here.
///
/// ponytail: every open pull request is asked about on every pass. Keep a
/// per-ticket backoff if the forge ever rate limits.
pub fn watch(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(WATCH_SECS));
        if let Err(error) = watch_pass(&app) {
            eprintln!("could not follow pull requests: {error}");
        }
    });
}

fn watch_pass(app: &tauri::AppHandle) -> Result<(), String> {
    let projects = app.state::<Watched>().0.lock().unwrap().clone();
    if projects.is_empty() {
        return Ok(());
    }
    let store = workspace::for_app(app)?;
    let before = store.load()?;
    // One connection per project, not per pull request: reading the remote and
    // the saved sign-in costs two git calls, and neither changes within a pass.
    let mut forges: std::collections::HashMap<String, Result<Box<dyn Forge>, String>> =
        Default::default();
    for (project_id, ticket_id) in open_pulls(&before) {
        let Some(project) = projects.iter().find(|item| item.id == project_id) else {
            continue;
        };
        let forge = forges
            .entry(project_id.clone())
            .or_insert_with(|| forge::for_repo(Path::new(&project.path)));
        // One pull request the host cannot answer for must not stop the rest.
        let outcome = match forge {
            Ok(forge) => git::staging_for(app, &project_id).and_then(|staging| {
                pr_sync(
                    &store,
                    &staging,
                    Path::new(&project.path),
                    &project_id,
                    &ticket_id,
                    forge.as_ref(),
                )
            }),
            Err(error) => Err(error.clone()),
        };
        if let Err(error) = outcome {
            eprintln!("{ticket_id}: {error}");
        }
    }
    if store.load()? != before {
        // The window keeps its own copy and only reads records back when it
        // writes. Without this it would show yesterday's board.
        app.emit("workspace-changed", ())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Every ticket with a pull request that is not finished with.
fn open_pulls(w: &Value) -> Vec<(String, String)> {
    w["tasks"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|ticket| {
            ticket.get("pullRequest").is_some()
                && ticket["pullRequest"]["merged"] != json!(true)
                && ticket["status"] != "complete"
        })
        .filter_map(|ticket| {
            Some((
                ticket["projectId"].as_str()?.to_owned(),
                ticket["id"].as_str()?.to_owned(),
            ))
        })
        .collect()
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

    /// A host that answers from a file and writes down what it was asked.
    ///
    /// Both live on disk rather than in the struct, so a fresh one still sees
    /// what an earlier call did, exactly as a real host would.
    struct Fake {
        log: std::path::PathBuf,
        view: std::path::PathBuf,
        reachable: bool,
    }

    impl Fake {
        fn say(&self, line: &str) -> Result<(), String> {
            if !self.reachable {
                return Err("Could not reach example.test".into());
            }
            use std::io::Write;
            writeln!(
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.log)
                    .unwrap(),
                "{line}"
            )
            .unwrap();
            Ok(())
        }
    }

    impl Forge for Fake {
        fn find(&self, branch: &str) -> Result<Option<Pull>, String> {
            self.say(&format!("find {branch}"))?;
            Ok(None)
        }

        fn create(&self, head: &str, base: &str, title: &str, _body: &str) -> Result<Pull, String> {
            self.say(&format!("create {head} into {base}: {title}"))?;
            Ok(Pull {
                url: "https://example.test/pr/1".into(),
                number: 1,
            })
        }

        fn view(&self, pull: &Pull) -> Result<Value, String> {
            self.say(&format!("view {}", pull.number))?;
            serde_json::from_str(&std::fs::read_to_string(&self.view).unwrap_or_default())
                .map_err(|error| error.to_string())
        }

        fn merge(&self, pull: &Pull, head: &str) -> Result<(), String> {
            self.say(&format!("merge {} at {head}", pull.number))?;
            std::fs::write(&self.view, r#"{"state":"MERGED"}"#).unwrap();
            Ok(())
        }

        fn describe(&self) -> String {
            "the test host".into()
        }
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

        fn forge(&self) -> Fake {
            Fake {
                log: self.root.join("calls.log"),
                view: self.root.join("view.json"),
                reachable: true,
            }
        }

        /// What the host was asked to do, in order.
        fn calls(&self) -> String {
            std::fs::read_to_string(self.root.join("calls.log")).unwrap_or_default()
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
        // Publishing again reuses the PR: it was created exactly once.
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
        assert_eq!(bench.calls().matches("create ").count(), 1);

        // Not approved yet: nothing merges whatever the forge says.
        bench.view(&format!(r#"{{"state":"OPEN","headRefOid":"{}","mergeStateStatus":"CLEAN","statusCheckRollup":[]}}"#, first.head));
        assert_eq!(
            pr_sync(
                &bench.store,
                &bench.staging,
                &bench.source,
                "p",
                "t1",
                &bench.forge()
            )
            .unwrap()
            .state,
            "open"
        );
        assert!(!bench.calls().contains("merge "));

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
            pr_sync(
                &bench.store,
                &bench.staging,
                &bench.source,
                "p",
                "t1",
                &bench.forge()
            )
            .unwrap()
            .state,
            "checks-pending"
        );
        bench.view(&format!(r#"{{"state":"OPEN","headRefOid":"{}","mergeStateStatus":"CLEAN","statusCheckRollup":[{{"conclusion":"FAILURE"}}]}}"#, first.head));
        assert_eq!(
            pr_sync(
                &bench.store,
                &bench.staging,
                &bench.source,
                "p",
                "t1",
                &bench.forge()
            )
            .unwrap()
            .state,
            "checks-failed"
        );
        // Branch protection on the forge is respected, never forced.
        bench.view(&format!(r#"{{"state":"OPEN","headRefOid":"{}","mergeStateStatus":"BLOCKED","statusCheckRollup":[{{"conclusion":"SUCCESS"}}]}}"#, first.head));
        assert_eq!(
            pr_sync(
                &bench.store,
                &bench.staging,
                &bench.source,
                "p",
                "t1",
                &bench.forge()
            )
            .unwrap()
            .state,
            "blocked"
        );
        // A commit pushed behind our back invalidates the approval.
        bench.view(r#"{"state":"OPEN","headRefOid":"someone-else","mergeStateStatus":"CLEAN","statusCheckRollup":[{"conclusion":"SUCCESS"}]}"#);
        assert_eq!(
            pr_sync(
                &bench.store,
                &bench.staging,
                &bench.source,
                "p",
                "t1",
                &bench.forge()
            )
            .unwrap()
            .state,
            "head-moved"
        );
        assert_eq!(bench.ticket()["pullRequest"]["review"], "pending");
        assert_eq!(bench.ticket()["pullRequest"]["head"], "someone-else");
        assert!(!bench.calls().contains("merge "));

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
            pr_sync(
                &bench.store,
                &bench.staging,
                &bench.source,
                "p",
                "t1",
                &bench.forge()
            )
            .unwrap()
            .state,
            "merged"
        );
        assert!(
            bench
                .calls()
                .contains(&format!("merge 1 at {}", first.head)),
            "{}",
            bench.calls()
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
            pr_sync(
                &bench.store,
                &bench.staging,
                &bench.source,
                "p",
                "t1",
                &bench.forge()
            )
            .unwrap()
            .state,
            "waiting-for-human"
        );
        assert!(!bench.calls().contains("merge "));
        assert_eq!(bench.ticket()["status"], "review");
        bench.view(r#"{"state":"MERGED"}"#);
        assert_eq!(
            pr_sync(
                &bench.store,
                &bench.staging,
                &bench.source,
                "p",
                "t1",
                &bench.forge()
            )
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
        let missing = Fake {
            log: bench.root.join("calls.log"),
            view: bench.root.join("view.json"),
            reachable: false,
        };
        let refused = publish(
            &bench.store,
            &bench.staging,
            "p",
            "t1",
            bench.source.to_str().unwrap(),
            &missing,
        );
        assert!(refused.unwrap_err().contains("Could not reach"));
        // The ticket is untouched and can be retried.
        assert_eq!(bench.ticket()["status"], "running");
        assert!(bench.ticket().get("pullRequest").is_none());
    }

    /// The watcher asks the forge about pull requests it can still change.
    #[test]
    fn only_unfinished_pull_requests_are_followed() {
        let w = json!({"tasks":[
            {"id":"no-pr","projectId":"p","status":"running"},
            {"id":"open","projectId":"p","status":"review","pullRequest":{"merged":false}},
            {"id":"failing","projectId":"p","status":"running","pullRequest":{"merged":false}},
            {"id":"merged","projectId":"p","status":"complete","pullRequest":{"merged":true}}
        ]});
        assert_eq!(
            open_pulls(&w),
            vec![
                ("p".to_string(), "open".to_string()),
                ("p".to_string(), "failing".to_string())
            ]
        );
    }

    /// The real shape of PR #3: two runs of the same workflow on one commit,
    /// the older one red. Reading both would keep the PR broken for good.
    #[test]
    fn a_rerun_replaces_the_run_it_repeated() {
        let head = "abc";
        // Straight from PR #3: the repaired "frontend" finished in the very
        // same second as the one it replaced, so only the id tells them apart.
        let rollup = r#"[
          {"name":"frontend","conclusion":"SUCCESS","startedAt":"2026-09-18T21:34:33Z","completedAt":"2026-09-18T21:34:48Z","order":105769425547,"detailsUrl":"https://x/actions/runs/2/job/22"},
          {"name":"frontend","conclusion":"FAILURE","startedAt":"2026-09-18T21:34:32Z","completedAt":"2026-09-18T21:34:48Z","order":105769422249,"detailsUrl":"https://x/actions/runs/1/job/11"},
          {"name":"desktop","conclusion":"FAILURE","startedAt":"2026-09-18T21:34:37Z","completedAt":"2026-09-18T21:34:58Z","order":105769421868,"detailsUrl":"https://x/actions/runs/1/job/33"}
        ]"#;
        let view: Value = serde_json::from_str(&format!(
            r#"{{"state":"OPEN","headRefOid":"{head}","mergeStateStatus":"CLEAN","statusCheckRollup":{rollup}}}"#
        ))
        .unwrap();
        assert_eq!(latest_checks(&view).len(), 2);
        // Still failed, but only because of "desktop". "frontend" was repaired.
        assert_eq!(
            pull_state(&view, head, "approved", "automatic"),
            "checks-failed"
        );
        let findings = ci_findings(&view, head);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0]["ciKey"], json!("abc:desktop"));
        let criteria = findings[0]["criteria"].as_str().unwrap();
        // The worker is pointed at the job, not at a tool it may not have.
        assert!(
            criteria.contains("https://x/actions/runs/1/job/33"),
            "{criteria}"
        );
        assert!(!criteria.contains("gh "), "{criteria}");
    }

    /// A build is watched before anyone reviews it, and reports the same
    /// broken job every poll. Each poll must not add another task.
    #[test]
    fn a_failing_build_queues_its_fix_once_without_waiting_for_a_review() {
        let head = "abc";
        let view: Value = serde_json::from_str(&format!(
            r#"{{"state":"OPEN","headRefOid":"{head}","mergeStateStatus":"CLEAN","statusCheckRollup":[{{"name":"desktop","workflowName":"Verify","conclusion":"FAILURE","completedAt":"2026-09-18T21:34:58Z","detailsUrl":"https://x/actions/runs/1/job/33"}}]}}"#
        ))
        .unwrap();
        // The review has not been submitted, and the old code stopped here.
        assert_eq!(
            pull_state(&view, head, "pending", "manual"),
            "checks-failed"
        );

        let mut w = json!({"schemaVersion":1,
            "tasks":[{"id":"other","projectId":"p"},
                     {"id":"t","projectId":"p","status":"review","stage":"Review"}],
            "agentTasks":[{"id":"done","parentTaskId":"t","status":"complete"}]});
        let findings = ci_findings(&view, head);
        queue_fix_tasks(&mut w, "p", "t", &findings).unwrap();
        queue_fix_tasks(&mut w, "p", "t", &findings).unwrap();

        assert_eq!(
            w["tasks"][0]["id"],
            json!("t"),
            "the ticket jumps the queue"
        );
        assert_eq!(w["tasks"][0]["status"], json!("running"));
        assert_eq!(w["tasks"][0]["stage"], json!("Engineer"));
        let fixes: Vec<_> = w["agentTasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|task| task["reviewFix"] == json!(true))
            .collect();
        assert_eq!(fixes.len(), 1, "polling must not queue the same job twice");
        assert_eq!(fixes[0]["status"], json!("ready"));
    }

    /// A branch that will not merge is work, not a wait.
    ///
    /// The host runs its checks against a merge it cannot make, so this one
    /// reports its build as still pending forever. Reading the build first
    /// left the pull request sitting there.
    #[test]
    fn a_conflicting_branch_queues_one_resolve_task_per_head() {
        let head = "abc";
        let view: Value = serde_json::from_str(&format!(
            r#"{{"state":"OPEN","headRefOid":"{head}","mergeStateStatus":"DIRTY","statusCheckRollup":[{{"name":"desktop","conclusion":"IN_PROGRESS"}}]}}"#
        ))
        .unwrap();
        assert_eq!(pull_state(&view, head, "pending", "manual"), "conflicts");
        // Approved and automatic changes nothing: it still cannot merge.
        assert_eq!(
            pull_state(&view, head, "approved", "automatic"),
            "conflicts"
        );

        let mut w = json!({"schemaVersion":1,
            "tasks":[{"id":"other","projectId":"p"},
                     {"id":"t","projectId":"p","status":"review","stage":"Review"}],
            "agentTasks":[{"id":"done","parentTaskId":"t","status":"complete"}]});
        let findings = conflict_findings("forge/main", "main", head);
        queue_fix_tasks(&mut w, "p", "t", &findings).unwrap();
        queue_fix_tasks(&mut w, "p", "t", &findings).unwrap();
        let fixes: Vec<_> = w["agentTasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|task| task["reviewFix"] == json!(true))
            .collect();
        assert_eq!(fixes.len(), 1, "polling must not queue the same head twice");
        assert_eq!(w["tasks"][0]["id"], json!("t"));
        assert_eq!(w["tasks"][0]["status"], json!("running"));
        let criteria = fixes[0]["criteria"].as_str().unwrap();
        assert!(criteria.contains("git merge forge/main"), "{criteria}");

        // A later head that still conflicts is a fresh attempt, not a repeat.
        queue_fix_tasks(
            &mut w,
            "p",
            "t",
            &conflict_findings("forge/main", "main", "def"),
        )
        .unwrap();
        assert_eq!(
            w["agentTasks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|task| task["reviewFix"] == json!(true))
                .count(),
            2
        );
    }

    /// End to end: the host says the branch conflicts, and the worker queue
    /// gets a task naming the base as the host has it.
    #[test]
    #[cfg(unix)]
    fn the_watcher_sends_a_conflict_back_to_the_workers() {
        let bench = Bench::new();
        finished_ticket(&bench, "automatic");
        let published = publish(
            &bench.store,
            &bench.staging,
            "p",
            "t1",
            bench.source.to_str().unwrap(),
            &bench.forge(),
        )
        .unwrap();
        bench.view(&format!(
            r#"{{"state":"OPEN","headRefOid":"{}","mergeStateStatus":"DIRTY","statusCheckRollup":[]}}"#,
            published.head
        ));
        assert_eq!(
            pr_sync(
                &bench.store,
                &bench.staging,
                &bench.source,
                "p",
                "t1",
                &bench.forge()
            )
            .unwrap()
            .state,
            "conflicts"
        );
        let w = bench.store.load().unwrap();
        assert_eq!(w["tasks"][0]["status"], json!("running"));
        assert_eq!(w["tasks"][0]["stage"], json!("Engineer"));
        let fix = w["agentTasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|task| task["reviewFix"] == json!(true))
            .expect("a resolve task")
            .clone();
        assert_eq!(fix["status"], json!("ready"));
        // The base is taken from the host's copy, which is what the pull
        // request is judged against.
        let criteria = fix["criteria"].as_str().unwrap();
        assert!(criteria.contains("git merge forge/main"), "{criteria}");
        // Nothing merged, and the checkout is untouched.
        assert!(!bench.calls().contains("merge 1"), "{}", bench.calls());
        assert!(sh(&bench.source, &["git", "status", "--porcelain"]).is_empty());
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
