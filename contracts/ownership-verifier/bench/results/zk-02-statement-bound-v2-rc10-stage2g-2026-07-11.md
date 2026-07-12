# ZK-02 Statement-Bound V2 rc.10 Stage 2g Evaluation

Date: 2026-07-11

This is the redacted release-facing record for the statement-bound V2
provider-evaluation gate. It contains no proof bytes, wallet material, key
material, signed transaction, or provider credential.

## Candidate

- Source commit: `2c80985a5e69bd9074e7243cbaeeb6834a3070d1`
- Signed tag: `zk-02-statement-bound-v2-rc.10`
- Proof slot encoding: `full-proof-plus-public-input-digest-v2`
- Batch transcript: `statement-bound-v2`
- Default / optimization / hard maximum: `6 / 6 / 7`
- Seven-slot request: explicit `maxUtxos: 7`
- Release ceilings: 90% CPU, 80% memory

The capacity case contains seven pairwise-distinct payment credentials derived
from the same root private key, seven distinct full proofs, and seven distinct
authenticated public-input digests. This is a benchmark case, not a credential
uniqueness rule. Builders may construct seven duplicate-credential slots, and
must still use measured transaction execution units.

## Verification

- Contract suite: 243 of 243 tests passed.
- Local production-width V2 distinct-7: 8,948,018,437 CPU / 1,617,490 memory.
- Local raw capacity: N=8 fits; N=9 exceeds the raw transaction CPU limit.
- Duplicate-credential/full-proof regression remains accepted.
- Two independent exact-diff security reviews found no semantic or security
  regression in the rc.10 cost optimizations.

## Preprod Provider Evaluation

The guarded Stage 2g evaluator reported:

| Component | CPU | Memory |
| --- | ---: | ---: |
| Seven ReclaimBase spend redeemers | 26,421,557 each | 101,127 each |
| Statement-bound V2 ReclaimGlobal withdrawal | 8,789,543,009 | 1,007,474 |
| **Total** | **8,974,493,908** | **1,715,363** |
| **Protocol-limit percentage** | **90%** | **11%** |

The run was provider-measurement-only: it used synthetic inputs and direct
script attachment, and explicitly performed no signing, submission, funding,
minting, stake registration, deployment, or deployment-record write.

## Disposition

The provider evaluator gate passes. This result does **not** close Gate G2.
G2 still requires a coherent Preprod deployment followed by a real accepted
all-distinct-7 claim transaction, with evaluator and on-chain execution units
recorded and any divergence above 5% investigated before proceeding.

## RC11 provenance follow-up

The signed follow-up commit
`a5a918bfed962d220a68dfe8f5bbe9636630300d` and signed tag
`zk-02-statement-bound-v2-rc.11` close the release-provenance review findings
without changing the validator scripts or benchmark transaction:

- Stage 2g material generation and the guarded deployer require an
  independently supplied manifest public-key file and expected signer ID.
- Direct and symlink-contained bundle anchors reject before wallet access;
  hard-linked bundle anchors reject in the specialized verifier.
- Manifest signature, expected signer identity, readiness marker, and bundle
  hashes verify before Stage 2g wallet access or deployment Cardano-VK export.
- Duplicate credentials remain buildable; distinctness remains confined to
  this capacity benchmark.

A fresh provider-only rerun from RC11 reproduced exactly
`8,974,493,908` CPU / `1,715,363` memory (90% / 11%). Its safety record again
reported false for signing, submission, funding, minting, stake registration,
deployment, and deployment-record writes. No raw provider response, proof,
wallet, or key material is included here.
