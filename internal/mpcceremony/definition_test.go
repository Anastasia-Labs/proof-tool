package mpcceremony

import "testing"

func TestProductionDefinitionRequiresMultipleParticipantsInBothPhases(t *testing.T) {
	valid := adversarialDefinition(t)

	oneParticipant := valid
	oneParticipant.CeremonyID = ""
	oneParticipant.Roster = append([]Participant(nil), valid.Roster[:1]...)
	oneParticipant.Phase1Policy = PhasePolicy{
		Participants: []string{valid.Roster[0].Identity.ID},
		Minimum:      1,
	}
	oneParticipant.Phase2Policy = oneParticipant.Phase1Policy
	if _, err := FinalizeCeremonyDefinition(oneParticipant); err == nil {
		t.Fatal("single-participant production ceremony unexpectedly accepted")
	}

	lowMinimum := valid
	lowMinimum.CeremonyID = ""
	lowMinimum.Phase1Policy = clonePhasePolicy(valid.Phase1Policy)
	lowMinimum.Phase1Policy.Minimum = 1
	if _, err := FinalizeCeremonyDefinition(lowMinimum); err == nil {
		t.Fatal("production phase1 minimum 1 unexpectedly accepted")
	}
	lowMinimum = valid
	lowMinimum.CeremonyID = ""
	lowMinimum.Phase2Policy = clonePhasePolicy(valid.Phase2Policy)
	lowMinimum.Phase2Policy.Minimum = 1
	if _, err := FinalizeCeremonyDefinition(lowMinimum); err == nil {
		t.Fatal("production phase2 minimum 1 unexpectedly accepted")
	}

	partialThreshold := valid
	partialThreshold.CeremonyID = ""
	partialThreshold.Phase1Policy = clonePhasePolicy(valid.Phase1Policy)
	partialThreshold.Phase1Policy.Minimum = uint8(len(partialThreshold.Phase1Policy.Participants) - 1)
	if _, err := FinalizeCeremonyDefinition(partialThreshold); err == nil {
		t.Fatal("production minimum below the complete scheduled roster unexpectedly accepted")
	}
}

func TestRehearsalDefinitionMayUseOneParticipant(t *testing.T) {
	valid := adversarialDefinition(t)
	rehearsal := valid
	rehearsal.CeremonyID = ""
	rehearsal.Mode = ModeRehearsal
	rehearsal.Roster = append([]Participant(nil), valid.Roster[:1]...)
	rehearsal.Phase1Policy = PhasePolicy{
		Participants: []string{valid.Roster[0].Identity.ID},
		Minimum:      1,
	}
	rehearsal.Phase2Policy = rehearsal.Phase1Policy
	if _, err := FinalizeCeremonyDefinition(rehearsal); err != nil {
		t.Fatalf("single-participant rehearsal rejected: %v", err)
	}
}

func TestDefinitionRequiresUniquePublicKeysAcrossAllRoles(t *testing.T) {
	reusePublicKey := func(destination *Identity, source Identity) {
		destination.Ed25519PublicKeyHex = source.Ed25519PublicKeyHex
		destination.PublicKeyFingerprint = source.PublicKeyFingerprint
	}

	tests := []struct {
		name   string
		mutate func(*CeremonyDefinition)
	}{
		{
			name: "release signer and coordinator",
			mutate: func(definition *CeremonyDefinition) {
				reusePublicKey(&definition.ReleaseSigner, definition.Coordinator)
			},
		},
		{
			name: "auditor and coordinator",
			mutate: func(definition *CeremonyDefinition) {
				reusePublicKey(&definition.Auditors[0], definition.Coordinator)
			},
		},
		{
			name: "two auditors",
			mutate: func(definition *CeremonyDefinition) {
				reusePublicKey(&definition.Auditors[1], definition.Auditors[0])
			},
		},
		{
			name: "participant and coordinator",
			mutate: func(definition *CeremonyDefinition) {
				reusePublicKey(&definition.Roster[0].Identity, definition.Coordinator)
			},
		},
		{
			name: "participant and release signer",
			mutate: func(definition *CeremonyDefinition) {
				reusePublicKey(&definition.Roster[0].Identity, definition.ReleaseSigner)
			},
		},
		{
			name: "participant and auditor",
			mutate: func(definition *CeremonyDefinition) {
				reusePublicKey(&definition.Roster[0].Identity, definition.Auditors[0])
			},
		},
		{
			name: "two participants",
			mutate: func(definition *CeremonyDefinition) {
				reusePublicKey(&definition.Roster[1].Identity, definition.Roster[0].Identity)
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			definition := adversarialDefinition(t)
			definition.CeremonyID = ""
			test.mutate(&definition)
			if _, err := FinalizeCeremonyDefinition(definition); err == nil {
				t.Fatal("definition with reused Ed25519 public key unexpectedly accepted")
			}
		})
	}
}
