package mpcceremony

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestEnrollmentProofOfPossessionBindsFrozenDefinitionRosterRoleAndDisclosure(t *testing.T) {
	definition := adversarialDefinition(t)
	definitionBytes, err := MarshalCanonical(definition)
	if err != nil {
		t.Fatal(err)
	}
	rosterBytes, err := json.Marshal(definition.Roster)
	if err != nil {
		t.Fatal(err)
	}
	record := EnrollmentRecord{
		Schema:                 EnrollmentRecordSchema,
		CeremonyID:             definition.CeremonyID,
		Definition:             NewDigest(definitionBytes),
		FullRosterSHA256:       taggedSHA256(rosterBytes),
		Identity:               definition.Roster[0].Identity,
		Role:                   EnrollmentParticipant,
		RoleIndex:              1,
		IndependenceDisclosure: ArtifactRef{Name: "disclosures/participant-01.json", Digest: NewDigest([]byte("independent organization and host"))},
		EnrolledAt:             "2026-07-23T12:00:01Z",
	}
	canonical, err := MarshalCanonical(record)
	if err != nil {
		t.Fatal(err)
	}
	privateKey := adversarialPrivateKey(0x11)
	raw := ed25519.Sign(privateKey, canonical)
	signature, err := ImportOperationalSignature(canonical, record.Identity.KeyID, privateKey.Public().(ed25519.PublicKey), raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyExact(canonical, signature, record.Identity.KeyID, privateKey.Public().(ed25519.PublicKey)); err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseOperationalRecord(RecordEnrollment, canonical)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyOperationalRecordBinding(definition, definitionBytes, parsed); err != nil {
		t.Fatal(err)
	}

	tampered := record
	tampered.RoleIndex = 2
	if _, err := VerifyOperationalRecordBinding(definition, definitionBytes, &tampered); err == nil {
		t.Fatal("wrong roster index unexpectedly accepted")
	}
	tampered = record
	tampered.FullRosterSHA256 = taggedSHA256([]byte("partial roster"))
	if _, err := VerifyOperationalRecordBinding(definition, definitionBytes, &tampered); err == nil {
		t.Fatal("partial roster digest unexpectedly accepted")
	}
	if _, err := ImportOperationalSignature(canonical, record.Identity.KeyID, privateKey.Public().(ed25519.PublicKey), bytes.Repeat([]byte{0}, 64)); err == nil {
		t.Fatal("invalid offline signature unexpectedly imported")
	}
	nonCanonical := append([]byte(" "), canonical...)
	if _, err := ParseOperationalRecord(RecordEnrollment, nonCanonical); err == nil {
		t.Fatal("non-canonical signing bytes unexpectedly accepted")
	}
}

func TestExternalEnrollmentRejectsCeremonyActorOverlap(t *testing.T) {
	definition := adversarialDefinition(t)
	definitionBytes, err := MarshalCanonical(definition)
	if err != nil {
		t.Fatal(err)
	}
	rosterBytes, _ := json.Marshal(definition.Roster)
	record := EnrollmentRecord{
		Schema:                 EnrollmentRecordSchema,
		CeremonyID:             definition.CeremonyID,
		Definition:             NewDigest(definitionBytes),
		FullRosterSHA256:       taggedSHA256(rosterBytes),
		Identity:               definition.Coordinator,
		Role:                   EnrollmentPublicWitness,
		RoleIndex:              1,
		IndependenceDisclosure: ArtifactRef{Name: "disclosures/witness.json", Digest: NewDigest([]byte("not independent"))},
		EnrolledAt:             "2026-07-23T12:00:01Z",
	}
	if _, err := VerifyOperationalRecordBinding(definition, definitionBytes, &record); err == nil {
		t.Fatal("ceremony coordinator unexpectedly enrolled as independent public witness")
	}
}

func TestTransferReceiptBindsExactHandoffAndValidityWindow(t *testing.T) {
	definition := adversarialDefinition(t)
	source := TransferSourceBinding{
		SourceCommit: definition.Software.SourceCommit,
		ToolBinary:   definition.Software.ToolBinary,
		R1CS:         definition.Circuit.R1CS,
	}
	files := []ArtifactRef{
		{Name: "accepted/head-01.bin", Digest: NewDigest([]byte("accepted head"))},
	}
	handoff := TransferHandoff{
		Schema:            TransferHandoffSchema,
		CeremonyID:        definition.CeremonyID,
		Phase:             Phase1,
		Index:             1,
		PredecessorHeadID: "sha256:" + strings.Repeat("ab", 32),
		Source:            source,
		Files:             files,
		SenderID:          definition.Coordinator.ID,
		SenderKeyID:       definition.Coordinator.KeyID,
		RecipientID:       definition.Roster[0].Identity.ID,
		RecipientKeyID:    definition.Roster[0].Identity.KeyID,
		CreatedAt:         "2026-07-23T13:00:00Z",
		ExpiresAt:         "2026-07-23T15:00:00Z",
	}
	handoffBytes, err := MarshalCanonical(handoff)
	if err != nil {
		t.Fatal(err)
	}
	receipt := TransferReceipt{
		Schema:            TransferReceiptSchema,
		Kind:              ReceiptReceiver,
		HandoffSHA256:     taggedSHA256(handoffBytes),
		CeremonyID:        handoff.CeremonyID,
		Phase:             handoff.Phase,
		Index:             handoff.Index,
		PredecessorHeadID: handoff.PredecessorHeadID,
		Source:            handoff.Source,
		Files:             handoff.Files,
		SenderID:          handoff.SenderID,
		SenderKeyID:       handoff.SenderKeyID,
		RecipientID:       handoff.RecipientID,
		RecipientKeyID:    handoff.RecipientKeyID,
		SignerID:          handoff.RecipientID,
		SignerKeyID:       handoff.RecipientKeyID,
		ReceivedAt:        "2026-07-23T14:00:00Z",
	}
	if err := VerifyTransferReceipt(handoffBytes, handoff, receipt); err != nil {
		t.Fatal(err)
	}
	tampered := receipt
	tampered.Files = []ArtifactRef{{Name: files[0].Name, Digest: NewDigest([]byte("substitution"))}}
	if err := VerifyTransferReceipt(handoffBytes, handoff, tampered); err == nil {
		t.Fatal("file substitution unexpectedly accepted")
	}
	tampered = receipt
	tampered.ReceivedAt = handoff.CreatedAt
	if err := VerifyTransferReceipt(handoffBytes, handoff, tampered); err == nil {
		t.Fatal("receipt at handoff creation boundary unexpectedly accepted")
	}
	tampered = receipt
	tampered.ReceivedAt = "2026-07-23T15:00:01Z"
	if err := VerifyTransferReceipt(handoffBytes, handoff, tampered); err == nil {
		t.Fatal("expired receipt unexpectedly accepted")
	}
}

func TestPublicWitnessLeadBoundaryAndActorIndependence(t *testing.T) {
	definition := adversarialDefinition(t)
	round := uint64(40_000_000)
	roundTime, err := QuicknetRoundTime(round)
	if err != nil {
		t.Fatal(err)
	}
	close := operationalClose(t, definition, Phase1, round, roundTime.Add(-25*time.Hour))
	closeBytes, err := MarshalCanonical(close)
	if err != nil {
		t.Fatal(err)
	}
	witness := adversarialIdentity(t, "public-witness-01", 0x91)
	receipt := PublicWitnessReceipt{
		Schema:                 PublicWitnessReceiptSchema,
		CeremonyID:             definition.CeremonyID,
		Phase:                  Phase1,
		CloseID:                close.CloseID,
		ChainHeadID:            close.ChainHeadID,
		Closure:                ArtifactRef{Name: "phase1/closure.json", Digest: NewDigest(closeBytes)},
		BeaconRound:            round,
		BeaconScheduledAt:      roundTime.Format(time.RFC3339),
		PublicationLocationSHA: taggedSHA256([]byte("https://independent.example/phase1/closure.json")),
		Witness:                witness,
		ObservedAt:             roundTime.Add(-24 * time.Hour).Format(time.RFC3339),
	}
	if err := ValidatePublicWitnessReceipt(definition, close, closeBytes, receipt); err != nil {
		t.Fatalf("exact signed minimum lead rejected: %v", err)
	}
	tooLate := receipt
	tooLate.ObservedAt = roundTime.Add(-24*time.Hour + time.Second).Format(time.RFC3339)
	if err := ValidatePublicWitnessReceipt(definition, close, closeBytes, tooLate); err == nil {
		t.Fatal("below-minimum witness lead unexpectedly accepted")
	}
	overlap := receipt
	overlap.Witness = definition.Roster[0].Identity
	if err := ValidatePublicWitnessReceipt(definition, close, closeBytes, overlap); err == nil {
		t.Fatal("participant self-witness unexpectedly accepted")
	}
}

func TestPublicWitnessQuorumRejectsDuplicateIdentityAndKey(t *testing.T) {
	definition := adversarialDefinition(t)
	round := uint64(40_000_001)
	roundTime, _ := QuicknetRoundTime(round)
	close := operationalClose(t, definition, Phase1, round, roundTime.Add(-25*time.Hour))
	closeBytes, _ := MarshalCanonical(close)
	signed := func(id string, fill byte) SignedPublicWitness {
		privateKey := adversarialPrivateKey(fill)
		identity, err := NewIdentity(id, "Witness "+id, id+"-key", privateKey.Public().(ed25519.PublicKey))
		if err != nil {
			t.Fatal(err)
		}
		record := PublicWitnessReceipt{
			Schema:                 PublicWitnessReceiptSchema,
			CeremonyID:             definition.CeremonyID,
			Phase:                  Phase1,
			CloseID:                close.CloseID,
			ChainHeadID:            close.ChainHeadID,
			Closure:                ArtifactRef{Name: "phase1/closure.json", Digest: NewDigest(closeBytes)},
			BeaconRound:            round,
			BeaconScheduledAt:      roundTime.Format(time.RFC3339),
			PublicationLocationSHA: taggedSHA256([]byte(id)),
			Witness:                identity,
			ObservedAt:             roundTime.Add(-24 * time.Hour).Format(time.RFC3339),
		}
		recordBytes, signatureBytes, err := SignRecord(record, identity.KeyID, privateKey)
		if err != nil {
			t.Fatal(err)
		}
		return SignedPublicWitness{RecordBytes: recordBytes, SignatureBytes: signatureBytes, TrustedKey: privateKey.Public().(ed25519.PublicKey)}
	}
	first := signed("witness-01", 0xa1)
	second := signed("witness-02", 0xa2)
	if err := VerifyPublicWitnessQuorum(definition, close, closeBytes, []SignedPublicWitness{first, second}, 2); err != nil {
		t.Fatal(err)
	}
	if err := VerifyPublicWitnessQuorum(definition, close, closeBytes, []SignedPublicWitness{first, first}, 2); err == nil {
		t.Fatal("duplicate witness unexpectedly satisfied quorum")
	}
	wrongTrust := second
	wrongTrust.TrustedKey = first.TrustedKey
	if err := VerifyPublicWitnessQuorum(definition, close, closeBytes, []SignedPublicWitness{first, wrongTrust}, 2); err == nil {
		t.Fatal("witness identity/trust-key mismatch unexpectedly accepted")
	}
}

func TestMultiRelayEvidenceRequiresThreeOperatorsEndpointsAndMatchingRandomness(t *testing.T) {
	base := RelayObservation{
		RelayID:            "relay-01",
		OperatorID:         "drand",
		EndpointSHA256:     taggedSHA256([]byte("https://api.drand.sh")),
		RawResponse:        ArtifactRef{Name: "beacons/drand.json", Digest: NewDigest([]byte(quicknetRound42Response))},
		RetrievedAt:        "2026-07-23T12:00:00Z",
		VerifiedRandomness: "8ada64bae5c6c0f5540a6a13af56e663240edfbd2c76ac6a8f27671eb7259ce3",
	}
	second := base
	second.RelayID = "relay-02"
	second.OperatorID = "cloudflare"
	second.EndpointSHA256 = taggedSHA256([]byte("https://api.cloudflare.com"))
	second.RawResponse.Name = "beacons/cloudflare.json"
	third := base
	third.RelayID = "relay-03"
	third.OperatorID = "secureweb3"
	third.EndpointSHA256 = taggedSHA256([]byte("https://api.secureweb3.com"))
	third.RawResponse.Name = "beacons/secureweb3.json"
	evidence := MultiRelayBeaconEvidence{
		Schema:           MultiRelayBeaconEvidenceSchema,
		CeremonyID:       "sha256:" + strings.Repeat("11", 32),
		Phase:            Phase1,
		CloseID:          "sha256:" + strings.Repeat("12", 32),
		BeaconRound:      42,
		Provider:         BeaconProviderDrand,
		Network:          BeaconNetworkQuicknet,
		Observations:     []RelayObservation{base, second, third},
		CoordinatorID:    "coordinator",
		CoordinatorKeyID: "coordinator-key",
		RecordedAt:       "2026-07-23T12:00:01Z",
	}
	if err := evidence.Validate(); err != nil {
		t.Fatal(err)
	}
	onlyTwo := evidence
	onlyTwo.Observations = onlyTwo.Observations[:2]
	if err := onlyTwo.Validate(); err == nil {
		t.Fatal("two-relay evidence unexpectedly accepted")
	}
	duplicateOperator := evidence
	duplicateOperator.Observations = append([]RelayObservation(nil), evidence.Observations...)
	duplicateOperator.Observations[1].OperatorID = duplicateOperator.Observations[0].OperatorID
	if err := duplicateOperator.Validate(); err == nil {
		t.Fatal("same operator through different endpoint unexpectedly accepted")
	}
	mismatch := evidence
	mismatch.Observations = append([]RelayObservation(nil), evidence.Observations...)
	mismatch.Observations[2].VerifiedRandomness = strings.Repeat("00", 32)
	if err := mismatch.Validate(); err == nil {
		t.Fatal("relay randomness disagreement unexpectedly accepted")
	}
}

func TestGovernanceRestartRequiresDistinctNewCeremonyAndEvidence(t *testing.T) {
	record := GovernanceRecord{
		Schema:          GovernanceRecordSchema,
		Kind:            GovernanceRestart,
		CeremonyID:      "sha256:" + strings.Repeat("11", 32),
		Phase:           Phase1,
		Index:           1,
		HeadID:          "sha256:" + strings.Repeat("22", 32),
		Evidence:        []ArtifactRef{{Name: "incidents/evidence.json", Digest: NewDigest([]byte("evidence"))}},
		ReasonCode:      "host-integrity-failure",
		StatementSHA256: taggedSHA256([]byte("restart required")),
		NewCeremonyID:   "sha256:" + strings.Repeat("33", 32),
		SignerID:        "coordinator",
		SignerKeyID:     "coordinator-key",
		RecordedAt:      "2026-07-23T12:00:00Z",
	}
	if err := record.Validate(); err != nil {
		t.Fatal(err)
	}
	same := record
	same.NewCeremonyID = same.CeremonyID
	if err := same.Validate(); err == nil {
		t.Fatal("restart retaining old ceremony ID unexpectedly accepted")
	}
	incident := record
	incident.Kind = GovernanceIncident
	if err := incident.Validate(); err == nil {
		t.Fatal("non-restart record with new ceremony ID unexpectedly accepted")
	}
}

func operationalClose(
	t *testing.T,
	definition CeremonyDefinition,
	phase Phase,
	round uint64,
	closedAt time.Time,
) CloseRecord {
	t.Helper()
	roundTime, err := QuicknetRoundTime(round)
	if err != nil {
		t.Fatal(err)
	}
	record, err := NewCloseRecord(CloseRecord{
		CeremonyID:           definition.CeremonyID,
		Phase:                phase,
		PhaseID:              "sha256:" + strings.Repeat("44", 32),
		FinalIndex:           1,
		FinalPayload:         ArtifactRef{Name: string(phase) + "/final.bin", Digest: NewDigest([]byte("final"))},
		ChainHeadID:          "sha256:" + strings.Repeat("55", 32),
		AcceptedParticipants: []string{definition.Roster[0].Identity.ID},
		BeaconProvider:       BeaconProviderDrand,
		BeaconNetwork:        BeaconNetworkQuicknet,
		BeaconRound:          round,
		BeaconNotBefore:      roundTime.Format(time.RFC3339),
		ClosedAt:             closedAt.Format(time.RFC3339),
		CoordinatorID:        definition.Coordinator.ID,
		CoordinatorKeyID:     definition.Coordinator.KeyID,
	})
	if err != nil {
		t.Fatal(err)
	}
	return record
}
