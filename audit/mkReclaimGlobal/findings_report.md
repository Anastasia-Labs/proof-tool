# Cardano eUTxO Vulnerability Scan Report

## Scan Metadata

- Target repository root: `/home/gumbo/playground/proof-zk-recovery/proof-tool`.
- Output directory: `audit/mkReclaimGlobal/`.
- Context artifact used: `audit/mkReclaimGlobal/context_report.md`.
- Context Closure Gate: PASS.
- Target mapping: requested `mkReclaimGlobal` maps to `reclaimGlobalValidatorBuiltin`, `reclaimGlobalValidator`, and `reclaimGlobalValidatorUntyped` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:529`, `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:560`, and `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:569`.
- Scope note: current filesystem includes uncommitted/untracked contract and doc files; scanner findings use current file contents and line numbers.

## Category Status

- Scanned: DATUM_VALIDATION, ADDRESS_VALIDATION, DOUBLE_SATISFACTION, MINTING_POLICY, VALUE_VALIDATION, ACCESS_CONTROL, VALIDITY_RANGE, DENIAL_OF_SERVICE, ARITHMETIC, INPUT_VALIDATION, STATE_MANAGEMENT, STAKING_CREDENTIAL, LOGIC_ERROR, DOCUMENTATION, CONFIGURATION, ECONOMIC_DESIGN, UPGRADE_SAFETY, CODE_QUALITY, INFORMATION.
- Blocked: none. Required context artifacts were present in `context_report.md`.
- N/A: REENTRANCY is EVM-only and not applicable to this native Cardano eUTxO validator set.

## Summary Counts

- Critical: 0
- High: 0
- Medium: 1
- Low: 0
- Informational: 0
- Areas of Interest: 4

## Findings

### [MEDIUM] [ACCESS_CONTROL] - Single ReclaimGlobal Path Accepts Non-Rewarding Script Contexts

1. Category and subcategory: ACCESS_CONTROL / script-purpose confusion.

2. Entrypoint identity: single reclaim global validator mapped from requested `mkReclaimGlobal`; `reclaimGlobalValidatorBuiltin` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:529`, `reclaimGlobalValidator` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:560`, and untyped wrapper at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:569`.

3. Context artifacts used: Scope Manifest target mapping, Entrypoint Table row for `reclaimGlobalValidatorBuiltin`, Branch Card "ReclaimGlobal Parameter Resolution", Branch Card "ReclaimGlobal Input/Proof/Destination Traversal", Compliance Matrix row "Global script purpose must be `RewardingScript`", and Threat Boundary Table row "Unprivileged transaction builder".

4. Security invariant: The global reclaim script must accept only when evaluated for its intended rewarding purpose, not when the same script bytes are used as a spending or minting script.

5. Adversarial transaction shape:

- Inputs:
  - `G`: a UTxO locked at the payment credential for the single `ReclaimGlobal` script hash, with arbitrary value `Vg`. This can be an accidental deposit to the global script address or any cross-purpose use of the same script bytes.
  - `B`: an attacker-controlled `ReclaimBase` UTxO whose resolved output address has `ScriptCredential reclaimBaseScriptHash`, inline `ReclaimBaseDatum attackerPaymentKeyHash`, and value `Vb`.
- Reference inputs:
  - `P` at `reclaimParamsIdx = 0`, containing the legitimate parameter token under `paramsCurrencySymbol` and an inline parameter datum whose first field is `reclaimBaseScriptHash`.
- Redeemer for spending `G` with the global script bytes:
  - `ReclaimGlobalRedeemer { reclaimParamsIdx = 0, reclaimDestinationOutStartIdx = 0, reclaimProofs = [attackerProof] }`.
- Script context purpose for the global script execution spending `G`:
  - `SpendingScript GOutRef (Just someDatum)`, not `RewardingScript`.
- Withdrawals:
  - Include the configured global script credential so the attacker's base input `B` can satisfy `ReclaimBase`.
- Outputs:
  - Output `0` pays the attacker's proof-bound destination address with value at least `Vb`.
  - Another attacker-chosen output receives value `Vg` from the global-script input `G`.
- Proof:
  - `attackerProof` is a valid destination-bound proof for `attackerPaymentKeyHash` and output `0`'s destination address.

6. Code-path explanation:

