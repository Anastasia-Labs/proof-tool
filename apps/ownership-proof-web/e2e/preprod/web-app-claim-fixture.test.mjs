import { describe, expect, it, vi } from "vitest";
import { prepareOrResumeAdaOnlyClaimFixture } from "./web-app-claim-fixture.mjs";

const credential = "a".repeat(56);
const txHash = "b".repeat(64);
const outRefId = `${txHash}#0`;

describe("web-app claim fixture", () => {
  it("resumes the single ADA-only fixture left by an interrupted run", async () => {
    const browserLauncher = { launch: vi.fn() };
    const result = await prepareOrResumeAdaOnlyClaimFixture({
      ...baseOptions(),
      browserLauncher,
      fetchFn: indexFetch([eligibleUtxo()]),
    });

    expect(result).toMatchObject({ outRefId, source: "resumed-existing", nativeAssetCount: 0 });
    expect(browserLauncher.launch).not.toHaveBeenCalled();
  });

  it("funds through the Preview setup page and discovers the exact resulting outref", async () => {
    const calls = [];
    const page = {
      goto: vi.fn(async (url) => calls.push(["goto", url])),
      setDefaultTimeout: vi.fn(),
    };
    const context = {
      close: vi.fn(async () => undefined),
      newPage: vi.fn(async () => page),
    };
    const browser = {
      close: vi.fn(async () => undefined),
      newContext: vi.fn(async () => context),
    };
    const browserLauncher = { launch: vi.fn(async () => browser) };
    const installOnPage = vi.fn(async () => undefined);
    const walletDriver = fixtureWalletDriver({ installOnPage });
    let fetchCount = 0;
    const artifacts = [];

    const result = await prepareOrResumeAdaOnlyClaimFixture({
      ...baseOptions(),
      browserLauncher,
      driverFactory: () => walletDriver,
      fetchFn: async () => jsonResponse(fetchCount++ === 0 ? [] : [eligibleUtxo()]),
      fundingRunner: vi.fn(async () => ({
        artifacts: ["/tmp/funding.json", "/tmp/funding.png"],
        summary: { submittedTxHash: txHash },
      })),
      harnessLoader: vi.fn(async () => ({})),
      outputArtifacts: artifacts,
      sleep: vi.fn(async () => undefined),
    });

    expect(result).toMatchObject({ outRefId, source: "funded-by-lane", fundingTransactionHash: txHash });
    expect(browserLauncher.launch).toHaveBeenCalledWith({ headless: true });
    expect(browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ extraHTTPHeaders: { "x-test": "preview" } }),
    );
    expect(installOnPage).toHaveBeenCalledWith(page);
    expect(calls).toEqual([["goto", "https://proof-tool-preview.vercel.app/reclaim"]]);
    expect(artifacts).toEqual(["/tmp/funding.json", "/tmp/funding.png"]);
    expect(context.close).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
  });

  it("refuses to fund for a wallet file that does not match the Lace compromised role", async () => {
    await expect(
      prepareOrResumeAdaOnlyClaimFixture({
        ...baseOptions(),
        browserLauncher: { launch: vi.fn() },
        driverFactory: () => fixtureWalletDriver({ compromisedCredential: "c".repeat(56) }),
        fetchFn: indexFetch([]),
        harnessLoader: vi.fn(async () => ({})),
      }),
    ).rejects.toMatchObject({ code: "fixture_wallet_identity_mismatch" });
  });

  it("fails closed when more than one claim exists for the dedicated credential", async () => {
    await expect(
      prepareOrResumeAdaOnlyClaimFixture({
        ...baseOptions(),
        browserLauncher: { launch: vi.fn() },
        fetchFn: indexFetch([eligibleUtxo(), { ...eligibleUtxo(), outRefId: `${"c".repeat(64)}#1` }]),
      }),
    ).rejects.toMatchObject({ code: "prepared_claim_not_unique" });
  });
});

function baseOptions() {
  return {
    config: {
      baseUrl: "https://proof-tool-preview.vercel.app",
      outputDir: "/tmp/proof-tool-fixture-test",
    },
    cwd: "/repo/apps/ownership-proof-web",
    env: {},
    expectedPaymentCredential: credential,
    headers: { "x-test": "preview" },
  };
}

function eligibleUtxo() {
  return {
    outRefId,
    state: "unspent",
    datum: { status: "valid", paymentCredential: credential },
    value: { lovelace: "2000000" },
  };
}

function indexFetch(utxos) {
  return async () => jsonResponse(utxos);
}

function jsonResponse(utxos) {
  return {
    status: 200,
    async json() {
      return {
        available: true,
        page: { nextCursor: null },
        utxos,
      };
    },
  };
}

function fixtureWalletDriver(options = {}) {
  return {
    installOnPage: options.installOnPage,
    roleState(role) {
      if (role === "compromised_user") {
        return {
          canSign: false,
          paymentCredential: options.compromisedCredential ?? credential,
        };
      }
      if (role === "reclaim_funder") {
        return { canSign: true };
      }
      return null;
    },
  };
}
