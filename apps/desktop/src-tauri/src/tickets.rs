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
const DEFAULT_LIMIT: u32 = 20;
const MAX_LIMIT: u32 = 50;
/// An empty search is the picker opening. It needs a list long enough to be
/// worth looking at, whatever limit the window asked for.
const RECENT_LIMIT: u32 = 10;
const JIRA_SITE: &str = "Enter a Jira Cloud site URL and account email.";

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
}

/// The one refusal the window has to be able to tell apart, so it can offer
/// to open settings instead of showing a failure.
fn not_connected(provider: &str) -> String {
    format!("Connect {provider} in settings first.")
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
        .map_err(|_| "Enter the full HTTPS Jira Cloud site URL.".to_string())?;
    let host = url.host_str().unwrap_or("").to_string();
    if url.scheme() != "https"
        || !host.ends_with(".atlassian.net")
        || url.port().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || !url.username().is_empty()
        || email.is_empty()
    {
        return Err(JIRA_SITE.to_string());
    }
    Ok(host)
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
    let connection = connection(&app, &organization_id, &project_id, &provider)?;
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
            let auth = base64::engine::general_purpose::STANDARD
                .encode(format!("{}:{token}", connection.jira_email));
            jira_site_host = host.clone();
            client
                .get(format!("https://{host}/rest/api/3/issue/{reference}"))
                .header("Authorization", format!("Basic {auth}"))
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
        // STUB: Jira and Asana search land in a follow-up task. Reading one
        // issue by reference already works for both.
        "Jira" | "Asana" => Err("Search is not available for this provider yet.".to_string()),
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
        assert_eq!(not_connected("Linear"), "Connect Linear in settings first.");
        assert_eq!(not_connected("Jira"), "Connect Jira in settings first.");
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
