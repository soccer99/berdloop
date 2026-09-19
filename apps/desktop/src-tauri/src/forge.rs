//! Pull requests and merge requests over HTTP, for GitHub and GitLab.
//!
//! No command line tool is needed. Berdloop already does every branch, every
//! worktree and every push with `git`, which speaks to both hosts and needs no
//! help. What `git` cannot do is open a pull request, read a build or merge,
//! and those three are ordinary HTTP calls.
//!
//! The token comes from `git credential fill`, so whatever already lets the
//! person push also lets Berdloop call the API: the macOS keychain, the GitHub
//! CLI's own helper, git-credential-manager, a plain `.netrc`. Nothing new to
//! install and nothing new to sign in to.
//!
//! Both hosts are reported in one shape, the one GitHub's GraphQL uses,
//! because `pr_review::pull_state` already reads it and is tested against it.

use serde_json::{json, Value};
use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

const TIMEOUT: Duration = Duration::from_secs(30);

/// A pull request, or the merge request that is the same thing on GitLab.
#[derive(Clone, Debug, PartialEq)]
pub struct Pull {
    pub url: String,
    pub number: u64,
}

impl Pull {
    /// Both hosts end the web address with the number, so a pull request
    /// recorded before this module existed is still addressable.
    pub fn from_url(url: &str) -> Result<Self, String> {
        url.trim_end_matches('/')
            .rsplit('/')
            .next()
            .and_then(|tail| tail.parse().ok())
            .map(|number| Pull {
                url: url.to_owned(),
                number,
            })
            .ok_or_else(|| format!("Could not read a pull request number from {url}"))
    }
}

pub trait Forge: Send + Sync {
    /// The open or closed pull request for this branch, if the host has one.
    fn find(&self, branch: &str) -> Result<Option<Pull>, String>;
    fn create(&self, head: &str, base: &str, title: &str, body: &str) -> Result<Pull, String>;
    /// State, head commit and every check, in one shape for both hosts.
    fn view(&self, pull: &Pull) -> Result<Value, String>;
    /// Merge, but only while the head is still the commit that was reviewed.
    fn merge(&self, pull: &Pull, head: &str) -> Result<(), String>;
    /// What to tell a person this is connected to.
    fn describe(&self) -> String;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Host {
    GitHub,
    GitLab,
}

/// Which repository on which host, read from a git remote.
#[derive(Clone, Debug, PartialEq)]
pub struct Repo {
    pub host: Host,
    /// The host as the credential helper knows it, such as `github.com`.
    pub domain: String,
    /// The full namespace path, such as `group/subgroup/repo`.
    pub path: String,
}

impl Repo {
    /// Read `https://`, `ssh://` and `git@host:path` remotes alike.
    ///
    /// Only the two hosted services are recognised. A self-managed GitLab or a
    /// GitHub Enterprise domain cannot be told apart from any other git server
    /// by its address alone, so it is refused by name rather than guessed at.
    pub fn from_remote(remote: &str) -> Result<Self, String> {
        let remote = remote.trim();
        let rest = match remote.split_once("://") {
            Some((_, rest)) => rest,
            None => remote,
        };
        // `git@github.com:owner/repo.git` puts the path after a colon.
        let rest = rest.split_once('@').map_or(rest, |(_, after)| after);
        let (domain, path) = match rest.split_once(':') {
            Some((domain, path)) if !path.starts_with("//") => (domain, path),
            _ => rest
                .split_once('/')
                .ok_or_else(|| format!("{remote} is not a repository address."))?,
        };
        let domain = domain.split(':').next().unwrap_or("").to_ascii_lowercase();
        let path = path.trim_matches('/').trim_end_matches(".git");
        if path.is_empty() || !path.contains('/') {
            return Err(format!("{remote} names no repository."));
        }
        let host = match domain.as_str() {
            "github.com" => Host::GitHub,
            "gitlab.com" => Host::GitLab,
            other => {
                return Err(format!(
                    "Berdloop opens pull requests on github.com and gitlab.com. This project's remote is {other}."
                ))
            }
        };
        Ok(Repo {
            host,
            domain,
            path: path.to_owned(),
        })
    }

    fn api(&self) -> String {
        match self.host {
            Host::GitHub => "https://api.github.com".into(),
            Host::GitLab => "https://gitlab.com/api/v4".into(),
        }
    }

    /// The owner a GitHub head filter needs: the first segment of the path.
    fn owner(&self) -> &str {
        self.path.split('/').next().unwrap_or(&self.path)
    }

