# Cardano eUTxO Vulnerability Scan Report

## Scan Metadata

- Target repository root: `/home/gumbo/playground/proof-zk-recovery/proof-tool`
- Pinned commit for audit context: `e4285e414941d12801a1a194a570cc0c111ecd53`
- Focus entrypoint: `mkMultiReclaimGlobal` in `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:477`
- Context artifact: `audit/mkMultiReclaimGlobal/context_report.md`
- Context closure gate: PASS
- Scope note: frontend/off-chain code was excluded except where useful for fixture or mitigation context.

## Category Status

- Scanned:
  - DATUM_VALIDATION
  - ADDRESS_VALIDATION
  - DOUBLE_SATISFACTION
  - MINTING_POLICY
  - VALUE_VALIDATION
  - ACCESS_CONTROL
  - VALIDITY_RANGE
  - DENIAL_OF_SERVICE
  - ARITHMETIC
  - INPUT_VALIDATION
  - STATE_MANAGEMENT
  - STAKING_CREDENTIAL
  - LOGIC_ERROR
  - DOCUMENTATION
  - CONFIGURATION
  - ECONOMIC_DESIGN
  - UPGRADE_SAFETY
  - CODE_QUALITY
  - INFORMATION
- Blocked: none. The required context artifacts are present in `context_report.md`.
- N/A:
  - REENTRANCY: native Cardano eUTxO validation has no EVM-style dynamic call stack or reentrant callee pattern for this target.

## Summary Counts

- Critical: 0
- High: 0
- Medium: 1
- Low: 0
- Informational: 0
- Areas of Interest: 3

## Findings

### [MEDIUM] [STAKING_CREDENTIAL / VALUE_VALIDATION] - Nonzero Reward Withdrawal Can Be Co-Spent Without Being Accounted To The Proof-Bound Destination

1. Category and subcategory (root cause)

   - Category: STAKING_CREDENTIAL and VALUE_VALIDATION.
   - Root cause: the same reward/staking credential is used as the authorization hook for base-script spends, but the global rewarding validator does not constrain the withdrawal amount or require nonzero withdrawn rewards to be included in the proof-bound destination value accounting.

