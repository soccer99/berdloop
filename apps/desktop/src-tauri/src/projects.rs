use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
    pub is_git: bool,
    pub branch: Option<String>,
    pub remote_url: Option<String>,
    pub provider: Option<String>,
}

fn git(path: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn provider(remote: &str) -> Option<String> {
    let host = remote
        .split_once("://")
        .map(|(_, rest)| rest.split('/').next().unwrap_or(""))
        .or_else(|| {
            remote
                .split_once('@')
                .and_then(|(_, rest)| rest.split(':').next())
        })?
        .split(':')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match host.as_str() {
        "github.com" => Some("GitHub".into()),
        "gitlab.com" => Some("GitLab".into()),
        _ => None,
    }
}

fn inspect(path: &Path) -> Result<ProjectInfo, String> {
    let canonical = path
        .canonicalize()
        .map_err(|_| "Folder does not exist.".to_string())?;
    if !canonical.is_dir() {
        return Err("Choose a folder.".into());
    }
    let root = git(&canonical, &["rev-parse", "--show-toplevel"])
        .filter(|root| !root.is_empty())
        .and_then(|root| PathBuf::from(root).canonicalize().ok());
    let path = root.as_deref().unwrap_or(&canonical);
    let remote_url = root
        .as_ref()
        .and_then(|_| git(path, &["remote", "get-url", "origin"]));
    let branch = root
        .as_ref()
        .and_then(|_| git(path, &["branch", "--show-current"]))
        .filter(|s| !s.is_empty());
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Project")
        .to_string();
    Ok(ProjectInfo {
        path: path.to_string_lossy().into_owned(),
        name,
        is_git: root.is_some(),
        branch,
        provider: remote_url.as_deref().and_then(provider),
        remote_url,
    })
}

#[tauri::command]
pub fn project_inspect(path: String) -> Result<ProjectInfo, String> {
    inspect(Path::new(path.trim()))
}

#[tauri::command]
pub fn project_init(path: String) -> Result<ProjectInfo, String> {
    let target = Path::new(path.trim())
        .canonicalize()
        .map_err(|_| "Folder does not exist.".to_string())?;
    if !target.is_dir() {
        return Err("Choose a folder.".into());
    }
    if inspect(&target)?.is_git {
        return Err("This folder is already inside a Git repository.".into());
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(&target)
        .arg("init")
        .output()
        .map_err(|_| "Git is not installed or could not be started.".to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    inspect(&target)
}

fn clone_name(url: &str) -> Result<String, String> {
    let remote = url.trim();
    if provider(remote).is_none() || !(remote.starts_with("https://") || remote.starts_with("git@"))
    {
        return Err("Enter a GitHub or GitLab HTTPS or SSH repository URL.".into());
    }
    let name = remote
        .trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()
        .unwrap_or("")
        .trim_end_matches(".git");
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err("Repository URL has no valid folder name.".into());
    }
    Ok(name.to_string())
}

#[tauri::command]
pub fn project_clone(url: String, destination: String) -> Result<ProjectInfo, String> {
    let name = clone_name(&url)?;
    let parent = Path::new(destination.trim())
        .canonicalize()
        .map_err(|_| "Destination folder does not exist.".to_string())?;
    if !parent.is_dir() {
        return Err("Choose a destination folder.".into());
    }
    let target = parent.join(name);
    if target.exists() {
        return Err("A folder with this repository name already exists there.".into());
    }
    let output = Command::new("git")
        .arg("clone")
        .arg("--")
        .arg(url.trim())
        .arg(&target)
        .output()
        .map_err(|_| "Git is not installed or could not be started.".to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Clone failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    inspect(&target)
}

#[cfg(test)]
mod tests {
    use super::{clone_name, provider};
    #[test]
    fn inspects_and_initializes_a_folder() {
        let path =
            std::env::temp_dir().join(format!("berdloop-project-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let before = super::inspect(&path).unwrap();
        assert!(!before.is_git);
        let after = super::project_init(path.to_string_lossy().into_owned()).unwrap();
        assert!(after.is_git);
        assert_eq!(after.path, path.canonicalize().unwrap().to_string_lossy());
        assert!(super::project_init(path.to_string_lossy().into_owned()).is_err());
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn validates_clone_sources() {
        assert_eq!(
            clone_name("https://github.com/team/repo.git").unwrap(),
            "repo"
        );
        assert_eq!(clone_name("git@gitlab.com:team/repo.git").unwrap(), "repo");
        assert!(clone_name("https://example.com/repo.git").is_err());
        assert!(clone_name("--upload-pack=evil").is_err());
        assert_eq!(
            provider("https://github.com/team/repo"),
            Some("GitHub".into())
        );
    }
}
