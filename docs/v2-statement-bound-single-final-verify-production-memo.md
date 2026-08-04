# Statement-bound V2 single-`finalVerify` production memo

Date: 2026-08-02
Status: **implemented in the canonical production validator; retain the normal
independent cryptographic review gate before a Mainnet deployment**
Scope: `ReclaimGlobalV2` only. The circuit, verification key, proof encoding,
public-input digest, validator parameters, and redeemer encoding are unchanged.

## Decision

The statement-bound V2 verifier may merge the batched Groth16 equation and the
BSB22 commitment-opening equation with one independently derived Fiat-Shamir
challenge. This is the production remediation preferred by the earlier
proof-only review: the verifier key hash, proof count, every proof, and every
authenticated public statement are absorbed before either batching challenge
is derived.

This is not the historical benchmark-only construction reviewed in
`v2-single-final-verify-soundness-memo.md`. That construction omitted the
statements and admitted a generalized-birthday attack against its primary batch
challenge. The live construction closes that boundary: changing a credential,
destination, digest, proof, proof order, count, or verification key changes the
complete transcript and therefore changes both challenges and every batch
weight.

## Frozen transcript and challenges

For scalar-field order

```text
q = 52435875175126190479447740508185965837690552500527637822603658699938581184513
```

the canonical transcript is

```text
domain = ASCII("ROOT-OWNERSHIP-POK-BATCH-v2")
T = domain || vk_hash || u16be(n)
      || proof_0 || statement_digest_0
      || ...
      || proof_(n-1) || statement_digest_(n-1)

len(vk_hash)          = 32
len(proof_i)          = 336
len(statement_digest) = 32
1 <= n <= 65535

NZ(x) = 1 + (big_endian_integer(x) mod (q-1))
D = blake2b_256(T)
r = NZ(D)
s = NZ(blake2b_256(D || 0x01))
w_i = r^i mod q
```

The V2 validator authenticates each statement digest against the corresponding
on-chain base datum credential and destination output before accepting the
batch. The applied verification key hash is host-checked against the exact
672-byte key and is committed to by the resulting script hash.

The `r` and `s` random-oracle inputs are disjoint: `r` consumes the 32-byte
transcript digest directly while the hash query for `s` consumes that digest
plus a one-byte domain suffix.
The count and fixed-width slot framing make concatenation unambiguous.

Because `2^256` is not a multiple of `q-1`, `NZ` has small modulo bias. Every
scalar has probability at most `3/2^256`, approximately `2^-254.415`, rather
than exactly `1/(q-1)`. Production soundness bounds must use that maximum.

## Merged equation

Let the already batched Groth16 relation be `G_L = G_R` and the commitment
opening relation be `P_L = P_R`, where

```text
G_L = product_i ML(w_i A_i, B_i)
D   = sum_i w_i D_i
P   = sum_i w_i PoK_i
C   = sum_i w_i C_i

V   = (sum_i w_i) IC0
    + (sum_i w_i pub_i) IC1
    + (sum_i w_i eCmt_i) K2
    + D

G_R = ML((sum_i w_i) alpha, beta) * ML(V, gamma) * ML(C, delta)
P_L = ML(P, ckG)
P_R = ML(-D, ckGSN)
```

The canonical validator computes

```text
P_s = sum_i (s*w_i mod q) PoK_i = s*P
D_s = s*D

M_L = G_L * ML(P_s, ckG)
M_R = G_R * ML(-D_s, ckGSN)

accept iff finalVerify(M_L, M_R)
```

`D` remains unscaled in `V`; only its commitment-opening occurrence is scaled.
For N>=8, `P_s` is evaluated directly by the PV11 native G1 MSM builtin. This
is algebraically identical to first evaluating `P` and then multiplying the
result by `s`. Smaller batches use the latter form because the MSM builtin's
fixed cost is larger there.

Writing the final-exponentiated residuals as `G = G_L/G_R` and `P_e = P_L/P_R`
in the prime-order target group, the accepted equation is

```text
G * P_e^s = 1.
```

Honest proofs satisfy it. For a fixed transcript and fixed residuals:

- if `P_e = 1`, acceptance is exactly `G = 1`; and
- if `P_e != 1`, at most one scalar `s` can make the product the identity.

Thus an invalid fixed candidate succeeds at the final `s` query with
probability at most `3/2^256`. If the final relevant query is `r`, the residual
is a polynomial of degree at most `n-1`, giving the standard batch-verification
root bound of at most `(n-1)*3/2^256`. The BSB22 SHA-256 XMD challenge retains
the separate assumptions and bounds documented in the earlier memo.

Most importantly, statements can no longer be varied while holding the batch
polynomial fixed. A changed statement digest produces a new `T`, new `r`, new
`s`, and new weights. The earlier independent-list generalized-birthday attack
therefore does not apply to this construction.

## Assumptions and release boundary

The argument relies on:

- BLAKE2b-256 modeled as a random oracle for the transcript commitment and the
  digest-suffix-separated merge challenge;
- the existing Groth16 and BSB22 soundness assumptions;
- prime-order subgroup behavior enforced by the BLS12-381 uncompress builtins;
- the pinned standard gnark setup and unknown cross-base discrete logarithms
  among `gamma`, `ckG`, and `ckGSN`; and
- verification-key, proving-key, circuit, and deployment artifact coherence.

The merge is a conventional probabilistic batch check, not a literal Boolean
conjunction. It preserves production viability under the assumptions above but
does not remove the repository's independent-review and real-network evaluation
release gates. Those are deployment controls, not benchmark-only wiring.

## Implementation and regression evidence

- `Ownership.Verify.verifyCommittedProofMergedBatchWithScaledPokBatchVK`
  implements the exact merged pairing product.
- `Ownership.Verify.verifyCommittedProofMergedBatchSumOneWithScaledPokBatchVK`
  and `coefficientFirstVkXSumOne` specialize its terminal fixed-base work for
  the affine coefficient sum of one.
- `Ownership.ReclaimGlobalV2.affineBatchCoefficient` keeps every N>1 proof
  coefficient transcript-dependent while closing their field sum to one.
- `Ownership.ReclaimGlobalV2.finishBatchColumns` makes the batch-size decision
  once for all three G1 columns and implements the direct `s*w_i` MSM plus the
  short-batch scalar-fold fallback.
- The canonical exported `reclaimGlobalValidatorV2Code` calls the merged
  verifier; there is no benchmark selector or alternate validator involved.
- Algebraic tests compare both hybrid columns with individual scalar folding
  for every N=1..9.
- The compiled production script accepts the source-backed N=9 batch and
  rejects isolated valid-curve substitutions in Groth16 C and BSB22 PoK.
- The existing compiled negative matrix continues to reject malformed widths,
  digest/proof asymmetry, statement reordering, count mismatch, zero slots,
  destination substitution, and value underpayment.

Primary research references:

- Fiat-Shamir Transformation of special-sound protocols:
  https://eprint.iacr.org/2023/1945
- Fiat-Shamir Transformation of Multi-Round Interactive Proofs:
  https://eprint.iacr.org/2021/1377
- CIP-133 BLS12-381 multi-scalar multiplication:
  https://cips.cardano.org/cip/CIP-133