    /// GitLab addresses a project by its path, escaped into one segment.
    fn encoded(&self) -> String {
        self.path.replace('/', "%2F")
    }
}

/// Ask git for the user name and token it would use to push to this host.
///
/// It runs in the repository, so the project's own credential helper, and any
/// host rule in the user's config, apply exactly as they do to a push.
fn credential(domain: &str, dir: &Path) -> Result<(String, String), String> {
    let mut child = Command::new("git")
        .args(["credential", "fill"])
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not run git: {error}"))?;
    child
        .stdin
        .take()
        .ok_or("Could not talk to git")?
        .write_all(format!("protocol=https\nhost={domain}\n\n").as_bytes())
        .map_err(|error| format!("Could not talk to git: {error}"))?;
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Could not read git: {error}"))?;
    let missing = || {
        format!(
            "No saved sign-in for {domain}. Sign in once, with `gh auth login`, \
             `glab auth login`, or any HTTPS push, and Berdloop will use it."
        )
    };
    if !output.status.success() {
        return Err(missing());
    }
    let mut user = String::new();
    let mut token = String::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        match line.split_once('=') {
            Some(("username", value)) => user = value.to_owned(),
            Some(("password", value)) => token = value.to_owned(),
            _ => {}
        }
    }
    if token.is_empty() {
        return Err(missing());
    }
    Ok((user, token))
}

/// The forge for the repository in `dir`, ready to call.
pub fn for_repo(dir: &Path) -> Result<Box<dyn Forge>, String> {
    let remote = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(dir)
        .output()
        .map_err(|error| format!("Could not run git: {error}"))?;
    if !remote.status.success() {
        return Err("This project has no `origin` remote to publish to.".into());
    }
    let repo = Repo::from_remote(&String::from_utf8_lossy(&remote.stdout))?;
    let (user, token) = credential(&repo.domain, dir)?;
    Ok(Box::new(Http {
        repo,
        user,
        token,
        client: reqwest::blocking::Client::builder()
            .timeout(TIMEOUT)
            .user_agent("berdloop")
            .build()
            .map_err(|error| error.to_string())?,
    }))
}

pub struct Http {
    repo: Repo,
    user: String,
    token: String,
    client: reqwest::blocking::Client,
}

impl Http {
    fn call(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let mut request = self.client.request(method, url);
        request = match self.repo.host {
            Host::GitHub => request
                .bearer_auth(&self.token)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28"),
            Host::GitLab => request.header("PRIVATE-TOKEN", &self.token),
        };
        if let Some(body) = &body {
            request = request.json(body);
        }
        let response = request
            .send()
            .map_err(|error| format!("Could not reach {}: {error}", self.repo.domain))?;
        let status = response.status();
        let text = response.text().unwrap_or_default();
        if !status.is_success() {
            // The host's own message says far more than the code does: a
            // missing scope, a protected branch, a head that moved.
            let detail: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            let said = detail["message"]
                .as_str()
                .or(detail["error"].as_str())
                .unwrap_or(text.trim());
            return Err(format!("{} said {status}: {said}", self.repo.domain));
        }
        serde_json::from_str(&text)
            .map_err(|error| format!("{} sent no JSON: {error}", self.repo.domain))
    }

    fn get(&self, url: &str) -> Result<Value, String> {
        self.call(reqwest::Method::GET, url, None)
    }

    /// Every check on a GitHub commit: Actions check runs, and the older
    /// commit statuses that many services still post.
    fn github_checks(&self, sha: &str) -> Result<Vec<Value>, String> {
        let api = self.repo.api();
        let path = &self.repo.path;
        // `filter=latest` is the default and is what drops a run that a rerun
        // has already replaced.
        let runs = self.get(&format!(
            "{api}/repos/{path}/commits/{sha}/check-runs?per_page=100"
        ))?;
        let mut checks: Vec<Value> = runs["check_runs"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|run| {
                let finished = run["status"].as_str() == Some("completed");
                json!({
                    "name": run["name"],
                    "conclusion": if finished {
                        run["conclusion"].as_str().unwrap_or("").to_uppercase()
                    } else {
                        "IN_PROGRESS".to_string()
                    },
                    "startedAt": run["started_at"],
                    "completedAt": run["completed_at"],
                    "detailsUrl": run["html_url"],
                    // Two runs of one job can finish in the same second. The
                    // id always rises, so it is what settles which is newer.
                    "order": run["id"],
                })
            })
            .collect();
        let combined = self.get(&format!(
            "{api}/repos/{path}/commits/{sha}/status?per_page=100"
        ))?;
        checks.extend(
            combined["statuses"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|status| {
                    json!({
                        "name": status["context"],
                        "conclusion": status["state"].as_str().unwrap_or("").to_uppercase(),
                        "startedAt": status["created_at"],
                        "completedAt": status["updated_at"],
                        "detailsUrl": status["target_url"],
                        "order": status["id"],
                    })
                }),
        );
        Ok(checks)
    }

