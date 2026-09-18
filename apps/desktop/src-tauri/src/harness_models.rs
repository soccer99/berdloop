//! Read model choices from each CLI without starting a model turn.
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

use serde_json::{json, Value};

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct ModelOption {
    value: String,
    label: String,
}

struct Discovery {
    child: Child,
    messages: Receiver<Value>,
    deadline: Instant,
}

impl Drop for Discovery {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Discovery {
    fn start(command: &mut Command) -> Result<Self, String> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                format!("Could not start the harness. Check that its CLI is installed: {e}")
            })?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Could not read the harness output.")?;
        let (tx, messages) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Ok(value) = serde_json::from_str(&line) {
                    if tx.send(value).is_err() {
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            messages,
            deadline: Instant::now() + Duration::from_secs(20),
        })
    }

    fn send(&mut self, message: Value) -> Result<(), String> {
        let stdin = self.child.stdin.as_mut().ok_or("Harness input closed.")?;
        writeln!(stdin, "{message}")
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("Could not request models: {e}"))
    }

    fn receive(&self) -> Result<Value, String> {
        self.messages.recv_timeout(self.deadline.saturating_duration_since(Instant::now()))
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => "Model discovery timed out. Check the CLI connection and retry.".into(),
                mpsc::RecvTimeoutError::Disconnected => "The harness exited before returning models. Check that its CLI is signed in and up to date.".into(),
            })
    }

    fn rpc(&mut self, id: u32, method: &str, params: Value) -> Result<Value, String> {
        self.send(json!({"id": id, "method": method, "params": params}))?;
        loop {
            let message = self.receive()?;
            if message["id"] != id {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(format!("Could not load models: {error}"));
            }
            return message
                .get("result")
                .cloned()
                .ok_or("Missing harness response.".into());
        }
    }
}

fn model_options(value: &Value, value_key: &str) -> Result<Vec<ModelOption>, String> {
    let entries = value
        .as_array()
        .ok_or("The harness returned an invalid model list.")?;
    let mut options = Vec::new();
    for entry in entries {
        if entry["hidden"] == true {
            continue;
        }
        let value = entry[value_key]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or("The harness returned a model without an identifier.")?;
        if options
            .iter()
            .any(|option: &ModelOption| option.value == value)
        {
            continue;
        }
        let name = entry["displayName"].as_str().unwrap_or(value);
        // Claude's launch values are aliases (such as "sonnet"). Its resolved
        // model identifies the version the alias currently uses.
        let resolved = entry["resolvedModel"]
            .as_str()
            .filter(|model| !model.is_empty())
            .unwrap_or(value);
        let label = if name.eq_ignore_ascii_case(resolved) {
            name.to_string()
        } else {
            format!("{name} ({resolved})")
        };
        options.push(ModelOption {
            value: value.into(),
            label,
        });
    }
    Ok(options)
}

fn discover(harness: &str) -> Result<Vec<ModelOption>, String> {
    match harness {
        "codex" => {
            let mut connection = Discovery::start(Command::new("codex").arg("app-server"))?;
            connection.rpc(
                0,
                "initialize",
                json!({"clientInfo": {"name": "berdloop", "version": env!("CARGO_PKG_VERSION")}}),
            )?;
            connection.send(json!({"method": "initialized"}))?;
            let mut models = Vec::new();
            let mut cursor = Value::Null;
            for id in 1..=100 {
                let result = connection.rpc(
                    id,
                    "model/list",
                    json!({"limit": 100, "cursor": cursor, "includeHidden": false}),
                )?;
                for model in model_options(&result["data"], "model")? {
                    if !models
                        .iter()
                        .any(|existing: &ModelOption| existing.value == model.value)
                    {
                        models.push(model);
                    }
                }
                match result.get("nextCursor").and_then(Value::as_str) {
                    Some(next) if cursor.as_str() != Some(next) => cursor = json!(next),
                    None => return Ok(models),
                    _ => return Err("The harness returned a repeated model list page.".into()),
                }
            }
            Err("The harness returned too many model list pages.".into())
        }
        "claude-code" => {
            let mut connection = Discovery::start(
                Command::new("claude")
                    .args([
                        "-p",
                        "--verbose",
                        "--input-format",
                        "stream-json",
                        "--output-format",
                        "stream-json",
                        "--setting-sources",
                        "",
                        "--strict-mcp-config",
                        "--disable-slash-commands",
                        "--no-session-persistence",
                    ])
                    .current_dir(std::env::temp_dir()),
            )?;
            connection.send(json!({"type": "control_request", "request_id": "models", "request": {"subtype": "initialize"}}))?;
            loop {
                let message = connection.receive()?;
                if message["type"] != "control_response"
                    || message["response"]["request_id"] != "models"
                {
                    continue;
                }
                let response = &message["response"];
                if response["subtype"] != "success" {
                    return Err(format!("Could not load models: {}", response["error"]));
                }
                return model_options(&response["response"]["models"], "value");
            }
        }
        _ => Err("Unsupported harness.".into()),
    }
}

