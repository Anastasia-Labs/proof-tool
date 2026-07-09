import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type {
  DesktopApi,
  HelperStartup,
  KeyBundleProgress,
  KeyBundleStatus,
  ProofAssetInstallProgress,
  RuntimeDiagnostics,
} from "./desktopApi";

const missingStatus: KeyBundleStatus = {
  state: "missing",
  ready: false,
  app_data_dir: "/tmp/proof-helper",
  active_dir: "/tmp/proof-helper/keys/ownership-destination-v1/active",
  expected_release_tag: "test-release",
  expected_vk_hash: "blake2b256:test",
  error: "key bundle is not installed",
};

const readyStatus: KeyBundleStatus = {
  state: "ready",
  ready: true,
  key_version: "ownership-destination-v1",
  vk_hash: "blake2b256:41db4045127fbb379143a9bb99eadf2fdf2d316698c83cb912d00df938017e92",
  circuit_id: "root-ownership-destination-v1/bls12-381/groth16",
  app_data_dir: "/tmp/proof-helper",
  active_dir: "/tmp/proof-helper/keys/ownership-destination-v1/active",
  installed_release_tag: "test-release",
  expected_release_tag: "test-release",
  signature_key_id: "test-signer",
  expected_vk_hash: "blake2b256:41db4045127fbb379143a9bb99eadf2fdf2d316698c83cb912d00df938017e92",
  installed_at: "unix:1",
};

const invalidStatus: KeyBundleStatus = {
  state: "invalid",
  ready: false,
  key_version: "ownership-destination-v1",
  vk_hash: "blake2b256:bad",
  circuit_id: "root-ownership-destination-v1/bls12-381/groth16",
  app_data_dir: "/tmp/proof-helper",
  active_dir: "/tmp/proof-helper/keys/ownership-destination-v1/active",
  installed_release_tag: "old-release",
  expected_release_tag: "test-release",
  signature_key_id: "old-signer",
  expected_vk_hash: "blake2b256:test",
  installed_at: "unix:1",
  error: "verifying key hash mismatch",
};

const startup: HelperStartup = {
  type: "proof_tool_helper_ready",
  helper_url: "http://127.0.0.1:49152",
  site_url: "http://127.0.0.1:3002",
  pairing_url: "http://127.0.0.1:3002/#helper=http://127.0.0.1:49152&pair=secret",
  token: "secret",
  allowed_origins: ["http://127.0.0.1:3002"],
  sidecar_version: "0.1.0",
  protocol_version: "proof-helper-v1",
  circuit_id: "root-ownership-destination-v1/bls12-381/groth16",
  key_state: "ready",
  key_ready: true,
  key_version: "ownership-destination-v1",
  key_hash: "blake2b256:test",
  key_compatibility: "ready",
};

const windowsDiagnostics: RuntimeDiagnostics = {
  os: "windows",
  arch: "x86_64",
  family: "windows",
  current_exe: "C:\\Program Files\\Proof Helper\\Proof Helper.exe",
  resource_dir: "C:\\Program Files\\Proof Helper\\resources",
  bundled_sidecar_candidates: [
    "C:\\Program Files\\Proof Helper\\resources\\proof-tool-x86_64-pc-windows-msvc.exe",
  ],
};

