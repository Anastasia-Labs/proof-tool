# PV11 N=9 production-safety profile

Date: 2026-08-03
Scope: canonical statement-bound `ReclaimGlobalV2`, the unchanged ownership-
destination circuit/proof/redeemer/public-input/parameter interface, and the
checked-in 350-entry protocol-v11 PlutusV3 cost model. The cost-model array is
byte-for-byte equal to the live Mainnet epoch-647 array queried on 2026-08-02.

## Production target

The live release policy requires a complete transaction, not an isolated
validator, to remain at or below 90% of Mainnet transaction CPU and 80% of
Mainnet transaction memory:

- CPU: `9,000,000,000` of `10,000,000,000`
- memory: `13,200,000` of `16,500,000`

The target leaves room for realistic transaction-context and multi-asset Value
variation. Raw acceptance just below 10B is not a production release result.

## Method

The profile uses three complementary measurements:

1. Exact complete-script budgets come from the ordinary non-instrumented CEK
   evaluator and the checked-in Mainnet-equal cost model.
2. `Cek.tallying` attributes that exact, unchanged UPLC term to builtins and CEK
   nodes. Run it with `OWNERSHIP_V2_PROFILE=tally-n9`.
3. A separate build using Plinth `profile-all`,
   `conservative-optimisation`, and retained traces identifies inclusive source
   regions. Run it with `OWNERSHIP_V2_PROFILE=n9`. Instrumented totals are not
   used as benchmark results because instrumentation changes compilation.

This follows the official Plinth profiling guidance: fully apply the script,
use budget-bearing traces for attribution, and measure accepted deltas against
the non-profiled script.

## Current exact result

All rows below use Plutus/Plinth `1.66.0.0`, target UPLC `1.1.0`, builtin
casing, and the exact protocol-v11 evaluator.

| Complete N=9 transaction shape | Memory | CPU | CPU over 9B target |
| --- | ---: | ---: | ---: |
| Ledger-shaped ADA fixture | 825,008 | 9,944,453,755 | 944,453,755 |
| Production-width policy and credential | 825,008 | 9,944,944,777 | 944,944,777 |
| Representative multi-asset paid superset | 835,403 | 9,990,478,198 | 990,478,198 |

Memory has ample headroom. CPU is the binding resource. The 1.66 compiler
reduces each N=9 row by 2,992,000 CPU relative to 1.63 while fixing the
officially reported unsound UPLC `FloatDelay` transformation.

## Exact accepted-path tally

The production-width global validator consumes `9,920,661,445` CPU; the nine
base validators add `24,283,332`. Its non-instrumented tally is dominated by:

| Builtin work | Count | Exact CPU | Share of complete production-width tx |
| --- | ---: | ---: | ---: |
| BLS12-381 Miller loop | 14 | 3,556,087,822 | 35.76% |
| BLS12-381 G1 uncompress | 40 | 2,117,924,880 | 21.30% |
| BLS12-381 G1 MSM | 3 | 1,592,704,057 | 16.02% |
| BLS12-381 G2 uncompress | 14 | 1,045,778,608 | 10.52% |
| BLS12-381 G1 scalar multiplication | 13 | 994,090,214 | 10.00% |
| BLS12-381 final verification | 1 | 333,849,714 | 3.36% |
| Six-group subtotal |  | **9,640,435,295** | **96.94%** |

The decompressions are exactly four G1 plus one G2 point for each of nine
336-byte proofs and four G1 plus five G2 points for the 672-byte verification
key. The Miller loops are nine distinct proof A/B terms and five fixed
Groth16/BSB22 terms. The three MSMs are the commitment, Groth16 C, and
merge-challenge-scaled PoK columns. There is already only one final
verification.

The inclusive instrumented profile independently locates approximately 586M
in verification-key parsing, 537M/568M/533M in the three terminal G1 columns,
236M in `coefficientFirstVkX`, 1.432B in the merged terminal Miller-product
sides, and 334M in final verification. Each proof parse/decompress/hash region
is about 299–302M. These source regions agree with the exact builtin tally.

## Compiler search

Compiler-only experiments were built in isolated build directories and
measured as exact non-instrumented complete scripts.

| Plinth configuration | Production-width N=9 CPU | Multi-asset N=9 CPU | Base/global bytes | Disposition |
| --- | ---: | ---: | ---: | --- |
| 1.66 defaults | 9,944,944,777 | 9,990,478,198 | 111 / 3,419 | sound current baseline |
| no relaxed float-in | 9,944,560,777 | 9,990,094,198 | 111 / 3,420 | only 384K saved |
| callsite growth 100 | 9,929,466,295 | 9,974,999,716 | 377 / 5,982 | 15.5M saved, component-wide experiment |
| callsite growth 500 | 9,926,330,295 | 9,971,863,716 | 377 / 7,698 | best viable-size experiment; still 926M high |
| callsite growth 1000 | 9,925,946,295 | 9,971,479,716 | 377 / 26,497 | script alone exceeds 16,384-byte max tx size |

