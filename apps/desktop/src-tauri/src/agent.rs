//! Run a coding CLI and stream what it says back to the window.
//!
//! We always run the user's own `claude` or `codex` binary, in the task's
//! working directory. The CLI writes its own transcript, so a run started
//! here stays resumable from a plain terminal, and the other way round.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use crate::agent_preferences;
use crate::git::Staging;
use tauri::{AppHandle, Emitter, Manager};

pub const CHUNK_EVENT: &str = "agent://chunk";
pub const END_EVENT: &str = "agent://end";

/// Tail of stderr kept for the failure message. Enough to show a launch error
/// without holding a whole build log in memory.
const STDERR_TAIL: usize = 4096;

/// A worker we can still talk to.
///
/// The standard input handle is kept because that is how a Claude Code
/// conversation is steered once it is running. Codex is reached by a separate
/// command instead, so its handle is simply never used.
pub struct Live {
    child: Child,
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
pub struct Running(Mutex<HashMap<String, Live>>);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub run_id: String,
    /// Known up front for Claude Code, which lets us choose the session id.
    /// Codex assigns its own, so this stays null until the stream reports it.
    pub session_id: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentChunk {
    run_id: String,
    session_id: Option<String>,
    /// One of: text, thinking, tool, done, error.
    kind: &'static str,
    text: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentEnd {
    run_id: String,
    session_id: Option<String>,
    ok: bool,
    detail: String,
}

fn text_of(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

/// Turn one line of a CLI's JSON stream into zero or more display chunks.
/// Returns the session id whenever the line reveals it.
fn parse_line(
    harness: &str,
    line: &serde_json::Value,
    out: &mut Vec<(&'static str, String)>,
) -> Option<String> {
    if harness == "Codex" || harness == "codex" {
        return parse_codex(line, out);
    }
    parse_claude(line, out)
}

fn parse_claude(line: &serde_json::Value, out: &mut Vec<(&'static str, String)>) -> Option<String> {
    match line.get("type").and_then(|v| v.as_str()) {
        Some("assistant") => {
            let blocks = line
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array());
            for block in blocks.into_iter().flatten() {
                match block.get("type").and_then(|v| v.as_str()) {
                    Some("text") => {
                        if let Some(text) = text_of(block, "text") {
                            out.push(("text", text));
                        }
                    }
                    Some("thinking") => out.push(("thinking", String::new())),
                    Some("tool_use") => {
                        out.push(("tool", text_of(block, "name").unwrap_or_default()));
                    }
                    _ => {}
                }
            }
        }
        Some("result") => {
            let ok = line.get("subtype").and_then(|v| v.as_str()) == Some("success");
            out.push((if ok { "done" } else { "error" }, String::new()));
        }
        _ => {}
    }
    text_of(line, "session_id")
}

fn parse_codex(line: &serde_json::Value, out: &mut Vec<(&'static str, String)>) -> Option<String> {
    match line.get("type").and_then(|v| v.as_str()) {
        Some("thread.started") => return text_of(line, "thread_id"),
        Some("item.completed") => {
            let item = line.get("item")?;
            let kind = item
                .get("item_type")
                .or_else(|| item.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("item");
            match kind {
                "agent_message" => {
                    out.push(("text", text_of(item, "text").unwrap_or_default()));
                }
                "reasoning" => out.push(("thinking", String::new())),
                _ => {
                    let label = text_of(item, "command").unwrap_or_else(|| kind.to_string());
                    out.push(("tool", label));
                }
            }
        }
        Some("turn.completed") => out.push(("done", String::new())),
        Some("turn.failed") | Some("error") => {
            out.push(("error", text_of(line, "message").unwrap_or_default()));
        }
        _ => {}
    }
    None
}

/// Everything needed to run one agent, decided by `planConversation`.
///
/// The harness flags live in TypeScript beside the rules and tools they go
/// with, so this side only starts a process and carries its output back.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPlan {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// "stdin" when the prompt is written to the process rather than passed
    /// as an argument, which is what keeps the conversation steerable.
    pub delivery: String,
    pub prompt: String,
    /// Extra environment, such as a private harness home.
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
}

/// Absolute path to the `berdloop-worker` command that ships beside the app.
///
/// Agents are told this path rather than a bare name, because a harness runs
/// its shell from a saved snapshot that rebuilds PATH from the user's own
/// startup files. A worker that cannot find the command commits its work and
/// then never merges it, silently.
#[tauri::command]
pub fn worker_command() -> Result<String, String> {
    let here = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("the app has no directory")?
        .join("berdloop-worker");
    Ok(here.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn agent_start(
    app: AppHandle,
    running: tauri::State<'_, Running>,
    mut plan: LaunchPlan,
    harness: String,
    session_id: Option<String>,
    organization_id: Option<String>,
    project_id: Option<String>,
    role: Option<String>,
) -> Result<AgentRun, String> {
    if let Some(role) = role.as_deref() {
        let settings = agent_preferences::read(&app)?;
        if let Some(choice) = settings.resolve(
            organization_id.as_deref().unwrap_or(""),
            project_id.as_deref().unwrap_or(""),
            role,
        ) {
            apply_preference(&mut plan, choice);
        }
    }
    let run_id = uuid::Uuid::new_v4().to_string();
    let stream_prompt = plan.delivery == "stdin";
    let worker = Staging::locate(Path::new(&plan.cwd)).and_then(|(staging, task)| {
        staging
            .ticket_of(&task)
            .ok()
            .map(|ticket| (staging, task, ticket))
    });

    let mut child = Command::new(&plan.program)
        .args(&plan.args)
        .current_dir(&plan.cwd)
        // Belt and braces: the standing orders carry the absolute path, and
        // the command is on PATH as well for anything that looks there.
        .env("PATH", worker_path())
        .envs(&plan.env)
        .env("BERDLOOP_RUN_ID", &run_id)
        // Kept open, not closed: this is the channel a steering message uses.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", plan.program))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let mut stdin = child.stdin.take();

    // Claude Code reads its prompt from the same stream that later steering
    // messages use, so the first message is sent the same way as the rest.
    if stream_prompt {
        let handle = stdin.as_mut().ok_or("no stdin")?;
        write_user_message(handle, &plan.prompt).map_err(|e| e.to_string())?;
    }

    running
        .0
        .lock()
        .unwrap()
        .insert(run_id.clone(), Live { child, stdin });

    let errors = Arc::new(Mutex::new(String::new()));
    let sink = Arc::clone(&errors);
    std::thread::spawn(move || {
        let mut buffer = String::new();
        let mut reader = stderr;
        let _ = reader.read_to_string(&mut buffer);
        *sink.lock().unwrap() = buffer;
    });

    let app_handle = app.clone();
    let stream_run_id = run_id.clone();
    let mut stream_session = session_id.clone();
    std::thread::spawn(move || {
        let mut failed = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let mut chunks = Vec::new();
            if let Some(found) = parse_line(&harness, &value, &mut chunks) {
                stream_session = Some(found);
            }
            for (kind, text) in chunks {
                failed |= kind == "error";
                let _ = app_handle.emit(
                    CHUNK_EVENT,
                    AgentChunk {
                        run_id: stream_run_id.clone(),
                        session_id: stream_session.clone(),
                        kind,
                        text,
                    },
                );
            }
        }

        // Reap the child so a finished run leaves no zombie behind.
        let status = app_handle
            .state::<Running>()
            .0
            .lock()
            .unwrap()
            .remove(&stream_run_id)
            .and_then(|mut live| {
                // Closing standard input is what lets a streaming harness
                // finish. Nothing more will be sent to it.
                live.stdin.take();
                live.child.wait().ok()
            });
        let clean = status.is_some_and(|s| s.success()) && !failed;

        // An agent can crash, be stopped, or forget its final report. Record a
        // blocked outcome on disk so the loop can release its worker slot.
        if let Some((staging, task, ticket)) = worker {
            if !staging.has_report_for_run(&task, &stream_run_id) {
                let _ = staging.append_report(
                    &ticket,
                    &task,
                    "blocked",
                    "The agent exited without reporting an outcome. Its worktree was preserved.",
                    &stream_run_id,
                );
            }
        }

        let mut detail = errors.lock().unwrap().clone();
        if detail.len() > STDERR_TAIL {
            detail = detail.split_off(detail.len() - STDERR_TAIL);
        }
        let _ = app_handle.emit(
            END_EVENT,
            AgentEnd {
                run_id: stream_run_id,
                session_id: stream_session,
                ok: clean,
                detail: if clean { String::new() } else { detail },
            },
        );
    });

    Ok(AgentRun { run_id, session_id })
}

fn apply_preference(plan: &mut LaunchPlan, choice: &agent_preferences::RolePreference) {
    let model = choice.model.trim();
    if !model.is_empty() {
        if plan.program == "codex" {
            let at = plan.args.len().saturating_sub(1);
            plan.args
                .splice(at..at, ["--model".to_string(), model.to_string()]);
        } else if plan.program == "claude" {
            plan.args
                .splice(0..0, ["--model".to_string(), model.to_string()]);
        }
    }
    let custom = choice.system_prompt.trim();
    if custom.is_empty() {
        return;
    }
    if plan.program == "codex" {
        if let Some(prompt) = plan.args.last_mut() {
            *prompt = format!("{custom}\n\n---\n\n{prompt}");
        }
    } else if plan.program == "claude" {
        if let Some(at) = plan
            .args
            .iter()
            .position(|arg| arg == "--append-system-prompt")
        {
            if let Some(system) = plan.args.get_mut(at + 1) {
                system.push_str("\n\n## Organization and project instructions\n");
                system.push_str(custom);
            }
        }
    }
}

#[tauri::command]
pub fn agent_stop(running: tauri::State<'_, Running>, run_id: String) -> Result<(), String> {
    if let Some(mut live) = running.0.lock().unwrap().remove(&run_id) {
        live.stdin.take();
        live.child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A private Codex home, so an agent reads none of the user's configuration.
///
/// Codex keeps its config, skills, plugins and MCP servers under one
/// directory. Pointing it at ours isolates all of them at once. Only the
/// credentials are carried across, because the point is to use the user's own
/// subscription, not their tool setup.
#[tauri::command]
pub fn harness_home(app: AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let home = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not find the app data directory.".to_string())?
        .join("harness")
        .join("codex");
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;

    // Refreshed every time: the user may have logged in again since.
    if let Ok(user_home) = std::env::var("HOME") {
        let source = Path::new(&user_home).join(".codex/auth.json");
        if source.exists() {
            std::fs::copy(&source, home.join("auth.json")).map_err(|e| e.to_string())?;
        }
    }
    Ok(home.to_string_lossy().into_owned())
}

/// PATH for a worker, with the directory holding `berdloop-worker` in front.
fn worker_path() -> String {
    let existing = std::env::var("PATH").unwrap_or_default();
    match std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        Some(dir) => format!("{}:{existing}", dir.to_string_lossy()),
        None => existing,
    }
}

/// One line of the stream-json input format: a user turn.
fn write_user_message(handle: &mut ChildStdin, text: &str) -> std::io::Result<()> {
    let line = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text },
    });
    writeln!(handle, "{line}")?;
    handle.flush()
}

/// Interrupt a running conversation with a new instruction.
///
/// This is how a task agent steers a worker, and how a ticket agent steers a
/// task agent. A conversation that has already finished cannot be reached, and
/// says so rather than failing silently.
#[tauri::command]
pub fn agent_steer(
    running: tauri::State<'_, Running>,
    run_id: String,
    message: String,
) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("A steering message cannot be empty.".to_string());
    }
    let mut live = running.0.lock().unwrap();
    let target = live
        .get_mut(&run_id)
        .ok_or("That conversation is no longer running.")?;
    let handle = target
        .stdin
        .as_mut()
        .ok_or("That conversation does not take messages on its input.")?;
    write_user_message(handle, &message).map_err(|e| e.to_string())
}

/// Steer a harness that is reached from outside its own process.
///
/// Codex takes a message addressed by thread id, from any process, which means
/// a queued instruction can be delivered without holding the worker's handle.
#[tauri::command]
pub fn agent_steer_command(
    program: String,
    args: Vec<String>,
    session_id: String,
    message: String,
) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("A steering message cannot be empty.".to_string());
    }
    let filled: Vec<String> = args
        .iter()
        .map(|arg| {
            arg.replace("{session}", &session_id)
                .replace("{message}", &message)
        })
        .collect();
    let output = Command::new(&program)
        .args(&filled)
        .output()
        .map_err(|e| format!("could not run {program}: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_launch_receives_model_and_system_prompt() {
        let mut plan = LaunchPlan {
            program: "claude".into(),
            args: vec![
                "--append-system-prompt".into(),
                "Base rules".into(),
                "-p".into(),
            ],
            cwd: "/tmp".into(),
            delivery: "stdin".into(),
            prompt: "Task".into(),
            env: HashMap::new(),
        };
        apply_preference(
            &mut plan,
            &agent_preferences::RolePreference {
                model: "claude-opus-4-1".into(),
                system_prompt: "Check accessibility".into(),
            },
        );
        assert_eq!(&plan.args[..2], ["--model", "claude-opus-4-1"]);
        assert!(plan
            .args
            .iter()
            .any(|arg| arg.contains("Base rules") && arg.contains("Check accessibility")));
    }

    #[test]
    fn codex_launch_receives_model_and_system_prompt() {
        let mut plan = LaunchPlan {
            program: "codex".into(),
            args: vec!["exec".into(), "Base rules\n\nTask".into()],
            cwd: "/tmp".into(),
            delivery: "argv".into(),
            prompt: "Task".into(),
            env: HashMap::new(),
        };
        apply_preference(
            &mut plan,
            &agent_preferences::RolePreference {
                model: "gpt-5".into(),
                system_prompt: "Check accessibility".into(),
            },
        );
        assert_eq!(&plan.args[1..3], ["--model", "gpt-5"]);
        assert!(plan.args.last().unwrap().contains("Check accessibility"));
    }

    fn chunks(harness: &str, raw: &str) -> (Vec<(&'static str, String)>, Option<String>) {
        let value: serde_json::Value = serde_json::from_str(raw).unwrap();
        let mut out = Vec::new();
        let session = parse_line(harness, &value, &mut out);
        (out, session)
    }

    #[test]
    fn claude_text_and_tools_are_separated() {
        let (out, session) = chunks(
            "Claude Code",
            r#"{"type":"assistant","session_id":"s1","message":{"content":[
                {"type":"text","text":"hello"},
                {"type":"tool_use","name":"Bash","input":{}}]}}"#,
        );
        assert_eq!(session.as_deref(), Some("s1"));
        assert_eq!(out, [("text", "hello".into()), ("tool", "Bash".into())]);
    }

    #[test]
    fn a_failed_claude_result_is_an_error() {
        let (out, _) = chunks(
            "Claude Code",
            r#"{"type":"result","subtype":"error_max_turns"}"#,
        );
        assert_eq!(out, [("error", String::new())]);
    }

    #[test]
    fn codex_reports_its_own_thread_id() {
        let (out, session) = chunks("Codex", r#"{"type":"thread.started","thread_id":"cx-7"}"#);
        assert_eq!(session.as_deref(), Some("cx-7"));
        assert!(out.is_empty());
    }

    #[test]
    fn codex_agent_messages_become_text() {
        let (out, _) = chunks(
            "Codex",
            r#"{"type":"item.completed","item":{"item_type":"agent_message","text":"pong"}}"#,
        );
        assert_eq!(out, [("text", "pong".into())]);
    }

    #[test]
    fn codex_other_items_become_tools() {
        let (out, _) = chunks(
            "Codex",
            r#"{"type":"item.completed","item":{"item_type":"command_execution","command":"ls -la"}}"#,
        );
        assert_eq!(out, [("tool", "ls -la".into())]);
    }
}
