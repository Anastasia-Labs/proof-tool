# Variant Analysis Report

## Original Finding

- ID: RGMM-001
- Severity: Medium
- Category: STAKING_CREDENTIAL / VALUE_VALIDATION
- Original location: `mkMultiReclaimGlobal` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:477`
- Missing/wrong check: the global rewarding validator does not constrain nonzero withdrawal amounts under its own reward credential or include those withdrawn rewards in proof-bound destination value accounting.
- Original adversarial transaction shape: a valid multi-reclaim transaction spends authorized base inputs, includes a parameter reference input, uses a valid multi proof, pays the proof-bound destination only the aggregate base-input value, and also withdraws `R > 0` rewards under the same global reward credential to unrelated outputs.

## Root Cause Pattern

The root cause is not "uses withdrawals" by itself. The precise pattern is:

1. A base spending validator treats presence of a configured global reward credential in `txInfoWdrl` as authorization.
2. A global rewarding validator validates proof coverage and base-input output coverage.
3. The global rewarding validator does not read or restrict the actual withdrawal amount for the reward credential that invoked it.
4. The value coverage check accounts for protected base-input value but not value introduced by a nonzero reward withdrawal under the same credential.

## Search Strategy

- Direct syntax patterns:
  - `txInfoWdrl`
  - `withRewardingScript`
  - `RewardingScript`
  - `reclaimGlobalValidator`
  - `reclaimGlobalMultiValidator`
  - `Value.leq`
- Semantic traversal:
  - Identify all validators that can be invoked as rewarding scripts.
  - For each, check whether `TxInfo.txInfoWdrl` is read.
  - For each value-coverage branch, check whether coverage includes only spent input value or also withdrawn reward value.
- Shared helper/caller traversal:
  - `ReclaimBase.hasReclaimWithdrawal` at `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs:59`.
  - Test context builder `withRewardingScript` at `contracts/ownership-verifier/test-support/ScriptContextBuilder.hs:324`.

## Results Summary

- Locations searched:
  - `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs`
  - `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs`
  - `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs`
  - `contracts/ownership-verifier/src/Ownership/OneShotNFT.hs`
  - `contracts/ownership-verifier/src/Ownership/Verify.hs`
  - `contracts/ownership-verifier/test/VerifySpec.hs`
  - `docs/reclaim-contracts-spec.md`
  - `docs/reclaim-contract-audit-context.md`
- Confirmed variants: 1
- Mitigated locations: 2
- Inconclusive locations: 1

## Confirmed Variants

### [MEDIUM] [STAKING_CREDENTIAL / VALUE_VALIDATION] - Single ReclaimGlobal Reward Withdrawal Amount Is Also Unaccounted (Variant of Finding #RGMM-001)

1. Category and subcategory

   - Category: STAKING_CREDENTIAL / VALUE_VALIDATION.
   - Root cause: same presence-only rewarding-credential hook and output coverage that excludes nonzero reward withdrawal value.

2. Entrypoint identity

   - `reclaimGlobalValidatorBuiltin` starts at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:529`.
   - `reclaimGlobalValidator` wraps it at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:560`.

3. Context artifacts used

   - Context Branch Card: `ReclaimBase Spend Gate`.
   - Context Branch Card: single `ReclaimGlobal` comparison entry in `Entrypoint Table`.
   - Compliance row: base spends require a global withdrawal presence check.

4. Security invariant

   The single-proof global reward validator must not authorize withdrawal of unrelated nonzero reward-account value unless that value is explicitly constrained by zero-amount policy or destination accounting.

5. Adversarial transaction shape (specific to this variant)

   Preconditions:

   - The global reward credential used by `ReclaimBase` has withdrawable rewards `R > 0`.
   - The attacker has a valid destination-bound single proof for at least one reclaim-base input.

   Transaction:

   - Spending inputs:
     - One `ReclaimBase(globalCredential)` UTxO with inline `ReclaimBaseDatum` matching the attacker's valid destination-bound proof.
   - Reference inputs:
     - Parameter UTxO selected by `reclaimParamsIdx`.
   - Withdrawal:
     - `txInfoWdrl[globalCredential] = R`.
   - Redeemer:
     - `reclaimGlobalRedeemerData reclaimParamsIdx destinationOutStartIdx [proof]`.
   - Outputs:
     - Destination output at `destinationOutStartIdx` pays exactly the reclaim-base input value to the proof-bound destination.
     - Separate attacker/change output receives `R` or benefits from transaction balancing of the withdrawn rewards.
   - Mint:
     - None required.

6. Code-path explanation

   - `ReclaimBase` accepts withdrawal presence regardless of amount through `Map.lookup` at `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs:59`.
   - `reclaimGlobalValidatorBuiltin` extracts `txInfoInputs`, `txInfoReferenceInputs`, and `txInfoOutputs` from `txInfoFields` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:537`.
   - It does not read `txInfoWdrl`; instead, it validates params at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:547`, parses the verifier key at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:551`, and passes inputs plus destination outputs into `validateReclaimInputs` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:553`.
   - For each matching base input, `validateReclaimInputs` checks only `inputValue Value.leq destinationValue` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:404` and `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:488`.
   - Thus the single path has the same acceptance condition for base values while leaving nonzero reward withdrawal value outside destination accounting.

