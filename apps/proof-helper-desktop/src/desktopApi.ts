import { invoke } from "@tauri-apps/api/core";

export type KeyBundleStatus = {
  state: string;
  ready: boolean;
  key_version?: string | null;
  vk_hash?: string | null;
  circuit_id?: string | null;
  app_data_dir: string;
  active_dir: string;
  error?: string | null;
};

export type StartHelperRequest = {
  siteUrl: string;
  sidecarPath?: string;
  keysDir?: string;
  fixture?: boolean;
  devCreateKeys?: boolean;
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

export type DesktopApi = {
  keyStatus(): Promise<KeyBundleStatus>;
  deleteKeyCache(): Promise<KeyBundleStatus>;
  startHelper(request: StartHelperRequest): Promise<HelperStartup>;
  stopHelper(): Promise<HelperProcessStatus>;
  helperProcessStatus(): Promise<HelperProcessStatus>;
  openUrl(url: string): Promise<void>;
};

export const tauriDesktopApi: DesktopApi = {
  keyStatus: () => invoke<KeyBundleStatus>("key_status"),
  deleteKeyCache: () => invoke<KeyBundleStatus>("delete_key_cache"),
  startHelper: (request) => invoke<HelperStartup>("start_helper", { request }),
  stopHelper: () => invoke<HelperProcessStatus>("stop_helper"),
  helperProcessStatus: () => invoke<HelperProcessStatus>("helper_process_status"),
  openUrl: (url) => invoke<void>("open_url", { url }),
};

