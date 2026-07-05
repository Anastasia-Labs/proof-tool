use key_bundle_core::{self, InstallProgress, InstallRequest};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

const KEY_VERSION: &str = "ownership-destination-v1";
const KEY_BUNDLE_PROGRESS_EVENT: &str = "key-bundle-progress";

#[derive(Default)]
pub struct KeyBundleState {
    cancel_activation: AtomicBool,
}

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
#[serde(rename_all = "camelCase")]
pub struct ActivateKeyBundleRequest {
    pub source_dir: String,
    pub trusted_manifest_public_key_hex: String,
    pub expected_signature_key_id: String,
    pub min_free_bytes: Option<u64>,
}

#[tauri::command]
pub fn key_status<R: Runtime>(app: AppHandle<R>) -> Result<KeyBundleStatus, String> {
    inspect_key_bundle(&app)
}

#[tauri::command]
pub fn activate_key_bundle<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, KeyBundleState>,
    request: ActivateKeyBundleRequest,
) -> Result<KeyBundleStatus, String> {
    state.cancel_activation.store(false, Ordering::SeqCst);
    let paths = key_cache_paths(&app)?;
    let request = InstallRequest {
        source_dir: PathBuf::from(request.source_dir),
        active_dir: paths.active_dir.clone(),
        downloading_dir: paths.downloading_dir.clone(),
        trusted_manifest_public_key_hex: request.trusted_manifest_public_key_hex,
        expected_signature_key_id: request.expected_signature_key_id,
        min_free_bytes: request.min_free_bytes,
    };
    let install_result = key_bundle_core::install_bundle_with_progress(&request, |progress| {
        if state.cancel_activation.load(Ordering::SeqCst) {
            return Err("key bundle activation cancelled".to_string());
        }
        emit_progress(&app, &progress)
    });
    state.cancel_activation.store(false, Ordering::SeqCst);
    install_result?;
    inspect_key_bundle(&app)
}

#[tauri::command]
pub fn delete_key_cache<R: Runtime>(app: AppHandle<R>) -> Result<KeyBundleStatus, String> {
    let paths = key_cache_paths(&app)?;
    key_bundle_core::delete_cache(&paths.active_dir, &paths.downloading_dir)?;
    inspect_key_bundle(&app)
}

#[tauri::command]
pub fn cancel_key_bundle_activation(state: State<'_, KeyBundleState>) -> Result<(), String> {
    state.cancel_activation.store(true, Ordering::SeqCst);
    Ok(())
}

pub fn active_key_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(key_cache_paths(app)?.active_dir)
}

pub fn inspect_key_bundle<R: Runtime>(app: &AppHandle<R>) -> Result<KeyBundleStatus, String> {
    let paths = key_cache_paths(app)?;
    let inspection = key_bundle_core::inspect_active_bundle(&paths.active_dir);
    Ok(KeyBundleStatus {
        state: inspection.state,
        ready: inspection.ready,
        key_version: inspection.key_version,
        vk_hash: inspection.vk_hash,
        circuit_id: inspection.circuit_id,
        app_data_dir: paths.app_data_dir.display().to_string(),
        active_dir: paths.active_dir.display().to_string(),
        error: inspection.error,
    })
}

struct KeyCachePaths {
    app_data_dir: PathBuf,
    active_dir: PathBuf,
    downloading_dir: PathBuf,
}

fn key_cache_paths<R: Runtime>(app: &AppHandle<R>) -> Result<KeyCachePaths, String> {
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

fn emit_progress<R: Runtime>(app: &AppHandle<R>, progress: &InstallProgress) -> Result<(), String> {
    app.emit(KEY_BUNDLE_PROGRESS_EVENT, progress)
        .map_err(|err| format!("emit key bundle progress: {err}"))
}
