package ownership

import (
	"bytes"
	"math/bits"
	"testing"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
)

func TestOwnershipCircuitGate(t *testing.T) {
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
			constraints:     1_789_634,
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

			master := mustDecodeHex(t, knownMaster)
			credential, err := DeriveCredential(master, Path{Account: 0, Role: 0, Index: 0})
			if err != nil {
				t.Fatalf("derive golden credential: %v", err)
			}
			wantCredential := mustDecodeHex(t, goldenC)
			if !bytes.Equal(credential[:], wantCredential) {
				t.Fatalf("credential = %x, want %x", credential, wantCredential)
			}
			digest, err := PublicInputDigestForCredential(credential[:])
			if err != nil {
				t.Fatalf("derive golden public-input digest: %v", err)
			}
			wantDigest := mustDecodeHex(t, "c6dc594ba9f45d2d177f2cbecb3002541f17c3b10966bd07715cd09390015aaf")
			if !bytes.Equal(digest, wantDigest) {
				t.Fatalf("public-input digest = %x, want %x", digest, wantDigest)
			}
			pub, err := PublicInputForCredential(credential[:])
			if err != nil {
				t.Fatalf("derive golden public input: %v", err)
			}
			assignment, err := Assignment(master, Path{Account: 0, Role: 0, Index: 0}, pub)
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
