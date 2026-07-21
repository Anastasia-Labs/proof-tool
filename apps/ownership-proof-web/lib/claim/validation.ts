import type { ClaimOutRef, ClaimOutRefString } from "./types";

const HEX_RE = /^[0-9a-f]+$/u;
const OUT_REF_RE = /^([0-9a-f]{64})#([0-9]+)$/u;

export function normalizeHex(value: string): string {
  return value.trim().replace(/^0x/iu, "").toLowerCase();
}

export function assertHex(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ClaimValidationError(`${field}_invalid`, `${field} must be a hex string.`);
  }
  const normalized = normalizeHex(value);
  if (normalized.length === 0 || normalized.length % 2 !== 0 || !HEX_RE.test(normalized)) {
    throw new ClaimValidationError(`${field}_invalid`, `${field} must be even-length lowercase hex.`);
  }
  return normalized;
}

export function assertByteHex(value: unknown, field: string, byteLength: number): string {
  const normalized = assertHex(value, field);
  if (normalized.length !== byteLength * 2) {
    throw new ClaimValidationError(`${field}_length`, `${field} must be ${byteLength} bytes.`);
  }
  return normalized;
}

export function assertPaymentKeyHash(value: unknown, field = "paymentCredential"): string {
  return assertByteHex(value, field, 28);
}

export function outRefToString(outRef: ClaimOutRef): ClaimOutRefString {
  return `${outRef.txHash}#${outRef.outputIndex}`;
}

export function assertOutRef(value: unknown, field = "outref"): ClaimOutRef {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    const match = OUT_REF_RE.exec(normalized);
    if (!match) {
      throw new ClaimValidationError(`${field}_invalid`, `${field} must be formatted as txHash#index.`);
    }
    const outputIndex = Number(match[2]);
    if (!Number.isSafeInteger(outputIndex)) {
      throw new ClaimValidationError(`${field}_invalid`, `${field} output index is too large.`);
    }
    return { txHash: match[1], outputIndex };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaimValidationError(`${field}_invalid`, `${field} must be an outref object or txHash#index string.`);
  }
  const raw = value as Record<string, unknown>;
  const txHash = assertByteHex(raw.txHash, `${field}.txHash`, 32);
  const outputIndex = raw.outputIndex;
  if (
    typeof outputIndex !== "number" ||
    !Number.isInteger(outputIndex) ||
    outputIndex < 0 ||
    !Number.isSafeInteger(outputIndex)
  ) {
    throw new ClaimValidationError(`${field}_invalid`, `${field}.outputIndex must be a non-negative safe integer.`);
  }
  return { txHash, outputIndex };
}

export function assertOutRefList(value: unknown, field: string): ClaimOutRef[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ClaimValidationError(`${field}_invalid`, `${field} must be an array.`);
  }

  const seen = new Set<string>();
  const outrefs: ClaimOutRef[] = [];
  for (const [index, rawOutRef] of value.entries()) {
    const outRef = assertOutRef(rawOutRef, `${field}[${index}]`);
    const outRefId = outRefToString(outRef);
    if (seen.has(outRefId)) {
      throw new ClaimValidationError(`${field}_duplicate`, `${field} contains duplicate outref ${outRefId}.`);
    }
    seen.add(outRefId);
    outrefs.push(outRef);
  }
  return outrefs;
}

export function assertExactDeploymentId(value: unknown, expectedDeploymentId: string): void {
  if (value !== expectedDeploymentId) {
    throw new ClaimValidationError("deployment_mismatch", "Selected reclaim deployment is no longer current.");
  }
}

export function assertObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaimValidationError(`${field}_invalid`, `${field} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

export function assertCborHex(value: unknown, field: string): string {
  return assertHex(value, field);
}

export class ClaimValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    // Optional structured, user-safe context (e.g. required vs available
    // lovelace) serialized alongside the code in API error responses.
    readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = "ClaimValidationError";
  }
}
