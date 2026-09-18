//! The resource broker: one set of engines, many worktrees.
//!
//! A project's databases are a tier above its app. Postgres, MySQL, Mongo,
//! Redis and DuckDB are expensive to start and there is no reason to have one
//! per worker: a single engine can hold a hundred tenants. So Berdloop keeps
//! the engines at the project level and hands each worktree its own tenant
//! inside them.
//!
//! ```text
//!   engines (one set, shared)      postgres   mongo   redis
//!                                      |        |       |
//!   tenants (one per worktree)    app_wt3   docs_wt3  wt3:*
//!                                      \       |      /
//!   worker 3                            its own credentials
//! ```
//!
//! ## Why a broker and not "each worker makes its own database"
//!
//! Three reasons, and the third is the important one.
//!
//! * Ten workers starting at once would run ten `CREATE DATABASE` statements
//!   and ten migration chains against one server. The broker does one at a
//!   time.
//! * A worker must not start before its database is ready. Asking and waiting
//!   makes that ordering explicit instead of a race.
//! * A worker that creates its own database needs the server's admin password.
//!   An agent reads every file in its worktree, so that password would be in
//!   its context. The broker holds the admin credentials in the app, outside
//!   every worktree, and hands back only a tenant. The agent gets what it needs
//!   to run the app and nothing more.
//!
//! Admin credentials live in the app's own data directory, never in the project
//! and never in a worktree. That is a locked door, not a wall: an agent runs
//! with permissions bypassed and could go looking. It is the same boundary the
//! rest of Berdloop relies on, and it is worth saying plainly rather than
//! pretending otherwise.
//!
//! ## Asking
//!
//! Requests are files, like the merge queue and the question desk, because the
//! things that make them are separate processes and they must outlive the
//! window being closed.
//!
//! ```text
//! <staging root>/resources/requests/<task>.json   "I need my resources"
//! <staging root>/resources/leases/<task>.json     what the worker was given
//! ```
//!
//! A worker writes a request and waits. The app grants it and writes a lease.
//! The worker reads the lease, writes its env files and connects.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

/// How long a worker waits for its resources before giving up.
pub const GRANT_LIMIT: std::time::Duration = std::time::Duration::from_secs(300);

// ---------------------------------------------------------------------------
// What a project declares
// ---------------------------------------------------------------------------

/// One engine a project needs, and how a worktree gets its own corner of it.
///
/// A project may declare as many as it likes. `postgres + redis`, or
/// `postgres + mongo + duckdb`, are ordinary.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Resource {
    /// What this is called in `.berd/config.json`, for messages and leases.
    pub name: String,
    /// `postgres`, `mysql`, `mongodb`, `redis`, `sqlite`, `duckdb`, or anything
    /// else when `create` and `drop` are given by hand.
    pub engine: String,
    /// The variable the app reads its connection string from.
    pub var: String,
    /// How a worktree is kept apart from its neighbours.
    ///
    /// * `database` — its own database on the shared server. The usual answer.
    /// * `schema` — its own schema in one database. PostgreSQL only.
    /// * `prefix` — its own key prefix. For Redis and anything like it.
    /// * `file` — its own file. For SQLite and DuckDB.
    /// * `none` — shared. Correct for a read-only engine.
    pub tenancy: String,
    /// Brings the engine up, if it is not something already running.
    ///
    /// Empty is the common case and the one to aim for: a Postgres installed
    /// with Homebrew, or a container the user starts themselves, is already
    /// there and Berdloop should leave it alone.
    pub start: String,
    /// Proves the engine is up. Run before the first lease, and retried.
    pub ready: String,
    /// Overrides the built-in commands for this engine. `{admin}`, `{tenant}`
    /// and `{url}` are replaced.
    pub create: Vec<String>,
    pub drop: Vec<String>,
    /// Run in the worktree, with the worker's env, after the lease is granted.
    pub migrate: Vec<String>,
    pub seed: Vec<String>,
}

/// What one worktree was given.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub task: String,
    pub slot: u32,
    /// The variables to put in the worker's environment.
    pub env: BTreeMap<String, String>,
    /// One line per resource, for the window and for the worker's brief.
    pub granted: Vec<String>,
    pub notes: Vec<String>,
    pub at: u128,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    pub task: String,
    /// `grant` for the first time, `reset` to empty and rebuild the tenant.
    pub kind: String,
    pub at: u128,
}

