import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const workflow = readFileSync(
  path.join(repoRoot, ".github", "workflows", "preprod-web-app-claim-flow-wasm-lace.yml"),
  "utf8",
);

describe("Preprod Lace workflow security boundary", () => {
  it("loads only from pull_request_target and has no branch-controlled dispatch path", () => {
    expect(workflow).toMatch(/^\s*pull_request_target:\s*$/mu);
    expect(workflow).not.toMatch(/^\s*pull_request:\s*$/mu);
    expect(workflow).not.toMatch(/^\s*workflow_dispatch:\s*$/mu);
  });

  it("checks out only the trusted base harness, never the PR head", () => {
    expect(workflow).toContain("BASE_SHA: ${{ github.event.pull_request.base.sha }}");
    expect(workflow).toContain("ref: ${{ steps.bind.outputs.harness_sha }}");
    expect(workflow).toContain("ref: ${{ needs.resolve-preview.outputs.harness_sha }}");
    expect(workflow).not.toMatch(/ref:\s*\$\{\{[^\n]*expected_sha/gu);
  });

  it("pins every third-party action by a full commit SHA", () => {
    const actionUses = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gmu)].map((match) => match[1]);
    expect(actionUses.length).toBeGreaterThanOrEqual(5);
    expect(actionUses.every((value) => /@[0-9a-f]{40}$/u.test(value))).toBe(true);
  });

  it("uses an approved environment and a guarded one-run profile copy", () => {
    expect(workflow).toContain("environment: preprod-lace-e2e");
    expect(workflow).toContain("runs-on: [self-hosted, proof-tool-preprod-lace-ephemeral]");
    expect(workflow).toContain("registered with GitHub's --ephemeral mode");
    expect(workflow).toContain('cp -a "$PROFILE_TEMPLATE_DIR/." "$run_profile_dir/"');
    expect(workflow).toContain('"$RUNNER_TEMP"/proof-tool-lace-*) rm -rf -- "$PW_USER_DATA_DIR"');
    expect(workflow).toContain("if: always()");
  });
});
