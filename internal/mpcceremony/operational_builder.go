package mpcceremony

import (
	"encoding/json"
	"fmt"
)

// NewEnrollmentRecord derives the frozen definition and full-roster bindings;
// callers cannot substitute either digest.
func NewEnrollmentRecord(
	definition CeremonyDefinition,
	definitionBytes []byte,
	identity Identity,
	role EnrollmentRole,
	roleIndex uint16,
	disclosure ArtifactRef,
	enrolledAt string,
) (EnrollmentRecord, error) {
	rosterBytes, err := json.Marshal(definition.Roster)
	if err != nil {
		return EnrollmentRecord{}, err
	}
	record := EnrollmentRecord{
		Schema:                 EnrollmentRecordSchema,
		CeremonyID:             definition.CeremonyID,
		Definition:             NewDigest(definitionBytes),
		FullRosterSHA256:       taggedSHA256(rosterBytes),
		Identity:               identity,
		Role:                   role,
		RoleIndex:              roleIndex,
		IndependenceDisclosure: disclosure,
		EnrolledAt:             enrolledAt,
	}
	if err := record.Validate(); err != nil {
		return EnrollmentRecord{}, err
	}
	if err := verifyEnrollmentBinding(definition, definitionBytes, record); err != nil {
		return EnrollmentRecord{}, err
	}
	return record, nil
}

func NewTransferHandoff(
	definition CeremonyDefinition,
	phase Phase,
	index uint8,
	headID string,
	files []ArtifactRef,
	sender, recipient Identity,
	createdAt, expiresAt string,
) (TransferHandoff, error) {
	record := TransferHandoff{
		Schema:            TransferHandoffSchema,
		CeremonyID:        definition.CeremonyID,
		Phase:             phase,
		Index:             index,
		PredecessorHeadID: headID,
		Source: TransferSourceBinding{
			SourceCommit: definition.Software.SourceCommit,
			ToolBinary:   definition.Software.ToolBinary,
			R1CS:         definition.Circuit.R1CS,
		},
		Files:          append([]ArtifactRef(nil), files...),
		SenderID:       sender.ID,
		SenderKeyID:    sender.KeyID,
		RecipientID:    recipient.ID,
		RecipientKeyID: recipient.KeyID,
		CreatedAt:      createdAt,
		ExpiresAt:      expiresAt,
	}
	if err := record.Validate(); err != nil {
		return TransferHandoff{}, err
	}
	if err := verifyTransferSource(definition, record.Source); err != nil {
		return TransferHandoff{}, err
	}
	if err := verifyTransferParty(definition, record.SenderID, record.SenderKeyID); err != nil {
		return TransferHandoff{}, err
	}
	if err := verifyTransferParty(definition, record.RecipientID, record.RecipientKeyID); err != nil {
		return TransferHandoff{}, err
	}
	return record, nil
}

func NewTransferReceipt(
	handoff TransferHandoff,
	handoffBytes []byte,
	kind TransferReceiptKind,
	receivedAt string,
) (TransferReceipt, error) {
	signerID, signerKeyID := handoff.RecipientID, handoff.RecipientKeyID
	record := TransferReceipt{
		Schema:            TransferReceiptSchema,
		Kind:              kind,
		HandoffSHA256:     taggedSHA256(handoffBytes),
		CeremonyID:        handoff.CeremonyID,
		Phase:             handoff.Phase,
		Index:             handoff.Index,
		PredecessorHeadID: handoff.PredecessorHeadID,
		Source:            handoff.Source,
		Files:             append([]ArtifactRef(nil), handoff.Files...),
		SenderID:          handoff.SenderID,
		SenderKeyID:       handoff.SenderKeyID,
		RecipientID:       handoff.RecipientID,
		RecipientKeyID:    handoff.RecipientKeyID,
		SignerID:          signerID,
		SignerKeyID:       signerKeyID,
		ReceivedAt:        receivedAt,
	}
	if err := VerifyTransferReceipt(handoffBytes, handoff, record); err != nil {
		return TransferReceipt{}, err
	}
	return record, nil
}

func NewImmutableMirrorReceipt(
	ceremonyID string,
	phase Phase,
	index uint8,
	acceptedHeadID string,
	files []ArtifactRef,
	mirror Identity,
	locationSHA256, storedAt string,
) (ImmutableMirrorReceipt, error) {
	record := ImmutableMirrorReceipt{
		Schema:                ImmutableMirrorReceiptSchema,
		CeremonyID:            ceremonyID,
		Phase:                 phase,
		Index:                 index,
		AcceptedHeadID:        acceptedHeadID,
		Files:                 append([]ArtifactRef(nil), files...),
		Mirror:                mirror,
		StorageLocationSHA256: locationSHA256,
		StoredAt:              storedAt,
	}
	return record, record.Validate()
}

func NewPublicWitnessReceipt(
	definition CeremonyDefinition,
	close CloseRecord,
	closeBytes []byte,
	witness Identity,
	closureName, locationSHA256, observedAt string,
) (PublicWitnessReceipt, error) {
	roundTime, err := QuicknetRoundTime(close.BeaconRound)
	if err != nil {
		return PublicWitnessReceipt{}, err
	}
	record := PublicWitnessReceipt{
		Schema:                 PublicWitnessReceiptSchema,
		CeremonyID:             definition.CeremonyID,
		Phase:                  close.Phase,
		CloseID:                close.CloseID,
		ChainHeadID:            close.ChainHeadID,
		Closure:                ArtifactRef{Name: closureName, Digest: NewDigest(closeBytes)},
		BeaconRound:            close.BeaconRound,
		BeaconScheduledAt:      roundTime.Format("2006-01-02T15:04:05Z"),
		PublicationLocationSHA: locationSHA256,
		Witness:                witness,
		ObservedAt:             observedAt,
	}
	if err := ValidatePublicWitnessReceipt(definition, close, closeBytes, record); err != nil {
		return PublicWitnessReceipt{}, err
	}
	return record, nil
}

func NewMultiRelayBeaconEvidence(
	definition CeremonyDefinition,
	close CloseRecord,
	observations []RelayObservation,
	rawResponses map[string][]byte,
	recordedAt string,
) (MultiRelayBeaconEvidence, error) {
	record := MultiRelayBeaconEvidence{
		Schema:           MultiRelayBeaconEvidenceSchema,
		CeremonyID:       definition.CeremonyID,
		Phase:            close.Phase,
		CloseID:          close.CloseID,
		BeaconRound:      close.BeaconRound,
		Provider:         definition.BeaconPolicy.Provider,
		Network:          definition.BeaconPolicy.Network,
		Observations:     append([]RelayObservation(nil), observations...),
		CoordinatorID:    definition.Coordinator.ID,
		CoordinatorKeyID: definition.Coordinator.KeyID,
		RecordedAt:       recordedAt,
	}
	if err := ValidateMultiRelayBeaconEvidence(definition, close, record, rawResponses); err != nil {
		return MultiRelayBeaconEvidence{}, fmt.Errorf("multi-relay evidence: %w", err)
	}
	return record, nil
}