// ---------------------------------------------------------------------------
// A small URL, so every engine can be spoken to correctly
// ---------------------------------------------------------------------------

/// The parts of a connection string.
///
/// Every engine here is addressed by URL, but their command line clients are
/// not: `psql` takes a URL, `mysql` takes flags, `redis-cli` takes others
/// again. Splitting the URL once means each engine's commands can be built
/// properly instead of assembled with string replacement.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Url {
    pub scheme: String,
    pub user: String,
    pub password: String,
    pub host: String,
    pub port: String,
    /// The database, schema or file, with no leading slash.
    pub path: String,
    pub query: String,
}

impl Url {
    pub fn parse(raw: &str) -> Option<Url> {
        let (scheme, rest) = raw.split_once("://")?;
        let (rest, query) = match rest.split_once('?') {
            Some((rest, query)) => (rest, query.to_string()),
            None => (rest, String::new()),
        };
        let (authority, path) = match rest.split_once('/') {
            Some((authority, path)) => (authority, path.to_string()),
            None => (rest, String::new()),
        };
        // A password may hold an `@`, so the host is after the *last* one.
        let (credentials, host_part) = match authority.rsplit_once('@') {
            Some((credentials, host)) => (credentials, host),
            None => ("", authority),
        };
        let (user, password) = match credentials.split_once(':') {
            Some((user, password)) => (user.to_string(), password.to_string()),
            None => (credentials.to_string(), String::new()),
        };
        // An IPv6 host is bracketed, and its colons are not a port separator.
        let (host, port) = if let Some(end) = host_part.rfind(']') {
            let (host, rest) = host_part.split_at(end + 1);
            (
                host.to_string(),
                rest.strip_prefix(':').unwrap_or("").to_string(),
            )
        } else {
            match host_part.split_once(':') {
                Some((host, port)) => (host.to_string(), port.to_string()),
                None => (host_part.to_string(), String::new()),
            }
        };
        Some(Url {
            scheme: scheme.to_string(),
            user,
            password,
            host,
            port,
            path,
            query,
        })
    }

    pub fn render(&self) -> String {
        let mut out = format!("{}://", self.scheme);
        if !self.user.is_empty() {
            out.push_str(&self.user);
            if !self.password.is_empty() {
                out.push(':');
                out.push_str(&self.password);
            }
            out.push('@');
        }
        out.push_str(&self.host);
        if !self.port.is_empty() {
            out.push(':');
            out.push_str(&self.port);
        }
        if !self.path.is_empty() {
            out.push('/');
            out.push_str(&self.path);
        }
        if !self.query.is_empty() {
            out.push('?');
            out.push_str(&self.query);
        }
        out
    }

    /// The same server, with no database chosen. What an admin command uses.
    pub fn server(&self) -> Url {
        Url {
            path: String::new(),
            query: String::new(),
            ..self.clone()
        }
    }

    /// A file engine has no server, so everything after `://` is one path.
    ///
    /// `sqlite:///tmp/dev.db` parses with an empty host, and
    /// `duckdb://./data/w.duckdb` with a host of `.`, because that is what those
    /// strings mean as URLs. Both are really just paths, and this puts them
    /// back together.
    pub fn file_path(&self) -> String {
        if self.host.is_empty() {
            format!("/{}", self.path)
        } else {
            format!("{}/{}", self.host, self.path)
        }
    }

    /// The inverse of `file_path`, so `render` still produces the original
    /// shape.
    fn with_file_path(&self, full: &str) -> Url {
        let (host, path) = match full.strip_prefix('/') {
            Some(rest) => (String::new(), rest.to_string()),
            None => {
                let (host, path) = full.split_once('/').unwrap_or((full, ""));
                (host.to_string(), path.to_string())
            }
        };
        Url {
            host,
            path,
            query: String::new(),
            ..self.clone()
        }
    }

