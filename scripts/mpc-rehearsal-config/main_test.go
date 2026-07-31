package main

import (
	"os"
	"path/filepath"
	"testing"

	"proof-tool/internal/keybundle"
	"proof-tool/internal/mpcceremony"
)

func TestGenerateCreatesValidatedCanonicalRehearsalInputs(t *testing.T) {
	root := filepath.Join(t.TempDir(), "rehearsal")
	if err := generate(root, 3, 300); err != nil {
		t.Fatal(err)
	}
	participants, err := mpcceremony.LoadInitParticipants(
		filepath.Join(root, "config", "participants.json"),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(participants.Roster) != 3 || len(participants.Auditors) != 2 {
		t.Fatal("unexpected generated rehearsal roster")
	}
	policy, err := mpcceremony.LoadInitPolicy(filepath.Join(root, "config", "policy.json"))
	if err != nil {
		t.Fatal(err)
	}
	if policy.Phase1Policy.Minimum != 3 || policy.Phase2Policy.Minimum != 3 {
		t.Fatal("rehearsal policy did not require every generated participant")
	}
	if policy.BeaconPolicy.MinimumWitnessLeadSeconds != 300 {
		t.Fatal("rehearsal policy did not bind the requested beacon witness lead")
	}
	if _, err := mpcceremony.LoadContributionEnvironment(
		filepath.Join(root, "config", "environment.json"),
	); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{
		"coordinator",
		"release-signer",
		"auditor-01",
		"auditor-02",
		"witness-01",
		"witness-02",
		"mirror-01",
		"mirror-02",
		"participant-01",
		"participant-02",
		"participant-03",
	} {
		path := filepath.Join(root, "keys", id+".ed25519.private.hex")
		if _, _, err := keybundle.LoadExistingPrivateKey(path); err != nil {
			t.Fatalf("load generated %s key: %v", id, err)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("generated %s key has group/world permissions", id)
		}
	}
}

func TestGenerateRejectsUnsafeParticipantCounts(t *testing.T) {
	for _, count := range []int{0, 2, 21} {
		if err := generate(filepath.Join(t.TempDir(), "rehearsal"), count, 300); err == nil {
			t.Fatalf("accepted participant count %d", count)
		}
	}
}

func TestGenerateRejectsShortBeaconWitnessLead(t *testing.T) {
	if err := generate(filepath.Join(t.TempDir(), "rehearsal"), 3, 59); err == nil {
		t.Fatal("accepted a rehearsal beacon witness lead below 60 seconds")
	}
}
