# Local Credential Discovery

## Purpose and supported roles

Users should not need to know a CIP-1852 account, role, or address index. Both
local proving modes therefore discover every requested 28-byte key credential
automatically before loading the proving key or constraint system.

The current proof coherence set supports these [CIP-1852 roles](https://cips.cardano.org/cip/CIP-1852):

| Role | Meaning | Deployed V2 proof support |
| --- | --- | --- |
| 0 | External payment | Yes |
| 1 | Internal/change payment | Yes |
| 2 | Staking key ([CIP-11](https://cips.cardano.org/cip/CIP-11)) | Yes |
| 3 | DRep key ([CIP-105](https://cips.cardano.org/cip/CIP-0105)) | No; requires a new circuit coherence set |
| 4 | Constitutional committee cold key | No |
| 5 | Constitutional committee hot key | No |

Reclaim datums can contain the hash of a role-2 key, so role 2 must not be
discarded as “not a payment role.” The field's historical payment-credential
name does not narrow the circuit's existing role-2 derivation relation.

Role 3 is DRep, but adding it only to search would be misleading: the current
`ckd.DeriveChain` relation constrains the witness role to 0, 1, or 2, and the
signed V2 PK/VK/CCS were generated for that exact relation. A role-3 path found
by an unconstrained pre-search would fail during witness assignment or proof
generation.

## Algorithm

`ownership.DiscoverCredentialPaths` performs one traversal for the complete
set of distinct targets:

1. Derive `1852'` and `1815'` once.
2. Derive each configured hardened account once and convert it to an extended
   public key.
3. Derive the soft role parents once for roles 0, 1, and 2.
4. For each candidate index, derive only the soft public child, hash its
   compressed Ed25519 public key with BLAKE2b-224, and perform an O(1) target-set
   lookup.
5. Re-derive every match through the canonical private implementation and
   compare it in constant time before returning the path.
6. Stop as soon as every distinct target has been resolved.

The optimized public derivation uses `filippo.io/edwards25519` and is
differential-tested against the existing circuit-oriented private reference.
Tests cover fixed boundary vectors, the CIP-11 role-2 vector, randomized valid
masters and paths through roles 0 to 5, and canonical private re-verification
of every production match.

## Search order and bounds

The default bounds remain accounts 0 through 9 and indexes 0 through 999. The
schedule is index-major and role-prioritized:

```text
indexes 0..19, then 20..99, then 100..999
  for each index:
    role 0 across accounts 0..9
    role 1 across accounts 0..9
    role 2 across accounts 0..9
```

This finds account 3 / role 0 / index 0 after four candidates, rather than
exhausting thousands of high indexes under earlier accounts. Role 2 remains in
the automatic search and an account-3 stake key at index 0 is reached after 24
candidates. The full bounded miss is 30,000 candidates.

The 0–19 band is a priority tier, not a correctness cutoff. Cardano wallet gap
conventions concern address usage/history; this local proof search has no
trusted transaction-history oracle, so it continues through the configured
999 bound.

## Progress, cancellation, and privacy

Progress contains only:

- candidates scanned and total;
- matched and target counts;
- elapsed time, candidates per second, and ETA;
- coarse local stages and proof ordinal counts.

It never contains the mnemonic, master XPrv, target credentials, account,
role, index, derived keys, or paths. Browser progress is whitelisted again in
the worker bootstrap. Desktop progress is whitelisted into NDJSON response
types and uses a sanitized terminal error.

Browser cancellation terminates the dedicated prover worker. Desktop
cancellation aborts the loopback fetch; request-context cancellation is checked
for every candidate and before every proof. The browser cache contains only
paths for one hashed master-key identity and is cleared on identity change or
worker termination. Helper paths live only for the request. Callers clear
master-key byte buffers in `finally`, and the helper clears its decoded request
buffer on return. Go cannot promise compiler-enforced erasure of every copied
value, so this is best-effort memory hygiene, not a hardware zeroization claim.

## Performance evidence

Measured July 15, 2026 on an AMD Ryzen 9 9950X3D with Go 1.26.0:

| Case | Legacy private root-to-leaf scan | Optimized native | Improvement |
| --- | ---: | ---: | ---: |
| Account 3 / role 0 / index 0 | 58.359 s, 9,001 candidates | 8.255 ms median, 4 candidates | about 7,069x |
| Full bounded miss | 197.433 s, 30,000 candidates | 461.357 ms median, 30,000 candidates | about 428x |

Real Go-WASM entrypoint results from the production Binaryen `-O3 -all` build:

| Host mode | Account-3 match | Full miss |
| --- | ---: | ---: |
| Node Go-WASM | 49.63 ms | 2.795 s |
| Headless Chromium dedicated worker, unconstrained | 34.4 ms median | 2.911 s |

The deliberately constrained-host check used the unoptimized build, pinned the
browser to one loaded CPU, and reported 174.7 ms median for the account-3 match
and 12.767 s for the complete miss. This is a responsiveness bound, not a
production throughput comparison.

The final optimized runtime is 22,797,387 bytes with SHA-256
`b4f60806d8828fdd5d4a1393862ae96f2f62e7fa24a0ef7a123cb1b2f28d487a`.
It is staged in immutable release
`proof-assets-ownership-destination-v2-preprod-9fac96b-g3a-2m-key-discovery-r1`.
The release verifier passed both its versioned descriptor and the promoted
stable pointer, checking 16 same-origin resources plus the signed bulk-asset
identities.

A live-style cold Chromium run then used automatic account-3 / role-2 / index-0
discovery, the immutable release, and the deployed remote PK/CCS transports. It
constructed the destination proof in 90.534 s, peaked at 0.833 GiB main WASM
heap, and verified locally. Concurrent unrelated builds contaminated timing,
so this is functional evidence rather than a performance baseline. The signed
desktop/helper bundle produced and verified the same class of role-2 proof in
20.154 s cold and 4.378 s warm.

The original live report of roughly six minutes for an account-3 wallet is
consistent with the old account-major private scan, but it is not used as a
controlled benchmark.

## Role-3 upgrade boundary

Supporting DRep credentials requires a separately reviewed protocol release:

1. Extend the circuit role constraint and bump every affected circuit/key
   version; do not reuse a V2 identifier.
2. Refresh constraint gates and prove positive role-3 plus negative
   out-of-range cases.
3. Produce and accept a new signed PK/VK/CCS setup bundle with explicit trust
   provenance.
4. Refresh Cardano VK exports, verifier parameters, batch transcripts,
   contract/reference-script artifacts, deployment manifest, browser chunk
   manifest/signatures, and helper pins as one coherence set.
5. Run real derive/prove/verify/export and contract-path evidence for DRep
   index 0 and a nonzero index (CIP-105 recommends, but does not require,
   `address_index=0`).
6. Deploy and activate that coherence set before enabling role 3 in automatic
   production search.

Roles 4 and 5 require the same analysis. The optimized public-child primitive
is already differentially tested through those roles, so the future work is
the proof/deployment boundary, not another search-engine rewrite.

## Rollout and rollback

The browser runtime must ship under a new immutable release ID whose runtime
manifest pins the new WASM and worker bytes. Promote the stable deployment
descriptor only after `verify-proof-release.mjs`, the real worker discovery
test, proof generation, local verification, and contract-facing validation all
pass. Rollback is the stable descriptor's previous immutable runtime release;
the circuit and V2 proof assets remain unchanged by this optimization.

The desktop sidecar change is backward compatible at the HTTP boundary. New
web clients request NDJSON; old helpers ignore the `Accept` preference and
return JSON, which the client still accepts. A new helper release is required
for streamed progress, cancellation propagation, and optimized discovery.
