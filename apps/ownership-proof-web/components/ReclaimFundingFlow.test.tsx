import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("ReclaimFundingFlow", () => {
  it("renders loading deployment with disabled wallet and form controls", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    render(<ReclaimFundingFlow />);

    expect(document.querySelector('[data-lock-funds-state="loading-deployment"]')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeDisabled();
    expect(screen.getByLabelText("Payment key credential")).toBeDisabled();
    expect(screen.queryByRole("link", { name: /^Proof$/i })).not.toBeInTheDocument();
  });

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

  it("shows credential format warning without losing wallet context", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            available: true,
            deployment: deployment(),
            missing: [],
          }),
          { status: 200 },
        ),
      ),
    );
    Object.defineProperty(window, "cardano", {
      configurable: true,
      value: {
        lace: {
          name: "Lace",
          enable: vi.fn().mockResolvedValue({
            getNetworkId: vi.fn().mockResolvedValue(0),
            getUsedAddresses: vi.fn().mockResolvedValue([usedWalletAddressHex]),
            getChangeAddress: vi.fn().mockResolvedValue(walletAddressHex),
            signTx: vi.fn(),
          }),
        },
      },
    });

    render(<ReclaimFundingFlow />);

    await screen.findByText("Preprod deployment ready");
    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));
    await screen.findByText("2 CIP-30 wallet addresses loaded");
    fireEvent.change(screen.getByLabelText("Payment key credential"), { target: { value: "bad-credential" } });

    expect(await screen.findByText("Credential format")).toBeInTheDocument();
    expect(screen.getByText("2 CIP-30 wallet addresses loaded")).toBeInTheDocument();
  });

  it.each([
    ["loading-deployment", "Loading deployment"],
    ["deployment-unavailable", "Reclaim deployment unavailable"],
    ["ready-idle", "Not connected"],
    ["wallet-connected", "2 CIP-30 wallet addresses loaded"],
    ["credential-format-warning", "Credential format"],
    ["assets-loaded", "2 UTxOs, 2 assets"],
    ["building-transaction", "Building unsigned tx"],
    ["review-built", "Ready for wallet signature"],
    ["signing-awaiting-wallet", "Awaiting wallet"],
    ["submitted", "Funds locked"],
    ["failed-build", "Mock build rejected for screenshot coverage."],
  ])("renders fixture state %s", async (fixtureState, expectedText) => {
    window.history.replaceState(null, "", `/reclaim?fixtureState=${fixtureState}`);

    render(<ReclaimFundingFlow />);

    expect(document.querySelector(`[data-lock-funds-state="${fixtureState}"]`)).toBeInTheDocument();
    expect((await screen.findAllByText(expectedText)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: /^Proof$/i })).not.toBeInTheDocument();
  });

  it("keeps Build Transaction disabled with a visible reason until a valid credential is entered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            available: true,
            deployment: deployment(),
            missing: [],
          }),
          { status: 200 },
        ),
      ),
    );
    Object.defineProperty(window, "cardano", {
      configurable: true,
      value: {
        lace: {
          name: "Lace",
          enable: vi.fn().mockResolvedValue({
            getNetworkId: vi.fn().mockResolvedValue(0),
            getUsedAddresses: vi.fn().mockResolvedValue([usedWalletAddressHex]),
            getChangeAddress: vi.fn().mockResolvedValue(walletAddressHex),
            signTx: vi.fn(),
          }),
        },
      },
    });

    render(<ReclaimFundingFlow />);
    await screen.findByText("Preprod deployment ready");

    const credentialInput = screen.getByLabelText("Payment key credential");
    expect(credentialInput).toBeRequired();
    expect(credentialInput).toHaveAttribute("placeholder", "Paste the 56-character payment key hash");

    const buildButton = screen.getByRole("button", { name: /build transaction/i });
    expect(buildButton).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Connect the funding wallet to continue.");

    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));
    await screen.findByText("2 CIP-30 wallet addresses loaded");
    fireEvent.change(screen.getByLabelText("ADA amount"), { target: { value: "1.5" } });

    expect(buildButton).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Enter the compromised credential to continue.");
    expect(screen.getAllByText("Enter the compromised credential to continue.").length).toBe(2);
    expect(screen.getByText("Awaiting requirements")).toBeInTheDocument();
    expect(screen.queryByText("Ready to build")).not.toBeInTheDocument();

    fireEvent.change(credentialInput, { target: { value: credential } });

    expect(buildButton).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("Enter the compromised credential to continue.")).not.toBeInTheDocument();
    expect(screen.getByText("Ready to build")).toBeInTheDocument();
    expect(screen.queryByText("Awaiting requirements")).not.toBeInTheDocument();
  });

  it("explains an invalid credential beside the disabled build button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            available: true,
            deployment: deployment(),
            missing: [],
          }),
          { status: 200 },
        ),
      ),
    );
    Object.defineProperty(window, "cardano", {
      configurable: true,
      value: {
        lace: {
          name: "Lace",
          enable: vi.fn().mockResolvedValue({
            getNetworkId: vi.fn().mockResolvedValue(0),
            getUsedAddresses: vi.fn().mockResolvedValue([usedWalletAddressHex]),
            getChangeAddress: vi.fn().mockResolvedValue(walletAddressHex),
            signTx: vi.fn(),
          }),
        },
      },
    });

    render(<ReclaimFundingFlow />);
    await screen.findByText("Preprod deployment ready");
    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));
    await screen.findByText("2 CIP-30 wallet addresses loaded");
    fireEvent.change(screen.getByLabelText("ADA amount"), { target: { value: "1.5" } });
    fireEvent.change(screen.getByLabelText("Payment key credential"), { target: { value: "bad-credential" } });

    const buildButton = screen.getByRole("button", { name: /build transaction/i });
    expect(buildButton).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Use a 28-byte hex payment credential.");
    expect(screen.queryByText("Ready to build")).not.toBeInTheDocument();
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
            reviewHash: "review-hash",
            reviewToken: "review-token",
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

    fireEvent.click(screen.getByRole("button", { name: /refresh assets/i }));
    expect(await screen.findByText("2 UTxOs, 2 assets")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^token$/i }));

    const tokenDialog = await screen.findByRole("dialog", { name: /add token from wallet/i });
    expect(tokenDialog).toBeInTheDocument();
    expect(within(tokenDialog).getAllByText("NFT").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Amount to lock"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /add token/i }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /add token from wallet/i })).not.toBeInTheDocument();
    });
    expect(screen.getByText("NFT")).toBeInTheDocument();

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
          reviewToken: "review-token",
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
          unsignedTxCbor: "84a400",
          witnessSetCbor: "witness-cbor",
        }),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /lock another batch/i }));
    fireEvent.change(screen.getByPlaceholderText("0"), { target: { value: "3" } });

    await waitFor(() => {
      expect(screen.queryByText("Transaction submitted")).not.toBeInTheDocument();
      expect(screen.queryByText("Datum CBOR")).not.toBeInTheDocument();
    });
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