- The single global validator parses `ctxFields`, then reads only `txInfo` and `redeemer` from `field0` and `field1` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:534` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:545`. It does not read `field2`, which is the V3 `scriptContextScriptInfo`.
- `validateGlobal` resolves the parameter reference input, extracts `baseScriptHash`, parses the verifier key, drops the destination-output prefix, and calls `validateReclaimInputs` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:547` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:558`.
- `validateReclaimInputs` scans all `txInfoInputs`, skips non-base inputs at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:391` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:430`, and therefore ignores the global-script spending input `G` if its address is not the base script hash.
- The attacker-controlled base input `B` is recognized by `isReclaimBaseInput` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:222` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:233`.
- The validator consumes `attackerProof`, computes destination bytes from output `0`, checks `Vb <= output0.value`, and prepares the proof check at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:398` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:424`.
- The destination-bound public input is `ROOT-OWNERSHIP-DESTINATION-v1 || paymentKeyHash || destinationAddress`, defined at `contracts/ownership-verifier/src/Ownership/Verify.hs:71` through `contracts/ownership-verifier/src/Ownership/Verify.hs:78` and used by the no-POK proof path at `contracts/ownership-verifier/src/Ownership/Verify.hs:163` through `contracts/ownership-verifier/src/Ownership/Verify.hs:172`.
- Final batch proof checks run at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:449` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:468`, after which the spending-context execution of the global script accepts.
- The spec explicitly requires the global script purpose to be `RewardingScript ownCredential` at `docs/reclaim-contracts-spec.md:120` through `docs/reclaim-contracts-spec.md:123`, and the prior audit-context branch table records the same purpose gate at `docs/reclaim-contract-audit-context.md:58` through `docs/reclaim-contract-audit-context.md:63`.
- The same package's multi global path shows the expected guard shape by reading `scriptInfo = field2 ctxFields` and requiring constructor tag `2` before `validateGlobal` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:477` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:500`.

7. Affected component and blast radius: the single `Ownership.ReclaimGlobal` path can authorize spending or other non-rewarding use of the same parameterized script bytes. The direct asset-loss blast radius is any value locked under the global validator as a payment script or other cross-purpose deployment; this does not by itself bypass proofs for correctly deployed `ReclaimBase` UTxOs because base spends still require a global withdrawal and matching global validation.

8. Preconditions:

- The single global script bytes are used outside the rewarding/staking context, or funds are accidentally sent to an address whose payment credential is the single global script hash.
- The attacker can provide at least one valid reclaim proof for a matching base input; the attacker can satisfy this by creating their own base UTxO with their own datum and valid proof.
- The legitimate parameter UTxO is available as a reference input.

9. Variant locations:

- `Ownership.ReclaimGlobalMulti` is a mitigated comparator: it checks `scriptInfo` constructor tag `2` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:477` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:500`.
- `Ownership.ReclaimBase` is not a variant because it intentionally requires `SpendingScript _ (Just datum)` before accepting a datum at `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs:52` through `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs:57`.
- Full variant expansion is in `audit/mkReclaimGlobal/variant_reports/finding_1.md`.

10. Minimal remediation principle: mirror the multi-path purpose guard in the single-path global validator. In `reclaimGlobalValidatorBuiltin`, read `scriptContextScriptInfo` from `ctxFields`, require `RewardingScript`, and combine that guard with `validateGlobal` before returning success.

11. Regression test idea: add a negative test that builds a context with the same tx inputs, reference inputs, redeemer, proof, and destination output as the positive `Ownership.ReclaimGlobal` test, but sets `scriptContextScriptInfo` to `SpendingScript` or `MintingScript`. The current tests build ReclaimGlobal contexts through `withRewardingScript` at `contracts/ownership-verifier/test/VerifySpec.hs:624` through `contracts/ownership-verifier/test/VerifySpec.hs:632`; add a sibling helper for non-rewarding script info and assert rejection.

## Areas of Interest

### [AREA OF INTEREST] [MINTING_POLICY / CONFIGURATION] - Single-path parameter token exactness relies on one-shot deployment