    fn with_path(&self, path: &str) -> Url {
        Url {
            path: path.to_string(),
            ..self.clone()
        }
    }
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

/// The name of one worktree's tenant inside a shared engine.
fn tenant_name(base: &str, slot: u32) -> String {
    let base = if base.is_empty() { "app" } else { base };
    format!("{base}_wt{slot}")
}

/// What Berdloop knows how to do with one engine, before the project says
/// anything.
///
/// Returns the commands that make and drop a tenant, the connection string the
/// worker should use, and any extra variables it needs. An engine that is not
/// listed gets no commands, which means the project must supply its own; that
/// is the honest answer rather than a guess that half works.
fn plan(
    resource: &Resource,
    admin: &Url,
    slot: u32,
) -> (Vec<String>, Vec<String>, Url, BTreeMap<String, String>) {
    let mut extra = BTreeMap::new();
    let engine = resource.engine.as_str();
    let tenancy = if resource.tenancy.is_empty() {
        default_tenancy(engine)
    } else {
        resource.tenancy.as_str()
    };
    let tenant = tenant_name(&admin.path, slot);
    let server = admin.server().render();

    let (create, drop, url) = match (engine, tenancy) {
        ("postgres", "database") => (
            vec![format!(
                "psql \"{server}/postgres\" -v ON_ERROR_STOP=1 -c 'CREATE DATABASE \"{tenant}\"'"
            )],
            // FORCE closes stragglers on the tenant only. The user's own
            // database is a different one and is never touched.
            vec![format!(
                "psql \"{server}/postgres\" -c 'DROP DATABASE IF EXISTS \"{tenant}\" WITH (FORCE)'"
            )],
            admin.with_path(&tenant),
        ),
        ("postgres", "schema") => {
            // One database, one schema each. Cheaper than a database per
            // worker, and the app needs no change: the search path does it.
            let mut url = admin.clone();
            let option = format!("options=-csearch_path%3D{tenant}");
            url.query = if url.query.is_empty() {
                option
            } else {
                format!("{}&{}", url.query, option)
            };
            extra.insert(
                format!("{}_SCHEMA", var_base(&resource.var)),
                tenant.clone(),
            );
            (
                vec![format!(
                    "psql \"{}\" -v ON_ERROR_STOP=1 -c 'CREATE SCHEMA IF NOT EXISTS \"{tenant}\"'",
                    admin.render()
                )],
                vec![format!(
                    "psql \"{}\" -c 'DROP SCHEMA IF EXISTS \"{tenant}\" CASCADE'",
                    admin.render()
                )],
                url,
            )
        }
        ("mysql", _) => {
            let flags = mysql_flags(admin);
            (
                vec![format!(
                    "mysql {flags} -e 'CREATE DATABASE IF NOT EXISTS `{tenant}`'"
                )],
                vec![format!(
                    "mysql {flags} -e 'DROP DATABASE IF EXISTS `{tenant}`'"
                )],
                admin.with_path(&tenant),
            )
        }
        // Mongo makes a database on first write, so there is nothing to create.
        ("mongodb", _) => (
            Vec::new(),
            vec![format!(
                "mongosh \"{}\" --quiet --eval 'db.dropDatabase()'",
                admin.with_path(&tenant).render()
            )],
            admin.with_path(&tenant),
        ),
        ("redis", "database") => {
            // Redis has sixteen numbered databases and no more, so this only
            // works for the first sixteen workers. The prefix strategy has no
            // such limit and is the better default.
            (Vec::new(), Vec::new(), admin.with_path(&slot.to_string()))
        }
        ("redis", _) => {
            let prefix = format!("wt{slot}:");
            extra.insert(
                format!("{}_PREFIX", var_base(&resource.var)),
                prefix.clone(),
            );
            (
                Vec::new(),
                vec![format!(
                    "redis-cli -u \"{}\" --scan --pattern '{prefix}*' | xargs -r redis-cli -u \"{}\" del",
                    admin.render(),
                    admin.render()
                )],
                admin.clone(),
            )
        }
        ("sqlite" | "duckdb", _) => {
            // A file engine has no server. Each worktree gets its own file,
            // beside the original so a relative path still resolves.
            let whole = admin.file_path();
            let (stem, extension) = match whole.rsplit_once('.') {
                // Only a real extension, not a dot in a directory name.
                Some((stem, extension)) if !extension.contains('/') => {
                    (stem.to_string(), format!(".{extension}"))
                }
                _ => (whole.clone(), String::new()),
            };
            let file = format!("{stem}.wt{slot}{extension}");
            (
                Vec::new(),
                vec![format!("rm -f \"{file}\"")],
                admin.with_file_path(&file),
            )
        }
        _ => (Vec::new(), Vec::new(), admin.with_path(&tenant)),
    };

    // Anything the project wrote by hand wins over all of the above.
    let create = if resource.create.is_empty() {
        create
    } else {
        resource.create.clone()
    };
    let drop = if resource.drop.is_empty() {
        drop
    } else {
        resource.drop.clone()
    };
    let fill = |commands: Vec<String>| -> Vec<String> {
        commands
            .into_iter()
            .map(|command| {
                command
                    .replace("{admin}", &admin.render())
                    .replace("{tenant}", &tenant)
                    .replace("{url}", &url.render())
            })
            .collect()
    };
    (fill(create), fill(drop), url, extra)
}

/// What a worktree gets when the project does not say.
fn default_tenancy(engine: &str) -> &'static str {
    match engine {
        "redis" => "prefix",
        "sqlite" | "duckdb" => "file",
        _ => "database",
    }
}

