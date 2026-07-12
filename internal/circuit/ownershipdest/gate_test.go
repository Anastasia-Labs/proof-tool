package ownershipdest

import (
	"bytes"
	"math/bits"
	"testing"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	"proof-tool/internal/circuit/ownership"
)

func TestOwnershipDestinationCircuitGate(t *testing.T) {
	gates := []struct {
		name            string
		circuit         frontend.Circuit
		constraints     int
		k               int
		commitmentCount int
	}{
		{
			name:            CircuitID,
			circuit:         &Circuit{},
			constraints:     1_789_750,
			k:               21,
			commitmentCount: 1,
		},
	}

	for _, gate := range gates {
		gate := gate
		t.Run(gate.name, func(t *testing.T) {
			ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, gate.circuit)
			if err != nil {
				t.Fatalf("compile circuit: %v", err)
			}
			gotConstraints := ccs.GetNbConstraints()
			if gotConstraints != gate.constraints {
				t.Errorf("constraint count = %d, want %d", gotConstraints, gate.constraints)
			}
			if gotK := constraintDomainK(gotConstraints); gotK != gate.k {
				t.Errorf("K = %d, want %d", gotK, gate.k)
			}
			if got := len(ccs.GetCommitments().CommitmentIndexes()); got != gate.commitmentCount {
				t.Errorf("commitment count = %d, want %d", got, gate.commitmentCount)
			}

			master := mustDecodeHex(t, "c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620")
			path := ownership.Path{Account: 0, Role: 0, Index: 0}
			credential, err := ownership.DeriveCredential(master, path)
			if err != nil {
				t.Fatalf("derive golden credential: %v", err)
			}
			wantCredential := mustDecodeHex(t, "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4")
			if !bytes.Equal(credential[:], wantCredential) {
				t.Fatalf("credential = %x, want %x", credential, wantCredential)
			}
			destination := mustDecodeHex(t, "010038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da1110000000000000000000000000000000000000000000000000000000000")
			digest, err := PublicInputDigestForCredentialDestination(credential[:], destination)
			if err != nil {
				t.Fatalf("derive golden public-input digest: %v", err)
			}
			wantDigest := mustDecodeHex(t, "663c122bc08e26b489e1742a6fb95fb30ee6346548c753f4db0a2cd81a73a442")
			if !bytes.Equal(digest, wantDigest) {
				t.Fatalf("public-input digest = %x, want %x", digest, wantDigest)
			}
			pub, err := PublicInputForCredentialDestination(credential[:], destination)
			if err != nil {
				t.Fatalf("derive golden public input: %v", err)
			}
			assignment, err := Assignment(master, path, destination, pub)
			if err != nil {
				t.Fatalf("build golden assignment: %v", err)
			}
			witness, err := frontend.NewWitness(assignment, ecc.BLS12_381.ScalarField())
			if err != nil {
				t.Fatalf("build golden witness: %v", err)
			}
			started := time.Now()
			if err := ccs.IsSolved(witness); err != nil {
				t.Fatalf("solve golden witness: %v", err)
			}
			t.Logf("golden witness solve: %s", time.Since(started))
		})
	}
}

func constraintDomainK(constraints int) int {
	if constraints < 1 {
		return 0
	}
	return bits.Len64(uint64(constraints - 1))
}
