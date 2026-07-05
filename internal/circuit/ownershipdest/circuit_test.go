package ownershipdest

import (
	"bytes"
	"encoding/hex"
	"testing"

	"proof-tool/internal/circuit/ownership"
)

func TestPublicInputDigestForCredentialDestination(t *testing.T) {
	credential := mustDecodeHex(t, "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4")
	destination := mustDecodeHex(t, "010038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da1110000000000000000000000000000000000000000000000000000000000")

	digest, err := PublicInputDigestForCredentialDestination(credential, destination)
	if err != nil {
		t.Fatal(err)
	}
	want := mustDecodeHex(t, "663c122bc08e26b489e1742a6fb95fb30ee6346548c753f4db0a2cd81a73a442")
	if !bytes.Equal(digest, want) {
		t.Fatalf("digest = %x, want %x", digest, want)
	}

	pub, err := PublicInputForCredentialDestination(credential, destination)
	if err != nil {
		t.Fatal(err)
	}
	if PublicInputHex(pub) != "0x42a4731ad82c0adbf453c7486534e60eb35fb96f2a74e189b4268ec02b123c66" {
		t.Fatalf("public input = %s", PublicInputHex(pub))
	}
}

func TestAssignmentRejectsWrongDestinationLength(t *testing.T) {
	master := mustDecodeHex(t, "c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620")
	_, err := Assignment(master, ownership.Path{Account: 0, Role: 0, Index: 0}, []byte{1, 2, 3}, nil)
	if err == nil {
		t.Fatal("expected destination length error")
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
