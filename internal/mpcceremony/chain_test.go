package mpcceremony

import (
	"bytes"
	"encoding/hex"
	"strings"
	"testing"
	"time"
)

func TestDeriveBeaconChallengeIsExactAndDomainBound(t *testing.T) {
	closeID := "sha256:" + strings.Repeat("11", 32)
	randomness := bytes.Repeat([]byte{0x42}, 32)

	challenge, err := DeriveBeaconChallenge(closeID, BeaconProviderDrand, BeaconNetworkQuicknet, 1234, randomness)
	if err != nil {
		t.Fatalf("derive challenge: %v", err)
	}
	if len(challenge) != 32 {
		t.Fatalf("challenge length = %d, want 32", len(challenge))
	}
	if got := hex.EncodeToString(challenge); got != "85b20a01a58bec4cffd9e10f6c94df3c056fcfa391f8ea30ec4888cb5c5cd49f" {
		t.Fatalf("challenge vector = %s", got)
	}
	again, err := DeriveBeaconChallenge(closeID, BeaconProviderDrand, BeaconNetworkQuicknet, 1234, randomness)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(challenge, again) {
		t.Fatal("same beacon tuple produced different challenges")
	}

	cases := []struct {
		name       string
		closeID    string
		provider   string
		network    string
		round      uint64
		randomness []byte
	}{
		{"close", "sha256:" + strings.Repeat("12", 32), BeaconProviderDrand, BeaconNetworkQuicknet, 1234, randomness},
		{"round", closeID, BeaconProviderDrand, BeaconNetworkQuicknet, 1235, randomness},
		{"randomness", closeID, BeaconProviderDrand, BeaconNetworkQuicknet, 1234, bytes.Repeat([]byte{0x43}, 32)},
	}
	if _, err := DeriveBeaconChallenge(closeID, "other", BeaconNetworkQuicknet, 1234, randomness); err == nil {
		t.Fatal("unsupported beacon provider unexpectedly accepted")
	}
	if _, err := DeriveBeaconChallenge(closeID, BeaconProviderDrand, "other", 1234, randomness); err == nil {
		t.Fatal("unsupported beacon network unexpectedly accepted")
	}
	if _, err := DeriveBeaconChallenge(
		closeID,
		BeaconProviderDrand,
		BeaconNetworkQuicknet,
		1234,
		append(bytes.Clone(randomness), 0),
	); err == nil {
		t.Fatal("non-32-byte quicknet randomness unexpectedly accepted")
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			changed, err := DeriveBeaconChallenge(
				test.closeID,
				test.provider,
				test.network,
				test.round,
				test.randomness,
			)
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Equal(challenge, changed) {
				t.Fatal("changed beacon tuple retained the same challenge")
			}
		})
	}
}

func TestNewBeaconRecordOwnsChallengeDerivation(t *testing.T) {
	randomness := bytes.Repeat([]byte{0x51}, 32)
	base := BeaconRecord{
		CeremonyID:  "sha256:" + strings.Repeat("21", 32),
		Phase:       Phase1,
		PhaseID:     "sha256:" + strings.Repeat("22", 32),
		CloseID:     "sha256:" + strings.Repeat("23", 32),
		Provider:    BeaconProviderDrand,
		Network:     BeaconNetworkQuicknet,
		Round:       9876,
		PublishedAt: "2026-07-23T13:00:00Z",
		RawResponse: ArtifactRef{
			Name:   "beacons/phase1-response.json",
			Digest: NewDigest([]byte("authenticated beacon response")),
		},
		RandomnessHex: hex.EncodeToString(randomness),
	}
	record, err := NewBeaconRecord(base)
	if err != nil {
		t.Fatalf("new beacon record: %v", err)
	}
	expected, err := DeriveBeaconChallenge(
		base.CloseID,
		base.Provider,
		base.Network,
		base.Round,
		randomness,
	)
	if err != nil {
		t.Fatal(err)
	}
	if record.ChallengeHex != hex.EncodeToString(expected) {
		t.Fatalf("challenge_hex = %q, want deterministic derivation", record.ChallengeHex)
	}
	if record.ChallengeSHA256 != taggedSHA256(expected) {
		t.Fatal("challenge_sha256 does not bind derived challenge")
	}
	if err := record.Validate(); err != nil {
		t.Fatalf("derived record rejected: %v", err)
	}

	arbitrary := base
	arbitrary.ChallengeHex = strings.Repeat("00", 32)
	if _, err := NewBeaconRecord(arbitrary); err == nil {
		t.Fatal("caller-selected challenge unexpectedly accepted")
	}
	arbitrary = base
	arbitrary.ChallengeSHA256 = "sha256:" + strings.Repeat("00", 32)
	if _, err := NewBeaconRecord(arbitrary); err == nil {
		t.Fatal("caller-selected challenge digest unexpectedly accepted")
	}

	tampered := record
	tampered.RandomnessHex = strings.Repeat("52", 32)
	if err := tampered.Validate(); err == nil {
		t.Fatal("randomness tamper retaining the old challenge unexpectedly validated")
	}
}

