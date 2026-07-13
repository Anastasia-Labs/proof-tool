# Native prover benchmark — root-ownership-destination-v2 (2026-07-13)

First recorded native (non-WASM) proving-time measurement for the production
circuit. Before this benchmark the repo had browser WASM traces only; the
native path (which the desktop helper's sidecar uses via `cmd/proof-tool`) had
no recorded v2 prove time.

## Identity

- Circuit: `root-ownership-destination-v2/bls12-381/groth16`, **1,789,750
  constraints** (read from the deserialized frozen CCS), K=21, one commitment.
- Artifacts: ceremony `ownership.pk` (1,288,707,133 bytes) and frozen
  `ownership-destination.ccs` (129,221,468 bytes) downloaded from
  `https://proof-assets.reclaim-proof.com/proof-assets/preprod-9fac96b-g3a/`;
  `ownership.vk` from the checked-in proof-assets bundle.
- Integrity: PK SHA-256 and VK SHA-256 match `manifest.json`
  (`sha256:3e8a88b4…`, `sha256:6484b03a…`); CCS BLAKE2b-256 matches the
  manifest's `constraint_system_hash` (`blake2b256:bf2243b3…`). Digests are
  re-verified by the harness at startup before any load.
- Witness: repository golden fixture (master XPrv + path m/1852'/1815'/0'/0/0 +
  destination from `internal/circuit/ownershipdest/gate_test.go`). Every run's
  proof was verified against the pinned VK.
- Host: AMD Ryzen 9 9950X3D (16 cores / 32 threads), 64 GiB visible RAM, WSL2,
  Go native build (`GOMAXPROCS=32`), gnark 0.15.0, no GPU acceleration
  (`acceleration=none`). Same reference host as the ledger and browser traces.
- Harness: `cmd/bench-native-prove` (this branch). It deserializes the frozen
  CCS instead of recompiling, so the measurement binds to the exact ceremony
  constraint system regardless of local compile drift.

## Results

| Phase | Time |
| --- | ---: |
| CCS load (`ReadFrom`, warm cache) | 0.18 s |
| PK load (`UnsafeReadFrom`, warm cache) | 9.81 s |
| Witness build | < 1 ms |
| **Prove (median of 4)** | **19.43 s** |
| Prove runs | 20.16 / 19.44 / 19.43 / 19.14 s |
| — of which witness solve (gnark log) | 0.86–1.15 s |
| Verify | ~2 ms |

First-proof wall time from cold binary with artifacts already on disk ≈
**29–30 s** (PK load + prove). Subsequent proofs in the same process ≈ 19.4 s
each. One-time cost per machine: the 1.29 GB PK download.

## Comparison with the browser prover

| | Browser WASM (w16/s16/rf2, W1–W7) | Native (this run) | Ratio |
| --- | ---: | ---: | ---: |
| Prove wall | ≈ 70 s median (67.7–72.8 s uncontaminated) | 19.43 s | **3.6×** |
| Witness solve | ≈ 3.3 s (single-thread WASM) | ≈ 1.0 s | 3.3× |
| Peak memory | 0.835 GiB WASM heap | n/a (native RSS not captured) | — |
| Network per proof | ≈ 3.15 GB fetched (59% waste) | 0 after one 1.29 GB download | — |

Browser baseline: `experiments/wasm-prover/output/v2-k21-w16-s16-rf2-allflags-2026-07-13-r{4..6}`.

The previously circulated "plausibly 15–40× faster" inference was wrong; the
measured gap is **3.6×**. The browser prover is closer to native than the
single-thread WASM penalty would suggest because its dominant cost — the MSM
window — is already spread across 16 worker processes; what remains of the gap
is WASM's generic pure-Go field arithmetic (no amd64 assembly), fetch overhead
inside the MSM window, and JS-side scheduling. This also recalibrates the
runtime backlog: chunk-aligned PK fetches (est. −8–15 s) would close a
meaningful fraction of the browser-vs-native gap on its own.

## Incidental finding

The frozen R2 CCS deserializes to exactly **1,789,750** constraints, matching
the recorded gate and the vendored main-worktree build. The
`optimize-circuits-reconcile` worktree's local compile of 1,791,413 (+1,663)
is therefore local build drift (vendor bootstrap absent there), not drift in
the ceremony artifacts.

## Reproduce

```bash
mkdir -p ~/.cache/proof-tool-bench && cd ~/.cache/proof-tool-bench
curl -O https://proof-assets.reclaim-proof.com/proof-assets/preprod-9fac96b-g3a/ownership.pk
curl -O https://proof-assets.reclaim-proof.com/proof-assets/preprod-9fac96b-g3a/ownership-destination.ccs
cd <repo>
go build ./cmd/bench-native-prove
./bench-native-prove \
  --ccs ~/.cache/proof-tool-bench/ownership-destination.ccs \
  --pk  ~/.cache/proof-tool-bench/ownership.pk \
  --vk  apps/ownership-proof-web/public/proof-assets/ownership.vk \
  --runs 4
```

Caveats: WSL2 host (native Linux may differ slightly); single golden witness
(prove time is witness-independent for fixed circuit size); run-to-run spread
was ±0.5 s; PK load measured from warm page cache — cold-disk load will be
higher.

## Follow-up (same day): single-task MSM pin found and lifted — 19.4 s → 3.84 s

A CPU profile of the 19.4 s run showed **188% CPU utilization on a 32-thread
host** — the prover averaged under two cores. Root cause: the vendored
streaming prover routes every MSM through `internal/msmengine`, and the CPU
rung (`internal/msmengine/cpu.go`) hardcoded `ecc.MultiExpConfig{NbTasks: 1}` —
the Phase-0 single-thread lever that is correct inside a one-thread WASM
worker but was never meant to govern the native binary. Only the 3–4
concurrent MSM *sections* in the prover overlapped; each MSM itself ran
single-threaded.

Fix in this branch: `cpuNbTasks` is now a build-tagged constant —
`1` on `js && wasm` (Phase-0 lever preserved exactly), `runtime.NumCPU()`
elsewhere. An MSM is a group sum, so task count changes only the internal
addition order, not the resulting group element; the emitted proof is
unaffected (and Groth16 proofs are randomized per run regardless). All
`internal/msmengine` tests pass; every benchmark proof verifies against the
pinned ceremony VK.

| | Before (NbTasks=1) | After (NbTasks=NumCPU) |
| --- | ---: | ---: |
| Prove median | 19.43 s | **3.84 s** |
| Prove runs | 20.16/19.44/19.43/19.14 | 4.05/3.56/3.99/3.69 |
| CPU utilization | ~1.9 cores | multi-core |
| vs browser (~70 s) | 3.6× | **≈ 18×** |

The corrected end state: first proof on a machine ≈ 14 s (PK load 9.8 s warm +
prove 3.8 s) after a one-time 1.29 GB download; subsequent proofs ≈ 3.8 s.
The original "15–40× faster than browser" intuition was right about the
hardware and wrong about the software — the native binary was artificially
single-threaded. Production adoption is runtime-only (no ceremony): take the
`cpuNbTasks` build-tag split, confirm the WASM bundle still pins 1, and run
the standard proof-byte/verification acceptance.
