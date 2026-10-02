import { createHash, createPublicKey, verify } from "node:crypto";

export const APPROVAL_SCHEMA = "proof-tool-operator-release-approval-v1";
export const APPROVAL_SCOPE = "adopt-existing-ceremony-assets-for-ownership-proof-web";
const DOMAIN = "proof-tool/operator-release-approval/v1\n";
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// Sorted JSON keys, UTF-8, no whitespace or trailing newline. Arrays retain order.
export function canonicalApprovalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalApprovalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalApprovalJSON(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined || (typeof value === "number" && !Number.isFinite(value))) {
    throw new Error("Operator approval must contain JSON values");
  }
  return encoded;
}

export function approvalJSONDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalApprovalJSON(value)).digest("hex")}`;
}

export function approvalSigningBytes(approval) {
  return Buffer.from(DOMAIN + canonicalApprovalJSON(approval), "utf8");
}

// Trust is supplied by committed application pins, never by the approval payload.
export function verifyOperatorApproval({ approval, signature, trust, deployment, runtimePins }) {
  requireApproval(trust?.schema === "proof-tool-operator-release-trust-v1", "trust schema");
  requireApproval(/^[0-9a-f]{64}$/u.test(trust.public_key_hex ?? ""), "trusted public key");
  const publicBytes = Buffer.from(trust.public_key_hex, "hex");
  const keyID = `ed25519:${createHash("sha256").update(publicBytes).digest("hex")}`;
  requireApproval(trust.key_id === keyID, "trusted key identity");
  requireApproval(/^sha256:[0-9a-f]{64}$/u.test(trust.approval_id ?? ""), "approval pin");
  requireApproval(approvalJSONDigest(approval) === trust.approval_id, "approval digest differs from committed pin");
  requireApproval(signature?.schema === "proof-tool-operator-release-signature-v1", "signature schema");
  requireApproval(signature.algorithm === "ed25519" && signature.key_id === keyID, "signature identity");
  requireApproval(/^[0-9a-f]{128}$/u.test(signature.signature_hex ?? ""), "signature encoding");
  const publicKey = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicBytes]), format: "der", type: "spki" });
  requireApproval(
    verify(null, approvalSigningBytes(approval), publicKey, Buffer.from(signature.signature_hex, "hex")),
    "signature verification failed",
  );
  requireApproval(approval.schema === APPROVAL_SCHEMA && approval.decision === "GO", "GO decision/schema");
  requireApproval(approval.scope === APPROVAL_SCOPE, "approval scope");
  requireApproval(
    approval.authority?.key_id === keyID && approval.authority?.model === "single-repository-operator",
    "operator authority",
  );
  requireApproval(
    approval.original_ceremony_approval?.status === "unavailable-not-authenticated",
    "original approval disclosure",
  );
  requireApproval(approval.authorization?.statement?.length > 0, "operator authorization");
  requireApproval(
    approval.permissions?.deploy_new_mainnet_contracts === false,
    "new Mainnet deployment is outside approval scope",
  );
  requireApproval(deployment?.network === "Mainnet" && deployment.network_id === 1, "Mainnet deployment binding");
  requireApproval(approval.deployment_id === deployment.deployment_id, "deployment identity");
  requireApproval(
    approval.bindings?.deployment_json_sha256 === approvalJSONDigest(deployment),
    "deployment descriptor changed after approval",
  );
  requireApproval(
    approval.bindings?.runtime_pins_json_sha256 === approvalJSONDigest(runtimePins),
    "runtime pins changed after approval",
  );
  requireApproval(approval.ceremony_id === deployment.proof?.mpc_ceremony_id, "ceremony identity");
  requireApproval(approval.candidate_id === deployment.proof?.mpc_candidate_id, "candidate identity");
  requireApproval(approval.mpc_release_id === deployment.planning?.mpc_release_id, "MPC release identity");
  requireApproval(
    approval.original_ceremony_approval.declared_decision_id === deployment.planning?.production_decision_id,
    "original decision declaration",
  );
  const expectedBase = `/proof-releases/${approval.release_id}/`;
  requireApproval(
    runtimePins?.runtime_manifest_url === `${expectedBase}runtime/runtime-manifest.json`,
    "release identity",
  );
  requireApproval(trust.approval_url === `${expectedBase}approval/operator-approval.json`, "approval URL");
  requireApproval(trust.signature_url === `${expectedBase}approval/operator-approval.sig.json`, "signature URL");
  requireApproval(Array.isArray(approval.files) && approval.files.length > 0, "release file inventory");
  const seen = new Set();
  for (const file of approval.files) {
    requireApproval(
      typeof file.path === "string" &&
        file.path.startsWith(expectedBase) &&
        !file.path.includes("..") &&
        /^\/[A-Za-z0-9/._-]+$/u.test(file.path),
      "release file path",
    );
    requireApproval(!seen.has(file.path), "duplicate release file");
    seen.add(file.path);
    requireApproval(
      /^sha256:[0-9a-f]{64}$/u.test(file.sha256) && Number.isSafeInteger(file.size) && file.size > 0,
      "release file pin",
    );
  }
  return { approval_id: trust.approval_id, authority_key_id: keyID, scope: approval.scope };
}

function requireApproval(condition, detail) {
  if (!condition) throw new Error(`Operator release approval: ${detail}`);
}
