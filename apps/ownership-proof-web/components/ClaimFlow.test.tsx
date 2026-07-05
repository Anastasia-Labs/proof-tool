import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaimFlow } from "./ClaimFlow";

const credential = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";
const usedCredential = "22222222222222222222222222222222222222222222222222222222";
const unrelatedCredential = "33333333333333333333333333333333333333333333333333333333";
const walletAddressHex = `60${credential}`;
const usedWalletAddressHex = `60${usedCredential}`;
const tokenUnit = `${"a".repeat(56)}4e4654`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(window, "cardano");
  window.history.replaceState(null, "", "/");
});

describe("ClaimFlow", () => {
  it("uses the gated fixture state from the query string", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    window.history.replaceState(null, "", "/claim?fixtureState=create-proofs-ready");

    render(<ClaimFlow />);

    expect(await screen.findByRole("heading", { name: "Create proofs" })).toBeInTheDocument();
    expect(screen.getByText(/Your recovery phrase is sent only to the Proof Helper/i)).toBeInTheDocument();
  });

  it("ignores fixture state query strings when fixture mode is disabled", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(claimDeployment()), { status: 200 })));
    window.history.replaceState(null, "", "/claim?fixtureState=claim-review-complete");

    render(<ClaimFlow />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Review deployment" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Claim review" })).not.toBeInTheDocument();
  });

  it("keeps Proof Helper out of the canonical progress rail", () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    render(<ClaimFlow />);

    const rail = screen.getByLabelText("Claim progress");
    expect(rail).toHaveTextContent("1. Deployment");
    expect(rail).toHaveTextContent("4. Safe Wallet");
    expect(rail).toHaveTextContent("5. Create Proofs");
    expect(rail).not.toHaveTextContent("Proof Helper");
  });

  it("shows impacted wallet as discovery-only", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    window.history.replaceState(null, "", "/claim?fixtureState=impacted-wallet");

    render(<ClaimFlow />);

    expect(await screen.findByRole("heading", { name: "Connect impacted wallet" })).toBeInTheDocument();
    expect(screen.getByText(/will not sign a transaction with the impacted wallet/i)).toBeInTheDocument();
    expect(screen.queryByText("signTx")).not.toBeInTheDocument();
  });

  it("renders and closes the UTxO asset modal fixture", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    window.history.replaceState(null, "", "/claim?fixtureState=available-claims-asset-modal");

    render(<ClaimFlow />);

    expect(await screen.findByRole("dialog", { name: "UTxO assets" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done reviewing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "UTxO assets" })).not.toBeInTheDocument());
  });

  it("discovers matching claim UTxOs with impacted wallet public reads only", async () => {
    const signTx = vi.fn();
    const enable = vi.fn().mockResolvedValue({
      getNetworkId: vi.fn().mockResolvedValue(0),
      getChangeAddress: vi.fn().mockResolvedValue(walletAddressHex),
      getUsedAddresses: vi.fn().mockResolvedValue([usedWalletAddressHex]),
      signTx,
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(claimDeployment()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(reclaimUtxos()), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    Object.defineProperty(window, "cardano", {
      configurable: true,
      value: {
        nami: {
          name: "Nami",
          enable,
        },
      },
    });

    render(<ClaimFlow />);

    fireEvent.click(await screen.findByRole("button", { name: "I reviewed deployment" }));
    expect(await screen.findByRole("heading", { name: "Connect impacted wallet" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect impacted wallet" }));

    expect(await screen.findByRole("heading", { name: "Available claims" })).toBeInTheDocument();
    expect(screen.getAllByText("1.5 ADA").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("1 asset")).toBeInTheDocument();
    expect(screen.queryByText("9 ADA")).not.toBeInTheDocument();
    expect(screen.queryByText("2 ADA")).not.toBeInTheDocument();
    expect(signTx).not.toHaveBeenCalled();

    const indexCall = fetch.mock.calls.find(([url]) => String(url).startsWith("/claim-api/reclaim-utxos"));
    expect(indexCall).toBeDefined();
    expect(String(indexCall?.[0])).toBe("/claim-api/reclaim-utxos?limit=100");
    expect(indexCall?.[1]).toBeUndefined();
    expect(String(indexCall?.[0])).not.toContain(credential);
  });

  it("blocks impacted wallet scans on the wrong network", async () => {
    const signTx = vi.fn();
    const enable = vi.fn().mockResolvedValue({
      getNetworkId: vi.fn().mockResolvedValue(1),
      getChangeAddress: vi.fn().mockResolvedValue(walletAddressHex),
      getUsedAddresses: vi.fn().mockResolvedValue([usedWalletAddressHex]),
      signTx,
    });
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(claimDeployment()), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    Object.defineProperty(window, "cardano", {
      configurable: true,
      value: {
        nami: {
          name: "Nami",
          enable,
        },
      },
    });

    render(<ClaimFlow />);

    fireEvent.click(await screen.findByRole("button", { name: "I reviewed deployment" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect impacted wallet" }));

    expect(await screen.findByText(/This wallet is not on Preprod/i)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signTx).not.toHaveBeenCalled();
  });
});

function claimDeployment() {
  return {
    available: true,
    deployment: {
      id: "preprod:reclaim-base:commit",
      network: "Preprod",
      networkId: 0,
      reclaimBaseAddress: "addr_test1wreclaimbase00000000000000000000000000000000000000000",
      reclaimBaseScriptHash: "a".repeat(56),
      reclaimGlobalCredential: "b".repeat(56),
      reclaimGlobalScriptHash: "c".repeat(56),
      paramsCurrencySymbol: "d".repeat(56),
      paramsTokenName: "",
      verifierVkHash: "e".repeat(64),
      contractVersion: "v1",
      sourceCommit: "f".repeat(40),
      paramsUtxo: {
        tx_hash: "1".repeat(64),
        output_index: 0,
        policy_id: "d".repeat(56),
        token_name: "",
        holder_address: "addr_test1wparams00000000000000000000000000000000000000000000",
        datum_reclaim_base_script_hash: "a".repeat(56),
      },
      batching: {
        default_utxo_count: 4,
        optimization_utxo_count: 5,
        hard_max_utxo_count: 5,
        max_tx_cpu_percent: 70,
        max_tx_mem_percent: 70,
      },
    },
    manifest: {},
    readiness: { funding: true, claiming: true, reasons: [] },
    provider: { configured: true },
    missing: [],
    errors: [],
    capabilities: {},
  };
}

function reclaimUtxos() {
  return {
    available: true,
    deploymentId: "preprod:reclaim-base:commit",
    network: "Preprod",
    indexer: {
      providerBacked: true,
      status: "available",
    },
    page: {
      limit: 100,
      cursor: null,
      nextCursor: null,
      total: 4,
    },
    utxos: [
      indexedUtxo({
        txHash: "a".repeat(64),
        outputIndex: 0,
        paymentCredential: credential,
        value: {
          lovelace: "1500000",
          [tokenUnit]: "1",
        },
      }),
      indexedUtxo({
        txHash: "b".repeat(64),
        outputIndex: 0,
        paymentCredential: unrelatedCredential,
        value: {
          lovelace: "9000000",
        },
      }),
      indexedUtxo({
        txHash: "c".repeat(64),
        outputIndex: 0,
        paymentCredential: credential,
        state: "pending",
        value: {
          lovelace: "2000000",
        },
      }),
      {
        ...indexedUtxo({
          txHash: "d".repeat(64),
          outputIndex: 0,
          paymentCredential: credential,
          value: {
            lovelace: "3000000",
          },
        }),
        datum: {
          status: "malformed_datum",
          reason: "bad datum",
        },
      },
    ],
  };
}

function indexedUtxo({
  txHash,
  outputIndex,
  paymentCredential,
  value,
  state = "unspent",
}: {
  txHash: string;
  outputIndex: number;
  paymentCredential: string;
  value: Record<string, string>;
  state?: "unspent" | "pending";
}) {
  return {
    outRef: { txHash, outputIndex },
    outRefId: `${txHash}#${outputIndex}`,
    address: "addr_test1wreclaimbase00000000000000000000000000000000000000000",
    value,
    datum: {
      status: "valid",
      paymentCredential,
    },
    datumCbor: "d8799f",
    state,
    deploymentId: "preprod:reclaim-base:commit",
    confirmation: {
      slot: 10,
    },
  };
}