2. Entrypoint identity (script, branch, file:line)

   - Target entrypoint: `mkMultiReclaimGlobal` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:477`.
   - The target only checks that the current script purpose has the `RewardingScript` constructor tag at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:498`.
   - The target extracts `txInfoInputs`, `txInfoReferenceInputs`, and `txInfoOutputs` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:487`, but it does not read or constrain `txInfoWdrl`.
   - The base spending validator requires the configured global credential to be present in withdrawals using `Map.lookup` at `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs:59`, but presence is enough and the amount is ignored at `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs:62`.

3. Context artifacts used (Branch Card, State Graph node, Compliance row)

   - Branch Card: `ReclaimBase Spend Gate`.
   - Branch Card: `Destination Run and Value Coverage`.
   - Threat Boundary row: `Unprivileged user / claimant`.
   - Compliance row: `Base spends require a script-credential withdrawal`.

4. Security invariant (single testable statement)

   A reclaim transaction must not be able to withdraw any nonzero reward balance controlled by the global reward credential unless that withdrawn value is deliberately accounted for by policy, for example by requiring zero withdrawal amount or by adding the withdrawn lovelace to the proof-bound destination coverage check.

5. Adversarial transaction shape (inputs/outputs/redeemer/mint/validity range)

   Preconditions:

   - The deployment's global reward credential is registered or otherwise has a withdrawable reward balance `R > 0`.
   - The attacker can produce a valid multi proof for one or more reclaim-base inputs they are authorized to reclaim.

   Transaction:

   - Spending inputs:
     - One or more `ReclaimBase(globalCredential)` UTxOs whose inline datum payment key hashes match the attacker's valid multi proof.
     - Optional unrelated wallet inputs controlled by the attacker for fees/change.
   - Reference inputs:
     - The parameter UTxO selected by `reclaimParamsIdx`, containing the parameter NFT and inline base script hash.
   - Withdrawal:
     - `txInfoWdrl[globalCredential] = R`, where `R` is the full nonzero reward balance under the same reward credential used to invoke `mkMultiReclaimGlobal`.
   - Redeemer:
     - `reclaimGlobalMultiRedeemerData reclaimParamsIdx reclaimDestinationOutIdx proof`, with a valid proof over the ordered base-input credentials and selected destination address.
   - Outputs:
     - A proof-bound destination run starting at `reclaimDestinationOutIdx` with value at least equal to the aggregate value of the base-script inputs.
     - An attacker-controlled/change output receiving `R` lovelace from the reward withdrawal, or receiving value made possible because the destination coverage excludes `R`.
   - Mint:
     - No mint is required.
   - Validity range:
     - Any range accepted by the ledger; `mkMultiReclaimGlobal` does not inspect validity range fields.

6. Code-path explanation (missing/wrong check and acceptance path)

   - Base spends accept any withdrawal amount because `hasReclaimWithdrawal` only tests whether `Map.lookup globalCredential` returns `Just _` at `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs:59`, and tests explicitly accept a nonzero amount at `contracts/ownership-verifier/test/VerifySpec.hs:132`.
   - The spec also states that the withdrawal amount is not meaningful and only credential presence matters at `docs/reclaim-contracts-spec.md:64`.
   - `mkMultiReclaimGlobal` validates the rewarding context, params reference, proof, and output coverage, but its extracted `TxInfo` fields stop at inputs/reference inputs/outputs at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:487`.
   - `scanMultiReclaimInputs` computes `requiredValue` only by summing matching base input values at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:250`.
   - `scanDestinationOutputs` computes `destinationValue` only from the selected contiguous destination output run at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:389`.
   - The only value coverage check is `requiredValue Value.leq destinationValue` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:444`; withdrawn rewards are not part of `requiredValue`.
   - Therefore, if the ledger permits a nonzero withdrawal under the same script credential, the validator can accept a transaction that proves and pays only the reclaimed base inputs while allowing the reward withdrawal value to be routed elsewhere by normal transaction balancing.

7. Affected component and blast radius

   - Affected target: `Ownership.ReclaimGlobalMulti`.
   - Also affected by the same pattern: the single-path `Ownership.ReclaimGlobal` reward validator, covered in the variant report.
   - Blast radius: nonzero staking/reward balances held by the global reward credential. The finding does not show theft of protected base-script UTxO value; those remain covered by the proof-bound destination `Value.leq` check.

8. Preconditions

   - The global script credential must have a nonzero withdrawable reward balance.
   - The attacker must be able to construct at least one otherwise-valid reclaim transaction that invokes the global rewarding script.
   - No separate deployment policy, off-chain rule, or ledger-level registration policy prevents that reward credential from accruing rewards.

9. Variant locations

   - `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:529` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:558` has the same broad pattern: the rewarding validator validates params, proofs, inputs, and outputs but does not read withdrawal amounts.
   - `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs:59` is the shared base gate that treats withdrawal presence as the trigger.

10. Minimal remediation principle

   - If the global credential is intended only as a zero-amount script-auth hook, enforce zero withdrawal amount in both the base/global contract path or in a shared rewarding-credential invariant that is directly tested.
   - If nonzero rewards are intentionally allowed, add the withdrawn lovelace for the script credential to the value that must be paid to the proof-bound destination, or route it to a fixed treasury/destination by explicit policy.
   - Document and test the deployment invariant: the global reward credential must not be registered/delegated or otherwise allowed to accrue rewards if the contract continues to ignore withdrawal amounts.

11. Regression test idea

   - Build a `ScriptContext` for `reclaimGlobalMultiValidator` with valid params, two valid base inputs, valid `multi-count2` proof/vk fixtures, and `withRewardingScript redeemer globalCredential R` where `R > 0`.
   - Add a destination output covering exactly the aggregate base input value, plus an unrelated attacker output consuming the reward value.
   - Expected after remediation: reject when `R > 0` unless policy explicitly accounts for `R`; accept the existing zero-withdrawal fixture.

## Areas of Interest

### [INCONCLUSIVE] [CONFIGURATION] - Parameter UTxO Holder Immutability Is A Deployment Assumption

