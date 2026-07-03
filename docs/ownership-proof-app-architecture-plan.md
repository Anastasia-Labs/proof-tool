# Ownership Proof App Architecture Plan

## Decision

Build the product as a local-first proving flow with remote verification only.
The seed phrase and master XPrv must never be sent to the hosted backend.
Groth16 proving stays in a native Go helper that runs on the user's machine.
The hosted backend receives only public verification material and proof
artifacts.

Highest-assurance production path:

1. Next.js App Router + TypeScript UI.
2. Signed Tauri desktop shell for the seed phrase and proving flow.
3. Web Worker for mnemonic validation and master XPrv derivation.
4. Native Go prover helper built from this proof-tool.
5. Backend Go verifier service, or a Next.js Route Handler that calls a pinned
   Go verifier.

If the product must be a normal hosted webapp, the browser may derive the
96-byte master XPrv from the seed phrase, but that path should be documented as
trusting first-party JavaScript delivered by the hosted app at runtime. It keeps
secrets off backend APIs, but it does not remove CDN, deployment, compromised
build, or malicious first-party script risk.

Do not attempt pure browser proving for the first production version. The
current gnark Groth16/BLS12-381 circuit and proving key are large enough that
browser proving is the riskiest part of the stack, both for memory reliability
and for user experience.

## Current Proof-Tool Baseline

The repo already has the core contracts needed for this split:

- `cmd/proof-tool/main.go` exposes `master-xprv-from-seed-phrase`, `prove`, and
  `verify`.
- `internal/circuit/ownership/circuit.go` defines
  `root-ownership-v1/bls12-381/groth16`.
- The private witness is a 96-byte master XPrv plus the CIP-1852 path
  components. The seed phrase is not the circuit witness.
- The current derivation normalizes and validates a BIP-39 mnemonic, converts it
  to entropy, runs PBKDF2-SHA512 with an empty password, entropy as salt, 4096
  iterations, and derives 96 bytes before applying the current XPrv clamps.
- `packages/client-ts` already mirrors that derivation with `@scure/bip39` and
  WebCrypto PBKDF2.
- `internal/artifact` defines the proof artifact shape:
  `schema`, `circuit_id`, `vk_hash`, `target_credential`, `public_input`,
  `proof`, and optional path metadata.
- `internal/prover` loads or creates a proving/verifying key bundle and binds
  proofs to a BLS12-381 Groth16 verifying key hash.

The production app should preserve those contracts, then harden how secrets and
keys move through the system.

## Claim Semantics

This proof establishes derivability of a 28-byte Cardano key credential from a
96-byte master XPrv at a CIP-1852 path. It does not prove ownership of a full
address, network id, UTxO, balance, stake credential, script credential, wallet
account, or on-chain recovery entitlement.

If the UI accepts a Cardano address, address parsing must be local and explicit
about what is being extracted. It should reject unsupported address types,
script payment credentials, or ambiguous inputs rather than converting them into
an overbroad ownership claim. Product copy should say "credential proof" or
"payment key credential proof" unless a later circuit proves more.

## Architecture

```text
Next.js UI
  |
  | seed phrase stays in the client-only route
  v
Browser Web Worker
  |
  | derives 96-byte master XPrv locally
  v
Local Go prover helper
  |
  | emits ownership-proof.json only
  v
Backend verifier
  |
  | verifies against pinned verifying key
  v
Verified / not verified result
```

### Frontend

Use Next.js App Router and TypeScript for the hosted UI. Keep all seed phrase
handling in a client-only route and a dedicated Web Worker. In the hosted-web
variant, this is a trust-in-downloaded-JavaScript design, not a hardware-wallet
or native secure enclave design.

Responsibilities:

- Accept seed phrase input only in browser-local UI. Avoid controlled React
  state for the full phrase; prefer an input ref, submit directly to the worker,
  then clear the input.
- Normalize and validate the mnemonic in the worker.
- Derive the master XPrv using the existing `packages/client-ts` logic.
- Accept or derive the target credential outside the backend. If the UI accepts
  a Cardano address, credential extraction should also be local and tested with
  golden vectors.
