// Copyright 2026 Midgard Labs
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"io"
	"strings"
)

func writeUsage(w io.Writer, topic []string) error {
	key := strings.Join(topic, " ")
	if text, ok := commandHelp[key]; ok {
		_, err := fmt.Fprint(w, text)
		return err
	}
	_, err := fmt.Fprint(w, rootHelp)
	return err
}

const rootHelp = `Usage:
  mpc-ceremony [--format human|json] [--quiet] <command> [flags]

Offline, append-only orchestration for this repository's BLS12-381 Groth16
multi-party setup. The binary accepts setup artifacts and signing keys only.
It performs no network access and never selects a mutable "latest" artifact.

Commands:
  init                 Bind a ceremony to the compiled repository circuit
  phase1 contribute    Verify the full phase 1 chain and contribute
  phase1 attest-erasure Sign a participant destruction attestation
  phase1 verify        Verify and append one candidate contribution
  phase1 close         Close the accepted phase 1 chain
  phase1 beacon        Record signed post-closure beacon evidence
  phase1 seal          Apply an offline post-closure beacon
  phase2 init          Initialize circuit-specific phase 2
  phase2 contribute    Verify the full phase 2 chain and contribute
  phase2 attest-erasure Sign a participant destruction attestation
  phase2 verify        Verify and append one candidate contribution
  phase2 close         Close the accepted phase 2 chain
  phase2 beacon        Record signed post-closure beacon evidence
  finalize prepare     Replay both phases and publish preliminary final keys
  finalize complete    Verify external public evidence and create candidate
  audit                Independently replay and audit ceremony artifacts
  release sign         Sign an audited release manifest
  release verify       Verify release and ceremony coherence
  decision prepare     Derive the canonical production GO/NO-GO record
  decision sign        Sign the canonical production GO/NO-GO record
  decision verify      Verify decision evidence and role threshold
  ops export-signing   Export canonical operational bytes for offline signing
  ops import-signature Import and verify a raw offline Ed25519 signature
  ops verify           Verify a signed operational record fail-closed

All input and output paths are explicit. Outputs must not already exist. There
are no network, automatic-discovery, overwrite, deterministic-randomness, or
verification-bypass flags.

Run "mpc-ceremony help <command>" for command-specific help.
`

const replayFlagsHelp = `
Required immutable replay evidence:
  --transcript-root DIR
  --phase1-chain FILE --phase1-chain-signature FILE
  --phase1-close FILE --phase1-close-signature FILE
  --phase1-beacon FILE --phase1-beacon-signature FILE
  --phase1-seal FILE --phase1-seal-signature FILE
  --phase2-chain FILE --phase2-chain-signature FILE
  --phase2-close FILE --phase2-close-signature FILE
  --phase2-beacon FILE --phase2-beacon-signature FILE

The signed chain, closure, beacon, and seal records bind the genesis,
contributions, attestations, erasure evidence, verification records, raw drand
responses, and commons by safe relative artifact name. Those artifacts are
strictly resolved beneath --transcript-root; the operator cannot substitute a
second path list.
`

