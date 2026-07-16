import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { bech32 } from "bech32";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaimFlow, selectClaimBatchRows } from "./ClaimFlow";
import { acknowledgePairing, broadcastPairing, subscribeToPairing } from "../lib/proving/helper-pairing-relay";

const credential = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4";
const usedCredential = "22222222222222222222222222222222222222222222222222222222";
const unrelatedCredential = "33333333333333333333333333333333333333333333333333333333";
const safeCredential = "44444444444444444444444444444444444444444444444444444444";
const changedSafeCredential = "55555555555555555555555555555555555555555555555555555555";
const walletAddressHex = `60${credential}`;
const usedWalletAddressHex = `60${usedCredential}`;
const safeWalletAddressHex = `60${safeCredential}`;
const safeWalletAddressBech32 = cip30HexAddressToBech32(safeWalletAddressHex);
const changedSafeWalletAddressHex = `60${changedSafeCredential}`;
const baseAddressWithStakeCredentialHex = `00${safeCredential}${credential}`;
const rewardAddressHex = `e0${credential}`;
const tokenUnit = `${"a".repeat(56)}4e4654`;
const recoveryPhrase24 =
  "gown cactus human cat slide give prepare update kite attitude author describe primary wise robot armor giraffe salon tide bomb assault there together bronze";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(window, "cardano");
  Reflect.deleteProperty(window.navigator, "clipboard");
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

function cip30HexAddressToBech32(value: string): string {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bech32.encode("addr_test", bech32.toWords(bytes), 1000);
}

