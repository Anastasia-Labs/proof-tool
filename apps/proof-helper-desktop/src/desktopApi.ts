import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type KeyBundleStatus = {
  state: string;
  ready: boolean;
  key_version?: string | null;
  vk_hash?: string | null;
  circuit_id?: string | null;
  app_data_dir: string;
  active_dir: string;
  installed_release_tag?: string | null;
  expected_release_tag?: string | null;
  signature_key_id?: string | null;
  expected_vk_hash?: string | null;
  installed_at?: string | null;
  error?: string | null;
};

export type StartHelperRequest = {
  siteUrl: string;
  sidecarPath?: string;
  keysDir?: string;
  fixture?: boolean;
  devCreateKeys?: boolean;
};

export type ActivateKeyBundleRequest = {
  sourceDir: string;
  trustedManifestPublicKeyHex: string;
  expectedSignatureKeyId: string;
  minFreeBytes?: number;
};

export type KeyBundleProgress = {
  file_name: string;
  copied_bytes: number;
  total_bytes: number;
};

export type ProofAssetInstallPhase =
  | "checking"
  | "downloading"
  | "verifying_archive"
  | "extracting"
  | "verifying_bundle"
  | "activating"
  | "complete";

export type ProofAssetInstallProgress = {
  release_tag: string;
  phase: ProofAssetInstallPhase;
  file_name?: string | null;
  copied_bytes: number;
  total_bytes: number;
  message: string;
};

export type HelperStartup = {
  type: string;
  helper_url: string;
  site_url: string;
  pairing_url: string;
  token: string;
  allowed_origins: string[];
  sidecar_version: string;
  protocol_version: string;
  circuit_id: string;
  key_state: string;
  key_ready: boolean;
  key_version?: string | null;
  key_hash?: string | null;
  key_compatibility: string;
};

export type HelperProcessStatus = {
  running: boolean;
};

export type RuntimeDiagnostics = {
  os: string;
  arch: string;
  family: string;
  current_exe?: string | null;
  resource_dir?: string | null;
  bundled_sidecar_candidates: string[];
};

export type DesktopApi = {
  keyStatus(): Promise<KeyBundleStatus>;
  installProofAssetsRelease(): Promise<KeyBundleStatus>;
  activateKeyBundle(request: ActivateKeyBundleRequest): Promise<KeyBundleStatus>;
  cancelKeyBundleActivation(): Promise<void>;
  onKeyBundleProgress(callback: (progress: KeyBundleProgress) => void): Promise<() => void>;
  onProofAssetInstallProgress(callback: (progress: ProofAssetInstallProgress) => void): Promise<() => void>;
  deleteKeyCache(): Promise<KeyBundleStatus>;
  startHelper(request: StartHelperRequest): Promise<HelperStartup>;
  stopHelper(): Promise<HelperProcessStatus>;
  helperProcessStatus(): Promise<HelperProcessStatus>;
  runtimeDiagnostics(): Promise<RuntimeDiagnostics>;
  openUrl(url: string): Promise<void>;
};

export const tauriDesktopApi: DesktopApi = {
  keyStatus: () => invoke<KeyBundleStatus>("key_status"),
  installProofAssetsRelease: () => invoke<KeyBundleStatus>("install_proof_assets_release"),
  activateKeyBundle: (request) => invoke<KeyBundleStatus>("activate_key_bundle", { request }),
  cancelKeyBundleActivation: () => invoke<void>("cancel_key_bundle_activation"),
  onKeyBundleProgress: (callback) =>
    listen<KeyBundleProgress>("key-bundle-progress", (event) => callback(event.payload)),
  onProofAssetInstallProgress: (callback) =>
    listen<ProofAssetInstallProgress>("proof-asset-install-progress", (event) => callback(event.payload)),
  deleteKeyCache: () => invoke<KeyBundleStatus>("delete_key_cache"),
  startHelper: (request) => invoke<HelperStartup>("start_helper", { request }),
  stopHelper: () => invoke<HelperProcessStatus>("stop_helper"),
  helperProcessStatus: () => invoke<HelperProcessStatus>("helper_process_status"),
  runtimeDiagnostics: () => invoke<RuntimeDiagnostics>("runtime_diagnostics"),
  openUrl: (url) => invoke<void>("open_url", { url }),
};