/// `DATABASE_URL` becomes `DATABASE`, so the extras read naturally.
fn var_base(var: &str) -> String {
    var.trim_end_matches("_URL")
        .trim_end_matches("_URI")
        .to_string()
}

/// The MySQL client takes flags, not a URL.
fn mysql_flags(url: &Url) -> String {
    let mut flags = Vec::new();
    if !url.host.is_empty() {
        flags.push(format!("-h {}", url.host));
    }
    if !url.port.is_empty() {
        flags.push(format!("-P {}", url.port));
    }
    if !url.user.is_empty() {
        flags.push(format!("-u {}", url.user));
    }
    if !url.password.is_empty() {
        // Attached with no space, which is the only form mysql accepts.
        flags.push(format!("-p{}", url.password));
    }
    flags.join(" ")
}

/// The probe that proves an engine is up, when the project gives none.
fn default_ready(engine: &str, admin: &Url) -> String {
    match engine {
        "postgres" => format!("pg_isready -q -d \"{}/postgres\"", admin.server().render()),
        "mysql" => format!("mysqladmin {} ping --silent", mysql_flags(admin)),
        "mongodb" => format!(
            "mongosh \"{}\" --quiet --eval 'db.adminCommand(\"ping\")'",
            admin.server().render()
        ),
        "redis" => format!("redis-cli -u \"{}\" ping", admin.server().render()),
        // A file engine is always ready.
        _ => String::new(),
    }
}

// ---------------------------------------------------------------------------
// Admin credentials, kept out of the project and out of every worktree
// ---------------------------------------------------------------------------

/// The connection string Berdloop uses to administer each resource.
///
/// Keyed by resource name. Written when the project is set up, and stored in
/// the app's own data directory: not in the repository, which is committed, and
/// not in a worktree, which an agent reads.
pub type Admin = BTreeMap<String, String>;

pub fn admin_path(app_data: &Path, project_id: &str) -> PathBuf {
    app_data
        .join("resources")
        .join(format!("{}.json", file_safe(project_id)))
}

pub fn read_admin(app_data: &Path, project_id: &str) -> Admin {
    std::fs::read_to_string(admin_path(app_data, project_id))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn write_admin(app_data: &Path, project_id: &str, admin: &Admin) -> Result<(), String> {
    let path = admin_path(app_data, project_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(admin).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    // Readable by this user only. Friction, not a wall, and worth having.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Granting
// ---------------------------------------------------------------------------

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

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

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

/// The broker's own directory inside a project's staging area.
pub struct Desk {
    pub root: PathBuf,
}

impl Desk {
    pub fn new(staging_root: &Path) -> Self {
        Self {
            root: staging_root.join("resources"),
        }
    }

    fn requests(&self) -> PathBuf {
        self.root.join("requests")
    }

    fn leases(&self) -> PathBuf {
        self.root.join("leases")
    }

    /// Serialise granting. One tenant is built at a time, so ten workers
    /// starting together do not run ten migration chains at once.
    fn lock(&self) -> Result<std::fs::File, String> {
        std::fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.root.join("broker.lock"))
            .map_err(|e| e.to_string())?;
        file.lock().map_err(|e| e.to_string())?;
        Ok(file)
    }

    /// A worker asking for its resources. It then waits for the lease.
    pub fn ask(&self, task: &str, kind: &str) -> Result<(), String> {
        let dir = self.requests();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let ask = Ask {
            task: task.to_string(),
            kind: kind.to_string(),
            at: now_ms(),
        };
        let body = serde_json::to_vec(&ask).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(format!("{}.json", file_safe(task))), body)
            .map_err(|e| e.to_string())
    }

    pub fn pending(&self) -> Vec<Ask> {
        let Ok(entries) = self.requests().read_dir() else {
            return Vec::new();
        };
        let mut asks: Vec<Ask> = entries
            .flatten()
            .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
            .filter_map(|text| serde_json::from_str(&text).ok())
            .collect();
        asks.sort_by_key(|ask| ask.at);
        asks
    }

    fn clear_request(&self, task: &str) {
        let _ = std::fs::remove_file(self.requests().join(format!("{}.json", file_safe(task))));
    }

    pub fn lease(&self, task: &str) -> Option<Lease> {
        let text = std::fs::read_to_string(self.leases().join(format!("{}.json", file_safe(task))))
            .ok()?;
        serde_json::from_str(&text).ok()
    }

    fn put_lease(&self, lease: &Lease) -> Result<(), String> {
        let dir = self.leases();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let body = serde_json::to_vec_pretty(lease).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(format!("{}.json", file_safe(&lease.task))), body)
            .map_err(|e| e.to_string())
    }

    fn clear_lease(&self, task: &str) {
        let _ = std::fs::remove_file(self.leases().join(format!("{}.json", file_safe(task))));
    }
}