describe("ClaimFlow", () => {
  it("keeps statement-bound V2 automatic selection at six even when the manifest advertises seven", () => {
    const rows: Parameters<typeof selectClaimBatchRows>[0] = Array.from({ length: 7 }, (_, index) => ({
      id: index,
      tx: String(index),
      output: 0,
      credential,
      ada: "1 ADA",
      assets: "No tokens",
      summary: [],
      outRefId: `${(index + 1).toString(16).padStart(64, "0")}#0`,
      confirmationSlot: index,
    }));
    const deployment = {
      available: true,
      deployment: {
        ...claimDeployment().deployment,
        reclaimGlobalProofSlotEncoding: "full-proof-plus-public-input-digest-v2",
        batching: {
          default_utxo_count: 7,
          optimization_utxo_count: 7,
          hard_max_utxo_count: 7,
          max_tx_cpu_percent: 90,
          max_tx_mem_percent: 80,
          distinct_7_opt_in: {
            request_parameter: "maxUtxos",
            request_value: 7,
            require_explicit_request: true,
            require_measured_execution_units: true,
          },
        },
      },
    } as Parameters<typeof selectClaimBatchRows>[2];

    expect(selectClaimBatchRows(rows, [], deployment)).toHaveLength(6);
    expect(selectClaimBatchRows(rows, [], deployment, 7)).toHaveLength(7);
  });

  it("offers the explicit V2 seven-slot opt-in and drafts seven duplicate credentials without a uniqueness gate", async () => {
    const selectedOutrefs = Array.from({ length: 7 }, (_, index) => `${(index + 1).toString(16).padStart(64, "0")}#${index}`);
    const draft = claimDraft(selectedOutrefs);
    const draftRequests: Array<Record<string, unknown>> = [];
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const urlText = String(url);
        if (urlText === "/claim-api/deployment") {
          return jsonResponse(statementBoundV2Deployment());
        }
        if (urlText.startsWith("/claim-api/reclaim-utxos")) {
          return jsonResponse(reclaimUtxosWithMatching(7));
        }
        if (urlText === "/claim-api/draft") {
          draftRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return jsonResponse(draft);
        }
        throw new Error(`Unexpected fetch ${urlText}`);
      }),
    );

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect impacted wallet" }));
    expect(await screen.findByRole("heading", { name: "Available claims" })).toBeInTheDocument();
    const optIn = screen.getByRole("checkbox", { name: "Use seven UTxOs for the next batch" });
    expect(optIn).not.toBeChecked();
    fireEvent.click(optIn);
    expect(optIn).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Continue to safe wallet" }));
    fireEvent.click(await findSafeWalletOption());
    fireEvent.click(screen.getByRole("button", { name: "Connect safe wallet" }));

    await waitFor(() => expect(draftRequests).toHaveLength(1));
    expect(draftRequests[0]).toMatchObject({
      maxUtxos: 7,
      selectedOutrefs,
    });
  });

  it("retains manifest-driven automatic capacity for legacy claim profiles", () => {
    const rows: Parameters<typeof selectClaimBatchRows>[0] = Array.from({ length: 8 }, (_, index) => ({
      id: index,
      tx: String(index),
      output: 0,
      credential,
      ada: "1 ADA",
      assets: "No tokens",
      summary: [],
      outRefId: `${(index + 1).toString(16).padStart(64, "0")}#0`,
      confirmationSlot: index,
    }));
    const deployment = {
      available: true,
      deployment: {
        ...claimDeployment().deployment,
        reclaimGlobalProofSlotEncoding: "bytes-empty-same-as-previous-v1",
        batching: {
          default_utxo_count: 8,
          optimization_utxo_count: 8,
          hard_max_utxo_count: 8,
          max_tx_cpu_percent: 80,
          max_tx_mem_percent: 80,
        },
      },
    } as Parameters<typeof selectClaimBatchRows>[2];

    expect(selectClaimBatchRows(rows, [], deployment)).toHaveLength(8);
  });

  it("uses the gated fixture state from the query string", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    window.history.replaceState(null, "", "/claim?fixtureState=create-proofs-ready");

    render(<ClaimFlow />);

    expect(await screen.findByRole("heading", { name: "Create proofs" })).toBeInTheDocument();
    expect(screen.getByText(/Browser proving is not enabled for this build yet/i)).toBeInTheDocument();
  });

  it("pastes the clipboard phrase into the default 24-word proof inputs", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    window.history.replaceState(null, "", "/claim?fixtureState=create-proofs-ready");
    const { readText, writeText } = installClipboard(recoveryPhrase24);

    render(<ClaimFlow />);

    expect(await screen.findByRole("heading", { name: "Create proofs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "24 words" })).toHaveAttribute("aria-pressed", "true");
    const recoveryInputs = screen.getAllByLabelText(/Recovery word \d+/) as HTMLInputElement[];
    expect(recoveryInputs).toHaveLength(24);

    fireEvent.click(screen.getByRole("button", { name: "Paste phrase" }));

    await waitFor(() => expect(recoveryInputs[23].value).toBe("bronze"));
    expect(recoveryInputs.map((input) => input.value)).toEqual(recoveryPhrase24.split(" "));
    expect(readText).toHaveBeenCalledTimes(1);
    // C27: after a successful paste the clipboard is overwritten best-effort.
    await waitFor(() => expect(screen.getByText(/Pasted 24 words\. We cleared your clipboard\./i)).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith("");
  });

  it("auto-switches the phrase length when the clipboard phrase has a supported word count", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    window.history.replaceState(null, "", "/claim?fixtureState=create-proofs-ready");
    installClipboard(recoveryPhrase24);

    render(<ClaimFlow />);

    expect(await screen.findByRole("heading", { name: "Create proofs" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "12 words" }));
    expect(screen.getAllByLabelText(/Recovery word \d+/)).toHaveLength(12);

    fireEvent.click(screen.getByRole("button", { name: "Paste phrase" }));

    await waitFor(() => expect(screen.getAllByLabelText(/Recovery word \d+/)).toHaveLength(24));
    const recoveryInputs = screen.getAllByLabelText(/Recovery word \d+/) as HTMLInputElement[];
    await waitFor(() => expect(recoveryInputs[23].value).toBe("bronze"));
    expect(recoveryInputs.map((input) => input.value)).toEqual(recoveryPhrase24.split(" "));
    await waitFor(() => expect(screen.getByText(/Pasted 24 words\. We cleared your clipboard\./i)).toBeInTheDocument());
  });

  it("fills all proof inputs when the browser sends a full phrase paste event to a word field", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    window.history.replaceState(null, "", "/claim?fixtureState=create-proofs-ready");

    render(<ClaimFlow />);

    expect(await screen.findByRole("heading", { name: "Create proofs" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Paste phrase" }));
    const recoveryInputs = screen.getAllByLabelText(/Recovery word \d+/) as HTMLInputElement[];
    expect(recoveryInputs[0]).toHaveFocus();
    expect(screen.getByText(/Clipboard access is not available here/i)).toBeInTheDocument();

    fireEvent.paste(recoveryInputs[0], {
      clipboardData: {
        getData: () => recoveryPhrase24,
      },
    });

    await waitFor(() => expect(recoveryInputs[23].value).toBe("bronze"));
    expect(recoveryInputs.map((input) => input.value)).toEqual(recoveryPhrase24.split(" "));
    // No clipboard API is available here, so the user is told to clear it.
    await waitFor(() =>
      expect(screen.getByText(/Pasted 24 words\. Clear your clipboard now — copy anything else to overwrite it\./i)).toBeInTheDocument(),
    );
  });

  it("lets the user choose 12, 15, or 24 recovery words", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    window.history.replaceState(null, "", "/claim?fixtureState=create-proofs-ready");

    render(<ClaimFlow />);

    expect(await screen.findByRole("heading", { name: "Create proofs" })).toBeInTheDocument();
    expect(screen.getAllByLabelText(/Recovery word \d+/)).toHaveLength(24);

    fireEvent.click(screen.getByRole("button", { name: "12 words" }));
    expect(screen.getByRole("button", { name: "12 words" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByLabelText(/Recovery word \d+/)).toHaveLength(12);

    fireEvent.click(screen.getByRole("button", { name: "15 words" }));
    expect(screen.getByRole("button", { name: "15 words" })).toHaveAttribute("aria-pressed", "true");
    const recoveryInputs = screen.getAllByLabelText(/Recovery word \d+/) as HTMLInputElement[];
    expect(recoveryInputs).toHaveLength(15);
    expect(recoveryInputs.every((input) => input.type === "password")).toBe(true);

    fireEvent.click(screen.getByLabelText("Show words"));
    expect(recoveryInputs.every((input) => input.type === "text")).toBe(true);
  });

  it("defaults to browser proving and opens the desktop installer chooser when desktop is selected", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    window.history.replaceState(null, "", "/claim?fixtureState=helper-unavailable");

    render(<ClaimFlow />);

    expect(await screen.findByRole("heading", { name: "Create proofs" })).toBeInTheDocument();
    const localHelperTile = screen.getByText("Local proof method").closest("section");
    expect(localHelperTile).not.toBeNull();
    expect(within(localHelperTile as HTMLElement).getByText("Prove in browser")).toBeInTheDocument();
    expect(within(localHelperTile as HTMLElement).getByText("Unavailable", { selector: "small" })).toHaveClass("bad");

    fireEvent.click(within(localHelperTile as HTMLElement).getByRole("button", { name: "Choose method" }));

    const methodDialog = await screen.findByRole("dialog", { name: "Choose how to create proofs" });
    expect(within(methodDialog).getByRole("radio", { name: /Prove in this browser/i })).toHaveAttribute("aria-checked", "true");
    expect(within(methodDialog).queryByText("Experimental")).not.toBeInTheDocument();
    expect(within(methodDialog).getByText(/Windows, macOS, or Linux/i)).toBeInTheDocument();
    expect(within(methodDialog).getByText(/About 2 minutes per proof/i)).toBeInTheDocument();
    fireEvent.click(within(methodDialog).getByRole("radio", { name: /Proof Helper Desktop/i }));
    fireEvent.click(within(methodDialog).getByRole("button", { name: "Continue to desktop app" }));

    const dialog = await screen.findByRole("dialog", { name: "Choose your installer" });
    expect(within(dialog).getByRole("link", { name: /Windows/i })).toHaveAttribute(
      "href",
      "https://github.com/Anastasia-Labs/proof-tool-release/releases/download/proof-helper-desktop-v0.2.1/proof-helper_0.2.1_windows_x64_setup.exe",
    );
    expect(within(dialog).getByRole("link", { name: /macOS/i })).toHaveAttribute(
      "href",
      "https://github.com/Anastasia-Labs/proof-tool-release/releases/download/proof-helper-v0.1.0/proof-helper_0.1.0_macos_universal.zip",
    );
    expect(within(dialog).getByRole("link", { name: /Linux/i })).toHaveAttribute(
      "href",
      "https://github.com/Anastasia-Labs/proof-tool-release/releases/download/proof-helper-desktop-v0.2.2/proof-helper_0.2.2_linux_x86_64.AppImage",
    );
    expect(within(dialog).getByText("Download AppImage")).toBeInTheDocument();
    expect(within(dialog).getByText("263592681101d7edaeed071d02758ed570a6187072939479f9d3ead763b9745c")).toBeInTheDocument();
    expect(within(dialog).getByText("sha256sum -c proof-helper_0.2.2_linux_x86_64.AppImage.sha256")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Download checksum" })).toHaveAttribute(
      "href",
      "https://github.com/Anastasia-Labs/proof-tool-release/releases/download/proof-helper-desktop-v0.2.2/proof-helper_0.2.2_linux_x86_64.AppImage.sha256",
    );
    expect(within(dialog).getByRole("link", { name: "Verification and launch instructions" })).toHaveAttribute(
      "href",
      "https://github.com/Anastasia-Labs/proof-tool-release/releases/download/proof-helper-desktop-v0.2.2/VERIFY-LINUX.md",
    );
    expect(within(dialog).getByText("Windows zip start command")).toBeInTheDocument();
    expect(within(dialog).getByText(/Start Proof Helper\.bat/)).toHaveTextContent(
      '".\\Start Proof Helper.bat" "http://localhost:3000/claim?fixtureState=helper-unavailable"',
    );
  });

  it("blocks the browser proof method until preflight reports ready", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    window.history.replaceState(null, "", "/claim?fixtureState=create-proofs-ready");

    render(<ClaimFlow />);

    expect(await screen.findByRole("heading", { name: "Create proofs" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Choose method" })[0]);
    const methodDialog = await screen.findByRole("dialog", { name: "Choose how to create proofs" });

    // The readiness section renders and Continue stays disabled while proving
    // is not verified (fixture mode never enables the descriptor).
    expect(within(methodDialog).getByRole("radio", { name: /Prove in this browser/i })).toHaveAttribute("aria-checked", "true");
    expect(within(methodDialog).queryByText("Experimental")).not.toBeInTheDocument();
    expect(within(methodDialog).getByText(/Cross-origin isolated/i)).toBeInTheDocument();
    const continueButton = within(methodDialog).getByRole("button", { name: /Continue/i });
    expect(continueButton).toBeDisabled();
  });

  it("surfaces the browser blocked reason on the Create proofs screen", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    window.history.replaceState(null, "", "/claim?fixtureState=create-proofs-ready");

    render(<ClaimFlow />);

    expect(await screen.findByRole("heading", { name: "Create proofs" })).toBeInTheDocument();

    const summaryTile = screen.getByText("Local proof method").closest("section");
    expect(summaryTile).not.toBeNull();
    expect(within(summaryTile as HTMLElement).getByText("Prove in browser")).toBeInTheDocument();
    // Generate proofs remains disabled because the browser path is not ready.
    expect(screen.getByRole("button", { name: /Generate proofs/i })).toBeDisabled();
  });

  it("ignores fixture state query strings when fixture mode is disabled", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(claimDeployment()), { status: 200 })));
    window.history.replaceState(null, "", "/claim?fixtureState=claim-review-complete");

    render(<ClaimFlow />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Verify this recovery service" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /view commit on github/i })).toHaveAttribute(
      "href",
      `https://github.com/Anastasia-Labs/proof-tool/commit/${"f".repeat(40)}`,
    );
    expect(screen.getByText(/github\.com\/Anastasia-Labs\/proof-tool\/commit/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Claim review" })).not.toBeInTheDocument();
  });

  it("detects Lace when the extension injects its provider after the initial render", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(claimDeployment())));

    render(<ClaimFlow />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("button", { name: /No wallet found/i })).toBeDisabled();

    Object.defineProperty(window, "cardano", {
      configurable: true,
      value: {
        lace: {
          name: "Lace",
          enable: vi.fn(),
        },
      },
    });
    await act(async () => {
      window.dispatchEvent(new Event("cardano#initialized"));
    });

    await waitFor(() => {
      expect(screen.getAllByRole("button").some(
        (button) => button.querySelector("strong")?.textContent?.includes("Lace"),
      )).toBe(true);
    });
    expect(screen.queryByRole("button", { name: /No wallet found/i })).not.toBeInTheDocument();
  });

  it("keeps Proof Helper out of the canonical progress rail", () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    render(<ClaimFlow />);

    const rail = screen.getByLabelText("Claim progress");
    expect(rail).toHaveTextContent("1. Verify service");
    expect(rail).toHaveTextContent("4. Safe wallet");
    expect(rail).toHaveTextContent("5. Create proofs");
    expect(rail).toHaveTextContent("6. Claim funds");
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
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
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

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Connect impacted wallet" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect impacted wallet" }));

    expect(await screen.findByRole("heading", { name: "Available claims" })).toBeInTheDocument();
    expect(screen.getAllByText("1.5 ADA").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("1 token").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("9 ADA")).not.toBeInTheDocument();
    expect(screen.queryByText("2 ADA")).not.toBeInTheDocument();
    expect(signTx).not.toHaveBeenCalled();

    const indexCall = fetch.mock.calls.find(([url]) => String(url).startsWith("/claim-api/reclaim-utxos"));
    expect(indexCall).toBeDefined();
    expect(String(indexCall?.[0])).toBe("/claim-api/reclaim-utxos?limit=100");
    // The scan is a plain public GET: only the cancellation signal (C11) may
    // be present — no method, headers, or body that could carry credentials.
    const indexInit = indexCall?.[1] as RequestInit | undefined;
    expect(indexInit?.method).toBeUndefined();
    expect(indexInit?.headers).toBeUndefined();
    expect(indexInit?.body).toBeUndefined();
    expect(String(indexCall?.[0])).not.toContain(credential);
  });

  it("refreshes available claims without treating the click event as credentials", async () => {
    const enable = vi.fn().mockResolvedValue({
      getNetworkId: vi.fn().mockResolvedValue(0),
      getChangeAddress: vi.fn().mockResolvedValue(walletAddressHex),
      getUsedAddresses: vi.fn().mockResolvedValue([usedWalletAddressHex]),
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(claimDeployment()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(reclaimUtxos()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(emptyReclaimUtxos()), { status: 200 }));
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

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect impacted wallet" }));
    expect(await screen.findByRole("heading", { name: "Available claims" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText(/No matching funds found/i)).toBeInTheDocument();
    expect(screen.queryByText(/map is not a function/i)).not.toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => String(url).startsWith("/claim-api/reclaim-utxos"))).toHaveLength(2);
  });

  it("moves between available claim pages with Previous and Next", async () => {
    const enable = vi.fn().mockResolvedValue({
      getNetworkId: vi.fn().mockResolvedValue(0),
      getChangeAddress: vi.fn().mockResolvedValue(walletAddressHex),
      getUsedAddresses: vi.fn().mockResolvedValue([usedWalletAddressHex]),
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(claimDeployment()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(reclaimUtxosWithMatching(11)), { status: 200 }));
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

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect impacted wallet" }));
    expect(await screen.findByText("Showing 1-10 of 11 UTxOs")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Showing 11-11 of 11 UTxOs")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("Showing 1-10 of 11 UTxOs")).toBeInTheDocument();
  });

  it("shows the selected claim row assets and returns to the same page after closing", async () => {
    const enable = vi.fn().mockResolvedValue({
      getNetworkId: vi.fn().mockResolvedValue(0),
      getChangeAddress: vi.fn().mockResolvedValue(walletAddressHex),
      getUsedAddresses: vi.fn().mockResolvedValue([usedWalletAddressHex]),
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

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect impacted wallet" }));
    expect(await screen.findByText("Showing 1-1 of 1 UTxOs")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const dialog = await screen.findByRole("dialog", { name: "UTxO assets" });
    expect(within(dialog).getByText(`${"a".repeat(64)}#0`)).toBeInTheDocument();
    expect(within(dialog).getByText("NFT")).toBeInTheDocument();
    expect(within(dialog).queryByText(/policy1v9/i)).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "UTxO assets" })).not.toBeInTheDocument());
    expect(screen.getByText("Showing 1-1 of 1 UTxOs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  });

  it("discovers matching claim UTxOs from reward-address stake credentials", async () => {
    const signTx = vi.fn();
    const getRewardAddresses = vi.fn().mockResolvedValue([rewardAddressHex]);
    const enable = vi.fn().mockResolvedValue({
      getNetworkId: vi.fn().mockResolvedValue(0),
      getChangeAddress: vi.fn().mockResolvedValue(usedWalletAddressHex),
      getUsedAddresses: vi.fn().mockResolvedValue([]),
      getRewardAddresses,
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

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect impacted wallet" }));

    expect(await screen.findByRole("heading", { name: "Available claims" })).toBeInTheDocument();
    expect(screen.getAllByText("1.5 ADA").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("9 ADA")).not.toBeInTheDocument();
    expect(getRewardAddresses).toHaveBeenCalledTimes(1);
    expect(signTx).not.toHaveBeenCalled();
  });

  it("discovers matching claim UTxOs from base-address stake credentials", async () => {
    const signTx = vi.fn();
    const enable = vi.fn().mockResolvedValue({
      getNetworkId: vi.fn().mockResolvedValue(0),
      getChangeAddress: vi.fn().mockResolvedValue(baseAddressWithStakeCredentialHex),
      getUsedAddresses: vi.fn().mockResolvedValue([]),
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

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect impacted wallet" }));

    expect(await screen.findByRole("heading", { name: "Available claims" })).toBeInTheDocument();
    expect(screen.getAllByText("1.5 ADA").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("9 ADA")).not.toBeInTheDocument();
    expect(signTx).not.toHaveBeenCalled();
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

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect impacted wallet" }));

    expect(await screen.findByText(/This wallet is not on Preprod/i)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signTx).not.toHaveBeenCalled();
  });

  it("runs the non-fixture draft, proof, build, safe-sign, submit, progress, and receipt flow", async () => {
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");
    const impactedSignTx = vi.fn();
    const safeSignTx = vi.fn().mockResolvedValue("84a100");
    installWallets({
      impacted: walletApi({
        getChangeAddress: walletAddressHex,
        getUsedAddresses: [usedWalletAddressHex],
        signTx: impactedSignTx,
      }),
      safe: walletApi({
        getChangeAddress: safeWalletAddressHex,
        getUsedAddresses: [safeWalletAddressHex],
        signTx: safeSignTx,
      }),
    });

    const calls: Array<{ url: string; body?: unknown; init?: RequestInit }> = [];
    const selectedOutrefs = [`${"a".repeat(64)}#0`];
    const draft = claimDraft(selectedOutrefs);
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlText = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: urlText, body, init });
      if (urlText === "/claim-api/deployment") {
        return jsonResponse(claimDeployment());
      }
      if (urlText.startsWith("/claim-api/reclaim-utxos")) {
        const previousProgress = calls.some((call) => call.url.startsWith("/claim-api/progress"));
        return jsonResponse(previousProgress ? emptyReclaimUtxos() : reclaimUtxos());
      }
      if (urlText === "/claim-api/draft") {
        expect(body).toMatchObject({
          deploymentId: "preprod:reclaim-base:commit",
          networkId: 0,
          safeWalletChangeAddress: safeWalletAddressBech32,
          safeWalletAddresses: [safeWalletAddressBech32],
          selectedOutrefs,
          maxUtxos: 1,
        });
        expect(JSON.stringify(body)).not.toContain(credential);
        return jsonResponse(draft);
      }
      if (urlText === "http://127.0.0.1:49152/status") {
        return jsonResponse(helperStatus());
      }
      if (urlText === "http://127.0.0.1:49152/prove-destination") {
        expect(init?.headers).toMatchObject({ "X-Proof-Tool-Token": "pair-secret" });
        if ((body as { preflight_only?: boolean })?.preflight_only) {
          expect(body).toEqual({ preflight_only: true });
          return jsonResponse({ ok: true, capability: "prove-destination-preflight-v1" });
        }
        expect(body).toMatchObject({
          profile: "single-destination",
          requests: draft.proofRequests,
          search: { max_account: 9, max_index: 999 },
          include_debug_path: false,
        });
        expect(body).not.toHaveProperty("path");
        return jsonResponse(destinationProofResponse(draft));
      }
      if (urlText === "/claim-api/build") {
        expect(body).toMatchObject({
          deploymentId: "preprod:reclaim-base:commit",
          networkId: 0,
          draftId: draft.draftId,
          selectedOutrefs,
          maxUtxos: draft.batchCap.requested,
          safeWalletChangeAddress: safeWalletAddressBech32,
          safeWalletAddresses: [safeWalletAddressBech32],
        });
        expect(JSON.stringify(body)).not.toContain("path");
        return jsonResponse(claimBuild(draft));
      }
      if (urlText === "/claim-api/submit") {
        expect(body).toMatchObject({
          deploymentId: "preprod:reclaim-base:commit",
          selectedOutrefs,
          unsignedTxCbor: "84a1",
          witnessSetCbor: "84a100",
          claimBuildReviewToken: "review-token",
        });
        expect(body).not.toHaveProperty("signedTxCbor");
        return jsonResponse(claimSubmit(selectedOutrefs));
      }
      if (urlText.startsWith("/claim-api/progress")) {
        expect(decodeURIComponent(urlText)).toContain(`outrefs=${selectedOutrefs.join(",")}`);
        return jsonResponse(claimProgress(selectedOutrefs));
      }
      throw new Error(`Unexpected fetch ${urlText}`);
    });
    vi.stubGlobal("fetch", fetch);

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect impacted wallet" }));
    expect(await screen.findByRole("heading", { name: "Available claims" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue to safe wallet" }));
    fireEvent.click(await findSafeWalletOption());
    fireEvent.click(screen.getByRole("button", { name: "Connect safe wallet" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm destination and continue" }));

    expect(await screen.findByRole("heading", { name: "Create proofs" })).toBeInTheDocument();
    await chooseDesktopProofMethod();
    const recoveryInputs = fillRecoveryPhraseInputs();
    fireEvent.click(screen.getByRole("button", { name: "Generate proofs" }));
    expect(await screen.findByRole("heading", { name: "Proofs ready" })).toBeInTheDocument();
    expect(recoveryInputs.every((input) => input.value === "")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Continue to current batch" }));
    expect(await screen.findByRole("heading", { name: "Claim funds" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Build transaction for review" }));
    expect(await screen.findByText("Review hash")).toBeInTheDocument();
    expect(safeSignTx).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit claim" }));

    await waitFor(() => expect(screen.getByText(/Recovery complete/i)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /11111\.\.\.11111/i })).toHaveAttribute(
      "href",
      `https://preprod.cexplorer.io/tx/${"1".repeat(64)}`,
    );
    expect(impactedSignTx).not.toHaveBeenCalled();
    expect(safeSignTx).toHaveBeenCalledTimes(1);
    expect(safeSignTx).toHaveBeenCalledWith("84a1", true);
    expect(calls.some((call) => call.url === "http://127.0.0.1:49152/prove-destination")).toBe(true);
  });

  it("shows the proof method chooser on the proof step before a local helper is paired", async () => {
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    vi.stubGlobal("fetch", claimFlowFetch());

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    await connectSafeWalletToProofs();

    const localHelperTile = screen.getByText("Local proof method").closest("section");
    expect(localHelperTile).not.toBeNull();
    expect(within(localHelperTile as HTMLElement).getByText("Prove in browser")).toBeInTheDocument();
    expect(screen.getByText(/Browser proving is not enabled for this build yet/i)).toBeInTheDocument();
    expect(within(localHelperTile as HTMLElement).getByRole("button", { name: "Choose method" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate proofs" })).toBeDisabled();
  });

  it("resumes the proof step when Proof Helper opens a paired claim tab", async () => {
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    const fetch = claimFlowFetch();
    vi.stubGlobal("fetch", fetch);

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    await connectSafeWalletToProofs();
    await waitFor(() => expect(window.localStorage.getItem("proof-tool.claim-flow.resume.v1")).not.toBeNull());
    cleanup();
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    expect(await screen.findByRole("heading", { name: "Create proofs" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Verify this recovery service" })).not.toBeInTheDocument();
    await waitFor(() => {
      const localHelperTile = screen.getByText("Local proof method").closest("section");
      expect(localHelperTile).not.toBeNull();
      expect(within(localHelperTile as HTMLElement).getByText("Prove in browser")).toBeInTheDocument();
      expect(within(localHelperTile as HTMLElement).getByText("Unavailable")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Generate proofs" })).toBeDisabled();
    expect(fetch.mock.calls.some(([url]) => String(url) === "http://127.0.0.1:49152/status")).toBe(true);
  });

  it("pairs the local helper in place from a courier tab relay without reloading", async () => {
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    const fetch = claimFlowFetch();
    vi.stubGlobal("fetch", fetch);

    // This tab is the working tab: it advances to Create proofs without any
    // pairing fragment, so the helper starts unpaired.
    render(<ClaimFlow createWorker={createWorkerSuccess()} />);
    await connectSafeWalletToProofs();
    expect(fetch.mock.calls.some(([url]) => String(url) === "http://127.0.0.1:49152/status")).toBe(false);

    // A courier tab (opened by the desktop app) relays the pairing over the
    // same-origin channel and listens for an acknowledgement.
    const courier = "courier-under-test";
    const acks: string[] = [];
    const unsubscribe = subscribeToPairing({ sender: courier, onAck: (target) => acks.push(target) });
    broadcastPairing({ helperUrl: "http://127.0.0.1:49152", token: "pair-secret" }, courier);

    // The working tab pairs in place: it queries the relayed helper and
    // acknowledges the courier — all without a navigation or fragment.
    await waitFor(() =>
      expect(fetch.mock.calls.some(([url]) => String(url) === "http://127.0.0.1:49152/status")).toBe(true),
    );
    await waitFor(() => expect(acks).toContain(courier));
    expect(window.location.hash).toBe("");
    unsubscribe();
  });

  it("courier tab shows the paired confirmation and closes itself once an existing tab acknowledges", async () => {
    vi.stubGlobal("fetch", claimFlowFetch());
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    // An "existing tab" that takes any relayed pairing and acknowledges it.
    const existing = "existing-tab-under-test";
    const unsubscribe = subscribeToPairing({
      sender: existing,
      onPair: ({ sender }) => acknowledgePairing(sender, existing),
    });
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    // The courier never runs the flow itself: it relays, confirms, and closes.
    expect(await screen.findByTestId("helper-courier")).toBeInTheDocument();
    expect(await screen.findByText("Proof Helper paired")).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    await waitFor(() => expect(close).toHaveBeenCalled(), { timeout: 4000 });
    unsubscribe();
    close.mockRestore();
  });

  it("renders non-fixture proof readiness from the draft without demo proof progress or placeholder addresses", async () => {
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    vi.stubGlobal("fetch", claimFlowFetch({ draft: claimDraft([`${"a".repeat(64)}#0`, `${"b".repeat(64)}#0`]) }));

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    await connectSafeWalletToProofs();

    expect(screen.getByText("0 of 2")).toBeInTheDocument();
    expect(screen.getAllByText("2 UTxOs").length).toBeGreaterThan(0);
    expect(screen.queryByText("39%")).not.toBeInTheDocument();
    expect(screen.queryByText(/7 of 18/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/b1e4c8d2/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/addr1qx/i)).not.toBeInTheDocument();
  });

  it("reconnects the safe wallet after resuming a built current batch and submits without losing state", async () => {
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");
    const draft = claimDraft([`${"a".repeat(64)}#0`]);
    const build = claimBuild(draft);
    const safeSignTx = vi.fn().mockResolvedValue("84a100");
    const safeEnable = vi.fn().mockResolvedValue(
      walletApi({
        getChangeAddress: safeWalletAddressHex,
        getUsedAddresses: [safeWalletAddressHex],
        signTx: safeSignTx,
      }),
    );
    Object.defineProperty(window, "cardano", {
      configurable: true,
      value: {
        safe: {
          name: "Safe",
          enable: safeEnable,
        },
      },
    });
    writeResumeSnapshotForTest({ screen: "current-batch", draft, build });
    const fetch = claimFlowFetch({ draft });
    vi.stubGlobal("fetch", fetch);

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    expect(await screen.findByRole("heading", { name: "Claim funds" })).toBeInTheDocument();
    expect(screen.getByText(/Reconnect safe wallet to sign/i)).toBeInTheDocument();
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url) === "/claim-api/deployment")).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Reconnect and submit claim" }));

    await waitFor(() => expect(screen.getByText(/Recovery complete/i)).toBeInTheDocument());
    expect(safeEnable).toHaveBeenCalledTimes(1);
    expect(safeSignTx).toHaveBeenCalledWith("84a1", true);
    expect(fetch.mock.calls.some(([url]) => String(url) === "/claim-api/submit")).toBe(true);
    expect(fetch.mock.calls.some(([url]) => String(url) === "/claim-api/build")).toBe(false);
  });

  it("builds a resumed current batch while marking safe-wallet signing as reconnect-required", async () => {
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");
    const draft = claimDraft([`${"a".repeat(64)}#0`]);
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    writeResumeSnapshotForTest({ screen: "current-batch", draft });
    const fetch = claimFlowFetch({ draft });
    vi.stubGlobal("fetch", fetch);

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    expect(await screen.findByRole("heading", { name: "Claim funds" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Build transaction for review" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Build transaction for review" }));

    expect(await screen.findByText("Review hash")).toBeInTheDocument();
    expect(screen.getByText(/Reconnect safe wallet to sign/i)).toBeInTheDocument();
    expect(screen.getByText(/No transaction has been signed or submitted yet/i)).toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url) === "/claim-api/build")).toBe(true);
    expect(fetch.mock.calls.some(([url]) => String(url) === "/claim-api/submit")).toBe(false);
  });

  it("blocks wrong-network safe-wallet reconnect without clearing the resumed build", async () => {
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");
    const draft = claimDraft([`${"a".repeat(64)}#0`]);
    const build = claimBuild(draft);
    const safeSignTx = vi.fn().mockResolvedValue("84a100");
    const safeEnable = vi.fn().mockResolvedValue(
      walletApi({
        getNetworkId: 1,
        getChangeAddress: safeWalletAddressHex,
        getUsedAddresses: [safeWalletAddressHex],
        signTx: safeSignTx,
      }),
    );
    Object.defineProperty(window, "cardano", {
      configurable: true,
      value: {
        safe: {
          name: "Safe",
          enable: safeEnable,
        },
      },
    });
    writeResumeSnapshotForTest({ screen: "current-batch", draft, build });
    const fetch = claimFlowFetch({ draft });
    vi.stubGlobal("fetch", fetch);

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    expect(await screen.findByRole("heading", { name: "Claim funds" })).toBeInTheDocument();
    expect(screen.getByText("Review hash")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect and submit claim" }));

    expect(await screen.findByText(/Safe wallet is on Mainnet/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Claim funds" })).toBeInTheDocument();
    expect(screen.getByText("Review hash")).toBeInTheDocument();
    expect(safeEnable).toHaveBeenCalledTimes(1);
    expect(safeSignTx).not.toHaveBeenCalled();
    expect(fetch.mock.calls.some(([url]) => String(url) === "/claim-api/build")).toBe(false);
    expect(fetch.mock.calls.some(([url]) => String(url) === "/claim-api/submit")).toBe(false);
  });

  it("blocks resumed submit when the reconnected safe wallet destination changed", async () => {
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");
    const draft = claimDraft([`${"a".repeat(64)}#0`]);
    const build = claimBuild(draft);
    const safeSignTx = vi.fn().mockResolvedValue("84a100");
    Object.defineProperty(window, "cardano", {
      configurable: true,
      value: {
        safe: {
          name: "Safe",
          enable: vi.fn().mockResolvedValue(
            walletApi({
              getChangeAddress: changedSafeWalletAddressHex,
              getUsedAddresses: [changedSafeWalletAddressHex],
              signTx: safeSignTx,
            }),
          ),
        },
      },
    });
    writeResumeSnapshotForTest({ screen: "current-batch", draft, build });
    const fetch = claimFlowFetch({ draft });
    vi.stubGlobal("fetch", fetch);

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    expect(await screen.findByRole("heading", { name: "Claim funds" })).toBeInTheDocument();
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url) === "/claim-api/deployment")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect and submit claim" }));

    expect(await screen.findByText(/destination changed/i)).toBeInTheDocument();
    expect(safeSignTx).not.toHaveBeenCalled();
    expect(fetch.mock.calls.some(([url]) => String(url) === "/claim-api/submit")).toBe(false);
  });

  it("blocks safe wallets that cannot sign", async () => {
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }, { omitSignTx: true }),
    });
    const fetch = claimFlowFetch();
    vi.stubGlobal("fetch", fetch);

    render(<ClaimFlow />);

    await connectImpactedAndContinueToSafeWallet();
    fireEvent.click(await findSafeWalletOption());
    fireEvent.click(screen.getByRole("button", { name: "Connect safe wallet" }));

    expect(await screen.findByText(/must support CIP-30 signTx/i)).toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url) === "/claim-api/draft")).toBe(false);
  });

  it("blocks safe wallet network mismatch and credential overlap", async () => {
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({
        getNetworkId: 1,
        getChangeAddress: safeWalletAddressHex,
        getUsedAddresses: [safeWalletAddressHex],
      }),
    });
    vi.stubGlobal("fetch", claimFlowFetch());

    render(<ClaimFlow />);

    await connectImpactedAndContinueToSafeWallet();
    fireEvent.click(await findSafeWalletOption());
    fireEvent.click(screen.getByRole("button", { name: "Connect safe wallet" }));
    expect(await screen.findByText(/Safe wallet is on Mainnet/i)).toBeInTheDocument();

    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "cardano");
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [walletAddressHex] }),
    });
    vi.stubGlobal("fetch", claimFlowFetch());
    render(<ClaimFlow />);

    await connectImpactedAndContinueToSafeWallet();
    fireEvent.click(await findSafeWalletOption());
    fireEvent.click(screen.getByRole("button", { name: "Connect safe wallet" }));
    await waitFor(() => expect(screen.getAllByText(/shares a wallet key/i).length).toBeGreaterThan(0));
  });

  it("lets users retry safe wallet connection after an overlap block", async () => {
    const safeEnable = vi
      .fn()
      .mockResolvedValueOnce(walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [walletAddressHex] }))
      .mockResolvedValueOnce(walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }));
    Object.defineProperty(window, "cardano", {
      configurable: true,
      value: {
        impacted: {
          name: "Impacted",
          enable: vi.fn().mockResolvedValue(walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] })),
        },
        safe: {
          name: "Safe",
          enable: safeEnable,
        },
      },
    });
    vi.stubGlobal("fetch", claimFlowFetch());

    render(<ClaimFlow />);

    await connectImpactedAndContinueToSafeWallet();
    fireEvent.click(await findSafeWalletOption());
    fireEvent.click(screen.getByRole("button", { name: "Connect safe wallet" }));

    const retry = await screen.findByRole("button", { name: "Choose another wallet" });
    expect(retry).toBeEnabled();

    fireEvent.click(retry);

    // C17: a successful reconnect stays on the safe-wallet screen for the
    // explicit destination confirmation.
    fireEvent.click(await screen.findByRole("button", { name: "Confirm destination and continue" }));
    expect(await screen.findByRole("heading", { name: "Create proofs" })).toBeInTheDocument();
    expect(safeEnable).toHaveBeenCalledTimes(2);
  });

  it("blocks safe wallet overlap through reward-address stake credentials", async () => {
    installWallets({
      impacted: walletApi({ getChangeAddress: usedWalletAddressHex, getUsedAddresses: [], getRewardAddresses: [rewardAddressHex] }),
      safe: walletApi({
        getChangeAddress: safeWalletAddressHex,
        getUsedAddresses: [safeWalletAddressHex],
        getRewardAddresses: [rewardAddressHex],
      }),
    });
    vi.stubGlobal("fetch", claimFlowFetch());

    render(<ClaimFlow />);

    await connectImpactedAndContinueToSafeWallet();
    fireEvent.click(await findSafeWalletOption());
    fireEvent.click(screen.getByRole("button", { name: "Connect safe wallet" }));
    await waitFor(() => expect(screen.getAllByText(/shares a wallet key/i).length).toBeGreaterThan(0));
  });

  it("blocks proof generation when the helper destination key hash does not match deployment", async () => {
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    const draft = claimDraft([`${"a".repeat(64)}#0`]);
    const fetch = claimFlowFetch({
      draft,
      helperStatus: helperStatus({ key_hash: "f".repeat(64) }),
    });
    vi.stubGlobal("fetch", fetch);

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    await connectSafeWalletToProofs();
    await chooseDesktopProofMethod();
    fillRecoveryPhraseInputs();
    fireEvent.click(screen.getByRole("button", { name: "Generate proofs" }));

    expect(await screen.findByText(/destination key hash does not match/i)).toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/prove-destination"))).toBe(false);
  });

  it("blocks helper artifacts that include derivation path metadata", async () => {
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    const draft = claimDraft([`${"a".repeat(64)}#0`]);
    const fetch = claimFlowFetch({
      draft,
      destinationProofResponse: destinationProofResponse(draft, { path: { account: 0, role: 0, index: 0 } }),
    });
    vi.stubGlobal("fetch", fetch);

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    await connectSafeWalletToProofs();
    await chooseDesktopProofMethod();
    fillRecoveryPhraseInputs();
    fireEvent.click(screen.getByRole("button", { name: "Generate proofs" }));

    expect(await screen.findByText(/derivation path metadata/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Proofs ready" })).not.toBeInTheDocument();
  });

  it("shows the full destination address in the pre-sign review and copies it to the clipboard", async () => {
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");
    const draft = claimDraft([`${"a".repeat(64)}#0`]);
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    writeResumeSnapshotForTest({ screen: "current-batch", draft });
    vi.stubGlobal("fetch", claimFlowFetch({ draft }));
    const writeText = installClipboardWrite();

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    expect(await screen.findByRole("heading", { name: "Claim funds" })).toBeInTheDocument();
    expect(screen.getByText(safeWalletAddressBech32)).toBeInTheDocument();
    expect(screen.getByText(/Confirm this matches the receive address shown in your safe wallet before signing/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy Safe wallet (destination)" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(safeWalletAddressBech32));
    expect(await screen.findByRole("button", { name: /Copy Safe wallet \(destination\) — copied/i })).toBeInTheDocument();
  });

  it("shows build progress immediately and suppresses duplicate build requests", async () => {
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");
    const draft = claimDraft([`${"a".repeat(64)}#0`]);
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    writeResumeSnapshotForTest({ screen: "current-batch", draft });
    let resolveBuild!: (response: Response) => void;
    const pendingBuild = new Promise<Response>((resolve) => {
      resolveBuild = resolve;
    });
    const fallbackFetch = claimFlowFetch({ draft });
    const fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === "/claim-api/build") {
        return pendingBuild;
      }
      return fallbackFetch(url, init);
    });
    vi.stubGlobal("fetch", fetch);

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    expect(await screen.findByRole("heading", { name: "Claim funds" })).toBeInTheDocument();
    const buildButton = screen.getByRole("button", { name: "Build transaction for review" });
    fireEvent.click(buildButton);
    fireEvent.click(buildButton);

    const buildingButton = await screen.findByRole("button", { name: "Building transaction" });
    expect(buildingButton).toBeDisabled();
    expect(buildingButton.querySelector("svg.spin")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Go back" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/Refreshing current chain data/i);
    expect(fetch.mock.calls.filter(([url]) => String(url) === "/claim-api/build")).toHaveLength(1);

    resolveBuild(jsonResponse(claimBuild(draft)));
    expect(await screen.findByText("Review hash")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /submit claim/i })).toBeEnabled();
  });

  it("keeps Refresh status passive and starts the next batch only from the explicit CTA", async () => {
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");
    const draft = claimDraft([`${"a".repeat(64)}#0`]);
    const build = claimBuild(draft);
    const safeSignTx = vi.fn().mockResolvedValue("84a100");
    const safeEnable = vi.fn().mockResolvedValue(
      walletApi({
        getChangeAddress: safeWalletAddressHex,
        getUsedAddresses: [safeWalletAddressHex],
        signTx: safeSignTx,
      }),
    );
    Object.defineProperty(window, "cardano", {
      configurable: true,
      value: {
        safe: {
          name: "Safe",
          enable: safeEnable,
        },
      },
    });
    writeResumeSnapshotForTest({ screen: "current-batch", draft, build });
    const remainingUtxos = {
      ...reclaimUtxos(),
      utxos: [
        ...reclaimUtxos().utxos,
        indexedUtxo({
          txHash: "e".repeat(64),
          outputIndex: 0,
          paymentCredential: credential,
          value: { lovelace: "1250000" },
        }),
      ],
    };
    const fetch = claimFlowFetch({ draft, reclaimUtxosResponse: remainingUtxos });
    vi.stubGlobal("fetch", fetch);

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    expect(await screen.findByRole("heading", { name: "Claim funds" })).toBeInTheDocument();
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url) === "/claim-api/deployment")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect and submit claim" }));

    // One claim remains after the submitted batch settles: the flow must stay
    // on the pending review instead of auto-creating a new draft.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Claim review" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/Claim submitted/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/your recovery phrase will be needed again/i)).toBeInTheDocument());
    expect(fetch.mock.calls.filter(([url]) => String(url) === "/claim-api/draft")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));

    await waitFor(() =>
      expect(fetch.mock.calls.filter(([url]) => String(url).startsWith("/claim-api/progress")).length).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() => expect(screen.getByRole("heading", { name: "Claim review" })).toBeInTheDocument());
    expect(fetch.mock.calls.filter(([url]) => String(url) === "/claim-api/draft")).toHaveLength(0);
    expect(screen.getByText(/your recovery phrase will be needed again/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Start next batch \(1 claim remaining\)/i }));

    expect(await screen.findByRole("heading", { name: "Create proofs" })).toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => String(url) === "/claim-api/draft")).toHaveLength(1);
  });

  it("offers resume from the stored snapshot on refresh without auto-applying it", async () => {
    const draft = claimDraft([`${"a".repeat(64)}#0`]);
    writeResumeSnapshotForTest({ screen: "current-batch", draft });
    vi.stubGlobal("fetch", claimFlowFetch({ draft }));

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    expect(await screen.findByRole("heading", { name: "Verify this recovery service" })).toBeInTheDocument();
    expect(await screen.findByText("Resume your claim in progress?")).toBeInTheDocument();
    expect(screen.getByText(/Last saved/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    expect(await screen.findByRole("heading", { name: "Claim funds" })).toBeInTheDocument();
  });

  it("clears the stored snapshot when starting over from the resume banner", async () => {
    const draft = claimDraft([`${"a".repeat(64)}#0`]);
    writeResumeSnapshotForTest({ screen: "current-batch", draft });
    vi.stubGlobal("fetch", claimFlowFetch({ draft }));

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    expect(await screen.findByText("Resume your claim in progress?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));

    await waitFor(() => expect(screen.queryByText("Resume your claim in progress?")).not.toBeInTheDocument());
    expect(window.localStorage.getItem("proof-tool.claim-flow.resume.v1")).toBeNull();
    expect(screen.getByRole("heading", { name: "Verify this recovery service" })).toBeInTheDocument();
  });

  it("paginates claims beyond page 2 with numbered page buttons", async () => {
    const enable = vi.fn().mockResolvedValue({
      getNetworkId: vi.fn().mockResolvedValue(0),
      getChangeAddress: vi.fn().mockResolvedValue(walletAddressHex),
      getUsedAddresses: vi.fn().mockResolvedValue([usedWalletAddressHex]),
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(claimDeployment()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(reclaimUtxosWithMatching(25)), { status: 200 }));
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

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect impacted wallet" }));
    expect(await screen.findByText("Showing 1-10 of 25 UTxOs")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "3" }));
    expect(await screen.findByText("Showing 21-25 of 25 UTxOs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("Showing 11-20 of 25 UTxOs")).toBeInTheDocument();
  });

  it("renders fixture claim rows and working search/filter on the available-claims fixture state", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    window.history.replaceState(null, "", "/claim?fixtureState=available-claims-page-1");

    render(<ClaimFlow />);

    expect(await screen.findByRole("heading", { name: "Available claims" })).toBeInTheDocument();
    expect(screen.getByText("Showing 1-10 of 18 UTxOs")).toBeInTheDocument();
    expect(screen.getAllByText("b1e4c8d2...9af3").length).toBeGreaterThan(0);

    const searchInput = screen.getByLabelText("Search claims by tx, output, or credential");
    fireEvent.change(searchInput, { target: { value: "7f9a2d11" } });
    expect(screen.getByText("Showing 1-2 of 2 UTxOs")).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("radio", { name: "ADA" }));
    expect(screen.getByText("Showing 1-5 of 5 UTxOs")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Tokens" }));
    expect(screen.getByText("Showing 1-10 of 13 UTxOs")).toBeInTheDocument();
  });

  it("does not render placeholder deployment values in live mode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    render(<ClaimFlow />);

    expect(await screen.findByText(/Deployment unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/script1q9k9r0v6t2m313u4z8h8y2d0k5f4x7w8e5p2c3h6tx/)).not.toBeInTheDocument();
    expect(screen.queryByText(/4f3c9a1e2b6c8d0f91a4b7c3e0d29a6f48bd12c0/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /view commit on github/i })).not.toBeInTheDocument();
  });

  it("stays on the safe wallet screen after connect and advances only on explicit confirm", async () => {
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    vi.stubGlobal("fetch", claimFlowFetch());

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    await connectImpactedAndContinueToSafeWallet();
    fireEvent.click(await findSafeWalletOption());
    fireEvent.click(screen.getByRole("button", { name: "Connect safe wallet" }));

    // Connect must not auto-advance: the populated destination panel gets an
    // explicit confirmation beat (C17).
    const confirm = await screen.findByRole("button", { name: "Confirm destination and continue" });
    expect(screen.getByRole("heading", { name: "Connect safe wallet" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Create proofs" })).not.toBeInTheDocument();
    expect(screen.getAllByText(safeWalletAddressBech32).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "Choose a different wallet" })).toBeInTheDocument();

    fireEvent.click(confirm);

    expect(await screen.findByRole("heading", { name: "Create proofs" })).toBeInTheDocument();
  });

  it("clears the connected safe wallet when choosing a different wallet", async () => {
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    vi.stubGlobal("fetch", claimFlowFetch());

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    await connectImpactedAndContinueToSafeWallet();
    fireEvent.click(await findSafeWalletOption());
    fireEvent.click(screen.getByRole("button", { name: "Connect safe wallet" }));

    fireEvent.click(await screen.findByRole("button", { name: "Choose a different wallet" }));

    expect(await screen.findByRole("button", { name: "Connect safe wallet" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm destination and continue" })).not.toBeInTheDocument();
  });

  it("disables the generating button and ignores a second generate click while a run is active", async () => {
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    const draft = claimDraft([`${"a".repeat(64)}#0`]);
    let resolveProve: (value: Response) => void = () => {};
    const provePromise = new Promise<Response>((resolve) => {
      resolveProve = resolve;
    });
    const base = claimFlowFetch({ draft });
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === "http://127.0.0.1:49152/prove-destination") {
        const body = init?.body ? JSON.parse(String(init.body)) as { preflight_only?: boolean } : {};
        if (body.preflight_only) {
          return jsonResponse({ ok: true, capability: "prove-destination-preflight-v1" });
        }
        return provePromise;
      }
      return base(url, init);
    });
    vi.stubGlobal("fetch", fetch);

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    await connectSafeWalletToProofs();
    await chooseDesktopProofMethod();
    fillRecoveryPhraseInputs();
    const generate = screen.getByRole("button", { name: "Generate proofs" });
    fireEvent.click(generate);
    fireEvent.click(generate);

    // The status CTA is disabled while a run is active (C6) and the second
    // click did not spawn a racing helper request.
    expect(await screen.findByRole("button", { name: "Generating proofs" })).toBeDisabled();
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/prove-destination"))).toHaveLength(2);

    resolveProve(jsonResponse(destinationProofResponse(draft)));

    expect(await screen.findByRole("heading", { name: "Proofs ready" })).toBeInTheDocument();
  });

  it("re-runs the helper status check from the Check helper again button", async () => {
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    const draft = claimDraft([`${"a".repeat(64)}#0`]);
    let helperKeyReady = false;
    const base = claimFlowFetch({ draft });
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === "http://127.0.0.1:49152/status") {
        return jsonResponse(helperStatus({ key_ready: helperKeyReady }));
      }
      return base(url, init);
    });
    vi.stubGlobal("fetch", fetch);

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    await connectSafeWalletToProofs();
    await chooseDesktopProofMethod();
    fillRecoveryPhraseInputs();

    const checkAgain = await screen.findByRole("button", { name: "Check helper again" });
    expect(screen.getByRole("button", { name: "Generate proofs" })).toBeDisabled();
    const statusCallsBefore = fetch.mock.calls.filter(([url]) => String(url) === "http://127.0.0.1:49152/status").length;
    expect(statusCallsBefore).toBeGreaterThanOrEqual(1);

    helperKeyReady = true;
    fireEvent.click(checkAgain);

    await waitFor(() => expect(screen.getByRole("button", { name: "Generate proofs" })).toBeEnabled());
    expect(
      fetch.mock.calls.filter(([url]) => String(url) === "http://127.0.0.1:49152/status").length,
    ).toBeGreaterThan(statusCallsBefore);
  });

  it("presents an indexer failure as a lookup problem with a retry, not as no matching funds", async () => {
    const enable = vi.fn().mockResolvedValue({
      getNetworkId: vi.fn().mockResolvedValue(0),
      getChangeAddress: vi.fn().mockResolvedValue(walletAddressHex),
      getUsedAddresses: vi.fn().mockResolvedValue([usedWalletAddressHex]),
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(claimDeployment()))
      .mockResolvedValueOnce(jsonResponse({ error: "indexer exploded" }, { status: 502 }))
      .mockResolvedValueOnce(jsonResponse(reclaimUtxos()));
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

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect impacted wallet" }));

    expect(await screen.findByText("We couldn't check for claims")).toBeInTheDocument();
    expect(screen.getByText(/Your funds are not affected — this was a lookup problem/i)).toBeInTheDocument();
    expect(screen.getByText(/indexer exploded/i)).toBeInTheDocument();
    expect(screen.queryByText(/No matching funds found/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("heading", { name: "Available claims" })).toBeInTheDocument();
    expect(screen.queryByText("We couldn't check for claims")).not.toBeInTheDocument();
  });

  it("keeps the genuinely-empty state distinct with a what-next hint", async () => {
    const enable = vi.fn().mockResolvedValue({
      getNetworkId: vi.fn().mockResolvedValue(0),
      getChangeAddress: vi.fn().mockResolvedValue(walletAddressHex),
      getUsedAddresses: vi.fn().mockResolvedValue([usedWalletAddressHex]),
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(claimDeployment()))
      .mockResolvedValueOnce(jsonResponse(emptyReclaimUtxos()));
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

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect impacted wallet" }));

    expect(await screen.findByText(/No matching funds found/i)).toBeInTheDocument();
    expect(screen.getByText(/rescuers may still be locking funds/i)).toBeInTheDocument();
    expect(screen.queryByText("We couldn't check for claims")).not.toBeInTheDocument();
  });

  it("routes insufficient safe-wallet funds draft errors to the insufficient-ada screen", async () => {
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    const base = claimFlowFetch();
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === "/claim-api/draft") {
        return jsonResponse(
          {
            error: "Safe wallet must have enough ADA to pay claim fees, collateral, and destination-output min-ADA.",
            code: "safe_wallet_lovelace_unavailable",
          },
          { status: 400 },
        );
      }
      return base(url, init);
    });
    vi.stubGlobal("fetch", fetch);

    render(<ClaimFlow />);

    await connectImpactedAndContinueToSafeWallet();
    fireEvent.click(await findSafeWalletOption());
    fireEvent.click(screen.getByRole("button", { name: "Connect safe wallet" }));

    expect(await screen.findByText("More ADA needed")).toBeInTheDocument();
    expect(screen.getByText(/enough ADA to pay claim fees/i)).toBeInTheDocument();
    // C32: without structured details (older payloads) the copy stays
    // qualitative.
    expect(screen.getByText(/The safe wallet needs more ADA for fees, collateral, and min-ADA/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Create proofs" })).not.toBeInTheDocument();
  });

  it("shows required vs available ADA when the draft error carries structured details", async () => {
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    const base = claimFlowFetch();
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === "/claim-api/draft") {
        return jsonResponse(
          {
            error: "Safe wallet must have enough ADA to pay claim fees, collateral, and destination-output min-ADA.",
            code: "safe_wallet_lovelace_unavailable",
            details: { availableLovelace: "2450000", requiredLovelace: "5000000" },
          },
          { status: 400 },
        );
      }
      return base(url, init);
    });
    vi.stubGlobal("fetch", fetch);

    render(<ClaimFlow />);

    await connectImpactedAndContinueToSafeWallet();
    fireEvent.click(await findSafeWalletOption());
    fireEvent.click(screen.getByRole("button", { name: "Connect safe wallet" }));

    expect(await screen.findByText("More ADA needed")).toBeInTheDocument();
    // C32: the notice renders the backend amounts via formatLovelace.
    expect(
      screen.getByText(/Your safe wallet has 2\.45 ADA — at least 5 ADA is needed for fees, collateral, and min-ADA/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Recovered funds will not be reduced for fees/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Create proofs" })).not.toBeInTheDocument();
  });

  it("demonstrates the insufficient-ada layout with example amounts in fixture mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    window.history.replaceState(null, "", "/claim?fixtureState=insufficient-ada");

    render(<ClaimFlow />);

    expect(await screen.findByText("More ADA needed")).toBeInTheDocument();
    expect(
      screen.getByText(/Your safe wallet has 2\.45 ADA — at least 5 ADA is needed for fees, collateral, and min-ADA/i),
    ).toBeInTheDocument();
  });

  it("traps focus in the proof method dialog, closes on Escape, and restores focus to the opener", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    window.history.replaceState(null, "", "/claim?fixtureState=create-proofs-ready");

    render(<ClaimFlow />);

    expect(await screen.findByRole("heading", { name: "Create proofs" })).toBeInTheDocument();
    const opener = screen.getAllByRole("button", { name: "Choose method" })[0];
    // Real browsers focus a button on mousedown; fireEvent does not.
    opener.focus();
    fireEvent.click(opener);

    const methodDialog = await screen.findByRole("dialog", { name: "Choose how to create proofs" });
    // C36: initial focus moves into the dialog.
    expect(methodDialog).toHaveFocus();

    fireEvent.keyDown(methodDialog, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose how to create proofs" })).not.toBeInTheDocument());
    // C36: focus returns to the control that opened the dialog.
    expect(opener).toHaveFocus();
  });

  it("closes the asset modal from the backdrop and Escape", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLAIM_UI_FIXTURE", "1");
    window.history.replaceState(null, "", "/claim?fixtureState=available-claims-asset-modal");

    render(<ClaimFlow />);

    const dialog = await screen.findByRole("dialog", { name: "UTxO assets" });
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "UTxO assets" })).not.toBeInTheDocument());
  });

  it("announces bad notices with role=alert", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    render(<ClaimFlow />);

    expect(await screen.findByText(/Deployment unavailable/i)).toBeInTheDocument();
    const alerts = screen.getAllByRole("alert");
    expect(alerts.some((alert) => /Deployment unavailable/i.test(alert.textContent ?? ""))).toBe(true);
  });

  it("blocks Generate until the recovery phrase grid is complete and wordlist-valid", async () => {
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    vi.stubGlobal("fetch", claimFlowFetch({ draft: claimDraft([`${"a".repeat(64)}#0`]) }));

    render(<ClaimFlow createWorker={createWorkerSuccess()} />);

    await connectSafeWalletToProofs();
    await chooseDesktopProofMethod();

    // Empty grid: blocked.
    expect(screen.getByRole("button", { name: "Generate proofs" })).toBeDisabled();

    // A word that is not letters-only is flagged and keeps Generate blocked.
    const recoveryInputs = screen.getAllByLabelText(/Recovery word \d+/) as HTMLInputElement[];
    fireEvent.change(recoveryInputs[0], { target: { value: "word1" } });
    expect(await screen.findByText(/not a recovery word/i)).toBeInTheDocument();
    expect(recoveryInputs[0]).toHaveClass("invalid");
    expect(screen.getByRole("button", { name: "Generate proofs" })).toBeDisabled();

    // C28: a letters-only typo that is not in the BIP-39 wordlist is flagged
    // too ("recieve" vs "receive") and keeps Generate blocked.
    fireEvent.change(recoveryInputs[0], { target: { value: "recieve" } });
    expect(await screen.findByText(/not a recovery word/i)).toBeInTheDocument();
    expect(recoveryInputs[0]).toHaveClass("invalid");
    expect(recoveryInputs[0]).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Generate proofs" })).toBeDisabled();

    fillRecoveryPhraseInputs();
    expect(screen.queryByText(/not a recovery word/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate proofs" })).toBeEnabled();
  });

  it("blocks a wordlist-valid phrase with a bad checksum without clearing the grid or starting a run", async () => {
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    const draft = claimDraft([`${"a".repeat(64)}#0`]);
    const fetch = claimFlowFetch({ draft });
    vi.stubGlobal("fetch", fetch);
    const workerFactory = vi.fn(createWorkerSuccess());

    render(<ClaimFlow createWorker={workerFactory} />);

    await connectSafeWalletToProofs();
    await chooseDesktopProofMethod();

    // All words are valid BIP-39 words, but 24x "abandon" fails the checksum.
    const recoveryInputs = screen.getAllByLabelText(/Recovery word \d+/) as HTMLInputElement[];
    recoveryInputs.forEach((input) => {
      fireEvent.change(input, { target: { value: "abandon" } });
    });
    expect(screen.queryByText(/not a recovery word/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate proofs" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Generate proofs" }));

    // The checksum failure is explained inline, the inputs are NOT cleared,
    // and no derivation or secret-bearing helper run was started. The exact
    // no-secret endpoint preflight still runs first by design.
    expect(await screen.findByText(/phrase checksum doesn't match/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Create proofs" })).toBeInTheDocument();
    expect(recoveryInputs.every((input) => input.value === "abandon")).toBe(true);
    expect(workerFactory).not.toHaveBeenCalled();
    const helperCalls = fetch.mock.calls.filter(([url]) => String(url).endsWith("/prove-destination"));
    expect(helperCalls).toHaveLength(1);
    expect(JSON.parse(String(helperCalls[0]?.[1]?.body))).toEqual({ preflight_only: true });

    // Editing a word clears the checksum notice.
    fireEvent.change(recoveryInputs[0], { target: { value: "gown" } });
    await waitFor(() => expect(screen.queryByText(/phrase checksum doesn't match/i)).not.toBeInTheDocument());

    // Correcting the phrase lets the run proceed (and only then clears words).
    fillRecoveryPhraseInputs();
    fireEvent.click(screen.getByRole("button", { name: "Generate proofs" }));
    expect(await screen.findByRole("heading", { name: "Proofs ready" })).toBeInTheDocument();
    expect(recoveryInputs.every((input) => input.value === "")).toBe(true);
  });

  it("keeps the phrase intact when the exact no-secret desktop preflight fails", async () => {
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    const draft = claimDraft([`${"a".repeat(64)}#0`]);
    const base = claimFlowFetch({ draft });
    const helperBodies: unknown[] = [];
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/prove-destination")) {
        helperBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ error: "preflight blocked" }, { status: 503 });
      }
      return base(url, init);
    });
    vi.stubGlobal("fetch", fetch);
    const workerFactory = vi.fn(createWorkerSuccess());

    render(<ClaimFlow createWorker={workerFactory} />);
    await connectSafeWalletToProofs();
    await chooseDesktopProofMethod();
    const recoveryInputs = fillRecoveryPhraseInputs();
    fireEvent.click(screen.getByRole("button", { name: "Generate proofs" }));

    expect(await screen.findByText(/preflight blocked/i)).toBeInTheDocument();
    expect(helperBodies).toEqual([{ preflight_only: true }]);
    expect(recoveryInputs.every((input) => input.value.length > 0)).toBe(true);
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it("proves through the currently published helper when loopback permission is granted", async () => {
    const permissionQuery = vi.fn(async () => ({ state: "granted" as PermissionState }));
    vi.stubGlobal("navigator", { permissions: { query: permissionQuery } });
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    const draft = claimDraft([`${"a".repeat(64)}#0`]);
    const publishedStatus: Record<string, unknown> = { ...helperStatus() };
    delete publishedStatus.capabilities;
    const fetch = claimFlowFetch({
      draft,
      helperStatus: publishedStatus,
      legacyDesktopPreflight: true,
    });
    vi.stubGlobal("fetch", fetch);
    const workerFactory = vi.fn(createWorkerSuccess());

    render(<ClaimFlow createWorker={workerFactory} />);
    await connectSafeWalletToProofs();
    await chooseDesktopProofMethod();
    const recoveryInputs = fillRecoveryPhraseInputs();
    fireEvent.click(screen.getByRole("button", { name: "Generate proofs" }));

    expect(await screen.findByRole("heading", { name: "Proofs ready" })).toBeInTheDocument();
    const helperCalls = fetch.mock.calls.filter(([url]) => String(url).endsWith("/prove-destination"));
    expect(helperCalls).toHaveLength(2);
    expect(JSON.parse(String(helperCalls[0]?.[1]?.body))).toEqual({ preflight_only: true });
    expect(permissionQuery).toHaveBeenCalledWith({ name: "loopback-network" });
    expect(workerFactory).toHaveBeenCalledOnce();
    expect(recoveryInputs.every((input) => input.value === "")).toBe(true);
  });

  it("blocks denied loopback permission before reading or clearing the recovery phrase", async () => {
    const permissionQuery = vi.fn(async () => ({ state: "denied" as PermissionState }));
    vi.stubGlobal("navigator", { permissions: { query: permissionQuery } });
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    const fetch = claimFlowFetch({ draft: claimDraft([`${"a".repeat(64)}#0`]) });
    vi.stubGlobal("fetch", fetch);
    const workerFactory = vi.fn(createWorkerSuccess());

    render(<ClaimFlow createWorker={workerFactory} />);
    await connectSafeWalletToProofs();
    await chooseDesktopProofMethod();
    const recoveryInputs = fillRecoveryPhraseInputs();
    fireEvent.click(screen.getByRole("button", { name: "Generate proofs" }));

    expect(await screen.findByText(/Local device access is blocked/i)).toBeInTheDocument();
    expect(permissionQuery).toHaveBeenCalledWith({ name: "loopback-network" });
    expect(recoveryInputs.every((input) => input.value.length > 0)).toBe(true);
    expect(workerFactory).not.toHaveBeenCalled();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/status"))).toBe(false);
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/prove-destination"))).toBe(false);
  });

  it("explains that the phrase was cleared after a proof failure and disables Retry until re-entry", async () => {
    window.history.replaceState(null, "", "/claim#helper=127.0.0.1:49152&pair=pair-secret");
    installWallets({
      impacted: walletApi({ getChangeAddress: walletAddressHex, getUsedAddresses: [usedWalletAddressHex] }),
      safe: walletApi({ getChangeAddress: safeWalletAddressHex, getUsedAddresses: [safeWalletAddressHex] }),
    });
    vi.stubGlobal("fetch", claimFlowFetch({ draft: claimDraft([`${"a".repeat(64)}#0`]) }));

    render(<ClaimFlow createWorker={createWorkerFailure("invalid BIP-39 seed phrase")} />);

    await connectSafeWalletToProofs();
    await chooseDesktopProofMethod();
    fillRecoveryPhraseInputs();
    fireEvent.click(screen.getByRole("button", { name: "Generate proofs" }));

    expect(await screen.findByText(/Proof generation stopped/i)).toBeInTheDocument();
    expect(
      screen.getByText(/For your security your recovery phrase was cleared — re-enter it before retrying/i),
    ).toBeInTheDocument();
    // The cleared grid keeps Retry disabled until the phrase is re-entered.
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry proofs" })).toBeDisabled());

    fillRecoveryPhraseInputs();
    expect(screen.getByRole("button", { name: "Retry proofs" })).toBeEnabled();
  });
});

async function connectImpactedAndContinueToSafeWallet() {
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  fireEvent.click(await screen.findByRole("button", { name: "Connect impacted wallet" }));
  expect(await screen.findByRole("heading", { name: "Available claims" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Continue to safe wallet" }));
  expect(await screen.findByRole("heading", { name: "Connect safe wallet" })).toBeInTheDocument();
}

async function connectSafeWalletToProofs() {
  await connectImpactedAndContinueToSafeWallet();
  fireEvent.click(await findSafeWalletOption());
  fireEvent.click(screen.getByRole("button", { name: "Connect safe wallet" }));
  // C17: connecting stays on the safe-wallet screen; an explicit confirm
  // advances to proof creation.
  fireEvent.click(await screen.findByRole("button", { name: "Confirm destination and continue" }));
  expect(await screen.findByRole("heading", { name: "Create proofs" })).toBeInTheDocument();
}

// C28: Generate stays disabled until every recovery-word input passes the
// BIP-39 wordlist check, and the click-time checksum validation must pass, so
// flow tests fill the grid with a real checksum-valid phrase.
function fillRecoveryPhraseInputs() {
  const words = recoveryPhrase24.split(" ");
  const recoveryInputs = screen.getAllByLabelText(/Recovery word \d+/) as HTMLInputElement[];
  recoveryInputs.forEach((input, index) => {
    fireEvent.change(input, { target: { value: words[index % words.length] } });
  });
  return recoveryInputs;
}

async function chooseDesktopProofMethod() {
  const localHelperTile = screen.getByText("Local proof method").closest("section");
  expect(localHelperTile).not.toBeNull();
  fireEvent.click(within(localHelperTile as HTMLElement).getByRole("button", { name: "Choose method" }));
  const methodDialog = await screen.findByRole("dialog", { name: "Choose how to create proofs" });
  fireEvent.click(within(methodDialog).getByRole("radio", { name: /Proof Helper Desktop/i }));
  fireEvent.click(within(methodDialog).getByRole("button", { name: "Continue to desktop app" }));
  const installDialog = await screen.findByRole("dialog", { name: "Choose your installer" });
  fireEvent.click(within(installDialog).getByRole("button", { name: "Close installer chooser" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose your installer" })).not.toBeInTheDocument());
}

async function findSafeWalletOption() {
  await waitFor(() => {
    expect(
      screen.getAllByRole("button").some((button) => button.querySelector("strong")?.textContent?.trim() === "Safe"),
    ).toBe(true);
  });
  const button = screen.getAllByRole("button").find((candidate) => candidate.querySelector("strong")?.textContent?.trim() === "Safe");
  if (!button) {
    throw new Error("Safe wallet option not found.");
  }
  return button;
}

function writeResumeSnapshotForTest({
  screen,
  draft,
  build,
}: {
  screen: string;
  draft: ReturnType<typeof claimDraft>;
  build?: ReturnType<typeof claimBuild>;
}) {
  window.localStorage.setItem(
    "proof-tool.claim-flow.resume.v1",
    JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      screen,
      selectedImpactedWallet: "impacted",
      selectedSafeWallet: "safe",
      impactedWallet: {
        walletId: "impacted",
        walletName: "Impacted",
        networkId: 0,
        addresses: [walletAddressHex],
        credentials: [credential, usedCredential],
      },
      safeWallet: {
        walletId: "safe",
        walletName: "Safe",
        networkId: 0,
        addresses: [safeWalletAddressBech32],
        credentials: [safeCredential],
        changeAddress: safeWalletAddressBech32,
      },
      claimRows: [],
      claimIndexerTotal: 1,
      pendingOutrefs: [],
      draft,
      proofArtifacts: destinationProofResponse(draft).artifacts.map((item) => item.artifact),
      build: build ?? null,
    }),
  );
}

function installWallets({
  impacted,
  safe,
}: {
  impacted: Record<string, unknown>;
  safe: Record<string, unknown>;
}) {
  Object.defineProperty(window, "cardano", {
    configurable: true,
    value: {
      impacted: {
        name: "Impacted",
        enable: vi.fn().mockResolvedValue(impacted),
      },
      safe: {
        name: "Safe",
        enable: vi.fn().mockResolvedValue(safe),
      },
    },
  });
}

function installClipboard(text: string) {
  const readText = vi.fn().mockResolvedValue(text);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: {
      readText,
      writeText,
    },
  });
  return { readText, writeText };
}

function installClipboardWrite() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText,
    },
  });
  return writeText;
}

