use crate::key_bundle;
use serde::{Deserialize, Serialize};
use std::env;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct SidecarState {
    child: Mutex<Option<Child>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartHelperRequest {
    pub site_url: String,
    pub sidecar_path: Option<String>,
    pub keys_dir: Option<String>,
    pub fixture: Option<bool>,
    pub dev_create_keys: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct HelperProcessStatus {
    pub running: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HelperStartup {
    #[serde(rename = "type")]
    pub event_type: String,
    pub helper_url: String,
    pub site_url: String,
    pub pairing_url: String,
    pub token: String,
    pub allowed_origins: Vec<String>,
    pub sidecar_version: String,
    pub protocol_version: String,
    pub circuit_id: String,
    pub key_state: String,
    pub key_ready: bool,
    pub key_version: Option<String>,
    pub key_hash: Option<String>,
    pub key_compatibility: String,
}

#[tauri::command]
pub fn start_helper(
    app: AppHandle,
    state: State<'_, SidecarState>,
    request: StartHelperRequest,
) -> Result<HelperStartup, String> {
    let mut slot = state
        .child
        .lock()
        .map_err(|_| "helper process state is poisoned".to_string())?;
    if process_running(slot.as_mut()) {
        return Err("helper is already running".to_string());
    }
    *slot = None;

    let sidecar_path = resolve_sidecar_path(&app, request.sidecar_path.as_deref())?;
    let keys_dir = match request.keys_dir {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => key_bundle::active_key_dir(&app)?,
    };

    let mut args = vec![
        "serve-helper".to_string(),
        "--addr".to_string(),
        "127.0.0.1:0".to_string(),
        "--keys-dir".to_string(),
        keys_dir.display().to_string(),
        "--site-url".to_string(),
        request.site_url,
        "--no-open".to_string(),
    ];
    if request.fixture.unwrap_or(false) {
        args.push("--fixture".to_string());
    }
    if request.dev_create_keys.unwrap_or(false) {
        args.push("--dev-create-keys".to_string());
    }

    let mut child = Command::new(&sidecar_path)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|err| format!("start sidecar {}: {err}", sidecar_path.display()))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar stdout was not captured".to_string())?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    if reader
        .read_line(&mut line)
        .map_err(|err| format!("read sidecar startup JSON: {err}"))?
        == 0
    {
        let _ = child.kill();
        return Err("sidecar exited before startup JSON".to_string());
    }
    let startup: HelperStartup = serde_json::from_str(line.trim())
        .map_err(|err| format!("parse sidecar startup JSON: {err}"))?;
    *slot = Some(child);
    Ok(startup)
}

#[tauri::command]
pub fn stop_helper(state: State<'_, SidecarState>) -> Result<HelperProcessStatus, String> {
    let mut slot = state
        .child
        .lock()
        .map_err(|_| "helper process state is poisoned".to_string())?;
    if let Some(mut child) = slot.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(HelperProcessStatus { running: false })
}

#[tauri::command]
pub fn helper_process_status(
    state: State<'_, SidecarState>,
) -> Result<HelperProcessStatus, String> {
    let mut slot = state
        .child
        .lock()
        .map_err(|_| "helper process state is poisoned".to_string())?;
    let running = process_running(slot.as_mut());
    if !running {
        *slot = None;
    }
    Ok(HelperProcessStatus { running })
}

fn process_running(child: Option<&mut Child>) -> bool {
    match child {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    }
}

fn resolve_sidecar_path(app: &AppHandle, explicit: Option<&str>) -> Result<PathBuf, String> {
    if let Some(path) = explicit {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!(
            "configured sidecar path does not exist: {}",
            path.display()
        ));
    }
    if let Ok(path) = env::var("PROOF_HELPER_SIDECAR_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
    }
    for candidate in bundled_candidates(app) {
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Ok(PathBuf::from("proof-tool"))
}

fn bundled_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        push_candidate_set(&mut out, &resource_dir);
        push_candidate_set(&mut out, &resource_dir.join("binaries"));
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            push_candidate_set(&mut out, dir);
            push_candidate_set(&mut out, &dir.join("binaries"));
        }
    }
    out
}

fn push_candidate_set(out: &mut Vec<PathBuf>, dir: &Path) {
    let suffix = match (env::consts::OS, env::consts::ARCH) {
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc.exe",
        _ => "",
    };
    out.push(dir.join("proof-tool"));
    if !suffix.is_empty() {
        out.push(dir.join(format!("proof-tool-{suffix}")));
    }
}
