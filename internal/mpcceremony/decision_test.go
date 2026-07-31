package mpcceremony

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"proof-tool/internal/artifact"
)

type productionDecisionFixture struct {
	root       string
	definition CeremonyDefinition
	decision   ProductionDecision
	record     []byte
	signatures [][]byte
}

func TestProductionDecisionGORequiresExactRoleThresholdAndEvidence(t *testing.T) {
	fixture := newProductionDecisionFixture(t, DecisionGO)
	evidenceOnly, err := VerifyProductionDecisionEvidence(
		VerifyProductionDecisionEvidenceOptions{
			Definition:    fixture.definition,
			DecisionBytes: fixture.record,
			EvidenceRoot:  fixture.root,
		},
	)
	if err != nil {
		t.Fatalf("verify production GO evidence before signing: %v", err)
	}
	if len(evidenceOnly.VerifiedSigners) != 0 ||
		evidenceOnly.Decision.DecisionID != fixture.decision.DecisionID {
		t.Fatalf("evidence-only result = %#v", evidenceOnly)
	}
	verified, err := VerifyProductionDecision(VerifyProductionDecisionOptions{
		Definition:     fixture.definition,
		DecisionBytes:  fixture.record,
		SignatureBytes: fixture.signatures,
		EvidenceRoot:   fixture.root,
	})
	if err != nil {
		t.Fatalf("verify production GO decision: %v", err)
	}
	if verified.Decision.Decision != DecisionGO || len(verified.VerifiedSigners) != 4 {
		t.Fatalf("verified decision = %q with %d signers", verified.Decision.Decision, len(verified.VerifiedSigners))
	}

	for index := range fixture.signatures {
		missing := append([][]byte(nil), fixture.signatures[:index]...)
		missing = append(missing, fixture.signatures[index+1:]...)
		if _, err := VerifyProductionDecision(VerifyProductionDecisionOptions{
			Definition:     fixture.definition,
			DecisionBytes:  fixture.record,
			SignatureBytes: missing,
			EvidenceRoot:   fixture.root,
		}); err == nil || !strings.Contains(err.Error(), "missing required") {
			t.Fatalf("missing signature %d error = %v", index, err)
		}
	}

	duplicate := append(append([][]byte(nil), fixture.signatures...), fixture.signatures[0])
	if _, err := VerifyProductionDecision(VerifyProductionDecisionOptions{
		Definition:     fixture.definition,
		DecisionBytes:  fixture.record,
		SignatureBytes: duplicate,
		EvidenceRoot:   fixture.root,
	}); err == nil || !strings.Contains(err.Error(), "duplicate decision signature") {
		t.Fatalf("duplicate signature error = %v", err)
	}
}

func TestPrepareProductionDecisionDerivesExactSignedRecord(t *testing.T) {
	fixture := newProductionDecisionFixture(t, DecisionGO)
	draft := productionDecisionDraft(fixture.decision)
	draftBytes, err := MarshalCanonical(draft)
	if err != nil {
		t.Fatal(err)
	}
	prepared, preparedBytes, err := PrepareProductionDecision(fixture.definition, draftBytes)
	if err != nil {
		t.Fatalf("prepare production decision: %v", err)
	}
	if prepared.DecisionID != fixture.decision.DecisionID ||
		prepared.Release.ReleaseID != fixture.decision.Release.ReleaseID ||
		!slices.Equal(preparedBytes, fixture.record) {
		t.Fatal("prepared decision does not exactly reproduce the content-addressed record")
	}

	unknown := append([]byte(nil), draftBytes[:len(draftBytes)-1]...)
	unknown = append(unknown, []byte(`,"unknown":true}`)...)
	if _, _, err := PrepareProductionDecision(fixture.definition, unknown); err == nil {
		t.Fatal("decision prepare accepted an unknown draft field")
	}
	if _, _, err := PrepareProductionDecision(
		fixture.definition,
		append(append([]byte(nil), draftBytes...), '\n'),
	); err == nil {
		t.Fatal("decision prepare accepted trailing bytes")
	}
}