describe("Proof Helper desktop app", () => {
  it("shows non-technical missing proof assets state by default", async () => {
    render(<App api={fakeApi({ keyStatus: missingStatus })} />);

    expect(await screen.findByRole("heading", { name: "Proof assets need setup" })).toBeInTheDocument();
    expect(screen.getByText("Proof assets are not installed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /install proof assets/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^open reclaim$/i })).not.toBeInTheDocument();
    expect(screen.getAllByText("key bundle is not installed").length).toBeGreaterThan(0);
    expect(screen.getByText("Proofs are created on this computer. Your recovery phrase is never sent to Reclaim servers.")).toBeInTheDocument();
  });

  it("installs proof assets from the production action and enables Reclaim", async () => {
    const api = fakeApi({ keyStatus: missingStatus, releaseInstallStatus: readyStatus });
    render(<App api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: /install proof assets/i }));

    await waitFor(() => expect(api.installProofAssetsRelease).toHaveBeenCalledOnce());
    expect(await screen.findByText("Downloading proof assets.")).toBeInTheDocument();
    expect(await screen.findByText("Proof assets installed and verified.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /open reclaim/i })).toBeInTheDocument();
  });

  it("offers replacement when installed proof assets are invalid", async () => {
    render(<App api={fakeApi({ keyStatus: invalidStatus })} />);

    expect(await screen.findByRole("heading", { name: "Blocked" })).toBeInTheDocument();
    expect(screen.getAllByText("verifying key hash mismatch").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /replace proof assets/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^open reclaim$/i })).not.toBeInTheDocument();
  });

  it("requests cancellation from the production install flow", async () => {
    const api = fakeApi({ keyStatus: missingStatus, releaseInstallNever: true });
    render(<App api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: /install proof assets/i }));
    const cancel = await screen.findAllByRole("button", { name: /cancel install/i });
    fireEvent.click(cancel[0]);

    await waitFor(() => expect(api.cancelKeyBundleActivation).toHaveBeenCalledOnce());
  });

  it("hides developer-only controls in the default production UI", async () => {
    render(<App api={fakeApi({ keyStatus: readyStatus })} />);

    expect(await screen.findByRole("button", { name: /open reclaim/i })).toBeInTheDocument();
    expect(screen.queryByLabelText("Bundle source")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Manifest public key")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Signature key id")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Website URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Sidecar path")).not.toBeInTheDocument();
    expect(screen.queryByText("Fixture")).not.toBeInTheDocument();
    expect(screen.queryByText("Dev keys")).not.toBeInTheDocument();
  });

  it("keeps local source activation available in developer controls", async () => {
    const api = fakeApi({ keyStatus: missingStatus, activateStatus: readyStatus });
    render(<App api={api} showDeveloperControls />);

    await screen.findByRole("heading", { name: "Proof assets need setup" });
    fireEvent.change(screen.getByLabelText("Bundle source"), { target: { value: "/tmp/source-bundle" } });
    fireEvent.change(screen.getByLabelText("Manifest public key"), { target: { value: "ab".repeat(32) } });
    fireEvent.change(screen.getByLabelText("Signature key id"), { target: { value: "test-signer" } });
    fireEvent.click(screen.getByRole("button", { name: /install local proof assets/i }));

    await waitFor(() => expect(api.activateKeyBundle).toHaveBeenCalledOnce());
    expect(api.activateKeyBundle).toHaveBeenCalledWith({
      sourceDir: "/tmp/source-bundle",
      trustedManifestPublicKeyHex: "ab".repeat(32),
      expectedSignatureKeyId: "test-signer",
      minFreeBytes: 1,
    });
    expect(await screen.findByText("Copying ownership.pk")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(await screen.findByText("Proof assets installed and verified.")).toBeInTheDocument();
  });

  it("requests cancellation while installing a key bundle in developer controls", async () => {
    const api = fakeApi({ keyStatus: missingStatus, activateNever: true });
    render(<App api={api} showDeveloperControls />);

    await screen.findByRole("heading", { name: "Proof assets need setup" });
    fireEvent.change(screen.getByLabelText("Bundle source"), { target: { value: "/tmp/source-bundle" } });
    fireEvent.change(screen.getByLabelText("Manifest public key"), { target: { value: "cd".repeat(32) } });
    fireEvent.click(screen.getByRole("button", { name: /install local proof assets/i }));

    const cancel = await screen.findAllByRole("button", { name: /cancel install/i });
    fireEvent.click(cancel[0]);

    await waitFor(() => expect(api.cancelKeyBundleActivation).toHaveBeenCalledOnce());
  });

  it("starts helper and opens the pairing URL without showing the token", async () => {
    const api = fakeApi({ keyStatus: readyStatus, startup });
    render(<App api={api} />);

    expect(await screen.findByRole("heading", { name: "Ready" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /open reclaim/i }));

    await waitFor(() => expect(api.startHelper).toHaveBeenCalledOnce());
    expect(api.startHelper).toHaveBeenCalledWith({
      siteUrl: "http://127.0.0.1:3002",
      sidecarPath: undefined,
      fixture: false,
      devCreateKeys: false,
    });
    expect(api.openUrl).toHaveBeenCalledWith(startup.pairing_url);
    expect(await screen.findByText("Proof Helper is running locally and the reclaim website is paired.")).toBeInTheDocument();
    expect(screen.queryByText("Paired at http://127.0.0.1:49152")).not.toBeInTheDocument();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
  });

  it("reports the packaged Windows runtime in diagnostics", async () => {
    render(<App api={fakeApi({ keyStatus: readyStatus })} />);

    expect(await screen.findByRole("heading", { name: "Ready" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Diagnostics"));

    expect(await screen.findByText("Windows / x86_64")).toBeInTheDocument();
    expect(screen.getByText("C:\\Program Files\\Proof Helper\\Proof Helper.exe")).toBeInTheDocument();
    expect(
      screen.getByText("C:\\Program Files\\Proof Helper\\resources\\proof-tool-x86_64-pc-windows-msvc.exe"),
    ).toBeInTheDocument();
  });

  it("removes proof assets from diagnostics and refreshes status", async () => {
    const api = fakeApi({ keyStatus: readyStatus, deleteStatus: missingStatus });
    render(<App api={api} />);

    expect(await screen.findByRole("heading", { name: "Ready" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Diagnostics"));
    fireEvent.click(screen.getByRole("button", { name: /remove proof assets/i }));

    await waitFor(() => expect(api.deleteKeyCache).toHaveBeenCalledOnce());
    expect(await screen.findByRole("heading", { name: "Proof assets need setup" })).toBeInTheDocument();
  });
});

function fakeApi({
  keyStatus,
  deleteStatus = keyStatus,
  startup: helperStartup = startup,
  releaseInstallStatus,
  releaseInstallNever = false,
  activateStatus,
  activateNever = false,
  runtimeDiagnostics = windowsDiagnostics,
}: {
  keyStatus: KeyBundleStatus;
  deleteStatus?: KeyBundleStatus;
  startup?: HelperStartup;
  releaseInstallStatus?: KeyBundleStatus;
  releaseInstallNever?: boolean;
  activateStatus?: KeyBundleStatus;
  activateNever?: boolean;
  runtimeDiagnostics?: RuntimeDiagnostics;
}): DesktopApi {
  let keyBundleProgressListener: ((progress: KeyBundleProgress) => void) | undefined;
  let proofAssetProgressListener: ((progress: ProofAssetInstallProgress) => void) | undefined;
  return {
    keyStatus: vi.fn().mockResolvedValue(keyStatus),
    installProofAssetsRelease: vi.fn().mockImplementation(() => {
      proofAssetProgressListener?.({
        release_tag: "test-release",
        phase: "downloading",
        file_name: null,
        copied_bytes: 8,
        total_bytes: 16,
        message: "Downloading proof assets.",
      });
      if (releaseInstallNever) {
        return new Promise(() => undefined);
      }
      return Promise.resolve(releaseInstallStatus ?? keyStatus);
    }),
    activateKeyBundle: vi.fn().mockImplementation(() => {
      keyBundleProgressListener?.({ file_name: "ownership.pk", copied_bytes: 8, total_bytes: 16 });
      if (activateNever) {
        return new Promise(() => undefined);
      }
      return Promise.resolve(activateStatus ?? keyStatus);
    }),
    cancelKeyBundleActivation: vi.fn().mockResolvedValue(undefined),
    onKeyBundleProgress: vi.fn().mockImplementation((callback: (progress: KeyBundleProgress) => void) => {
      keyBundleProgressListener = callback;
      return Promise.resolve(() => {
        keyBundleProgressListener = undefined;
      });
    }),
    onProofAssetInstallProgress: vi.fn().mockImplementation((callback: (progress: ProofAssetInstallProgress) => void) => {
      proofAssetProgressListener = callback;
      return Promise.resolve(() => {
        proofAssetProgressListener = undefined;
      });
    }),
    deleteKeyCache: vi.fn().mockResolvedValue(deleteStatus),
    startHelper: vi.fn().mockResolvedValue(helperStartup),
    stopHelper: vi.fn().mockResolvedValue({ running: false }),
    helperProcessStatus: vi.fn().mockResolvedValue({ running: false }),
    runtimeDiagnostics: vi.fn().mockResolvedValue(runtimeDiagnostics),
    openUrl: vi.fn().mockResolvedValue(undefined),
  };
}
