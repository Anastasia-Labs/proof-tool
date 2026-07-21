import { describe, expect, it } from "vitest";
import { CML } from "@lucid-evolution/lucid";
import {
  CLAIM_FLOW_SCREENSHOTS,
  assertCompleteScreenshotLedger,
  browserContextHeaders,
  loadWebAppClaimFlowConfig,
  requestContainsRecoveryPhraseMaterial,
  validateBrowserWasmClaimDeployment,
  validateClaimBuildReview,
  validateClaimTransactionSafety,
  validateClaimSubmit,
  validateLocalProductionUrl,
  validatePreviewProvenance,
  validatePreviewUrl,
} from "./web-app-claim-flow-contract.mjs";

const commit = "a".repeat(40);
const outref = `${"b".repeat(64)}#0`;
const deploymentHost = "proof-tool-c4f3n2-example.vercel.app";

describe("web-app claim flow contract", () => {
  it("loads an exact spending Preview run configuration", () => {
    const config = loadWebAppClaimFlowConfig(validEnv(), {
      cwd: "/repo/apps/ownership-proof-web",
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    });

    expect(config.previewUrl.hostname).toBe(deploymentHost);
    expect(config.targetMode).toBe("vercel-preview");
    expect(config.expectedCommitSha).toBe(commit);
    expect(config.prMergeSha).toBe("c".repeat(40));
    expect(config.expectedPrNumber).toBe(42);
    expect(config.fixtureMode).toBe("existing");
    expect(config.expectedOutref).toBe(outref);
    expect(config.outputDir).toContain(
      "output/preprod-web-app-claim-flow-wasm-lace/2026-07-15T12-00-00-000Z-aaaaaaaaaaaa",
    );
  });

  it("defaults to lane-prepared fixture setup when no outref is supplied", () => {
    const env = validEnv();
    delete env.RECLAIM_E2E_CLAIM_OUTREF;
    const config = loadWebAppClaimFlowConfig(env);

    expect(config.fixtureMode).toBe("prepare");
    expect(config.expectedOutref).toBeNull();
    expect(() => loadWebAppClaimFlowConfig({ ...env, RECLAIM_E2E_FIXTURE_MODE: "existing" })).toThrowError(
      expect.objectContaining({ code: "fixture_outref_missing" }),
    );
    expect(() => loadWebAppClaimFlowConfig({ ...validEnv(), RECLAIM_E2E_FIXTURE_MODE: "prepare" })).toThrowError(
      expect.objectContaining({ code: "fixture_configuration_ambiguous" }),
    );
    expect(() => loadWebAppClaimFlowConfig({ ...env, RECLAIM_E2E_PR_MERGE_SHA: "not-a-full-sha" })).toThrowError(
      expect.objectContaining({ code: "pr_merge_commit_invalid" }),
    );
  });

  it("rejects production, non-Vercel, mutable, or non-origin targets", () => {
    expect(() => validatePreviewUrl("https://proof-tool.vercel.app/")).toThrowError(
      expect.objectContaining({ code: "preview_is_production" }),
    );
    expect(() => validatePreviewUrl("https://example.com/")).toThrowError(
      expect.objectContaining({ code: "preview_url_invalid" }),
    );
    expect(() => validatePreviewUrl(`https://${deploymentHost}/claim`)).toThrowError(
      expect.objectContaining({ code: "preview_url_invalid" }),
    );
    expect(() => validatePreviewUrl(`https://${deploymentHost}/?secret=value`)).toThrowError(
      expect.objectContaining({ code: "preview_url_invalid" }),
    );
  });

  it("accepts only an explicitly marked localhost production emulation", () => {
    const env = {
      ...validEnv(),
      RECLAIM_E2E_TARGET_MODE: "local-production",
      RECLAIM_E2E_PREVIEW_URL: "http://127.0.0.1:3917/",
    };
    const config = loadWebAppClaimFlowConfig(env);
    expect(config.targetMode).toBe("local-production");
    expect(validateLocalProductionUrl(env.RECLAIM_E2E_PREVIEW_URL).host).toBe("127.0.0.1:3917");
    expect(
      validatePreviewProvenance(
        {
          schema: "proof-tool-web-build-provenance-v1",
          localPreviewEmulation: true,
          environment: "preview",
          deploymentUrl: "127.0.0.1:3917",
          branchUrl: "127.0.0.1:3917",
          productionUrl: "proof-tool.vercel.app",
          commitSha: commit,
          commitRef: "feature",
          pullRequestId: "42",
        },
        config,
      ),
    ).toMatchObject({ deploymentHost: "127.0.0.1:3917", localPreviewEmulation: true });

    expect(() => validateLocalProductionUrl("http://localhost:3917/")).toThrowError(
      expect.objectContaining({ code: "local_url_invalid" }),
    );
    expect(() =>
      loadWebAppClaimFlowConfig({ ...env, RECLAIM_E2E_VERCEL_BYPASS_SECRET: "do-not-forward" }),
    ).toThrowError(expect.objectContaining({ code: "local_vercel_bypass_forbidden" }));
    expect(() =>
      validatePreviewProvenance(
        {
          schema: "proof-tool-web-build-provenance-v1",
          localPreviewEmulation: true,
          environment: "preview",
          deploymentUrl: deploymentHost,
          productionUrl: "proof-tool.vercel.app",
          commitSha: commit,
          pullRequestId: "42",
        },
        loadWebAppClaimFlowConfig(validEnv()),
      ),
    ).toThrowError(expect.objectContaining({ code: "preview_local_emulation_rejected" }));
  });

  it("binds the exact immutable deployment host, PR, and commit", () => {
    const config = loadWebAppClaimFlowConfig(validEnv());
    expect(
      validatePreviewProvenance(
        {
          schema: "proof-tool-web-build-provenance-v1",
          environment: "preview",
          deploymentUrl: deploymentHost,
          branchUrl: "proof-tool-git-feature-example.vercel.app",
          productionUrl: "proof-tool.vercel.app",
          commitSha: commit,
          commitRef: "feature",
          pullRequestId: "42",
        },
        config,
      ),
    ).toMatchObject({ deploymentHost, commitSha: commit, pullRequestId: "42" });

    expect(() =>
      validatePreviewProvenance(
        {
          schema: "proof-tool-web-build-provenance-v1",
          environment: "preview",
          deploymentUrl: "different-deployment.vercel.app",
          commitSha: commit,
          pullRequestId: "42",
        },
        config,
      ),
    ).toThrowError(expect.objectContaining({ code: "preview_url_not_immutable_deployment" }));
    expect(() =>
      validatePreviewProvenance(
        {
          schema: "proof-tool-web-build-provenance-v1",
          environment: "preview",
          deploymentUrl: deploymentHost,
          commitSha: "c".repeat(40),
          pullRequestId: "42",
        },
        config,
      ),
    ).toThrowError(expect.objectContaining({ code: "preview_commit_mismatch" }));
  });

  it("requires a coherent Preprod deployment with browser-WASM proving", () => {
    expect(
      validateBrowserWasmClaimDeployment({
        available: true,
        deployment: {
          id: "preprod-deployment",
          network: "Preprod",
          networkId: 0,
          sourceCommit: commit,
          verifierVkHash: "blake2b256:" + "d".repeat(64),
          proof: { browser_proving: { id: "browser-assets", enabled: true } },
        },
      }),
    ).toMatchObject({ deploymentId: "preprod-deployment", network: "Preprod", proofAssetId: "browser-assets" });

    expect(() =>
      validateBrowserWasmClaimDeployment({
        available: true,
        deployment: {
          network: "Preprod",
          networkId: 0,
          verifierVkHash: "d".repeat(64),
          proof: { browser_proving: { enabled: false } },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "browser_wasm_unavailable" }));
  });

  it("requires the complete ordered screenshot ledger", () => {
    expect(() => assertCompleteScreenshotLedger(CLAIM_FLOW_SCREENSHOTS)).not.toThrow();
    expect(() => assertCompleteScreenshotLedger(CLAIM_FLOW_SCREENSHOTS.slice(1))).toThrowError(
      expect.objectContaining({ code: "screenshot_ledger_incomplete" }),
    );
  });

  it("binds the reviewed and submitted transaction to one outref and the safe destination", () => {
    const safeAddress = "addr_test1safe";
    const build = {
      txHash: "e".repeat(64),
      review: {
        selectedOutrefs: [outref],
        destinationOutputs: [{ address: safeAddress }],
      },
    };
    expect(validateClaimBuildReview(build, outref, safeAddress)).toBe(build);
    expect(validateClaimSubmit({ txHash: build.txHash, selectedOutrefs: [outref] }, build, outref)).toMatchObject({
      txHash: build.txHash,
    });
    expect(() => validateClaimBuildReview(build, outref, "addr_test1different")).toThrowError(
      expect.objectContaining({ code: "transaction_review_mismatch" }),
    );
    expect(() =>
      validateClaimSubmit({ txHash: "f".repeat(64), selectedOutrefs: [outref] }, build, outref),
    ).toThrowError(expect.objectContaining({ code: "receipt_transaction_mismatch" }));
  });

  it("inspects the actual transaction body before Lace may sign", () => {
    const safeAddress =
      "addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn";
    const safeInputHash = "c".repeat(64);
    const build = transactionBuild({
      inputOutrefs: [outref, `${safeInputHash}#1`],
      outputAddresses: [safeAddress],
      safeAddress,
    });
    const safeUtxos = [{ address: safeAddress, outputIndex: 1, txHash: safeInputHash }];

    expect(validateClaimTransactionSafety(build, outref, safeAddress, safeUtxos)).toBe(build);

    const maliciousOutput = transactionBuild({
      inputOutrefs: [outref, `${safeInputHash}#1`],
      outputAddresses: [
        "addr_test1qzttdu6d96klw8xvme7ctwuv0jg7xns0vm35ksv4l722aupyayzk39uascqj78hynwh3ax5w8ch5n9062k0vpnj3dlpsjt6afz",
      ],
      safeAddress,
    });
    expect(() => validateClaimTransactionSafety(maliciousOutput, outref, safeAddress, safeUtxos)).toThrowError(
      expect.objectContaining({ code: "transaction_safety_mismatch" }),
    );

    const foreignInput = transactionBuild({
      inputOutrefs: [outref, `${"d".repeat(64)}#2`],
      outputAddresses: [safeAddress],
      safeAddress,
    });
    expect(() => validateClaimTransactionSafety(foreignInput, outref, safeAddress, safeUtxos)).toThrowError(
      expect.objectContaining({ code: "transaction_safety_mismatch" }),
    );
  });

  it("uses headers, never URL parameters, for Vercel automation bypass", () => {
    expect(browserContextHeaders({ bypassSecret: "test-bypass-secret" })).toEqual({
      "x-vercel-protection-bypass": "test-bypass-secret",
      "x-vercel-set-bypass-cookie": "true",
    });
    expect(browserContextHeaders({ bypassSecret: "" })).toEqual({});
  });

  it("detects recovery-phrase material before a browser request is released", () => {
    const mnemonic = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    expect(
      requestContainsRecoveryPhraseMaterial(
        "https://preview.vercel.app/collect",
        JSON.stringify({ mnemonic }),
        mnemonic,
      ),
    ).toBe(true);
    expect(
      requestContainsRecoveryPhraseMaterial(
        "https://preview.vercel.app/collect?one=abandon&two=ability&three=able",
        null,
        mnemonic,
      ),
    ).toBe(true);
    expect(
      requestContainsRecoveryPhraseMaterial(
        "https://preview.vercel.app/claim-api/build",
        JSON.stringify({ proof: "00ff" }),
        mnemonic,
      ),
    ).toBe(false);
  });
});

function validEnv() {
  return {
    RECLAIM_E2E_PREVIEW_URL: `https://${deploymentHost}/`,
    RECLAIM_E2E_EXPECTED_COMMIT_SHA: commit,
    RECLAIM_E2E_PR_MERGE_SHA: "c".repeat(40),
    RECLAIM_E2E_EXPECTED_PR_NUMBER: "42",
    RECLAIM_E2E_CLAIM_OUTREF: outref,
    RECLAIM_E2E_SUBMIT_TRANSACTIONS: "1",
    RECLAIM_E2E_LACE_EXTENSION_DIR: "/tmp/lace-extension",
    RECLAIM_E2E_LACE_WALLET_PASSWORD: "test-password",
    PW_USER_DATA_DIR: "/tmp/lace-profile",
    PREPROD_TEST_WALLETS_FILE: "/tmp/preprod-wallets.local.json",
  };
}

function transactionBuild({ inputOutrefs, outputAddresses, safeAddress }) {
  const inputs = CML.TransactionInputList.new();
  for (const value of inputOutrefs) {
    const [txHash, outputIndex] = value.split("#");
    inputs.add(CML.TransactionInput.new(CML.TransactionHash.from_hex(txHash), BigInt(outputIndex)));
  }
  const outputs = CML.TransactionOutputList.new();
  for (const address of outputAddresses) {
    outputs.add(
      CML.TransactionOutput.new(
        CML.Address.from_bech32(address),
        CML.Value.from_coin(2_000_000n),
        undefined,
        undefined,
      ),
    );
  }
  const body = CML.TransactionBody.new(inputs, outputs, 170_000n);
  const transaction = CML.Transaction.new(body, CML.TransactionWitnessSet.new(), true, undefined);
  return {
    txCbor: transaction.to_cbor_hex(),
    txHash: CML.hash_transaction(body).to_hex(),
    review: {
      selectedOutrefs: [outref],
      destinationOutputStartIndex: 0,
      destinationOutputs: [{ address: safeAddress, value: { lovelace: "2000000" } }],
    },
  };
}