func TestSignedReleaseInventorySupportsTwentyPartyOperationalScale(t *testing.T) {
	const representativeFiles = 1024
	artifacts := make([]LocatedArtifactRef, representativeFiles)
	for index := range artifacts {
		name := fmt.Sprintf("release/operational/artifact-%04d.json", index)
		artifacts[index] = LocatedArtifactRef{
			URI: "https://evidence.example/" + name,
			Artifact: ArtifactRef{
				Name:   name,
				Digest: NewDigest([]byte(name)),
			},
		}
	}
	input := SignedReleaseEvidence{
		CandidateID: "sha256:" + strings.Repeat("71", 32),
		Manifest:    decisionScaleArtifact("release/manifest.json", "manifest"),
		ManifestSignature: decisionScaleArtifact(
			"release/manifest.sig",
			"manifest signature",
		),
		ManifestPublicKey: decisionScaleArtifact(
			"release/manifest-public-key.hex",
			"manifest public key",
		),
		Candidate: SignedLocatedArtifact{
			Record:    decisionScaleArtifact("release/candidate.json", "candidate"),
			Signature: decisionScaleArtifact("release/candidate.sig.json", "candidate signature"),
		},
		FinalTranscript: decisionScaleArtifact("release/setup-transcript.json", "transcript"),
		Artifacts:       artifacts,
	}
	if _, err := NewSignedReleaseEvidence(input); err != nil {
		t.Fatalf("representative 20-party release inventory rejected: %v", err)
	}

	input.Artifacts = make([]LocatedArtifactRef, MaxProductionReleaseArtifacts+1)
	for index := range input.Artifacts {
		name := fmt.Sprintf("release/overflow/artifact-%04d", index)
		input.Artifacts[index] = LocatedArtifactRef{
			URI: "https://evidence.example/" + name,
			Artifact: ArtifactRef{
				Name:   name,
				Digest: NewDigest([]byte(name)),
			},
		}
	}
	if _, err := NewSignedReleaseEvidence(input); err == nil ||
		!strings.Contains(err.Error(), "4096") {
		t.Fatalf("oversized release inventory error = %v", err)
	}
}

func TestProductionDecisionRejectsWrongRoleWrongKeyAndChangedEvidence(t *testing.T) {
	fixture := newProductionDecisionFixture(t, DecisionGO)

	var coordinator ProductionDecisionSignature
	if err := UnmarshalCanonical(fixture.signatures[0], &coordinator); err != nil {
		t.Fatal(err)
	}
	coordinator.Role = DecisionSignerRelease
	wrongRole, err := MarshalCanonical(coordinator)
	if err != nil {
		t.Fatal(err)
	}
	signatures := append([][]byte(nil), fixture.signatures...)
	signatures[0] = wrongRole
	if _, err := VerifyProductionDecision(VerifyProductionDecisionOptions{
		Definition:     fixture.definition,
		DecisionBytes:  fixture.record,
		SignatureBytes: signatures,
		EvidenceRoot:   fixture.root,
	}); err == nil || !strings.Contains(err.Error(), "wrong identity") {
		t.Fatalf("wrong-role error = %v", err)
	}

	wrongKey, err := SignExact(
		fixture.record,
		fixture.definition.Coordinator.KeyID,
		adversarialPrivateKey(0x7e),
	)
	if err != nil {
		t.Fatal(err)
	}
	coordinator.Role = DecisionSignerCoordinator
	coordinator.Signature = wrongKey
	wrongKeyBytes, err := MarshalCanonical(coordinator)
	if err != nil {
		t.Fatal(err)
	}
	signatures[0] = wrongKeyBytes
	if _, err := VerifyProductionDecision(VerifyProductionDecisionOptions{
		Definition:     fixture.definition,
		DecisionBytes:  fixture.record,
		SignatureBytes: signatures,
		EvidenceRoot:   fixture.root,
	}); err == nil || !strings.Contains(err.Error(), "fingerprint mismatch") {
		t.Fatalf("wrong-key error = %v", err)
	}

	checklistPath := filepath.Join(fixture.root, fixture.decision.FormalChecklist.Artifact.Name)
	if err := os.WriteFile(checklistPath, []byte("# changed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyProductionDecision(VerifyProductionDecisionOptions{
		Definition:     fixture.definition,
		DecisionBytes:  fixture.record,
		SignatureBytes: fixture.signatures,
		EvidenceRoot:   fixture.root,
	}); err == nil || !strings.Contains(err.Error(), "changed or has the wrong digest") {
		t.Fatalf("changed-evidence error = %v", err)
	}
}