The spec requires the referenced output to contain exactly one parameter NFT at `docs/reclaim-contracts-spec.md:123` through `docs/reclaim-contracts-spec.md:126`. The single path only checks that the first non-Ada currency-symbol entry equals `paramsCurrencySymbol` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:178` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:186`; it does not inspect token name count or quantity. The supporting one-shot policy does enforce exactly one own token during minting at `contracts/ownership-verifier/src/Ownership/OneShotNFT.hs:33` through `contracts/ownership-verifier/src/Ownership/OneShotNFT.hs:54`, and the multi-path comparator performs an exact token check at `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:175` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobalMulti.hs:197`. This remains an area of interest, not a confirmed finding, because an unprivileged attacker cannot create extra tokens under the correct one-shot policy after correct deployment.

### [AREA OF INTEREST] [CONFIGURATION] - Parameter holder immutability is assumed, not enforced by the single global script

The spec says the parameter UTxO should be locked at an always-fails script address at `docs/reclaim-contracts-spec.md:87` through `docs/reclaim-contracts-spec.md:91`, and the prior threat table records the holder script as assumed always-fails at `docs/reclaim-contract-audit-context.md:98` through `docs/reclaim-contract-audit-context.md:99`. The single global code accepts any reference input with the parameter policy ID and decodable datum through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:208` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:220`. If the parameter NFT were mutable or spendable by a privileged/deployment actor, changing `reclaimBaseScriptHash` could become catastrophic, but correct always-fails deployment blocks the unprivileged attack path. This should be verified in deployment artifacts or hardened by committing to an expected holder address/script if the design wants on-chain defense in depth.

### [AREA OF INTEREST] [CRYPTOGRAPHIC DESIGN] - Batch challenge transcript excludes explicit public-input bytes

The batch challenge is derived from concatenated proof bytes at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:383` and `contracts/ownership-verifier/src/Ownership/Verify.hs:80` through `contracts/ownership-verifier/src/Ownership/Verify.hs:87`. Payment key hashes and destination bytes enter each proof's `vkX` through the destination digest at `contracts/ownership-verifier/src/Ownership/Verify.hs:75` through `contracts/ownership-verifier/src/Ownership/Verify.hs:78` and the committed-proof calculation at `contracts/ownership-verifier/src/Ownership/Verify.hs:258` through `contracts/ownership-verifier/src/Ownership/Verify.hs:265`, but they are not explicitly transcript-bound into the batching scalar. No concrete forgery was established in this audit; production hardening could domain-separate and hash `(proof, paymentKeyHash, destinationBytes)` tuples into the batch challenge.

### [AREA OF INTEREST] [STAKING_CREDENTIAL / LIVENESS] - Stake pointer destination addresses are unsupported

Destination bytes encode payment credential plus staking credential, but stake pointers intentionally fail at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:289` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:306`. This is a liveness/compatibility limitation rather than a security finding: transactions paying to pointer-stake destinations will be rejected, while no evidence shows acceptance of an unauthorized transaction.

## Categories with No Findings

- DATUM_VALIDATION: base and global reject missing/malformed base datum or bad key-hash length through `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs:73` through `contracts/ownership-verifier/src/Ownership/ReclaimBase.hs:90` and `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:244` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:251`.
- ADDRESS_VALIDATION: destination redirection is checked by computing bytes from the actual output and verifying destination-bound proofs at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:308` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:332`.
- DOUBLE_SATISFACTION: one proof and one destination output are consumed per matching base input in ledger order at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:372` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:527`; no reuse of a single destination output was identified.
- VALUE_VALIDATION: per-input destination value coverage uses `Value.leq` at `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:402` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:406` and `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:486` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:490`.
- VALIDITY_RANGE: no time/slot authorization invariant is specified for this reclaim path.
- DENIAL_OF_SERVICE: malformed indexes/proofs/destinations can fail transactions, but no accepted malicious transaction or protocol-level stuck state was identified.
- ARITHMETIC: no unsafe monetary arithmetic beyond `Value.leq` and batch scalar modular arithmetic was confirmed as exploitable.
- INPUT_VALIDATION: negative and out-of-bounds indexes fail through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:134` through `contracts/ownership-verifier/src/Ownership/ReclaimGlobal.hs:167`.
- STATE_MANAGEMENT: there is no continuing state machine; parameter-state immutability remains a deployment area of interest.
- LOGIC_ERROR: no additional accepted malicious transaction shape was confirmed beyond Finding 1.
- DOCUMENTATION: the docs correctly describe several intended checks; the missing single-path purpose check is captured as Finding 1 rather than a docs-only issue.
- ECONOMIC_DESIGN: no fee, incentive, or MEV-specific invariant was in scope beyond value coverage.
- UPGRADE_SAFETY: no upgrade path is implemented in the scoped validator.
- CODE_QUALITY / INFORMATION: unsafe `BuiltinData` destructuring is common in this PlutusTx style and generally fails closed on malformed data; no code-quality-only security finding was confirmed.
- REENTRANCY: N/A for native Cardano eUTxO.
