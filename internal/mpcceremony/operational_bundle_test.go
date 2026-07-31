package mpcceremony

import (
	"crypto/ed25519"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

const quicknetRound43OperationalResponse = `{"round":43,"randomness":"c8f7c61c7024f8b45ffbf5be58b1f112a26be93c26f5461af9f8522233705dbb","signature":"a96a579010b3d2261959104b29b5b46685b3a6b6f6aae7304ef72d44fe7d44e667bcdd500935d7deb58a2b4d89419ea6"}`

type operationalBundleFixture struct {
	root           string
	definition     CeremonyDefinition
	coordinatorKey ed25519.PrivateKey
	bundle         OperationalEvidenceBundle
	bundleBytes    []byte
	signatureBytes []byte
	phase1Close    AuthenticatedCloseEvidence
	phase2Close    AuthenticatedCloseEvidence
	witnessKeys    map[string]ed25519.PrivateKey
}

func TestVerifyOperationalEvidenceBundleEndToEndAndNegatives(t *testing.T) {
	fixture := newOperationalBundleFixture(t)
	verify := func(f operationalBundleFixture) error {
		_, err := VerifyOperationalEvidenceBundle(VerifyOperationalEvidenceOptions{
			Definition:           f.definition,
			CoordinatorPublicKey: f.coordinatorKey.Public().(ed25519.PublicKey),
			EvidenceRoot:         f.root,
			BundleBytes:          f.bundleBytes,
			BundleSignatureBytes: f.signatureBytes,
			Phase1Close:          f.phase1Close,
			Phase2Close:          f.phase2Close,
		})
		return err
	}
	if err := verify(fixture); err != nil {
		t.Fatalf("complete operational bundle rejected: %v", err)
	}

	t.Run("missing enrollment", func(t *testing.T) {
		f := newOperationalBundleFixture(t)
		f.bundle.Enrollments = f.bundle.Enrollments[1:]
		resignBundle(t, &f)
		if err := verify(f); err == nil {
			t.Fatal("missing required proof-of-possession enrollment unexpectedly accepted")
		}
	})
	t.Run("missing independence disclosure", func(t *testing.T) {
		f := newOperationalBundleFixture(t)
		recordBytes, err := verifyArtifactBytes(f.root, f.bundle.Enrollments[0].Record, maxSignedRecordBytes)
		if err != nil {
			t.Fatal(err)
		}
		var enrollment EnrollmentRecord
		if err := UnmarshalCanonical(recordBytes, &enrollment); err != nil {
			t.Fatal(err)
		}
		path, err := resolveArtifactPath(f.root, enrollment.IndependenceDisclosure.Name)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		if err := verify(f); err == nil {
			t.Fatal("missing independence disclosure unexpectedly accepted")
		}
	})
	t.Run("tampered contribution verification", func(t *testing.T) {
		f := newOperationalBundleFixture(t)
		chainBytes, err := verifyArtifactBytes(f.root, f.bundle.Phase1.AcceptedChain.Record, maxSignedRecordBytes)
		if err != nil {
			t.Fatal(err)
		}
		var chain Chain
		if err := UnmarshalCanonical(chainBytes, &chain); err != nil {
			t.Fatal(err)
		}
		path, err := resolveArtifactPath(f.root, chain.Records[0].Verification.Name)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		raw[len(raw)-1] ^= 1
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := verify(f); err == nil {
			t.Fatal("tampered contribution verification unexpectedly accepted")
		}
	})
	t.Run("incomplete mirror evidence", func(t *testing.T) {
		f := newOperationalBundleFixture(t)
		f.bundle.Phase1.AcceptedHeads[0].MirrorReceipts =
			f.bundle.Phase1.AcceptedHeads[0].MirrorReceipts[:1]
		resignInvalidBundle(t, &f)
		if err := verify(f); err == nil {
			t.Fatal("accepted head with one mirror unexpectedly accepted")
		}
	})
	t.Run("swapped outbound custody direction", func(t *testing.T) {
		f := newOperationalBundleFixture(t)
		head := &f.bundle.Phase1.AcceptedHeads[0]
		raw, err := verifyArtifactBytes(f.root, head.OutboundHandoff.Record, maxSignedRecordBytes)
		if err != nil {
			t.Fatal(err)
		}
		var handoff TransferHandoff
		if err := UnmarshalCanonical(raw, &handoff); err != nil {
			t.Fatal(err)
		}
		handoff.SenderID, handoff.RecipientID = handoff.RecipientID, handoff.SenderID
		handoff.SenderKeyID, handoff.RecipientKeyID = handoff.RecipientKeyID, handoff.SenderKeyID
		rewriteSignedPair(t, f.root, head.OutboundHandoff, handoff, adversarialPrivateKey(0x11))
		head.OutboundHandoff = refreshPair(t, f.root, head.OutboundHandoff)
		resignBundle(t, &f)
		if err := verify(f); err == nil {
			t.Fatal("participant-to-coordinator outbound direction unexpectedly accepted")
		}
	})
	t.Run("return handoff uses future accepted id", func(t *testing.T) {
		f := newOperationalBundleFixture(t)
		head := &f.bundle.Phase1.AcceptedHeads[0]
		raw, err := verifyArtifactBytes(f.root, head.ReturnHandoff.Record, maxSignedRecordBytes)
		if err != nil {
			t.Fatal(err)
		}
		var handoff TransferHandoff
		if err := UnmarshalCanonical(raw, &handoff); err != nil {
			t.Fatal(err)
		}
		handoff.PredecessorHeadID = head.AcceptedHeadID
		rewriteSignedPair(t, f.root, head.ReturnHandoff, handoff, adversarialPrivateKey(0x11))
		head.ReturnHandoff = refreshPair(t, f.root, head.ReturnHandoff)
		resignBundle(t, &f)
		if err := verify(f); err == nil {
			t.Fatal("return handoff with future accepted record ID unexpectedly accepted")
		}
	})
	t.Run("tampered accepted chain prefix", func(t *testing.T) {
		f := newOperationalBundleFixture(t)
		ref := f.bundle.Phase1.AcceptedHeads[0].AcceptedChainPrefix.Record
		path, err := resolveArtifactPath(f.root, ref.Name)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		raw[len(raw)-1] ^= 1
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := verify(f); err == nil {
			t.Fatal("tampered accepted chain prefix unexpectedly accepted")
		}
	})
	t.Run("mirror omits accepted chain prefix", func(t *testing.T) {
		f := newOperationalBundleFixture(t)
		head := &f.bundle.Phase1.AcceptedHeads[0]
		raw, err := verifyArtifactBytes(f.root, head.MirrorReceipts[0].Record, maxSignedRecordBytes)
		if err != nil {
			t.Fatal(err)
		}
		var mirror ImmutableMirrorReceipt
		if err := UnmarshalCanonical(raw, &mirror); err != nil {
			t.Fatal(err)
		}
		filtered := mirror.Files[:0]
		for _, ref := range mirror.Files {
			if ref != head.AcceptedChainPrefix.Record && ref != head.AcceptedChainPrefix.Signature {
				filtered = append(filtered, ref)
			}
		}
		mirror.Files = filtered
		rewriteSignedPair(t, f.root, head.MirrorReceipts[0], mirror, adversarialPrivateKey(0xa1))
		head.MirrorReceipts[0] = refreshPair(t, f.root, head.MirrorReceipts[0])
		resignBundle(t, &f)
		if err := verify(f); err == nil {
			t.Fatal("mirror omitting authenticated chain prefix unexpectedly accepted")
		}
	})
	t.Run("tampered accepted output payload", func(t *testing.T) {
		f := newOperationalBundleFixture(t)
		chainBytes, err := verifyArtifactBytes(f.root, f.bundle.Phase1.AcceptedChain.Record, maxSignedRecordBytes)
		if err != nil {
			t.Fatal(err)
		}
		var chain Chain
		if err := UnmarshalCanonical(chainBytes, &chain); err != nil {
			t.Fatal(err)
		}
		path, err := resolveArtifactPath(f.root, chain.Records[0].OutputPayload.Name)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("tampered output payload"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := verify(f); err == nil {
			t.Fatal("tampered accepted output payload unexpectedly accepted")
		}
	})
	t.Run("actor overlap witness", func(t *testing.T) {
		f := newOperationalBundleFixture(t)
		pair := f.bundle.Phase1.PublicWitnessReceipts[0]
		var receipt PublicWitnessReceipt
		recordBytes, err := verifyArtifactBytes(f.root, pair.Record, maxSignedRecordBytes)
		if err != nil {
			t.Fatal(err)
		}
		if err := UnmarshalCanonical(recordBytes, &receipt); err != nil {
			t.Fatal(err)
		}
		receipt.Witness = f.definition.Roster[0].Identity
		privateKey := adversarialPrivateKey(0x11)
		rewriteSignedPair(t, f.root, pair, receipt, privateKey)
		f.bundle.Phase1.PublicWitnessReceipts[0] = refreshPair(t, f.root, pair)
		resignBundle(t, &f)
		if err := verify(f); err == nil {
			t.Fatal("participant self-witness unexpectedly accepted")
		}
	})
	t.Run("less than three relay operators", func(t *testing.T) {
		f := newOperationalBundleFixture(t)
		pair := f.bundle.Phase1.MultiRelayBeaconEvidence
		var evidence MultiRelayBeaconEvidence
		recordBytes, err := verifyArtifactBytes(f.root, pair.Record, maxSignedRecordBytes)
		if err != nil {
			t.Fatal(err)
		}
		if err := UnmarshalCanonical(recordBytes, &evidence); err != nil {
			t.Fatal(err)
		}
		evidence.Observations = evidence.Observations[:2]
		rewriteInvalidSignedPair(t, f.root, pair, evidence, f.coordinatorKey, f.definition.Coordinator.KeyID)
		f.bundle.Phase1.MultiRelayBeaconEvidence = refreshPair(t, f.root, pair)
		f.bundle.Phase1.RawBeaconResponses = f.bundle.Phase1.RawBeaconResponses[:2]
		resignBundle(t, &f)
		if err := verify(f); err == nil {
			t.Fatal("two-operator relay evidence unexpectedly accepted")
		}
	})
	t.Run("reused phase rounds", func(t *testing.T) {
		f := newOperationalBundleFixture(t)
		phase1Round := f.phase1Close.Record.BeaconRound
		close2 := f.phase2Close.Record
		close2.BeaconRound = phase1Round
		reusedRoundTime, err := QuicknetRoundTime(phase1Round)
		if err != nil {
			t.Fatal(err)
		}
		close2.BeaconNotBefore = reusedRoundTime.Format(time.RFC3339)
		close2, err = NewCloseRecord(close2)
		if err != nil {
			t.Fatal(err)
		}
		recordBytes, signatureBytes, err := SignRecord(close2, f.definition.Coordinator.KeyID, f.coordinatorKey)
		if err != nil {
			t.Fatal(err)
		}
		f.phase2Close = AuthenticatedCloseEvidence{Record: close2, RecordBytes: recordBytes, SignatureBytes: signatureBytes}
		f.bundle.Phase2.Close.Record.Digest = NewDigest(recordBytes)
		f.bundle.Phase2.Close.Signature.Digest = NewDigest(signatureBytes)
		resignBundle(t, &f)
		if err := verify(f); err == nil {
			t.Fatal("phase round reuse unexpectedly accepted")
		}
	})
	t.Run("too late witness", func(t *testing.T) {
		f := newOperationalBundleFixture(t)
		pair := f.bundle.Phase1.PublicWitnessReceipts[0]
		var receipt PublicWitnessReceipt
		recordBytes, err := verifyArtifactBytes(f.root, pair.Record, maxSignedRecordBytes)
		if err != nil {
			t.Fatal(err)
		}
		if err := UnmarshalCanonical(recordBytes, &receipt); err != nil {
			t.Fatal(err)
		}
		roundTime, _ := QuicknetRoundTime(receipt.BeaconRound)
		receipt.ObservedAt = roundTime.Add(-24*time.Hour + time.Second).Format(time.RFC3339)
		rewriteSignedPair(t, f.root, pair, receipt, f.witnessKeys[receipt.Witness.ID])
		f.bundle.Phase1.PublicWitnessReceipts[0] = refreshPair(t, f.root, pair)
		resignBundle(t, &f)
		if err := verify(f); err == nil {
			t.Fatal("too-late witness unexpectedly accepted")
		}
	})
	t.Run("receipt equal to handoff time", func(t *testing.T) {
		f := newOperationalBundleFixture(t)
		head := &f.bundle.Phase1.AcceptedHeads[0]
		handoffBytes, err := verifyArtifactBytes(f.root, head.OutboundHandoff.Record, maxSignedRecordBytes)
		if err != nil {
			t.Fatal(err)
		}
		var handoff TransferHandoff
		if err := UnmarshalCanonical(handoffBytes, &handoff); err != nil {
			t.Fatal(err)
		}
		receiptBytes, err := verifyArtifactBytes(f.root, head.OutboundReceipt.Record, maxSignedRecordBytes)
		if err != nil {
			t.Fatal(err)
		}
		var receipt TransferReceipt
		if err := UnmarshalCanonical(receiptBytes, &receipt); err != nil {
			t.Fatal(err)
		}
		receipt.ReceivedAt = handoff.CreatedAt
		rewriteSignedPair(t, f.root, head.OutboundReceipt, receipt, adversarialPrivateKey(0x11))
		head.OutboundReceipt = refreshPair(t, f.root, head.OutboundReceipt)
		resignBundle(t, &f)
		if err := verify(f); err == nil {
			t.Fatal("receipt at exact handoff creation time unexpectedly accepted")
		}
	})
	t.Run("mirror equal to acceptance time", func(t *testing.T) {
		f := newOperationalBundleFixture(t)
		head := &f.bundle.Phase1.AcceptedHeads[0]
		chainBytes, err := verifyArtifactBytes(f.root, f.bundle.Phase1.AcceptedChain.Record, maxSignedRecordBytes)
		if err != nil {
			t.Fatal(err)
		}
		var chain Chain
		if err := UnmarshalCanonical(chainBytes, &chain); err != nil {
			t.Fatal(err)
		}
		mirrorBytes, err := verifyArtifactBytes(f.root, head.MirrorReceipts[0].Record, maxSignedRecordBytes)
		if err != nil {
			t.Fatal(err)
		}
		var mirror ImmutableMirrorReceipt
		if err := UnmarshalCanonical(mirrorBytes, &mirror); err != nil {
			t.Fatal(err)
		}
		mirror.StoredAt = chain.Records[0].AcceptedAt
		rewriteSignedPair(t, f.root, head.MirrorReceipts[0], mirror, adversarialPrivateKey(0xa1))
		head.MirrorReceipts[0] = refreshPair(t, f.root, head.MirrorReceipts[0])
		resignBundle(t, &f)
		if err := verify(f); err == nil {
			t.Fatal("mirror at exact acceptance time unexpectedly accepted")
		}
	})
	t.Run("assembled at latest evidence boundary", func(t *testing.T) {
		f := newOperationalBundleFixture(t)
		evidenceBytes, err := verifyArtifactBytes(
			f.root,
			f.bundle.Phase2.MultiRelayBeaconEvidence.Record,
			maxSignedRecordBytes,
		)
		if err != nil {
			t.Fatal(err)
		}
		var evidence MultiRelayBeaconEvidence
		if err := UnmarshalCanonical(evidenceBytes, &evidence); err != nil {
			t.Fatal(err)
		}
		f.bundle.AssembledAt = evidence.RecordedAt
		resignBundle(t, &f)
		if err := verify(f); err == nil {
			t.Fatal("bundle assembled at exact latest evidence time unexpectedly accepted")
		}
	})
	t.Run("chain tamper", func(t *testing.T) {
		f := newOperationalBundleFixture(t)
		path, err := resolveArtifactPath(f.root, f.bundle.Phase1.AcceptedChain.Record.Name)
		if err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		data[len(data)-1] ^= 1
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := verify(f); err == nil {
			t.Fatal("tampered accepted chain unexpectedly accepted")
		}
	})
}

func newOperationalBundleFixture(t *testing.T) operationalBundleFixture {
	t.Helper()
	definition := adversarialDefinition(t)
	round42Time, _ := QuicknetRoundTime(42)
	definition.Mode = ModeRehearsal
	definition.CreatedAt = round42Time.Add(-30 * time.Hour).Format(time.RFC3339)
	definition.Circuit.Constraints = 1_789_750
	definition.Circuit.DomainSize = 1 << 21
	definition.Phase1Policy.Minimum = 1
	definition.Phase2Policy.Minimum = 1
	var err error
	definition, err = FinalizeCeremonyDefinition(definition)
	if err != nil {
		t.Fatal(err)
	}
	definitionBytes, _ := MarshalCanonical(definition)
	root := t.TempDir()
	coordinatorKey := adversarialPrivateKey(0x01)
	witnesses := []struct {
		identity Identity
		key      ed25519.PrivateKey
	}{
		{adversarialIdentity(t, "public-witness-01", 0x91), adversarialPrivateKey(0x91)},
		{adversarialIdentity(t, "public-witness-02", 0x92), adversarialPrivateKey(0x92)},
	}
	mirrors := []struct {
		identity Identity
		key      ed25519.PrivateKey
	}{
		{adversarialIdentity(t, "mirror-operator-01", 0xa1), adversarialPrivateKey(0xa1)},
		{adversarialIdentity(t, "mirror-operator-02", 0xa2), adversarialPrivateKey(0xa2)},
	}

	type enrollmentInput struct {
		identity Identity
		role     EnrollmentRole
		index    uint16
		key      ed25519.PrivateKey
	}
	inputs := []enrollmentInput{
		{definition.Coordinator, EnrollmentCoordinator, 1, coordinatorKey},
		{definition.ReleaseSigner, EnrollmentReleaseSigner, 1, adversarialPrivateKey(0x02)},
		{definition.Auditors[0], EnrollmentAuditor, 1, adversarialPrivateKey(0x03)},
		{definition.Auditors[1], EnrollmentAuditor, 2, adversarialPrivateKey(0x04)},
	}
	for index, participant := range definition.Roster {
		inputs = append(inputs, enrollmentInput{
			participant.Identity,
			EnrollmentParticipant,
			uint16(index + 1),
			adversarialPrivateKey(byte(0x11 + index)),
		})
	}
	for index, witness := range witnesses {
		inputs = append(inputs, enrollmentInput{witness.identity, EnrollmentPublicWitness, uint16(index + 1), witness.key})
	}
	for index, mirror := range mirrors {
		inputs = append(inputs, enrollmentInput{mirror.identity, EnrollmentMirrorOperator, uint16(index + 1), mirror.key})
	}
	slices.SortFunc(inputs, func(a, b enrollmentInput) int {
		return strings.Compare(a.identity.ID, b.identity.ID)
	})
	enrollments := make([]SignedArtifactRefs, 0, len(inputs))
	for _, input := range inputs {
		disclosureData := []byte("independence disclosure " + input.identity.ID)
		disclosureName := "disclosures/" + input.identity.ID + ".json"
		writeFixtureFile(t, root, disclosureName, disclosureData)
		record, err := NewEnrollmentRecord(
			definition,
			definitionBytes,
			input.identity,
			input.role,
			input.index,
			ArtifactRef{
				Name:   disclosureName,
				Digest: NewDigest(disclosureData),
			},
			round42Time.Add(-29*time.Hour).Format(time.RFC3339),
		)
		if err != nil {
			t.Fatal(err)
		}
		enrollments = append(enrollments, writeSignedFixturePair(
			t,
			root,
			"enrollments/"+input.identity.ID,
			record,
			input.identity.KeyID,
			input.key,
		))
	}

	phase1, close1 := buildOperationalPhaseFixture(
		t, root, definition, Phase1, 42, quicknetRound42Response,
		coordinatorKey, witnesses, mirrors,
	)
	phase2, close2 := buildOperationalPhaseFixture(
		t, root, definition, Phase2, 43, quicknetRound43OperationalResponse,
		coordinatorKey, witnesses, mirrors,
	)
	bundle := OperationalEvidenceBundle{
		Schema:           OperationalEvidenceBundleSchema,
		CeremonyID:       definition.CeremonyID,
		Enrollments:      enrollments,
		Phase1:           phase1,
		Phase2:           phase2,
		CoordinatorID:    definition.Coordinator.ID,
		CoordinatorKeyID: definition.Coordinator.KeyID,
		AssembledAt:      round42Time.Add(time.Hour).Format(time.RFC3339),
	}
	bundleBytes, signatureBytes, err := SignRecord(bundle, definition.Coordinator.KeyID, coordinatorKey)
	if err != nil {
		t.Fatal(err)
	}
	witnessKeys := make(map[string]ed25519.PrivateKey, len(witnesses))
	for _, witness := range witnesses {
		witnessKeys[witness.identity.ID] = witness.key
	}
	return operationalBundleFixture{
		root:           root,
		definition:     definition,
		coordinatorKey: coordinatorKey,
		bundle:         bundle,
		bundleBytes:    bundleBytes,
		signatureBytes: signatureBytes,
		phase1Close:    close1,
		phase2Close:    close2,
		witnessKeys:    witnessKeys,
	}
}

func buildOperationalPhaseFixture(
	t *testing.T,
	root string,
	definition CeremonyDefinition,
	phase Phase,
	round uint64,
	rawResponse string,
	coordinatorKey ed25519.PrivateKey,
	witnesses, mirrors []struct {
		identity Identity
		key      ed25519.PrivateKey
	},
) (PhaseOperationalEvidence, AuthenticatedCloseEvidence) {
	t.Helper()
	roundTime, _ := QuicknetRoundTime(round)
	genesis := definition.Phase1Genesis
	phaseID := "sha256:" + strings.Repeat("77", 32)
	if phase == Phase1 {
		var err error
		phaseID, err = ComputePhaseID(definition.CeremonyID, Phase1, genesis, "")
		if err != nil {
			t.Fatal(err)
		}
	} else {
		genesis = ArtifactRef{Name: "phase2/genesis.bin", Digest: NewDigest([]byte("phase2 genesis"))}
	}
	genesisBytes := []byte(string(phase) + " genesis")
	writeFixtureFile(t, root, genesis.Name, genesisBytes)
	chain, err := NewChain(definition.CeremonyID, phase, phaseID, genesis)
	if err != nil {
		t.Fatal(err)
	}
	previousID, _ := GenesisRecordID(definition.CeremonyID, phaseID, genesis)
	outputBytes := []byte(string(phase) + " accepted output")
	outputPayload := ArtifactRef{
		Name:   string(phase) + "/accepted-01.bin",
		Digest: NewDigest(outputBytes),
	}
	writeFixtureFile(t, root, outputPayload.Name, outputBytes)
	attestation, err := NewContributionAttestation(ContributionAttestation{
		CeremonyID:           definition.CeremonyID,
		Phase:                phase,
		PhaseID:              phaseID,
		Index:                1,
		ParticipantID:        definition.Roster[0].Identity.ID,
		ParticipantKeyID:     definition.Roster[0].Identity.KeyID,
		PreviousPayload:      genesis,
		OutputPayload:        outputPayload,
		PreviousAcceptanceID: previousID,
		ToolBinary:           definition.Software.ToolBinary,
		SourceCommit:         definition.Software.SourceCommit,
		GnarkVersion:         GnarkVersion,
		GnarkCryptoVersion:   GnarkCryptoVersion,
		DrandVersion:         DrandVersion,
		Environment: ContributionEnvironment{
			OS:                           "linux",
			Architecture:                 "amd64",
			EntropySource:                "operating-system-csprng",
			SwapDisabled:                 true,
			CrashDumpsDisabled:           true,
			TelemetryDisabled:            true,
			EphemeralEnvironment:         true,
			EphemeralDestructionRequired: true,
		},
		ContributedAt: roundTime.Add(-27 * time.Hour).Format(time.RFC3339),
	})
	if err != nil {
		t.Fatal(err)
	}
	attestationPair := writeSignedFixturePair(
		t, root, string(phase)+"/attestation", attestation,
		definition.Roster[0].Identity.KeyID, adversarialPrivateKey(0x11),
	)
	erasure, err := NewErasureAttestation(ErasureAttestation{
		CeremonyID:                definition.CeremonyID,
		Phase:                     phase,
		PhaseID:                   phaseID,
		Index:                     1,
		ParticipantID:             definition.Roster[0].Identity.ID,
		ParticipantKeyID:          definition.Roster[0].Identity.KeyID,
		ContributionAttestationID: attestation.AttestationID,
		OutputPayload:             outputPayload,
		DestroyedAt:               roundTime.Add(-26*time.Hour - 30*time.Minute).Format(time.RFC3339),
		ProcessTerminated:         true,
		EphemeralStorageDestroyed: true,
		NoBackupRetained:          true,
	})
	if err != nil {
		t.Fatal(err)
	}
	erasurePair := writeSignedFixturePair(
		t, root, string(phase)+"/erasure", erasure,
		definition.Roster[0].Identity.KeyID, adversarialPrivateKey(0x11),
	)
	verification := ContributionVerification{
		Schema:           verificationSchema,
		VerificationMode: directTransitionVerification,
		CeremonyID:       definition.CeremonyID,
		Phase:            phase,
		PhaseID:          phaseID,
		Index:            1,
		ParticipantID:    definition.Roster[0].Identity.ID,
		PreviousPayload:  genesis,
		OutputPayload:    outputPayload,
		AttestationID:    attestation.AttestationID,
		ErasureID:        erasure.ErasureID,
		PreviousRecordID: previousID,
		CoordinatorID:    definition.Coordinator.ID,
		CoordinatorKeyID: definition.Coordinator.KeyID,
		Passed:           true,
		VerifiedAt:       roundTime.Add(-26 * time.Hour).Format(time.RFC3339),
	}
	verificationBytes, err := MarshalCanonical(verification)
	if err != nil {
		t.Fatal(err)
	}
	verificationName := string(phase) + "/verification.json"
	writeFixtureFile(t, root, verificationName, verificationBytes)
	record, err := NewChainRecord(ChainRecord{
		CeremonyID:           definition.CeremonyID,
		Phase:                phase,
		PhaseID:              phaseID,
		Index:                1,
		ParticipantID:        definition.Roster[0].Identity.ID,
		PreviousPayload:      genesis,
		OutputPayload:        outputPayload,
		AttestationID:        attestation.AttestationID,
		Attestation:          attestationPair.Record,
		AttestationSignature: attestationPair.Signature,
		ErasureID:            erasure.ErasureID,
		Erasure:              erasurePair.Record,
		ErasureSignature:     erasurePair.Signature,
		Verification: ArtifactRef{
			Name:   verificationName,
			Digest: NewDigest(verificationBytes),
		},
		PreviousRecordID: previousID,
		CoordinatorID:    definition.Coordinator.ID,
		CoordinatorKeyID: definition.Coordinator.KeyID,
		AcceptedAt:       roundTime.Add(-26 * time.Hour).Format(time.RFC3339),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := chain.Append(record); err != nil {
		t.Fatal(err)
	}
	chainPair := writeSignedFixturePair(
		t, root, string(phase)+"/chain", chain,
		definition.Coordinator.KeyID, coordinatorKey,
	)
	prefixPair := writeSignedFixturePair(
		t, root, string(phase)+"/heads/0001/accepted-chain", chain,
		definition.Coordinator.KeyID, coordinatorKey,
	)
	close, err := NewCloseRecord(CloseRecord{
		CeremonyID:           definition.CeremonyID,
		Phase:                phase,
		PhaseID:              phaseID,
		FinalIndex:           1,
		FinalPayload:         record.OutputPayload,
		ChainHeadID:          record.RecordID,
		AcceptedParticipants: []string{definition.Roster[0].Identity.ID},
		BeaconProvider:       BeaconProviderDrand,
		BeaconNetwork:        BeaconNetworkQuicknet,
		BeaconRound:          round,
		BeaconNotBefore:      roundTime.Format(time.RFC3339),
		ClosedAt:             roundTime.Add(-25 * time.Hour).Format(time.RFC3339),
		CoordinatorID:        definition.Coordinator.ID,
		CoordinatorKeyID:     definition.Coordinator.KeyID,
	})
	if err != nil {
		t.Fatal(err)
	}
	closeBytes, closeSignature, err := SignRecord(close, definition.Coordinator.KeyID, coordinatorKey)
	if err != nil {
		t.Fatal(err)
	}
	closePair := writeExactFixturePair(t, root, string(phase)+"/close", closeBytes, closeSignature)

	handoff, err := NewTransferHandoff(
		definition, phase, 1, record.PreviousRecordID,
		[]ArtifactRef{record.PreviousPayload},
		definition.Coordinator, definition.Roster[0].Identity,
		roundTime.Add(-29*time.Hour).Format(time.RFC3339),
		roundTime.Add(-27*time.Hour-30*time.Minute).Format(time.RFC3339),
	)
	if err != nil {
		t.Fatal(err)
	}
	handoffBytes, _ := MarshalCanonical(handoff)
	handoffPair := writeSignedFixturePair(
		t, root, string(phase)+"/heads/0001/handoff", handoff,
		definition.Coordinator.KeyID, coordinatorKey,
	)
	receiver, err := NewTransferReceipt(
		handoff, handoffBytes, ReceiptReceiver,
		roundTime.Add(-28*time.Hour).Format(time.RFC3339),
	)
	if err != nil {
		t.Fatal(err)
	}
	receiverPair := writeSignedFixturePair(
		t, root, string(phase)+"/heads/0001/receiver", receiver,
		definition.Roster[0].Identity.KeyID, adversarialPrivateKey(0x11),
	)
	returnFiles := []ArtifactRef{
		record.Attestation,
		record.AttestationSignature,
		record.Erasure,
		record.ErasureSignature,
		record.OutputPayload,
	}
	slices.SortFunc(returnFiles, compareArtifactRefName)
	returnHandoff, err := NewTransferHandoff(
		definition, phase, 1, record.PreviousRecordID,
		returnFiles,
		definition.Roster[0].Identity, definition.Coordinator,
		roundTime.Add(-26*time.Hour-20*time.Minute).Format(time.RFC3339),
		roundTime.Add(-26*time.Hour-5*time.Minute).Format(time.RFC3339),
	)
	if err != nil {
		t.Fatal(err)
	}
	returnHandoffBytes, _ := MarshalCanonical(returnHandoff)
	returnHandoffPair := writeSignedFixturePair(
		t, root, string(phase)+"/heads/0001/return-handoff", returnHandoff,
		definition.Roster[0].Identity.KeyID, adversarialPrivateKey(0x11),
	)
	returnReceipt, err := NewTransferReceipt(
		returnHandoff, returnHandoffBytes, ReceiptReceiver,
		roundTime.Add(-26*time.Hour-10*time.Minute).Format(time.RFC3339),
	)
	if err != nil {
		t.Fatal(err)
	}
	returnPair := writeSignedFixturePair(
		t, root, string(phase)+"/heads/0001/return", returnReceipt,
		definition.Coordinator.KeyID, coordinatorKey,
	)
	mirrorPairs := make([]SignedArtifactRefs, len(mirrors))
	mirrorFiles := append([]ArtifactRef(nil), returnFiles...)
	mirrorFiles = append(
		mirrorFiles,
		record.Verification,
		prefixPair.Record,
		prefixPair.Signature,
	)
	slices.SortFunc(mirrorFiles, compareArtifactRefName)
	for index, mirror := range mirrors {
		mirrorReceipt := ImmutableMirrorReceipt{
			Schema:                ImmutableMirrorReceiptSchema,
			CeremonyID:            definition.CeremonyID,
			Phase:                 phase,
			Index:                 1,
			AcceptedHeadID:        record.RecordID,
			Files:                 mirrorFiles,
			Mirror:                mirror.identity,
			StorageLocationSHA256: taggedSHA256([]byte("immutable://" + mirror.identity.ID)),
			StoredAt:              roundTime.Add(-25*time.Hour - 50*time.Minute).Format(time.RFC3339),
		}
		if err := mirrorReceipt.Validate(); err != nil {
			t.Fatal(err)
		}
		mirrorPairs[index] = writeSignedFixturePair(
			t, root,
			string(phase)+"/heads/0001/mirrors/"+mirror.identity.ID,
			mirrorReceipt, mirror.identity.KeyID, mirror.key,
		)
	}
	witnessPairs := make([]SignedArtifactRefs, len(witnesses))
	for index, witness := range witnesses {
		receipt, err := NewPublicWitnessReceipt(
			definition,
			close,
			closeBytes,
			witness.identity,
			closePair.Record.Name,
			taggedSHA256([]byte("https://public.example/"+string(phase)+"/"+witness.identity.ID)),
			roundTime.Add(-24*time.Hour).Format(time.RFC3339),
		)
		if err != nil {
			t.Fatal(err)
		}
		witnessPairs[index] = writeSignedFixturePair(
			t, root, string(phase)+"/witnesses/"+witness.identity.ID,
			receipt, witness.identity.KeyID, witness.key,
		)
	}
	rawBytes := []byte(rawResponse)
	randomness, err := VerifyDrandBeaconResponse(definition.BeaconPolicy, round, rawBytes)
	if err != nil {
		t.Fatal(err)
	}
	operatorIDs := []string{"cloudflare", "drand", "secureweb3"}
	rawRefs := make([]ArtifactRef, len(operatorIDs))
	observations := make([]RelayObservation, len(operatorIDs))
	rawMap := make(map[string][]byte, len(operatorIDs))
	for index, operatorID := range operatorIDs {
		name := string(phase) + "/beacon/raw/" + operatorID + ".json"
		writeFixtureFile(t, root, name, rawBytes)
		rawRefs[index] = ArtifactRef{Name: name, Digest: NewDigest(rawBytes)}
		relayID := "relay-" + operatorID
		observations[index] = RelayObservation{
			RelayID:            relayID,
			OperatorID:         operatorID,
			EndpointSHA256:     taggedSHA256([]byte("https://" + operatorID + ".example/beacon")),
			RawResponse:        rawRefs[index],
			RetrievedAt:        roundTime.Format(time.RFC3339),
			VerifiedRandomness: randomness,
		}
		rawMap[relayID] = rawBytes
	}
	slices.SortFunc(observations, func(a, b RelayObservation) int {
		return strings.Compare(a.RelayID, b.RelayID)
	})
	evidence, err := NewMultiRelayBeaconEvidence(
		definition, close, observations, rawMap,
		roundTime.Add(time.Second).Format(time.RFC3339),
	)
	if err != nil {
		t.Fatal(err)
	}
	beaconPair := writeSignedFixturePair(
		t, root, string(phase)+"/beacon/evidence", evidence,
		definition.Coordinator.KeyID, coordinatorKey,
	)
	return PhaseOperationalEvidence{
			Phase:         phase,
			AcceptedChain: chainPair,
			Close:         closePair,
			AcceptedHeads: []AcceptedHeadOperationalEvidence{{
				Index:               1,
				PredecessorHeadID:   record.PreviousRecordID,
				AcceptedHeadID:      record.RecordID,
				OutboundHandoff:     handoffPair,
				OutboundReceipt:     receiverPair,
				ReturnHandoff:       returnHandoffPair,
				ReturnReceipt:       returnPair,
				AcceptedChainPrefix: prefixPair,
				MirrorReceipts:      mirrorPairs,
			}},
			PublicWitnessQuorum:      2,
			PublicWitnessReceipts:    witnessPairs,
			MultiRelayBeaconEvidence: beaconPair,
			RawBeaconResponses:       rawRefs,
		}, AuthenticatedCloseEvidence{
			Record:         close,
			RecordBytes:    closeBytes,
			SignatureBytes: closeSignature,
		}
}

func writeSignedFixturePair(
	t *testing.T,
	root, stem string,
	record any,
	keyID string,
	key ed25519.PrivateKey,
) SignedArtifactRefs {
	t.Helper()
	recordBytes, signatureBytes, err := SignRecord(record, keyID, key)
	if err != nil {
		t.Fatal(err)
	}
	return writeExactFixturePair(t, root, stem, recordBytes, signatureBytes)
}

func writeExactFixturePair(t *testing.T, root, stem string, recordBytes, signatureBytes []byte) SignedArtifactRefs {
	t.Helper()
	recordName, signatureName := stem+".json", stem+".sig"
	writeFixtureFile(t, root, recordName, recordBytes)
	writeFixtureFile(t, root, signatureName, signatureBytes)
	return SignedArtifactRefs{
		Record:    ArtifactRef{Name: recordName, Digest: NewDigest(recordBytes)},
		Signature: ArtifactRef{Name: signatureName, Digest: NewDigest(signatureBytes)},
	}
}

func writeFixtureFile(t *testing.T, root, name string, data []byte) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func rewriteSignedPair(t *testing.T, root string, pair SignedArtifactRefs, record any, key ed25519.PrivateKey) {
	t.Helper()
	recordBytes, signatureBytes, err := SignRecord(record, keyIDForOperationalRecord(record), key)
	if err != nil {
		t.Fatal(err)
	}
	writeFixtureFile(t, root, pair.Record.Name, recordBytes)
	writeFixtureFile(t, root, pair.Signature.Name, signatureBytes)
}

func rewriteInvalidSignedPair(
	t *testing.T,
	root string,
	pair SignedArtifactRefs,
	record any,
	key ed25519.PrivateKey,
	keyID string,
) {
	t.Helper()
	recordBytes, err := jsonMarshalForNegative(record)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := SignExact(recordBytes, keyID, key)
	if err != nil {
		t.Fatal(err)
	}
	signatureBytes, err := MarshalCanonical(signature)
	if err != nil {
		t.Fatal(err)
	}
	writeFixtureFile(t, root, pair.Record.Name, recordBytes)
	writeFixtureFile(t, root, pair.Signature.Name, signatureBytes)
}

func refreshPair(t *testing.T, root string, pair SignedArtifactRefs) SignedArtifactRefs {
	t.Helper()
	record, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(pair.Record.Name)))
	if err != nil {
		t.Fatal(err)
	}
	signature, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(pair.Signature.Name)))
	if err != nil {
		t.Fatal(err)
	}
	pair.Record.Digest = NewDigest(record)
	pair.Signature.Digest = NewDigest(signature)
	return pair
}

