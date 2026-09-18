//! Reading and searching the ticket providers.
//!
//! The window names a provider and a scope; it never sends a token. The host
//! resolves the connection a person saved in settings, project first and the
//! organization as the fallback, and makes the request itself. Nothing here
//! puts a token in an error, so every message can be shown to a person.

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

use crate::agent_preferences;
use crate::integration_secrets;

const PROVIDERS: [&str; 3] = ["Linear", "Jira", "Asana"];
const LINEAR_API: &str = "https://api.linear.app/graphql";
const ASANA_API: &str = "https://app.asana.com/api/1.0";
const DEFAULT_LIMIT: u32 = 20;
const MAX_LIMIT: u32 = 50;
/// An empty search is the picker opening. It needs a list long enough to be
/// worth looking at, whatever limit the window asked for.
const RECENT_LIMIT: u32 = 10;
const JIRA_SITE: &str = "Enter a Jira Cloud site URL and account email.";
const ASANA_WORKSPACE: &str = "Add your Asana workspace GID in settings.";
const ASANA_FIELDS: &str = "gid,name,notes,permalink_url,completed,modified_at";
/// Asana's task list takes no ordering parameter: it answers in an order of
/// its own and truncates to the limit asked for, so asking it for twenty
/// would hand back an arbitrary twenty of a person's assigned tasks. A whole
/// page is read instead and ordered here before anything is dropped. 100 is
/// the most Asana returns in one page, and is above MAX_LIMIT.
const ASANA_PAGE: u32 = 100;

/// One issue as Berdloop shows it, whether it came from a search or from
/// reading a single reference.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalIssue {
    pub provider: String,
    pub id: String,
    pub key: String,
    pub url: String,
    pub title: String,
    pub description: String,
    pub status: String,
    /// When the provider last changed the issue. Empty when it does not say.
    pub updated_at: String,
}

/// What the host needs to reach one provider here. It stays in this module.
struct Connection {
    token: String,
    jira_site: String,
    jira_email: String,
    asana_workspace: String,
}

/// The mark on every refusal a person fixes in settings rather than by
/// trying again. The window matches the mark, not the sentence, so a new
/// refusal of this kind is offered the same way out without the window
/// having to learn its wording.
const SETTINGS_PREFIX: &str = "Settings: ";

/// Mark a refusal as one settings can fix. The sentence is still readable on
/// its own, so anywhere that does not know the mark loses nothing.
fn settings_fix(message: &str) -> String {
    format!("{SETTINGS_PREFIX}{message}")
}

/// The commonest of those refusals: nobody has saved a connection yet.
fn not_connected(provider: &str) -> String {
    settings_fix(&format!("Connect {provider} in settings first."))
}

fn connection(
    app: &tauri::AppHandle,
    organization_id: &str,
    project_id: &str,
    provider: &str,
) -> Result<Connection, String> {
    let token = integration_secrets::resolve(app, organization_id, project_id, provider)
        .unwrap_or_default()
        .trim()
        .to_string();
    if token.is_empty() {
        return Err(not_connected(provider));
    }
    let settings = agent_preferences::read(app)?
        .resolve_integration(organization_id, project_id, provider)
        .unwrap_or_default();
    let connection = Connection {
        token,
        jira_site: settings.jira_site.unwrap_or_default().trim().to_string(),
        jira_email: settings.jira_email.unwrap_or_default().trim().to_string(),
        asana_workspace: settings
            .asana_workspace
            .unwrap_or_default()
            .trim()
            .to_string(),
    };
    // Jira cannot be reached by token alone, so a half-filled connection is
    // an unconnected one.
    if provider == "Jira" && (connection.jira_site.is_empty() || connection.jira_email.is_empty()) {
        return Err(not_connected(provider));
    }
    Ok(connection)
}

/// Jira is the one provider whose address a person types, so the host checks
/// it: HTTPS, an Atlassian Cloud site, and nothing smuggled into the URL.
fn jira_host(site: &str, email: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(site)
        .map_err(|_| settings_fix("Enter the full HTTPS Jira Cloud site URL."))?;
    let host = url.host_str().unwrap_or("").to_string();
    if url.scheme() != "https"
        || !host.ends_with(".atlassian.net")
        || url.port().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || !url.username().is_empty()
        || email.is_empty()
    {
        return Err(settings_fix(JIRA_SITE));
    }
    Ok(host)
}

