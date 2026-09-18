//! Running the user's app, many workers at a time, without breaking it.
//!
//! A project joins Berdloop with a dev setup built for one person: one dev
//! server on one port, one database, one `.env`. Several workers cannot share
//! that. The second `npm run dev` dies on the port, and two migrations against
//! one database step on each other.
//!
//! The fix is a slot. Every worker gets the lowest free integer, and that one
//! number decides everything else:
//!
//! ```text
//! port     = base + slot * stride        (a whole block, never one port)
//! database = <the project's name>_wt<slot>
//! compose  = <repo>-wt<slot>
//! ```
//!
//! Berdloop knows no stacks. It cannot tell Next.js from Django, and it does
//! not try. `.berd/config.json` in the project says what varies per worker, and
//! that file is the only adapter. A project with no config still works: its
//! workers simply get no ports and no dev server, and nothing else changes.
//!
//! ## What is never touched
//!
//! Setup only ever creates `.berd/`. It reads the rest of the repository and
//! writes nothing else there: no edited `.env`, no changed `docker-compose.yml`,
//! no touched source file. The user's own checkout keeps working exactly as it
//! did, on its own ports, against its own database. Slot 0 is theirs by
//! definition and is never handed out.
//!
//! Per-worker files are written into the worker's worktree, which is private to
//! Berdloop, and are hidden from git through the staging repository's own
//! `info/exclude`. The user's repository never sees them.
//!
//! ## Secrets
//!
//! A worktree starts with no `.env` at all, because git does not copy untracked
//! files into one. So the only question is what Berdloop puts there.
//!
//! A value is copied only from a file git tracks, such as `.env.example`.
//! Anything the team already committed is not a secret. Keys found only in an
//! untracked `.env` are carried over by name, and given a generated dummy
//! value. Real secrets are read for their key names and dropped on the spot;
//! they are never written to disk and never reach an agent.

use std::collections::BTreeMap;
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Where the per-worker port blocks start.
///
/// High enough to sit clear of the defaults every framework picks (3000, 5173,
/// 8000) and of the ports macOS keeps for itself (5000 and 7000 are AirPlay).
const BASE_PORT: u16 = 41000;

/// How many ports one slot owns. A stack with a web server, an API, a queue
/// dashboard and a debugger still fits inside one slot.
const STRIDE: u16 = 20;

/// Slots to try before giving up. Each is a whole block, so this is the real
/// ceiling on workers running a dev stack at once.
const MAX_SLOTS: u32 = 64;

/// Dev servers allowed to run at once, across every worker on the machine.
///
/// This is the number that keeps a laptop alive. Ten workers can be coding;
/// only this many may hold a running stack.
const DEFAULT_MAX_SERVERS: usize = 2;

/// A dev server untouched for this long is stopped.
const DEFAULT_IDLE_MINUTES: u64 = 10;

/// Env files whose values are safe to copy, if git tracks them.
const EXAMPLE_NAMES: &[&str] = &[
    ".env.example",
    ".env.sample",
    ".env.dist",
    ".env.template",
    ".env.defaults",
];

/// Env files that hold the real thing. Read for key names only, never values.
const SECRET_NAMES: &[&str] = &[".env", ".env.local", ".env.development.local"];

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/// `.berd/config.json`: what varies from one worker to the next.
///
/// Every field has a default, so a half-written config still loads and a
/// missing section simply means "this project does not have one of those".
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub version: u32,
    pub ports: Ports,
    /// Each service that binds a port. The order fixes the offsets.
    pub services: Vec<Service>,
    pub dev: Dev,
    /// The engines this project needs. Berdloop keeps one set of them for the
    /// whole project and gives each worker its own tenant inside. See
    /// `crate::broker`.
    pub resources: Vec<crate::broker::Resource>,
    pub compose: Option<Compose>,
    pub env: Env,
    pub limits: Limits,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: 1,
            ports: Ports::default(),
            services: Vec::new(),
            dev: Dev::default(),
            resources: Vec::new(),
            compose: None,
            env: Env::default(),
            limits: Limits::default(),
        }
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Ports {
    pub base: u16,
    pub stride: u16,
}