- The spec requires the parameter UTxO to be locked at an always-fails script address at `docs/reclaim-contracts-spec.md:89`.
- The target validates token and datum through `validateParams` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:472`, but it does not inspect the referenced output address as an always-fails holder.
- This is not a confirmed target finding because an attacker still needs the unique parameter NFT, and the one-shot policy mints exactly one own token at `contracts/ownership-verifier/src/Ownership/OneShotNFT.hs:33`.
- Keep this as a deployment/configuration test requirement: confirm the actual deployed params UTxO is immutable and cannot be spent/mutated by a privileged or mistaken holder script.

### [INCONCLUSIVE] [INPUT_VALIDATION / CODE_QUALITY] - Parameter Token Check Depends On The First Non-Ada Value Entry

- `hasExactlyOneParamToken` reads `BI.tail valueEntries`, then `BI.head nonAdaEntries`, and compares only that first non-Ada policy id to `paramsCurrencySymbol` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:175`.
- If the params UTxO carries unrelated non-Ada assets before the parameter policy in the underlying map representation, the transaction may fail even when the parameter NFT is present.
- This was not promoted to a finding because the observed effect is liveness/order-sensitivity for malformed parameter UTxOs, not an unauthorized acceptance path; a deployment can keep the params UTxO clean.

### [INCONCLUSIVE] [DOCUMENTATION] - Multi Path Is Specified In Planning Docs More Precisely Than The Main Contract Spec

- `docs/reclaim-contracts-spec.md:66` primarily describes `ReclaimGlobal`, while `docs/reclaim-global-multi-credential-plan.md:124` defines the target multi-credential contract plan.
- The target behavior is covered by code/tests and the multi plan, but the main spec has not been fully updated into a standalone `ReclaimGlobalMulti` specification.
- This is not a security finding by itself; it is a documentation hardening item for future reviews and deployments.

## Categories with No Findings

- DATUM_VALIDATION: base datum presence and 28-byte length are enforced by `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs:76` and `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:267`.
- ADDRESS_VALIDATION: destination bytes are computed from the selected `TxOut` address at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:337`; changed destination tests reject at `contracts/ownership-verifier/test/VerifySpec.hs:437`.
- DOUBLE_SATISFACTION: the multi path aggregates all matching base-input values before one `Value.leq` comparison at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:431`, avoiding per-input underpayment for same-owner batches.
- MINTING_POLICY: `OneShotNFT` requires the seed ref and exactly one own token at `contracts/ownership-verifier/src/Ownership/OneShotNFT.hs:46`; no minting is needed in the target reclaim transaction.
- ACCESS_CONTROL: proof validity, ordered credentials, params NFT, and base-script matching gate the reclaim spend; no signature-only bypass was found.
- VALIDITY_RANGE: the target does not rely on time or slot windows.
- DENIAL_OF_SERVICE: malformed indices, malformed datums, unsupported stake pointers, and malformed proof/VK bytes can reject transactions, but no adversarial forced-lock beyond depositor-chosen bad datum or deployment mistakes was confirmed.
- ARITHMETIC: count bounds and byte lengths are checked at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:354`; no overflow-relevant arithmetic path was confirmed.
- INPUT_VALIDATION: invalid params and output indices reject through `findDataAt` and `dropDataAt` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:134` and `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:157`.
- STATE_MANAGEMENT: the target has no continuing state transition; it consumes base UTxOs and references params.
- LOGIC_ERROR: credential ordering, destination binding, and aggregate value tests cover the intended core flow at `contracts/ownership-verifier/test/VerifySpec.hs:407`.
- ECONOMIC_DESIGN: aside from the confirmed reward-withdrawal accounting issue, no base-value redirection or fee-shifting bug was confirmed.
- UPGRADE_SAFETY: the verifier key is a script parameter per `docs/reclaim-contracts-spec.md:80`; no upgrade path is present in the target.
- CODE_QUALITY: raw `BuiltinData` decoding is sharp but covered by tests for the target invariants; no standalone security finding was confirmed.
- INFORMATION: no sensitive on-chain secret handling exists in this validator.