/// Jira Cloud takes an API token as the password of a basic-auth pair.
fn jira_auth(email: &str, token: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{email}:{token}"));
    format!("Basic {encoded}")
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "Could not start the provider request.".to_string())
}

fn supported(provider: &str) -> Result<(), String> {
    if PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err("Unsupported task provider.".to_string())
    }
}

fn plain_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(plain_text).collect::<Vec<_>>().join("\n"),
        Value::Object(map) => {
            let own = map.get("text").and_then(Value::as_str).unwrap_or("");
            let nested = map.get("content").map(plain_text).unwrap_or_default();
            if own.is_empty() {
                nested
            } else {
                own.to_string()
            }
        }
        _ => String::new(),
    }
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("Provider response is missing {key}."))
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn http_error(status: reqwest::StatusCode) -> String {
    format!("Provider returned HTTP {}.", status.as_u16())
}

#[tauri::command]
pub async fn fetch_external_issue(
    app: tauri::AppHandle,
    provider: String,
    reference: String,
    organization_id: String,
    project_id: String,
) -> Result<ExternalIssue, String> {
    fetch(&app, provider, reference, &organization_id, &project_id).await
}

/// Read one issue. The window comes here through `fetch_external_issue`; the
/// ticket agent comes here through the control channel, so both go to the
/// provider the same way and with the same resolved connection.
pub async fn fetch(
    app: &tauri::AppHandle,
    provider: String,
    reference: String,
    organization_id: &str,
    project_id: &str,
) -> Result<ExternalIssue, String> {
    let reference = reference.trim().to_string();
    if reference.is_empty()
        || reference.len() > 128
        || !reference
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("Enter a valid ticket ID.".to_string());
    }
    supported(&provider)?;
    let connection = connection(app, organization_id, project_id, &provider)?;
    let token = connection.token.as_str();
    let client = client()?;
    let mut jira_site_host = String::new();
    let response = match provider.as_str() {
        "Linear" => {
            client
                .post(LINEAR_API)
                .header("Authorization", token)
                .json(&json!({
                    "query": "query Issue($id: String!) { issue(id: $id) { id identifier title description url updatedAt state { name } } }",
                    "variables": { "id": reference }
                }))
                .send()
                .await
        }
        "Asana" => {
            if !reference.chars().all(|c| c.is_ascii_digit()) {
                return Err("Enter the numeric Asana task GID.".to_string());
            }
            client
                .get(format!("https://app.asana.com/api/1.0/tasks/{reference}"))
                .bearer_auth(token)
                .query(&[(
                    "opt_fields",
                    "gid,name,notes,permalink_url,completed,modified_at",
                )])
                .send()
                .await
        }
        "Jira" => {
            let host = jira_host(&connection.jira_site, &connection.jira_email)?;
            let auth = jira_auth(&connection.jira_email, token);
            jira_site_host = host.clone();
            client
                .get(format!("https://{host}/rest/api/3/issue/{reference}"))
                .header("Authorization", auth)
                .query(&[("fields", "summary,description,status,updated")])
                .send()
                .await
        }
        _ => unreachable!(),
    }
    .map_err(|_| "Could not reach the task provider.".to_string())?;
    if !response.status().is_success() {
        return Err(http_error(response.status()));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| "Provider returned invalid JSON.".to_string())?;
    match provider.as_str() {
        "Linear" => {
            if body["errors"]
                .as_array()
                .is_some_and(|errors| !errors.is_empty())
            {
                return Err("Linear could not load this issue.".to_string());
            }
            let issue = &body["data"]["issue"];
            Ok(ExternalIssue {
                provider,
                id: required_string(issue, "id")?.to_string(),
                key: required_string(issue, "identifier")?.to_string(),
                url: required_string(issue, "url")?.to_string(),
                title: required_string(issue, "title")?.to_string(),
                description: issue["description"].as_str().unwrap_or("").to_string(),
                status: issue["state"]["name"].as_str().unwrap_or("").to_string(),
                updated_at: issue["updatedAt"].as_str().unwrap_or("").to_string(),
            })
        }
        "Asana" => {
            let issue = &body["data"];
            Ok(ExternalIssue {
                provider,
                id: required_string(issue, "gid")?.to_string(),
                key: required_string(issue, "gid")?.to_string(),
                url: required_string(issue, "permalink_url")?.to_string(),
                title: required_string(issue, "name")?.to_string(),
                description: issue["notes"].as_str().unwrap_or("").to_string(),
                status: if issue["completed"].as_bool().unwrap_or(false) {
                    "Complete"
                } else {
                    "Open"
                }
                .to_string(),
                updated_at: issue["modified_at"].as_str().unwrap_or("").to_string(),
            })
        }
        "Jira" => {
            let key = required_string(&body, "key")?;
            Ok(ExternalIssue {
                id: required_string(&body, "id")?.to_string(),
                url: format!("https://{jira_site_host}/browse/{key}"),
                key: key.to_string(),
                title: required_string(&body["fields"], "summary")?.to_string(),
                description: plain_text(&body["fields"]["description"]),
                status: body["fields"]["status"]["name"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
                updated_at: body["fields"]["updated"].as_str().unwrap_or("").to_string(),
                provider,
            })
        }
        _ => unreachable!(),
    }
}

