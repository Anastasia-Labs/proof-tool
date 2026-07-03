import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProofFlow } from "./ProofFlow";

const target = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("ProofFlow", () => {
  it("shows helper-not-running state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    render(<ProofFlow createWorker={fakeWorkerSuccess} />);

    expect((await screen.findAllByText("Install Proof Helper")).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Pairing token")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Helper URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Verifier URL")).not.toBeInTheDocument();
  });

  it("shows invalid mnemonic without echoing the phrase", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(readyHelperStatus()), { status: 200 })),
    );

    renderPaired(<ProofFlow createWorker={fakeWorkerError} />);

    await screen.findByText("Helper connected");
    fireEvent.change(screen.getByLabelText("Payment key credential"), { target: { value: target } });
    fireEvent.change(screen.getByLabelText("Recovery phrase"), { target: { value: "not a real seed phrase" } });
    fireEvent.click(screen.getByRole("button", { name: /generate proof/i }));

    expect(await screen.findByText("Check the recovery phrase")).toBeInTheDocument();
    expect(screen.queryByText("not a real seed phrase")).not.toBeInTheDocument();
  });

  it("generates and verifies a proof artifact", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(readyHelperStatus()), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            artifact: {
              schema: "root-ownership-proof-artifact-v1",
              circuit_id: "root-ownership-v1/bls12-381/groth16",
              vk_hash: "blake2b256:test",
              target_credential: target,
              public_input: "0x1",
              proof: "proof",
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            verified: true,
            circuit_id: "root-ownership-v1/bls12-381/groth16",
            vk_hash: "blake2b256:test",
            target_credential: target,
            public_input: "0x1",
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetch);

    renderPaired(<ProofFlow createWorker={fakeWorkerSuccess} />);

    await screen.findByText("Helper connected");
    expect(screen.queryByLabelText("Pairing token")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Helper URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Verifier URL")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Payment key credential"), { target: { value: target } });
    fireEvent.change(screen.getByLabelText("Recovery phrase"), { target: { value: "valid phrase" } });
    fireEvent.click(screen.getByRole("button", { name: /generate proof/i }));

    expect(await screen.findByText("Proof Artifact")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /verify proof/i }));

    await waitFor(() => expect(screen.getByText("This proof matches the payment key credential.")).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:18080/prove",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Proof-Tool-Token": "token" }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "/api/verify",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("shows update-required helper state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ connected: true, compatibility: "update_required" }), { status: 200 }),
      ),
    );

    renderPaired(<ProofFlow createWorker={fakeWorkerSuccess} />);

    expect(await screen.findByText("Update Proof Helper")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Payment key credential"), { target: { value: target } });
    fireEvent.change(screen.getByLabelText("Recovery phrase"), { target: { value: "valid phrase" } });
    fireEvent.click(screen.getByRole("button", { name: /generate proof/i }));

    expect(await screen.findByText("Action needed")).toBeInTheDocument();
    expect(screen.getByText("Update Proof Helper before generating a proof.")).toBeInTheDocument();
  });
});

function readyHelperStatus() {
  return {
    connected: true,
    compatibility: "ready",
    key_ready: true,
    key_state: "ready",
    protocol_version: "proof-helper-v1",
    sidecar_version: "0.1.0",
  };
}

function renderPaired(element: React.ReactElement) {
  window.history.replaceState(
    null,
    "",
    "/#helper=http%3A%2F%2F127.0.0.1%3A18080&pair=token",
  );
  return render(element);
}

function fakeWorkerSuccess() {
  return makeFakeWorker({
    id: "",
    type: "master-xprv",
    masterXPrv: new Uint8Array(96).buffer,
  });
}

function fakeWorkerError() {
  return makeFakeWorker({
    id: "",
    type: "error",
    code: "invalid_mnemonic",
    message: "The seed phrase is not a valid recovery phrase.",
  });
}

function makeFakeWorker(response: { id: string; type: string; masterXPrv?: ArrayBuffer; code?: string; message?: string }) {
  let listener: ((event: MessageEvent) => void) | null = null;
  return {
    postMessage(message: { id: string }) {
      window.setTimeout(() => {
        listener?.({ data: { ...response, id: message.id } } as MessageEvent);
      }, 0);
    },
    terminate() {},
    addEventListener(_type: "message", next: (event: MessageEvent) => void) {
      listener = next;
    },
    removeEventListener() {
      listener = null;
    },
  };
}
