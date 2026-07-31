package mpcceremony

import (
	"testing"
)

func TestErasureAttestationBindsCompletedPostContributionDestruction(t *testing.T) {
	contribution := adversarialAttestation(t)
	erasure, err := NewErasureAttestation(ErasureAttestation{
		CeremonyID:                contribution.CeremonyID,
		Phase:                     contribution.Phase,
		PhaseID:                   contribution.PhaseID,
		Index:                     contribution.Index,
		ParticipantID:             contribution.ParticipantID,
		ParticipantKeyID:          contribution.ParticipantKeyID,
		ContributionAttestationID: contribution.AttestationID,
		OutputPayload:             contribution.OutputPayload,
		DestroyedAt:               "2026-07-23T12:00:01Z",
		ProcessTerminated:         true,
		EphemeralStorageDestroyed: true,
		NoBackupRetained:          true,
	})
	if err != nil {
		t.Fatalf("new erasure attestation: %v", err)
	}
	if err := ValidateErasureForContribution(contribution, erasure); err != nil {
		t.Fatalf("valid erasure rejected: %v", err)
	}

	notAfter := erasure
	notAfter.DestroyedAt = contribution.ContributedAt
	notAfter, err = NewErasureAttestation(notAfter)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateErasureForContribution(contribution, notAfter); err == nil {
		t.Fatal("erasure at contribution time unexpectedly accepted")
	}

	wrongOutput := erasure
	wrongOutput.OutputPayload = ArtifactRef{
		Name:   "phase1/another-output.bin",
		Digest: NewDigest([]byte("another output")),
	}
	wrongOutput, err = NewErasureAttestation(wrongOutput)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateErasureForContribution(contribution, wrongOutput); err == nil {
		t.Fatal("erasure for another output unexpectedly accepted")
	}
}

func TestErasureAttestationRequiresAllNarrowClaims(t *testing.T) {
	contribution := adversarialAttestation(t)
	base := ErasureAttestation{
		CeremonyID:                contribution.CeremonyID,
		Phase:                     contribution.Phase,
		PhaseID:                   contribution.PhaseID,
		Index:                     contribution.Index,
		ParticipantID:             contribution.ParticipantID,
		ParticipantKeyID:          contribution.ParticipantKeyID,
		ContributionAttestationID: contribution.AttestationID,
		OutputPayload:             contribution.OutputPayload,
		DestroyedAt:               "2026-07-23T12:01:00Z",
		ProcessTerminated:         true,
		EphemeralStorageDestroyed: true,
		NoBackupRetained:          true,
	}
	cases := []struct {
		name   string
		mutate func(*ErasureAttestation)
	}{
		{"process", func(a *ErasureAttestation) { a.ProcessTerminated = false }},
		{"storage", func(a *ErasureAttestation) { a.EphemeralStorageDestroyed = false }},
		{"backup", func(a *ErasureAttestation) { a.NoBackupRetained = false }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			candidate := base
			test.mutate(&candidate)
			if _, err := NewErasureAttestation(candidate); err == nil {
				t.Fatal("incomplete erasure claim unexpectedly accepted")
			}
		})
	}
}
