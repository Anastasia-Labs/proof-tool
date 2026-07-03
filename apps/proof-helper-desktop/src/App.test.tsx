import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { DesktopApi, HelperStartup, KeyBundleStatus } from "./desktopApi";

const missingStatus: KeyBundleStatus = {
  state: "missing",
  ready: false,
  app_data_dir: "/tmp/proof-helper",
  active_dir: "/tmp/proof-helper/keys/ownership-v1/active",
  error: "key bundle is not installed",
};

const readyStatus: KeyBundleStatus = {
  state: "ready",
  ready: true,
  key_version: "ownership-v1",
  vk_hash: "blake2b256:41db4045127fbb379143a9bb99eadf2fdf2d316698c83cb912d00df938017e92",
  circuit_id: "root-ownership-v1/bls12-381/groth16",
  app_data_dir: "/tmp/proof-helper",
  active_dir: "/tmp/proof-helper/keys/ownership-v1/active",
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
  circuit_id: "root-ownership-v1/bls12-381/groth16",
  key_state: "ready",
  key_ready: true,
  key_version: "ownership-v1",
  key_hash: "blake2b256:test",
  key_compatibility: "ready",
};

describe("Proof Helper desktop app", () => {
  it("shows missing key cache state", async () => {
    render(<App api={fakeApi({ keyStatus: missingStatus })} />);

    expect((await screen.findAllByText("Missing")).length).toBeGreaterThan(0);
    expect(screen.getByText("key bundle is not installed")).toBeInTheDocument();
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
}: {
  keyStatus: KeyBundleStatus;
  deleteStatus?: KeyBundleStatus;
  startup?: HelperStartup;
}): DesktopApi {
  return {
    keyStatus: vi.fn().mockResolvedValue(keyStatus),
    deleteKeyCache: vi.fn().mockResolvedValue(deleteStatus),
    startHelper: vi.fn().mockResolvedValue(helperStartup),
    stopHelper: vi.fn().mockResolvedValue({ running: false }),
    helperProcessStatus: vi.fn().mockResolvedValue({ running: false }),
    openUrl: vi.fn().mockResolvedValue(undefined),
  };
}
