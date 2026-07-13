package helper

import (
	"context"
	"os"
	"testing"
	"time"

	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/circuit/ownershipdest"
)

// TestGenerateDestinationProofsAgainstInstalledBundle exercises the full
// helper proving path (manifest/PK/VK digest validation, frozen-CCS load with
// its manifest pin, path search, Groth16 prove, artifact assembly, and the
// idle-TTL cache) against a real installed key bundle. It is gated on
// PROOF_TOOL_BUNDLE_DIR because the bundle is ~1.4 GiB and not present in CI.
//
//	PROOF_TOOL_BUNDLE_DIR=/path/to/key-bundle/ownership-destination-v2-... \
//	  go test ./internal/helper -run TestGenerateDestinationProofsAgainstInstalledBundle -v
func TestGenerateDestinationProofsAgainstInstalledBundle(t *testing.T) {
	bundleDir := os.Getenv("PROOF_TOOL_BUNDLE_DIR")
	if bundleDir == "" {
		t.Skip("PROOF_TOOL_BUNDLE_DIR not set; skipping installed-bundle integration test")
	}

	// Repository golden fixture (internal/circuit/ownershipdest/gate_test.go).
	master, err := ownership.DecodeMasterXPrvHex("c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620")
	if err != nil {
		t.Fatalf("decode golden master: %v", err)
	}
	destination, err := ownershipdest.DecodeDestinationAddressV1Hex("010038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da1110000000000000000000000000000000000000000000000000000000000")
	if err != nil {
		t.Fatalf("decode golden destination: %v", err)
	}
	credential, err := ownership.DeriveCredential(master, ownership.Path{Account: 0, Role: 0, Index: 0})
	if err != nil {
		t.Fatalf("derive golden credential: %v", err)
	}

	g := &OwnershipGenerator{DestinationKeysDir: bundleDir}
	input := ProveDestinationInput{
		MasterXPrv: master,
		Profile:    DestinationProfileSingle,
		Requests: []DestinationProofInput{{
			OutRef:                     "integration-test#0",
			TargetCredential:           credential[:],
			DestinationAddressEncoding: ownershipdest.DestinationAddressEncoding,
			DestinationAddress:         destination,
		}},
		Search: ownership.SearchOptions{Account: 0, Role: 0, Index: 0},
	}

	coldStart := time.Now()
	first, err := g.GenerateDestinationProofs(context.Background(), input)
	if err != nil {
		t.Fatalf("cold GenerateDestinationProofs: %v", err)
	}
	cold := time.Since(coldStart)
	if len(first) != 1 {
		t.Fatalf("cold run returned %d artifacts, want 1", len(first))
	}

	warmStart := time.Now()
	second, err := g.GenerateDestinationProofs(context.Background(), input)
	if err != nil {
		t.Fatalf("warm GenerateDestinationProofs: %v", err)
	}
	warm := time.Since(warmStart)
	if len(second) != 1 {
		t.Fatalf("warm run returned %d artifacts, want 1", len(second))
	}

	t.Logf("cold (load bundle + frozen ccs + prove): %s", cold)
	t.Logf("warm (cached bundle + prove):            %s", warm)
	if warm >= cold {
		t.Logf("note: warm run was not faster than cold; cache may not be effective")
	}

	g.mu.Lock()
	cached := g.destCache != nil
	g.mu.Unlock()
	if !cached {
		t.Fatal("destination prover cache is empty after requests")
	}
}