func TestValidateBeaconRecomputesAgainstBoundClose(t *testing.T) {
	definition := adversarialDefinition(t)
	phaseID, err := ComputePhaseID(definition.CeremonyID, Phase1, definition.Phase1Genesis, "")
	if err != nil {
		t.Fatal(err)
	}
	chain, err := NewChain(definition.CeremonyID, Phase1, phaseID, definition.Phase1Genesis)
	if err != nil {
		t.Fatal(err)
	}
	for index, participantID := range definition.Phase1Policy.Participants {
		head, err := chain.HeadPayload()
		if err != nil {
			t.Fatal(err)
		}
		headID, err := chain.HeadRecordID()
		if err != nil {
			t.Fatal(err)
		}
		record := adversarialChainRecord(
			t,
			definition,
			phaseID,
			uint8(index+1),
			participantID,
			head,
			headID,
			"beacon-bound-"+participantID,
		)
		if err := chain.Append(record); err != nil {
			t.Fatal(err)
		}
	}
	finalPayload, _ := chain.HeadPayload()
	chainHead, _ := chain.HeadRecordID()
	participants, _ := chain.ParticipantIDs()
	roundTime, err := QuicknetRoundTime(30699432)
	if err != nil {
		t.Fatal(err)
	}
	minimumLead := time.Duration(definition.BeaconPolicy.MinimumWitnessLeadSeconds) * time.Second
	closeRecord, err := NewCloseRecord(CloseRecord{
		CeremonyID:           definition.CeremonyID,
		Phase:                Phase1,
		PhaseID:              phaseID,
		FinalIndex:           uint8(len(chain.Records)),
		FinalPayload:         finalPayload,
		ChainHeadID:          chainHead,
		AcceptedParticipants: participants,
		BeaconProvider:       definition.BeaconPolicy.Provider,
		BeaconNetwork:        definition.BeaconPolicy.Network,
		BeaconRound:          30699432,
		BeaconNotBefore:      roundTime.Format(time.RFC3339),
		ClosedAt:             roundTime.Add(-minimumLead - time.Minute).Format(time.RFC3339),
		CoordinatorID:        definition.Coordinator.ID,
		CoordinatorKeyID:     definition.Coordinator.KeyID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateClose(definition, chain, closeRecord); err != nil {
		t.Fatal(err)
	}
	exactLead := closeRecord
	exactLead.ClosedAt = roundTime.Add(-minimumLead).Format(time.RFC3339)
	exactLead, err = NewCloseRecord(exactLead)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateClose(definition, chain, exactLead); err != nil {
		t.Fatalf("close at exact signed minimum witness lead rejected: %v", err)
	}
	belowLead := exactLead
	belowLead.ClosedAt = "2026-07-23T14:01:00.000000001Z"
	belowLead, err = NewCloseRecord(belowLead)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateClose(definition, chain, belowLead); err == nil {
		t.Fatal("close below signed minimum witness lead unexpectedly accepted")
	}
	atFinalAcceptance := closeRecord
	atFinalAcceptance.ClosedAt = chain.Records[len(chain.Records)-1].AcceptedAt
	atFinalAcceptance, err = NewCloseRecord(atFinalAcceptance)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateClose(definition, chain, atFinalAcceptance); err == nil {
		t.Fatal("close at the final acceptance timestamp unexpectedly accepted")
	}
	pastRound := closeRecord
	pastRound.BeaconRound = 10001
	pastRoundTime, err := QuicknetRoundTime(pastRound.BeaconRound)
	if err != nil {
		t.Fatal(err)
	}
	pastRound.BeaconNotBefore = pastRoundTime.Format(time.RFC3339)
	pastRound.ClosedAt = pastRoundTime.Add(-time.Second).Format(time.RFC3339)
	pastRound, err = NewCloseRecord(pastRound)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateClose(definition, chain, pastRound); err == nil {
		t.Fatal("past beacon round unexpectedly accepted at phase close")
	}
	beacon, err := NewBeaconRecord(BeaconRecord{
		CeremonyID:  definition.CeremonyID,
		Phase:       Phase1,
		PhaseID:     phaseID,
		CloseID:     closeRecord.CloseID,
		Provider:    closeRecord.BeaconProvider,
		Network:     closeRecord.BeaconNetwork,
		Round:       closeRecord.BeaconRound,
		PublishedAt: "2026-07-24T14:01:00Z",
		RawResponse: ArtifactRef{
			Name:   "beacons/phase1-response.json",
			Digest: NewDigest([]byte("phase1 public beacon evidence")),
		},
		RandomnessHex: strings.Repeat("a5", 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateBeacon(definition, closeRecord, beacon); err != nil {
		t.Fatalf("bound deterministic beacon rejected: %v", err)
	}

	otherClose := beacon
	otherClose.CloseID = "sha256:" + strings.Repeat("99", 32)
	otherClose.ChallengeHex = ""
	otherClose.ChallengeSHA256 = ""
	otherClose, err = NewBeaconRecord(otherClose)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateBeacon(definition, closeRecord, otherClose); err == nil {
		t.Fatal("challenge derived for another close record unexpectedly accepted")
	}
}

func TestCloseRequiresCompleteProductionRosterButKeepsRehearsalThreshold(t *testing.T) {
	buildAcceptedPrefix := func(
		t *testing.T,
		definition CeremonyDefinition,
		count int,
	) (Chain, string) {
		t.Helper()
		phaseID, err := ComputePhaseID(
			definition.CeremonyID,
			Phase1,
			definition.Phase1Genesis,
			"",
		)
		if err != nil {
			t.Fatal(err)
		}
		chain, err := NewChain(
			definition.CeremonyID,
			Phase1,
			phaseID,
			definition.Phase1Genesis,
		)
		if err != nil {
			t.Fatal(err)
		}
		for index, participantID := range definition.Phase1Policy.Participants[:count] {
			head, err := chain.HeadPayload()
			if err != nil {
				t.Fatal(err)
			}
			headID, err := chain.HeadRecordID()
			if err != nil {
				t.Fatal(err)
			}
			record := adversarialChainRecord(
				t,
				definition,
				phaseID,
				uint8(index+1),
				participantID,
				head,
				headID,
				"close-policy-"+participantID,
			)
			if err := chain.Append(record); err != nil {
				t.Fatal(err)
			}
		}
		return chain, phaseID
	}
	buildClose := func(t *testing.T, definition CeremonyDefinition, chain Chain, phaseID string) CloseRecord {
		t.Helper()
		payload, err := chain.HeadPayload()
		if err != nil {
			t.Fatal(err)
		}
		headID, err := chain.HeadRecordID()
		if err != nil {
			t.Fatal(err)
		}
		participants, err := chain.ParticipantIDs()
		if err != nil {
			t.Fatal(err)
		}
		roundTime, err := QuicknetRoundTime(30699432)
		if err != nil {
			t.Fatal(err)
		}
		minimumLead := time.Duration(definition.BeaconPolicy.MinimumWitnessLeadSeconds) * time.Second
		closeRecord, err := NewCloseRecord(CloseRecord{
			CeremonyID:           definition.CeremonyID,
			Phase:                Phase1,
			PhaseID:              phaseID,
			FinalIndex:           uint8(len(chain.Records)),
			FinalPayload:         payload,
			ChainHeadID:          headID,
			AcceptedParticipants: participants,
			BeaconProvider:       definition.BeaconPolicy.Provider,
			BeaconNetwork:        definition.BeaconPolicy.Network,
			BeaconRound:          30699432,
			BeaconNotBefore:      roundTime.Format(time.RFC3339),
			ClosedAt:             roundTime.Add(-minimumLead - time.Minute).Format(time.RFC3339),
			CoordinatorID:        definition.Coordinator.ID,
			CoordinatorKeyID:     definition.Coordinator.KeyID,
		})
		if err != nil {
			t.Fatal(err)
		}
		return closeRecord
	}

	production := adversarialDefinition(t)
	productionChain, productionPhaseID := buildAcceptedPrefix(t, production, 2)
	productionClose := buildClose(t, production, productionChain, productionPhaseID)
	err := ValidateClose(production, productionChain, productionClose)
	if err == nil || !strings.Contains(err.Error(), "all 3 scheduled participants") {
		t.Fatalf("incomplete production close error = %v, want complete-roster rejection", err)
	}

	rehearsal := adversarialDefinition(t)
	rehearsal.CeremonyID = ""
	rehearsal.Mode = ModeRehearsal
	rehearsal.Phase1Policy = clonePhasePolicy(rehearsal.Phase1Policy)
	rehearsal.Phase1Policy.Minimum = 2
	rehearsal.Phase2Policy = clonePhasePolicy(rehearsal.Phase2Policy)
	rehearsal.Phase2Policy.Minimum = 2
	rehearsal, err = FinalizeCeremonyDefinition(rehearsal)
	if err != nil {
		t.Fatal(err)
	}
	rehearsalChain, rehearsalPhaseID := buildAcceptedPrefix(t, rehearsal, 2)
	rehearsalClose := buildClose(t, rehearsal, rehearsalChain, rehearsalPhaseID)
	if err := ValidateClose(rehearsal, rehearsalChain, rehearsalClose); err != nil {
		t.Fatalf("rehearsal close at signed minimum rejected: %v", err)
	}
}
