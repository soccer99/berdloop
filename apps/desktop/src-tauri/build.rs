use std::path::PathBuf;

/// The worker helper is a Tauri sidecar built by this same crate, so the
/// sidecar file must exist before the crate can compile. A placeholder breaks
/// that cycle; `bun run sidecar` replaces it with the real binary before
/// bundling, and the app refuses to launch agents with a placeholder.
fn ensure_sidecar_placeholder() {
    let target = std::env::var("TARGET").unwrap_or_default();
    let extension = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("binaries");
    let path = dir.join(format!("berdloop-worker-{target}{extension}"));
    println!("cargo:rerun-if-changed=binaries");
    if path.exists() {
        return;
    }
    std::fs::create_dir_all(&dir).expect("create binaries directory");
    if extension.is_empty() {
        std::fs::write(
            &path,
            "#!/bin/sh\necho \"berdloop-worker was not bundled. Rebuild the app with: bun run build:desktop\" >&2\nexit 1\n",
        )
        .expect("write sidecar placeholder");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("chmod sidecar placeholder");
        }
    } else {
        std::fs::write(&path, b"").expect("write sidecar placeholder");
    }
}

fn main() {
    ensure_sidecar_placeholder();
    tauri_build::build()
}
