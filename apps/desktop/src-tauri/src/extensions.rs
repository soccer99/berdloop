//! Find the skills and MCP servers the user already has.
//!
//! Berdloop gives its agents none of these by default, because a worker runs
//! with permissions bypassed and anything configured globally would run
//! unattended inside the user's repository. This is the other half of that
//! decision: show a person what exists, so they can hand back the ones they
//! actually want.
//!
//! Nothing here enables anything. It only looks.

use std::fs;
use std::path::{Path, PathBuf};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Extension {
    /// "skill" or "mcp".
    pub kind: &'static str,
    pub name: String,
    /// Which CLI it belongs to: "Claude Code" or "Codex".
    pub harness: &'static str,
    /// Where it was found, for a person to check.
    pub source: String,
    /// One line, where the file offers one.
    pub description: String,
}

fn home() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}

/// The `description:` line of a skill's front matter, when it has one.
fn skill_description(dir: &Path) -> String {
    let Ok(text) = fs::read_to_string(dir.join("SKILL.md")) else {
        return String::new();
    };
    text.lines()
        .take(20)
        .find_map(|line| line.strip_prefix("description:"))
        .map(|line| line.trim().trim_matches('"').to_string())
        .unwrap_or_default()
}

fn skills_in(root: &Path, harness: &'static str, out: &mut Vec<Extension>) {
    let Ok(entries) = root.read_dir() else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        out.push(Extension {
            kind: "skill",
            name: name.to_string(),
            harness,
            source: path.to_string_lossy().into_owned(),
            description: skill_description(&path),
        });
    }
}

/// MCP server names from a JSON file holding an `mcpServers` object.
fn mcp_from_json(path: &Path, harness: &'static str, out: &mut Vec<Extension>) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let Some(servers) = value.get("mcpServers").and_then(|v| v.as_object()) else {
        return;
    };
    for (name, entry) in servers {
        out.push(Extension {
            kind: "mcp",
            name: name.clone(),
            harness,
            source: path.to_string_lossy().into_owned(),
            description: entry
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        });
    }
}

/// MCP server names from Codex's TOML config.
///
/// Read by hand rather than with a TOML parser: only the `[mcp_servers.<name>]`
/// headings are wanted, and a whole dependency for that is not worth it.
fn mcp_from_toml(path: &Path, out: &mut Vec<Extension>) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("[mcp_servers.") else {
            continue;
        };
        let Some(name) = rest.strip_suffix(']') else {
            continue;
        };
        // A nested table such as [mcp_servers.x.env] is part of the same entry.
        let name = name.split('.').next().unwrap_or(name).trim_matches('"');
        if !out
            .iter()
            .any(|item| item.kind == "mcp" && item.name == name)
        {
            out.push(Extension {
                kind: "mcp",
                name: name.to_string(),
                harness: "Codex",
                source: path.to_string_lossy().into_owned(),
                description: String::new(),
            });
        }
    }
}

/// Everything the user has, so a person can choose what to hand back.
#[tauri::command]
pub fn extensions_scan() -> Result<Vec<Extension>, String> {
    let home = home().ok_or("HOME is not set")?;
    let mut found = Vec::new();

    skills_in(&home.join(".claude/skills"), "Claude Code", &mut found);
    skills_in(&home.join(".codex/skills"), "Codex", &mut found);

    mcp_from_json(&home.join(".claude.json"), "Claude Code", &mut found);
    mcp_from_json(
        &home.join(".claude/settings.json"),
        "Claude Code",
        &mut found,
    );
    mcp_from_toml(&home.join(".codex/config.toml"), &mut found);

    found.sort_by(|a, b| a.kind.cmp(b.kind).then_with(|| a.name.cmp(&b.name)));
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("berdloop-ext-{n}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_a_skill_and_its_description() {
        let root = temp();
        let skill = root.join("tidy-up");
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: tidy-up\ndescription: Clears the desk\n---\nbody\n",
        )
        .unwrap();

        let mut found = Vec::new();
        skills_in(&root, "Claude Code", &mut found);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "tidy-up");
        assert_eq!(found[0].description, "Clears the desk");
    }

    #[test]
    fn a_missing_folder_is_not_an_error() {
        let mut found = Vec::new();
        skills_in(Path::new("/no/such/place"), "Codex", &mut found);
        assert!(found.is_empty());
    }

    #[test]
    fn reads_mcp_servers_from_json() {
        let root = temp();
        let path = root.join("settings.json");
        fs::write(
            &path,
            r#"{"mcpServers":{"perplexity":{"command":"npx"},"docs":{"command":"uvx"}}}"#,
        )
        .unwrap();

        let mut found = Vec::new();
        mcp_from_json(&path, "Claude Code", &mut found);
        let mut names: Vec<_> = found.iter().map(|e| e.name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["docs", "perplexity"]);
        assert_eq!(found[0].kind, "mcp");
    }

    #[test]
    fn reads_mcp_servers_from_toml_without_repeating_nested_tables() {
        let root = temp();
        let path = root.join("config.toml");
        fs::write(
            &path,
            "[mcp_servers.search]\ncommand = \"x\"\n\n[mcp_servers.search.env]\nKEY = \"v\"\n\n[mcp_servers.other]\ncommand = \"y\"\n",
        )
        .unwrap();

        let mut found = Vec::new();
        mcp_from_toml(&path, &mut found);
        let names: Vec<_> = found.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["search", "other"]);
    }

    #[test]
    fn malformed_files_are_skipped_rather_than_failing() {
        let root = temp();
        let path = root.join("broken.json");
        fs::write(&path, "{not json").unwrap();
        let mut found = Vec::new();
        mcp_from_json(&path, "Claude Code", &mut found);
        assert!(found.is_empty());
    }
}

#[cfg(test)]
mod real {
    /// Smoke test against this machine. Run with:
    ///   cargo test real_extensions -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_extensions() {
        let found = super::extensions_scan().unwrap();
        let skills = found.iter().filter(|e| e.kind == "skill").count();
        let mcp = found.iter().filter(|e| e.kind == "mcp").count();
        println!("{skills} skills, {mcp} MCP servers found");
        for item in found.iter().filter(|e| e.kind == "mcp") {
            println!("  mcp  {:<28} {}", item.name, item.harness);
        }
        for item in found.iter().filter(|e| e.kind == "skill").take(5) {
            println!("  skill {:<27} {}", item.name, item.harness);
        }
    }
}
