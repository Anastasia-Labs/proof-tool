# Variant Analysis Report

## Original Finding

- Finding ID: 1
- Severity: Medium
- Category: ACCESS_CONTROL / script-purpose confusion
- Original location: `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:529` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:558`
- Missing/wrong check: the single `ReclaimGlobal` path does not read or validate `scriptContextScriptInfo`, so it can accept a non-rewarding context if the rest of the reclaim proof/reference-input checks pass.
- Original adversarial shape: spend a UTxO locked by the single global validator as a payment script while also including an attacker-controlled matching base input, legitimate parameter reference input, valid destination-bound proof, and covering destination output.

## Root Cause Pattern

The root cause is not generic absence of a signer check. It is a missing purpose discriminator in a validator intended to be used only as a rewarding script. In Plutus V3, the `ScriptContext` carries `scriptContextScriptInfo`; a rewarding-only validator should reject any constructor other than `RewardingScript`.

## Search Strategy

- Direct syntax patterns:
  - `scriptContextScriptInfo`
  - `RewardingScript`
  - `field2 ctxFields`
  - `isRewarding`
  - `reclaimGlobalValidatorBuiltin`
  - `mkMultiReclaimGlobal`
- Semantic equivalent patterns:
  - Validators that parse `ScriptContext` manually and use `field0`/`field1` without checking `field2`.
  - Rewarding validators whose docs/specs require `RewardingScript`.
  - Untyped wrappers for global/rewarding reclaim validators.
- Shared helper/caller traversal:
  - Checked `Ownership.ReclaimGlobal`, `Ownership.ReclaimGlobalMulti`, `Ownership.ReclaimBase`, `Ownership.OneShotNFT`, `Ownership.Verify`, and the ReclaimGlobal test builders in `VerifySpec.hs`.

## Results Summary

- Locations searched:
  - `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs`
  - `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs`
  - `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs`
  - `contracts/ownership-verifier/src/Ownership/OneShotNFT.hs`
  - `contracts/ownership-verifier/src/Ownership/Verify.hs`
  - `contracts/ownership-verifier/test/VerifySpec.hs`
- Confirmed variants: 0
- Mitigated locations: 2
- Inconclusive locations: 1

## Confirmed Variants

None. The confirmed issue is limited to the single `Ownership.ReclaimGlobal` path in the scoped code.

## Mitigated Locations

### `Ownership.ReclaimGlobalMulti`

`mkMultiReclaimGlobal` manually parses `ctxFields`, reads `scriptInfo = field2 ctxFields`, and requires constructor tag `2` before `validateGlobal` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:477` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:500`. This is the direct same-package mitigation pattern for the single-path global validator.

### `Ownership.ReclaimBase`

`ReclaimBase` is a spending validator, not a rewarding validator. Its datum is accepted only when `scriptContextScriptInfo` is `SpendingScript _ (Just datum)` at `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs:52` through `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs:57`, and `reclaimBaseValidator` then requires datum presence and withdrawal presence at `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs:73` through `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs:90`. This is not a variant of a missing rewarding-purpose guard.

## Inconclusive Locations

### `Ownership.OneShotNFT`

The one-shot NFT policy uses `ownCurrencySymbol ctx` at `contracts/ownership-verifier/src/Ownership/OneShotNFT.hs:33` through `contracts/ownership-verifier/src/Ownership/OneShotNFT.hs:44` and is semantically a minting policy, not a rewarding validator. This audit did not establish a cross-purpose accepted transaction shape for `oneShotNFTPolicy`, so it is not treated as a confirmed variant.

## Remediation Strategy

- Add a local purpose guard to `reclaimGlobalValidatorBuiltin`, mirroring the `ReclaimGlobalMulti` pattern:
  - parse `scriptInfo = field2 ctxFields`;
  - require the `RewardingScript` constructor;
  - combine `isRewarding` with `validateGlobal`.
- Add regression tests for the single path:
  - positive rewarding context remains accepted;
  - equivalent `SpendingScript` context is rejected;
  - equivalent `MintingScript` context is rejected.
- Keep this remediation local to `Ownership.ReclaimGlobal`; no variant patch is needed for `Ownership.ReclaimGlobalMulti` or `Ownership.ReclaimBase`.
