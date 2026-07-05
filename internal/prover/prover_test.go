package prover

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/consensys/gnark/frontend"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/circuit/ownershipdest"
	"proof-tool/internal/circuit/ownershipmulti"
)

type sq struct {
	X frontend.Variable
	Y frontend.Variable `gnark:",public"`
}

func (s *sq) Define(api frontend.API) error {
	api.AssertIsEqual(api.Mul(s.X, s.X), s.Y)
	return nil
}

func TestSmallProofMarshalVerifyAndRejectsWrongPublicInput(t *testing.T) {
	ccs, err := Compile(&sq{})
	if err != nil {
		t.Fatal(err)
	}
	pk, vk, err := Setup(ccs)
	if err != nil {
		t.Fatal(err)
	}
	proof, err := Prove(ccs, pk, &sq{X: 3, Y: 9})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := MarshalProof(proof)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := UnmarshalProof(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyProof(vk, decoded, &sq{Y: 9}); err != nil {
		t.Fatalf("valid proof rejected: %v", err)
	}
	if err := VerifyProof(vk, decoded, &sq{Y: 10}); err == nil {
		t.Fatal("proof verified against wrong public input")
	}
}

func TestOwnershipProofRoundTripIntegration(t *testing.T) {
	if os.Getenv("PROOF_TOOL_RUN_FULL_PROOF") != "1" {
		t.Skip("set PROOF_TOOL_RUN_FULL_PROOF=1 to run the full ownership Groth16 proof")
	}

	master := mustDecodeHex(t, "c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620")
	target := mustDecodeHex(t, "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4")
	pub, err := ownership.PublicInputForCredential(target)
	if err != nil {
		t.Fatal(err)
	}
	assignment, err := ownership.Assignment(master, ownership.Path{Account: 0, Role: 0, Index: 0}, pub)
	if err != nil {
		t.Fatal(err)
	}

	ccs, err := CompileOwnership()
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := LoadOrCreateOwnershipBundle(t.TempDir(), ccs)
	if err != nil {
		t.Fatal(err)
	}
	proof, err := Prove(ccs, bundle.ProvingKey, assignment)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := MarshalProof(proof)
	if err != nil {
		t.Fatal(err)
	}

	proofPath := filepath.Join(t.TempDir(), "proof.json")
	if err := artifact.WriteJSON(proofPath, artifact.ProofArtifact{
		Schema:           artifact.ProofSchema,
		CircuitID:        ownership.CircuitID,
		VKHash:           bundle.Manifest.VKHash,
		TargetCredential: hex.EncodeToString(target),
		PublicInput:      ownership.PublicInputHex(pub),
		Proof:            encoded,
		Path:             &artifact.PathMetadata{Account: 0, Role: 0, Index: 0},
	}); err != nil {
		t.Fatal(err)
	}

	decoded, err := UnmarshalProof(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyProof(bundle.VerifyingKey, decoded, &ownership.Circuit{Pub: pub}); err != nil {
		t.Fatalf("valid ownership proof rejected: %v", err)
	}

	wrongTarget := append([]byte(nil), target...)
	wrongTarget[0] ^= 0x01
	wrongPub, err := ownership.PublicInputForCredential(wrongTarget)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyProof(bundle.VerifyingKey, decoded, &ownership.Circuit{Pub: wrongPub}); err == nil {
		t.Fatal("ownership proof verified against wrong target credential")
	}

	rawProof, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	rawProof[len(rawProof)-1] ^= 0x01
	tampered, err := UnmarshalProof(base64.StdEncoding.EncodeToString(rawProof))
	if err == nil {
		if err := VerifyProof(bundle.VerifyingKey, tampered, &ownership.Circuit{Pub: pub}); err == nil {
			t.Fatal("tampered ownership proof verified")
		}
	}

	readBack, err := os.ReadFile(proofPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(readBack, []byte(ownership.CircuitID)) {
		t.Fatal("artifact does not include circuit id")
	}
}

func TestOwnershipMultiProofRoundTripIntegration(t *testing.T) {
	if os.Getenv("PROOF_TOOL_RUN_FULL_PROOF") != "1" {
		t.Skip("set PROOF_TOOL_RUN_FULL_PROOF=1 to run the full multi-ownership Groth16 proof")
	}

	master := mustDecodeHex(t, "c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620")
	destination := mustDecodeHex(t, "010038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da1110000000000000000000000000000000000000000000000000000000000")
	paths := []ownership.Path{
		{Account: 0, Role: 0, Index: 0},
		{Account: 0, Role: 0, Index: 1},
	}
	credentials, err := ownershipmulti.DeriveCredentials(master, paths)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := ownershipmulti.PublicInputForCredentialsDestination(credentials, destination)
	if err != nil {
		t.Fatal(err)
	}
	assignment, err := ownershipmulti.Assignment(master, paths, destination, pub)
	if err != nil {
		t.Fatal(err)
	}

	ccs, err := CompileOwnershipMulti()
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := LoadOrCreateOwnershipMultiBundle(t.TempDir(), ccs)
	if err != nil {
		t.Fatal(err)
	}
	if bundle.Manifest.CircuitID != ownershipmulti.CircuitID {
		t.Fatalf("manifest circuit id = %q", bundle.Manifest.CircuitID)
	}
	proof, err := Prove(ccs, bundle.ProvingKey, assignment)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := MarshalProof(proof)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := UnmarshalProof(encoded)
	if err != nil {
		t.Fatal(err)
	}
	publicAssignment, err := ownershipmulti.PublicAssignment(len(paths), pub)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyProof(bundle.VerifyingKey, decoded, publicAssignment); err != nil {
		t.Fatalf("valid multi ownership proof rejected: %v", err)
	}

	reorderedPub, err := ownershipmulti.PublicInputForCredentialsDestination(
		[][]byte{credentials[1], credentials[0]},
		destination,
	)
	if err != nil {
		t.Fatal(err)
	}
	reorderedAssignment, err := ownershipmulti.PublicAssignment(len(paths), reorderedPub)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyProof(bundle.VerifyingKey, decoded, reorderedAssignment); err == nil {
		t.Fatal("multi proof verified against reordered credentials")
	}
	changedDestination := append([]byte(nil), destination...)
	changedDestination[1] ^= 0x01
	changedDestinationPub, err := ownershipmulti.PublicInputForCredentialsDestination(credentials, changedDestination)
	if err != nil {
		t.Fatal(err)
	}
	changedDestinationAssignment, err := ownershipmulti.PublicAssignment(len(paths), changedDestinationPub)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyProof(bundle.VerifyingKey, decoded, changedDestinationAssignment); err == nil {
		t.Fatal("multi proof verified against changed destination")
	}

	proofPath := filepath.Join(t.TempDir(), "multi-proof.json")
	if err := artifact.WriteJSON(proofPath, artifact.ProofArtifact{
		Schema:                     artifact.ProofSchema,
		CircuitID:                  ownershipmulti.CircuitID,
		VKHash:                     bundle.Manifest.VKHash,
		TargetCredentials:          []string{hex.EncodeToString(credentials[0]), hex.EncodeToString(credentials[1])},
		DestinationAddressEncoding: ownershipmulti.DestinationAddressEncoding,
		DestinationAddress:         hex.EncodeToString(destination),
		CredentialCount:            ownershipmulti.CredentialCount,
		PublicInputEncoding:        ownershipmulti.PublicInputEncoding,
		PublicInput:                ownershipmulti.PublicInputHex(pub),
		Proof:                      encoded,
		Paths: []artifact.PathMetadata{
			{Account: 0, Role: 0, Index: 0},
			{Account: 0, Role: 0, Index: 1},
		},
	}); err != nil {
		t.Fatal(err)
	}
	readBack, err := os.ReadFile(proofPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(readBack, []byte(ownershipmulti.CircuitID)) {
		t.Fatal("multi artifact does not include circuit id")
	}
}

func TestOwnershipDestinationProofRoundTripIntegration(t *testing.T) {
	if os.Getenv("PROOF_TOOL_RUN_FULL_PROOF") != "1" {
		t.Skip("set PROOF_TOOL_RUN_FULL_PROOF=1 to run the full destination ownership Groth16 proof")
	}

	master := mustDecodeHex(t, "c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620")
	target := mustDecodeHex(t, "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4")
	destination := mustDecodeHex(t, "010038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da1110000000000000000000000000000000000000000000000000000000000")
	pub, err := ownershipdest.PublicInputForCredentialDestination(target, destination)
	if err != nil {
		t.Fatal(err)
	}
	assignment, err := ownershipdest.Assignment(master, ownership.Path{Account: 0, Role: 0, Index: 0}, destination, pub)
	if err != nil {
		t.Fatal(err)
	}

	ccs, err := CompileOwnershipDestination()
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := LoadOrCreateOwnershipDestinationBundle(t.TempDir(), ccs)
	if err != nil {
		t.Fatal(err)
	}
	if bundle.Manifest.CircuitID != ownershipdest.CircuitID {
		t.Fatalf("manifest circuit id = %q", bundle.Manifest.CircuitID)
	}
	proof, err := Prove(ccs, bundle.ProvingKey, assignment)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := MarshalProof(proof)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := UnmarshalProof(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyProof(bundle.VerifyingKey, decoded, &ownershipdest.Circuit{Pub: pub}); err != nil {
		t.Fatalf("valid destination ownership proof rejected: %v", err)
	}

	changedDestination := append([]byte(nil), destination...)
	changedDestination[1] ^= 0x01
	changedDestinationPub, err := ownershipdest.PublicInputForCredentialDestination(target, changedDestination)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyProof(bundle.VerifyingKey, decoded, &ownershipdest.Circuit{Pub: changedDestinationPub}); err == nil {
		t.Fatal("destination ownership proof verified against changed destination")
	}

	proofPath := filepath.Join(t.TempDir(), "destination-proof.json")
	if err := artifact.WriteJSON(proofPath, artifact.ProofArtifact{
		Schema:                     artifact.ProofSchema,
		CircuitID:                  ownershipdest.CircuitID,
		VKHash:                     bundle.Manifest.VKHash,
		TargetCredential:           hex.EncodeToString(target),
		DestinationAddressEncoding: ownershipdest.DestinationAddressEncoding,
		DestinationAddress:         hex.EncodeToString(destination),
		PublicInputEncoding:        ownershipdest.PublicInputEncoding,
		PublicInput:                ownershipdest.PublicInputHex(pub),
		Proof:                      encoded,
		Path:                       &artifact.PathMetadata{Account: 0, Role: 0, Index: 0},
	}); err != nil {
		t.Fatal(err)
	}
	readBack, err := os.ReadFile(proofPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(readBack, []byte(ownershipdest.CircuitID)) {
		t.Fatal("destination artifact does not include circuit id")
	}
}

func TestInspectOwnershipBundleReportsMissing(t *testing.T) {
	status := InspectOwnershipBundle(t.TempDir(), true)
	if status.Ready {
		t.Fatal("missing bundle reported ready")
	}
	if status.State != "missing" {
		t.Fatalf("state = %q", status.State)
	}
}

func TestLoadOwnershipProverFailsClosedWhenMissing(t *testing.T) {
	_, err := LoadOwnershipProver(t.TempDir())
	if err == nil {
		t.Fatal("missing production bundle loaded")
	}
	if !strings.Contains(err.Error(), "manifest.json") {
		t.Fatalf("error = %v", err)
	}
}

func TestInspectOwnershipBundleRejectsWrongVerifyingKeyHash(t *testing.T) {
	dir := t.TempDir()
	manifestPath, pkPath, vkPath := ownershipBundlePaths(dir)
	if err := os.WriteFile(pkPath, []byte("pk"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(vkPath, []byte("vk"), 0o600); err != nil {
		t.Fatal(err)
	}
	pkDigest, err := digestFile(pkPath)
	if err != nil {
		t.Fatal(err)
	}
	vkDigest, err := digestFile(vkPath)
	if err != nil {
		t.Fatal(err)
	}
	manifest := &artifact.KeyManifest{
		Schema:               artifact.ManifestSchema,
		KeyVersion:           DefaultKeyVersion,
		CircuitID:            ownership.CircuitID,
		Curve:                "BLS12-381",
		Backend:              "groth16",
		VKHash:               "blake2b256:wrong",
		ProvingKeySHA256:     pkDigest.SHA256,
		ProvingKeyBlake2b256: pkDigest.Blake2b256,
		ProvingKeySize:       pkDigest.Size,
		VerifyingKeySHA256:   vkDigest.SHA256,
		VerifyingKeySize:     vkDigest.Size,
	}
	if err := artifact.WriteJSON(manifestPath, manifest); err != nil {
		t.Fatal(err)
	}

	status := InspectOwnershipBundle(dir, true)
	if status.Ready {
		t.Fatal("wrong key hash reported ready")
	}
	if status.State != "invalid" {
		t.Fatalf("state = %q", status.State)
	}
	if !strings.Contains(status.Error, "verifying key hash mismatch") {
		t.Fatalf("error = %q", status.Error)
	}
}

func mustDecodeHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
