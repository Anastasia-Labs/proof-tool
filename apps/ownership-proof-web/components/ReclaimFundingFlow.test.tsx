import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReclaimFundingFlow } from "./ReclaimFundingFlow";

const credential = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";
const walletAddress = "addr_test1vqv7qlaucathxkwkc503ujw0rv9lfj2rkj96feyst2rs9eqqyas5r";
const walletAddressHex = "6019e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";
const usedWalletAddress = "addr_test1vq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygswahgq5";
const usedWalletAddressHex = "6022222222222222222222222222222222222222222222222222222222";
const tokenUnit = `${"a".repeat(56)}4e4654`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ReclaimFundingFlow", () => {
  it("shows unavailable deployment configuration", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            available: false,
            deployment: null,
            missing: ["RECLAIM_BASE_ADDRESS"],
          }),
          { status: 200 },
        ),
      ),
    );

    render(<ReclaimFundingFlow />);

    expect(await screen.findByText("Reclaim deployment unavailable")).toBeInTheDocument();
    expect(screen.getByText("RECLAIM_BASE_ADDRESS")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeDisabled();
  });

  it("builds a multi-asset transaction and submits wallet witnesses", async () => {
    const signTx = vi.fn().mockResolvedValue("witness-cbor");
    const getUnusedAddresses = vi.fn().mockResolvedValue([walletAddressHex]);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            available: true,
            deployment: deployment(),
            missing: [],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            changeAddress: walletAddress,
            walletAddresses: [walletAddress, usedWalletAddress],
            network: "Preprod",
            networkId: 0,
            utxoCount: 2,
            assets: {
              lovelace: "3000000",
              [tokenUnit]: "5",
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            txCbor: "84a400",
            txHash: "body-hash",
            review: {
              changeAddress: walletAddress,
              walletAddresses: [walletAddress, usedWalletAddress],
              reclaimBaseAddress: deployment().reclaimBaseAddress,
              compromisedCredential: credential,
              datumCbor: "d8799f581c19e07fbcff",
              assets: {
                lovelace: "1500000",
                [tokenUnit]: "2",
              },
              network: "Preprod",
              deploymentId: deployment().id,
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ txHash: "submitted-hash" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    Object.defineProperty(window, "cardano", {
      configurable: true,
      value: {
        nami: {
          name: "Nami",
          enable: vi.fn().mockResolvedValue({
            getNetworkId: vi.fn().mockResolvedValue(0),
            getUsedAddresses: vi.fn().mockResolvedValue([usedWalletAddressHex]),
            getChangeAddress: vi.fn().mockResolvedValue(walletAddressHex),
            getUnusedAddresses,
            signTx,
          }),
        },
      },
    });

    render(<ReclaimFundingFlow />);

    await screen.findByText("Preprod deployment ready");
    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));

    await screen.findByText("2 CIP-30 wallet addresses loaded");
    expect(screen.queryByRole("textbox", { name: /change address/i })).not.toBeInTheDocument();
    expect(getUnusedAddresses).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Payment key credential"), { target: { value: credential } });
    fireEvent.change(screen.getByLabelText("ADA amount"), { target: { value: "1.5" } });
    fireEvent.change(screen.getByPlaceholderText("policyId + tokenName hex"), { target: { value: tokenUnit } });
    fireEvent.change(screen.getByPlaceholderText("0"), { target: { value: "2" } });

    fireEvent.click(screen.getByRole("button", { name: /refresh assets/i }));
    expect(await screen.findByText("2 UTxOs, 2 assets")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /build transaction/i }));
    expect(await screen.findByText("Datum CBOR")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /sign and submit/i }));

    expect(await screen.findByText("Transaction submitted")).toBeInTheDocument();
    expect(screen.getByText("submitted-hash")).toBeInTheDocument();
    expect(signTx).toHaveBeenCalledWith("84a400", true);
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "/reclaim-api/build",
      expect.objectContaining({
        body: JSON.stringify({
          changeAddress: walletAddress,
          walletAddresses: [walletAddress, usedWalletAddress],
          networkId: 0,
          compromisedCredential: credential,
          assets: {
            lovelace: "1500000",
            [tokenUnit]: "2",
          },
          deploymentId: deployment().id,
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      "/reclaim-api/submit",
      expect.objectContaining({
        body: JSON.stringify({
          unsignedTxCbor: "84a400",
          witnessSetCbor: "witness-cbor",
        }),
      }),
    );
  });
});

function deployment() {
  return {
    id: "Preprod:script-hash:commit",
    network: "Preprod",
    networkId: 0,
    reclaimBaseAddress: "addr_test1wreclaimbase00000000000000000000000000000000000000000",
    reclaimBaseScriptHash: "script-hash",
    reclaimGlobalCredential: "global-credential",
    reclaimGlobalScriptHash: "global-script-hash",
    paramsCurrencySymbol: "params-policy",
    paramsTokenName: "params-token",
    verifierVkHash: "vk-hash",
    contractVersion: "v1",
    sourceCommit: "commit",
  };
}
