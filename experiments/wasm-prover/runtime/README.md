# Runtime comparison infrastructure

`run-runtime-ab.mjs` supplies the common A/B interface for W1-W7. A selected
flag is sent as `tuning.opt_wN=false` in the baseline and `true` (or its
explicit requested value) in the candidate. The runtime must advertise the
flag in `globalThis.__wasmProverCapabilities.optimization_flags` and return the
applied values as `runtime_options`; absent or inconsistent acknowledgement is
a failing `TODO_UNSUPPORTED` gate. This prevents an ignored JSON field from
being reported as an optimization experiment.

```sh
node experiments/wasm-prover/scripts/run-runtime-ab.mjs \
  --case w2-domain-read \
  --opt-w2 \
  --workers 8 --shards 32 --rf 2 --repeats 3
```

W5 is a host-side worker-count change rather than a WASM algorithm switch.
Its A/B run therefore requires a distinct candidate count; `--workers` is the
baseline and `--candidate-workers` is the adaptive arm (capped at 16):

```sh
node experiments/wasm-prover/scripts/run-runtime-ab.mjs \
  --case w5-worker-count \
  --opt-w5 \
  --workers 8 --candidate-workers 16 --shards 32 --rf 2 --repeats 3
```

The runner invokes the guarded browser benchmark for every case, rejects fewer
than three repeats, and emits counterbalanced order
(`baseline→candidate`, then `candidate→baseline`) plus one split JSON file per
run. Case names are safe filename components and tuning values are positive
integers. At least one candidate optimization must be enabled.

The equivalence checker consumes every repeat by default. It compares the public
claim, `vk_hash`, PK/VK/CCS identities, and raw key/chunk-manifest identities;
checks both 336-byte Cardano encodings; and independently invokes
`proof-tool verify-destination` for both randomized proofs. It intentionally
does not compare randomized Groth16 proof bytes.

```sh
node experiments/wasm-prover/scripts/check-runtime-equivalence.mjs \
  --ab-report experiments/wasm-prover/output/w2-domain-read.ab.json \
  --keys-dir output/release/.../key-bundle/... \
  --contract-verifier experiments/wasm-prover/runtime/contract-verifier.mjs \
  --primary-metric peak-heap-gib
```

Every run must carry accepted preflight and contamination telemetry. Promotion
requires the designated primary median to improve by at least 8%, while the
secondary median may not regress by more than 5%. The contract adapter invokes
the compiled Haskell `Ownership.Verify` destination-proof path. Omitting it is
an explicit failing TODO gate after local verification.

Two stronger hooks are supported for controlled fixtures:

- `intermediate_digests`: schema `wasm-prover-intermediate-digests-v1` with
  complete `Basis`, `BasisExpSigma`, `G2B`, `A`, `B`, `Z`, and `K` stage
  records. Every record contains versioned 256-bit `scalar_inputs`,
  `point_inputs`, and `result` hashes. `--require-intermediate-digests` makes
  absence or an incomplete stage fail.
- `deterministic_randomness: true`: when both engines inject the same fixed
  Groth16 randomness, `--exact-proof` also compares full proof bytes. Never use
  this mode as the default production prover behavior.

Gnark's BSB22 commitment adds a random mask to committed witness values, so
separately randomized proofs do not have equal scalar/MSM intermediates even
for the same user witness. The W2 fixed-witness differential therefore runs in
native tests with a test-only deterministic random reader. Production WASM
does not expose scalar digests or deterministic proving randomness: doing so
would create a witness-dictionary side channel or weaken zero knowledge. W2 is
advertised and acknowledged by the WASM entrypoint; later flags remain hard
TODO gates until implemented.
