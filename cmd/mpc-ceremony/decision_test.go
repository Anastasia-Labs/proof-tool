// Copyright 2026 Midgard Labs
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"proof-tool/internal/mpcceremony"
)

func TestDecisionSignCLIAuthenticatesDefinitionRoleAndExactBytes(t *testing.T) {
	root := t.TempDir()
	definition, decisionBytes, coordinatorKey := decisionSignFixture(t)
	definitionBytes, definitionSignatureBytes, err := mpcceremony.SignRecord(
		definition,
		definition.Coordinator.KeyID,
		coordinatorKey,
	)
	if err != nil {
		t.Fatal(err)
	}
	ceremonyPath := filepath.Join(root, "ceremony.json")
	ceremonySignaturePath := filepath.Join(root, "ceremony.sig.json")
	coordinatorPublicKeyPath := filepath.Join(root, "coordinator-public-key.hex")
	decisionDraftPath := filepath.Join(root, "decision.draft.json")
	decisionPath := filepath.Join(root, "decision.json")
	signingKeyPath := filepath.Join(root, "coordinator-private-key.hex")
	outputPath := filepath.Join(root, "coordinator-decision.sig.json")
	writeDecisionTestFile(t, ceremonyPath, definitionBytes, 0o600)
	writeDecisionTestFile(t, ceremonySignaturePath, definitionSignatureBytes, 0o600)
	writeDecisionTestFile(
		t,
		coordinatorPublicKeyPath,
		[]byte(definition.Coordinator.Ed25519PublicKeyHex+"\n"),
		0o600,
	)
	var expectedDecision mpcceremony.ProductionDecision
	if err := mpcceremony.UnmarshalCanonical(decisionBytes, &expectedDecision); err != nil {
		t.Fatal(err)
	}
	draftBytes, err := mpcceremony.MarshalCanonical(decisionDraft(expectedDecision))
	if err != nil {
		t.Fatal(err)
	}
	writeDecisionTestFile(t, decisionDraftPath, draftBytes, 0o600)
	writeDecisionTestFile(t, signingKeyPath, []byte(hex.EncodeToString(coordinatorKey)+"\n"), 0o600)

	trustArgs := []string{
		"--ceremony", ceremonyPath,
		"--ceremony-signature", ceremonySignaturePath,
		"--coordinator-public-key-file", coordinatorPublicKeyPath,
	}
	prepareArgs := append(
		[]string{"--format", "json", "decision", "prepare"},
		trustArgs...,
	)
	prepareArgs = append(
		prepareArgs,
		"--draft", decisionDraftPath,
		"--out", decisionPath,
	)
	var prepareStdout, prepareStderr bytes.Buffer
	if code := runCLI(
		context.Background(),
		prepareArgs,
		&prepareStdout,
		&prepareStderr,
		workflowExecutor{},
	); code != 0 {
		t.Fatalf(
			"decision prepare exit = %d, stdout = %q, stderr = %q",
			code,
			prepareStdout.String(),
			prepareStderr.String(),
		)
	}
	preparedBytes, err := os.ReadFile(decisionPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(preparedBytes, decisionBytes) {
		t.Fatal("decision prepare did not derive the exact expected canonical record")
	}

	args := []string{
		"--format", "json",
		"decision", "sign",
		"--ceremony", ceremonyPath,
		"--ceremony-signature", ceremonySignaturePath,
		"--coordinator-public-key-file", coordinatorPublicKeyPath,
		"--decision", decisionPath,
		"--role", "coordinator",
		"--signer-id", definition.Coordinator.ID,
		"--signing-key", signingKeyPath,
		"--out", outputPath,
	}
	var stdout, stderr bytes.Buffer
	if code := runCLI(context.Background(), args, &stdout, &stderr, workflowExecutor{}); code != 0 {
		t.Fatalf("decision sign exit = %d, stdout = %q, stderr = %q", code, stdout.String(), stderr.String())
	}
	var result CommandResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.OK || result.Command != CommandDecisionSign ||
		result.Decision != string(mpcceremony.DecisionNOGO) ||
		result.CeremonyID != definition.CeremonyID {
		t.Fatalf("decision sign result = %+v", result)
	}
	signatureBytes, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatal(err)
	}
	var signature mpcceremony.ProductionDecisionSignature
	if err := mpcceremony.UnmarshalCanonical(signatureBytes, &signature); err != nil {
		t.Fatal(err)
	}
	publicKey := coordinatorKey.Public().(ed25519.PublicKey)
	if err := mpcceremony.VerifyExact(
		decisionBytes,
		signature.Signature,
		definition.Coordinator.KeyID,
		publicKey,
	); err != nil {
		t.Fatal(err)
	}
}