func TestProductionDecisionHashesTheExactReleaseTree(t *testing.T) {
	t.Run("changed proving key", func(t *testing.T) {
		fixture := newProductionDecisionFixture(t, DecisionGO)
		provingKeyPath := filepath.Join(
			fixture.root,
			"release",
			NativeProvingKeyFile,
		)
		if err := os.WriteFile(provingKeyPath, []byte("different proving key"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := VerifyProductionDecision(VerifyProductionDecisionOptions{
			Definition:     fixture.definition,
			DecisionBytes:  fixture.record,
			SignatureBytes: fixture.signatures,
			EvidenceRoot:   fixture.root,
		}); err == nil || !strings.Contains(err.Error(), "changed or has the wrong digest") {
			t.Fatalf("changed proving-key error = %v", err)
		}
	})

	t.Run("unpinned file", func(t *testing.T) {
		fixture := newProductionDecisionFixture(t, DecisionGO)
		if err := os.WriteFile(
			filepath.Join(fixture.root, "release", "unreviewed.txt"),
			[]byte("not in the signed inventory"),
			0o600,
		); err != nil {
			t.Fatal(err)
		}
		if _, err := VerifyProductionDecision(VerifyProductionDecisionOptions{
			Definition:     fixture.definition,
			DecisionBytes:  fixture.record,
			SignatureBytes: fixture.signatures,
			EvidenceRoot:   fixture.root,
		}); err == nil || !strings.Contains(err.Error(), "unpinned file") {
			t.Fatalf("unpinned release-file error = %v", err)
		}
	})
}

func TestProductionDecisionRequiresTwoDistinctExternalAuditSignoffs(t *testing.T) {
	fixture := newProductionDecisionFixture(t, DecisionGO)
	value := fixture.decision
	value.DecisionID = ""
	value.ExternalAudits[1].Auditor = value.ExternalAudits[0].Auditor
	if _, err := NewProductionDecision(value); err == nil ||
		!strings.Contains(err.Error(), "distinct auditor identity") {
		t.Fatalf("duplicate external auditor error = %v", err)
	}

	fixture = newProductionDecisionFixture(t, DecisionGO)
	secondReport := fixture.decision.ExternalAudits[1].Report
	if err := os.WriteFile(
		filepath.Join(fixture.root, secondReport.Artifact.Name),
		[]byte("changed second external audit report\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyProductionDecision(VerifyProductionDecisionOptions{
		Definition:     fixture.definition,
		DecisionBytes:  fixture.record,
		SignatureBytes: fixture.signatures,
		EvidenceRoot:   fixture.root,
	}); err == nil || !strings.Contains(err.Error(), "changed or has the wrong digest") {
		t.Fatalf("changed second external-audit report error = %v", err)
	}
}

func TestProductionDecisionRejectsResignedSemanticOperationalTamper(t *testing.T) {
	fixture := newProductionDecisionFixture(t, DecisionGO)
	releaseRoot := filepath.Join(fixture.root, "release")
	bundlePath := filepath.Join(releaseRoot, filepath.FromSlash(OperationalEvidenceBundleFile))
	bundleBytes, err := os.ReadFile(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	var bundle OperationalEvidenceBundle
	if err := UnmarshalCanonical(bundleBytes, &bundle); err != nil {
		t.Fatal(err)
	}

	handoffPair := bundle.Phase1.AcceptedHeads[0].OutboundHandoff
	handoffBytes, err := verifyArtifactBytes(releaseRoot, handoffPair.Record, maxSignedRecordBytes)
	if err != nil {
		t.Fatal(err)
	}
	var handoff TransferHandoff
	if err := UnmarshalCanonical(handoffBytes, &handoff); err != nil {
		t.Fatal(err)
	}
	handoff.SenderID, handoff.RecipientID = handoff.RecipientID, handoff.SenderID
	handoff.SenderKeyID, handoff.RecipientKeyID =
		handoff.RecipientKeyID, handoff.SenderKeyID
	rewriteSignedPair(
		t,
		releaseRoot,
		handoffPair,
		handoff,
		adversarialPrivateKey(0x11),
	)
	bundle.Phase1.AcceptedHeads[0].OutboundHandoff =
		refreshPair(t, releaseRoot, handoffPair)

	bundleBytes, bundleSignatureBytes, err := SignRecord(
		bundle,
		fixture.definition.Coordinator.KeyID,
		adversarialPrivateKey(0x01),
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bundlePath, bundleBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	bundleSignaturePath := filepath.Join(
		releaseRoot,
		filepath.FromSlash(OperationalEvidenceSignatureFile),
	)
	if err := os.WriteFile(bundleSignaturePath, bundleSignatureBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	transcriptPath := filepath.Join(releaseRoot, FinalTranscriptFile)
	transcriptBytes, err := os.ReadFile(transcriptPath)
	if err != nil {
		t.Fatal(err)
	}
	var transcript FinalTranscript
	if err := UnmarshalCanonical(transcriptBytes, &transcript); err != nil {
		t.Fatal(err)
	}
	transcript.OperationalEvidence = SignedArtifactRefs{
		Record: mustArtifactRef(t, releaseRoot, OperationalEvidenceBundleFile),
		Signature: mustArtifactRef(
			t,
			releaseRoot,
			OperationalEvidenceSignatureFile,
		),
	}
	transcript.TranscriptID = ""
	transcript, err = NewFinalTranscript(transcript)
	if err != nil {
		t.Fatal(err)
	}
	transcriptBytes, err = MarshalCanonical(transcript)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(transcriptPath, transcriptBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	manifestPath := filepath.Join(releaseRoot, "manifest.json")
	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest artifact.KeyManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.SetupTranscriptHash = NewDigest(transcriptBytes).Blake2b256
	manifestBytes, err = json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	manifestBytes = append(manifestBytes, '\n')
	if err := os.WriteFile(manifestPath, manifestBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	manifestSignature := hex.EncodeToString(
		ed25519.Sign(adversarialPrivateKey(0x02), manifestBytes),
	) + "\n"
	if err := os.WriteFile(
		filepath.Join(releaseRoot, "manifest.sig"),
		[]byte(manifestSignature),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	rewriteChecksumFileFromExistingNames(
		t,
		releaseRoot,
		filepath.Join(releaseRoot, ReleaseChecksumsFile),
	)

	decision := fixture.decision
	oldOperational := decision.OperationalEvidence
	oldManifest := decision.Release.Manifest
	decision.OperationalEvidence = SignedLocatedArtifact{
		Record:    refreshedLocated(t, fixture.root, oldOperational.Record),
		Signature: refreshedLocated(t, fixture.root, oldOperational.Signature),
	}
	decision.Release.Manifest = refreshedLocated(t, fixture.root, decision.Release.Manifest)
	decision.Release.ManifestSignature =
		refreshedLocated(t, fixture.root, decision.Release.ManifestSignature)
	decision.Release.FinalTranscript =
		refreshedLocated(t, fixture.root, decision.Release.FinalTranscript)
	decision.Release.Artifacts = locatedTree(t, fixture.root, "release")
	decision.Release.ReleaseID = ""
	decision.Release, err = NewSignedReleaseEvidence(decision.Release)
	if err != nil {
		t.Fatal(err)
	}
	for gateIndex := range decision.Gates {
		for evidenceIndex, evidence := range decision.Gates[gateIndex].Evidence {
			switch evidence {
			case oldOperational.Record:
				decision.Gates[gateIndex].Evidence[evidenceIndex] =
					decision.OperationalEvidence.Record
			case oldOperational.Signature:
				decision.Gates[gateIndex].Evidence[evidenceIndex] =
					decision.OperationalEvidence.Signature
			case oldManifest:
				decision.Gates[gateIndex].Evidence[evidenceIndex] =
					decision.Release.Manifest
			}
		}
	}
	decision.DecisionID = ""
	decision, err = NewProductionDecision(decision)
	if err != nil {
		t.Fatal(err)
	}
	decisionBytes, err := MarshalCanonical(decision)
	if err != nil {
		t.Fatal(err)
	}
	signatures := signDecisionFixture(t, fixture.definition, decisionBytes)
	if _, err := VerifyProductionDecision(VerifyProductionDecisionOptions{
		Definition:     fixture.definition,
		DecisionBytes:  decisionBytes,
		SignatureBytes: signatures,
		EvidenceRoot:   fixture.root,
	}); err == nil || !strings.Contains(err.Error(), "outbound") {
		t.Fatalf("re-signed semantic custody violation error = %v", err)
	}
}

func TestProductionDecisionCanonicalParserRejectsUnknownAndTrailingFields(t *testing.T) {
	fixture := newProductionDecisionFixture(t, DecisionNOGO)
	unknown := append([]byte(nil), fixture.record[:len(fixture.record)-1]...)
	unknown = append(unknown, []byte(`,"unknown":true}`)...)
	var decision ProductionDecision
	if err := UnmarshalCanonical(unknown, &decision); err == nil {
		t.Fatal("unknown production-decision field accepted")
	}
	if err := UnmarshalCanonical(append(append([]byte(nil), fixture.record...), '\n'), &decision); err == nil {
		t.Fatal("trailing production-decision bytes accepted")
	}

	var signature ProductionDecisionSignature
	if err := UnmarshalCanonical(fixture.signatures[0], &signature); err != nil {
		t.Fatal(err)
	}
	trailing := append(append([]byte(nil), fixture.signatures[0]...), '\n')
	if err := UnmarshalCanonical(trailing, &signature); err == nil {
		t.Fatal("trailing decision-signature bytes accepted")
	}
}

func TestProductionDecisionNOGOMayBeSignedByOneAuthorizedRole(t *testing.T) {
	fixture := newProductionDecisionFixture(t, DecisionNOGO)
	verified, err := VerifyProductionDecision(VerifyProductionDecisionOptions{
		Definition:     fixture.definition,
		DecisionBytes:  fixture.record,
		SignatureBytes: fixture.signatures[:1],
		EvidenceRoot:   fixture.root,
	})
	if err != nil {
		t.Fatalf("verify signed NO-GO: %v", err)
	}
	if verified.Decision.Decision != DecisionNOGO || len(verified.VerifiedSigners) != 1 {
		t.Fatalf("verified NO-GO = %#v", verified)
	}
}

func newProductionDecisionFixture(t *testing.T, outcome ProductionDecisionOutcome) productionDecisionFixture {
	t.Helper()
	operationalFixture := newOperationalBundleFixture(t)
	root := t.TempDir()
	copyRegularTree(t, operationalFixture.root, filepath.Join(root, "release"))
	definition := operationalFixture.definition
	definitionBytes, err := MarshalCanonical(definition)
	if err != nil {
		t.Fatal(err)
	}

	candidate := adversarialCandidate(t, definition)
	candidate.Schema = ""
	candidate.CandidateID = ""
	candidate.Definition = ArtifactRef{Name: "release/ceremony.json", Digest: NewDigest(definitionBytes)}
	candidate.Phase1 = operationalPhaseSummary(
		t,
		operationalFixture.root,
		operationalFixture.bundle.Phase1,
		candidate.Phase1,
	)
	candidate.Phase2 = operationalPhaseSummary(
		t,
		operationalFixture.root,
		operationalFixture.bundle.Phase2,
		candidate.Phase2,
	)
	candidate, err = NewCandidateMetadata(candidate)
	if err != nil {
		t.Fatal(err)
	}
	candidateBytes, candidateSignatureBytes, err := SignRecord(
		candidate,
		definition.Coordinator.KeyID,
		adversarialPrivateKey(0x01),
	)
	if err != nil {
		t.Fatal(err)
	}
	candidateLocated := writeLocated(t, root, "release/candidate.json", candidateBytes)
	candidateSignatureLocated := writeLocated(t, root, "release/candidate.sig.json", candidateSignatureBytes)
	for name, content := range map[string]string{
		candidate.ConstraintSystem.Name:    "r1cs",
		candidate.ProvingKey.Name:          "proving key",
		candidate.VerifyingKey.Name:        "verifying key",
		candidate.CardanoVerifyingKey.Name: "cardano vk",
		candidate.CardanoVKHex.Name:        "cardano vk hex",
		candidate.CardanoVKFormat.Name:     "cardano vk format",
		candidate.VerificationReport.Name:  "verification report",
		candidate.PublicEvidence.Name:      "public finalization evidence",
		candidate.Phase2SealRecord.Name:    "phase2 seal record",
		Phase2SealSignatureFile:            "phase2 seal signature",
	} {
		writeLocated(t, root, "release/"+name, []byte(content))
	}

	auditEvidence := make([]ProductionAuditEvidence, 2)
	auditRefs := make([]ArtifactRef, 2)
	replayRoot, err := replayRootSHA256(candidate)
	if err != nil {
		t.Fatal(err)
	}
	for index, auditor := range definition.Auditors[:2] {
		record, err := NewAuditRecord(AuditRecord{
			CeremonyID:       definition.CeremonyID,
			AuditorID:        auditor.ID,
			AuditorKeyID:     auditor.KeyID,
			Definition:       candidate.Definition,
			Phase1Chain:      candidate.Phase1.Chain,
			Phase2Chain:      candidate.Phase2.Chain,
			Phase1SealID:     candidate.Phase1.SealID,
			Phase2SealID:     candidate.Phase2.SealID,
			ReplayRootSHA256: replayRoot,
			Outputs: candidateAuditOutputs(candidate, ArtifactRef{
				Name: CandidateMetadataFile, Digest: candidateLocated.Artifact.Digest,
			}),
			Passed:    true,
			Findings:  []string{},
			AuditedAt: "2026-07-23T14:0" + string(rune('1'+index)) + ":00Z",
		})
		if err != nil {
			t.Fatal(err)
		}
		recordBytes, signatureBytes, err := SignRecord(
			record,
			auditor.KeyID,
			adversarialPrivateKey(byte(0x03+index)),
		)
		if err != nil {
			t.Fatal(err)
		}
		audit := SignedLocatedArtifact{
			Record: writeLocated(
				t,
				root,
				"release/audits/"+fmt.Sprintf("%04d.json", index+1),
				recordBytes,
			),
			Signature: writeLocated(
				t,
				root,
				"release/audits/"+fmt.Sprintf("%04d.sig", index+1),
				signatureBytes,
			),
		}
		auditEvidence[index] = ProductionAuditEvidence{
			AuditorID: auditor.ID, AuditorKeyID: auditor.KeyID, Audit: audit,
		}
		auditRefs[index] = ArtifactRef{
			Name:   strings.TrimPrefix(audit.Record.Artifact.Name, "release/"),
			Digest: audit.Record.Artifact.Digest,
		}
	}

	operational := SignedLocatedArtifact{
		Record: writeLocated(
			t,
			root,
			"release/"+OperationalEvidenceBundleFile,
			operationalFixture.bundleBytes,
		),
		Signature: writeLocated(
			t,
			root,
			"release/"+OperationalEvidenceSignatureFile,
			operationalFixture.signatureBytes,
		),
	}

	transcript, err := NewFinalTranscript(FinalTranscript{
		CeremonyID: definition.CeremonyID,
		Definition: candidate.Definition,
		Circuit:    definition.Circuit,
		Phase1:     candidate.Phase1,
		Phase2:     candidate.Phase2,
		Audits:     auditRefs,
		OperationalEvidence: SignedArtifactRefs{
			Record: ArtifactRef{
				Name:   strings.TrimPrefix(operational.Record.Artifact.Name, "release/"),
				Digest: operational.Record.Artifact.Digest,
			},
			Signature: ArtifactRef{
				Name:   strings.TrimPrefix(operational.Signature.Artifact.Name, "release/"),
				Digest: operational.Signature.Artifact.Digest,
			},
		},
		ProvingKey:          candidate.ProvingKey,
		VerifyingKey:        candidate.VerifyingKey,
		CardanoVerifyingKey: candidate.CardanoVerifyingKey,
		FinalizedAt:         "2026-07-23T15:00:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	transcriptBytes, err := MarshalCanonical(transcript)
	if err != nil {
		t.Fatal(err)
	}
	transcriptLocated := writeLocated(t, root, "release/"+FinalTranscriptFile, transcriptBytes)

	manifest := artifact.KeyManifest{
		Schema:               artifact.ManifestSchema,
		KeyVersion:           definition.Circuit.KeyVersion,
		CircuitID:            definition.Circuit.CircuitID,
		Curve:                definition.Circuit.Curve,
		Backend:              definition.Circuit.Backend,
		VKHash:               candidate.VerifyingKey.Digest.Blake2b256,
		ProvingKeySHA256:     candidate.ProvingKey.Digest.SHA256,
		ProvingKeyBlake2b256: candidate.ProvingKey.Digest.Blake2b256,
		ProvingKeySize:       candidate.ProvingKey.Digest.Size,
		VerifyingKeySHA256:   candidate.VerifyingKey.Digest.SHA256,
		VerifyingKeySize:     candidate.VerifyingKey.Digest.Size,
		ConstraintSystemHash: candidate.ConstraintSystem.Digest.Blake2b256,
		CircuitSourceCommit:  definition.Software.SourceCommit,
		ProofToolVersion:     definition.Software.ProofToolVersion,
		GnarkVersion:         definition.Software.GnarkVersion,
		SetupTranscriptHash:  NewDigest(transcriptBytes).Blake2b256,
		PublishedAt:          "2026-07-23T15:00:00Z",
		SignatureKeyID:       definition.ReleaseSigner.KeyID,
	}
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	manifestBytes = append(manifestBytes, '\n')
	releasePrivateKey := adversarialPrivateKey(0x02)
	manifestSignature := hex.EncodeToString(ed25519.Sign(releasePrivateKey, manifestBytes)) + "\n"
	manifestLocated := writeLocated(t, root, "release/manifest.json", manifestBytes)
	manifestSignatureLocated := writeLocated(t, root, "release/manifest.sig", []byte(manifestSignature))
	manifestPublicKeyLocated := writeLocated(
		t,
		root,
		"release/manifest-public-key.hex",
		[]byte(definition.ReleaseSigner.Ed25519PublicKeyHex+"\n"),
	)
	releaseRoot := filepath.Join(root, "release")
	transcriptTime, err := time.Parse(time.RFC3339Nano, transcript.FinalizedAt)
	if err != nil {
		t.Fatal(err)
	}
	verifiedOperational, err := verifyReleaseOperationalEvidence(
		definition,
		operationalFixture.coordinatorKey.Public().(ed25519.PublicKey),
		candidate,
		releaseRoot,
		filepath.Join(releaseRoot, filepath.FromSlash(OperationalEvidenceBundleFile)),
		filepath.Join(releaseRoot, filepath.FromSlash(OperationalEvidenceSignatureFile)),
		transcriptTime,
	)
	if err != nil {
		t.Fatalf("verify decision fixture operational evidence: %v", err)
	}
	if err := writeChecksumsNoReplace(
		releaseRoot,
		filepath.Join(releaseRoot, CandidateChecksumsFile),
		candidateChecksumNames(),
	); err != nil {
		t.Fatal(err)
	}
	if err := writeChecksumsNoReplace(
		releaseRoot,
		filepath.Join(releaseRoot, ReleaseChecksumsFile),
		releaseChecksumNames(2, verifiedOperational.Names),
	); err != nil {
		t.Fatal(err)
	}
	release, err := NewSignedReleaseEvidence(SignedReleaseEvidence{
		CandidateID:       candidate.CandidateID,
		Manifest:          manifestLocated,
		ManifestSignature: manifestSignatureLocated,
		ManifestPublicKey: manifestPublicKeyLocated,
		Candidate: SignedLocatedArtifact{
			Record: candidateLocated, Signature: candidateSignatureLocated,
		},
		FinalTranscript: transcriptLocated,
		Artifacts:       locatedTree(t, root, "release"),
	})
	if err != nil {
		t.Fatal(err)
	}

	external := adversarialIdentity(t, "external-auditor", 0x05)
	externalReportBytes := []byte("independent security audit report\n")
	externalReport := writeLocated(t, root, "external/security-audit.pdf", externalReportBytes)
	externalSignoff, err := SignExact(externalReportBytes, external.KeyID, adversarialPrivateKey(0x05))
	if err != nil {
		t.Fatal(err)
	}
	externalSignoffBytes, err := MarshalCanonical(externalSignoff)
	if err != nil {
		t.Fatal(err)
	}
	externalSignoffLocated := writeLocated(t, root, "external/security-audit.sig.json", externalSignoffBytes)
	rehearsal := writeLocated(t, root, "rehearsal/k21-evidence.tar.zst", []byte("exact K21 rehearsal evidence"))
	tagObject := writeLocated(t, root, "source/v1.0.0-mainnet.tag", []byte("signed annotated tag object"))
	deployment := writeLocated(t, root, "governance/mainnet-deployment-plan.md", []byte("# Mainnet deployment plan\n"))
	checklist := writeLocated(t, root, "governance/go-no-go-checklist.md", []byte("# Formal GO/NO-GO checklist\n"))

	gateEvidence := map[ProductionGate]LocatedArtifactRef{
		GateSignedRelease:          manifestLocated,
		GateOperationalEvidence:    operational.Record,
		GateIndependentAudits:      auditEvidence[0].Audit.Record,
		GateExternalAudit:          externalReport,
		GateK21Rehearsal:           rehearsal,
		GateMainnetDeploymentPlan:  deployment,
		GateFormalChecklist:        checklist,
		GateParticipantIndependent: checklist,
		GateParticipantHost:        checklist,
		GateParticipantEntropy:     checklist,
		GateParticipantErasure:     checklist,
		GatePublicWitnessing:       operational.Record,
		GateImmutableMirrors:       operational.Record,
		GateLiveTwentyParty:        checklist,
	}
	gates := make([]ProductionGateResult, len(requiredProductionGates))
	for index, gate := range requiredProductionGates {
		gates[index] = ProductionGateResult{
			Gate: gate, Status: GatePASS, Evidence: []LocatedArtifactRef{gateEvidence[gate]},
		}
	}
	if outcome == DecisionNOGO {
		gates[len(gates)-1].Status = GatePENDING
		gates[len(gates)-1].Rationale = "The live twenty-party production ceremony has not occurred."
	}
	decision, err := NewProductionDecision(ProductionDecision{
		CeremonyID: definition.CeremonyID,
		Release:    release,
		SourceRelease: SourceReleaseEvidence{
			SourceCommit:         definition.Software.SourceCommit,
			SignedTag:            "v1.0.0-mainnet",
			SignatureFormat:      "openpgp-primary-key-v4",
			SignerFingerprintHex: strings.Repeat("ab", 20),
			SignedTagObject:      tagObject,
		},
		OperationalEvidence: operational,
		Audits:              auditEvidence,
		ExternalAudits: []ExternalAuditEvidence{
			{Auditor: external, Report: externalReport, Signoff: externalSignoffLocated},
			{
				Auditor: adversarialIdentity(t, "external-auditor-b", 0x06),
				Report:  writeLocated(t, root, "external/security-audit-b.pdf", []byte("independent security audit report b\n")),
				Signoff: signedExternalAuditFixture(
					t, root, "external/security-audit-b.sig.json",
					[]byte("independent security audit report b\n"),
					adversarialIdentity(t, "external-auditor-b", 0x06),
					adversarialPrivateKey(0x06),
				),
			},
		},
		K21Rehearsal: K21RehearsalEvidence{
			KeyVersion:  definition.Circuit.KeyVersion,
			CircuitID:   definition.Circuit.CircuitID,
			Curve:       definition.Circuit.Curve,
			Backend:     definition.Circuit.Backend,
			Constraints: definition.Circuit.Constraints,
			DomainSize:  definition.Circuit.DomainSize,
			Evidence:    rehearsal,
		},
		MainnetDeploymentPlan: deployment,
		FormalChecklist:       checklist,
		Gates:                 gates,
		Decision:              outcome,
		DecidedAt:             "2026-07-23T16:00:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	recordBytes, err := MarshalCanonical(decision)
	if err != nil {
		t.Fatal(err)
	}
	signers := []struct {
		role DecisionSignerRole
		id   string
		key  byte
	}{
		{DecisionSignerCoordinator, definition.Coordinator.ID, 0x01},
		{DecisionSignerAuditor, definition.Auditors[0].ID, 0x03},
		{DecisionSignerAuditor, definition.Auditors[1].ID, 0x04},
		{DecisionSignerRelease, definition.ReleaseSigner.ID, 0x02},
	}
	signatures := make([][]byte, len(signers))
	for index, signer := range signers {
		signatures[index], err = SignProductionDecision(
			definition,
			recordBytes,
			signer.role,
			signer.id,
			adversarialPrivateKey(signer.key),
		)
		if err != nil {
			t.Fatal(err)
		}
	}
	return productionDecisionFixture{
		root: root, definition: definition, decision: decision, record: recordBytes, signatures: signatures,
	}
}

func operationalPhaseSummary(
	t *testing.T,
	root string,
	evidence PhaseOperationalEvidence,
	summary PhaseSummary,
) PhaseSummary {
	t.Helper()
	chainBytes, err := verifyArtifactBytes(root, evidence.AcceptedChain.Record, maxSignedRecordBytes)
	if err != nil {
		t.Fatal(err)
	}
	var chain Chain
	if err := UnmarshalCanonical(chainBytes, &chain); err != nil {
		t.Fatal(err)
	}
	closeBytes, err := verifyArtifactBytes(root, evidence.Close.Record, maxSignedRecordBytes)
	if err != nil {
		t.Fatal(err)
	}
	var closeRecord CloseRecord
	if err := UnmarshalCanonical(closeBytes, &closeRecord); err != nil {
		t.Fatal(err)
	}
	head, err := chain.HeadRecordID()
	if err != nil {
		t.Fatal(err)
	}
	participants, err := chain.ParticipantIDs()
	if err != nil {
		t.Fatal(err)
	}
	summary.Phase = chain.Phase
	summary.PhaseID = chain.PhaseID
	summary.Genesis = chain.Genesis
	summary.Chain = evidence.AcceptedChain.Record
	summary.ChainHeadID = head
	summary.ContributionCount = uint8(len(chain.Records))
	summary.Participants = participants
	summary.CloseID = closeRecord.CloseID
	return summary
}

func mustArtifactRef(t *testing.T, root, name string) ArtifactRef {
	t.Helper()
	ref, err := artifactRefForFile(name, filepath.Join(root, filepath.FromSlash(name)))
	if err != nil {
		t.Fatal(err)
	}
	return ref
}

func decisionScaleArtifact(name, content string) LocatedArtifactRef {
	return LocatedArtifactRef{
		URI: "https://evidence.example/" + name,
		Artifact: ArtifactRef{
			Name:   name,
			Digest: NewDigest([]byte(content)),
		},
	}
}

func refreshedLocated(
	t *testing.T,
	root string,
	located LocatedArtifactRef,
) LocatedArtifactRef {
	t.Helper()
	path, err := resolveArtifactPath(root, located.Artifact.Name)
	if err != nil {
		t.Fatal(err)
	}
	ref, err := artifactRefForFile(located.Artifact.Name, path)
	if err != nil {
		t.Fatal(err)
	}
	return LocatedArtifactRef{URI: located.URI, Artifact: ref}
}

func rewriteChecksumFileFromExistingNames(t *testing.T, root, checksumPath string) {
	t.Helper()
	raw, err := os.ReadFile(checksumPath)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
	names := make([]string, len(lines))
	for index, line := range lines {
		if len(line) < 67 || line[64:66] != "  " {
			t.Fatalf("invalid fixture checksum line %q", line)
		}
		names[index] = line[66:]
	}
	if err := os.Remove(checksumPath); err != nil {
		t.Fatal(err)
	}
	if err := writeChecksumsNoReplace(root, checksumPath, names); err != nil {
		t.Fatal(err)
	}
}

func signDecisionFixture(
	t *testing.T,
	definition CeremonyDefinition,
	record []byte,
) [][]byte {
	t.Helper()
	signers := []struct {
		role DecisionSignerRole
		id   string
		key  byte
	}{
		{DecisionSignerCoordinator, definition.Coordinator.ID, 0x01},
		{DecisionSignerAuditor, definition.Auditors[0].ID, 0x03},
		{DecisionSignerAuditor, definition.Auditors[1].ID, 0x04},
		{DecisionSignerRelease, definition.ReleaseSigner.ID, 0x02},
	}
	result := make([][]byte, len(signers))
	for index, signer := range signers {
		var err error
		result[index], err = SignProductionDecision(
			definition,
			record,
			signer.role,
			signer.id,
			adversarialPrivateKey(signer.key),
		)
		if err != nil {
			t.Fatal(err)
		}
	}
	return result
}

func writeLocated(t *testing.T, root, name string, data []byte) LocatedArtifactRef {
	t.Helper()
	target := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return LocatedArtifactRef{
		URI:      "https://evidence.example/" + name,
		Artifact: ArtifactRef{Name: name, Digest: NewDigest(data)},
	}
}

func locatedTree(t *testing.T, root, directory string) []LocatedArtifactRef {
	t.Helper()
	var result []LocatedArtifactRef
	err := filepath.WalkDir(filepath.Join(root, directory), func(file string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		name, err := filepath.Rel(root, file)
		if err != nil {
			return err
		}
		name = filepath.ToSlash(name)
		result = append(result, LocatedArtifactRef{
			URI:      "https://evidence.example/" + name,
			Artifact: ArtifactRef{Name: name, Digest: NewDigest(data)},
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	slices.SortFunc(result, func(a, b LocatedArtifactRef) int {
		return strings.Compare(a.Artifact.Name, b.Artifact.Name)
	})
	return result
}

func signedExternalAuditFixture(
	t *testing.T,
	root, name string,
	report []byte,
	auditor Identity,
	privateKey ed25519.PrivateKey,
) LocatedArtifactRef {
	t.Helper()
	signature, err := SignExact(report, auditor.KeyID, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	data, err := MarshalCanonical(signature)
	if err != nil {
		t.Fatal(err)
	}
	return writeLocated(t, root, name, data)
}

func productionDecisionDraft(decision ProductionDecision) ProductionDecisionDraft {
	return ProductionDecisionDraft{
		Schema:     ProductionDecisionDraftSchema,
		CeremonyID: decision.CeremonyID,
		Release: SignedReleaseEvidenceDraft{
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

func TestProductionDecisionGateOrderIsFixedAndGOFailCloses(t *testing.T) {
	fixture := newProductionDecisionFixture(t, DecisionGO)
	changed := fixture.decision
	changed.DecisionID = ""
	changed.Gates = slices.Clone(changed.Gates)
	changed.Gates[0], changed.Gates[1] = changed.Gates[1], changed.Gates[0]
	if _, err := NewProductionDecision(changed); err == nil || !strings.Contains(err.Error(), "gate 0") {
		t.Fatalf("reordered gate error = %v", err)
	}

	changed = fixture.decision
	changed.DecisionID = ""
	changed.Gates = slices.Clone(changed.Gates)
	changed.Gates[len(changed.Gates)-1].Status = GatePENDING
	changed.Gates[len(changed.Gates)-1].Rationale = "Live ceremony is pending."
	if _, err := NewProductionDecision(changed); err == nil || !strings.Contains(err.Error(), "every production gate") {
		t.Fatalf("GO with pending gate error = %v", err)
	}
}
