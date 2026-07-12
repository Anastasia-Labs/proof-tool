package ownershipmulti

import (
	"bytes"
	"encoding/hex"
	"testing"

	"golang.org/x/crypto/blake2b"

	"proof-tool/internal/circuit/ownership"
)

const (
	knownMaster = "c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620"
	credential0 = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4"
	credential1 = "155a68f5db6e170a0f0c7d211c24dce882b23e18244f1f142a5fa377"
	destination = "010038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da1110000000000000000000000000000000000000000000000000000000000"
)

func TestPublicInputDigestForCredentialsDestination(t *testing.T) {
	c0 := mustDecodeHex(t, credential0)
	c1 := mustDecodeHex(t, credential1)
	dest := mustDecodeHex(t, destination)

	got, err := PublicInputDigestForCredentialsDestination([][]byte{c0, c1}, dest)
	if err != nil {
		t.Fatal(err)
	}
	preimage := append([]byte(Domain), 0, DefaultCredentialCount)
	preimage = append(preimage, c0...)
	preimage = append(preimage, c1...)
	preimage = append(preimage, dest...)
	want := blake2b.Sum256(preimage)
	if !bytes.Equal(got, want[:]) {
		t.Fatalf("digest mismatch:\n got  %x\n want %x", got, want)
	}
}

func TestPublicInputDigestForCredentialsDestinationValidatesShape(t *testing.T) {
	c0 := mustDecodeHex(t, credential0)
	dest := mustDecodeHex(t, destination)
	if _, err := PublicInputDigestForCredentialsDestination(nil, dest); err == nil {
		t.Fatal("accepted zero credentials")
	}
	if _, err := PublicInputDigestForCredentialsDestination([][]byte{c0, c0[:27]}, dest); err == nil {
		t.Fatal("accepted malformed credential")
	}
	if _, err := PublicInputDigestForCredentialsDestination([][]byte{c0, c0}, dest[:57]); err == nil {
		t.Fatal("accepted malformed destination")
	}
}

func TestDeriveCredentialsGolden(t *testing.T) {
	master := mustDecodeHex(t, knownMaster)
	credentials, err := DeriveCredentials(master, []ownership.Path{
		{Account: 0, Role: 0, Index: 0},
		{Account: 0, Role: 0, Index: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(credentials[0]) != credential0 {
		t.Fatalf("credential0 = %x", credentials[0])
	}
	if hex.EncodeToString(credentials[1]) != credential1 {
		t.Fatalf("credential1 = %x", credentials[1])
	}
}

func TestCountSpecificCircuitIDs(t *testing.T) {
	for _, count := range []int{1, 2, 5, 10, 15, 20} {
		circuitID := CircuitIDForCount(count)
		parsedCount, ok := CircuitCountFromID(circuitID)
		if !ok {
			t.Fatalf("did not parse circuit id %q", circuitID)
		}
		if parsedCount != count {
			t.Fatalf("parsed count = %d, want %d", parsedCount, count)
		}
		if KeyVersionForCount(count) == "" {
			t.Fatalf("empty key version for count %d", count)
		}
	}
	if CircuitIDForCount(DefaultCredentialCount) != CircuitID {
		t.Fatalf("default circuit id changed: %s", CircuitIDForCount(DefaultCredentialCount))
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
