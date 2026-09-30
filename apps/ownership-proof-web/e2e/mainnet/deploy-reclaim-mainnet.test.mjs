import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAINNET_DEPLOY_PROFILE,
  PREPROD_DEPLOY_PROFILE,
  buildManifest,
  deployReclaimMainnet,
  resolveBlockfrostUrl,
  resolveDeployProfile,
  resolveKoiosUrl,
} from "../deploy-reclaim.mjs";

const RECLAIM_PARAMS_TOKEN_NAME = "5245434c41494d504152414d53";
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

function tempRepo() {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "reclaim-mainnet-deploy-"));
  tempDirs.push(repoRoot);
  return repoRoot;
}

describe("deploy network argument", () => {
  it("accepts only preprod and mainnet", () => {
    expect(resolveDeployProfile("preprod")).toBe(PREPROD_DEPLOY_PROFILE);
    expect(resolveDeployProfile("mainnet")).toBe(MAINNET_DEPLOY_PROFILE);
  });

  it("rejects a missing or unknown argument", () => {
    for (const argument of [undefined, "", "Preprod", "main"]) {
      expect(() => resolveDeployProfile(argument)).toThrowError(
        expect.objectContaining({ code: "network_argument_invalid" }),
      );
    }
  });
});

describe("mainnet deploy gates", () => {
  it("rejects a run without the live mainnet gate", async () => {
    await expect(
      deployReclaimMainnet({
        repoRoot: tempRepo(),
        env: {
          RECLAIM_E2E_SUBMIT_TRANSACTIONS: "1",
          RECLAIM_NETWORK: "Mainnet",
          RECLAIM_NETWORK_ID: "1",
        },
      }),
    ).rejects.toMatchObject({ code: "live_mainnet_gate_missing" });
  });

  it("rejects Preprod network and network id 0", async () => {
    const repoRoot = tempRepo();
    const env = {
      RECLAIM_E2E_LIVE_MAINNET: "1",
      RECLAIM_E2E_SUBMIT_TRANSACTIONS: "1",
    };

    await expect(
      deployReclaimMainnet({
        repoRoot,
        env: { ...env, RECLAIM_NETWORK: "Preprod", RECLAIM_NETWORK_ID: "1" },
      }),
    ).rejects.toMatchObject({ code: "network_not_mainnet" });
    await expect(
      deployReclaimMainnet({
        repoRoot,
        env: { ...env, RECLAIM_NETWORK: "Mainnet", RECLAIM_NETWORK_ID: "0" },
      }),
    ).rejects.toMatchObject({ code: "network_id_not_mainnet" });
  });
});

describe("mainnet provider defaults", () => {
  it("selects the Mainnet Blockfrost and Koios URLs", () => {
    expect(resolveBlockfrostUrl(MAINNET_DEPLOY_PROFILE, {})).toBe("https://cardano-mainnet.blockfrost.io/api/v0");
    expect(resolveKoiosUrl(MAINNET_DEPLOY_PROFILE, {})).toBe("https://api.koios.rest/api/v1");
  });
});

describe("mainnet deployment manifest", () => {
  it("records Mainnet identity and omits preprod notes", () => {
    const manifest = buildManifest({
      profile: MAINNET_DEPLOY_PROFILE,
      sourceCommit: "12".repeat(20),
      baseAddress: "addr1_base",
      baseScriptHash: "34".repeat(28),
      globalScriptHash: "56".repeat(28),
      globalRewardAddress: "stake1_global",
      holderScriptHash: "78".repeat(28),
      paramsPolicyId: "9a".repeat(28),
      paramsUnit: `${"9a".repeat(28)}${RECLAIM_PARAMS_TOKEN_NAME}`,
      paramsOutRef: {
        tx_hash: "bc".repeat(32),
        output_index: 0,
        holder_address: "addr1_holder",
      },
      referenceBase: { tx_hash: "de".repeat(32), output_index: 1 },
      referenceGlobal: { tx_hash: "f0".repeat(32), output_index: 2 },
      destination: {
        vkHash: `blake2b256:${"11".repeat(32)}`,
        cardanoVkBlake2b256: `blake2b256:${"22".repeat(32)}`,
      },
      providerName: "blockfrost",
      globalRewardAccountRegistered: true,
    });

    expect(manifest.network).toBe("Mainnet");
    expect(manifest.network_id).toBe(1);
    expect(manifest.deployment_id).toBe(`mainnet:${"34".repeat(28)}:${"12".repeat(20)}`);
    expect(manifest.preprod_notes).toBeUndefined();
    expect(manifest.mainnet_notes).toEqual({
      holder_model: "unspendable-params-holder",
      holder_script_hash: "78".repeat(28),
      destination_key_provenance: "supplied destination key bundle",
      global_reward_address: "stake1_global",
      global_reward_account_registered: true,
    });
    expect(JSON.stringify(manifest)).not.toMatch(/single-actor local Preprod/u);
  });
});
