package ownership

import (
	"encoding/hex"
	"testing"

	"proof-tool/internal/circuit/ckd"
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

func TestCIP11StakeRoleGolden(t *testing.T) {
	master, err := MasterXPrvFromSeedPhrase("prevent company field green slot measure chief hero apple task eagle sunset endorse dress seed")
	if err != nil {
		t.Fatal(err)
	}
	leaf := ckd.DeriveRef(master, 0, 2, 0)
	got := append(append(append(make([]byte, 0, 96), leaf.KL[:]...), leaf.KR[:]...), leaf.CC[:]...)
	const want = "b8ab42f1aacbcdb3ae858e3a3df88142b3ed27a2d3f432024e0d943fc1e597442d57545d84c8db2820b11509d944093bc605350e60c533b8886a405bd59eed6dcf356648fe9e9219d83e989c8ff5b5b337e2897b6554c1ab4e636de791fe5427"
	if hex.EncodeToString(got) != want {
		t.Fatalf("CIP-11 role-2 child mismatch:\n got  %x\n want %s", got, want)
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