- Send the master XPrv only to the local prover helper, never to the hosted
  backend.
- Send only proof artifacts and public verification material to the backend.

Security requirements:

- No server-rendered seed phrase route.
- No seed phrase, entropy, or master XPrv in URLs, cookies, localStorage,
  sessionStorage, analytics, logs, error reporting, or React Server Component
  payloads.
- No dynamic script injection, third-party scripts, tag managers, or remote
  feature-flag code on the seed phrase route.
- For hosted-web releases, use immutable versioned assets, deploy approval,
  build provenance, and bundle integrity checks where the deployment platform
  allows them.
- Disable spellcheck, autocorrect, and autocomplete on the seed phrase input.
- Clear worker-held buffers after use where JavaScript allows it.
- Keep the hosted app's CSP strict and omit third-party scripts from the seed
  phrase flow.
- Treat browser memory clearing as best effort, not as a hard guarantee.

### Web Worker

The worker should do mnemonic validation and master XPrv derivation, but it is
not a perfect isolation boundary. The browser may keep structured-clone copies,
input strings, logs, crash snapshots, or heap remnants longer than application
code can control.

Worker API:

- Input: `{ seedPhrase: string }`.
- Output on success: a transferred `ArrayBuffer` or `Uint8Array` containing the
  96-byte master XPrv. Hex strings should be reserved for manual/debug flows
  because they create extra immutable string copies.
- Output on failure: typed validation errors that do not echo the seed phrase.

Implementation notes:

- Reuse `@proof-zk-recovery/proof-tool-client`.
- Require `globalThis.crypto.subtle`.
- Match the Go derivation exactly.
- Keep test vectors shared between the Go and TypeScript implementations.
- Keep the existing hex helper for tests and manual tooling, but avoid it in
  the production UI-to-helper path.

### Local Prover Helper

The local helper is the only component that receives both the master XPrv and
the target credential. It should be built from the current Go proof-tool, but it
should not expose secrets through command-line arguments in the production path.

Preferred transports, in order:

1. Tauri command invoking a bundled Go binary over stdin/stdout.
2. Local `127.0.0.1` helper API with origin checks and a per-session token.
3. Manual file handoff for an MVP or fallback flow.

Helper responsibilities:

- Receive master XPrv locally.
- Receive target credential and optional path search bounds.
- Find the matching CIP-1852 path locally.
- Create the Groth16 proof using the pinned proving key.
- Return `ownership-proof.json`.
- Never call the hosted backend with the master XPrv.

Hardening requirements:

- Do not pass `--master-xprv` on the process command line in production.
- Prefer JSON over stdin/stdout for Tauri and desktop wrapper use.
- If an HTTP helper is used, bind only to loopback, require a random
  per-session token, allow only the configured hosted origin, and reject browser
  requests without the token.
- Do not log request bodies, master XPrv, seed phrase derivatives, or proof
  inputs.
- Keep proof outputs in user-selected locations or return them directly to the
  UI.
- Make key bundle verification mandatory before proving.
- Treat in-memory zeroization as best effort in Go and JavaScript; avoid
  unnecessary copies instead of promising perfect erasure.

### Artifact Profiles

Use two artifact profiles:

- Local proof report: may include optional path metadata for the user's own
  debugging and audit trail.
- Backend verification artifact: should omit `path` by default. The verifier
  does not need account, role, or index to verify the proof.

The current CLI writes path metadata when it finds the credential. Before a
hosted UI uploads or shares a proof artifact, it should strip `path` unless the
user explicitly opts into a debug/support flow. The backend should ignore or
reject shared path metadata by default so account structure is not leaked
unnecessarily.

### Proving Key Distribution

The first production version should not rely on client-side trusted setup.
The helper should consume a versioned proving-key bundle produced and published
by the project.

Key bundle requirements:

- Include `ownership.pk`, `ownership.vk`, and `manifest.json`.
- Pin `circuit_id`, curve, backend, `vk_hash`, proving-key digest, proving-key
  size, constraint-system digest, circuit source commit, gnark version, setup
  transcript hash, release signature, and trusted-setup notes.
