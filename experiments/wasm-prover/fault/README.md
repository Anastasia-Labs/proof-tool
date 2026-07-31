# Runtime fault gates

The runner defines six recovery/fail-closed outcome contracts: worker
termination, served PK chunk corruption, recoverable and exhausted range
fetches, reload/retry, and the 4-core/8-GB memory-pressure profile.

```sh
node experiments/wasm-prover/fault/run.mjs --case reload-retry --opt-w2 --workers 8 --deadline-ms 180000
node experiments/wasm-prover/fault/run.mjs --case all --opt-w1 --opt-w2 --opt-w3 --opt-w5 --opt-w6 --opt-w7 --workers 16 --deadline-ms 180000
```

The suite is executable against the local fault server. It serves the complete
candidate coherence set selected by `PROOF_CHUNK_ASSETS_DIR`, not a mixture of
candidate manifests and stale browser assets. Optimization flags are passed to
the runtime request and must be both advertised and acknowledged; use
`--opt-w2`, `--opt-w3`, and later finding flags to exercise the exact candidate
under review.
The runtime must also advertise explicit worker-count support and preflight must
acknowledge the requested `--workers` value; valid values are 1 through 16.
That preflight acknowledgement is only a decoded-request check. A separate
engine probe constructs and closes the selected worker pool, checks the applied
worker/shard/fetch settings, and checks directly instrumented options such as
W7. Successful reload and memory-profile proofs must also carry the requested
cumulative runtime options in both the result and proof trace.

Chunk corruption changes one byte in an authenticated PK chunk and requires a
`chunk-digest-mismatch` failure with a confirmed server hit, no CPU fallback,
and no partial proof. With `--opt-w7`, this also proves corrupt bytes cannot be
hidden by or inserted into the verified per-worker cache. A transient chunk
fetch gets one bounded same-chunk retry (two fetch attempts total) before the
outer shard retry is considered; the worker unit gate covers both the retry
and its candidate/production parity. Network recovery returns two retryable
transport responses, then requires chunk-local retries to complete and the
final proof to verify locally without requiring an outer shard restart.
Network abort interrupts two responses and
returns a terminal error for subsequent attempts; the runtime must report
bounded `3/3` exhaustion and must not demote the authenticated-transport
failure to CPU proving. A separate Worker unit gate requires rejected `fetch`
promises to carry the retryable network error code; this avoids treating
Chromium's transparent replay of idempotent GETs as runtime retry evidence.

Worker termination injects the error event produced by a crashed Worker and
then terminates it after an MSM range dispatch. The runtime must replace only
that worker, retry the same shard, and locally verify the completed proof
without CPU fallback. Programmatic `Worker.terminate()` is silent by browser
definition, so the separate progress-aware watchdog tests cover silent
disappearance and its bounded five-minute inactivity/20-minute absolute
deadlines.

The final bounded-recovery acceptance on 2026-07-31 exercised the changed
paths with real browser proofs. `network-recover` returned two transient 503
responses, observed two chunk-local retries and zero outer shard restarts,
completed on the third server hit, and verified locally without CPU fallback
or a partial proof.
`worker-kill` replaced one worker, retried once, and verified locally.
`chunk-corruption` failed closed on the first authenticated hit with
`chunk-digest-mismatch` and no runtime retry. Persistent `network-abort`
exhausted the declared `3/3` shard-attempt budget and failed closed with no CPU
fallback or partial proof. Unit tests separately cover the healthy no-timer
path, the local same-chunk retry, structured error allow-list, inactivity
renewal, absolute deadline, and candidate/production worker parity.

Reload/retry waits for a
`prove` progress stage, reloads the same tab, requires that the in-flight
attempt terminates, and locally verifies a new proof. Before the fresh proof it
compares cryptographic before/after inventories and entry counts for
local/session storage, IndexedDB (including empty databases/stores),
Cache Storage, cookies, `history.state`, `window.name`, and OPFS where
available (including empty caches/directories). Missing baseline coverage, any
inventory change, or any secret/proof marker fails the gate.
It is intentionally a long real-proof test.

The memory-pressure case emulates the 4-core/8-GB browser profile, applies the
profile memory limit, and requests its bounded worker/shard configuration. It
always overrides the suite worker count to 4 and records both the requested
count and the profile override in the outcome. It
must either finish with a locally verified proof inside the declared envelope
or take the structured OOM-guidance path; an unclassified crash or wedged tab
is a failure. CPU fallback evidence is three-state (`none`, `observed`, or
`unknown`); only definitive `none` can pass. Joined `cpu retry prove` and
demotion errors are classified as observed, while an unstructured OOM error is
unknown and therefore fails the gate.

Every case has an external Node deadline. Expiry rejects immediately with
`hung=true`, then requests bounded cleanup; a hung cleanup callback cannot
delay or turn a wedged browser into a pass.

The default qualification command uses 180 seconds. On a deliberately loaded
host where the real worker4 proof itself exceeds that window, rerun the whole
suite with an explicitly recorded larger bound (the accepted 2026-07-10 r7
report and the final 2026-07-11 signed r8 G1 report both used
`--deadline-ms 360000`). The first timeout remains a rejected run; raising the
bound does not relax any outcome, fallback, or verification check. The r8
report is `output/fault-r8-final/fault-all.json`.

Accepted outcomes and exact error classes are declared in `cases.mjs`.
Unsupported future controls remain fail-closed: they must produce
`TODO_UNSUPPORTED`, never a skip or a recorded pass. Each W finding reruns the
whole suite with its cumulative prerequisite flags enabled, and W1 additionally
checks bounded same-shard recovery without accepting a partial result.
