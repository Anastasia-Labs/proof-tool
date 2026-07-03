mod commands;
mod key_bundle;
mod sidecar;

fn main() {
    tauri::Builder::default()
        .manage(sidecar::SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_url,
            key_bundle::key_status,
            key_bundle::delete_key_cache,
            sidecar::start_helper,
            sidecar::stop_helper,
            sidecar::helper_process_status
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Proof Helper desktop app");
}
