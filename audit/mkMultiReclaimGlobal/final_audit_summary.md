# Final Audit Summary

## Context Quality Status

- Context closure gate: PASS.
- Context artifact: `audit/mkMultiReclaimGlobal/context_report.md`.
- The audit covered the target `mkMultiReclaimGlobal` entrypoint at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:477`, its base spending gate, verifier helpers, one-shot parameter NFT policy, test fixtures, and reclaim specs/plans.
- The audit was performed against the current dirty local worktree at commit `e4285e414941d12801a1a194a570cc0c111ecd53`; implementation files were not edited.

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
| STAKING_CREDENTIAL / VALUE_VALIDATION | 1 |
| Areas of Interest / Inconclusive | 3 |

## Confirmed Findings

1. `RGMM-001` - Medium - Nonzero reward withdrawal can be co-spent without being accounted to the proof-bound destination.
   - Target path: `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:477`.
   - Root cause: the global reward credential is used as the script-authorization hook, but `mkMultiReclaimGlobal` validates base input values against destination outputs without constraining or accounting for a nonzero reward withdrawal under that same credential.
   - Concrete risk: if the global reward credential has a withdrawable balance, any otherwise-valid claimant can include that withdrawal and route the reward value outside the proof-bound destination accounting.

## Variant Expansion

- Required because `RGMM-001` is Medium.
- Variant report written: `audit/mkMultiReclaimGlobal/variant_reports/finding_RGMM-001.md`.
- Confirmed variant: the single-path `Ownership.ReclaimGlobal` validator shares the same reward-withdrawal accounting pattern.
- Mitigated locations: `Ownership.OneShotNFT` and `Ownership.Verify` do not match the reward-withdrawal pattern.

## Systemic Root Causes

- Reward credential dual use: the same script credential serves as the authorization hook for base spends and as a potential Cardano reward account, but withdrawal amount semantics are treated as irrelevant.
- Deployment assumptions not fully enforceable in target code: params holder immutability and reward-account nonuse are documented/deployment expectations rather than direct checks in `mkMultiReclaimGlobal`.
- Spec split: the multi path is most precisely described in the multi-credential plan and tests; the main reclaim spec still centers the single `ReclaimGlobal` path.

## Highest-Priority Remediations

1. Add an explicit reward-withdrawal policy for the global credential:
   - either reject nonzero withdrawals under the global credential;
   - or account withdrawn lovelace into the proof-bound destination or a fixed treasury policy.
2. Apply the same policy to both `Ownership.ReclaimGlobalMulti` and the single `Ownership.ReclaimGlobal` variant.
3. Document deployment requirements:
   - global reward credential must not accrue rewards unless the contract accounts for them;
   - parameter NFT must be held at the intended immutable holder.
4. Tighten the main contract spec so `ReclaimGlobalMulti` has a first-class spec section, not only plan/test coverage.

## Suggested Regression Tests

- Multi path:
  - valid real multi proof, valid params, valid destination coverage, but `withRewardingScript redeemer globalCredential 1234567`; expect rejection after remediation if zero-withdrawal policy is chosen.
  - same transaction with withdrawal amount `0`; expect the current positive fixture to remain accepted.
- Single path:
  - equivalent nonzero-withdrawal test for `reclaimGlobalValidator`.
- Deployment/configuration:
  - assert generated/deployed params UTxO is at the intended immutable holder.
  - assert production setup does not register/delegate the global reward credential, unless nonzero reward accounting is implemented.

## Files Written

- `audit/mkMultiReclaimGlobal/context_report.md`
- `audit/mkMultiReclaimGlobal/findings_report.md`
- `audit/mkMultiReclaimGlobal/variant_reports/finding_RGMM-001.md`
- `audit/mkMultiReclaimGlobal/final_audit_summary.md`