const LINEAR_FIELDS: &str = "id identifier title description url updatedAt state { name }";

fn linear_recent_query() -> String {
    format!("query Recent($first: Int!) {{ issues(first: $first, orderBy: createdAt) {{ nodes {{ {LINEAR_FIELDS} }} }} }}")
}

fn linear_search_query() -> String {
    format!("query Search($first: Int!, $term: String!) {{ searchIssues(term: $term, first: $first) {{ nodes {{ {LINEAR_FIELDS} }} }} }}")
}

fn linear_issue(node: &Value) -> Option<ExternalIssue> {
    Some(ExternalIssue {
        provider: "Linear".to_string(),
        id: optional_string(node, "id")?,
        key: optional_string(node, "identifier")?,
        url: optional_string(node, "url")?,
        title: optional_string(node, "title")?,
        description: node["description"].as_str().unwrap_or("").to_string(),
        status: node["state"]["name"].as_str().unwrap_or("").to_string(),
        updated_at: node["updatedAt"].as_str().unwrap_or("").to_string(),
    })
}

/// Linear answers a search under `searchIssues` and a recent list under
/// `issues`, with the same fields in both. An issue the provider left
/// incomplete is skipped rather than failing the list: one odd record should
/// not empty the picker.
fn parse_linear_search(body: &Value) -> Result<Vec<ExternalIssue>, String> {
    if body["errors"]
        .as_array()
        .is_some_and(|errors| !errors.is_empty())
    {
        return Err("Linear could not run this search.".to_string());
    }
    let nodes = ["searchIssues", "issues"]
        .iter()
        .find_map(|key| body["data"][key]["nodes"].as_array())
        .ok_or("Provider response is missing nodes.")?;
    Ok(nodes.iter().filter_map(linear_issue).collect())
}

async fn search_linear(token: &str, query: &str, first: u32) -> Result<Vec<ExternalIssue>, String> {
    let request = if query.is_empty() {
        json!({ "query": linear_recent_query(), "variables": { "first": first } })
    } else {
        json!({ "query": linear_search_query(), "variables": { "first": first, "term": query } })
    };
    let response = client()?
        .post(LINEAR_API)
        .header("Authorization", token)
        .json(&request)
        .send()
        .await
        .map_err(|_| "Could not reach the task provider.".to_string())?;
    if !response.status().is_success() {
        return Err(http_error(response.status()));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| "Provider returned invalid JSON.".to_string())?;
    parse_linear_search(&body)
}

const JIRA_FIELDS: &str = "summary,description,status,updated";

/// JQL carries the search term inside a quoted string, so a quote or a
/// backslash in what a person typed could end that string and let them write
/// the rest of the query. Both are escaped the way JQL asks, the backslash
/// first so an escape is never escaped twice.
fn jira_escape(query: &str) -> String {
    query.replace('\\', "\\\\").replace('"', "\\\"")
}