Inlining plateaus after doubling the viable script size and cannot affect the
BLS floor. Lower callsite growth, disabling constant inlining, and changing
unconditional growth either matched the default or regressed it. The plugin's
documented textual `cse-which-subterms=all` value is not accepted by the 1.66
plugin option parser.

## Structural floor with the fixed interface

The six exact builtin groups already exceed the 9B target by 640,435,295 CPU.
Even replacing every non-BLS operation with zero-cost code cannot meet the
release policy.

The only remaining sound local batching idea is to constrain the random proof
coefficients to sum to one. That avoids the alpha and IC0 scalar
multiplications. Soundness requires every coefficient to remain challenge-
dependent: fixing one coefficient to one as well lets an attacker choose a
non-zero proof-error vector in the deterministic annihilator of those two
linear constraints. With all coefficients dynamic, N=9 adds one A scalar
multiplication and expands each eight-point-tail commitment/C MSM to nine
points. At protocol-v11 prices the best structural improvement is only about
26.26M CPU, leaving a BLS-only floor of approximately 9.614B before hashes,
CEK steps, contract checks, and base validators.

The major counts cannot be removed safely by a contract-local rewrite:

- Distinct proof B points prevent replacing the nine A/B Miller loops with one
  MSM and one pairing.
- Commitment, C, and PoK are independent weighted G1 columns used against
  distinct G2 bases. Combining them would require setup discrete-log
  relationships that are neither known nor safe to assume.
- Flat serialization rejects G1, G2, and Miller-result objects, so parsed VK
  points and the fixed alpha/beta Miller result cannot be lifted as on-chain
  constants.
- BSB22 PoK batching is already the same-key two-pairing batch check, merged
  with Groth16 under an independently derived, statement-bound challenge and a
  single final verification. Omitting it breaks commitment knowledge
  soundness.
- Mainnet exposes single `millerLoop`, not a multi-pairing builtin.

### Why the commitment cannot be stripped from the current proof

The source ownership circuit does not call `Commit` itself. The single
commitment is introduced by gnark's standard gadgets and is security-critical:

- `std/rangecheck.New` selects the Haböck log-derivative range checker when the
  R1CS builder implements `frontend.Committer`. Its documented challenge comes
  from the committed variables.
- `std/math/emulated.Field.performDeferredChecks` commits the Ed25519 limb
  inputs, hint outputs, quotients, and carries, then uses the resulting
  challenge for the Schwartz--Zippel multiplication checks.
- `std/multicommit` deliberately batches those consumers into the circuit's
  one root commitment. On a large field it panics if the compiler does not
  implement `frontend.Committer`; there is no supported exact-check fallback
  for the emulated multiplication path in gnark 0.15.
- gnark's commitment placeholder itself reports that an unreplaced hint makes
  the proof unsound and verification fail. The Groth16 verifier separately
  checks the Pedersen proof of knowledge before accepting the commitment as a
  public Groth16 input.

Consequently, retaining the identical constraints while merely ignoring or
zero-padding the commitment and PoK fields is not a production optimization.
A sound commitment-free construction must replace the probabilistic gadget
checks with complete constraints (or adopt another audited construction), then
regenerate the R1CS and coherent setup. That preserves the high-level recovery
claim, but it does not preserve the frozen circuit/proof semantics required by
this task.

## Conclusion and required decision

N=9 cannot meet the 9B production CPU policy while preserving all stated
interface constraints and the current Groth16-with-BSB22 proof semantics. The
canonical script must therefore remain unreleased for N=9; changing webapp or
deployment admission gates to advertise N=9 would be unsafe.

The narrow production-capable alternatives are:

1. Keep the circuit relation but rebuild the proving system without the gnark
   commitment machinery, which changes proof/VK format and coherent setup
   artifacts. Removing the BSB22 PoK path is enough to cross the target, but it
   is only sound if the new circuit/proving-system construction does not need
   that commitment.
2. Add a proof-aggregation/recursive-proof interface so the on-chain verifier
   does not execute nine distinct A/B Miller loops and 45 proof-point
   decompressions.
3. Preserve the interface exactly and split nine claims across multiple
   transactions; N=9 then cannot mean one transaction.
4. Wait for a protocol change providing materially cheaper decompression,
   pairing, or multi-pairing builtins, or a higher transaction CPU limit.

Primary references:

- Plinth profiling: https://plutus.cardano.intersectmbo.org/docs/working-with-scripts/profiling-budget-usage
- UPLC optimizer and per-pass evaluation: https://plutus.cardano.intersectmbo.org/docs/uplc-cli-tool
- Plinth compiler options: https://plutus.cardano.intersectmbo.org/docs/delve-deeper/plinth-compiler-options
- Plutus 1.66 release notes: https://github.com/IntersectMBO/plutus/releases/tag/1.66.0.0
- CIP-381 BLS12-381 builtins: https://cips.cardano.org/cip/CIP-0381
- CIP-133 BLS12-381 MSM: https://cips.cardano.org/cip/CIP-133
- Protocol-parameter guide: https://docs.cardano.org/about-cardano/explore-more/parameter-guide