function walletApi(
  options: {
    getNetworkId?: number;
    getChangeAddress: string;
    getUsedAddresses: string[];
    getRewardAddresses?: string[];
    signTx?: ReturnType<typeof vi.fn>;
  },
  flags: { omitSignTx?: boolean } = {},
) {
  const api: Record<string, unknown> = {
    getNetworkId: vi.fn().mockResolvedValue(options.getNetworkId ?? 0),
    getChangeAddress: vi.fn().mockResolvedValue(options.getChangeAddress),
    getUsedAddresses: vi.fn().mockResolvedValue(options.getUsedAddresses),
  };
  if (options.getRewardAddresses) {
    api.getRewardAddresses = vi.fn().mockResolvedValue(options.getRewardAddresses);
  }
  if (!flags.omitSignTx) {
    api.signTx = options.signTx ?? vi.fn().mockResolvedValue("84a100");
  }
  return api;
}

function claimFlowFetch(options: {
  draft?: ReturnType<typeof claimDraft>;
  helperStatus?: Record<string, unknown>;
  destinationProofResponse?: ReturnType<typeof destinationProofResponse>;
  reclaimUtxosResponse?: ReturnType<typeof reclaimUtxos>;
  legacyDesktopPreflight?: boolean;
} = {}) {
  const selectedOutrefs = options.draft?.orderedInputs.map((input) => input.outRefId) ?? [`${"a".repeat(64)}#0`];
  const draft = options.draft ?? claimDraft(selectedOutrefs);
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlText = String(url);
    if (urlText === "/claim-api/deployment") {
      return jsonResponse(claimDeployment());
    }
    if (urlText.startsWith("/claim-api/reclaim-utxos")) {
      return jsonResponse(options.reclaimUtxosResponse ?? reclaimUtxos());
    }
    if (urlText === "/claim-api/draft") {
      return jsonResponse(draft);
    }
    if (urlText === "http://127.0.0.1:49152/status") {
      return jsonResponse(options.helperStatus ?? helperStatus());
    }
    if (urlText === "http://127.0.0.1:49152/prove-destination") {
      const body = init?.body ? JSON.parse(String(init.body)) as { preflight_only?: boolean } : {};
      if (body.preflight_only) {
        if (options.legacyDesktopPreflight) {
          return jsonResponse({
            code: "invalid_request",
            error: "The destination proof request was not valid JSON.",
          }, { status: 400 });
        }
        return jsonResponse({ ok: true, capability: "prove-destination-preflight-v1" });
      }
      return jsonResponse(options.destinationProofResponse ?? destinationProofResponse(draft));
    }
    if (urlText === "/claim-api/build") {
      return jsonResponse(claimBuild(draft));
    }
    if (urlText === "/claim-api/submit") {
      return jsonResponse(claimSubmit(selectedOutrefs));
    }
    if (urlText.startsWith("/claim-api/progress")) {
      return jsonResponse(claimProgress(selectedOutrefs));
    }
    throw new Error(`Unexpected fetch ${urlText} ${init?.method ?? "GET"}`);
  });
}

