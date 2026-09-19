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
use std::time::SystemTime;

use crate::agent_preferences;
use crate::conversations::{Conversation, Conversations, Scope, UserMessage};
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
    outbound: Outbound,
    _control: Option<crate::control::Channel>,
}

#[derive(Clone)]
struct Outbound {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    plan: LaunchPlan,
    delivery: Arc<Mutex<()>>,
}

#[derive(Default)]
struct AgentState {
    live: HashMap<String, Live>,
    conversations: Conversations,
}

#[derive(Default)]
pub struct Running(Mutex<AgentState>);

const CONVERSATION_EVENT: &str = "agent://conversation";

/// Set whenever a thread changes, cleared by the writer below.
///
/// There is one conversation book in one process, so one flag is enough, and
/// it keeps `publish` from needing a lock its callers already hold.
static DIRTY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn publish(app: &AppHandle, thread: &Conversation) {
    DIRTY.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = app.emit(CONVERSATION_EVENT, thread);
}

/// Where the threads are kept between runs of the app.
fn conversations_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not find the app data directory.".to_string())?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory.join("conversations.v1.json"))
}

/// Read back the threads the previous run of the app left, at startup.
///
/// A conversation belongs to the work, not to the window, so a rebuild, a
/// reload or a crash must not lose one. Any thread still marked streaming
/// belonged to a process this one did not start: nothing is reading its
/// output any more, so it is stopped here and marked for a restart.
pub fn recover(app: &AppHandle) {
    let Ok(path) = conversations_path(app) else {
        return;
    };
    let mut book = Conversations::read(&path);
    for pgid in interrupt(&mut book) {
        stop_stale(pgid);
    }
    // Write what was just decided back out. A second stop before any agent
    // speaks would otherwise read the same threads as still running, and go
    // looking for process groups that were already stopped.
    DIRTY.store(true, std::sync::atomic::Ordering::Relaxed);
    app.state::<Running>().0.lock().unwrap().conversations = book;
}

/// Mark every thread that was still running, and answer with the process
/// groups left behind.
///
/// Kept apart from the app so the rule can be read and tested on its own.
pub fn interrupt(book: &mut Conversations) -> Vec<u32> {
    let mut stale = Vec::new();
    for thread in book.0.values_mut() {
        if !thread.streaming {
            continue;
        }
        stale.extend(thread.pgid.take());
        thread.streaming = false;
        // Work that reported an outcome is finished. Everything else was cut
        // off mid-sentence and is put back to work by the window.
        thread.interrupted = !["done", "merged"].contains(&thread.activity.as_str());
        if thread.interrupted {
            thread.activity = "queued".into();
        }
        thread.revision += 1;
    }
    stale
}

/// Stop a process group left behind by an earlier run of the app.
///
/// An orphaned agent is not working: nobody is reading its output, so it is
/// blocked on a full pipe as soon as it says anything. Its own transcript is
/// on disk, which is what the restart resumes from.
///
/// A process ID is reused, so the command is checked before anything is
/// signalled. A stale number must never reach somebody else's process.
fn stop_stale(pgid: u32) {
    let ours = Command::new("ps")
        .args(["-o", "command=", "-p", &pgid.to_string()])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .is_some_and(|line| line.starts_with("claude") || line.starts_with("codex"));
    if !ours {
        return;
    }
    let _ = Command::new("kill")
        .args(["-TERM", "--", &format!("-{pgid}")])
        .status();
}

/// Keep the saved threads up to date while agents are talking.
///
/// Every appended line marks them dirty and this writes at most once a
/// second, so a talkative agent costs one file write rather than hundreds.
pub fn autosave(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
        if !DIRTY.swap(false, std::sync::atomic::Ordering::Relaxed) {
            continue;
        }
        let Ok(path) = conversations_path(&app) else {
            continue;
        };
        let snapshot = Conversations(
            app.state::<Running>()
                .0
                .lock()
                .unwrap()
                .conversations
                .0
                .clone(),
        );
        if let Err(error) = snapshot.write(&path) {
            eprintln!("could not save conversations: {error}");
        }
    });
}

#[tauri::command]
pub fn agent_conversations(running: tauri::State<'_, Running>) -> Vec<Conversation> {
    running
        .0
        .lock()
        .unwrap()
        .conversations
        .0
        .values()
        .cloned()
        .collect()
}

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

/// The keys worth putting on the line itself, most telling first. A Bash call
/// says its command, a file tool says its file; anything else falls back to the
/// whole input, so a tool this list has never heard of still says something.
const TOOL_SUMMARY_KEYS: [&str; 8] = [
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
    "description",
    "prompt",
];

/// The keys a file-changing tool call uses to name the file it wrote.
///
/// Narrower than `TOOL_SUMMARY_KEYS` on purpose: that list says what to show
/// on any tool line, while this one is only read from a tool already known to
/// write, so a Read or a Grep never claims to have changed the file it named.
const TOOL_PATH_KEYS: [&str; 3] = ["file_path", "notebook_path", "path"];

/// A tool line: "Name · what it was called with", then the full input below.
///
/// The window shows the first line and opens the rest on a click, so a run of
/// tool calls still reads as a list while any one of them can be read in full.
fn tool_label(name: &str, input: Option<&serde_json::Value>) -> String {
    let Some(input) = input.filter(|value| {
        value.as_object().is_some_and(|fields| !fields.is_empty())
            || (!value.is_null() && !value.is_object())
    }) else {
        return name.to_string();
    };
    let detail = serde_json::to_string_pretty(input).unwrap_or_default();
    let summary = TOOL_SUMMARY_KEYS
        .iter()
        .find_map(|key| text_of(input, key))
        .unwrap_or_else(|| detail.clone());
    format!(
        "{name} · {}\n{}",
        one_line(&summary, 120),
        clamp(&detail, 4000)
    )
}

/// The first line of something, short enough to sit in a list.
fn one_line(text: &str, limit: usize) -> String {
    let first = text.lines().next().unwrap_or("").trim();
    let rest = text.lines().count() > 1;
    let mut out = clamp(first, limit);
    if rest && !out.ends_with('…') {
        out.push('…');
    }
    out
}

fn clamp(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit).collect::<String>() + "…"
}