    /// Every job of the merge request's newest pipeline.
    fn gitlab_checks(&self, pull: &Pull) -> Result<Vec<Value>, String> {
        let api = self.repo.api();
        let id = self.repo.encoded();
        let pipelines = self.get(&format!(
            "{api}/projects/{id}/merge_requests/{}/pipelines",
            pull.number
        ))?;
        // Newest first, so the first is the one that counts.
        let Some(pipeline) = pipelines.as_array().and_then(|list| list.first()) else {
            return Ok(Vec::new());
        };
        let pipeline_id = pipeline["id"].as_i64().unwrap_or_default();
        let jobs = self.get(&format!(
            "{api}/projects/{id}/pipelines/{pipeline_id}/jobs?per_page=100"
        ))?;
        Ok(jobs
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|job| {
                json!({
                    "name": job["name"],
                    "conclusion": gitlab_verdict(job),
                    "startedAt": job["started_at"],
                    "completedAt": job["finished_at"],
                    "detailsUrl": job["web_url"],
                    "order": job["id"],
                })
            })
            .collect())
    }
}

/// A GitLab job status, said the way GitHub says it.
///
/// A manual job waits for a person who may never come, and a job allowed to
/// fail was never a gate, so neither one holds a merge request open.
fn gitlab_verdict(job: &Value) -> &'static str {
    match job["status"].as_str().unwrap_or("") {
        "success" => "SUCCESS",
        "skipped" | "manual" => "SKIPPED",
        "failed" if job["allow_failure"] == json!(true) => "NEUTRAL",
        "failed" => "FAILURE",
        "canceled" | "canceling" => "CANCELLED",
        _ => "IN_PROGRESS",
    }
}

impl Forge for Http {
    fn find(&self, branch: &str) -> Result<Option<Pull>, String> {
        let api = self.repo.api();
        let found = match self.repo.host {
            Host::GitHub => {
                let owner = self.repo.owner();
                let path = &self.repo.path;
                let list = self.get(&format!(
                    "{api}/repos/{path}/pulls?state=all&head={owner}:{branch}"
                ))?;
                list.as_array().and_then(|items| items.first().cloned())
            }
            Host::GitLab => {
                let id = self.repo.encoded();
                let list = self.get(&format!(
                    "{api}/projects/{id}/merge_requests?state=all&source_branch={branch}"
                ))?;
                list.as_array().and_then(|items| items.first().cloned())
            }
        };
        Ok(found.and_then(|item| pull_of(&item)))
    }

    fn create(&self, head: &str, base: &str, title: &str, body: &str) -> Result<Pull, String> {
        let api = self.repo.api();
        let made = match self.repo.host {
            Host::GitHub => {
                let path = &self.repo.path;
                self.call(
                    reqwest::Method::POST,
                    &format!("{api}/repos/{path}/pulls"),
                    Some(json!({"title": title, "body": body, "head": head, "base": base})),
                )?
            }
            Host::GitLab => {
                let id = self.repo.encoded();
                self.call(
                    reqwest::Method::POST,
                    &format!("{api}/projects/{id}/merge_requests"),
                    Some(json!({"title": title, "description": body,
                                "source_branch": head, "target_branch": base})),
                )?
            }
        };
        pull_of(&made).ok_or_else(|| "The host made no pull request.".to_string())
    }

    fn view(&self, pull: &Pull) -> Result<Value, String> {
        let api = self.repo.api();
        match self.repo.host {
            Host::GitHub => {
                let path = &self.repo.path;
                let got = self.get(&format!("{api}/repos/{path}/pulls/{}", pull.number))?;
                let sha = got["head"]["sha"].as_str().unwrap_or("").to_owned();
                let state = if got["merged"] == json!(true) {
                    "MERGED"
                } else if got["state"].as_str() == Some("closed") {
                    "CLOSED"
                } else {
                    "OPEN"
                };
                // A pull request GitHub has not finished testing for conflicts
                // reads "unknown" for a moment. The next poll settles it.
                let mergeable = match got["mergeable_state"].as_str().unwrap_or("unknown") {
                    "clean" => "CLEAN".to_owned(),
                    other => other.to_uppercase(),
                };
                Ok(json!({
                    "state": state,
                    "headRefOid": sha,
                    "mergeStateStatus": mergeable,
                    "statusCheckRollup": self.github_checks(&sha)?,
                }))
            }
            Host::GitLab => {
                let id = self.repo.encoded();
                let got = self.get(&format!(
                    "{api}/projects/{id}/merge_requests/{}",
                    pull.number
                ))?;
                let state = match got["state"].as_str().unwrap_or("") {
                    "merged" => "MERGED",
                    "closed" | "locked" => "CLOSED",
                    _ => "OPEN",
                };
                // A conflict is told apart from every other reason a merge
                // request will not merge, because it is the only one work on
                // the branch itself can clear.
                let mergeable = match got["detailed_merge_status"].as_str().unwrap_or("") {
                    "mergeable" => "CLEAN",
                    "conflict" => "DIRTY",
                    _ => "BLOCKED",
                };
                Ok(json!({
                    "state": state,
                    "headRefOid": got["sha"],
                    "mergeStateStatus": mergeable,
                    "statusCheckRollup": self.gitlab_checks(pull)?,
                }))
            }
        }
    }