function createWorkerSuccess() {
  return () => {
    let listener: ((event: MessageEvent) => void) | null = null;
    return {
      postMessage(message: unknown) {
        const request = message as { id: string };
        listener?.({
          data: {
            id: request.id,
            type: "master-xprv",
            masterXPrv: new Uint8Array(96).fill(7).buffer,
          },
        } as MessageEvent);
      },
      terminate: vi.fn(),
      addEventListener(_type: "message", nextListener: (event: MessageEvent) => void) {
        listener = nextListener;
      },
      removeEventListener() {
        listener = null;
      },
    };
  };
}

function createWorkerFailure(message: string) {
  return () => {
    let listener: ((event: MessageEvent) => void) | null = null;
    return {
      postMessage(msg: unknown) {
        const request = msg as { id: string };
        listener?.({
          data: {
            id: request.id,
            type: "error",
            code: "invalid-seed-phrase",
            message,
          },
        } as MessageEvent);
      },
      terminate: vi.fn(),
      addEventListener(_type: "message", nextListener: (event: MessageEvent) => void) {
        listener = nextListener;
      },
      removeEventListener() {
        listener = null;
      },
    };
  };
}

function jsonResponse(value: unknown, init: ResponseInit = { status: 200 }) {
  return new Response(JSON.stringify(value), init);
}

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

