import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { DesktopApi, HelperStartup, KeyBundleProgress, KeyBundleStatus } from "./desktopApi";

const missingStatus: KeyBundleStatus = {
  state: "missing",
  ready: false,
  app_data_dir: "/tmp/proof-helper",
  active_dir: "/tmp/proof-helper/keys/ownership-destination-v1/active",
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

describe("Proof Helper desktop app", () => {
  it("shows missing key cache state", async () => {
    render(<App api={fakeApi({ keyStatus: missingStatus })} />);

    expect((await screen.findAllByText("Missing")).length).toBeGreaterThan(0);
    expect(screen.getByText("key bundle is not installed")).toBeInTheDocument();
  });

  it("installs a key bundle from a local source", async () => {
    const api = fakeApi({ keyStatus: missingStatus, activateStatus: readyStatus });
    render(<App api={api} />);

    await screen.findByText("key bundle is not installed");
    fireEvent.change(screen.getByLabelText("Bundle source"), { target: { value: "/tmp/source-bundle" } });
    fireEvent.change(screen.getByLabelText("Manifest public key"), { target: { value: "ab".repeat(32) } });
    fireEvent.change(screen.getByLabelText("Signature key id"), { target: { value: "test-signer" } });
    fireEvent.click(screen.getByRole("button", { name: /install key/i }));

    await waitFor(() => expect(api.activateKeyBundle).toHaveBeenCalledOnce());
    expect(api.activateKeyBundle).toHaveBeenCalledWith({
      sourceDir: "/tmp/source-bundle",
      trustedManifestPublicKeyHex: "ab".repeat(32),
      expectedSignatureKeyId: "test-signer",
      minFreeBytes: 1,
    });
    expect(await screen.findByText("Staging ownership.pk")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(await screen.findByText("Key bundle installed and verified.")).toBeInTheDocument();
  });

  it("requests cancellation while installing a key bundle", async () => {
    const api = fakeApi({ keyStatus: missingStatus, activateNever: true });
    render(<App api={api} />);

    await screen.findByText("key bundle is not installed");
    fireEvent.change(screen.getByLabelText("Bundle source"), { target: { value: "/tmp/source-bundle" } });
    fireEvent.change(screen.getByLabelText("Manifest public key"), { target: { value: "cd".repeat(32) } });
    fireEvent.click(screen.getByRole("button", { name: /install key/i }));

    const cancel = await screen.findByRole("button", { name: /cancel install/i });
    fireEvent.click(cancel);

    await waitFor(() => expect(api.cancelKeyBundleActivation).toHaveBeenCalledOnce());
  });

  it("starts helper and opens the pairing URL", async () => {
    const api = fakeApi({ keyStatus: readyStatus, startup });
    render(<App api={api} />);

    expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => expect(api.startHelper).toHaveBeenCalledOnce());
    expect(api.openUrl).toHaveBeenCalledWith(startup.pairing_url);
    expect(await screen.findByText("Paired at http://127.0.0.1:49152")).toBeInTheDocument();
  });

  it("deletes the cache and refreshes status", async () => {
    const api = fakeApi({ keyStatus: readyStatus, deleteStatus: missingStatus });
    render(<App api={api} />);

    expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /remove cache/i }));

    await waitFor(() => expect(api.deleteKeyCache).toHaveBeenCalledOnce());
    expect((await screen.findAllByText("Missing")).length).toBeGreaterThan(0);
  });
});

function fakeApi({
  keyStatus,
  deleteStatus = keyStatus,
  startup: helperStartup = startup,
  activateStatus,
  activateNever = false,
}: {
  keyStatus: KeyBundleStatus;
  deleteStatus?: KeyBundleStatus;
  startup?: HelperStartup;
  activateStatus?: KeyBundleStatus;
  activateNever?: boolean;
}): DesktopApi {
  let progressListener: ((progress: KeyBundleProgress) => void) | undefined;
  return {
    keyStatus: vi.fn().mockResolvedValue(keyStatus),
    activateKeyBundle: vi.fn().mockImplementation(() => {
      progressListener?.({ file_name: "ownership.pk", copied_bytes: 8, total_bytes: 16 });
      if (activateNever) {
        return new Promise(() => undefined);
      }
      return Promise.resolve(activateStatus ?? keyStatus);
    }),
    cancelKeyBundleActivation: vi.fn().mockResolvedValue(undefined),
    onKeyBundleProgress: vi.fn().mockImplementation((callback: (progress: KeyBundleProgress) => void) => {
      progressListener = callback;
      return Promise.resolve(() => {
        progressListener = undefined;
      });
    }),
    deleteKeyCache: vi.fn().mockResolvedValue(deleteStatus),
    startHelper: vi.fn().mockResolvedValue(helperStartup),
    stopHelper: vi.fn().mockResolvedValue({ running: false }),
    helperProcessStatus: vi.fn().mockResolvedValue({ running: false }),
    openUrl: vi.fn().mockResolvedValue(undefined),
  };
}