- Verify the manifest and verifying-key hash before proving.
- Ship the bundle with the desktop app when practical, or download it through an
  installer/update flow with a signed checksum.
- Keep the backend verifying key pinned independently of any client-provided
  `vk_hash`.
- Treat Groth16 setup provenance as part of the security model. Document who ran
  setup, how toxic waste was handled, and how users can verify the release.

The existing `LoadOrCreateOwnershipBundle` behavior is useful for development,
but production helper builds should fail if the expected key bundle is missing
or invalid rather than silently generating a new one.

Any circuit, gnark version, constraint-system, setup input, proving key, or
verifying key change requires an explicit circuit/key version bump. Do not
reuse `root-ownership-v1/bls12-381/groth16` for incompatible releases.

### Backend Verifier

Use a Go verifier service when possible. A Next.js Route Handler can be the HTTP
entrypoint, but verification should still run against the same Go verifier logic
and the pinned verifying key.

Request body:

```json
{
  "artifact": {
    "schema": "root-ownership-proof-artifact-v1",
    "circuit_id": "root-ownership-v1/bls12-381/groth16",
    "vk_hash": "blake2b256:...",
    "target_credential": "...",
    "public_input": "0x...",
    "proof": "..."
  },
  "expected_target_credential": "..."
}
```

`expected_target_credential` is optional and should come from the relying party
or product context when the backend is verifying a proof for a specific target.
Do not accept top-level `public_input` from clients; the server should always
recompute it from the credential.

Verifier checks:

- Reject unknown artifact schemas.
- Reject unknown `circuit_id`.
- If `expected_target_credential` is provided, reject mismatches with artifact
  `target_credential`.
- Recompute `public_input` from artifact `target_credential`.
- Reject mismatches between recomputed public input and artifact public input.
- Load only the server-pinned verifying key.
- Reject artifacts whose `vk_hash` does not match the pinned key.
- Ignore or reject optional artifact `path` unless an explicit debug endpoint
  accepts it.
- Verify the proof with public witness only.

Response body:

```json
{
  "verified": true,
  "circuit_id": "root-ownership-v1/bls12-381/groth16",
  "vk_hash": "blake2b256:...",
  "target_credential": "...",
  "public_input": "0x..."
}
```

Failure responses should be explicit enough for debugging but must not reveal or
request private witness material.

## Hosting Plan

Vercel is a good default for the hosted Next.js UI, Web Worker assets, static
metadata, and a thin verification entrypoint. It should not host proving,
trusted setup, proving-key generation, or any secret-bearing seed/master-XPrv
path.

Deployment ownership:

| Component | Where it runs | Recommended host/distribution |
| --- | --- | --- |
| Public website | Hosted web | Vercel Next.js project |
| Seed phrase entry | User device | Browser page served by Vercel for web MVP; signed Tauri app for higher assurance |
| Mnemonic to master XPrv | User device | Browser Web Worker or signed desktop app worker |
| Groth16 proving | User device | Bundled Go prover in Tauri, or installed loopback helper |
| Trusted setup | Release infrastructure | One-off controlled ceremony/job on dedicated high-memory VM or self-hosted runner |
| Proving-key generation | Release infrastructure | Same controlled release job as setup; never a public request/response service |
| Proving/verifying key artifacts | Static artifact distribution | Cloudflare R2, S3, GCS, or GitHub Releases, with signed manifest and checksums |
| Proof verification API | Hosted server | Prefer containerized Go verifier on Cloud Run/Fly.io/App Runner/ECS; Vercel only after a verifier spike passes |

Preferred hosted topology:

```text
Vercel-hosted Next.js UI
  |
  | seed phrase page + worker assets
  v
User device
  |
  | local derivation + local Go proving
  v
ownership-proof.json
  |
  | proof artifact only
  v
Verifier entrypoint
  |
  | Cloud Run/Fly.io/App Runner/ECS, or Vercel if verified suitable
  v
Pinned Go verifier
```

