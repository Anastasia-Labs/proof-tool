# ZK-02 statement-bound capacity comparison — 2026-07-11

This is the mandatory current-V1 versus statement-bound-V2 all-distinct
capacity comparison. The matching machine-readable record, including base,
global, total, delta, headroom, redeemer-size, script-identity, transaction,
and raw provider-redeemer rows, is
[`zk-02-statement-bound-capacity-2026-07-11.json`](zk-02-statement-bound-capacity-2026-07-11.json).

Validator code is frozen at signed commit
`a5a918bfed962d220a68dfe8f5bbe9636630300d` /
`zk-02-statement-bound-v2-rc.11`. Later comparison tooling and documentation
do not change either validator.

## Scope and method

Both profiles use the same repository-backed fixtures in canonical input order:
one normal proof for each of N pairwise-distinct payment credentials derived
from one root private key, N corresponding destination outputs, N
`ReclaimBase` spends, and one `ReclaimGlobal` withdrawal. No proof marker,
duplicate credential, or multi proof is used in the capacity sweep.

The local sweep evaluates every base spending purpose and the global withdrawal
inside the same ledger-shaped context, including one ordinary wallet input. It
uses protocol major version 11, the checked-in Preprod V11 cost-model snapshot
SHA-256 `e710abd050607fddc29d16a930bf222e465f053daed75ea4eebdac8134492bcb`,
and raw limits of 14,000,000 memory / 10,000,000,000 CPU.

## Raw-limit capacity

| Profile | N_exunits | First raw failure | Binding limit |
| --- | ---: | ---: | --- |
| Current proof-only V1 | 7 | 8 | CPU |
| Statement-bound V2 | 8 | 9 | CPU |

The product policy remains stricter than raw capacity: default and optimization
are six, seven is explicit opt-in, and the ceilings are 90% CPU / 80% memory.
Credential duplication is not a builder admission failure.

## Local Preprod-V11 snapshot sweep

| N | V1 total CPU | V2 total CPU | CPU delta | V1/V2 memory | V1/V2 CPU headroom | V1/V2 redeemer bytes | Raw result V1/V2 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 3,309,160,504 | 3,319,221,193 | +0.3040% | 311,497 / 347,672 | 6,690,839,496 / 6,680,778,807 | 357 / 393 | pass / pass |
| 2 | 4,537,149,335 | 4,384,824,626 | -3.3577% | 536,275 / 559,890 | 5,462,850,665 / 5,615,175,374 | 706 / 776 | pass / pass |
| 3 | 5,449,157,715 | 5,297,371,061 | -2.7855% | 747,339 / 771,318 | 4,550,842,285 / 4,702,628,939 | 1,055 / 1,159 | pass / pass |
| 4 | 6,361,173,361 | 6,209,925,454 | -2.3777% | 958,445 / 982,792 | 3,638,826,639 / 3,790,074,546 | 1,404 / 1,542 | pass / pass |
| 5 | 7,273,196,273 | 7,122,487,805 | -2.0721% | 1,169,593 / 1,194,312 | 2,726,803,727 / 2,877,512,195 | 1,753 / 1,925 | pass / pass |
| 6 | 8,185,226,451 | 8,035,058,114 | -1.8346% | 1,380,783 / 1,405,878 | 1,814,773,549 / 1,964,941,886 | 2,102 / 2,308 | pass / pass |
| 7 | 9,097,263,895 | 8,947,636,381 | -1.6447% | 1,592,015 / 1,617,490 | 902,736,105 / 1,052,363,619 | 2,451 / 2,691 | pass / pass |
| 8 | 10,009,308,605 | 9,860,222,606 | -1.4895% | 1,803,289 / 1,829,148 | -9,308,605 / 139,777,394 | 2,800 / 3,074 | fail / pass |
| 9 | 10,921,360,581 | 10,772,816,789 | -1.3601% | 2,014,605 / 2,040,852 | -921,360,581 / -772,816,789 | 3,149 / 3,457 | fail / fail |

The exact base-sum and global-witness split, memory deltas/headroom, and raw
accepted flags for every row are in the JSON record.

Benchmark-shaped 28-byte parameters produce:

| Script | Bytes | PlutusV3 script hash |
| --- | ---: | --- |
| Current base, bound to current global | 435 | `3cbbd982125b9d9481ff249d4b52cc81dddeb6481ead3c4d486d0f96` |
| Current global V1 | 4,467 | `e415ba6bec110da53c26a8c741547666699ae48f4dedd8a9892c9afb` |
| Statement-bound base, bound to statement-bound global | 435 | `3a81e8f7f62f1ad9c16a0d1bed18f72d74a2f3ed9381df12ba51f603` |
| Statement-bound global V2 | 3,648 | `b152f1a1f7e810c62b2a913d5622590770fb7d16a857bdcb6c6cfc67` |

Each base identity is coherently parameterized by the global identity in its
profile. These remain frozen benchmark-shape identities, not deployed script
hashes.

## Guarded Preprod provider comparison, N=7

A provider-only comparison then built two complete unsigned transactions from
the same seven-entry material and canonical order. It used direct attached
scripts, synthetic inputs, and the provider's current limits of 16,500,000
memory / 10,000,000,000 CPU. Neither transaction was signed or submitted.

| Metric | Current V1 | Statement-bound V2 | V2 minus V1 |
| --- | ---: | ---: | ---: |
| Total CPU | 9,124,265,422 | 8,974,493,908 | -149,771,514 (-1.6414%) |
| Total memory | 1,690,788 | 1,715,363 | +24,575 (+1.4534%) |
| CPU headroom | 875,734,578 | 1,025,506,092 | +149,771,514 |
| Memory headroom | 14,809,212 | 14,784,637 | -24,575 |
| Complete unsigned transaction CBOR | 8,546 bytes | 7,966 bytes | -580 bytes |
| Base script | 435 bytes | 435 bytes | 0 |
| Global script | 4,467 bytes | 3,648 bytes | -819 bytes |

Provider-applied script identities:

| Profile | Base hash | Global hash |
| --- | --- | --- |
| V1 | `1e9c23811c11428a3f0150acdf9ff21a7c4ec4d3a1de0c8882f6bddd` | `024026d463fd2c9d94ff4206455280b34f6f79ca9487daed1914cf44` |
| V2 | `a3ca571834bc46b422d1b406b38398113dcf6ab579da3c19ef6325e5` | `1eb8f8a0a121dade8a34658814702159dfeaa3af5033264e37423e08` |

The raw provider rows are seven identical base-spend budgets of
26,421,557 CPU / 101,127 memory plus one withdrawal: V1 is
8,939,314,523 / 982,899; V2 is 8,789,543,009 / 1,007,474.
The JSON record also pins both transaction fingerprints.

## Disposition and remaining evidence

The direct local and provider comparisons favor V2 on CPU, transaction bytes,
and all-distinct raw capacity, while increasing memory slightly and adding the
authenticated digest list. The repeated-full-proof and duplicate-credential
paths remain valid regression cases, not capacity admission rules.

This comparison still does not close Gate G2. It uses synthetic inputs and
direct scripts. G2 requires the coherent V2 reference-script deployment and a
real accepted all-distinct-7 Preprod claim, with the evaluator/on-chain units,
accepted transaction hash, reference-script transaction size, and any
divergence above 5% recorded. All safety fields for the comparison were false:
no signing, submission, funding, minting, stake registration, deployment, or
deployment-record write occurred.