/// `key = "..."` is an error in JQL unless the term really is an issue key,
/// so the exact-key half of the search is only asked for when it could match.
fn looks_like_issue_key(query: &str) -> bool {
    match query.split_once('-') {
        Some((project, number)) => {
            project.chars().any(|c| c.is_ascii_alphabetic())
                && project
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !number.is_empty()
                && number.chars().all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

/// `/rest/api/3/search/jql` refuses a query with no restriction in it
/// ("Unbounded JQL queries are not allowed here"), so the recent list, which
/// has no term to search for, is bounded by a clause every issue satisfies
/// rather than by a date or a project, which would hide issues.
fn jira_jql(query: &str) -> String {
    if query.is_empty() {
        return "project is not EMPTY order by created DESC".to_string();
    }
    let term = jira_escape(query);
    if looks_like_issue_key(query) {
        format!("(key = \"{term}\" OR text ~ \"{term}\") order by created DESC")
    } else {
        format!("text ~ \"{term}\" order by created DESC")
    }
}

fn jira_issue(issue: &Value, host: &str) -> Option<ExternalIssue> {
    let key = optional_string(issue, "key")?;
    let fields = &issue["fields"];
    Some(ExternalIssue {
        provider: "Jira".to_string(),
        id: optional_string(issue, "id")?,
        url: format!("https://{host}/browse/{key}"),
        key,
        title: optional_string(fields, "summary")?,
        description: plain_text(&fields["description"]),
        status: fields["status"]["name"].as_str().unwrap_or("").to_string(),
        updated_at: fields["updated"].as_str().unwrap_or("").to_string(),
    })
}

/// Jira answers a search and a recent list the same way, under `issues`. An
/// issue the provider left incomplete is skipped rather than failing the
/// list, as with Linear.
fn parse_jira_search(body: &Value, host: &str) -> Result<Vec<ExternalIssue>, String> {
    if body["errorMessages"]
        .as_array()
        .is_some_and(|messages| !messages.is_empty())
    {
        return Err("Jira could not run this search.".to_string());
    }
    let issues = body["issues"]
        .as_array()
        .ok_or("Provider response is missing issues.")?;
    Ok(issues
        .iter()
        .filter_map(|issue| jira_issue(issue, host))
        .collect())
}

async fn search_jira(
    connection: &Connection,
    query: &str,
    first: u32,
) -> Result<Vec<ExternalIssue>, String> {
    let host = jira_host(&connection.jira_site, &connection.jira_email)?;
    let max_results = first.to_string();
    let response = client()?
        .get(format!("https://{host}/rest/api/3/search/jql"))
        .header(
            "Authorization",
            jira_auth(&connection.jira_email, &connection.token),
        )
        .query(&[
            ("jql", jira_jql(query).as_str()),
            ("maxResults", max_results.as_str()),
            ("fields", JIRA_FIELDS),
        ])
        .send()
        .await
        .map_err(|_| "Could not reach the task provider.".to_string())?;
    if !response.status().is_success() {
        return Err(http_error(response.status()));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| "Provider returned invalid JSON.".to_string())?;
    parse_jira_search(&body, &host)
}

fn asana_task(task: &Value) -> Option<ExternalIssue> {
    let gid = optional_string(task, "gid")?;
    Some(ExternalIssue {
        provider: "Asana".to_string(),
        id: gid.clone(),
        key: gid,
        url: optional_string(task, "permalink_url")?,
        title: optional_string(task, "name")?,
        description: task["notes"].as_str().unwrap_or("").to_string(),
        status: if task["completed"].as_bool().unwrap_or(false) {
            "Complete"
        } else {
            "Open"
        }
        .to_string(),
        updated_at: task["modified_at"].as_str().unwrap_or("").to_string(),
    })
}

/// Asana answers both the task list and the search under `data`, in an order
/// of its own, so newest first is settled here on the time it reports.
fn parse_asana_search(body: &Value) -> Result<Vec<ExternalIssue>, String> {
    if body["errors"]
        .as_array()
        .is_some_and(|errors| !errors.is_empty())
    {
        return Err("Asana could not run this search.".to_string());
    }
    let data = body["data"]
        .as_array()
        .ok_or("Provider response is missing data.")?;
    let mut tasks: Vec<ExternalIssue> = data.iter().filter_map(asana_task).collect();
    tasks.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(tasks)
}

/// Searching Asana needs a paid plan. Rather than show a person a failure
/// they cannot act on, the page of assigned tasks is filtered here, on the
/// two things they would type: the task name and its GID. It filters the
/// whole page rather than the newest few, so the fallback can still find an
/// older task by name.
fn asana_filter(tasks: Vec<ExternalIssue>, query: &str, first: u32) -> Vec<ExternalIssue> {
    let needle = query.to_lowercase();
    tasks
        .into_iter()
        .filter(|task| {
            task.title.to_lowercase().contains(&needle) || task.key.to_lowercase().contains(&needle)
        })
        .take(first as usize)
        .collect()
}

async fn asana_json(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request
        .send()
        .await
        .map_err(|_| "Could not reach the task provider.".to_string())?;
    if !response.status().is_success() {
        return Err(http_error(response.status()));
    }
    response
        .json()
        .await
        .map_err(|_| "Provider returned invalid JSON.".to_string())
}

/// Asana only lists tasks for a workspace together with an assignee, so the
/// recent list is the signed-in person's own tasks in that workspace. A full
/// page comes back, newest first; how much of it to show is the caller's
/// choice, and the search fallback wants all of it to filter over.
async fn asana_assigned(
    connection: &Connection,
    workspace: &str,
) -> Result<Vec<ExternalIssue>, String> {
    let limit = ASANA_PAGE.to_string();
    let body = asana_json(
        client()?
            .get(format!("{ASANA_API}/tasks"))
            .bearer_auth(&connection.token)
            .query(&[
                ("workspace", workspace),
                ("assignee", "me"),
                ("opt_fields", ASANA_FIELDS),
                ("limit", limit.as_str()),
            ]),
    )
    .await?;
    parse_asana_search(&body)
}

/// The newest `first` of an already-ordered list. Truncating is the last
/// thing done, never the first, so the list is the newest tasks and not
/// whichever ones Asana happened to send.
fn asana_newest(tasks: Vec<ExternalIssue>, first: u32) -> Vec<ExternalIssue> {
    tasks.into_iter().take(first as usize).collect()
}

async fn search_asana(
    connection: &Connection,
    query: &str,
    first: u32,
) -> Result<Vec<ExternalIssue>, String> {
    let workspace = connection.asana_workspace.as_str();
    if workspace.is_empty() || !workspace.chars().all(|c| c.is_ascii_digit()) {
        return Err(settings_fix(ASANA_WORKSPACE));
    }
    if query.is_empty() {
        return Ok(asana_newest(
            asana_assigned(connection, workspace).await?,
            first,
        ));
    }
    let limit = first.to_string();
    let searched = asana_json(
        client()?
            .get(format!("{ASANA_API}/workspaces/{workspace}/tasks/search"))
            .bearer_auth(&connection.token)
            .query(&[
                ("text", query),
                ("opt_fields", ASANA_FIELDS),
                ("sort_by", "modified_at"),
                ("limit", limit.as_str()),
            ]),
    )
    .await
    .and_then(|body| parse_asana_search(&body));
    match searched {
        Ok(tasks) => Ok(tasks),
        // The search endpoint answers 402 or 403 on a plan without it. That
        // is a limit of the plan, not a failure of the search, so the recent
        // list is filtered here instead and nothing is reported.
        Err(_) => Ok(asana_filter(
            asana_assigned(connection, workspace).await?,
            query,
            first,
        )),
    }
}

#[tauri::command]
pub async fn search_external_issues(
    app: tauri::AppHandle,
    provider: String,
    organization_id: String,
    project_id: String,
    query: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<ExternalIssue>, String> {
    supported(&provider)?;
    let query = query.unwrap_or_default().trim().to_string();
    if query.len() > 256 {
        return Err("Search for something shorter.".to_string());
    }
    let first = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let first = if query.is_empty() {
        first.max(RECENT_LIMIT)
    } else {
        first
    };
    let connection = connection(&app, &organization_id, &project_id, &provider)?;
    match provider.as_str() {
        "Linear" => search_linear(&connection.token, &query, first).await,
        "Jira" => search_jira(&connection, &query, first).await,
        "Asana" => search_asana(&connection, &query, first).await,
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jira_description_becomes_plain_text() {
        let description = json!({
            "type": "doc",
            "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "First" }] },
                { "type": "paragraph", "content": [{ "type": "text", "text": "Second" }] }
            ]
        });
        assert_eq!(plain_text(&description), "First\nSecond");
    }

    fn search_response() -> Value {
        json!({
            "data": {
                "searchIssues": {
                    "nodes": [
                        {
                            "id": "1f0c",
                            "identifier": "BRD-128",
                            "title": "Searchable ticket import",
                            "description": "Hand the picked ticket to the agent.",
                            "url": "https://linear.app/berdloop/issue/BRD-128",
                            "updatedAt": "2026-09-17T10:04:00.000Z",
                            "state": { "name": "In Progress" }
                        },
                        {
                            "id": "22a1",
                            "identifier": "BRD-129",
                            "title": "Second issue",
                            "url": "https://linear.app/berdloop/issue/BRD-129",
                            "state": { "name": "Todo" }
                        }
                    ]
                }
            }
        })
    }

    #[test]
    fn a_linear_search_response_becomes_issues() {
        let issues = parse_linear_search(&search_response()).unwrap();
        assert_eq!(issues.len(), 2);
        assert_eq!(
            issues[0],
            ExternalIssue {
                provider: "Linear".to_string(),
                id: "1f0c".to_string(),
                key: "BRD-128".to_string(),
                url: "https://linear.app/berdloop/issue/BRD-128".to_string(),
                title: "Searchable ticket import".to_string(),
                description: "Hand the picked ticket to the agent.".to_string(),
                status: "In Progress".to_string(),
                updated_at: "2026-09-17T10:04:00.000Z".to_string(),
            }
        );
        // A provider that says nothing about when it changed leaves the field
        // empty rather than dropping the issue.
        assert_eq!(issues[1].key, "BRD-129");
        assert_eq!(issues[1].updated_at, "");
        assert_eq!(issues[1].status, "Todo");
    }

    #[test]
    fn the_recent_list_parses_the_same_way() {
        let recent = json!({
            "data": { "issues": { "nodes": [{
                "id": "1f0c",
                "identifier": "BRD-128",
                "title": "Searchable ticket import",
                "url": "https://linear.app/berdloop/issue/BRD-128",
                "updatedAt": "2026-09-17T10:04:00.000Z",
                "state": { "name": "In Progress" }
            }] } }
        });
        let issues = parse_linear_search(&recent).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].title, "Searchable ticket import");
    }

    #[test]
    fn an_incomplete_issue_is_skipped_and_an_error_is_not() {
        let partial = json!({ "data": { "issues": { "nodes": [
            { "id": "1f0c", "title": "No identifier, no URL" },
            { "id": "22a1", "identifier": "BRD-129", "title": "Kept", "url": "https://linear.app/i" }
        ] } } });
        let issues = parse_linear_search(&partial).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].key, "BRD-129");
        let failed = json!({ "errors": [{ "message": "Authentication required" }] });
        assert!(parse_linear_search(&failed).is_err());
        assert!(parse_linear_search(&json!({ "data": {} })).is_err());
    }

    #[test]
    fn a_jira_search_response_becomes_issues() {
        let body = json!({
            "issues": [
                {
                    "id": "10042",
                    "key": "BRD-128",
                    "fields": {
                        "summary": "Searchable ticket import",
                        "description": {
                            "type": "doc",
                            "content": [{ "type": "paragraph", "content": [
                                { "type": "text", "text": "Hand the picked ticket to the agent." }
                            ] }]
                        },
                        "status": { "name": "In Progress" },
                        "updated": "2026-09-17T10:04:00.000+0000"
                    }
                },
                {
                    "id": "10043",
                    "key": "BRD-129",
                    "fields": { "summary": "Second issue" }
                },
                { "id": "10044", "fields": { "summary": "No key, so skipped" } }
            ]
        });
        let issues = parse_jira_search(&body, "team.atlassian.net").unwrap();
        assert_eq!(issues.len(), 2);
        assert_eq!(
            issues[0],
            ExternalIssue {
                provider: "Jira".to_string(),
                id: "10042".to_string(),
                key: "BRD-128".to_string(),
                url: "https://team.atlassian.net/browse/BRD-128".to_string(),
                title: "Searchable ticket import".to_string(),
                description: "Hand the picked ticket to the agent.".to_string(),
                status: "In Progress".to_string(),
                updated_at: "2026-09-17T10:04:00.000+0000".to_string(),
            }
        );
        assert_eq!(issues[1].url, "https://team.atlassian.net/browse/BRD-129");
        assert_eq!(issues[1].status, "");
        assert_eq!(issues[1].updated_at, "");
        assert!(parse_jira_search(
            &json!({ "errorMessages": ["Bad JQL"] }),
            "team.atlassian.net"
        )
        .is_err());
        assert!(parse_jira_search(&json!({}), "team.atlassian.net").is_err());
    }

    #[test]
    fn a_search_term_cannot_break_out_of_the_jql_string() {
        // The recent list still has to be a bounded query, which Jira
        // enhanced search insists on.
        assert_eq!(jira_jql(""), "project is not EMPTY order by created DESC");
        assert_eq!(
            jira_jql("import"),
            "text ~ \"import\" order by created DESC"
        );
        assert_eq!(
            jira_jql("BRD-128"),
            "(key = \"BRD-128\" OR text ~ \"BRD-128\") order by created DESC"
        );
        // A quote is escaped, not passed on, so the term stays one string.
        assert_eq!(
            jira_jql("a\" OR key = \"BRD-1"),
            "text ~ \"a\\\" OR key = \\\"BRD-1\" order by created DESC"
        );
        assert_eq!(
            jira_jql("back\\slash"),
            "text ~ \"back\\\\slash\" order by created DESC"
        );
        // Anything that is not an issue key never asks Jira for a key match,
        // which Jira would refuse as an invalid key.
        assert!(!looks_like_issue_key("plain words"));
        assert!(!looks_like_issue_key("BRD-"));
        assert!(!looks_like_issue_key("12-34"));
        assert!(looks_like_issue_key("BRD-128"));
    }

    fn asana_response() -> Value {
        json!({ "data": [
            {
                "gid": "1209",
                "name": "Second task",
                "notes": "",
                "permalink_url": "https://app.asana.com/0/1/1209",
                "completed": true,
                "modified_at": "2026-09-16T08:00:00.000Z"
            },
            {
                "gid": "1208",
                "name": "Searchable ticket import",
                "notes": "Hand the picked ticket to the agent.",
                "permalink_url": "https://app.asana.com/0/1/1208",
                "completed": false,
                "modified_at": "2026-09-17T10:04:00.000Z"
            },
            { "gid": "1210", "name": "No permalink, so skipped" }
        ] })
    }

    #[test]
    fn an_asana_response_becomes_issues_newest_first() {
        let issues = parse_asana_search(&asana_response()).unwrap();
        assert_eq!(issues.len(), 2);
        assert_eq!(
            issues[0],
            ExternalIssue {
                provider: "Asana".to_string(),
                id: "1208".to_string(),
                key: "1208".to_string(),
                url: "https://app.asana.com/0/1/1208".to_string(),
                title: "Searchable ticket import".to_string(),
                description: "Hand the picked ticket to the agent.".to_string(),
                status: "Open".to_string(),
                updated_at: "2026-09-17T10:04:00.000Z".to_string(),
            }
        );
        assert_eq!(issues[1].key, "1209");
        assert_eq!(issues[1].status, "Complete");
        assert!(
            parse_asana_search(&json!({ "errors": [{ "message": "Not Authorized" }] })).is_err()
        );
        assert!(parse_asana_search(&json!({})).is_err());
    }

    #[test]
    fn the_asana_fallback_filters_the_recent_list_without_regard_to_case() {
        let recent = parse_asana_search(&asana_response()).unwrap();
        let matched = asana_filter(recent.clone(), "SEARCHABLE", 20);
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].key, "1208");
        // A GID matches too, and everything else is dropped.
        assert_eq!(asana_filter(recent.clone(), "1209", 20).len(), 1);
        assert!(asana_filter(recent.clone(), "nothing here", 20).is_empty());
        // The limit the window asked for still holds.
        assert_eq!(asana_filter(recent, "task", 1).len(), 1);
    }

    /// Asana returns assigned tasks oldest first, which is what makes
    /// truncating before sorting wrong.
    fn asana_page(count: u32) -> Value {
        let data: Vec<Value> = (0..count)
            .map(|index| {
                json!({
                    "gid": format!("{}", 1000 + index),
                    "name": format!("Task {index}"),
                    "notes": "",
                    "permalink_url": format!("https://app.asana.com/0/1/{}", 1000 + index),
                    "completed": false,
                    "modified_at": format!("2026-09-{:02}T10:04:00.000Z", index + 1)
                })
            })
            .collect();
        json!({ "data": data })
    }

    #[test]
    fn a_page_longer_than_the_limit_answers_with_the_newest_tasks() {
        // A whole page is read, so a person with more assigned tasks than the
        // picker shows still opens on their newest ones, not their oldest.
        const { assert!(MAX_LIMIT < ASANA_PAGE) };
        let page = parse_asana_search(&asana_page(25)).unwrap();
        assert_eq!(page.len(), 25);
        let newest = asana_newest(page.clone(), 20);
        assert_eq!(newest.len(), 20);
        assert_eq!(newest[0].key, "1024");
        assert_eq!(newest[19].key, "1005");
        for pair in newest.windows(2) {
            assert!(pair[0].updated_at > pair[1].updated_at);
        }
        // The five oldest are the ones dropped, which is the bug reversed.
        assert!(!newest.iter().any(|task| task.key == "1004"));
        // The fallback searches the whole page, so an older task is still
        // findable by name once the newest ones are not what was asked for.
        let matched = asana_filter(page, "Task 3", 20);
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].key, "1003");
    }

    #[test]
    fn a_missing_asana_workspace_says_what_to_fill_in() {
        assert_eq!(ASANA_WORKSPACE, "Add your Asana workspace GID in settings.");
    }

    #[test]
    fn an_issue_serializes_the_way_the_window_reads_it() {
        let json = serde_json::to_string(&ExternalIssue {
            updated_at: "2026-09-17T10:04:00.000Z".to_string(),
            ..ExternalIssue::default()
        })
        .unwrap();
        assert!(json.contains("\"updatedAt\":\"2026-09-17T10:04:00.000Z\""));
    }

    #[test]
    fn an_unconnected_provider_is_told_apart_from_any_other_failure() {
        assert_eq!(
            not_connected("Linear"),
            "Settings: Connect Linear in settings first."
        );
        assert_eq!(
            not_connected("Jira"),
            "Settings: Connect Jira in settings first."
        );
    }

    #[test]
    fn every_refusal_settings_can_fix_carries_the_same_mark() {
        // Each of these is a person filling something in, not a failure to
        // retry, so each is marked and the window offers settings for all of
        // them rather than for the connection one alone.
        for marked in [
            not_connected("Asana"),
            settings_fix(JIRA_SITE),
            settings_fix(ASANA_WORKSPACE),
        ] {
            assert!(marked.starts_with(SETTINGS_PREFIX), "{marked}");
        }
        // The sentence survives the mark, so anywhere that does not strip it
        // still reads.
        assert!(settings_fix(ASANA_WORKSPACE).ends_with(ASANA_WORKSPACE));
    }

    #[test]
    fn a_jira_site_a_person_typed_is_sent_back_to_settings() {
        for refused in [
            jira_host("http://team.atlassian.net", "person@example.com"),
            jira_host("not a url", "person@example.com"),
            jira_host("https://team.atlassian.net", ""),
        ] {
            assert!(refused.unwrap_err().starts_with(SETTINGS_PREFIX));
        }
    }

    #[test]
    fn only_an_atlassian_cloud_site_over_https_is_accepted() {
        assert_eq!(
            jira_host("https://team.atlassian.net", "person@example.com").unwrap(),
            "team.atlassian.net"
        );
        for refused in [
            jira_host("http://team.atlassian.net", "person@example.com"),
            jira_host("https://team.example.com", "person@example.com"),
            jira_host("https://team.atlassian.net:8443", "person@example.com"),
            jira_host("https://team.atlassian.net/wiki", "person@example.com"),
            jira_host("https://team.atlassian.net?next=x", "person@example.com"),
            jira_host("https://someone@team.atlassian.net", "person@example.com"),
            jira_host("https://team.atlassian.net", ""),
            jira_host("not a url", "person@example.com"),
        ] {
            assert!(refused.is_err());
        }
    }
}
