//! The `berdloop` command, which is how a worker reaches the merge queue.
//!
//! Every coding harness can run a shell command, so this needs no per-harness
//! setup: no MCP server to configure, no port, no token. A worker finds its
//! own staging area from the directory it is standing in.
//!
//! The commands match `berdloopTools` in `packages/agent/src/tools.ts`. That
//! list is what workers are told; this is what answers them.

use std::process::ExitCode;

use berdloop_lib::broker;
use berdloop_lib::devenv;
use berdloop_lib::git::Staging;
use berdloop_lib::human::{now_ms, Desk, Request};
use berdloop_lib::merge_queue::Queue;

/// How long `ask-human` waits for a person before giving up.
const ASK_LIMIT: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// How long `merge-wait` waits before giving up.
const WAIT_LIMIT: std::time::Duration = std::time::Duration::from_secs(20 * 60);
const POLL: std::time::Duration = std::time::Duration::from_secs(2);

fn main() -> ExitCode {
    match run() {
        Ok(message) => {
            println!("{message}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

struct Args {
    command: String,
    values: Vec<(String, String)>,
}

impl Args {
    fn parse() -> Result<Self, String> {
        let mut raw = std::env::args().skip(1);
        let command = raw.next().ok_or_else(usage)?;
        let mut values = Vec::new();
        while let Some(flag) = raw.next() {
            let name = flag
                .strip_prefix("--")
                .ok_or_else(|| format!("Expected a --flag, found {flag}."))?;
            let value = raw
                .next()
                .ok_or_else(|| format!("--{name} needs a value."))?;
            values.push((name.to_string(), value));
        }
        Ok(Self { command, values })
    }

    fn get(&self, name: &str) -> Result<&str, String> {
        self.values
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
            .ok_or_else(|| format!("--{name} is required."))
    }
}

fn usage() -> String {
    [
        "Usage: berdloop-worker <command> [--flag value ...]",
        "",
        "For a worker, run from its own task directory:",
        "",
        "  merge-request   Ask for a place in the merge queue. --task required.",
        "  merge-wait      Wait until it is your turn. --task required.",
        "  merge-sync      Bring the ticket branch into your worktree. --task required.",
        "  merge-land      Move the ticket branch onto your work. --task required.",
        "  merge-release   Give up your place. --task required.",
        "  ask-human       Ask a person a question and wait. --task and --question required.",
        "  dev-start       Start this worktree's app and print its URL. --task required.",
        "  dev-stop        Stop this worktree's app. --task required.",
        "  dev-status      Show every app Berdloop is running. --task required.",
        "  db-reset        Empty and rebuild this worktree's databases. --task required.",
        "  task-report     Record the outcome. --task, --status and --detail required.",
        "  mcp             Answer the harness's permission prompts. Started by Berdloop.",
        "",
        "For a ticket agent, a task agent or a review agent, started by Berdloop:",
        "",
        "  queue-show      Read a line. --kind ticket|agent-task|worker [--ticket].",
        "  decide          Ask typed questions about some text. --questions and",
        "                  --state or --state-file. Only when a gateway is set up.",
        "  The same six on either queue, whichever one you own:",
        "    ticket-add ticket-edit ticket-remove ticket-split ticket-merge ticket-reorder",
        "    task-add   task-edit   task-remove   task-split   task-merge   task-reorder",
        "  ticket-pause ticket-resume ticket-replan",
        "  ticket-import   Put a provider's issue on the queue. --provider and",
        "                  --reference. The connection comes from settings.",
        "  task-steer task-stop",
        "  pr-review-submit",
        "",
        "These reach the app through the private channel in BERDLOOP_CONTROL,",
        "which Berdloop sets when it starts the agent. The agent's own project",
        "and ticket are fixed by the app; they are never passed as flags.",
    ]
    .join("\n")
}

/// Ask the decision model a set of typed questions.
///
/// Prints the answers as JSON, one entry per question, each with the value and
/// a confidence from 0 to 1. The agent reads that and decides what to do with
/// it; nothing here acts on an answer.
fn decide(args: &Args) -> Result<String, String> {
    let jev = berdloop_lib::jev::Jev::from_env()
        .ok_or("Decisions are not turned on. Ask the person running Berdloop to add a gateway key in settings.")?;
    let questions: serde_json::Value = serde_json::from_str(args.get("questions")?)
        .map_err(|error| format!("--questions is not valid JSON: {error}"))?;
    if !questions.is_object() {
        return Err("--questions must be a JSON object keyed by question id.".to_string());
    }
    let state = match args.values.iter().find(|(key, _)| key == "state-file") {
        Some((_, path)) => std::fs::read_to_string(path)
            .map_err(|error| format!("Could not read {path}: {error}"))?,
        None => args
            .get("state")
            .map_err(|_| "Give --state or --state-file.".to_string())?
            .to_string(),
    };
    let answers = jev.decide(&state, &questions)?;
    if answers.is_empty() {
        return Err("The model returned no answers. Check the shape of --questions.".to_string());
    }
    let readable: serde_json::Map<String, serde_json::Value> = answers
        .into_iter()
        .map(|(id, answer)| {
            (
                id,
                serde_json::json!({
                    "value": answer.value,
                    "confidence": (answer.confidence * 100.0).round() / 100.0,
                }),
            )
        })
        .collect();
    serde_json::to_string_pretty(&readable).map_err(|error| error.to_string())
}

/// Work out where we are, which task this is, and which ticket it serves.
fn here(task: &str) -> Result<(Staging, String, Queue), String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let (staging, found) = Staging::locate(&cwd)
        .ok_or("This is not a Berdloop worktree. Run the command from your own task directory.")?;
    if found != task {
        return Err(format!(
            "This worktree belongs to task {found}, not {task}. Use your own task id."
        ));
    }
    let ticket = staging.ticket_of(task)?;
    let queue = Queue::new(staging.queue_dir(&ticket));
    Ok((staging, ticket, queue))
}

/// Refuse to touch the repository unless this worker holds the lock.
fn require_turn(queue: &Queue, task: &str) -> Result<(), String> {
    if queue.line().first().map(String::as_str) == Some(task) {
        queue.touch(task);
        return Ok(());
    }
    Err(
        "It is not your turn to merge. Call merge-request, then merge-wait, before merging."
            .to_string(),
    )
}

/// Keep the merge place alive while a git operation runs.
///
/// A holder that goes quiet for the reaping limit is assumed dead and loses
/// its turn. A long sync or land must not look like that, so this touches the
/// slot until it is dropped.
struct Heartbeat(
    Option<std::thread::JoinHandle<()>>,
    std::sync::Arc<std::sync::atomic::AtomicBool>,
);

impl Heartbeat {
    fn start(dir: std::path::PathBuf, task: String) -> Self {
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = stop.clone();
        let handle = std::thread::spawn(move || {
            let queue = Queue::new(dir);
            while !flag.load(std::sync::atomic::Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_secs(30));
                if !flag.load(std::sync::atomic::Ordering::SeqCst) {
                    queue.touch(&task);
                }
            }
        });
        Self(Some(handle), stop)
    }
}

impl Drop for Heartbeat {
    fn drop(&mut self) {
        self.1.store(true, std::sync::atomic::Ordering::SeqCst);
        // The thread wakes at most 30 seconds later and exits; nothing waits on it.
        self.0.take();
    }
}

fn run() -> Result<String, String> {
    let args = Args::parse()?;
    if args.command == "help" || args.command == "--help" {
        return Ok(usage());
    }
    // Answered here rather than through the app, because the gateway and key
    // arrive in this process's environment and nothing about a decision needs
    // the app's state. Any agent role may call it; the tool is only put in an
    // agent's orders when a gateway is set up.
    if args.command == "decide" {
        return decide(&args);
    }
    if berdloop_lib::control::COMMANDS.contains(&args.command.as_str()) {
        return berdloop_lib::control::call(berdloop_lib::control::Request {
            command: args.command,
            args: args.values.into_iter().collect(),
        });
    }

    let task = args.get("task")?.to_string();
    let (staging, ticket, queue) = here(&task)?;

    match args.command.as_str() {
        "merge-request" => {
            let slot = queue.acquire(&task)?;
            Ok(if slot.holder {
                "position 0. It is your turn. Run merge-sync now.".to_string()
            } else {
                format!(
                    "position {}. {} ahead of you. Run merge-wait.",
                    slot.position, slot.position
                )
            })
        }

        "merge-wait" => {
            queue.acquire(&task)?;
            let started = std::time::Instant::now();
            loop {
                if queue.line().first().map(String::as_str) == Some(task.as_str()) {
                    queue.touch(&task);
                    return Ok("It is your turn. Run merge-sync now.".to_string());
                }
                if started.elapsed() > WAIT_LIMIT {
                    return Err(
                        "Waited too long for a merge turn. Report the task as blocked.".to_string(),
                    );
                }
                std::thread::sleep(POLL);
            }
        }

        "merge-sync" => {
            require_turn(&queue, &task)?;
            let _alive = Heartbeat::start(staging.queue_dir(&ticket), task.clone());
            staging.commit_task(&task, &format!("Work on {task}"))?;
            let result = staging.sync_from_ticket(&ticket, &task)?;
            if result.merged {
                return Ok("Clean. Everything is committed. Run merge-land.".to_string());
            }
            Ok(format!(
                "{} file(s) conflict:\n{}\n\nFix them here, commit, then run merge-land.",
                result.conflicts.len(),
                result.conflicts.join("\n")
            ))
        }

        "merge-land" => {
            require_turn(&queue, &task)?;
            let _alive = Heartbeat::start(staging.queue_dir(&ticket), task.clone());
            staging.commit_task(&task, &format!("Work on {task}"))?;
            // Committing can take a while on a big tree. Check the turn again
            // right before the ticket branch moves, so a reaped holder cannot
            // land on top of whoever was promoted in the meantime.
            require_turn(&queue, &task)?;
            let result = staging.land(&ticket, &task)?;
            if result.merged {
                queue.release(&task);
                return Ok("Landed on the ticket branch. Your place is released.".to_string());
            }
            if !result.conflicts.is_empty() {
                return Err(format!(
                    "Still conflicted:\n{}\n\nFix them, commit, then run merge-land again.",
                    result.conflicts.join("\n")
                ));
            }
            Err(format!("{}\nRun merge-sync again.", result.detail))
        }

        "merge-release" => {
            let next = queue.release(&task);
            Ok(match next {
                Some(other) => format!("Released. {other} may merge now."),
                None => "Released. Nobody is waiting.".to_string(),
            })
        }

        // Speaks MCP on standard input, for the harness to ask before it
        // runs anything. Not called by an agent: the harness starts it.
        "mcp" => {
            berdloop_lib::mcp::serve(Desk::new(staging.root.clone()), &task, &ticket, ASK_LIMIT);
            Ok(String::new())
        }

        "ask-human" => {
            let question = args.get("question")?;
            // A command turns the question into an approval, so the interface
            // can offer Approve and Refuse rather than a text box.
            let command = args.values.iter().find(|(k, _)| k == "command");
            let id = format!("{}-{}", task, now_ms());
            let desk = Desk::new(staging.root.clone());
            desk.ask(&Request {
                id: id.clone(),
                task_id: task.clone(),
                ticket: ticket.clone(),
                kind: if command.is_some() {
                    "approval"
                } else {
                    "question"
                }
                .to_string(),
                question: question.to_string(),
                command: command.map(|(_, v)| v.clone()).unwrap_or_default(),
                at: now_ms(),
            })?;

            // Hold the merge queue place while waiting, if one is held: giving
            // it up here would mean queueing again after every question.
            let started = std::time::Instant::now();
            loop {
                if let Some(answer) = desk.answer(&id) {
                    let verdict = if command.is_some() {
                        if answer.approved {
                            "APPROVED. "
                        } else {
                            "REFUSED. "
                        }
                    } else {
                        ""
                    };
                    return Ok(format!("{verdict}{}", answer.text).trim().to_string());
                }
                if started.elapsed() > ASK_LIMIT {
                    return Err(
                        "Nobody answered. Report the task as blocked and say what you needed."
                            .to_string(),
                    );
                }
                queue.touch(&task);
                std::thread::sleep(POLL);
            }
        }

        "dev-start" => {
            let task = args.get("task")?;
            let (staging, _ticket, _queue) = here(task)?;
            let source = staging
                .source()
                .ok_or("This project's source repository could not be found.")?;
            let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
            // The agent's own environment already holds this worker's ports and
            // connection strings, put there when it was started, so the server
            // inherits exactly what the worktree is configured for.
            let env: std::collections::BTreeMap<String, String> = std::env::vars().collect();
            let server = devenv::start(&staging.root, &source, task, &cwd, &env)?;
            Ok(format!(
                "Running at {}. Log: {}. It stops on its own once you leave it alone.",
                server.url, server.log
            ))
        }
        "dev-stop" => {
            let task = args.get("task")?;
            let (staging, _ticket, _queue) = here(task)?;
            devenv::stop(&staging.root, task);
            Ok("Stopped.".to_string())
        }
        "dev-status" => {
            let task = args.get("task")?;
            let (staging, _ticket, _queue) = here(task)?;
            let running = devenv::servers(&staging.root);
            if running.is_empty() {
                return Ok("No app is running.".to_string());
            }
            Ok(running
                .iter()
                .map(|server| {
                    format!(
                        "{}{} at {}",
                        server.task,
                        if server.task == *task { " (yours)" } else { "" },
                        server.url
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "db-reset" => {
            let task = args.get("task")?;
            let (staging, _ticket, _queue) = here(task)?;
            let desk = broker::Desk::new(&staging.root);
            desk.ask(task, "reset")?;
            // Berdloop holds the database credentials, not this worker, so the
            // work is done by the app. Wait for it to say the tenant is ready
            // rather than connecting to one that is still being rebuilt.
            let before = desk.lease(task).map(|lease| lease.at).unwrap_or(0);
            let deadline = std::time::Instant::now() + broker::GRANT_LIMIT;
            while std::time::Instant::now() < deadline {
                if let Some(lease) = desk.lease(task) {
                    if lease.at > before {
                        let mut said = vec![format!(
                            "Ready. {}",
                            if lease.granted.is_empty() {
                                "This project has no databases.".to_string()
                            } else {
                                lease.granted.join("; ")
                            }
                        )];
                        said.extend(lease.notes);
                        return Ok(said.join("\n"));
                    }
                }
                std::thread::sleep(POLL);
            }
            Err("Berdloop did not rebuild the databases in time. Tell a person.".to_string())
        }
        "task-report" => {
            let status = args.get("status")?;
            if status != "complete" && status != "blocked" {
                return Err("--status must be complete or blocked.".to_string());
            }
            if status == "complete" && !staging.task_landed(&ticket, &task)? {
                return Err("The task branch has not landed on the ticket branch. Run merge-land before reporting complete.".to_string());
            }
            // A worker that stops without merging must not keep its place.
            queue.release(&task);
            staging.append_report(
                &ticket,
                &task,
                status,
                args.get("detail")?,
                &std::env::var("BERDLOOP_RUN_ID").unwrap_or_default(),
            )?;
            Ok(format!("Recorded {task} as {status}."))
        }

        other => Err(format!("Unknown command {other}.\n\n{}", usage())),
    }
}