const CATALOG_FORMAT_VERSION: u32 = 2;
const CACHE_TTL_SECONDS: u64 = 24 * 60 * 60;
static CATALOG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct HarnessDescriptor {
    id: String,
    name: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct HarnessOption {
    #[serde(flatten)]
    harness: HarnessDescriptor,
    models: Vec<ModelOption>,
    error: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessCatalog {
    #[serde(default)]
    format_version: u32,
    fetched_at: u64,
    harnesses: Vec<HarnessOption>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn cache_is_fresh(catalog: &HarnessCatalog, harnesses: &[HarnessDescriptor], time: u64) -> bool {
    catalog.format_version == CATALOG_FORMAT_VERSION
        && time >= catalog.fetched_at
        && time - catalog.fetched_at < CACHE_TTL_SECONDS
        && catalog.harnesses.len() == harnesses.len()
        && catalog
            .harnesses
            .iter()
            .zip(harnesses)
            .all(|(cached, harness)| {
                cached.harness.id == harness.id && cached.harness.name == harness.name
            })
}

fn load_catalog(
    path: &Path,
    harnesses: Vec<HarnessDescriptor>,
    force: bool,
    fetch: impl Fn(&str) -> Result<Vec<ModelOption>, String> + Sync,
) -> Result<HarnessCatalog, String> {
    let _guard = CATALOG_LOCK
        .lock()
        .map_err(|_| "Harness options are locked.")?;
    if !force {
        if let Some(cached) = fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<HarnessCatalog>(&bytes).ok())
        {
            if cache_is_fresh(&cached, &harnesses, now()) {
                return Ok(cached);
            }
        }
    }
    // Fetch every supported harness in parallel, even if only one is selected.
    // One missing CLI must not prevent the other harness's models loading.
    let options = std::thread::scope(|scope| {
        let jobs: Vec<_> = harnesses
            .into_iter()
            .map(|harness| {
                let fetch = &fetch;
                scope.spawn(move || {
                    let (models, error) = match fetch(&harness.id) {
                        Ok(models) => (models, None),
                        Err(error) => (Vec::new(), Some(error)),
                    };
                    HarnessOption {
                        harness,
                        models,
                        error,
                    }
                })
            })
            .collect();
        jobs.into_iter()
            .map(|job| {
                job.join()
                    .map_err(|_| "Model discovery failed.".to_string())
            })
            .collect::<Result<Vec<_>, _>>()
    })?;
    let catalog = HarnessCatalog {
        format_version: CATALOG_FORMAT_VERSION,
        fetched_at: now(),
        harnesses: options,
    };
    fs::create_dir_all(path.parent().ok_or("Invalid catalog path.")?).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(&catalog).map_err(|e| e.to_string())?)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(&temporary, path).map_err(|e| format!("Could not save harness options: {e}"))?;
    Ok(catalog)
}

#[tauri::command]
pub async fn load_harness_catalog(
    app: tauri::AppHandle,
    harnesses: Vec<HarnessDescriptor>,
    force: bool,
) -> Result<HarnessCatalog, String> {
    // The caller supplies the shared supported-harness catalog. Never execute
    // arbitrary program names from a cached file or IPC argument.
    if harnesses.is_empty()
        || harnesses.len() > 2
        || harnesses
            .iter()
            .any(|h| !matches!(h.id.as_str(), "claude-code" | "codex"))
    {
        return Err("Unsupported harness catalog.".into());
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("harness-catalog.v1.json");
    tauri::async_runtime::spawn_blocking(move || load_catalog(&path, harnesses, force, discover))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_lists_use_launch_ids_and_filter_hidden_duplicates() {
        let models = model_options(
            &json!([
                {"id":"picker-id", "model":"launch-id", "displayName":"Friendly name"},
                {"model":"hidden", "hidden":true},
                {"model":"launch-id"},
                {"model":"another"}
            ]),
            "model",
        )
        .unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].value, "launch-id");
        assert_eq!(models[0].label, "Friendly name (launch-id)");
        assert_eq!(models[1].label, "another");
        assert_eq!(
            model_options(
                &json!([{"value":"sonnet", "displayName":"Sonnet"}]),
                "value"
            )
            .unwrap()[0]
                .value,
            "sonnet"
        );
        assert!(model_options(&json!({}), "model").is_err());
        assert!(model_options(&json!([{"displayName":"No ID"}]), "model").is_err());
        assert!(discover("unknown").is_err());
    }

    #[test]
    fn model_labels_show_resolved_versions_without_changing_launch_aliases() {
        let models = model_options(&json!([
            {"value":"sonnet", "displayName":"Sonnet", "resolvedModel":"claude-sonnet-5"},
            {"value":"haiku", "displayName":"Haiku", "resolvedModel":"claude-haiku-4-5-20251001"},
            {"value":"default", "displayName":"Default (recommended)", "resolvedModel":"claude-opus-5[1m]"}
        ]), "value").unwrap();
        assert_eq!(models[0].value, "sonnet");
        assert_eq!(models[0].label, "Sonnet (claude-sonnet-5)");
        assert_eq!(models[1].label, "Haiku (claude-haiku-4-5-20251001)");
        assert!(models[2].label.contains("claude-opus-5[1m]"));
        let codex = model_options(
            &json!([{"model":"gpt-5.6-sol", "displayName":"GPT-5.6-Sol"}]),
            "model",
        )
        .unwrap();
        assert_eq!(codex[0].label, "GPT-5.6-Sol");
    }

    fn descriptors() -> Vec<HarnessDescriptor> {
        vec![
            HarnessDescriptor {
                id: "claude-code".into(),
                name: "Claude Code".into(),
            },
            HarnessDescriptor {
                id: "codex".into(),
                name: "Codex".into(),
            },
        ]
    }

    #[test]
    fn catalog_persists_reuses_and_overwrites_all_harness_options() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let directory =
            std::env::temp_dir().join(format!("berdloop-catalog-{}", uuid::Uuid::new_v4()));
        let path = directory.join("harness-catalog.v1.json");
        let calls = AtomicUsize::new(0);
        let fetch = |harness: &str| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(vec![ModelOption {
                value: format!("{harness}-model"),
                label: harness.into(),
            }])
        };
        let first = load_catalog(&path, descriptors(), false, fetch).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(first.harnesses.len(), 2);
        let cached = load_catalog(&path, descriptors(), false, |_| {
            panic!("must reuse disk cache")
        })
        .unwrap();
        assert_eq!(cached.harnesses[0].models[0].value, "claude-code-model");
        let refreshed = load_catalog(&path, descriptors(), true, |harness| {
            if harness == "codex" {
                return Err("CLI unavailable".into());
            }
            Ok(vec![ModelOption {
                value: "new-model".into(),
                label: "New model".into(),
            }])
        })
        .unwrap();
        assert_eq!(refreshed.harnesses[0].models[0].value, "new-model");
        assert_eq!(
            refreshed.harnesses[1].error.as_deref(),
            Some("CLI unavailable")
        );
        let mut saved: HarnessCatalog = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved.harnesses[0].models[0].value, "new-model");
        assert!(saved.harnesses[1].models.is_empty());
        saved.fetched_at = now() - CACHE_TTL_SECONDS;
        fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
        load_catalog(&path, descriptors(), false, fetch).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cache_expires_and_tracks_changes_to_the_supported_harness_list() {
        let catalog = HarnessCatalog {
            format_version: CATALOG_FORMAT_VERSION,
            fetched_at: 100,
            harnesses: descriptors()
                .into_iter()
                .map(|harness| HarnessOption {
                    harness,
                    models: Vec::new(),
                    error: None,
                })
                .collect(),
        };
        assert!(cache_is_fresh(
            &catalog,
            &descriptors(),
            100 + CACHE_TTL_SECONDS - 1
        ));
        assert!(!cache_is_fresh(
            &catalog,
            &descriptors(),
            100 + CACHE_TTL_SECONDS
        ));
        assert!(!cache_is_fresh(&catalog, &descriptors(), 99));
        assert!(!cache_is_fresh(&catalog, &descriptors()[..1], 100));
        let legacy = HarnessCatalog {
            format_version: 0,
            ..catalog
        };
        assert!(!cache_is_fresh(&legacy, &descriptors(), 100));
    }

    #[test]
    #[ignore = "requires installed and authenticated CLIs"]
    fn installed_harnesses_return_models() {
        for harness in ["claude-code", "codex"] {
            let models = discover(harness).unwrap();
            assert!(!models.is_empty(), "{harness} returned no models");
            println!("{harness}: {} models", models.len());
        }
    }
}