The phrase "client-side proof generation" should mean "on the user's device."
For the current proof-tool, that should be a native Go helper or Tauri-bundled
Go prover. Pure browser proving would be a separate product/research track, not
the recommended hosted webapp path.

### Website Hosting

Host the normal web product on Vercel:

- Next.js App Router UI.
- Static worker bundle for seed phrase validation and master-XPrv derivation.
- Static metadata such as supported circuit/key versions.
- Optional thin `/api/verify` route that forwards proof artifacts to the Go
  verifier.

For the hosted-web flow, users can enter the seed phrase on a Vercel-served
page, but the seed phrase must stay in browser memory and move only into the
worker/local helper path. This is acceptable for an MVP if the trust model is
clear, but the user is still trusting the JavaScript delivered by that Vercel
deployment. The higher-assurance version should ship the same UI inside a
signed Tauri app.

### Local Proving Distribution

Do not host proving as a central web service. Distribute proving capability to
the user:

- Best UX: signed Tauri app that bundles the Go prover and either bundles or
  downloads the pinned proving key.
- Hosted-web UX: local helper installer that binds to loopback and pairs with
  the Vercel site using a per-session token.
- MVP fallback: manual CLI/file handoff that produces `ownership-proof.json`.

The hosted site can orchestrate the flow, show status, and submit the final
proof, but it should not receive the seed phrase or master XPrv and should not
run the heavy Groth16 prover in browser for the first production version.

### Setup and Key Generation Hosting

Trusted setup and proving-key generation are release operations, not hosted
user-facing services.

Run them in a controlled release pipeline:

- Dedicated high-memory VM, self-hosted runner, or isolated workstation.
- Pinned source commit, pinned Go/gnark versions, and reproducible command log.
- No web request path and no shared multi-tenant serverless function.
- Produce `ownership.pk`, `ownership.vk`, `manifest.json`, checksums, and
  signatures.
- Destroy or archive the build environment according to the trusted-setup
  procedure and document toxic-waste handling.

After generation, publish only artifacts:

- Proving key to the Tauri app bundle, helper installer, or signed artifact
  storage.
- Verifying key and manifest to the verifier deployment.
- Public manifest/checksums to the website so users and helpers can compare
  expected versions.

### Artifact Hosting

Use object storage/CDN for large static artifacts:

- Cloudflare R2, S3, or GCS for proving/verifying key bundles and manifests.
- Public immutable URLs for non-secret artifacts, or short-lived presigned URLs
  if access control or staged rollout is needed.
- Signed manifest as the trust anchor; object storage permissions are not the
  security boundary by themselves.

The proving key is not secret, but it is large and integrity-critical. The
helper must verify the manifest, checksums, circuit id, and expected key hash
before proving.

Acceptable verifier deployment options:

1. Vercel Go runtime verifier service if the Go runtime is acceptable for the
   release risk profile and the verifier fits the platform limits.
2. Vercel Next.js Route Handler as a thin proxy to a separate Go verifier
   service.
3. Containerized Go verifier on Cloud Run, Fly.io, Render, AWS App Runner, ECS,
   or another always-container-friendly host, with Vercel hosting only the UI.

Use Vercel for the verifier only after a deployment spike confirms:

- The proof artifact request and response are comfortably below Vercel's
  function payload limit.
- The Go verifier binary, verifying key, manifest, and traced files fit the
  function bundle limit.
- Verification finishes within configured function duration on cold and warm
  starts.
- Runtime memory stays below the plan limit with headroom.
- The Go runtime support level is acceptable for production, or the project is
  comfortable using it only for beta/MVP deployments.
- Logs, observability, and error reporting do not capture proof bodies or any
  rejected request bodies.
- Region choice is explicit so verifier latency and data routing are
  predictable.

If any of those fail, keep Vercel for the UI and move the verifier to a
container host. That split still preserves the main security boundary because
the verifier receives only public inputs and proof artifacts.

Do not use Vercel Edge Runtime for verification. The verifier needs normal Go
or server-side runtime semantics, pinned key files, and enough CPU/memory
headroom.

## UX Options

