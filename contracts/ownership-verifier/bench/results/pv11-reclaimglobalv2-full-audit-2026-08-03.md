# PV11 ReclaimGlobalV2 full-module optimization audit

Date: 2026-08-03
Scope: the complete production `ReclaimGlobalV2` accepted path, preserving the
circuit, 336-byte proof, redeemer/public-input encoding, validator parameters,
and reclaim transaction interface.

## Final exact result

Figures use the checked-in 350-entry Mainnet/Preprod protocol-v11 cost model,
Plutus/Plinth `1.66.0.0`, UPLC `1.1.0`, and the exact non-instrumented applied
scripts.

| Complete N=9 transaction shape | Memory | CPU | Headroom below 10B |
| --- | ---: | ---: | ---: |
| Production-width policy and credential | 668,981 | 9,876,188,159 | 123,811,841 |
| Representative multi-asset paid superset | 671,159 | 9,895,276,763 | 104,723,237 |

The production-width result saves 22,933,066 CPU and 44,160 memory relative to
the immediately preceding 9,899,121,225 result. It saves 71,748,618 CPU from
the supplied 9,947,936,777 starting measurement. Applied production scripts
are 377 bytes for ReclaimBase and 6,363 bytes for ReclaimGlobalV2.

## Retained optimizations

- Removed the production transcript's redundant explicit u16 guard. The
  subsequent two-byte `integerToByteString` enforces the same bound itself.
- Kept folded public-input, commitment-challenge, coefficient-sum, and
  merge-scaled MSM integer representatives unreduced. Native BLS group scalar
  multiplication applies the required reduction modulo the group order.
  Batch powers remain reduced so supported batch widths cannot exceed the MSM
  builtin's scalar-size bound.
- Used the usually-negative affine complement directly. This keeps the
  integer coefficient sum exactly one while preserving the same field/group
  coefficient.
- Kept proof-derived `pub` and `eCmt` representatives unreduced until their
  only consumers, native group scalar multiplications.
- Replaced constant-position `dropList` field projections with cheaper tails.
- Projected the context, transaction info, and redeemer fields together rather
  than independently retraversing those lists.
- Made the >=8 crossover decision once for all three terminal G1 columns, with
  a continuation to avoid constructing and destructing an intermediate tuple.
- Hashes the complete batch transcript once. The batch challenge consumes that
  digest directly; the independent merge challenge hashes `digest || 0x01`.
  This retains transcript commitment and random-oracle domain separation while
  avoiding a second hash of the full 3.4KB N=9 transcript.
- Uses native `valueContains` directly. This costs 1,048,248 CPU on the simple
  exact-value shape but saves 25,396,569 CPU on the accepted representative
  multi-asset-superset shape, materially improving the worst measured live
  transaction shape.
- Removed identity indexing wrappers, dead `field3`/scalar-state/legacy
  point-first folding code, and a redundant success/error conditional. Ordinary builtin-cased
  `if` replaces the thunked conditional in the coefficient-one point fast path.
- Retuned callsite growth from 113 to 300 after simplifying the source. This
  saves 1,584,000 CPU. Growth 350 was remeasured and was 48,000 CPU worse.

The nested Fiat-Shamir derivation uses `D = BLAKE2b-256(T)`, `r = NZ(D)`, and
`s = NZ(BLAKE2b-256(D || 0x01))`. Distinct random-oracle inputs preserve the
independence required by the merged-equation argument; collision resistance of
the transcript commitment prevents different batches from sharing `D`.

## Remaining exact hotspot boundary

The final non-instrumented tally attributes 9,614,239,703 of the global
9,853,632,827 CPU (97.57%) to BLS operations: point uncompression, Miller
loops, three native MSMs, required A/fixed-base scalar multiplications, and the
single final verification. The largest remaining non-BLS items are proof hash
expansion/byte-to-integer conversion and CEK application/variable steps. No
additional source-level wrapper or list traversal approaches the cost of a
cryptographic operation; materially larger reductions now require changing
the proof/verifier algebra rather than another local builtin substitution.

## Measured rejected candidates

| Candidate | Measured effect | Decision |
| --- | ---: | --- |
| `null (dropList 7 coefficients)` crossover | +3,584,202 CPU, +12,348 memory | Reject |
| Count-returning transcript plus Boolean crossover | +141,290 CPU at N=9; +209,193,606 CPU at N=7 | Reject |
| Direct constructor equality/Boolean dispatch | about +3.8M CPU | Reject |
| Per-slot tuple field projection | +536,573 CPU, about +40K memory | Reject |
| `caseList` implementation of individual field access | +884,163 CPU, about +52K memory | Reject |
| Conditional suppression of the apparently-final power update | +451,143 CPU | Reject; laziness already removes unused work |
| Single-policy shape test before the equality value fast path | about +20M CPU on production width | Reject |
| Construct address credential bytes with direct `consByteString` branches | +1,501,713 CPU | Reject |
| Select an integer tag then `consByteString` it onto the hash | +637,713 CPU | Reject |

## Verification

- `pnpm test:all`: all 19 available sections passed; `golangci-lint` was the
  sole skipped section because it is not installed.
- All 133 contract tests pass, including compiled production N=9 acceptance,
  malformed list/width/count rejection, order and digest substitution, and
  isolated Groth16-C and commitment-PoK substitutions.
- Go, Plutus, browser TypeScript, and checked-in golden vectors use the same
  transcript-digest merge challenge.
- The production-width and representative multi-asset N=9 shapes both remain
  below Mainnet's 10B transaction CPU limit with more than 100M CPU headroom.
