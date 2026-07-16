package ckd

import (
	"encoding/hex"
	"math/rand"
	"testing"
)

const publicTestMaster = "c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620"

func TestOptimizedPublicDerivationMatchesPrivateReference(t *testing.T) {
	master, err := hex.DecodeString(publicTestMaster)
	if err != nil {
		t.Fatal(err)
	}
	root, err := RootExt(master)
	if err != nil {
		t.Fatal(err)
	}
	purpose := DerivePrivateChild(root, 1<<31|1852, true)
	coin := DerivePrivateChild(purpose, 1<<31|1815, true)

	for _, account := range []uint32{0, 1, 3, 9} {
		accountPrivate := DerivePrivateChild(coin, 1<<31|account, true)
		accountPublic, err := XPubFromPrivate(accountPrivate)
		if err != nil {
			t.Fatalf("account %d public key: %v", account, err)
		}
		for _, role := range []uint32{0, 1, 2, 3, 4, 5} {
			rolePublic, err := DerivePublicChild(accountPublic, role)
			if err != nil {
				t.Fatalf("account %d role %d: %v", account, role, err)
			}
			for _, index := range []uint32{0, 1, 19, 20, 99, 100, 999} {
				got, err := DerivePublicChild(rolePublic, index)
				if err != nil {
					t.Fatalf("account %d role %d index %d: %v", account, role, index, err)
				}
				want := DeriveRef(master, account, role, index)
				wantPublic := leafPubkey(want.KL)
				if string(got.PublicKey[:]) != string(wantPublic) {
					t.Fatalf("public key mismatch at %d/%d/%d", account, role, index)
				}
				if got.ChainCode != want.CC {
					t.Fatalf("chain code mismatch at %d/%d/%d", account, role, index)
				}
			}
		}
	}
}

func TestOptimizedPublicDerivationMatchesPrivateReferenceRandomized(t *testing.T) {
	rng := rand.New(rand.NewSource(0x1852))
	for masterIndex := 0; masterIndex < 8; masterIndex++ {
		master := make([]byte, 96)
		if _, err := rng.Read(master); err != nil {
			t.Fatal(err)
		}
		// Icarus master scalar clamp.
		master[0] &= 0xf8
		master[31] &= 0x1f
		master[31] |= 0x40

		root, err := RootExt(master)
		if err != nil {
			t.Fatal(err)
		}
		purpose := DerivePrivateChild(root, 1<<31|1852, true)
		coin := DerivePrivateChild(purpose, 1<<31|1815, true)
		for pathIndex := 0; pathIndex < 24; pathIndex++ {
			account := uint32(rng.Intn(10))
			role := uint32(rng.Intn(6))
			index := uint32(rng.Intn(1_000))
			accountPrivate := DerivePrivateChild(coin, 1<<31|account, true)
			accountPublic, err := XPubFromPrivate(accountPrivate)
			if err != nil {
				t.Fatalf("master %d path %d account public: %v", masterIndex, pathIndex, err)
			}
			rolePublic, err := DerivePublicChild(accountPublic, role)
			if err != nil {
				t.Fatalf("master %d path %d role public: %v", masterIndex, pathIndex, err)
			}
			got, err := DerivePublicChild(rolePublic, index)
			if err != nil {
				t.Fatalf("master %d path %d leaf public: %v", masterIndex, pathIndex, err)
			}
			want := DeriveRef(master, account, role, index)
			wantPublic := leafPubkey(want.KL)
			if string(got.PublicKey[:]) != string(wantPublic) || got.ChainCode != want.CC {
				t.Fatalf("randomized mismatch for master %d at %d/%d/%d", masterIndex, account, role, index)
			}
		}
	}
}

func TestPublicDerivationRejectsHardenedIndex(t *testing.T) {
	if _, err := DerivePublicChild(XPub{}, 1<<31); err == nil {
		t.Fatal("expected hardened public derivation to fail")
	}
}