### Best UX: Tauri + Next/React UI + Bundled Go Prover

Use this if the product can be distributed as a desktop app. Tauri gives the UI
the same React/Next ergonomics while avoiding the awkward browser-to-localhost
setup dance. The app can bundle the Go prover and proving key, call it over
stdin/stdout, strip debug-only path metadata, and upload only the verification
artifact.

Pros:

- Least awkward user flow.
- No local helper installation step.
- No localhost CORS or token pairing.
- Cleaner secret boundary.
- Signed, versioned app releases reduce mutable hosted-JavaScript risk for seed
  entry.

Cons:

- Requires desktop packaging, signing, and updater work.
- Less convenient than a purely hosted webapp for first-time access.

### Normal Hosted Webapp: Next.js + Local Native Helper

Use this if the product must be a normal hosted app. The webapp handles the
browser derivation and talks to a locally installed helper over loopback.

Pros:

- Hosted UI can update quickly.
- Backend remains verification-only.
- Users can prove without uploading seed phrase or master XPrv.

Cons:

- Requires helper installation.
- Requires pairing, CORS, origin, and token hardening.
- Browser-to-localhost UX is more fragile than a desktop wrapper.
- Users must trust the hosted JavaScript delivered for that session.

### Manual Fallback: File Handoff

Use this only as an MVP fallback or recovery path. The local machine runs the
Go prover and produces `ownership-proof.json`; the hosted UI uploads only that
proof artifact for verification after stripping debug-only path metadata.

Rules:

- Do not ask users to paste seed phrases into a hosted page for this fallback
  unless the page still performs all derivation locally.
- Do not put master XPrv values in shell history or command-line arguments.
- Prefer stdin or a local `0600` temporary file for secret input.
- Delete temporary secret files after proof generation.

## Implementation Phases

### Phase 1: Stabilize Contracts

- Freeze the proof artifact schema for `root-ownership-proof-artifact-v1`.
- Add Go/TypeScript golden vectors for mnemonic-to-master-XPrv derivation.
- Add golden vectors for target credential to public input.
- Add a production-mode helper command that accepts secret material through
  stdin or an authenticated local API, not command-line flags.
- Add a verifier command/service mode that accepts an artifact plus optional
  `expected_target_credential` and always recomputes public input.
- Add a backend-shareable artifact profile that strips `path` by default.

Exit criteria:

- Go and TypeScript derivation tests use the same vectors.
- The verifier rejects public-input and target-credential mismatches.
- The helper can prove without exposing master XPrv in the process list.
- Backend-bound artifacts do not include path metadata unless explicitly
  requested for a debug/support flow.

### Phase 2: Key Bundle Release Path

- Generate the production key bundle in a controlled environment.
- Extend and publish `manifest.json` with circuit source commit, gnark version,
  constraint-system digest, proving-key digest and size, verifying-key hash,
  setup transcript hash, release signature, and trusted-setup notes.
- Publish the verifying key, proving key, manifest, and signed checksums.
- Make backend deployments pin the verifying key and expected `vk_hash`.
- Make local helper production builds fail closed on missing or mismatched key
  bundles.

Exit criteria:

- Backend verification does not trust client-supplied keys.
- Local proving cannot silently regenerate a new incompatible key.
- Key rotation requires a new circuit/key version and explicit app support.
- Users and operators can verify key bundle provenance.

### Phase 3: Verifier Backend

- Implement a Go HTTP verifier service or a Vercel-compatible Next.js route
  that calls the Go verifier.
- Add request validation, artifact validation, pinned key loading, and structured
  error codes.
- Add rate limits and request-size limits.
- Add logging that records only non-secret metadata such as circuit id, pinned
  key hash, and verification result.
- Run a hosting spike on Vercel and at least one container host before choosing
  the final verifier deployment target.

Exit criteria:

- Valid proof artifacts return `verified: true`.
- Tampered proof, target credential, public input, circuit id, and key hash
  cases all fail in tests.
