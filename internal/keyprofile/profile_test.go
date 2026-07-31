package keyprofile

import (
	"strings"
	"testing"

	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/circuit/ownershipdest"
	"proof-tool/internal/prover"
)

func TestForKeyVersion(t *testing.T) {
	ownershipProfile, err := ForKeyVersion(prover.DefaultKeyVersion)
	if err != nil {
		t.Fatal(err)
	}
	if ownershipProfile.CircuitID != ownership.CircuitID {
		t.Fatalf("ownership circuit id = %q", ownershipProfile.CircuitID)
	}

	destinationProfile, err := ForKeyVersion(prover.DefaultDestinationKeyVersion)
	if err != nil {
		t.Fatal(err)
	}
	if destinationProfile.CircuitID != ownershipdest.CircuitID {
		t.Fatalf("destination circuit id = %q", destinationProfile.CircuitID)
	}
	if destinationProfile.KeyVersion != "ownership-destination-v2" {
		t.Fatalf("destination key version = %q", destinationProfile.KeyVersion)
	}

	if _, err := ForKeyVersion("ownership-destination-v1"); err == nil || !strings.Contains(err.Error(), "unsupported key version") {
		t.Fatalf("legacy key version err = %v", err)
	}
}
