//! The `berdloop` command, which is how a worker reaches the merge queue.
//!
//! Every coding harness can run a shell command, so this needs no per-harness
//! setup: no MCP server to configure, no port, no token. A worker finds its
//! own staging area from the directory it is standing in.
//!
//! The commands match `berdloopTools` in `packages/agent/src/tools.ts`. That
//! list is what workers are told; this is what answers them.

use std::path::PathBuf;
use std::process::ExitCode;

use berdloop_lib::git::Staging;
use berdloop_lib::human::{now_ms, Desk, Request};
use berdloop_lib::merge_queue::Queue;
use berdloop_lib::queues::{Kind, Queues};

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

    fn maybe(&self, name: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
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
        "Usage: berdloop <command> --task <task id> [...]",
        "",
        "  merge-request   Ask for a place in the merge queue.",
        "  merge-wait      Wait until it is your turn.",
        "  merge-sync      Bring the ticket branch into your worktree.",
        "  merge-land      Move the ticket branch onto your work.",
        "  merge-release   Give up your place.",
        "  ask-human       Ask a person a question and wait. --question required.",
        "  mcp             Answer the harness's permission prompts. Started by Berdloop.",
        "  task-report     Record the outcome. --status and --detail required.",
        "",
        "Queues, for a ticket agent or a task agent:",
        "",
        "  queue-show      Read a line. --kind ticket|agent-task|worker.",
        "  ticket-reorder  Set the ticket order. --order a,b,c.",
        "  task-reorder    Set a ticket's task order. --ticket and --order.",
        "",
        "An agent outside a worktree says where the project is, with",
        "--staging <path> or the BERDLOOP_STAGING environment variable.",
    ]
    .join("\n")
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

/// Where the project is, for an agent that is not standing in a worktree.
///
/// A worker is always inside its own task directory, so it needs nothing. A
/// ticket agent and a task agent are not, so they are told, by flag or by the
/// environment the app started them in.
fn staging_of(args: &Args) -> Result<Staging, String> {
    if let Some(path) = args.maybe("staging") {
        return Ok(Staging::new(PathBuf::from(path)));
    }
    if let Ok(path) = std::env::var("BERDLOOP_STAGING") {
        return Ok(Staging::new(PathBuf::from(path)));
    }
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    Staging::locate(&cwd).map(|(staging, _)| staging).ok_or_else(|| {
        "This is not a Berdloop project. Pass --staging <path>, or run from your task directory."
            .to_string()
    })
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

fn run() -> Result<String, String> {
    let args = Args::parse()?;
    if args.command == "help" || args.command == "--help" {
        return Ok(usage());
    }
    // These read and write a line. They belong to the agents above a worker,
    // which hold no worktree and no task id.
    match args.command.as_str() {
        "queue-show" => {
            let queues = Queues::new(staging_of(&args)?);
            let kind = Kind::parse(args.get("kind")?)?;
            let line = queues.line(kind, args.maybe("ticket").unwrap_or_default());
            return Ok(if line.is_empty() {
                "The line is empty.".to_string()
            } else {
                line.join("\n")
            });
        }
        "ticket-reorder" => {
            let queues = Queues::new(staging_of(&args)?);
            let order = order_of(args.get("order")?);
            queues.set(Kind::Ticket, "", &order)?;
            return Ok(format!("{} ticket(s) in line.", order.len()));
        }
        "task-reorder" => {
            let queues = Queues::new(staging_of(&args)?);
            let ticket = args.get("ticket")?;
            let order = order_of(args.get("order")?);
            queues.set(Kind::AgentTask, ticket, &order)?;
            return Ok(format!("{} task(s) in line on {ticket}.", order.len()));
        }
        _ => {}
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
            staging.commit_task(&task, &format!("Work on {task}"))?;
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

/// Read a comma separated order. Blanks are dropped, so trailing commas and
/// stray spaces from an agent are not an error.
fn order_of(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect()
}