func TestDecisionVerifyCLIRequiresAndRoutesExplicitSignatures(t *testing.T) {
	args := []string{
		"--format", "json",
		"decision", "verify",
		"--ceremony", "ceremony.json",
		"--ceremony-signature", "ceremony.sig.json",
		"--coordinator-public-key-file", "coordinator.pub",
		"--decision", "decision.json",
		"--signature", "coordinator.sig.json",
		"--signature", "auditor-01.sig.json",
		"--signature", "auditor-02.sig.json",
		"--signature", "release.sig.json",
		"--evidence-root", "evidence",
	}
	executor := executorFunc(func(_ context.Context, invocation Invocation) (CommandResult, error) {
		if invocation.Command != CommandDecisionVerify {
			t.Fatalf("command = %q", invocation.Command)
		}
		options := invocation.Options.(DecisionVerifyOptions)
		if len(options.SignaturePaths) != 4 || options.EvidenceRoot != "evidence" {
			t.Fatalf("decision verify options = %+v", options)
		}
		return CommandResult{
			Decision:   string(mpcceremony.DecisionGO),
			DecisionID: "sha256:" + strings.Repeat("11", 32),
			ReleaseID:  "sha256:" + strings.Repeat("22", 32),
		}, nil
	})
	var stdout, stderr bytes.Buffer
	if code := runCLI(context.Background(), args, &stdout, &stderr, executor); code != 0 {
		t.Fatalf("decision verify exit = %d, stderr = %q", code, stderr.String())
	}
	var result CommandResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.OK || result.Command != CommandDecisionVerify ||
		result.Decision != string(mpcceremony.DecisionGO) {
		t.Fatalf("decision verify result = %+v", result)
	}
}

