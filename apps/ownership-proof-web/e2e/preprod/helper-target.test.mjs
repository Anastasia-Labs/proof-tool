import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validatePreprodHelperTarget, writePreprodHelperTargetArtifact } from "./helper-target.mjs";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("preprod helper target", () => {
  it("accepts loopback helper targets and writes a redacted artifact", () => {
    const outputDir = tempDir();
    const target = validatePreprodHelperTarget({
      RECLAIM_E2E_HELPER_URL: "http://127.0.0.1:49152",
      RECLAIM_E2E_HELPER_TOKEN: "pair-secret",
    });

    expect(target).toEqual({
      schema: "proof-tool-preprod-helper-target-v1",
      helperUrl: "http://127.0.0.1:49152",
      token: "pair-secret",
      tokenRequired: true,
    });

    const artifactPath = writePreprodHelperTargetArtifact(target, outputDir);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    expect(artifact).toEqual({
      schema: "proof-tool-preprod-helper-target-v1",
      helperUrl: "http://127.0.0.1:49152",
      tokenRequired: true,
      token: "[redacted]",
    });
    expect(JSON.stringify(artifact)).not.toContain("pair-secret");
  });

  it("rejects missing helper token", () => {
    expectErrorCode(
      () =>
        validatePreprodHelperTarget({
          RECLAIM_E2E_HELPER_URL: "http://127.0.0.1:49152",
        }),
      "helper_token_missing",
    );
  });

  it("rejects non-loopback helper targets", () => {
    expectErrorCode(
      () =>
        validatePreprodHelperTarget({
          RECLAIM_E2E_HELPER_URL: "https://proof.example",
          RECLAIM_E2E_HELPER_TOKEN: "pair-secret",
        }),
      "helper_url_scheme_invalid",
    );
    expectErrorCode(
      () =>
        validatePreprodHelperTarget({
          RECLAIM_E2E_HELPER_URL: "http://proof.example",
          RECLAIM_E2E_HELPER_TOKEN: "pair-secret",
        }),
      "helper_url_not_loopback",
    );
  });

  it("rejects helper URL credentials and endpoint paths", () => {
    expectErrorCode(
      () =>
        validatePreprodHelperTarget({
          RECLAIM_E2E_HELPER_URL: "http://user:pass@127.0.0.1:49152",
          RECLAIM_E2E_HELPER_TOKEN: "pair-secret",
        }),
      "helper_url_credentials_forbidden",
    );
    expectErrorCode(
      () =>
        validatePreprodHelperTarget({
          RECLAIM_E2E_HELPER_URL: "http://127.0.0.1:49152/prove-destination",
          RECLAIM_E2E_HELPER_TOKEN: "pair-secret",
        }),
      "helper_url_path_invalid",
    );
  });
});

function expectErrorCode(fn, code) {
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${code}`);
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-tool-helper-target-"));
  tempDirs.push(dir);
  return dir;
}
