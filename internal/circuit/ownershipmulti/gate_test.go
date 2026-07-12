package ownershipmulti

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

func TestOwnershipMultiCircuitGate(t *testing.T) {
	circuit, err := NewCircuit(DefaultCredentialCount)
	if err != nil {
		t.Fatalf("construct circuit: %v", err)
	}
	gates := []struct {
		name            string
		circuit         frontend.Circuit
		constraints     int
		k               int
		commitmentCount int
	}{
		{
			name:            CircuitID,
			circuit:         circuit,
			constraints:     3_447_616,
			k:               22,
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

			master := mustDecodeHex(t, knownMaster)
			paths := []ownership.Path{
				{Account: 0, Role: 0, Index: 0},
				{Account: 0, Role: 0, Index: 1},
			}
			credentials, err := DeriveCredentials(master, paths)
			if err != nil {
				t.Fatalf("derive golden credentials: %v", err)
			}
			wantCredentials := [][]byte{
				mustDecodeHex(t, credential0),
				mustDecodeHex(t, credential1),
			}
			for i := range credentials {
				if !bytes.Equal(credentials[i], wantCredentials[i]) {
					t.Fatalf("credential %d = %x, want %x", i, credentials[i], wantCredentials[i])
				}
			}
			dest := mustDecodeHex(t, destination)
			digest, err := PublicInputDigestForCredentialsDestination(credentials, dest)
			if err != nil {
				t.Fatalf("derive golden public-input digest: %v", err)
			}
			wantDigest := mustDecodeHex(t, "e60b2a01ad44c309cf7fac7b828c787262abadfc085926a59437a1cb21cae81b")
			if !bytes.Equal(digest, wantDigest) {
				t.Fatalf("public-input digest = %x, want %x", digest, wantDigest)
			}
			pub, err := PublicInputForCredentialsDestination(credentials, dest)
			if err != nil {
				t.Fatalf("derive golden public input: %v", err)
			}
			assignment, err := Assignment(master, paths, dest, pub)
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
