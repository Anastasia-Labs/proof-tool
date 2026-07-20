# Exact-Artifact Preprocessing Feasibility

Recorded: 2026-07-16

This is a scaling probe, not contract-correctness evidence. Historical probes
import the locked public Preprod artifacts; the explicitly labeled candidate
probe imports current-source ReclaimBase. The measured `#prep_uplc` limit is a
Lean CEK step bound, not a Cardano execution-unit budget.

## Results

| Target | Probe | Result | Wall time | Peak RSS |
| --- | --- | --- | ---: | ---: |
| All four exact imports | `lake build` | decoded successfully | 4.1 s | not recorded |
| ParamsHolder | 100 steps, default module | completed | 2.7 s | not recorded |
| OneShotNFT | 500 steps, dedicated module | completed | 10.1 s | 1,353,112 KiB |
| ReclaimBase | 500 steps, dedicated module | completed | 6.0 s | 1,307,928 KiB |
| ReclaimBase current-source candidate, arbitrary withdrawal list | 500 then 200 steps | interrupted after sustained symbolic expansion | several minutes | over 4 GiB |
| ReclaimGlobalV2 | 100 steps, dedicated module | completed | 3.4 s | 1,233,236 KiB |
| OneShotNFT + ReclaimBase | 2,000 steps each | interrupted after more than 40 s | > 40 s | not recorded |
| All four artifacts | 20,000 steps each | interrupted after more than 50 s | > 50 s | not recorded |

Commands used `/usr/bin/time -f 'elapsed=%e maxrss_kb=%M' lake build
<module>` from `formal/`. The dedicated probes live under
`ProofToolFormal/Feasibility/` and are intentionally not imported by the
default library root.

## Decision

- Exact imports are feasible and no unsupported builtin was encountered in
  the shallow preprocessing paths.
- The shallow result does **not** establish that every BLS/Groth16 builtin and
  deep verifier branch is symbolically tractable.
- Monolithic top-level preprocessing is already memory-heavy at shallow bounds
  and scales poorly. The proof implementation must export reusable closed
  helpers for list coverage, datum decoding, Value coverage, transcript
  construction, and verifier control flow, then prove exact-artifact
  corollaries in dedicated modules.
- Default `lake build` keeps only the tiny ParamsHolder preprocessor. Heavy
  exact-artifact probes and theorem modules must be explicit targets so a
  routine build cannot silently consume unbounded time or memory.
- A step-limited `Eval` or `Return` state is classified as exhaustion, never as
  validator rejection. See `ProofToolFormal/Result.lean`.

This decomposition preserves the exact compiled artifact as the top-level
subject while avoiding the invalid shortcut of replacing it with a handwritten
model.