var commandHelp = map[string]string{
	"init": `Usage:
  mpc-ceremony init --key-version ownership-destination-v2 \
    --participants ROSTER.json --policy POLICY.json \
    --coordinator-key-id ID --coordinator-signing-key KEY \
    --created-at RFC3339 --out-dir DIR [--mode rehearsal|production] \
    [--session-nonce-hex HEX]

Compiles a registered repository circuit and writes a fresh signed ceremony
definition. The authoritative ceremony ID is derived from canonical content,
including a 32-byte session nonce securely generated when omitted. Production
mode requires an exact clean source build.
`,
	"phase1": `Usage:
  mpc-ceremony phase1 <contribute|attest-erasure|verify|close|beacon|seal> [flags]

Phase 1 is sequential and append-only. Contributors and coordinators must name
the exact accepted chain; the command never discovers a "latest" state.
`,
	"phase1 contribute": `Usage:
  mpc-ceremony phase1 contribute --ceremony FILE \
    --ceremony-signature FILE --coordinator-public-key-file KEY \
    --transcript-dir DIR --chain FILE --chain-signature FILE \
    --participant-id ID --participant-signing-key KEY \
    --environment FILE --contributed-at RFC3339 --out-dir FRESH_DIR

Replays the complete accepted phase 1 chain before adding OS-generated
randomness. The input chain is never modified.
`,
	"phase1 attest-erasure": `Usage:
  mpc-ceremony phase1 attest-erasure --ceremony FILE \
    --ceremony-signature FILE --coordinator-public-key-file KEY \
    --participant-id ID --participant-signing-key KEY \
    --candidate-dir DIR --destroyed-at RFC3339

Writes erasure.json and its participant signature into the candidate directory
without replacing existing files. This is an operational attestation, not
technical or cryptographic proof that contribution randomness was erased.
`,
	"phase1 verify": `Usage:
  mpc-ceremony phase1 verify --ceremony FILE --ceremony-signature FILE \
    --coordinator-public-key-file KEY --transcript-dir DIR --chain FILE \
    --chain-signature FILE --candidate-dir DIR \
    --coordinator-signing-key KEY --accepted-at RFC3339

Authenticates the signed chain and candidate evidence, verifies the candidate
transition directly from the accepted native head, then appends immutable
numbered artifacts and a new signed chain record. Participant contribution and
phase close perform the independent full-prefix replays.
`,
	"phase1 close": `Usage:
  mpc-ceremony phase1 close --ceremony FILE --ceremony-signature FILE \
    --coordinator-public-key-file KEY --transcript-dir DIR --chain FILE \
    --chain-signature FILE --coordinator-signing-key KEY \
    --beacon-round N

Replays the full phase, derives the exact Quicknet schedule from the round,
samples closed_at inside the core after replay, and atomically publishes the
signed closure only while the policy lead still holds.
`,
	"phase1 beacon": `Usage:
  mpc-ceremony phase1 beacon --ceremony FILE --ceremony-signature FILE \
    --coordinator-public-key-file KEY --closure FILE \
    --closure-signature FILE --raw-response FILE --published-at RFC3339 \
    --coordinator-signing-key KEY --transcript-dir DIR

Cryptographically verifies an archived pinned drand quicknet response and
derives the protocol challenge from its signature. The command performs no
network fetch and accepts neither randomness nor a challenge from the operator.
`,
	"phase1 seal": `Usage:
  mpc-ceremony phase1 seal --ceremony FILE --ceremony-signature FILE \
    --coordinator-public-key-file KEY --transcript-dir DIR --closure FILE \
    --closure-signature FILE --beacon FILE --beacon-signature FILE \
    --coordinator-signing-key KEY --out-dir FRESH_DIR

The beacon is supplied as offline evidence and must satisfy the signed policy
and postdate the signed closure.
`,
	"phase2": `Usage:
  mpc-ceremony phase2 <init|contribute|attest-erasure|verify|close|beacon> [flags]

Phase 2 is bound to the exact compiled R1CS and verified phase 1 seal.
`,
	"phase2 init": `Usage:
  mpc-ceremony phase2 init --ceremony FILE --ceremony-signature FILE \
    --coordinator-public-key-file KEY --phase1-transcript-dir DIR \
    --phase1-seal FILE --phase1-seal-signature FILE \
    --coordinator-signing-key KEY --out-dir FRESH_DIR
`,
	"phase2 contribute": `Usage:
  mpc-ceremony phase2 contribute --ceremony FILE \
    --ceremony-signature FILE --coordinator-public-key-file KEY \
    --phase1-seal FILE --phase1-seal-signature FILE \
    --transcript-dir DIR --chain FILE --participant-id ID \
    --chain-signature FILE --participant-signing-key KEY \
    --environment FILE --contributed-at RFC3339 --out-dir FRESH_DIR
`,
	"phase2 attest-erasure": `Usage:
  mpc-ceremony phase2 attest-erasure --ceremony FILE \
    --ceremony-signature FILE --coordinator-public-key-file KEY \
    --participant-id ID --participant-signing-key KEY \
    --candidate-dir DIR --destroyed-at RFC3339

Signs the participant's Phase 2 environment-destruction attestation. The
statement is auditable evidence, not proof that secret randomness was erased.
`,
	"phase2 verify": `Usage:
  mpc-ceremony phase2 verify --ceremony FILE --ceremony-signature FILE \
    --coordinator-public-key-file KEY --phase1-seal FILE \
  --phase1-seal-signature FILE --transcript-dir DIR --chain FILE \
  --chain-signature FILE --candidate-dir DIR \
  --coordinator-signing-key KEY --accepted-at RFC3339

Authenticates the signed chain, Phase 1 seal, and candidate evidence; verifies
the candidate transition directly from the accepted native Phase 2 head; then
appends immutable numbered artifacts and a new signed chain record.
Participant contribution and phase close retain independent full replays.
`,
	"phase2 close": `Usage:
  mpc-ceremony phase2 close --ceremony FILE --ceremony-signature FILE \
    --coordinator-public-key-file KEY --phase1-seal FILE \
    --phase1-seal-signature FILE --transcript-dir DIR --chain FILE \
    --chain-signature FILE --coordinator-signing-key KEY \
    --beacon-round N

Replays the full phase, derives the exact Quicknet schedule from the round,
samples closed_at inside the core after replay, and atomically publishes the
signed closure only while the policy lead still holds.
`,
	"phase2 beacon": `Usage:
  mpc-ceremony phase2 beacon --ceremony FILE --ceremony-signature FILE \
    --coordinator-public-key-file KEY --closure FILE \
    --closure-signature FILE --raw-response FILE --published-at RFC3339 \
    --coordinator-signing-key KEY --transcript-dir DIR

Records the distinct Phase 2 post-closure beacon evidence used by finalize.
`,
	"finalize": `Usage:
  mpc-ceremony finalize prepare [FLAGS]
  mpc-ceremony finalize complete [FLAGS]
`,
	"finalize prepare": `Usage:
  mpc-ceremony finalize prepare --ceremony FILE --ceremony-signature FILE \
    --coordinator-public-key-file KEY [REPLAY EVIDENCE FLAGS] \
    --coordinator-signing-key KEY --prepared-at RFC3339_UTC \
    --out-dir FRESH_DIR
` + replayFlagsHelp + `

Independently compiles this repository's destination-v2 R1CS, replays both
phases, and publishes a coordinator-signed preliminary native PK/VK tree. It
is not a candidate and cannot be audited or released.
`,
	"finalize complete": `Usage:
  mpc-ceremony finalize complete --ceremony FILE --ceremony-signature FILE \
    --coordinator-public-key-file KEY [REPLAY EVIDENCE FLAGS] \
    --coordinator-signing-key KEY --public-evidence FILE \
    --finalized-at RFC3339_UTC --out-dir FRESH_DIR
` + replayFlagsHelp + `

Replays both phases again, verifies the canonical external public proof
against the replayed final VK, and creates the coordinator-signed but
unsigned-for-release candidate. It accepts only the public evidence artifact.
Release signing remains a separate post-audit step.
`,
	"audit": `Usage:
  mpc-ceremony audit --ceremony FILE \
    --ceremony-signature FILE --coordinator-public-key-file KEY \
    [REPLAY EVIDENCE FLAGS] --candidate-bundle DIR \
    --auditor-id ID --auditor-signing-key KEY --audited-at RFC3339_UTC \
    --out FRESH_FILE --audit-signature FRESH_FILE
` + replayFlagsHelp + `

Audit always independently compiles the circuit and performs the full
two-phase replay. It emits a signed passing record only after reproducing the
candidate's native keys, Cardano export, and coherence evidence.
`,
	"release": `Usage:
  mpc-ceremony release <sign|verify> [flags]

Release authenticity is separate from MPC contribution identity.
`,
	"release sign": `Usage:
  mpc-ceremony release sign --ceremony FILE --ceremony-signature FILE \
    --coordinator-public-key-file KEY --candidate-bundle DIR \
	    --audit-report FILE --audit-signature FILE \
	    --audit-report FILE --audit-signature FILE \
	    --operational-evidence-root DIR \
	    --operational-bundle DIR/operational/evidence-bundle.json \
	    --operational-bundle-signature DIR/operational/evidence-bundle.sig \
	    --release-signing-key KEY --signature-key-id ID \
    --released-at RFC3339_UTC --release-dir FRESH_DIR

	Requires at least two distinct enrolled auditors plus the coordinator-signed
	Phase 1 and Phase 2 operational bundle. Each phase must contain a valid public
	witness quorum and matching multi-relay beacon responses. The candidate is
	never mutated; all verified evidence is atomically published into a fresh
	release directory.
`,
	"release verify": `Usage:
  mpc-ceremony release verify --ceremony FILE --ceremony-signature FILE \
    --coordinator-public-key-file KEY --keys-dir DIR \
    --manifest-public-key-file KEY --signature-key-id ID

Authenticates the release using the out-of-band release public key, then
strictly verifies the bundled audit evidence, transcript, native keys, Cardano
export, candidate signature, and checksums.
`,
	"decision": `Usage:
  mpc-ceremony decision <prepare|sign|verify> [flags]

Production decisions are canonical content-addressed records. The command
never fetches evidence URIs and never infers independence, host integrity,
entropy quality, erasure, public witnessing, mirrors, or attendance.
`,
	"decision prepare": `Usage:
  mpc-ceremony decision prepare --ceremony FILE --ceremony-signature FILE \
    --coordinator-public-key-file KEY --draft FILE --out FRESH_FILE

Strictly parses a proof-tool-mpc-production-decision-draft-v1 record, derives
the release_id and decision_id, and checks ceremony, source, exact K=21
circuit, and signer-role bindings. The fresh output is the only byte string
the accountable roles should sign.
`,
	"decision sign": `Usage:
  mpc-ceremony decision sign --ceremony FILE --ceremony-signature FILE \
    --coordinator-public-key-file KEY --decision FILE \
    --evidence-root DIR \
    --role coordinator|auditor|release_signer --signer-id ID \
    --signing-key KEY --out FRESH_FILE

Signs the exact canonical decision bytes with one enrolled ceremony identity.
A GO record requires the coordinator, the two auditors named by the record,
and the distinct release signer to sign the same bytes. Before loading a GO
signing key, the command hashes and semantically verifies the full local
evidence set. Evidence verification is optional for a NO-GO record so an
accountable role can sign a fail-closed decision that reports unavailable
evidence.
`,
	"decision verify": `Usage:
  mpc-ceremony decision verify --ceremony FILE --ceremony-signature FILE \
    --coordinator-public-key-file KEY --decision FILE \
    --signature FILE --signature FILE --signature FILE --signature FILE \
    --evidence-root DIR

Strictly parses the record and detached role signatures, hashes every local
evidence artifact, checks release/candidate/transcript/operational/audit
coherence, and fail-closes GO unless all gates PASS and all four roles signed.
Evidence URIs are content bindings only; the command performs no network fetch.
`,
	"ops": `Usage:
  mpc-ceremony ops <export-signing|import-signature|verify> [flags]

Operational records cover proof-of-possession enrollment, transfers and
receipts, immutable mirrors, pre-beacon public witnesses, multi-operator relay
evidence, governance events, and the release-bound operational evidence bundle.
`,
	"ops export-signing": `Usage:
  mpc-ceremony ops export-signing --record-type TYPE --record FILE \
    --ceremony FILE --ceremony-signature FILE \
    --coordinator-public-key-file KEY --out-dir FRESH_DIR

Strictly verifies the canonical record and ceremony binding, then exports
canonical.json and signing-request.json. No private signing key is read.
`,
	"ops import-signature": `Usage:
  mpc-ceremony ops import-signature --record-type TYPE --canonical FILE \
    --ceremony FILE --ceremony-signature FILE \
    --coordinator-public-key-file KEY --signer-public-key-file KEY \
    --raw-signature FILE --out FRESH_FILE

Accepts 64 raw signature bytes or 128 lowercase hex characters, verifies the
offline Ed25519 signature over exact canonical bytes and signer identity, then
writes the repository detached-signature format without replacement.
`,
	"ops verify": `Usage:
  mpc-ceremony ops verify --record-type TYPE --record FILE --signature FILE \
    --ceremony FILE --ceremony-signature FILE \
    --coordinator-public-key-file KEY --signer-public-key-file KEY \
    [--related-record HANDOFF] [--evidence-root DIR]

Authenticates canonical bytes, immutable ceremony fields, enrolled signer, and
detached signature. Receipt verification requires the exact related handoff.
Evidence-bundle verification requires the complete local evidence root and
validates both authenticated chains, every custody transfer, independent
mirrors and public witnesses, and three distinct beacon relay operators.
`,
}
