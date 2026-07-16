package helper

import (
	"context"
	"os"
	"testing"
	"time"

	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/circuit/ownershipdest"
	"proof-tool/internal/prover"
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
	// Exercise automatic discovery for the highest currently deployed role and
	// the account that triggered the production report. Role 2 is the CIP-1852
	// staking chain, and is a valid lock credential for the V2 circuit.
	wantPath := ownership.Path{Account: 3, Role: 2, Index: 0}
	credential, err := ownership.DeriveCredential(master, wantPath)
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
		Search: ownership.SearchOptions{
			Account: -1, Role: -1, Index: -1,
			MaxAccount: 9, MaxIndex: 999,
		},
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
	verifyInstalledBundleArtifact(t, bundleDir, first[0], credential[:], destination, wantPath)

	warmStart := time.Now()
	second, err := g.GenerateDestinationProofs(context.Background(), input)
	if err != nil {
		t.Fatalf("warm GenerateDestinationProofs: %v", err)
	}
	warm := time.Since(warmStart)
	if len(second) != 1 {
		t.Fatalf("warm run returned %d artifacts, want 1", len(second))
	}
	verifyInstalledBundleArtifact(t, bundleDir, second[0], credential[:], destination, wantPath)

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

func verifyInstalledBundleArtifact(
	t *testing.T,
	bundleDir string,
	item DestinationProofArtifactItem,
	credential []byte,
	destination []byte,
	wantPath ownership.Path,
) {
	t.Helper()
	if item.Artifact.Path == nil {
		t.Fatal("local debug artifact omitted its discovered path")
	}
	if got := *item.Artifact.Path; got.Account != wantPath.Account || got.Role != wantPath.Role || got.Index != wantPath.Index {
		t.Fatalf("discovered path = %+v, want %+v", got, wantPath)
	}
	publicInput, err := ownershipdest.PublicInputForCredentialDestination(credential, destination)
	if err != nil {
		t.Fatalf("recompute public input: %v", err)
	}
	proof, err := prover.UnmarshalProof(item.Artifact.Proof)
	if err != nil {
		t.Fatalf("decode generated proof: %v", err)
	}
	verifier, err := prover.LoadOwnershipDestinationVerifier(bundleDir)
	if err != nil {
		t.Fatalf("load installed verifier: %v", err)
	}
	if err := prover.VerifyProof(verifier.VerifyingKey, proof, &ownershipdest.Circuit{Pub: publicInput}); err != nil {
		t.Fatalf("verify generated proof: %v", err)
	}
}
