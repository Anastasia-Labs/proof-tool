package ownership

import (
	"encoding/hex"
	"testing"
)

const (
	knownMnemonic = "eight country switch draw meat scout mystery blade tip drift useless good keep usage title"
	knownMaster   = "c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620"
	goldenC       = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4"
)

func TestMasterXPrvFromSeedPhraseGolden(t *testing.T) {
	got, err := MasterXPrvFromSeedPhrase(knownMnemonic)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(got) != knownMaster {
		t.Fatalf("master xprv mismatch:\n got  %x\n want %s", got, knownMaster)
	}
}

func TestDeriveCredentialGolden(t *testing.T) {
	master := mustDecodeHex(t, knownMaster)
	got, err := DeriveCredential(master, Path{Account: 0, Role: 0, Index: 0})
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(got[:]) != goldenC {
		t.Fatalf("credential mismatch: got %x want %s", got, goldenC)
	}
}

func TestFindPath(t *testing.T) {
	master := mustDecodeHex(t, knownMaster)
	target := mustDecodeHex(t, goldenC)
	path, err := FindPath(master, target, SearchOptions{
		Account: 0,
		Role:    0,
		Index:   0,
	})
	if err != nil {
		t.Fatal(err)
	}
	if path != (Path{Account: 0, Role: 0, Index: 0}) {
		t.Fatalf("path = %+v, want 0/0/0", path)
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