function statementBoundV2Deployment() {
  const deployment = claimDeployment();
  return {
    ...deployment,
    deployment: {
      ...deployment.deployment,
      reclaimGlobalProofSlotEncoding: "full-proof-plus-public-input-digest-v2",
      batching: {
        default_utxo_count: 6,
        optimization_utxo_count: 6,
        hard_max_utxo_count: 7,
        max_tx_cpu_percent: 90,
        max_tx_mem_percent: 80,
        distinct_7_opt_in: {
          request_parameter: "maxUtxos",
          request_value: 7,
          require_explicit_request: true,
          require_measured_execution_units: true,
        },
      },
    },
  };
}

function claimDraft(selectedOutrefs: string[]) {
  return {
    draftId: "a1".repeat(32),
    deploymentId: "preprod:reclaim-base:commit",
    network: "Preprod",
    networkId: 0,
    proofProfile: "single-destination",
    batchCap: {
      requested: selectedOutrefs.length,
      default: 4,
      hardMax: 5,
    },
    orderedInputs: selectedOutrefs.map((outRefId, index) => ({
      outRef: {
        txHash: outRefId.split("#")[0],
        outputIndex: Number(outRefId.split("#")[1]),
      },
      outRefId,
      value: index === 0 ? { lovelace: "1500000", [tokenUnit]: "1" } : { lovelace: "1000000" },
      paymentCredential: credential,
      datumCbor: "d8799f",
      confirmation: {
        slot: 10 + index,
      },
    })),
    orderedPaymentCredentials: selectedOutrefs.map(() => credential),
    destinationOutputs: selectedOutrefs.map((outRefId, index) => ({
      outRefId,
      address: safeWalletAddressBech32,
      destinationAddressEncoding: "destination-address-v1",
      destinationAddress: `${"ab".repeat(58)}`,
      value: index === 0 ? { lovelace: "1500000", [tokenUnit]: "1" } : { lovelace: "1000000" },
    })),
    proofRequests: selectedOutrefs.map((outRefId) => ({
      out_ref: outRefId,
      target_credential: credential,
      destination_address_encoding: "destination-address-v1",
      destination_address: `${"ab".repeat(58)}`,
    })),
    expectedDestinationOutputStartIndex: 0,
    safeWallet: {
      changeAddress: safeWalletAddressBech32,
      addresses: [safeWalletAddressBech32],
      totalLovelace: "10000000",
      minimumRequiredLovelace: "5000000",
      utxoCount: 1,
    },
    reductions: [],
    buildSupported: true,
  };
}

