import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validatePreprodLiveConfig, writePreprodLiveConfigArtifact } from "./live-config.mjs";

const tempDirs = [];
const nativeUnit = `${"a".repeat(56)}4e4654`;

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("preprod live transaction config", () => {
  it("requires native asset config before approved transaction work", () => {
    expect(() => validatePreprodLiveConfig({})).toThrow(/RECLAIM_E2E_NATIVE_ASSET_UNIT/u);
  });

  it("normalizes valid live funding config with conservative defaults", () => {
    const config = validatePreprodLiveConfig({
      RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
    });

    expect(config).toEqual({
      schema: "proof-tool-preprod-live-config-v1",
      adaOnlyAmount: "2",
      nativeAdaAmount: "2",
      nativeAssetUnit: nativeUnit,
      nativeAssetQuantity: "1",
      nativeReclaimCount: 5,
      existingNativeReclaimCount: 0,
      expectedMinimumReclaimUtxos: 6,
    });
  });

  it("counts confirmed existing native reclaim UTxOs without lowering the six-UTxO gate", () => {
    const config = validatePreprodLiveConfig({
      RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
      RECLAIM_E2E_NATIVE_RECLAIM_COUNT: "4",
      RECLAIM_E2E_EXISTING_NATIVE_RECLAIM_COUNT: "1",
    });

    expect(config.nativeReclaimCount).toBe(4);
    expect(config.existingNativeReclaimCount).toBe(1);
    expect(config.expectedMinimumReclaimUtxos).toBe(6);
  });

  it("rejects malformed values before live work", () => {
    expect(() =>
      validatePreprodLiveConfig({
        RECLAIM_E2E_NATIVE_ASSET_UNIT: `${"g".repeat(56)}`,
      }),
    ).toThrow(/lowercase hex/u);
    expect(() =>
      validatePreprodLiveConfig({
        RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
        RECLAIM_E2E_NATIVE_RECLAIM_COUNT: "4",
      }),
    ).toThrow(/at least 5/u);
    expect(() =>
      validatePreprodLiveConfig({
        RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
        RECLAIM_E2E_EXISTING_NATIVE_RECLAIM_COUNT: "-1",
      }),
    ).toThrow(/non-negative integer/u);
    expect(() =>
      validatePreprodLiveConfig({
        RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
        RECLAIM_E2E_ADA_ONLY_AMOUNT: "0",
      }),
    ).toThrow(/positive ADA amount/u);
  });

  it("writes a non-secret live config artifact", () => {
    const outputDir = tempDir();
    const config = validatePreprodLiveConfig({
      RECLAIM_E2E_NATIVE_ASSET_UNIT: nativeUnit,
      RECLAIM_E2E_NATIVE_ASSET_QUANTITY: "2",
      RECLAIM_E2E_NATIVE_RECLAIM_COUNT: "6",
      RECLAIM_E2E_NATIVE_ADA_AMOUNT: "1.5",
    });

    const artifactPath = writePreprodLiveConfigArtifact(config, outputDir);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    expect(artifact.nativeAssetUnit).toBe(nativeUnit);
    expect(artifact.nativeAssetQuantity).toBe("2");
    expect(artifact.nativeReclaimCount).toBe(6);
    expect(JSON.stringify(artifact)).not.toMatch(/mnemonic|seed|xprv|witness|cbor/iu);
  });
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-live-config-"));
  tempDirs.push(dir);
  return dir;
}