7. Affected component and blast radius

   - Affects `Ownership.ReclaimGlobal` in addition to `Ownership.ReclaimGlobalMulti`.
   - Blast radius is the reward balance under the shared global reward credential, not the base input values.

8. Preconditions

   - Same as original: nonzero rewards under the global credential and an otherwise-valid reclaim transaction.

9. Related variants

   - Original target: `Ownership.ReclaimGlobalMulti`.
   - Shared base gate: `Ownership.ReclaimBase.hasReclaimWithdrawal`.

10. Minimal remediation principle

   - Apply a consistent reward-withdrawal policy across both global validators and the base validator: require zero withdrawal amount for the global credential, or require all nonzero withdrawn lovelace to be explicitly paid to a governed/proof-bound destination.

11. Regression test idea

   - Add single-path and multi-path tests using `withRewardingScript redeemer globalCredential 1234567` and outputs that cover only base input values.
   - Expected after remediation: both reject unless the remediation intentionally accounts for those rewards.

## Mitigated Locations

- `Ownership.OneShotNFT` is a minting policy, not a rewarding validator. It checks the seed ref and own mint only at `contracts/ownership-verifier/src/Ownership/OneShotNFT.hs:46`, so the reward-withdrawal accounting pattern does not apply.
- `Ownership.Verify` has no ledger transaction context or reward withdrawal access; it only verifies proof bytes and public scalars, for example at `contracts/ownership-verifier/src/Ownership/Verify.hs:303`.

## Inconclusive Locations

- `Ownership.ReclaimBase` is not itself the value-leaking rewarding validator, but it is part of the pattern because it treats withdrawal presence as sufficient. The amount is ignored by `hasReclaimWithdrawal` at `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs:59`, and the spec states the amount is not meaningful at `docs/reclaim-contracts-spec.md:64`. It should be patched or tested together with the global validators, but the direct reward-value leak manifests in the rewarding validators.

## Remediation Strategy

1. Decide the intended deployment invariant:
   - If the global credential must never hold rewards, document that it must not be registered/delegated and add deployment checks.
   - If the credential may hold rewards, define where those rewards must go.
2. Enforce the invariant on-chain:
   - Prefer a zero-withdrawal guard for this authorization-hook pattern, because reclaim value coverage already has a separate destination policy.
   - If nonzero withdrawal is allowed, include the withdrawn lovelace in the destination or treasury accounting.
3. Add regression tests for both `ReclaimGlobal` and `ReclaimGlobalMulti` with nonzero withdrawal amounts.
4. Keep EVM-only recurrence separate: this is a Cardano reward-credential accounting issue, not reentrancy.