function helperStatus(profileOverrides: Record<string, unknown> = {}) {
  return {
    connected: true,
    sidecar_version: "0.1.0",
    protocol_version: "proof-helper-v1",
    capabilities: ["prove-destination-preflight-v1"],
    destination_profile: {
      profile: "single-destination",
      key_ready: true,
      compatibility: "ready",
      key_hash: "e".repeat(64),
      key_version: "ownership-destination-v1",
      ...profileOverrides,
    },
  };
}

function destinationProofResponse(draft: ReturnType<typeof claimDraft>, artifactOverrides: Record<string, unknown> = {}) {
  return {
    profile: draft.proofProfile,
    artifacts: draft.proofRequests.map((request) => ({
      out_ref: request.out_ref,
      artifact: {
        schema: "root-ownership-proof-artifact-v1",
        circuit_id: "root-ownership-destination-v1/bls12-381/groth16",
        vk_hash: "e".repeat(64),
        target_credential: request.target_credential,
        destination_address_encoding: request.destination_address_encoding,
        destination_address: request.destination_address,
        public_input_encoding: "single-credential-destination-v1",
        cardano: {
          format: "groth16-bls12-381-bsb22",
          proof_hex: "ab".repeat(192),
          public_input_digest_hex: "cd".repeat(32),
        },
        ...artifactOverrides,
      },
    })),
  };
}

