//! Read the session transcripts that Claude Code and Codex write for themselves.
//!
//! Both CLIs record every conversation as JSON Lines on disk. We only read them.
//! Writing one by hand is not supported by either CLI, so we never try.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Lines of a transcript we read before giving up on finding the header fields.
const HEAD_LINES: usize = 80;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub harness: &'static str,
    /// Working directory the session ran in. This is how a session is matched
    /// to a Berdloop task, because the directory-name encoding is lossy.
    pub cwd: String,
    pub title: String,
    pub modified_ms: u64,
    pub path: String,
}

fn home() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "HOME is not set".to_string())
}

fn modified_ms(path: &Path) -> u64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Collect every `*.jsonl` under `root`, descending at most `depth` directories.
fn collect_jsonl(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = root.read_dir() else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth > 0 {
                collect_jsonl(&path, depth - 1, out);
            }
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            out.push(path);
        }
    }
}

fn head_lines(path: &Path) -> Vec<serde_json::Value> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    BufReader::new(file)
        .lines()
        .take(HEAD_LINES)
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str(&line).ok())
        .collect()
}

/// Pull readable text out of a message `content` field, which is either a bare
/// string or an array of typed blocks.
fn content_text(content: &serde_json::Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    content.as_array()?.iter().find_map(|block| {
        block
            .get("text")
            .and_then(|t| t.as_str())
            .map(str::to_string)
    })
}

/// Codex prepends synthetic turns such as `<environment_context>` and
/// `<recommended_plugins>` to a thread. They are not what the user typed.
fn is_injected(text: &str) -> bool {
    text.trim_start().starts_with('<')
}

fn trim_title(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 90 {
        format!("{}…", flat.chars().take(90).collect::<String>())
    } else {
        flat
    }
}

fn read_claude(path: &Path) -> Option<SessionSummary> {
    let mut id = None;
    let mut cwd = None;
    let mut title = None;

    for record in head_lines(path) {
        if id.is_none() {
            id = record
                .get("sessionId")
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }
        if cwd.is_none() {
            cwd = record
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }
        // An AI-written title is better than the raw first prompt, so it wins.
        if let Some(ai) = record.get("aiTitle").and_then(|v| v.as_str()) {
            title = Some(ai.to_string());
        }
        if title.is_none()
            && record.get("type").and_then(|v| v.as_str()) == Some("user")
            && record.get("isMeta").and_then(|v| v.as_bool()) != Some(true)
        {
            title = record
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(content_text)
                .map(|t| trim_title(&t));
        }
    }

    // The file name is the session id, so a missing sessionId field is survivable.
    let id = id.or_else(|| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
    })?;

    Some(SessionSummary {
        id,
        harness: "Claude Code",
        cwd: cwd.unwrap_or_default(),
        title: title.unwrap_or_else(|| "Untitled session".to_string()),
        modified_ms: modified_ms(path),
        path: path.to_string_lossy().into_owned(),
    })
}

fn read_codex(path: &Path, names: &HashMap<String, String>) -> Option<SessionSummary> {
    let mut id = None;
    let mut cwd = None;
    let mut title = None;

    for record in head_lines(path) {
        let payload = record.get("payload");
        match record.get("type").and_then(|v| v.as_str()) {
            Some("session_meta") => {
                let payload = payload?;
                id = payload
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                cwd = payload
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
            }
            Some("response_item") if title.is_none() => {
                let payload = payload?;
                if payload.get("role").and_then(|v| v.as_str()) == Some("user") {
                    title = payload
                        .get("content")
                        .and_then(content_text)
                        .filter(|t| !is_injected(t))
                        .map(|t| trim_title(&t));
                }
            }
            _ => {}
        }
    }

    let id = id?;
    // Codex keeps a written thread name in its own index. Prefer it.
    let title = names
        .get(&id)
        .map(|n| trim_title(n))
        .or(title)
        .unwrap_or_else(|| "Untitled session".to_string());

    Some(SessionSummary {
        id,
        harness: "Codex",
        cwd: cwd.unwrap_or_default(),
        title,
        modified_ms: modified_ms(path),
        path: path.to_string_lossy().into_owned(),
    })
}

/// Map each Codex thread id to the name Codex recorded for it.
fn codex_names(home: &Path) -> HashMap<String, String> {
    let Ok(file) = File::open(home.join(".codex/session_index.jsonl")) else {
        return HashMap::new();
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(&line).ok())
        .filter_map(|record| {
            Some((
                record.get("id")?.as_str()?.to_string(),
                record.get("thread_name")?.as_str()?.to_string(),
            ))
        })
        .collect()
}