    fn merge(&self, pull: &Pull, head: &str) -> Result<(), String> {
        let api = self.repo.api();
        // Both hosts refuse the merge if the head has moved on, which is the
        // whole point: only the reviewed commit may land.
        match self.repo.host {
            Host::GitHub => {
                let path = &self.repo.path;
                self.call(
                    reqwest::Method::PUT,
                    &format!("{api}/repos/{path}/pulls/{}/merge", pull.number),
                    Some(json!({"sha": head, "merge_method": "merge"})),
                )?;
            }
            Host::GitLab => {
                let id = self.repo.encoded();
                self.call(
                    reqwest::Method::PUT,
                    &format!("{api}/projects/{id}/merge_requests/{}/merge", pull.number),
                    Some(json!({"sha": head})),
                )?;
            }
        }
        Ok(())
    }

    fn describe(&self) -> String {
        let host = match self.repo.host {
            Host::GitHub => "GitHub",
            Host::GitLab => "GitLab",
        };
        let path = &self.repo.path;
        match self.user.as_str() {
            "" => format!("{host} {path}"),
            user => format!("{host} {path}, signed in as {user}"),
        }
    }
}

/// The address and number out of whatever the host called them.
fn pull_of(item: &Value) -> Option<Pull> {
    let url = item["html_url"].as_str().or(item["web_url"].as_str())?;
    let number = item["number"].as_i64().or(item["iid"].as_i64())?;
    Some(Pull {
        url: url.to_owned(),
        number: number as u64,
    })
}

/// Whether this project can have pull requests opened for it, and by whom.
///
/// Called before a person commits workers to a ticket, so a missing sign-in
/// is found while it costs nothing.
#[tauri::command]
pub fn forge_check(path: String) -> Result<String, String> {
    for_repo(Path::new(&path)).map(|forge| forge.describe())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remotes_of_every_shape_name_the_same_repository() {
        for remote in [
            "https://github.com/soccer99/berdloop.git",
            "git@github.com:soccer99/berdloop.git",
            "ssh://git@github.com/soccer99/berdloop",
            "https://soccer99@github.com/soccer99/berdloop.git\n",
        ] {
            let repo = Repo::from_remote(remote).unwrap();
            assert_eq!(repo.host, Host::GitHub, "{remote}");
            assert_eq!(repo.domain, "github.com", "{remote}");
            assert_eq!(repo.path, "soccer99/berdloop", "{remote}");
            assert_eq!(repo.owner(), "soccer99");
        }
        // GitLab nests groups, so the whole path is the project.
        let nested = Repo::from_remote("git@gitlab.com:team/sub/repo.git").unwrap();
        assert_eq!(nested.host, Host::GitLab);
        assert_eq!(nested.path, "team/sub/repo");
        assert_eq!(nested.encoded(), "team%2Fsub%2Frepo");
    }

    #[test]
    fn an_unknown_host_is_refused_by_name_not_guessed_at() {
        let refused = Repo::from_remote("git@git.example.com:team/repo.git").unwrap_err();
        assert!(refused.contains("git.example.com"), "{refused}");
    }

    #[test]
    fn a_pull_request_is_addressable_from_the_address_alone() {
        assert_eq!(
            Pull::from_url("https://github.com/soccer99/berdloop/pull/3").unwrap(),
            Pull {
                url: "https://github.com/soccer99/berdloop/pull/3".into(),
                number: 3
            }
        );
        assert_eq!(
            Pull::from_url("https://gitlab.com/team/repo/-/merge_requests/12")
                .unwrap()
                .number,
            12
        );
        assert!(Pull::from_url("https://example.test/nothing").is_err());
    }

    #[test]
    fn a_gitlab_job_that_gates_nothing_does_not_hold_the_merge_request() {
        assert_eq!(gitlab_verdict(&json!({"status":"success"})), "SUCCESS");
        assert_eq!(gitlab_verdict(&json!({"status":"failed"})), "FAILURE");
        assert_eq!(gitlab_verdict(&json!({"status":"running"})), "IN_PROGRESS");
        // Waiting for a person who may never come is not a failing build.
        assert_eq!(gitlab_verdict(&json!({"status":"manual"})), "SKIPPED");
        assert_eq!(
            gitlab_verdict(&json!({"status":"failed","allow_failure":true})),
            "NEUTRAL"
        );
    }
}