function claimBuild(draft: ReturnType<typeof claimDraft>) {
  return {
    txCbor: "84a1",
    txHash: "1".repeat(64),
    review: {
      deploymentId: draft.deploymentId,
      draftId: draft.draftId,
      selectedOutrefs: draft.orderedInputs.map((input) => input.outRefId),
      transactionInputOrder: draft.orderedInputs.map((input) => input.outRefId),
      destinationOutputStartIndex: 0,
      destinationOutputs: draft.destinationOutputs,
      paramsReferenceInput: {
        outRefId: `${"1".repeat(64)}#0`,
        holderAddress: "addr_test1wparams00000000000000000000000000000000000000000000",
        datumCbor: "d8799f",
      },
      referenceScriptInputs: [
        {
          role: "reclaim_base",
          outRefId: `${"2".repeat(64)}#0`,
          holderAddress: "addr_test1wrefbase000000000000000000000000000000000000000000",
          scriptHash: "a".repeat(56),
          scriptType: "PlutusV3",
        },
        {
          role: "reclaim_global",
          outRefId: `${"3".repeat(64)}#0`,
          holderAddress: "addr_test1wrefglobal00000000000000000000000000000000000000000",
          scriptHash: "c".repeat(56),
          scriptType: "PlutusV3",
        },
      ],
      proofDigests: draft.proofRequests.map((request) => ({
        outRefId: request.out_ref,
        targetCredential: request.target_credential,
        destinationAddress: request.destination_address,
        publicInputDigestHex: "cd".repeat(32),
      })),
    },
    reviewHash: "2".repeat(64),
    reviewToken: "review-token",
    evaluation: {
      redeemers: [{ tag: "withdraw", index: 0, memory: 1, steps: 2 }],
      totalMemory: "1",
      totalSteps: "2",
      memoryPercent: 12,
      cpuPercent: 13,
    },
  };
}