/// What a tool line is classified by: its name and arguments, never the full
/// input, so a command that merely mentions "edit" is not counted as one.
fn tool_head(label: &str) -> &str {
    label.split('\n').next().unwrap_or(label)
}

/// The files one line of a CLI's JSON stream says the agent wrote.
///
/// A harness only ever sends prose in an agent message: a file change arrives
/// as a tool call. So this is where a change to a file is found, and the
/// thread draws each one as that file's summary row instead of a plain tool
/// line, now that the diff itself is read in the Changes tab.
///
/// Read apart from `parse_line` because it answers a different question: that
/// one builds what the chat displays, this one says which of those tool lines
/// wrote a file. Each entry carries the position of its tool call among this
/// line's tool calls, which is what pairs it back to the right line. Position
/// is used rather than the label because `is_edit` reads a label by substring,
/// and a Bash command that merely mentions writing would take the wrong path.
fn edited_paths(harness: &str, line: &serde_json::Value) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    if harness == "Codex" || harness == "codex" {
        if line.get("type").and_then(|v| v.as_str()) != Some("item.completed") {
            return out;
        }
        let Some(item) = line.get("item") else {
            return out;
        };
        let kind = item
            .get("item_type")
            .or_else(|| item.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("item");
        // One item is one tool line, so anything found here belongs to it.
        if !is_edit(kind) {
            return out;
        }
        out.extend(tool_path(item).map(|path| (0, path)));
        return out;
    }
    if line.get("type").and_then(|v| v.as_str()) != Some("assistant") {
        return out;
    }
    let blocks = line
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array());
    let mut at = 0;
    for block in blocks.into_iter().flatten() {
        if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
            continue;
        }
        let here = at;
        at += 1;
        let Some(name) = text_of(block, "name") else {
            continue;
        };
        if !is_edit(&name) {
            continue;
        }
        let Some(input) = block.get("input") else {
            continue;
        };
        out.extend(tool_path(input).map(|path| (here, path)));
    }
    out
}

/// The file a writing tool's arguments name, if they name one at all.
///
/// A tool that names none — a Bash line that writes by itself — leaves no
/// row, because nothing here can tell what it touched.
fn tool_path(input: &serde_json::Value) -> Option<String> {
    TOOL_PATH_KEYS
        .iter()
        .find_map(|key| text_of(input, key))
        .filter(|path| !path.trim().is_empty())
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
                        let name = text_of(block, "name").unwrap_or_default();
                        out.push(("tool", tool_label(&name, block.get("input"))));
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
                    let label = match text_of(item, "command") {
                        Some(command) => format!(
                            "{} · {}\n{}",
                            kind,
                            one_line(&command, 120),
                            clamp(&command, 4000)
                        ),
                        None => kind.to_string(),
                    };
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
#[derive(Clone, serde::Deserialize)]
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

/// The decision gateway a worker should use, as environment.
///
/// The approval gate runs inside the worker, which is its own process, so the
/// gateway has to travel with it. Empty when the beta is off, and the gate
/// then behaves exactly as it did before.
fn decisions_env(app: &AppHandle) -> HashMap<String, String> {
    let settings = crate::harness_settings::read(app);
    match crate::jev::Jev::available(&settings) {
        Some(jev) => HashMap::from([
            (
                crate::jev::PROVIDER_VAR.to_string(),
                jev.provider().id().to_string(),
            ),
            (crate::jev::KEY_VAR.to_string(), jev.key().to_string()),
        ]),
        None => HashMap::new(),
    }
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
        .join(if cfg!(windows) {
            "berdloop-worker.exe"
        } else {
            "berdloop-worker"
        });
    check_worker_binary(&here)?;
    Ok(here.to_string_lossy().into_owned())
}

/// Refuse to start an agent whose helper is missing, before it can commit work
/// it will never be able to merge. The build writes a shell-script placeholder
/// when the real helper has not been built yet; that is caught here too.
fn check_worker_binary(path: &Path) -> Result<(), String> {
    let mut head = [0u8; 2];
    let read = std::fs::File::open(path)
        .and_then(|mut file| file.read(&mut head))
        .map_err(|_| {
            format!(
                "The worker helper is missing at {}. Rebuild the app with `bun run build:desktop`, or run `cargo build --bins` for development.",
                path.display()
            )
        })?;
    if read == 2 && &head == b"#!" {
        return Err(format!(
            "The worker helper at {} is a build placeholder, not the real command. Run `bun run sidecar` and rebuild the app.",
            path.display()
        ));
    }
    check_worker_age(path)
}

/// In development, refuse a worker helper built before the code it links.
///
/// `tauri dev` runs `cargo run --bin berdloop`, which builds the app alone. The
/// helper is a second binary, left at whatever version was last built by hand,
/// so a change to the worker rules is picked up by the window and ignored by
/// every worker. It fails silently, which is the dangerous part: an old helper
/// deleted its place in the merge queue instead of marking it merged, so the
/// record of what had landed went missing for a whole day of work.
///
/// Compare against the crate's sources, not against the app binary. The app is
/// always relinked after the helper, so an app comparison rejects a build that
/// is in fact current, and it never catches a helper older than the source it
/// was built from, which is the failure that actually happened: a worker was
/// told `dev-start` did not exist when the source had carried it for hours.
///
/// A bundled app is left alone. There the packer writes the files in whatever
/// order it likes, and their times say nothing.
fn check_worker_age(path: &Path) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Ok(());
    }
    let Ok(helper) = std::fs::metadata(path).and_then(|meta| meta.modified()) else {
        return Ok(());
    };
    let Some(source) = newest_source(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src")) else {
        return Ok(());
    };
    if helper < source {
        return Err(format!(
            "The worker helper at {} is older than the code it is built from, so agents would run old rules. Run `cargo build --bins --manifest-path apps/desktop/src-tauri/Cargo.toml`, then start the agent again.",
            path.display()
        ));
    }
    Ok(())
}