func decisionSignFixture(t *testing.T) (mpcceremony.CeremonyDefinition, []byte, ed25519.PrivateKey) {
	t.Helper()
	private := func(fill byte) ed25519.PrivateKey {
		return ed25519.NewKeyFromSeed(bytes.Repeat([]byte{fill}, ed25519.SeedSize))
	}
	identity := func(id string, fill byte) mpcceremony.Identity {
		value, err := mpcceremony.NewIdentity(
			id,
			"Test "+id,
			id+"-key",
			private(fill).Public().(ed25519.PublicKey),
		)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	coordinator := identity("coordinator", 0x01)
	releaseSigner := identity("release-signer", 0x02)
	auditors := []mpcceremony.Identity{identity("auditor-01", 0x03), identity("auditor-02", 0x04)}
	participants := []mpcceremony.Participant{
		{Identity: identity("participant-01", 0x11)},
		{Identity: identity("participant-02", 0x12)},
		{Identity: identity("participant-03", 0x13)},
	}
	definition, err := mpcceremony.NewCeremonyDefinition(mpcceremony.DefinitionOptions{
		Mode:            mpcceremony.ModeProduction,
		CreatedAt:       "2026-07-23T12:00:00Z",
		SessionNonceHex: strings.Repeat("5a", 32),
		Circuit: mpcceremony.CircuitBinding{
			KeyVersion:        mpcceremony.KeyVersionDestinationV2,
			CircuitID:         mpcceremony.CircuitIDDestinationV2,
			Curve:             mpcceremony.CurveBLS12381,
			Backend:           mpcceremony.BackendGroth16,
			R1CS:              decisionArtifact("circuit.ccs", "r1cs").Artifact,
			Constraints:       1_789_750,
			InternalVariables: 3,
			SecretVariables:   2,
			PublicVariables:   1,
			DomainSize:        1 << 21,
			Phase2Shape: mpcceremony.Phase2Shape{
				Commitments: 1, PKK: 1, Z: 7, SigmaCKK: []uint32{1},
			},
		},
		Software: mpcceremony.SoftwareBinding{
			ProofToolVersion: "0.1.0", GnarkVersion: mpcceremony.GnarkVersion,
			GnarkCryptoVersion: mpcceremony.GnarkCryptoVersion, DrandVersion: mpcceremony.DrandVersion,
			GoVersion: mpcceremony.ProductionGoVersion, GoOS: mpcceremony.ProductionGOOS,
			GoArch: mpcceremony.ProductionGOARCH, GoAMD64: mpcceremony.ProductionGOAMD64,
			Compiler: mpcceremony.ProductionCompiler, BuildMode: mpcceremony.ProductionBuildMode,
			TrimPath: true, SourceCommit: strings.Repeat("6b", 20),
			ToolBinary: mpcceremony.NewDigest([]byte("binary")),
		},
		Coordinator: coordinator, ReleaseSigner: releaseSigner, Auditors: auditors, Roster: participants,
		Phase1Policy: mpcceremony.PhasePolicy{
			Participants: []string{"participant-01", "participant-02", "participant-03"}, Minimum: 3,
		},
		Phase2Policy: mpcceremony.PhasePolicy{
			Participants: []string{"participant-01", "participant-02", "participant-03"}, Minimum: 3,
		},
		BeaconPolicy: mpcceremony.BeaconPolicy{
			Provider: mpcceremony.BeaconProviderDrand, Network: mpcceremony.BeaconNetworkQuicknet,
			ChainHashHex: mpcceremony.BeaconQuicknetChainHash, PublicKeyHex: mpcceremony.BeaconQuicknetPublicKey,
			Scheme: mpcceremony.BeaconQuicknetScheme, GenesisTimeUnix: mpcceremony.BeaconQuicknetGenesis,
			PeriodSeconds: mpcceremony.BeaconQuicknetPeriod, Extraction: mpcceremony.BeaconExtractionV1,
			MinimumChallengeBytes: 32, MinimumWitnessLeadSeconds: mpcceremony.ProductionMinimumWitnessLeadSeconds,
			FutureRoundRequired: true,
		},
		Phase1Genesis: decisionArtifact("phase1/genesis.bin", "genesis").Artifact,
	})
	if err != nil {
		t.Fatal(err)
	}
	release, err := mpcceremony.NewSignedReleaseEvidence(mpcceremony.SignedReleaseEvidence{
		CandidateID:       "sha256:" + strings.Repeat("71", 32),
		Manifest:          decisionArtifact("release/manifest.json", "manifest"),
		ManifestSignature: decisionArtifact("release/manifest.sig", "manifest sig"),
		ManifestPublicKey: decisionArtifact("release/manifest-public-key.hex", "manifest pub"),
		Candidate: mpcceremony.SignedLocatedArtifact{
			Record:    decisionArtifact("release/candidate.json", "candidate"),
			Signature: decisionArtifact("release/candidate.sig.json", "candidate sig"),
		},
		FinalTranscript: decisionArtifact("release/final-transcript.json", "transcript"),
		Artifacts:       decisionReleaseArtifacts(),
	})
	if err != nil {
		t.Fatal(err)
	}
	gates := make([]mpcceremony.ProductionGateResult, 14)
	gateNames := []mpcceremony.ProductionGate{
		mpcceremony.GateSignedRelease, mpcceremony.GateOperationalEvidence,
		mpcceremony.GateIndependentAudits, mpcceremony.GateExternalAudit,
		mpcceremony.GateK21Rehearsal, mpcceremony.GateMainnetDeploymentPlan,
		mpcceremony.GateFormalChecklist, mpcceremony.GateParticipantIndependent,
		mpcceremony.GateParticipantHost, mpcceremony.GateParticipantEntropy,
		mpcceremony.GateParticipantErasure, mpcceremony.GatePublicWitnessing,
		mpcceremony.GateImmutableMirrors, mpcceremony.GateLiveTwentyParty,
	}
	for index, gate := range gateNames {
		gates[index] = mpcceremony.ProductionGateResult{
			Gate: gate, Status: mpcceremony.GatePENDING, Rationale: "External evidence remains pending.",
		}
	}
	decision, err := mpcceremony.NewProductionDecision(mpcceremony.ProductionDecision{
		CeremonyID: definition.CeremonyID,
		Release:    release,
		SourceRelease: mpcceremony.SourceReleaseEvidence{
			SourceCommit: definition.Software.SourceCommit, SignedTag: "v1.0.0-mainnet",
			SignatureFormat: "openpgp-primary-key-v4", SignerFingerprintHex: strings.Repeat("ab", 20),
			SignedTagObject: decisionArtifact("source/v1.0.0-mainnet.tag", "tag object"),
		},
		OperationalEvidence: mpcceremony.SignedLocatedArtifact{
			Record:    decisionArtifact("operational/bundle.json", "bundle"),
			Signature: decisionArtifact("operational/bundle.sig.json", "bundle sig"),
		},
		Audits: []mpcceremony.ProductionAuditEvidence{
			{AuditorID: auditors[0].ID, AuditorKeyID: auditors[0].KeyID, Audit: mpcceremony.SignedLocatedArtifact{
				Record:    decisionArtifact("audits/auditor-01.json", "audit1"),
				Signature: decisionArtifact("audits/auditor-01.sig.json", "audit1 sig"),
			}},
			{AuditorID: auditors[1].ID, AuditorKeyID: auditors[1].KeyID, Audit: mpcceremony.SignedLocatedArtifact{
				Record:    decisionArtifact("audits/auditor-02.json", "audit2"),
				Signature: decisionArtifact("audits/auditor-02.sig.json", "audit2 sig"),
			}},
		},
		ExternalAudits: []mpcceremony.ExternalAuditEvidence{
			{
				Auditor: identity("external-auditor-a", 0x05),
				Report:  decisionArtifact("external/audit-a.pdf", "external audit a"),
				Signoff: decisionArtifact("external/audit-a.sig.json", "external signoff a"),
			},
			{
				Auditor: identity("external-auditor-b", 0x06),
				Report:  decisionArtifact("external/audit-b.pdf", "external audit b"),
				Signoff: decisionArtifact("external/audit-b.sig.json", "external signoff b"),
			},
		},
		K21Rehearsal: mpcceremony.K21RehearsalEvidence{
			KeyVersion: definition.Circuit.KeyVersion, CircuitID: definition.Circuit.CircuitID,
			Curve: definition.Circuit.Curve, Backend: definition.Circuit.Backend,
			Constraints: definition.Circuit.Constraints, DomainSize: definition.Circuit.DomainSize,
			Evidence: decisionArtifact("rehearsal/k21.tar.zst", "rehearsal"),
		},
		MainnetDeploymentPlan: decisionArtifact("governance/deployment-plan.md", "plan"),
		FormalChecklist:       decisionArtifact("governance/checklist.md", "checklist"),
		Gates:                 gates,
		Decision:              mpcceremony.DecisionNOGO,
		DecidedAt:             "2026-07-23T16:00:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	record, err := mpcceremony.MarshalCanonical(decision)
	if err != nil {
		t.Fatal(err)
	}
	return definition, record, private(0x01)
}

func decisionArtifact(name, content string) mpcceremony.LocatedArtifactRef {
	return mpcceremony.LocatedArtifactRef{
		URI:      "https://evidence.example/" + name,
		Artifact: mpcceremony.ArtifactRef{Name: name, Digest: mpcceremony.NewDigest([]byte(content))},
	}
}

func decisionReleaseArtifacts() []mpcceremony.LocatedArtifactRef {
	names := []string{
		"release/audits/auditor-01.json",
		"release/audits/auditor-01.sig.json",
		"release/audits/auditor-02.json",
		"release/audits/auditor-02.sig.json",
		"release/candidate-checksums.sha256",
		"release/candidate.json",
		"release/candidate.sig.json",
		"release/cardano-vk-format.txt",
		"release/cardano-vk.bin",
		"release/cardano-vk.hex",
		"release/checksums.sha256",
		"release/final-transcript.json",
		"release/manifest-public-key.hex",
		"release/manifest.json",
		"release/manifest.sig",
		"release/operational/bundle.json",
		"release/operational/bundle.sig.json",
		"release/ownership.ccs",
		"release/ownership.pk",
		"release/ownership.vk",
		"release/phase2-seal.json",
		"release/public-evidence.json",
		"release/verification-report.json",
	}
	result := make([]mpcceremony.LocatedArtifactRef, len(names))
	exactContent := map[string]string{
		"release/candidate.json":          "candidate",
		"release/candidate.sig.json":      "candidate sig",
		"release/final-transcript.json":   "transcript",
		"release/manifest-public-key.hex": "manifest pub",
		"release/manifest.json":           "manifest",
		"release/manifest.sig":            "manifest sig",
	}
	for index, name := range names {
		content := exactContent[name]
		if content == "" {
			content = "release tree " + name
		}
		result[index] = decisionArtifact(name, content)
	}
	return result
}

func decisionDraft(decision mpcceremony.ProductionDecision) mpcceremony.ProductionDecisionDraft {
	return mpcceremony.ProductionDecisionDraft{
		Schema:     mpcceremony.ProductionDecisionDraftSchema,
		CeremonyID: decision.CeremonyID,
		Release: mpcceremony.SignedReleaseEvidenceDraft{
			CandidateID:       decision.Release.CandidateID,
			Manifest:          decision.Release.Manifest,
			ManifestSignature: decision.Release.ManifestSignature,
			ManifestPublicKey: decision.Release.ManifestPublicKey,
			Candidate:         decision.Release.Candidate,
			FinalTranscript:   decision.Release.FinalTranscript,
			Artifacts:         decision.Release.Artifacts,
		},
		SourceRelease:         decision.SourceRelease,
		OperationalEvidence:   decision.OperationalEvidence,
		Audits:                decision.Audits,
		ExternalAudits:        decision.ExternalAudits,
		K21Rehearsal:          decision.K21Rehearsal,
		MainnetDeploymentPlan: decision.MainnetDeploymentPlan,
		FormalChecklist:       decision.FormalChecklist,
		Gates:                 decision.Gates,
		Decision:              decision.Decision,
		DecidedAt:             decision.DecidedAt,
	}
}

func writeDecisionTestFile(t *testing.T, path string, data []byte, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, data, mode); err != nil {
		t.Fatal(err)
	}
}