function claimSubmit(selectedOutrefs: string[]) {
  return {
    txHash: "1".repeat(64),
    deploymentId: "preprod:reclaim-base:commit",
    selectedOutrefs,
    reviewHash: "2".repeat(64),
    provider: {
      submitted: true,
    },
    progress: {
      pollAfterSeconds: 20,
    },
  };
}

function claimProgress(selectedOutrefs: string[]) {
  return {
    deploymentId: "preprod:reclaim-base:commit",
    providerAvailable: true,
    outrefs: selectedOutrefs.map((outRefId) => ({
      outRef: {
        txHash: outRefId.split("#")[0],
        outputIndex: Number(outRefId.split("#")[1]),
      },
      outRefId,
      state: "spent_or_unknown",
    })),
    nextBatch: {
      available: false,
      count: 0,
    },
  };
}

function emptyReclaimUtxos() {
  return {
    ...reclaimUtxos(),
    page: {
      ...reclaimUtxos().page,
      total: 0,
    },
    utxos: [],
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

function reclaimUtxosWithMatching(count: number) {
  return {
    ...reclaimUtxos(),
    page: {
      ...reclaimUtxos().page,
      total: count,
    },
    utxos: Array.from({ length: count }, (_, index) =>
      indexedUtxo({
        txHash: (index + 1).toString(16).padStart(64, "0"),
        outputIndex: index,
        paymentCredential: credential,
        value: {
          lovelace: "1000000",
          ...(index === 0 ? { [tokenUnit]: "1" } : {}),
        },
      }),
    ),
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
