#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod key_bundle;
mod proof_assets_release;
mod range_download;
mod sidecar;

fn proof_helper_builder<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .manage(key_bundle::KeyBundleState::default())
        .manage(sidecar::SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_url,
            key_bundle::activate_key_bundle,
            key_bundle::key_status,
            key_bundle::delete_key_cache,
            key_bundle::cancel_key_bundle_activation,
            proof_assets_release::install_proof_assets_release,
            sidecar::start_helper,
            sidecar::stop_helper,
            sidecar::helper_process_status,
            sidecar::runtime_diagnostics
        ])
}

fn main() {
    proof_helper_builder(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("failed to run Proof Helper desktop app");
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};

    use super::*;

    #[test]
    fn ipc_can_start_and_stop_real_sidecar_when_configured() {
        let sidecar_path = match std::env::var("PROOF_HELPER_SIDECAR_PATH") {
            Ok(value) if !value.trim().is_empty() => value,
            _ => {
                eprintln!("skipping real sidecar IPC smoke: PROOF_HELPER_SIDECAR_PATH is unset");
                return;
            }
        };
        let app = proof_helper_builder(mock_builder())
            .build(mock_context(noop_assets()))
            .expect("build mock Tauri app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build mock webview");

        let startup = invoke_json(
            &webview,
            "start_helper",
            json!({
                "request": {
                    "siteUrl": "http://127.0.0.1:3002",
                    "sidecarPath": sidecar_path,
                    "fixture": true
                }
            }),
        );
        let pairing_url = startup
            .get("pairing_url")
            .and_then(Value::as_str)
            .map(str::to_string)
            .expect("startup includes pairing_url");
        let process = invoke_json(&webview, "helper_process_status", Value::Null);
        let stopped = invoke_json(&webview, "stop_helper", Value::Null);

        assert!(pairing_url.starts_with("http://127.0.0.1:3002#"));
        assert!(pairing_url.contains("#helper=http://127.0.0.1:"));
        assert!(pairing_url.contains("&pair="));
        assert!(!pairing_url.contains("?helper="));
        assert!(!pairing_url.contains("?pair="));
        assert_eq!(process.get("running").and_then(Value::as_bool), Some(true));
        assert_eq!(stopped.get("running").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn ipc_reports_runtime_diagnostics() {
        let app = proof_helper_builder(mock_builder())
            .build(mock_context(noop_assets()))
            .expect("build mock Tauri app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build mock webview");

        let diagnostics = invoke_json(&webview, "runtime_diagnostics", Value::Null);

        assert_eq!(
            diagnostics.get("os").and_then(Value::as_str),
            Some(std::env::consts::OS)
        );
        assert_eq!(
            diagnostics.get("arch").and_then(Value::as_str),
            Some(std::env::consts::ARCH)
        );
        assert!(
            diagnostics
                .get("bundled_sidecar_candidates")
                .and_then(Value::as_array)
                .is_some(),
            "diagnostics include bundled sidecar candidates"
        );
    }

    fn invoke_json(
        webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        cmd: &str,
        body: Value,
    ) -> Value {
        get_ipc_response(
            webview,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: if body.is_null() {
                    tauri::ipc::InvokeBody::default()
                } else {
                    tauri::ipc::InvokeBody::Json(body)
                },
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .unwrap_or_else(|err| panic!("{cmd} IPC error: {err}"))
        .deserialize::<Value>()
        .expect("IPC response is JSON")
    }
}
