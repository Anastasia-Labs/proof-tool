# Ownership Proof System

## Claim Boundary

The core proof establishes that a 28-byte Cardano key credential is derivable
from a 96-byte master XPrv at a CIP-1852 account/role/index path accepted by
the circuit. The deployed V2 circuit accepts external payment role 0, internal
payment role 1, and staking role 2. It does not accept DRep role 3 and does not
prove ownership of a wallet, address, balance, UTxO, or script credential.
Destination and multi-credential profiles add only the bindings described
below.

Seed phrases, master XPrvs, derived paths, and witness values are local-only.
The browser may send a master XPrv to the loopback helper or move it into a
dedicated local Web Worker; it must never send it to a hosted API, persist it,
or place it in a URL or process command line.

## Circuit Profiles

All profiles use BLS12-381 Groth16 and the artifact schema
`root-ownership-proof-artifact-v1`.

| Profile | Circuit and key identity | Public claim |
| --- | --- | --- |
| Ownership only | `root-ownership-v1/bls12-381/groth16`, key version `ownership-v1` | `blake2b_256("ROOT-OWNERSHIP-v1" || credential)` |
| Single destination | `root-ownership-destination-v1/bls12-381/groth16`, key version `ownership-destination-v1` | `blake2b_256("ROOT-OWNERSHIP-DESTINATION-v1" || credential || destinationAddressV1)` |
| Multi destination | `root-ownership-multi-destination-v1-countN/bls12-381/groth16`, key version `ownership-multi-destination-v1-countN` | `blake2b_256("ROOT-OWNERSHIP-MULTI-v1" || count_u16_be || ordered_credentials || destinationAddressV1)` |

The public digest is converted to a BLS12-381 scalar using the circuit's
little-endian convention. Use the helpers in the circuit packages; do not
reimplement that conversion at an API boundary.

The active reclaim path uses the single-destination profile. The original
ownership-only CLI and verifier remain separate development/demo surfaces and
must not be substituted into `ReclaimGlobalV2`.

## Code Map

- `internal/circuit/ownership`: CIP-1852 derivation, credential construction,
  ownership-only public input, and path search.
- `internal/circuit/ownershipdest`: single-credential destination binding.
- `internal/circuit/ownershipmulti`: count-parametric ordered-credential and
  destination binding.
- `internal/circuit/ckd`, `ed25519`, `hash`, and `sha512`: circuit gadgets used
  by all profiles.
- `internal/prover`: coherent key-bundle loading, proving, verification,
  Cardano serialization, and profile-specific key directories.
- `internal/artifact`: proof/key manifest schemas and backend artifact
  sanitization.
- `internal/helper`: loopback proof-generation service.
- `internal/verifier`: hosted ownership-only verifier service.
- `cmd/proof-tool`: CLI, helper/verifier servers, ceremony tools, Cardano
  export, fixtures, and chunk-manifest generation.
- `cmd/api`: the Vercel-compatible ownership-only verifier entrypoint.
- `packages/client-ts`: browser-side mnemonic validation and 96-byte master
  XPrv derivation, including the worker request handler.

## Artifact Boundary

`artifact.ProofArtifact` can represent the three profiles. Important fields are
the circuit ID, pinned `vk_hash`, credential or ordered credentials,
destination encoding/bytes where applicable, recomputable public input, proof,
and optional Cardano bytes.

`artifact.BackendProofArtifact` removes `path` and `paths`. Apply it whenever an
artifact leaves a local debug boundary. Path metadata is not needed for hosted
verification or on-chain verification.

The JSON artifact is not a Cardano redeemer. `proof-tool export-cardano`
produces the committed BSB22 bytes expected by the contracts:

- `proof.hex`: 336-byte proof;
- `vk.hex`: 672-byte verifying key;
- `pub.hex`: 32-byte public-input digest fixture.

Contracts normally recompute the digest from transaction data instead of
trusting `pub.hex`.

## Key-Bundle Coherence

Production proving loads a signed bundle and fails closed. A bundle ties
together key version, circuit ID, proving/verifying key sizes and hashes,
constraint-system hash, VK hash, signer identity, and setup metadata. Do not
point a production helper at an empty key directory or enable
`--dev-create-keys`; a newly generated proving key will not match the deployed
verifier or contracts.

Treat these as one release unit:

- proving and verifying keys;
- signed key manifest and signer pin;
- constraint system;
- Cardano VK bytes;
- browser chunk manifest and runtime pins;
- reclaim deployment manifest and contract parameters.

See `proof-assets-release-inventory.md` and `trusted-setup-ceremony.md` before
changing any member of that set.

## Loopback Helper API

`proof-tool serve-helper` binds to loopback, emits one machine-readable
`proof_tool_helper_ready` JSON line, and opens a pairing URL whose helper origin
and token are in the URL fragment. The web app consumes and clears the fragment.

Endpoints:

- `GET /health`: basic service identity.
- `GET /status`: protocol/sidecar versions, exact allowed origins, base and
  destination profile key state, compatibility, circuit ID, key version, and
  VK hash.
- `POST /prove`: ownership-only proof.
- `POST /prove-destination`: ordered batch of single-destination requests.
- `POST /shutdown`: paired graceful shutdown.

Proof and shutdown calls require an exact allowed `Origin` and
`X-Proof-Tool-Token`. Token comparison is constant-time. The server supports
Chrome Private Network Access preflight for allowed origins. Destination
responses omit path metadata unless an explicit local debug request sets
`include_debug_path`.

Destination proving supports an opt-in `Accept: application/x-ndjson`
response. It streams aggregate key-discovery and per-proof progress followed
by one terminal result or sanitized error event. Closing or aborting the
loopback request cancels the Go request context. Existing clients that request
ordinary JSON retain the original one-response protocol.

## Hosted Verifier Boundary

The ownership-only verifier does not trust client-supplied public input,
credential match, circuit ID, or `vk_hash`. It sanitizes path metadata,
recomputes the public input from the target credential, compares an optional
expected credential, checks the pinned VK hash, then verifies the proof.

The claim backend has a separate destination-proof validation path in
`apps/ownership-proof-web/lib/claim-server/build-submit.ts`; it recomputes
destination-bound inputs from the draft and deployment before building a
transaction.

## Development Checks

Fast checks:

```bash
go test ./...
pnpm --dir packages/client-ts test
pnpm --dir packages/client-ts build
```

Full proof tests are opt-in because setup/proving is expensive:

```bash
PROOF_TOOL_RUN_FULL_PROOF=1 go test ./internal/prover -run 'Ownership|Destination|Multi' -count=1
```

Use repo-backed vectors and contract fixtures. The local fixture helper and
verifier prove control flow only; they are not evidence that a credential proof
or production key bundle works.