/// When any Rust file under `dir` was last written. Unreadable entries are
/// skipped: a missing source tree must not block a packaged app from starting.
fn newest_source(dir: &Path) -> Option<SystemTime> {
    let mut newest = None;
    let mut todo = vec![dir.to_path_buf()];
    while let Some(dir) = todo.pop() {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                todo.push(entry.path());
            } else if entry.path().extension().is_some_and(|ext| ext == "rs") {
                if let Ok(at) = entry.metadata().and_then(|meta| meta.modified()) {
                    newest = newest.max(Some(at));
                }
            }
        }
    }
    newest
}

#[tauri::command]
pub fn agent_start(
    app: AppHandle,
    running: tauri::State<'_, Running>,
    mut plan: LaunchPlan,
    harness: String,
    session_id: Option<String>,
    scope: Scope,
    opening: Option<UserMessage>,
) -> Result<AgentRun, String> {
    let key = scope.key()?;
    // The app is attempting this thread now, so it is no longer waiting to be
    // resumed. Cleared before anything that can fail: a start that dies on a
    // missing worker binary used to leave the flag set forever, and the loop
    // reads that flag as "somebody is already on it" and never puts the
    // abandoned task back.
    {
        let mut state = running.0.lock().unwrap();
        if let Ok(thread) = state.conversations.ensure(&scope) {
            thread.interrupted = false;
        }
    }
    // Every agent is given the worker helper's path in its orders, so no
    // launch path may skip the checks on it. A worker that cannot reach the
    // merge queue commits its work and then never merges it, quietly.
    worker_command()?;
    check_scope(&app, &scope)?;
    let settings = agent_preferences::read(&app)?;
    if let Some(choice) = settings.resolve(&scope.organization_id, &scope.project_id, &scope.role) {
        apply_preference(&mut plan, &choice);
    }
    let control = if scope.role != "worker" {
        let (channel, path) = crate::control::open(&app, scope.clone())?;
        plan.env
            .insert("BERDLOOP_CONTROL".into(), path.to_string_lossy().into());
        let workspace = crate::workspace::for_app(&app)?.load()?;
        let tickets: Vec<_> = workspace["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| {
                t["projectId"] == scope.project_id
                    && scope.ticket_id.as_ref().is_none_or(|id| t["id"] == *id)
            })
            .collect();
        let tasks: Vec<_> = workspace["agentTasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| {
                tickets
                    .iter()
                    .any(|parent| parent["id"] == t["parentTaskId"])
            })
            .collect();
        let context = format!("\n\n## Current workspace\nProject ID: {}\nTickets: {}\nTasks: {}\nUse queue-show to refresh this state before changes.",
            scope.project_id, serde_json::to_string(&tickets).unwrap(), serde_json::to_string(&tasks).unwrap());
        plan.prompt.push_str(&context);
        if plan.delivery == "argv" {
            plan.args
                .last_mut()
                .ok_or("Missing prompt")?
                .push_str(&context);
        }
        Some(channel)
    } else {
        None
    };
    // Hold the routing lock until both the process and its conversation exist.
    // Concurrent starts/sends cannot create two agents or miss the first output.
    let mut state = running.0.lock().unwrap();
    let thread = state.conversations.ensure(&scope)?;
    if thread.streaming {
        return Err("This conversation already has a running agent.".into());
    }
    if let Some(message) = opening.as_ref() {
        thread.enqueue(message.clone())?;
    }
    let pending = thread.pending();
    let extra: Vec<_> = pending
        .iter()
        .filter(|m| opening.as_ref().is_none_or(|first| first.id != m.id))
        .map(|m| m.text.as_str())
        .collect();
    if !extra.is_empty() {
        let suffix = format!(
            "\n\n## Instructions received while queued\n{}",
            extra.join("\n\n")
        );
        plan.prompt.push_str(&suffix);
        if plan.delivery == "argv" {
            let prompt = plan
                .args
                .last_mut()
                .ok_or("The launch plan has no prompt.")?;
            prompt.push_str(&suffix);
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
    // Remember the directory as it stands, so the window can show what this
    // run changes. A missed snapshot only costs a diff view, never a launch.
    if let Some((staging, task, _)) = worker.as_ref() {
        if let Err(error) = staging.mark_turn(task) {
            eprintln!("could not mark the turn for {task}: {error}");
        }
    }
    let mut command = Command::new(&plan.program);
    command
        .args(&plan.args)
        .current_dir(&plan.cwd)
        .env("PATH", worker_path())
        .envs(&plan.env)
        .env("BERDLOOP_RUN_ID", &run_id)
        // The approval gate runs inside the worker, which is its own process,
        // so the gateway has to travel with it. Empty when the beta is off,
        // and the gate then behaves exactly as it did before.
        .envs(decisions_env(&app))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Its own process group, so stopping the agent also stops whatever it was
    // running: a test suite left behind would otherwise keep writing into a
    // worktree the next attempt is about to use.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let spawned = command.spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            if let Some(message) = opening.as_ref() {
                thread.delivery(&message.id, "failed");
            }
            thread.append(
                "system",
                format!("Could not start {}: {error}", plan.program),
            );
            publish(&app, thread);
            return Err(format!("could not start {}: {error}", plan.program));
        }
    };
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let mut stdin = child.stdin.take();
    if stream_prompt {
        let result = stdin
            .as_mut()
            .ok_or("no stdin".to_string())
            .and_then(|handle| write_user_message(handle, &plan.prompt).map_err(|e| e.to_string()));
        if let Err(error) = result {
            let _ = child.kill();
            let _ = child.wait();
            if let Some(message) = opening.as_ref() {
                thread.delivery(&message.id, "failed");
            }
            publish(&app, thread);
            return Err(error);
        }
    }
    thread.run_id = Some(run_id.clone());
    // The agent leads its own group, so its process ID is the group's. Saved
    // so a later run of the app can stop it if this one does not get to.
    thread.pgid = Some(child.id());
    thread.session_id = session_id.clone();
    thread.harness = harness.clone();
    thread.worktree = Some(plan.cwd.clone());
    thread.streaming = true;
    thread.activity = "coding".into();
    thread.edits = 0;
    thread.started_at = Some(crate::human::now_ms());
    thread.revision += 1;
    for message in pending {
        thread.delivery(&message.id, "delivered");
    }
    publish(&app, thread);
    state.live.insert(
        run_id.clone(),
        Live {
            child,
            _control: control,
            outbound: Outbound {
                stdin: Arc::new(Mutex::new(stdin)),
                plan,
                delivery: Arc::new(Mutex::new(())),
            },
        },
    );
    drop(state);

    let errors = Arc::new(Mutex::new(String::new()));
    let sink = Arc::clone(&errors);
    let stderr_reader = std::thread::spawn(move || {
        let mut buffer = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut buffer);
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
            let found = parse_line(&harness, &value, &mut chunks);
            let written = edited_paths(&harness, &value);
            if let Some(session) = &found {
                stream_session = Some(session.clone());
            }
            {
                let running = app_handle.state::<Running>();
                let mut state = running.0.lock().unwrap();
                if let Some(thread) = state.conversations.for_run(&key, &stream_run_id) {
                    if let Some(session) = found.as_ref() {
                        thread.session_id = Some(session.clone());
                        thread.revision += 1;
                    }
                    // Which tool line of this stream line we are on, so a
                    // path found above lands on the call that wrote it.
                    let mut tool_at = 0;
                    for (kind, text) in &chunks {
                        match *kind {
                            "text" if !text.is_empty() => thread.append("agent", text.clone()),
                            "error" => thread.append(
                                "system",
                                if text.is_empty() {
                                    "The agent reported an error.".into()
                                } else {
                                    text.clone()
                                },
                            ),
                            "tool" => {
                                let head = tool_head(text);
                                thread.activity = activity_of(head).into();
                                if is_edit(head) {
                                    thread.edits += 1;
                                }
                                let path = written
                                    .iter()
                                    .find(|(at, _)| *at == tool_at)
                                    .map(|(_, path)| path.clone());
                                tool_at += 1;
                                // The thread showed only the agent's prose, so
                                // a worker that spent ten minutes running
                                // commands looked idle. Its own role keeps it
                                // out of the prose and lets the window draw it
                                // as a tool line, or, where the call wrote a
                                // file, as that file's one summary row.
                                if text.is_empty() {
                                    thread.revision += 1;
                                } else {
                                    thread.append_tool(text.clone(), path);
                                }
                            }
                            _ => {}
                        }
                    }
                    publish(&app_handle, thread);
                }
            }
            // Session announcements need no text to flush a message queued during startup.
            if found.is_some() {
                let _ = deliver_pending(&app_handle, &key, &stream_run_id);
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
        let live = app_handle
            .state::<Running>()
            .0
            .lock()
            .unwrap()
            .live
            .remove(&stream_run_id);
        let status = live.and_then(|mut live| {
            live.outbound.stdin.lock().unwrap().take();
            live.child.wait().ok()
        });
        let clean = status.is_some_and(|s| s.success()) && !failed;
        // A worker that exits cleanly without a report has not finished: its work
        // never left its worktree. Calling that "done" hides the one failure the
        // report exists to catch, so the run is only done when it reported.
        let mut reported = true;
        if let Some((staging, task, ticket)) = worker {
            reported = staging.has_report_for_run(&task, &stream_run_id);
            if !reported {
                let _ = staging.append_report(
                    &ticket,
                    &task,
                    "blocked",
                    "The agent exited without reporting an outcome. Its worktree was preserved.",
                    &stream_run_id,
                );
            }
        }
        let _ = stderr_reader.join();
        let detail: String = errors
            .lock()
            .unwrap()
            .chars()
            .rev()
            .take(STDERR_TAIL)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        {
            let running = app_handle.state::<Running>();
            let mut state = running.0.lock().unwrap();
            if let Some(thread) = state.conversations.for_run(&key, &stream_run_id) {
                thread.streaming = false;
                thread.pgid = None;
                if thread.activity != "paused" {
                    thread.activity = if clean && reported { "done" } else { "blocked" }.into();
                }
                thread.revision += 1;
                for message in thread.pending() {
                    thread.delivery(&message.id, "failed");
                }
                if !clean && !detail.is_empty() {
                    thread.append("system", detail.clone());
                }
                publish(&app_handle, thread);
            }
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

/// Whether a tool call changed a file. Counted for the row badge, nothing else.
fn is_edit(tool: &str) -> bool {
    let tool = tool.to_lowercase();
    ["edit", "write", "patch", "file_change"]
        .iter()
        .any(|name| tool.contains(name))
}

fn activity_of(tool: &str) -> &'static str {
    let tool = tool.to_lowercase();
    if tool.contains("merge-wait") || tool.contains("merge-request") {
        "waiting-to-merge"
    } else if tool.contains("merge-sync") || tool.contains("merge-land") {
        "merging"
    } else if tool.contains("test") || tool.contains("check") {
        "testing"
    } else {
        "coding"
    }
}

/// Route by conversation scope. The browser never chooses a process or session ID.
#[tauri::command]
pub async fn agent_send_message(
    app: AppHandle,
    scope: Scope,
    message: UserMessage,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || send_message(&app, scope, message))
        .await
        .map_err(|error| error.to_string())?
}

fn send_message(app: &AppHandle, scope: Scope, message: UserMessage) -> Result<(), String> {
    let key = scope.key()?;
    // Writing to a worker that has stopped is how a person changes work that is
    // already done. There is nobody to interrupt, so the message becomes the
    // instruction for its next run and the task goes back on the queue. The
    // worktree is untouched: the next run continues where this one left off.
    let reopening = match scope.task_id.as_deref() {
        Some(task) if scope.role == "worker" => {
            let running = app.state::<Running>();
            let stopped = {
                let mut state = running.0.lock().unwrap();
                let thread = state.conversations.ensure(&scope)?;
                thread.run_id.is_some() && !thread.streaming
            };
            // Refused before the message is kept, so a task that cannot be
            // reopened does not silently swallow what was typed.
            if stopped {
                reopen_task(app, task)?;
            }
            stopped
        }
        _ => false,
    };
    let run = {
        let running = app.state::<Running>();
        let mut state = running.0.lock().unwrap();
        let thread = state.conversations.ensure(&scope)?;
        if !reopening && thread.run_id.is_some() && !thread.streaming {
            return Err(
                "That agent has stopped. Start or resume the conversation before sending.".into(),
            );
        }
        thread.enqueue(message)?;
        if reopening {
            thread.activity = "queued".into();
            thread.revision += 1;
        }
        let run = thread.run_id.clone();
        publish(app, thread);
        // A stopped run cannot be handed anything; the next one collects it.
        if reopening {
            None
        } else {
            run
        }
    };
    if let Some(run) = run {
        deliver_pending(app, &key, &run)?;
    }
    Ok(())
}

/// Put a finished worker's task back on the queue.
///
/// The worktree is left exactly as the worker left it, so the next run carries
/// on from its own commits rather than starting the task again.
fn reopen_task(app: &AppHandle, task_id: &str) -> Result<(), String> {
    let store = crate::workspace::for_app(app)?;
    store.change(|w| reopen(w, task_id))?;
    Ok(())
}

/// Whether this task may go back on the queue, and the change if it may.
///
/// Kept apart from the app so the rules can be read and tested on their own.
pub fn reopen(w: &mut serde_json::Value, task_id: &str) -> Result<(), String> {
    let id = serde_json::json!(task_id);
    let tasks = w["agentTasks"].as_array().ok_or("Invalid tasks")?;
    let target = tasks
        .iter()
        .find(|t| t["id"] == id)
        .ok_or("That task is no longer in the workspace")?;
    // A shipped ticket has nothing left running to pick the work up, so queuing
    // it would look like it worked and then do nothing.
    let parent = target["parentTaskId"].clone();
    if w["tasks"]
        .as_array()
        .and_then(|list| list.iter().find(|t| t["id"] == parent))
        .is_some_and(|t| t["status"] == serde_json::json!("complete"))
    {
        return Err("This ticket is finished. Open a new ticket for further changes.".into());
    }
    // Work built on top of this would be standing on something being changed
    // underneath it.
    if target["status"] == serde_json::json!("complete") {
        let dependents: Vec<&str> = tasks
            .iter()
            .filter(|t| {
                t["dependencyIds"]
                    .as_array()
                    .is_some_and(|d| d.contains(&id))
                    && ["running", "review", "complete"]
                        .contains(&t["status"].as_str().unwrap_or(""))
            })
            .filter_map(|t| t["title"].as_str())
            .collect();
        if !dependents.is_empty() {
            return Err(format!(
                "Reopen the work that depends on this first: {}",
                dependents.join(", ")
            ));
        }
    }
    let item = w["agentTasks"]
        .as_array_mut()
        .ok_or("Invalid tasks")?
        .iter_mut()
        .find(|t| t["id"] == id)
        .ok_or("That task is no longer in the workspace")?;
    item["status"] = serde_json::json!("queued");
    item["updatedAt"] = serde_json::json!(crate::workspace::now());
    Ok(())
}

pub(crate) fn queue_instruction(
    app: &AppHandle,
    scope: Scope,
    message: UserMessage,
) -> Result<(), String> {
    let key = scope.key()?;
    let run = {
        let running = app.state::<Running>();
        let mut state = running.0.lock().unwrap();
        let thread = state.conversations.ensure(&scope)?;
        thread.enqueue(message)?;
        if !thread.streaming {
            thread.activity = "queued".into();
            thread.revision += 1;
        }
        publish(app, thread);
        thread.streaming.then(|| thread.run_id.clone()).flatten()
    };
    if let Some(run) = run {
        deliver_pending(app, &key, &run)?;
    }
    Ok(())
}

pub(crate) fn note(app: &AppHandle, scope: &Scope, message: String) {
    let Ok(key) = scope.key() else {
        return;
    };
    let running = app.state::<Running>();
    let mut state = running.0.lock().unwrap();
    if let Some(thread) = state.conversations.0.get_mut(&key) {
        thread.append("system", message);
        publish(app, thread);
    }
}

pub(crate) fn stop_and_wait(app: &AppHandle, scope: &Scope) -> Result<(), String> {
    agent_stop(app.clone(), scope.clone())?;
    let key = scope.key()?;
    let start = std::time::Instant::now();
    loop {
        let running = app.state::<Running>();
        let streaming = running
            .0
            .lock()
            .unwrap()
            .conversations
            .0
            .get(&key)
            .is_some_and(|t| t.streaming);
        if !streaming {
            return Ok(());
        }
        if start.elapsed().as_secs() >= 5 {
            return Err("Worker has not exited yet. Retry after it stops.".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

// Serialize only one conversation's deliveries. A slow external CLI must not
// block another conversation, stream events, snapshots, or the UI thread.
fn deliver_pending(app: &AppHandle, key: &str, run: &str) -> Result<(), String> {
    let running = app.state::<Running>();
    deliver_messages(&running.0, key, run, |thread| publish(app, thread))
}

fn deliver_messages(
    state: &Mutex<AgentState>,
    key: &str,
    run: &str,
    notify: impl Fn(&Conversation),
) -> Result<(), String> {
    let outbound = {
        let state = state.lock().unwrap();
        let Some(process) = state.live.get(run) else {
            return Ok(());
        };
        process.outbound.clone()
    };
    let _delivery = outbound.delivery.lock().unwrap();
    loop {
        let (message, session) = {
            let mut state = state.lock().unwrap();
            let thread = state
                .conversations
                .for_run(key, run)
                .ok_or("The agent run changed.")?;
            if !thread.streaming {
                return Err("That agent has stopped.".into());
            }
            let Some(message) = thread.pending().into_iter().next() else {
                return Ok(());
            };
            if outbound.plan.delivery != "stdin" && thread.session_id.is_none() {
                return Ok(());
            }
            (message, thread.session_id.clone())
        };
        // Every instruction starts a new turn, so the diff view can show what
        // this one message produced rather than the whole run.
        if let Some((staging, task)) = Staging::locate(Path::new(&outbound.plan.cwd)) {
            if let Err(error) = staging.mark_turn(&task) {
                eprintln!("could not mark the turn for {task}: {error}");
            }
        }
        let result = if outbound.plan.delivery == "stdin" {
            outbound
                .stdin
                .lock()
                .unwrap()
                .as_mut()
                .ok_or("The agent input is closed.".to_string())
                .and_then(|handle| {
                    write_user_message(handle, &message.text).map_err(|e| e.to_string())
                })
        } else {
            send_codex(&outbound.plan, session.as_deref().unwrap(), &message.text)
        };
        let mut state = state.lock().unwrap();
        if let Some(thread) = state.conversations.for_run(key, run) {
            thread.delivery(
                &message.id,
                if result.is_ok() {
                    "delivered"
                } else {
                    "failed"
                },
            );
            notify(thread);
        }
        result?;
    }
}

fn send_codex(plan: &LaunchPlan, session: &str, message: &str) -> Result<(), String> {
    let output = Command::new(&plan.program)
        .args(["queue", "--thread", session, "--message", message])
        .current_dir(&plan.cwd)
        .envs(&plan.env)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn apply_preference(plan: &mut LaunchPlan, choice: &agent_preferences::RolePreference) {
    let model = choice.model.as_deref().unwrap_or("").trim();
    let preference_harness = choice.harness.as_deref().unwrap_or("claude-code");
    let plan_harness = if plan.program == "codex" {
        "codex"
    } else {
        "claude-code"
    };
    if !model.is_empty() && preference_harness == plan_harness {
        if plan.program == "codex" {
            let at = plan.args.len().saturating_sub(1);
            plan.args
                .splice(at..at, ["--model".to_string(), model.to_string()]);
        } else if plan.program == "claude" {
            plan.args
                .splice(0..0, ["--model".to_string(), model.to_string()]);
        }
    }
    let custom = choice.system_prompt.as_deref().unwrap_or("").trim();
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
pub fn agent_stop(app: AppHandle, scope: Scope) -> Result<(), String> {
    let running = app.state::<Running>();
    let mut state = running.0.lock().unwrap();
    let thread = state.conversations.ensure(&scope)?;
    let run = thread.run_id.clone();
    if let Some(run) = run {
        if let Some(live) = state.live.get_mut(&run) {
            kill_group(&mut live.child)?;
            live.outbound.stdin.lock().unwrap().take();
        }
        let thread = state.conversations.ensure(&scope)?;
        thread.activity = "paused".into();
        // Keep this run reserved until its reader has reaped the process.
        thread.revision += 1;
        publish(&app, thread);
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

/// Stop the agent and every process it started. The agent was spawned as the
/// leader of its own group, so a negative pid reaches all of them.
fn kill_group(child: &mut Child) -> Result<(), String> {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", "--", &format!("-{}", child.id())])
            .status();
    }
    child.kill().map_err(|e| e.to_string())
}

/// The scope an agent is started under must exist in the records, or an agent
/// could be attached to a task that was removed or moved to another project.
fn check_scope(app: &AppHandle, scope: &Scope) -> Result<(), String> {
    let workspace = crate::workspace::for_app(app)?.load()?;
    let ticket = match scope.ticket_id.as_deref() {
        None => return Ok(()),
        Some(id) => workspace["tasks"]
            .as_array()
            .and_then(|tickets| tickets.iter().find(|t| t["id"] == id))
            .filter(|t| t["projectId"] == scope.project_id)
            .ok_or("That ticket is not in this project.")?,
    };
    if let Some(task) = scope.task_id.as_deref() {
        workspace["agentTasks"]
            .as_array()
            .and_then(|tasks| tasks.iter().find(|t| t["id"] == task))
            .filter(|t| t["parentTaskId"] == ticket["id"])
            .ok_or("That task is not on this ticket.")?;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Writing in a finished worker's conversation is how work gets changed, so
    /// what may and may not be reopened is the rule worth pinning down.
    #[test]
    fn reopening_a_task_is_allowed_unless_something_already_stands_on_it() {
        let workspace = |ticket: &str, first: &str, second: &str| {
            serde_json::json!({
                "tasks": [{"id": "t1", "projectId": "p", "status": ticket}],
                "agentTasks": [
                    {"id": "a", "parentTaskId": "t1", "title": "first",
                     "status": first, "dependencyIds": []},
                    {"id": "b", "parentTaskId": "t1", "title": "second",
                     "status": second, "dependencyIds": ["a"]},
                ],
            })
        };

        // The ordinary case: a finished worker's task goes back on the queue.
        let mut w = workspace("running", "complete", "queued");
        reopen(&mut w, "a").unwrap();
        assert_eq!(w["agentTasks"][0]["status"], "queued");

        // A blocked task is reopened the same way, with nothing in its path.
        let mut w = workspace("running", "blocked", "queued");
        reopen(&mut w, "a").unwrap();
        assert_eq!(w["agentTasks"][0]["status"], "queued");

        // Work built on top of it has to be reopened first, and is named.
        let mut w = workspace("running", "complete", "complete");
        let refused = reopen(&mut w, "a").unwrap_err();
        assert!(refused.contains("second"), "{refused}");
        assert_eq!(w["agentTasks"][0]["status"], "complete", "left untouched");

        // A shipped ticket has nobody left to pick the work up.
        let mut w = workspace("complete", "complete", "complete");
        assert!(reopen(&mut w, "a").unwrap_err().contains("new ticket"));

        let mut w = workspace("running", "complete", "queued");
        assert!(reopen(&mut w, "gone").is_err());
    }

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
                harness: None,
                model: Some("claude-opus-4-1".into()),
                system_prompt: Some("Check accessibility".into()),
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
                harness: Some("codex".into()),
                model: Some("gpt-5".into()),
                system_prompt: Some("Check accessibility".into()),
            },
        );
        assert_eq!(&plan.args[1..3], ["--model", "gpt-5"]);
        assert!(plan.args.last().unwrap().contains("Check accessibility"));
    }

    #[test]
    fn changing_harness_defaults_does_not_apply_incompatible_models_to_old_sessions() {
        let mut plan = LaunchPlan {
            program: "claude".into(),
            args: vec!["-p".into()],
            cwd: "/tmp".into(),
            delivery: "stdin".into(),
            prompt: "Task".into(),
            env: HashMap::new(),
        };
        apply_preference(
            &mut plan,
            &agent_preferences::RolePreference {
                harness: Some("codex".into()),
                model: Some("codex-model".into()),
                system_prompt: Some(String::new()),
            },
        );
        assert!(!plan.args.contains(&"--model".to_string()));
    }

    fn chunks(harness: &str, raw: &str) -> (Vec<(&'static str, String)>, Option<String>) {
        let value: serde_json::Value = serde_json::from_str(raw).unwrap();
        let mut out = Vec::new();
        let session = parse_line(harness, &value, &mut out);
        (out, session)
    }

    #[test]
    fn only_file_changing_tools_count_as_edits() {
        assert!(is_edit("Edit"));
        assert!(is_edit("MultiEdit"));
        assert!(is_edit("Write"));
        assert!(is_edit("apply_patch"));
        assert!(is_edit("file_change"));
        assert!(!is_edit("Bash"));
        assert!(!is_edit("Read"));
        assert!(!is_edit("merge-wait"));
    }

    fn written(harness: &str, raw: &str) -> Vec<(usize, String)> {
        edited_paths(harness, &serde_json::from_str(raw).unwrap())
    }

    #[test]
    fn two_claude_edits_name_two_files_in_order() {
        assert_eq!(
            written(
                "Claude Code",
                r#"{"type":"assistant","message":{"content":[
                    {"type":"tool_use","name":"Edit","input":{"file_path":"src/a.ts"}},
                    {"type":"tool_use","name":"Edit","input":{"file_path":"src/b.ts"}}]}}"#,
            ),
            [(0, "src/a.ts".to_string()), (1, "src/b.ts".to_string())]
        );
    }

    #[test]
    fn a_tool_that_writes_no_file_names_none() {
        assert!(written(
            "Claude Code",
            r#"{"type":"assistant","message":{"content":[
                {"type":"tool_use","name":"Bash","input":{"command":"ls"}},
                {"type":"tool_use","name":"Read","input":{"file_path":"src/a.ts"}}]}}"#,
        )
        .is_empty());
    }

    #[test]
    fn an_edit_is_placed_by_its_tool_call_and_not_by_its_turn_to_write() {
        // The Bash line mentions writing, so anything pairing a path to a tool
        // line by name alone would hand it the Edit's file. The position says
        // otherwise: the third tool call is the one that wrote.
        assert_eq!(
            written(
                "Claude Code",
                r#"{"type":"assistant","message":{"content":[
                    {"type":"text","text":"on it"},
                    {"type":"tool_use","name":"Bash","input":{"command":"bun run write:docs"}},
                    {"type":"tool_use","name":"Read","input":{"file_path":"src/a.ts"}},
                    {"type":"tool_use","name":"Edit","input":{"file_path":"src/b.ts"}}]}}"#,
            ),
            [(2, "src/b.ts".to_string())]
        );
    }

    #[test]
    fn a_notebook_edit_names_its_own_key() {
        assert_eq!(
            written(
                "Claude Code",
                r#"{"type":"assistant","message":{"content":[
                    {"type":"tool_use","name":"NotebookEdit","input":{"notebook_path":"run.ipynb"}}]}}"#,
            ),
            [(0, "run.ipynb".to_string())]
        );
    }

    #[test]
    fn a_codex_patch_names_the_file_it_changed() {
        assert_eq!(
            written(
                "Codex",
                r#"{"type":"item.completed","item":{"item_type":"file_change","path":"src/a.ts"}}"#,
            ),
            [(0, "src/a.ts".to_string())]
        );
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
    fn a_tool_line_carries_its_arguments() {
        let (out, _) = chunks(
            "Claude Code",
            r#"{"type":"assistant","message":{"content":[
                {"type":"tool_use","name":"Bash","input":{"command":"git status\ngit log","description":"look"}}]}}"#,
        );
        let (kind, label) = &out[0];
        assert_eq!(*kind, "tool");
        // The line itself says the command; the rest is the whole input, below.
        assert_eq!(label.lines().next().unwrap(), "Bash · git status…");
        assert!(label.contains("\"description\": \"look\""));
        // Classification reads the line, never the arguments under it.
        assert!(!is_edit(tool_head(label)));
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
        assert_eq!(out, [("tool", "command_execution · ls -la\nls -la".into())]);
    }
    #[cfg(unix)]
    fn live_fixture(program: &str, delivery: &str) -> Live {
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        Live {
            child,
            _control: None,
            outbound: Outbound {
                stdin: Arc::new(Mutex::new(stdin)),
                delivery: Arc::new(Mutex::new(())),
                plan: LaunchPlan {
                    program: program.into(),
                    args: vec![],
                    cwd: "/tmp".into(),
                    delivery: delivery.into(),
                    prompt: String::new(),
                    env: HashMap::new(),
                },
            },
        }
    }

    #[cfg(unix)]
    fn register(state: &mut AgentState, task: &str, live: Live) {
        let scope = Scope {
            organization_id: "org".into(),
            project_id: "project".into(),
            ticket_id: Some("ticket".into()),
            task_id: Some(task.into()),
            role: "worker".into(),
        };
        let thread = state.conversations.ensure(&scope).unwrap();
        thread.run_id = Some(format!("run-{task}"));
        thread.streaming = true;
        state.live.insert(format!("run-{task}"), live);
    }

    #[cfg(unix)]
    fn finish_fixture(live: Live) -> String {
        live.outbound.stdin.lock().unwrap().take();
        // cat exits on EOF, so this needs no sleeps or external services.
        let output = live.child.wait_with_output().unwrap();
        String::from_utf8(output.stdout).unwrap()
    }

    #[test]
    #[cfg(unix)]
    fn stdin_messages_reach_only_the_addressed_process_once() {
        let mut state = AgentState::default();
        register(&mut state, "a", live_fixture("cat", "stdin"));
        register(&mut state, "b", live_fixture("cat", "stdin"));
        for task in ["a", "b"] {
            state
                .conversations
                .0
                .get_mut(task)
                .unwrap()
                .enqueue(UserMessage {
                    id: format!("message-{task}"),
                    text: format!("hello {task}"),
                    target: None,
                })
                .unwrap();
        }
        let state = Mutex::new(state);
        // Delivery by stdin works before a CLI announces its session ID.
        deliver_messages(&state, "a", "run-a", |_| {}).unwrap();
        deliver_messages(&state, "a", "run-a", |_| {}).unwrap();
        assert!(deliver_messages(&state, "a", "run-b", |_| {}).is_err());
        {
            let state = state.lock().unwrap();
            assert_eq!(
                state.conversations.0["a"].messages[0].delivery.as_deref(),
                Some("delivered")
            );
            assert_eq!(
                state.conversations.0["b"].messages[0].delivery.as_deref(),
                Some("pending")
            );
        }
        let mut state = state.into_inner().unwrap();
        let a = finish_fixture(state.live.remove("run-a").unwrap());
        let b = finish_fixture(state.live.remove("run-b").unwrap());
        assert_eq!(a.lines().count(), 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&a).unwrap()["message"]["content"],
            "hello a"
        );
        assert!(b.is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn codex_waits_for_its_session_and_uses_the_launch_home() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("berdloop-routing-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-codex");
        std::fs::write(&script, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE\"\nprintf '%s' \"$CODEX_HOME\" > \"$CAPTURE_HOME\"\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut live = live_fixture(script.to_str().unwrap(), "argv");
        live.outbound.plan.env.insert(
            "CODEX_HOME".into(),
            dir.join("private-home").display().to_string(),
        );
        live.outbound
            .plan
            .env
            .insert("CAPTURE".into(), dir.join("args").display().to_string());
        live.outbound.plan.env.insert(
            "CAPTURE_HOME".into(),
            dir.join("home").display().to_string(),
        );
        let mut state = AgentState::default();
        register(&mut state, "a", live);
        state
            .conversations
            .0
            .get_mut("a")
            .unwrap()
            .enqueue(UserMessage {
                id: "m1".into(),
                text: "steer only A".into(),
                target: None,
            })
            .unwrap();
        let state = Mutex::new(state);
        deliver_messages(&state, "a", "run-a", |_| {}).unwrap();
        assert!(!dir.join("args").exists());
        state
            .lock()
            .unwrap()
            .conversations
            .0
            .get_mut("a")
            .unwrap()
            .session_id = Some("session-a".into());
        deliver_messages(&state, "a", "run-a", |_| {}).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("args")).unwrap(),
            "queue\n--thread\nsession-a\n--message\nsteer only A\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("home")).unwrap(),
            dir.join("private-home").display().to_string()
        );
        let mut state = state.into_inner().unwrap();
        assert_eq!(
            state.conversations.0["a"].messages[0].delivery.as_deref(),
            Some("delivered")
        );
        finish_fixture(state.live.remove("run-a").unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// `tauri dev` builds the app alone, so the helper beside it goes stale and
    /// every worker then runs rules the window has already replaced.
    #[test]
    #[cfg(debug_assertions)]
    fn a_worker_helper_older_than_its_source_is_refused() {
        let dir = std::env::temp_dir().join(format!("berdloop-helper-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let helper = dir.join("berdloop-worker");
        std::fs::write(&helper, b"\x7fELF fake binary").unwrap();

        // Set both times from the source tree, never from the clock: another
        // session editing this repo while the test runs must not fail it.
        let source = newest_source(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src")).unwrap();
        let touch = |at: std::time::SystemTime| {
            std::fs::File::options()
                .write(true)
                .open(&helper)
                .unwrap()
                .set_modified(at)
                .unwrap();
        };

        // Newer than every source file: nothing to complain about. This is the
        // ordinary case the old check got wrong, because `tauri dev` relinks the
        // app after the helper and the helper then looked stale on every build.
        touch(source + std::time::Duration::from_secs(60));
        assert!(check_worker_binary(&helper).is_ok());

        // Older than the source it was built from: refused, with the fix.
        touch(source - std::time::Duration::from_secs(60));
        let refused = check_worker_binary(&helper).unwrap_err();
        assert!(refused.contains("older than the code"), "{refused}");
        assert!(refused.contains("cargo build --bins"), "{refused}");

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_restart_puts_running_threads_back_to_work_and_leaves_finished_ones() {
        let mut book = Conversations::default();
        let mut make = |task: &str, activity: &str, streaming: bool, pgid: Option<u32>| {
            let thread = book
                .ensure(&Scope {
                    organization_id: "org".into(),
                    project_id: "p".into(),
                    role: "worker".into(),
                    ticket_id: Some("t".into()),
                    task_id: Some(task.into()),
                })
                .unwrap();
            thread.activity = activity.into();
            thread.streaming = streaming;
            thread.pgid = pgid;
            thread.session_id = Some(format!("session-{task}"));
        };
        make("cut-off", "coding", true, Some(4242));
        make("finished", "done", true, Some(4343));
        make("stopped", "paused", false, Some(4444));

        let mut stale = interrupt(&mut book);
        stale.sort();

        // Both processes the app left running are stopped, whatever they were
        // doing: nothing is reading their output any more.
        assert_eq!(stale, vec![4242, 4343]);
        // Work that was cut off is put back to work, on its own session.
        assert!(book.0["cut-off"].interrupted);
        assert!(!book.0["cut-off"].streaming);
        assert_eq!(
            book.0["cut-off"].session_id.as_deref(),
            Some("session-cut-off")
        );
        // Work that had already reported is left alone.
        assert!(!book.0["finished"].interrupted);
        assert_eq!(book.0["finished"].activity, "done");
        // A thread that was not running is not touched at all.
        assert!(!book.0["stopped"].interrupted);
        assert_eq!(book.0["stopped"].pgid, Some(4444));
    }

    #[test]
    #[cfg(unix)]
    fn failed_delivery_remains_visible_and_is_not_marked_sent() {
        let mut state = AgentState::default();
        register(&mut state, "a", live_fixture("/usr/bin/false", "argv"));
        let thread = state.conversations.0.get_mut("a").unwrap();
        thread.session_id = Some("session-a".into());
        thread
            .enqueue(UserMessage {
                id: "m".into(),
                text: "keep this message".into(),
                target: None,
            })
            .unwrap();
        let state = Mutex::new(state);
        assert!(deliver_messages(&state, "a", "run-a", |_| {}).is_err());
        let mut state = state.into_inner().unwrap();
        let message = &state.conversations.0["a"].messages[0];
        assert_eq!(message.delivery.as_deref(), Some("failed"));
        assert_eq!(message.text, "keep this message");
        finish_fixture(state.live.remove("run-a").unwrap());
    }
}
