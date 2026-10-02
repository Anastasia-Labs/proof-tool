export const APPROVAL_SCHEMA: string;
export const APPROVAL_SCOPE: string;
export function canonicalApprovalJSON(value: unknown): string;
export function approvalJSONDigest(value: unknown): string;
export function approvalSigningBytes(approval: unknown): Buffer;
export function verifyOperatorApproval(options: {
  approval: unknown;
  signature: unknown;
  trust: unknown;
  deployment: unknown;
  runtimePins: unknown;
}): { approval_id: string; authority_key_id: string; scope: string };