/// List the newest sessions from both CLIs, newest first.
///
/// Files are ranked by modification time *before* being parsed, so the cost
/// stays flat as a machine accumulates thousands of old transcripts.
#[tauri::command]
pub fn sessions_list(limit: Option<usize>) -> Result<Vec<SessionSummary>, String> {
    let home = home()?;
    let limit = limit.unwrap_or(200);

    let mut claude = Vec::new();
    collect_jsonl(&home.join(".claude/projects"), 1, &mut claude);

    let mut codex = Vec::new();
    collect_jsonl(&home.join(".codex/sessions"), 3, &mut codex);

    let mut candidates: Vec<(u64, bool, PathBuf)> = claude
        .into_iter()
        .map(|p| (modified_ms(&p), true, p))
        .chain(codex.into_iter().map(|p| (modified_ms(&p), false, p)))
        .collect();
    candidates.sort_unstable_by_key(|c| std::cmp::Reverse(c.0));
    // Parse more than asked for, because deduplicating removes some.
    candidates.truncate(limit.saturating_mul(2));

    let names = codex_names(&home);
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (_, is_claude, path) in &candidates {
        let Some(session) = (if *is_claude {
            read_claude(path)
        } else {
            read_codex(path, &names)
        }) else {
            continue;
        };
        // One conversation can leave several files behind. Keep the newest,
        // which is the first we meet because the list is already sorted.
        if seen.insert((session.harness, session.id.clone())) {
            out.push(session);
        }
        if out.len() == limit {
            break;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("berdloop-session-tests");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    fn write(path: &Path, body: &str) {
        let mut file = File::create(path).unwrap();
        file.write_all(body.as_bytes()).unwrap();
    }

    #[test]
    fn reads_a_claude_transcript() {
        let path = scratch("11111111-2222-3333-4444-555555555555.jsonl");
        write(
            &path,
            concat!(
                r#"{"type":"user","isMeta":true,"sessionId":"sid-1","cwd":"/work/app","message":{"role":"user","content":"<meta>"}}"#,
                "\n",
                r#"{"type":"user","sessionId":"sid-1","cwd":"/work/app","message":{"role":"user","content":[{"type":"text","text":"fix   the login bug"}]}}"#,
                "\n",
            ),
        );

        let session = read_claude(&path).unwrap();
        assert_eq!(session.id, "sid-1");
        assert_eq!(session.cwd, "/work/app");
        assert_eq!(session.harness, "Claude Code");
        // Whitespace is collapsed and the isMeta line is skipped.
        assert_eq!(session.title, "fix the login bug");
    }

    #[test]
    fn an_ai_title_beats_the_first_prompt() {
        let path = scratch("ai-title.jsonl");
        write(
            &path,
            concat!(
                r#"{"type":"user","sessionId":"sid-2","cwd":"/w","message":{"role":"user","content":"raw prompt"}}"#,
                "\n",
                r#"{"type":"ai-title","aiTitle":"Login fix","sessionId":"sid-2"}"#,
                "\n",
            ),
        );
        assert_eq!(read_claude(&path).unwrap().title, "Login fix");
    }

    #[test]
    fn reads_a_codex_rollout() {
        let path = scratch("rollout-test.jsonl");
        write(
            &path,
            concat!(
                r#"{"timestamp":"t","type":"session_meta","payload":{"session_id":"cx-1","cwd":"/work/api"}}"#,
                "\n",
                r#"{"timestamp":"t","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"audit the API"}]}}"#,
                "\n",
            ),
        );

        let session = read_codex(&path, &HashMap::new()).unwrap();
        assert_eq!(session.id, "cx-1");
        assert_eq!(session.cwd, "/work/api");
        assert_eq!(session.harness, "Codex");
        assert_eq!(session.title, "audit the API");
    }

    /// Smoke test against the real machine. Run with:
    ///   cargo test real_sessions -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_sessions() {
        let found = sessions_list(Some(10)).unwrap();
        for s in &found {
            println!("{:<12} {:<38} {}", s.harness, s.id, s.title);
            println!("             cwd={}", s.cwd);
        }
        assert!(!found.is_empty(), "no sessions found on this machine");
        assert!(found.iter().all(|s| !s.id.is_empty()));
    }

    #[test]
    fn a_transcript_with_no_id_is_dropped() {
        let path = scratch("rollout-empty.jsonl");
        write(&path, "{\"type\":\"event_msg\",\"payload\":{}}\n");
        assert!(read_codex(&path, &HashMap::new()).is_none());
    }
}