func resignBundle(t *testing.T, fixture *operationalBundleFixture) {
	t.Helper()
	var err error
	fixture.bundleBytes, fixture.signatureBytes, err = SignRecord(
		fixture.bundle,
		fixture.definition.Coordinator.KeyID,
		fixture.coordinatorKey,
	)
	if err != nil {
		t.Fatal(err)
	}
}

func resignInvalidBundle(t *testing.T, fixture *operationalBundleFixture) {
	t.Helper()
	var err error
	fixture.bundleBytes, err = jsonMarshalForNegative(fixture.bundle)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := SignExact(
		fixture.bundleBytes,
		fixture.definition.Coordinator.KeyID,
		fixture.coordinatorKey,
	)
	if err != nil {
		t.Fatal(err)
	}
	fixture.signatureBytes, err = MarshalCanonical(signature)
	if err != nil {
		t.Fatal(err)
	}
}

func jsonMarshalForNegative(value any) ([]byte, error) {
	return json.Marshal(value)
}

func keyIDForOperationalRecord(record any) string {
	switch r := record.(type) {
	case PublicWitnessReceipt:
		return r.Witness.KeyID
	case TransferReceipt:
		return r.SignerKeyID
	case ImmutableMirrorReceipt:
		return r.Mirror.KeyID
	case TransferHandoff:
		return r.SenderKeyID
	case MultiRelayBeaconEvidence:
		return r.CoordinatorKeyID
	case EnrollmentRecord:
		return r.Identity.KeyID
	default:
		return ""
	}
}
