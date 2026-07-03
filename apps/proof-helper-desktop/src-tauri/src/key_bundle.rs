use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const KEY_VERSION: &str = "ownership-v1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct KeyBundleStatus {
    pub state: String,
    pub ready: bool,
    pub key_version: Option<String>,
    pub vk_hash: Option<String>,
    pub circuit_id: Option<String>,
    pub app_data_dir: String,
    pub active_dir: String,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    key_version: Option<String>,
    circuit_id: Option<String>,
    vk_hash: Option<String>,
}

#[tauri::command]
pub fn key_status(app: AppHandle) -> Result<KeyBundleStatus, String> {
    inspect_key_bundle(&app)
}

#[tauri::command]
pub fn delete_key_cache(app: AppHandle) -> Result<KeyBundleStatus, String> {
    let paths = key_cache_paths(&app)?;
    if paths.active_dir.exists() {
        fs::remove_dir_all(&paths.active_dir)
            .map_err(|err| format!("delete active key cache: {err}"))?;
    }
    if paths.downloading_dir.exists() {
        fs::remove_dir_all(&paths.downloading_dir)
            .map_err(|err| format!("delete temporary key cache: {err}"))?;
    }
    inspect_key_bundle(&app)
}

pub fn active_key_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(key_cache_paths(app)?.active_dir)
}

pub fn inspect_key_bundle(app: &AppHandle) -> Result<KeyBundleStatus, String> {
    let paths = key_cache_paths(app)?;
    if !paths.active_dir.exists() {
        return Ok(status(
            &paths,
            "missing",
            false,
            None,
            Some("key bundle is not installed"),
        ));
    }

    let manifest_path = paths.active_dir.join("manifest.json");
    let pk_path = paths.active_dir.join("ownership.pk");
    let vk_path = paths.active_dir.join("ownership.vk");
    if !manifest_path.exists() || !pk_path.exists() || !vk_path.exists() {
        return Ok(status(
            &paths,
            "invalid",
            false,
            None,
            Some("key bundle is incomplete"),
        ));
    }

    let manifest_bytes = fs::read(&manifest_path).map_err(|err| format!("read manifest: {err}"))?;
    let manifest: Manifest =
        serde_json::from_slice(&manifest_bytes).map_err(|err| format!("parse manifest: {err}"))?;
    if manifest.key_version.as_deref() != Some(KEY_VERSION) {
        return Ok(status(
            &paths,
            "invalid",
            false,
            Some(manifest),
            Some("key version is not supported"),
        ));
    }
    if manifest.vk_hash.as_deref().unwrap_or_default().is_empty() {
        return Ok(status(
            &paths,
            "invalid",
            false,
            Some(manifest),
            Some("manifest is missing vk_hash"),
        ));
    }

    Ok(status(&paths, "ready", true, Some(manifest), None))
}

fn status(
    paths: &KeyCachePaths,
    state: &str,
    ready: bool,
    manifest: Option<Manifest>,
    error: Option<&str>,
) -> KeyBundleStatus {
    KeyBundleStatus {
        state: state.to_string(),
        ready,
        key_version: manifest
            .as_ref()
            .and_then(|value| value.key_version.clone()),
        vk_hash: manifest.as_ref().and_then(|value| value.vk_hash.clone()),
        circuit_id: manifest.as_ref().and_then(|value| value.circuit_id.clone()),
        app_data_dir: paths.app_data_dir.display().to_string(),
        active_dir: paths.active_dir.display().to_string(),
        error: error.map(str::to_string),
    }
}

struct KeyCachePaths {
    app_data_dir: PathBuf,
    active_dir: PathBuf,
    downloading_dir: PathBuf,
}

fn key_cache_paths(app: &AppHandle) -> Result<KeyCachePaths, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("resolve app data directory: {err}"))?;
    let key_root = app_data_dir.join("keys").join(KEY_VERSION);
    Ok(KeyCachePaths {
        app_data_dir,
        active_dir: key_root.join("active"),
        downloading_dir: key_root.join("downloading.tmp"),
    })
}