- No endpoint accepts seed phrases, entropy, or master XPrv.
- The backend does not require or trust client-provided top-level public input.
- Optional path metadata is ignored or rejected outside explicit debug paths.
- The chosen host has measured proof payload size, bundle size, cold-start,
  duration, memory, and logging behavior.

### Phase 4: Hosted UI + Worker

- Build the client-only seed phrase route.
- Move derivation into a Web Worker.
- Add local target credential input or local address-to-credential extraction.
- Add proof creation flow through the chosen local helper transport.
- Add proof upload/verification UI that sends the backend verification artifact,
  not the local debug report.
- For hosted-web delivery, add immutable asset/version policy, CSP, and release
  provenance checks for the seed phrase route.

Exit criteria:

- Network inspection shows no seed phrase, entropy, or master XPrv leaves the
  browser except to the local helper transport.
- The seed phrase page has no third-party scripts or telemetry.
- Worker derivation matches Go vectors.
- Proof artifact upload verifies against the backend.
- The worker returns transferable bytes in the production path, not an XPrv hex
  string.

### Phase 5: Local Helper Packaging

- For the recommended path, package the UI and Go prover with Tauri.
- For the hosted-web path, create installers for the loopback helper.
- Add health checks, version checks, and key bundle status checks.
- Add user-facing helper upgrade prompts when the backend requires a newer
  circuit/key version.
- For Tauri, package the seed phrase route as signed app code rather than a
  mutable hosted page.

Exit criteria:

- Fresh install can produce and verify a proof without manual CLI use.
- Helper refuses requests from unpaired origins.
- Helper version and key version are visible to the UI without exposing secrets.

### Phase 6: Hardening and Release

- Threat-model the seed phrase screen, worker, local helper, verifier backend,
  key distribution, and update path.
- Run security review of local HTTP pairing if that option is used.
- Add crash/error reporting filters that drop request bodies and secret-like
  fields.
- Add reproducible release notes for circuit id, key hash, helper version, and
  verifier version.
- Review product language against the claim semantics so it does not imply
  full-address, balance, stake, network, or on-chain control claims.

Exit criteria:

- Secret-bearing paths have no server logs, analytics, crash dumps, or command
  line exposure.
- Backend verifier is covered by positive and negative proof tests.
- Key bundle provenance and rotation are documented.
- Release notes include the exact credential-proof semantics.

## Test Plan

- Go unit tests for artifact parsing, public input recomputation, verifier
  failure modes, and helper request validation.
- TypeScript tests for mnemonic normalization, invalid mnemonic handling, and
  master XPrv golden vectors.
- Browser tests to ensure the seed phrase route is client-only and does not
  trigger backend requests while typing or deriving.
- Browser tests that the production worker path transfers bytes and clears the
  input after handoff, with memory clearing documented as best effort.
- End-to-end local test that derives in the worker, proves through the helper,
  uploads only the artifact, and verifies on the backend.
- Negative end-to-end tests that tamper with `proof`, `target_credential`,
  `public_input`, `circuit_id`, and `vk_hash`.
- Tests that backend-bound artifacts omit `path`, and that the verifier ignores
  or rejects path metadata by policy.
- Address parsing tests that reject script credentials and unsupported address
  forms.
- Packaging tests for missing, corrupted, and wrong-version key bundles.

## Open Decisions

- Tauri desktop app versus hosted webapp plus local helper.
- Vercel UI-only plus external Go verifier versus Vercel-hosted Go verifier.
- Whether target credentials are typed directly, extracted from Cardano
  addresses, or selected from wallet discovery.
- Production path-search defaults and UI affordances for unusual account,
  role, and address index ranges.
- Key bundle size and distribution channel.
- Whether the backend runs as a standalone Go service or behind a Next.js Route
  Handler.
- Whether the first hosted deployment targets Vercel Hobby for UI-only demos or
  Vercel Pro/container hosting for production verifier capacity.
- Supported platforms for the local helper and signing/notarization
  requirements.

## Non-Goals for the First Production Version

- Browser-native Groth16 proving.
- Backend proof generation.
- Backend seed phrase or master XPrv handling.
- Silent trusted setup on user machines.
- On-chain redemption or custody flow changes.