/// Bring one engine up, if the project says how, and wait until it answers.
///
/// An engine that is already running — a Homebrew Postgres, a container the
/// user started — needs no `start` at all. Berdloop probes, sees it is there,
/// and leaves it completely alone.
fn ensure_engine(resource: &Resource, admin: &Url, dir: &Path) -> Result<(), String> {
    let probe = if resource.ready.is_empty() {
        default_ready(&resource.engine, admin)
    } else {
        resource.ready.clone()
    };
    if probe.is_empty() {
        return Ok(());
    }
    let empty = BTreeMap::new();
    if shell(&probe, dir, &empty).0 {
        return Ok(());
    }
    if resource.start.is_empty() {
        return Err(format!(
            "{} is not answering, and .berd/config.json gives no way to start it. Start it yourself, or set `start` for the `{}` resource.",
            resource.engine, resource.name
        ));
    }
    let (ok, log) = shell(&resource.start, dir, &empty);
    if !ok {
        return Err(format!("Could not start {}: {log}", resource.name));
    }
    // Starting is not being ready. Postgres in particular accepts connections
    // seconds after the process exists.
    for _ in 0..30 {
        if shell(&probe, dir, &empty).0 {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    Err(format!(
        "{} was started but never became ready.",
        resource.name
    ))
}

/// Which worktree is being served. These four always travel together.
#[derive(Clone, Copy)]
pub struct Worker<'a> {
    pub staging_root: &'a Path,
    pub worktree: &'a Path,
    pub task: &'a str,
    pub slot: u32,
}

/// Give one worktree its tenant in every resource the project declares.
///
/// Called in the app, which is where the admin credentials are. `reset` drops
/// each tenant first, which is how a worker starts a feature from a clean
/// database.
pub fn grant(
    who: Worker<'_>,
    resources: &[Resource],
    admin: &Admin,
    base_env: &BTreeMap<String, String>,
    reset: bool,
) -> Lease {
    let Worker {
        staging_root,
        worktree,
        task,
        slot,
    } = who;
    let desk = Desk::new(staging_root);
    let _lock = desk.lock();
    let mut lease = Lease {
        task: task.to_string(),
        slot,
        env: base_env.clone(),
        at: now_ms(),
        ..Lease::default()
    };

    for resource in resources {
        let Some(raw) = admin.get(&resource.name) else {
            lease.notes.push(format!(
                "No connection details are stored for `{}`. Add them in the project's settings.",
                resource.name
            ));
            continue;
        };
        let Some(parsed) = Url::parse(raw) else {
            lease.notes.push(format!(
                "The connection string for `{}` could not be read as a URL.",
                resource.name
            ));
            continue;
        };
        if let Err(error) = ensure_engine(resource, &parsed, staging_root) {
            lease.notes.push(error);
            continue;
        }
        let (create, drop, url, extra) = plan(resource, &parsed, slot);

        if reset {
            for command in &drop {
                shell(command, staging_root, &BTreeMap::new());
            }
        }
        let mut failed = false;
        for command in &create {
            let (ok, log) = shell(command, staging_root, &BTreeMap::new());
            // Already there is success: granting has to be safe to repeat.
            if !ok && !log.to_ascii_lowercase().contains("already exists") {
                lease
                    .notes
                    .push(format!("Could not prepare `{}`: {log}", resource.name));
                failed = true;
            }
        }
        if failed {
            continue;
        }
        if !resource.var.is_empty() {
            lease.env.insert(resource.var.clone(), url.render());
        }
        lease.env.extend(extra);
        lease.granted.push(format!(
            "{} ({}): {}",
            resource.name,
            resource.engine,
            // The password is the one thing not worth printing into a log the
            // window shows.
            Url {
                password: if url.password.is_empty() {
                    String::new()
                } else {
                    "***".into()
                },
                ..url.clone()
            }
            .render()
        ));
    }

    // Migrations and seeds run in the worktree, with the worker's own
    // connection strings, after every tenant exists.
    for resource in resources {
        for command in resource.migrate.iter().chain(resource.seed.iter()) {
            let (ok, log) = shell(command, worktree, &lease.env);
            if !ok {
                lease
                    .notes
                    .push(format!("`{command}` failed for {}: {log}", resource.name));
            }
        }
    }

    let _ = desk.put_lease(&lease);
    desk.clear_request(task);
    lease
}

/// Drop everything one worktree held.
pub fn revoke(staging_root: &Path, resources: &[Resource], admin: &Admin, task: &str, slot: u32) {
    let desk = Desk::new(staging_root);
    let _lock = desk.lock();
    for resource in resources {
        let Some(parsed) = admin.get(&resource.name).and_then(|raw| Url::parse(raw)) else {
            continue;
        };
        let (_, drop, _, _) = plan(resource, &parsed, slot);
        for command in &drop {
            shell(command, staging_root, &BTreeMap::new());
        }
    }
    desk.clear_lease(task);
    desk.clear_request(task);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }

    #[test]
    fn connection_strings_split_into_parts_and_back() {
        let parsed = url("postgres://bob:pw@localhost:5432/shop?sslmode=disable");
        assert_eq!(parsed.user, "bob");
        assert_eq!(parsed.password, "pw");
        assert_eq!(parsed.host, "localhost");
        assert_eq!(parsed.port, "5432");
        assert_eq!(parsed.path, "shop");
        assert_eq!(parsed.query, "sslmode=disable");
        assert_eq!(
            parsed.render(),
            "postgres://bob:pw@localhost:5432/shop?sslmode=disable"
        );
    }

    #[test]
    fn a_password_holding_an_at_sign_does_not_move_the_host() {
        let parsed = url("postgres://bob:p@ss@db.internal:5432/shop");
        assert_eq!(parsed.password, "p@ss");
        assert_eq!(parsed.host, "db.internal");
        assert_eq!(parsed.path, "shop");
    }

    #[test]
    fn a_brew_postgres_with_no_user_or_password_still_parses() {
        let parsed = url("postgres://localhost:5432/shop");
        assert!(parsed.user.is_empty());
        assert!(parsed.password.is_empty());
        assert_eq!(parsed.host, "localhost");
        assert_eq!(parsed.render(), "postgres://localhost:5432/shop");
    }

    #[test]
    fn an_ipv6_host_keeps_its_colons() {
        let parsed = url("postgres://[::1]:5432/shop");
        assert_eq!(parsed.host, "[::1]");
        assert_eq!(parsed.port, "5432");
    }

    fn resource(engine: &str, tenancy: &str) -> Resource {
        Resource {
            name: "primary".into(),
            engine: engine.into(),
            var: "DATABASE_URL".into(),
            tenancy: tenancy.into(),
            ..Resource::default()
        }
    }

    #[test]
    fn postgres_gets_its_own_database_per_worktree() {
        let admin = url("postgres://localhost:5432/shop");
        let (create, drop, tenant, _) = plan(&resource("postgres", "database"), &admin, 3);
        assert_eq!(tenant.render(), "postgres://localhost:5432/shop_wt3");
        assert!(create[0].contains("CREATE DATABASE \"shop_wt3\""));
        // The admin command must not connect to the database it is dropping.
        assert!(create[0].contains("/postgres"));
        assert!(drop[0].contains("DROP DATABASE IF EXISTS \"shop_wt3\""));
    }

    #[test]
    fn postgres_can_use_one_database_and_a_schema_each_instead() {
        let admin = url("postgres://localhost:5432/shop");
        let (create, _, tenant, extra) = plan(&resource("postgres", "schema"), &admin, 2);
        assert!(create[0].contains("CREATE SCHEMA IF NOT EXISTS \"shop_wt2\""));
        // The app needs no change: the search path carries the tenancy.
        assert!(tenant.render().contains("search_path%3Dshop_wt2"));
        assert_eq!(extra.get("DATABASE_SCHEMA").unwrap(), "shop_wt2");
    }

    #[test]
    fn mysql_is_addressed_with_flags_because_its_client_takes_no_url() {
        let admin = url("mysql://root:secret@127.0.0.1:3306/shop");
        let (create, _, tenant, _) = plan(&resource("mysql", "database"), &admin, 1);
        assert!(create[0].contains("-h 127.0.0.1"));
        assert!(create[0].contains("-P 3306"));
        assert!(create[0].contains("-u root"));
        // No space after -p, which is the only form the client accepts.
        assert!(create[0].contains("-psecret"));
        assert!(create[0].contains("CREATE DATABASE IF NOT EXISTS `shop_wt1`"));
        assert_eq!(tenant.path, "shop_wt1");
    }

    #[test]
    fn mongo_needs_no_creating_but_can_still_be_dropped() {
        let admin = url("mongodb://localhost:27017/docs");
        let (create, drop, tenant, _) = plan(&resource("mongodb", ""), &admin, 4);
        assert!(create.is_empty());
        assert_eq!(tenant.path, "docs_wt4");
        assert!(drop[0].contains("docs_wt4"));
    }

    #[test]
    fn redis_uses_a_key_prefix_so_it_is_not_capped_at_sixteen_workers() {
        let admin = url("redis://localhost:6379");
        let mut spec = resource("redis", "");
        spec.var = "REDIS_URL".into();
        let (_, _, tenant, extra) = plan(&spec, &admin, 40);
        assert_eq!(extra.get("REDIS_PREFIX").unwrap(), "wt40:");
        // Same server: the prefix, not the URL, is what keeps workers apart.
        assert_eq!(tenant.render(), "redis://localhost:6379");
    }

    #[test]
    fn a_file_engine_gets_a_file_per_worktree() {
        let admin = url("duckdb://./data/warehouse.duckdb");
        let (_, drop, tenant, _) = plan(&resource("duckdb", ""), &admin, 5);
        assert_eq!(tenant.file_path(), "./data/warehouse.wt5.duckdb");
        // Round trips, so the app is handed back the shape it wrote.
        assert_eq!(tenant.render(), "duckdb://./data/warehouse.wt5.duckdb");
        assert!(drop[0].contains("warehouse.wt5.duckdb"));

        // An absolute path keeps its leading slash.
        let admin = url("sqlite:///tmp/dev.db");
        let (_, _, tenant, _) = plan(&resource("sqlite", ""), &admin, 2);
        assert_eq!(tenant.file_path(), "/tmp/dev.wt2.db");
        assert_eq!(tenant.render(), "sqlite:///tmp/dev.wt2.db");
    }

    #[test]
    fn an_unknown_engine_gets_no_guessed_commands_but_still_gets_a_name() {
        let admin = url("clickhouse://localhost:9000/events");
        let (create, drop, tenant, _) = plan(&resource("clickhouse", "database"), &admin, 2);
        assert!(create.is_empty());
        assert!(drop.is_empty());
        assert_eq!(tenant.path, "events_wt2");
    }

    #[test]
    fn a_project_can_override_any_engine_with_its_own_commands() {
        let admin = url("clickhouse://localhost:9000/events");
        let mut spec = resource("clickhouse", "database");
        spec.create = vec!["clickhouse-client -q 'CREATE DATABASE {tenant}'".into()];
        let (create, _, _, _) = plan(&spec, &admin, 7);
        assert_eq!(
            create[0],
            "clickhouse-client -q 'CREATE DATABASE events_wt7'"
        );
    }

    #[test]
    fn two_worktrees_never_land_on_the_same_tenant() {
        let admin = url("postgres://localhost:5432/shop");
        let (_, _, one, _) = plan(&resource("postgres", "database"), &admin, 1);
        let (_, _, two, _) = plan(&resource("postgres", "database"), &admin, 2);
        assert_ne!(one.path, two.path);
    }
}
