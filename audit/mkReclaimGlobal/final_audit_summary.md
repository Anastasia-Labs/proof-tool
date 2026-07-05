# Final Audit Summary

## Context Quality

- Context Closure Gate: PASS.
- Context report: `audit/mkReclaimGlobal/context_report.md`.
- The requested `mkReclaimGlobal` symbol is absent in current code and was mapped to the current single-path implementation: `reclaimGlobalValidatorBuiltin`, `reclaimGlobalValidator`, and `reclaimGlobalValidatorUntyped` in `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:529`, `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:560`, and `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:569`.
- Scope was limited to on-chain contracts, direct tests, and spec/context docs. Frontend/off-chain code was excluded except for mitigation notes.

## Finding Counts

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 0 |
| Informational | 0 |

| Category | Count |
| --- | ---: |
| ACCESS_CONTROL | 1 |

- Areas of Interest: 4
- Variant reports written: 1

## Confirmed Findings

1. Medium ACCESS_CONTROL: single `ReclaimGlobal` path accepts non-rewarding script contexts.
   - Report: `audit/mkReclaimGlobal/findings_report.md`
   - Variant analysis: `audit/mkReclaimGlobal/variant_reports/finding_1.md`
   - Root cause: the single global validator reads `txInfo` and `redeemer` but does not validate `scriptContextScriptInfo`, even though the spec requires `RewardingScript`.

## Systemic Root Causes

- No systemic multi-variant issue was confirmed. The direct same-package comparator, `Ownership.ReclaimGlobalMulti`, already implements a rewarding-purpose guard.
- The main root cause is local divergence between the single-path global validator and the purpose-check pattern already present in the multi-path global validator.

## Highest-Priority Remediations

1. Add a `RewardingScript` purpose guard to `reclaimGlobalValidatorBuiltin`, mirroring `mkMultiReclaimGlobal`.
2. Add negative tests for single-path `ReclaimGlobal` under `SpendingScript` and `MintingScript` contexts.
3. Consider hardening the single-path parameter NFT check to match `ReclaimGlobalMulti`'s exact token-count check.
4. Verify deployment artifacts prove the parameter NFT is locked at the intended always-fails holder script.
5. Consider expanding the batch transcript to include `(proof, paymentKeyHash, destinationAddress)` tuples for defense-in-depth review.

## Suggested Regression Tests

- Single `ReclaimGlobal` rejects a context identical to the positive reclaim test except `scriptContextScriptInfo = SpendingScript`.
- Single `ReclaimGlobal` rejects a context identical to the positive reclaim test except `scriptContextScriptInfo = MintingScript`.
- Single `ReclaimGlobal` accepts the existing rewarding positive path after the guard is added.
- Parameter reference with correct policy ID but malformed token structure is rejected if a stricter token-count check is added.
- Deployment/manifest test confirms the parameter NFT UTxO is locked under the documented always-fails script.

## Files Written

- `audit/mkReclaimGlobal/context_report.md`
- `audit/mkReclaimGlobal/findings_report.md`
- `audit/mkReclaimGlobal/variant_reports/finding_1.md`
- `audit/mkReclaimGlobal/final_audit_summary.md`
