use crate::key_bundle;
use serde::{Deserialize, Serialize};
use sidecar_core::{HelperStartup, ServeHelperLaunch};
use std::env;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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

#[derive(Debug, Serialize)]
pub struct RuntimeDiagnostics {
    pub os: String,
    pub arch: String,
    pub family: String,
    pub current_exe: Option<String>,
    pub resource_dir: Option<String>,
    pub bundled_sidecar_candidates: Vec<String>,
}

#[tauri::command]
pub fn start_helper<R: Runtime>(
    app: AppHandle<R>,
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
    let destination_keys_dir = key_bundle::active_key_dir(&app)?;

    let args = sidecar_core::serve_helper_args(&ServeHelperLaunch {
        site_url: request.site_url,
        keys_dir,
        destination_keys_dir,
        fixture: request.fixture.unwrap_or(false),
        dev_create_keys: request.dev_create_keys.unwrap_or(false),
    })
    .map_err(|err| err.to_string())?;

    let mut command = Command::new(&sidecar_path);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    hide_sidecar_console(&mut command);
    let mut child = command
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
    let startup = sidecar_core::parse_helper_startup_line(&line).map_err(|err| err.to_string())?;
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

#[tauri::command]
pub fn runtime_diagnostics<R: Runtime>(app: AppHandle<R>) -> RuntimeDiagnostics {
    RuntimeDiagnostics {
        os: env::consts::OS.to_string(),
        arch: env::consts::ARCH.to_string(),
        family: env::consts::FAMILY.to_string(),
        current_exe: env::current_exe()
            .ok()
            .map(|path| path.display().to_string()),
        resource_dir: app
            .path()
            .resource_dir()
            .ok()
            .map(|path| path.display().to_string()),
        bundled_sidecar_candidates: bundled_candidates(&app)
            .into_iter()
            .map(|path| path.display().to_string())
            .collect(),
    }
}

fn process_running(child: Option<&mut Child>) -> bool {
    match child {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    }
}

#[cfg(windows)]
fn hide_sidecar_console(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_sidecar_console(_command: &mut Command) {}

fn resolve_sidecar_path<R: Runtime>(
    app: &AppHandle<R>,
    explicit: Option<&str>,
) -> Result<PathBuf, String> {
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

fn bundled_candidates<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
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
    sidecar_core::push_candidate_set(out, dir, env::consts::OS, env::consts::ARCH);
}