impl Default for Ports {
    fn default() -> Self {
        Self {
            base: BASE_PORT,
            stride: STRIDE,
        }
    }
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Service {
    pub name: String,
    /// The environment variable the project already reads its port from.
    pub var: String,
    /// What the port is when nobody sets that variable. Slot 0, the user's own.
    pub default: u16,
    /// Position inside the slot's block.
    pub offset: u16,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Dev {
    /// Run through the platform shell, so a pipeline or `&&` works as written.
    /// Empty means this project has no dev server and none will be started.
    pub command: String,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Compose {
    pub file: String,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Env {
    /// Files to write inside the worker's worktree, such as `.env`.
    pub files: Vec<String>,
    /// Extra values, or overrides, written into every one of those files.
    pub values: BTreeMap<String, String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Limits {
    pub servers: usize,
    pub idle_minutes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            servers: DEFAULT_MAX_SERVERS,
            idle_minutes: DEFAULT_IDLE_MINUTES,
        }
    }
}

/// Read `.berd/config.json`, if the project has one.
pub fn config_of(repo: &Path) -> Option<Config> {
    let text = std::fs::read_to_string(repo.join(".berd").join("config.json")).ok()?;
    serde_json::from_str(&text).ok()
}

// ---------------------------------------------------------------------------
// Setup: look at the project, write .berd/, change nothing else
// ---------------------------------------------------------------------------

/// What setup did, for the window to show.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    /// False when `.berd/` was already there and was left exactly as it was.
    pub created: bool,
    pub path: String,
    /// What was found, and what the user still has to fill in.
    pub notes: Vec<String>,
    pub config: Config,
}

fn git_out(repo: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Every file git tracks, so "did the team commit this?" has an exact answer.
fn tracked(repo: &Path) -> Vec<String> {
    git_out(repo, &["ls-files"])
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

/// Read `KEY=value` pairs. Quotes are stripped; `export` prefixes are allowed.
fn parse_env(text: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        pairs.push((key.to_string(), value.to_string()));
    }
    pairs
}

/// A stand-in value for a key whose real one is a secret.
///
/// Shaped by the key's name, because some clients refuse a value that does not
/// look like a credential at all, and an agent debugging that would waste its
/// task on it.
fn dummy(key: &str) -> String {
    let upper = key.to_ascii_uppercase();
    let secretish = [
        "SECRET",
        "TOKEN",
        "PASSWORD",
        "CREDENTIAL",
        "PRIVATE",
        "KEY",
    ]
    .iter()
    .any(|word| upper.contains(word));
    if secretish {
        // Distinct per key, so a project that requires two different keys does
        // not silently treat them as one.
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in key.as_bytes() {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        return format!("berdloop-dummy-{hash:016x}");
    }
    if upper.ends_with("_URL") || upper.ends_with("_URI") {
        return "http://localhost".to_string();
    }
    "berdloop-dummy".to_string()
}

/// The dev command a project most likely uses, from what it carries.
///
/// A guess, written into the config for a person to correct. Berdloop never
/// acts on the guess directly, which is why a wrong one is harmless.
fn guess_dev(repo: &Path) -> (String, Vec<Service>) {
    let package = std::fs::read_to_string(repo.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    if let Some(package) = package {
        let scripts = &package["scripts"];
        let runner = ["bun.lock", "pnpm-lock.yaml", "yarn.lock"]
            .iter()
            .find(|file| repo.join(file).exists())
            .map(|file| match *file {
                "bun.lock" => "bun run",
                "pnpm-lock.yaml" => "pnpm",
                _ => "yarn",
            })
            .unwrap_or("npm run");
        for name in ["dev", "start", "serve"] {
            if scripts[name].is_string() {
                let default = if scripts[name].as_str().unwrap_or_default().contains("vite") {
                    5173
                } else {
                    3000
                };
                return (
                    format!("{runner} {name}"),
                    vec![Service {
                        name: "web".into(),
                        var: "PORT".into(),
                        default,
                        offset: 0,
                    }],
                );
            }
        }
    }
    if repo.join("manage.py").exists() {
        // Django reads the port from the argument, not the environment, so the
        // command has to carry it.
        return (
            "python manage.py runserver 0.0.0.0:$PORT".into(),
            vec![Service {
                name: "web".into(),
                var: "PORT".into(),
                default: 8000,
                offset: 0,
            }],
        );
    }
    for (file, command, port) in [
        ("Gemfile", "bundle exec rails server -p $PORT", 3000u16),
        ("go.mod", "go run .", 8080),
        ("Cargo.toml", "cargo run", 8080),
    ] {
        if repo.join(file).exists() {
            return (
                command.into(),
                vec![Service {
                    name: "web".into(),
                    var: "PORT".into(),
                    default: port,
                    offset: 0,
                }],
            );
        }
    }
    (String::new(), Vec::new())
}

/// Which engine a connection string belongs to.
///
/// Read from the scheme, which is the one part of a connection string that is
/// never secret. That matters: it lets Berdloop recognise a database in an
/// untracked `.env` without copying anything out of it.
fn engine_of(url: &str) -> Option<String> {
    if !url.contains("://") {
        return None;
    }
    let scheme = url.split("://").next()?.to_ascii_lowercase();
    Some(match scheme.as_str() {
        "postgres" | "postgresql" => "postgres".to_string(),
        "mysql" | "mariadb" => "mysql".to_string(),
        "mongodb" | "mongodb+srv" => "mongodb".to_string(),
        "redis" | "rediss" => "redis".to_string(),
        "sqlite" | "file" => "sqlite".to_string(),
        // Something else entirely. Berdloop has no commands for it, so the
        // project supplies them; the name is still worth carrying.
        other if !other.is_empty() => other.to_string(),
        _ => return None,
    })
}

/// Does this variable name look like it holds a connection string?
fn is_resource_var(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    ["_URL", "_URI", "_DSN"]
        .iter()
        .any(|suffix| upper.ends_with(suffix))
        && [
            "DATABASE", "DB", "MONGO", "REDIS", "MYSQL", "POSTGRES", "PG", "DUCK", "SQLITE",
            "CACHE",
        ]
        .iter()
        .any(|word| upper.contains(word))
}

/// Look at a project and propose a config. Nothing is written by this.
///
/// The second value is the admin connection string for each resource. It is
/// kept apart from the config on purpose: the config is committed to the user's
/// repository, and a connection string may carry a password. Only the caller
/// that stores it in the app's own data directory ever sees it.
pub fn detect(repo: &Path) -> (Config, crate::broker::Admin, Vec<String>) {
    let mut notes = Vec::new();
    let mut config = Config::default();

    let (command, services) = guess_dev(repo);
    if command.is_empty() {
        notes.push(
            "No dev server was recognised. Workers will still get their own ports and database; fill in `dev.command` in .berd/config.json to let them run the app."
                .into(),
        );
    } else {
        notes.push(format!(
            "Dev command guessed as `{command}`. Correct it in .berd/config.json if that is wrong."
        ));
    }
    config.dev.command = command;
    config.services = services;

    let files = tracked(repo);

    // Values may be copied only from a file the team has committed.
    let examples: Vec<&String> = files
        .iter()
        .filter(|path| {
            let name = path.rsplit('/').next().unwrap_or(path);
            EXAMPLE_NAMES.contains(&name)
        })
        .collect();
    let mut safe: BTreeMap<String, String> = BTreeMap::new();
    for example in &examples {
        if let Ok(text) = std::fs::read_to_string(repo.join(example)) {
            safe.extend(parse_env(&text));
        }
        // An example at `apps/api/.env.example` means `apps/api/.env`.
        let target = example.trim_end_matches(|c| c != '/').to_string() + ".env";
        if !config.env.files.contains(&target) {
            config.env.files.push(target);
        }
    }
    if config.env.files.is_empty() {
        config.env.files.push(".env".into());
    }

    // Keys the user has locally but never committed. The names travel; the
    // values are read here, used to decide nothing, and dropped.
    let mut dummies: BTreeMap<String, String> = BTreeMap::new();
    for name in SECRET_NAMES {
        let path = repo.join(name);
        if !path.exists() || files.iter().any(|tracked| tracked == name) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        for (key, _real) in parse_env(&text) {
            if safe.contains_key(&key) || key.to_ascii_uppercase().contains("PORT") {
                continue;
            }
            dummies.insert(key.clone(), dummy(&key));
        }
    }
    if !dummies.is_empty() {
        notes.push(format!(
            "{} key(s) in your untracked env files were carried over with generated dummy values. Your real values were never copied and never reach an agent.",
            dummies.len()
        ));
    }

    // Engines. A project often has more than one: Postgres and Redis, or
    // Postgres and Mongo, or all three. Each becomes a resource the broker
    // hands out tenants in.
    //
    // A connection string is recognised by its scheme, which is never the
    // secret part. So a database configured only in an untracked `.env` is
    // still found, and still gets one tenant per worker, without its password
    // ever being copied into the committed config: the value is looked up
    // again, in the app, when a worker is provisioned.
    let mut engines: BTreeMap<String, (String, String, bool)> = BTreeMap::new();
    for (key, value) in &safe {
        if !is_resource_var(key) {
            continue;
        }
        if let Some(engine) = engine_of(value) {
            engines.insert(key.clone(), (engine, value.clone(), true));
        }
    }
    for name in SECRET_NAMES {
        let path = repo.join(name);
        if !path.exists() || files.iter().any(|tracked| tracked == name) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        for (key, value) in parse_env(&text) {
            if engines.contains_key(&key) || !is_resource_var(&key) {
                continue;
            }
            if let Some(engine) = engine_of(&value) {
                // The scheme goes in the committed config. The value goes only
                // to the caller, which stores it outside the repository.
                engines.insert(key, (engine, value, false));
            }
        }
    }

    let mut admin = crate::broker::Admin::new();
    let mut needs_details = Vec::new();
    for (var, (engine, url, from_example)) in &engines {
        let name = var
            .to_ascii_lowercase()
            .trim_end_matches("_url")
            .trim_end_matches("_uri")
            .trim_end_matches("_dsn")
            .to_string();
        if !from_example {
            needs_details.push(var.clone());
        }
        if !matches!(
            engine.as_str(),
            "postgres" | "mysql" | "mongodb" | "redis" | "sqlite" | "duckdb"
        ) {
            notes.push(format!(
                "`{engine}` has no built-in commands. Fill in `create` and `drop` for the `{name}` resource in .berd/config.json."
            ));
        }
        if !url.is_empty() {
            admin.insert(name.clone(), url.clone());
        }
        config.resources.push(crate::broker::Resource {
            name,
            engine: engine.clone(),
            var: var.clone(),
            // Left empty so the broker picks the right default per engine.
            tenancy: String::new(),
            // Empty on purpose: an engine already running is left alone.
            start: String::new(),
            ready: String::new(),
            create: Vec::new(),
            drop: Vec::new(),
            migrate: Vec::new(),
            seed: Vec::new(),
        });
    }
    if !config.resources.is_empty() {
        notes.push(format!(
            "Found {} engine(s): {}. Each worker gets its own tenant inside your existing servers, so nothing new is started. Add your migration command to each resource's `migrate`, or a worker's database will be empty.",
            config.resources.len(),
            config
                .resources
                .iter()
                .map(|r| format!("{} ({})", r.name, r.engine))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !needs_details.is_empty() {
        notes.push(format!(
            "The connection details for {} came from an untracked file. They are stored in Berdloop, outside the repository and outside every worktree, so they are not committed and no agent is given them. Check them in the project's settings.",
            needs_details.join(", ")
        ));
    }

    config.env.values = safe
        .iter()
        // Ports and connection strings are decided per worker, not copied.
        .filter(|(key, _)| {
            !key.to_ascii_uppercase().contains("PORT") && !engines.contains_key(*key)
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .chain(
            dummies
                .into_iter()
                .filter(|(key, _)| !engines.contains_key(key)),
        )
        .collect();

    for file in ["docker-compose.yml", "docker-compose.yaml", "compose.yml"] {
        if repo.join(file).exists() {
            config.compose = Some(Compose { file: file.into() });
            notes.push(
                "A compose file was found. Each worker gets its own COMPOSE_PROJECT_NAME. Host ports in that file must read from the environment, for example `\"${PORT:-3000}:3000\"`, or the containers will still collide."
                    .into(),
            );
            break;
        }
    }

    (config, admin, notes)
}

const README: &str = r#"# .berd/

Berdloop runs several agents on this project at once. Each one gets its own
copy of the repository, so their files never collide. This directory is how
they avoid colliding on everything else: ports, databases and env files.

**Nothing outside this directory was changed.** Your own setup still runs
exactly as it did, on its normal ports, against your normal database. Slot 0 is
yours and is never given to a worker.

## config.json

| Field | What it decides |
| --- | --- |
| `ports` | Where the per-worker port blocks start, and how wide each is. |
| `services` | Each thing that binds a port, and the variable it reads. |
| `dev.command` | How to start the app. Run with the worker's own ports. |
| `resources` | The databases and caches, and how each worker gets its own. |
| `compose` | Set only if you use Docker. Most projects do not need it. |
| `env` | Which env files to write in a worker's copy, and what goes in them. |
| `limits` | How many apps may run at once, and when an idle one stops. |

Every field may be left out. A project with no `dev.command` simply never has
an app started for it. A project with no `resources` gets ports and nothing
else. Neither case is an error.

## Ports

Each worker holds a slot, which is a small number. A port is
`base + slot * stride + offset`, so it is the same every time and two workers
can never be given the same one.

Berdloop checks the whole block binds before it hands it over. If something
else holds a port in it, the worker moves to the next free block. A single port
is never moved on its own, because then nothing else would know where it went.

## Databases

Engines are a tier above the app. Berdloop does not start one per worker: it
uses the servers you already have and gives each worker its own database inside
them.

```
  your postgres, your redis, your mongo      one set, shared
            |            |          |
       app_wt1       wt1:*      docs_wt1     one tenant per worker
```

A project may declare as many resources as it needs. Postgres and Redis, or
Postgres and Mongo and DuckDB, are all ordinary. Each one says how a worker is
kept apart:

| `tenancy` | What each worker gets | Good for |
| --- | --- | --- |
| `database` | Its own database on your server. | Postgres, MySQL, Mongo |
| `schema` | Its own schema in one database. | Postgres |
| `prefix` | Its own key prefix. | Redis |
| `file` | Its own file. | SQLite, DuckDB |
| `none` | Nothing. The engine is shared. | A read-only engine |

**Docker is not required and is never assumed.** A Postgres installed with
Homebrew, or a server you start yourself, is the normal case: leave `start`
empty and Berdloop will probe it, find it running, and leave it alone. Set
`start` only for an engine you want Berdloop to bring up.

**Add your migration command** to each resource's `migrate`, and any fixtures
to `seed`. Without them a worker's database is empty, which is rarely what you
want. They run in the worker's own copy, with its own connection strings, after
its database exists.

Berdloop never copies your database. PostgreSQL refuses to copy one while
anything is connected to it, and the thing connected is usually your own app;
making that work would mean closing your connections. An empty database plus
your migrations is slower to build and always correct.

### Connection details

Berdloop keeps the admin connection string for each engine in its own data
directory, not here and not in any worker's copy. This file is committed, so a
password must never be written into it, and a worker that could make its own
database would need credentials an agent would then read.

Change them in the project's settings, not in this file.

## Secrets

Berdloop copies a value into a worker only from a file git tracks, such as
`.env.example`. Anything your team already committed is not a secret.

Keys it finds only in your untracked `.env` are carried over **by name**, with
a generated stand-in value. Your real values are never copied into a worker and
never reach an agent.

If a task genuinely needs a real credential, put it in `env.values` yourself,
and know that the agent will be able to read it.

## Config files that are not env files

Some projects keep ports and database names in `config/database.yml`,
`application.yml` or `appsettings.json` rather than the environment. Berdloop
does not edit files like that, because editing them is a code change.

Use the escape hatch instead: if `.berd/dev` exists and is executable, Berdloop
runs it in place of `dev.command`, with the worker's environment. Render or
patch whatever your stack needs at the top of that script, reading `$PORT` and
the connection strings from the environment, then start the app.

## If you use Docker

Set `compose.file` and each worker gets its own `COMPOSE_PROJECT_NAME`, so
containers, networks and volumes never collide. Host ports in that file must
read from the environment:

```yaml
services:
  web:
    ports:
      - "${PORT:-3000}:3000"
```

A fixed host port, a `container_name:` or `network_mode: host` will still
collide, whatever Berdloop does.
"#;

/// Create `.berd/` for a project, or report that it already has one.
///
/// Runs once, when a project is added. Nothing outside `.berd/` is written, and
/// an existing `.berd/` is never overwritten: the user may have edited it, and
/// their version is the one that is right.
pub fn setup(repo: &Path) -> Result<(Setup, crate::broker::Admin), String> {
    let dir = repo.join(".berd");
    let config_path = dir.join("config.json");
    if config_path.exists() {
        let config = config_of(repo).ok_or(".berd/config.json could not be read as JSON.")?;
        return Ok((
            Setup {
                created: false,
                path: dir.to_string_lossy().into_owned(),
                notes: vec!["This project already has .berd/. It was left as it is.".into()],
                config,
            },
            crate::broker::Admin::new(),
        ));
    }
    if !repo.is_dir() {
        return Err("That project folder does not exist.".into());
    }
    let (config, admin, notes) = detect(repo);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, text + "\n").map_err(|e| e.to_string())?;
    std::fs::write(dir.join("README.md"), README).map_err(|e| e.to_string())?;
    let mut notes = notes;
    // A hidden directory is easy to ignore by accident: a rule as broad as
    // `.*` sweeps it up. Worktrees are populated from committed files only, so
    // an ignored `.berd/` would never reach a worker and nothing would say why.
    if git_out(repo, &["check-ignore", "-q", ".berd"]).is_some() {
        notes.insert(
            0,
            "This project's .gitignore ignores .berd/. Workers are given committed files only, so they would never see it. Add an exception, such as `!.berd/`, then commit the directory."
                .into(),
        );
    }
    Ok((
        Setup {
            created: true,
            path: dir.to_string_lossy().into_owned(),
            notes,
            config,
        },
        admin,
    ))
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/// The slot book, kept beside the staging repository.
///
/// It is a file and not memory because the workers that read it are separate
/// processes, and it has to survive the window being closed.
struct Slots {
    dir: PathBuf,
}

impl Slots {
    fn new(root: &Path) -> Self {
        Self {
            dir: root.join("dev"),
        }
    }

    fn file(&self) -> PathBuf {
        self.dir.join("slots.json")
    }

    fn lock(&self) -> Result<std::fs::File, String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.dir.join("slots.lock"))
            .map_err(|e| e.to_string())?;
        file.lock().map_err(|e| e.to_string())?;
        Ok(file)
    }

    fn read(&self) -> BTreeMap<String, u32> {
        std::fs::read_to_string(self.file())
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// Give this task a slot, or hand back the one it already holds.
    ///
    /// Slot 0 is the user's own checkout and is never given out. A slot whose
    /// port block is already busy is skipped, so a worker is never handed a
    /// port it cannot bind.
    fn claim(&self, task: &str, ports: &Ports) -> Result<u32, String> {
        let _lock = self.lock()?;
        let mut book = self.read();
        if let Some(slot) = book.get(task) {
            return Ok(*slot);
        }
        let taken: Vec<u32> = book.values().copied().collect();
        let slot = (1..=MAX_SLOTS)
            .find(|slot| !taken.contains(slot) && block_is_free(ports, *slot))
            .ok_or(
                "Every port block is in use. Close a task, or widen `ports` in .berd/config.json.",
            )?;
        book.insert(task.to_string(), slot);
        self.write(&book)?;
        Ok(slot)
    }

    fn release(&self, task: &str) {
        let Ok(_lock) = self.lock() else { return };
        let mut book = self.read();
        if book.remove(task).is_some() {
            let _ = self.write(&book);
        }
    }

    fn write(&self, book: &BTreeMap<String, u32>) -> Result<(), String> {
        let text = serde_json::to_string_pretty(book).map_err(|e| e.to_string())?;
        let temp = self.file().with_extension("tmp");
        std::fs::write(&temp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, self.file()).map_err(|e| e.to_string())
    }
}

/// Can this port be bound right now?
fn port_is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// A slot is only free when every port in its block is.
///
/// Whole blocks move together. Walking one port at a time would leave a service
/// on a number nothing else knows, and an agent would then hard-code it.
fn block_is_free(ports: &Ports, slot: u32) -> bool {
    let start = ports.base as u32 + slot * ports.stride as u32;
    if start + ports.stride as u32 > u16::MAX as u32 {
        return false;
    }
    (0..ports.stride).all(|offset| port_is_free(start as u16 + offset))
}

fn port_for(ports: &Ports, slot: u32, offset: u16) -> u16 {
    (ports.base as u32 + slot * ports.stride as u32 + offset as u32) as u16
}

// ---------------------------------------------------------------------------
// Provisioning one worker
// ---------------------------------------------------------------------------

/// What one worker was given.
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provision {
    pub slot: u32,
    /// Handed to the agent's process, and written into the worktree's env files.
    pub env: BTreeMap<String, String>,
    pub notes: Vec<String>,
}

/// Run one configured command, through the platform shell.
fn shell(command: &str, dir: &Path, env: &BTreeMap<String, String>) -> (bool, String) {
    let mut process = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(command);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(command);
        c
    };
    match process.current_dir(dir).envs(env).output() {
        Ok(out) => (
            out.status.success(),
            format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            )
            .trim()
            .to_string(),
        ),
        Err(error) => (false, format!("{command} could not run: {error}")),
    }
}

/// Keep a generated file out of git, without touching the user's repository.
///
/// The staging repository belongs to Berdloop alone, so its `info/exclude` is
/// free to write. The user's own `.gitignore` is never edited.
fn exclude(staging_root: &Path, paths: &[String]) {
    let file = staging_root
        .join("staging.git")
        .join("info")
        .join("exclude");
    let Some(parent) = file.parent() else { return };
    let _ = std::fs::create_dir_all(parent);
    let existing = std::fs::read_to_string(&file).unwrap_or_default();
    let missing: Vec<&String> = paths
        .iter()
        .filter(|path| !existing.lines().any(|line| line.trim() == path.as_str()))
        .collect();
    if missing.is_empty() {
        return;
    }
    if let Ok(mut handle) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
    {
        let _ = writeln!(handle, "# written by Berdloop, per worker");
        for path in missing {
            let _ = writeln!(handle, "{path}");
        }
    }
}

/// Give one worker its ports, its tenants and its env files.
///
/// Called once, when the worktree is made. A project with no `.berd/config.json`
/// gets an empty provision and is completely unaffected: no ports, no database,
/// no files written, nothing changed.
///
/// The order matters. Ports are settled first, so an engine that is down still
/// leaves the worker with a usable worktree. The env files are written last,
/// because they have to carry the connection strings the broker just handed
/// back. Migrations run after that, against a tenant that exists and an env
/// that is on disk, which is what every framework expects.
pub fn provision(
    staging_root: &Path,
    source_repo: &Path,
    task_id: &str,
    worktree: &Path,
    admin: &crate::broker::Admin,
) -> Provision {
    let Some(config) = config_of(source_repo) else {
        return Provision::default();
    };
    let mut out = Provision::default();
    let slots = Slots::new(staging_root);
    let slot = match slots.claim(task_id, &config.ports) {
        Ok(slot) => slot,
        Err(error) => {
            out.notes.push(error);
            return out;
        }
    };
    out.slot = slot;
    out.env.insert("BERDLOOP_SLOT".into(), slot.to_string());

    for service in &config.services {
        let port = port_for(&config.ports, slot, service.offset);
        if !service.var.is_empty() {
            out.env.insert(service.var.clone(), port.to_string());
        }
        out.env.insert(
            format!("BERDLOOP_PORT_{}", service.name.to_ascii_uppercase()),
            port.to_string(),
        );
    }

    if config.compose.is_some() {
        let repo = source_repo
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("app");
        out.env
            .insert("COMPOSE_PROJECT_NAME".into(), format!("{repo}-wt{slot}"));
    }

    // The broker owns the engines and the admin credentials. It gives back the
    // connection strings for this worktree's tenants, and nothing more.
    let mut base = config.env.values.clone();
    base.extend(out.env.clone());
    let lease = crate::broker::grant(
        crate::broker::Worker {
            staging_root,
            worktree,
            task: task_id,
            slot,
        },
        &config.resources,
        admin,
        &base,
        false,
    );
    out.notes.extend(lease.notes.clone());
    out.env.extend(
        lease
            .env
            .iter()
            .filter(|(key, _)| !config.env.values.contains_key(*key))
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    let values = lease.env;

    let mut written = Vec::new();
    for file in &config.env.files {
        let path = worktree.join(file);
        if path.exists() {
            // Committed to the repository. Overwriting it would be a code
            // change, which this module never makes.
            out.notes.push(format!(
                "{file} is committed, so it was left alone. This worker's ports and database are in its environment instead."
            ));
            continue;
        }
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut text = String::from("# Written by Berdloop for this worker. Not committed.\n");
        for (key, value) in &values {
            text.push_str(&format!("{key}={value}\n"));
        }
        match std::fs::write(&path, text) {
            Ok(()) => written.push(file.clone()),
            Err(error) => out.notes.push(format!("Could not write {file}: {error}")),
        }
    }
    exclude(staging_root, &written);
    out
}

/// Give back everything one worker held: its dev server, its tenants, its slot.
pub fn release(
    staging_root: &Path,
    source_repo: &Path,
    task_id: &str,
    admin: &crate::broker::Admin,
) {
    stop(staging_root, task_id);
    let slots = Slots::new(staging_root);
    let Some(config) = config_of(source_repo) else {
        slots.release(task_id);
        return;
    };
    let slot = slots.read().get(task_id).copied();
    if let Some(slot) = slot {
        crate::broker::revoke(staging_root, &config.resources, admin, task_id, slot);
        if config.compose.is_some() {
            let repo = source_repo
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("app");
            shell(
                &format!("docker compose -p {repo}-wt{slot} down -v --remove-orphans"),
                staging_root,
                &BTreeMap::new(),
            );
        }
    }
    slots.release(task_id);
}

/// The slot a task holds, if it has one.
pub fn slot_of(staging_root: &Path, task_id: &str) -> Option<u32> {
    Slots::new(staging_root).read().get(task_id).copied()
}

/// Answer the workers waiting on the broker.
///
/// Called on the app's tick. A worker that wants a clean database writes a
/// request and waits; this is what turns that request into a lease. It runs in
/// the app because that is where the admin credentials are, and keeping them
/// there is the whole reason the broker exists.
pub fn serve_requests(
    staging_root: &Path,
    source_repo: &Path,
    admin: &crate::broker::Admin,
) -> Vec<String> {
    let Some(config) = config_of(source_repo) else {
        return Vec::new();
    };
    let desk = crate::broker::Desk::new(staging_root);
    let mut log = Vec::new();
    for ask in desk.pending() {
        let Some(slot) = slot_of(staging_root, &ask.task) else {
            log.push(format!(
                "{}: asked for resources but holds no slot.",
                ask.task
            ));
            continue;
        };
        let worktree = staging_root.join("work").join(file_safe(&ask.task));
        let mut base = config.env.values.clone();
        base.insert("BERDLOOP_SLOT".into(), slot.to_string());
        for service in &config.services {
            let port = port_for(&config.ports, slot, service.offset);
            if !service.var.is_empty() {
                base.insert(service.var.clone(), port.to_string());
            }
        }
        let lease = crate::broker::grant(
            crate::broker::Worker {
                staging_root,
                worktree: &worktree,
                task: &ask.task,
                slot,
            },
            &config.resources,
            admin,
            &base,
            ask.kind == "reset",
        );
        log.push(format!(
            "{}: {} ({} resource(s)).",
            ask.task,
            if ask.kind == "reset" {
                "reset"
            } else {
                "granted"
            },
            lease.granted.len()
        ));
        log.extend(lease.notes);
    }
    log
}

// ---------------------------------------------------------------------------
// Dev servers: started when asked, stopped when idle, capped in number
// ---------------------------------------------------------------------------

/// One running dev server, as recorded on disk.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub task: String,
    pub pid: u32,
    pub url: String,
    pub log: String,
    /// Milliseconds since the epoch, refreshed every time a worker asks for it.
    pub used: u64,
}

fn dev_dir(root: &Path) -> PathBuf {
    root.join("dev")
}

fn dev_lock(root: &Path) -> Result<std::fs::File, String> {
    let dir = dev_dir(root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("servers.lock"))
        .map_err(|e| e.to_string())?;
    file.lock().map_err(|e| e.to_string())?;
    Ok(file)
}

fn servers_file(root: &Path) -> PathBuf {
    dev_dir(root).join("servers.json")
}

fn read_servers(root: &Path) -> Vec<Server> {
    std::fs::read_to_string(servers_file(root))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_servers(root: &Path, servers: &[Server]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(servers).map_err(|e| e.to_string())?;
    let temp = servers_file(root).with_extension("tmp");
    std::fs::write(&temp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, servers_file(root)).map_err(|e| e.to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// Is this process still there?
fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // Signal 0 checks for the process without disturbing it.
        unsafe { libc_kill(pid as i32, 0) == 0 }
    }
    #[cfg(not(unix))]
    {
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}

#[cfg(unix)]
unsafe fn libc_kill(pid: i32, signal: i32) -> i32 {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe { kill(pid, signal) }
}

/// Stop a whole process group, so the dev server's own children go with it.
fn kill_group(pid: u32) {
    #[cfg(unix)]
    unsafe {
        // The server was started in its own group, so its id is the group id.
        libc_kill(-(pid as i32), 15);
    }
    #[cfg(not(unix))]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
}

/// Drop servers that died, and stop the ones nobody has used for a while.
fn reap_locked(servers: &mut Vec<Server>, idle_minutes: u64) {
    let cutoff = now_ms().saturating_sub(idle_minutes * 60 * 1000);
    servers.retain(|server| {
        if !alive(server.pid) {
            return false;
        }
        if server.used < cutoff {
            kill_group(server.pid);
            return false;
        }
        true
    });
}

/// Stop anything held for a task that is finished.
pub fn stop(root: &Path, task: &str) {
    let Ok(_lock) = dev_lock(root) else { return };
    let mut servers = read_servers(root);
    servers.retain(|server| {
        if server.task == task {
            kill_group(server.pid);
            return false;
        }
        true
    });
    let _ = write_servers(root, &servers);
}

/// Every dev server running right now, with the default idle limit.
pub fn servers(root: &Path) -> Vec<Server> {
    status(root, DEFAULT_IDLE_MINUTES)
}

/// Every dev server running right now, after clearing out the dead ones.
pub fn status(root: &Path, idle_minutes: u64) -> Vec<Server> {
    let Ok(_lock) = dev_lock(root) else {
        return Vec::new();
    };
    let mut servers = read_servers(root);
    reap_locked(&mut servers, idle_minutes);
    let _ = write_servers(root, &servers);
    servers
}

/// Start this worker's dev server, or hand back the one already running.
///
/// Nothing is started when a worker's task begins. Most of a task is reading
/// and editing, and a stack started for every worker would use the machine's
/// memory on servers nobody ever opens. The server appears the first time an
/// agent actually asks for it.
///
/// When the cap is reached the oldest unused server is stopped to make room,
/// so a worker waits a moment instead of the machine swapping.
pub fn start(
    root: &Path,
    source_repo: &Path,
    task: &str,
    worktree: &Path,
    env: &BTreeMap<String, String>,
) -> Result<Server, String> {
    let config = config_of(source_repo)
        .ok_or("This project has no .berd/config.json, so Berdloop cannot start it. Run the app yourself if you need it.")?;
    let script = worktree.join(".berd").join("dev");
    let has_script = is_executable(&script);
    if config.dev.command.is_empty() && !has_script {
        return Err(
            "No dev command is set for this project. Add `dev.command` to .berd/config.json."
                .into(),
        );
    }

    let _lock = dev_lock(root)?;
    let mut servers = read_servers(root);
    reap_locked(&mut servers, config.limits.idle_minutes);

    if let Some(existing) = servers.iter_mut().find(|server| server.task == task) {
        existing.used = now_ms();
        let found = existing.clone();
        let _ = write_servers(root, &servers);
        return Ok(found);
    }

    // Make room. The least recently used one goes, because whoever owns it has
    // not looked at it for the longest.
    while servers.len() >= config.limits.servers.max(1) {
        let Some(oldest) = servers
            .iter()
            .enumerate()
            .min_by_key(|(_, server)| server.used)
            .map(|(index, _)| index)
        else {
            break;
        };
        kill_group(servers[oldest].pid);
        servers.remove(oldest);
    }

    let port = config
        .services
        .first()
        .map(|service| {
            env.get(&service.var)
                .and_then(|value| value.parse().ok())
                .unwrap_or(service.default)
        })
        .unwrap_or(0);

    let log_path = dev_dir(root).join(format!("{}.log", file_safe(task)));
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let errors = log.try_clone().map_err(|e| e.to_string())?;

    let mut command = if has_script {
        Command::new(&script)
    } else if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&config.dev.command);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(&config.dev.command);
        c
    };
    command
        .current_dir(worktree)
        .envs(env)
        .env("BERDLOOP", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(errors));
    // Its own process group: the agent that asked for this server is stopped
    // between turns, and the server has to outlive that. It also means one
    // signal stops the server and everything it spawned.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);

    let child = command
        .spawn()
        .map_err(|error| format!("Could not start the dev server: {error}"))?;
    let server = Server {
        task: task.to_string(),
        pid: child.id(),
        url: format!("http://localhost:{port}"),
        log: log_path.to_string_lossy().into_owned(),
        used: now_ms(),
    };
    servers.push(server.clone());
    write_servers(root, &servers)?;
    Ok(server)
}

fn file_safe(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.exists()
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Set a project up for parallel workers. Safe to call on a project that is
/// already set up: it reports what is there and changes nothing.
#[tauri::command]
pub fn devenv_setup(
    app: tauri::AppHandle,
    project_id: String,
    path: String,
) -> Result<Setup, String> {
    let (report, admin) = setup(Path::new(path.trim()))?;
    if !admin.is_empty() {
        // Connection strings go to the app's own data directory, never to the
        // repository and never to a worktree.
        let data = tauri::Manager::path(&app)
            .app_data_dir()
            .map_err(|_| "Could not find the app data directory.".to_string())?;
        let mut stored = crate::broker::read_admin(&data, &project_id);
        for (name, url) in admin {
            stored.entry(name).or_insert(url);
        }
        crate::broker::write_admin(&data, &project_id, &stored)?;
    }
    Ok(report)
}

/// What setup would propose, without writing anything.
#[tauri::command]
pub fn devenv_preview(path: String) -> Result<Setup, String> {
    let repo = PathBuf::from(path.trim());
    let (config, _admin, notes) = detect(&repo);
    Ok(Setup {
        created: false,
        path: repo.join(".berd").to_string_lossy().into_owned(),
        notes,
        config,
    })
}

/// Answer any worker waiting on the broker. Called on the app's tick.
#[tauri::command]
pub fn devenv_serve(app: tauri::AppHandle, project_id: String) -> Result<Vec<String>, String> {
    let staging = crate::git::staging_for(&app, &project_id)?;
    let Some(source) = staging.source() else {
        return Ok(Vec::new());
    };
    let data = tauri::Manager::path(&app)
        .app_data_dir()
        .map_err(|_| "Could not find the app data directory.".to_string())?;
    let admin = crate::broker::read_admin(&data, &project_id);
    Ok(serve_requests(&staging.root, &source, &admin))
}

/// Every dev server running for one project, for the window to show.
#[tauri::command]
pub fn devenv_servers(app: tauri::AppHandle, project_id: String) -> Result<Vec<Server>, String> {
    let staging = crate::git::staging_for(&app, &project_id)?;
    Ok(status(&staging.root, DEFAULT_IDLE_MINUTES))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slot_owns_a_whole_block_of_ports() {
        let ports = Ports {
            base: 41000,
            stride: 20,
        };
        assert_eq!(port_for(&ports, 1, 0), 41020);
        assert_eq!(port_for(&ports, 1, 3), 41023);
        assert_eq!(port_for(&ports, 2, 0), 41040);
        // Blocks never overlap, which is the whole point of the stride.
        assert!(port_for(&ports, 1, ports.stride - 1) < port_for(&ports, 2, 0));
    }

    #[test]
    fn a_secret_key_gets_a_dummy_and_two_keys_never_share_one() {
        assert!(dummy("STRIPE_SECRET_KEY").starts_with("berdloop-dummy-"));
        assert_ne!(dummy("STRIPE_SECRET_KEY"), dummy("OPENAI_API_KEY"));
        assert_eq!(dummy("API_URL"), "http://localhost");
        assert_eq!(dummy("NODE_ENV"), "berdloop-dummy");
    }

    #[test]
    fn env_files_parse_the_shapes_people_actually_write() {
        let pairs =
            parse_env("# a comment\nexport A=1\nB=\"two\"\nC='three'\n\nBAD LINE\nD=with=equals\n");
        assert_eq!(
            pairs,
            vec![
                ("A".into(), "1".into()),
                ("B".into(), "two".into()),
                ("C".into(), "three".into()),
                ("D".into(), "with=equals".into()),
            ]
        );
    }

    #[test]
    fn a_project_with_nothing_recognisable_still_gets_a_working_config() {
        let dir = std::env::temp_dir().join(format!("berd-empty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (config, _admin, notes) = detect(&dir);
        assert!(config.dev.command.is_empty());
        assert!(config.resources.is_empty());
        // Still writes somewhere, so a project can be given values by hand.
        assert_eq!(config.env.files, vec![".env".to_string()]);
        assert!(notes.iter().any(|note| note.contains("No dev server")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn setup_never_overwrites_a_config_the_user_has_edited() {
        let dir = std::env::temp_dir().join(format!("berd-keep-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".berd")).unwrap();
        std::fs::write(
            dir.join(".berd").join("config.json"),
            r#"{"version":1,"dev":{"command":"mine"}}"#,
        )
        .unwrap();
        let (result, _admin) = setup(&dir).unwrap();
        assert!(!result.created);
        assert_eq!(result.config.dev.command, "mine");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn secret_values_are_never_copied_but_their_keys_are() {
        let dir = std::env::temp_dir().join(format!("berd-secret-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "Test"],
        ] {
            Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(&args)
                .output()
                .unwrap();
        }
        std::fs::write(dir.join(".env.example"), "API_URL=http://example.test\n").unwrap();
        std::fs::write(
            dir.join(".env"),
            "API_URL=http://real\nSTRIPE_KEY=sk_live_real\n",
        )
        .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["add", ".env.example"])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["commit", "-qm", "example"])
            .output()
            .unwrap();

        let (config, _admin, _notes) = detect(&dir);
        let values = &config.env.values;
        // Committed, so it travels as written.
        assert_eq!(values.get("API_URL").unwrap(), "http://example.test");
        // Untracked: the name survives, the value does not.
        assert!(values.contains_key("STRIPE_KEY"));
        assert!(values
            .get("STRIPE_KEY")
            .unwrap()
            .starts_with("berdloop-dummy-"));
        assert!(!values.values().any(|value| value.contains("sk_live_real")));
        assert!(!values.values().any(|value| value == "http://real"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod endtoend {
    //! One realistic project, checked end to end: what is written, what is
    //! proposed, and above all what is left alone.
    use super::*;

    #[test]
    fn a_real_project_is_read_correctly_and_nothing_else_is_touched() {
        let dir = std::env::temp_dir().join(format!("berd-e2e-{}", uuid::Uuid::new_v4()));
        let repo = dir.as_path();
        std::fs::create_dir_all(repo).unwrap();
        let git = |args: &[&str]| {
            Command::new("git")
                .arg("-C")
                .arg(repo)
                .args(args)
                .output()
                .unwrap();
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(
            repo.join("package.json"),
            r#"{"name":"shop","scripts":{"dev":"next dev"}}"#,
        )
        .unwrap();
        std::fs::write(
            repo.join(".env.example"),
            "DATABASE_URL=postgres://localhost:5432/shop\nREDIS_URL=redis://localhost:6379\nPORT=3000\nNODE_ENV=development\n",
        )
        .unwrap();
        std::fs::write(repo.join(".gitignore"), ".env\n").unwrap();
        // Untracked, and holding the real thing.
        std::fs::write(
            repo.join(".env"),
            "DATABASE_URL=postgres://bob:hunter2@localhost:5432/shop\nSTRIPE_SECRET_KEY=sk_live_REALSECRET123\nMONGODB_URI=mongodb://localhost:27017/docs\n",
        )
        .unwrap();
        git(&["add", "package.json", ".env.example", ".gitignore"]);
        git(&["commit", "-qm", "init"]);
        let before: Vec<_> = std::fs::read_dir(repo)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .filter(|name| name != ".berd")
            .collect();
        let env_before = std::fs::read_to_string(repo.join(".env")).unwrap();

        let (config, admin, notes) = detect(repo);

        // The dev command is recognised from package.json.
        assert_eq!(config.dev.command, "npm run dev");
        assert_eq!(config.services[0].default, 3000);

        // All three engines are found: two from the example, one from the
        // untracked .env, recognised by its scheme alone.
        let mut engines: Vec<_> = config
            .resources
            .iter()
            .map(|r| (r.name.as_str(), r.engine.as_str()))
            .collect();
        engines.sort();
        assert_eq!(
            engines,
            vec![
                ("database", "postgres"),
                ("mongodb", "mongodb"),
                ("redis", "redis"),
            ]
        );

        // Credentials are kept out of the committed config entirely.
        let written = serde_json::to_string(&config).unwrap();
        assert!(!written.contains("hunter2"));
        assert!(!written.contains("sk_live_REALSECRET123"));
        assert!(!written.contains("bob"));

        // They are handed to the caller instead, which stores them outside the
        // repository. The tracked example wins over the untracked file.
        assert_eq!(
            admin.get("database").unwrap(),
            "postgres://localhost:5432/shop"
        );

        // A secret that is only a key name travels with a stand-in value.
        let stripe = config.env.values.get("STRIPE_SECRET_KEY").unwrap();
        assert!(stripe.starts_with("berdloop-dummy-"));
        // A committed value travels as written.
        assert_eq!(config.env.values.get("NODE_ENV").unwrap(), "development");
        // Ports and connection strings are decided per worker, not copied.
        assert!(!config.env.values.contains_key("PORT"));
        assert!(!config.env.values.contains_key("DATABASE_URL"));

        assert!(notes.iter().any(|note| note.contains("3 engine(s)")));

        // Detection reads. It must never write.
        let after: Vec<_> = std::fs::read_dir(repo)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .filter(|name| name != ".berd")
            .collect();
        assert_eq!(before, after);
        assert_eq!(
            std::fs::read_to_string(repo.join(".env")).unwrap(),
            env_before
        );

        // And setup writes .berd/, and only .berd/.
        let (report, admin) = setup(repo).unwrap();
        assert!(report.created);
        assert!(repo.join(".berd").join("config.json").exists());
        assert!(repo.join(".berd").join("README.md").exists());
        assert_eq!(
            admin.get("database").unwrap(),
            "postgres://localhost:5432/shop"
        );
        let mut top: Vec<_> = std::fs::read_dir(repo)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name != ".git")
            .collect();
        top.sort();
        assert_eq!(
            top,
            vec![
                ".berd",
                ".env",
                ".env.example",
                ".gitignore",
                "package.json"
            ]
        );
        // The committed config never carries a credential.
        let on_disk = std::fs::read_to_string(repo.join(".berd").join("config.json")).unwrap();
        assert!(!on_disk.contains("hunter2"));
        assert!(!on_disk.contains("sk_live_REALSECRET123"));

        let _ = std::fs::remove_dir_all(repo);
    }
}

#[cfg(test)]
mod hidden_directory {
    //! `.berd/` is hidden, like `.git` and `.idea`. That makes it easy for a
    //! broad ignore rule to swallow it, and a worker would then never see it.
    use super::*;

    fn repo_with_gitignore(rule: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("berd-hidden-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "Test"],
        ] {
            Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(&args)
                .output()
                .unwrap();
        }
        std::fs::write(dir.join(".gitignore"), rule).unwrap();
        dir
    }

    #[test]
    fn a_gitignore_that_hides_every_dotfile_is_called_out() {
        let dir = repo_with_gitignore(".*\n");
        let (setup, _admin) = setup(&dir).unwrap();
        assert!(setup.created);
        assert!(
            setup.notes[0].contains("ignores .berd/"),
            "expected the warning first, got {:?}",
            setup.notes
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_ordinary_gitignore_produces_no_such_warning() {
        let dir = repo_with_gitignore("node_modules/\n.env\n");
        let (setup, _admin) = setup(&dir).unwrap();
        assert!(!setup
            .notes
            .iter()
            .any(|note| note.contains("ignores .berd/")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_config_and_readme_land_in_the_hidden_directory() {
        let dir = repo_with_gitignore("node_modules/\n");
        setup(&dir).unwrap();
        assert!(dir.join(".berd").join("config.json").exists());
        assert!(dir.join(".berd").join("README.md").exists());
        // The old visible name is not used anywhere.
        assert!(!dir.join("berd").exists());
        // And it is read back from the same place.
        assert!(config_of(&dir).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
