package streamprove

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	groth16_bls12381 "github.com/consensys/gnark/backend/groth16/bls12-381"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	"proof-tool/internal/prover"
	"proof-tool/internal/streampk"
)

type committedCircuit struct {
	P frontend.Variable `gnark:",public"`
	S frontend.Variable
}

func (c *committedCircuit) Define(api frontend.API) error {
	committer, ok := api.(frontend.Committer)
	if !ok {
		return fmt.Errorf("compiler does not commit")
	}
	cm, err := committer.Commit(c.S)
	if err != nil {
		return err
	}
	api.AssertIsDifferent(cm, 0)
	api.AssertIsEqual(c.P, c.S)
	return nil
}

func TestProveStreamCommitmentSectionsVerifyWithIndexedKey(t *testing.T) {
	ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &committedCircuit{})
	if err != nil {
		t.Fatal(err)
	}
	pk, vk, err := groth16.Setup(ccs)
	if err != nil {
		t.Fatal(err)
	}

	pkPath := filepath.Join(t.TempDir(), "ownership.pk")
	f, err := os.Create(pkPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pk.WriteRawTo(f); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	source, err := streampk.OpenKeyFile(pkPath)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()

	typedPK := pk.(*groth16_bls12381.ProvingKey)
	basis, err := source.G1("Basis", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(basis) != len(typedPK.CommitmentKeys[0].Basis) {
		t.Fatalf("Basis len = %d, want %d", len(basis), len(typedPK.CommitmentKeys[0].Basis))
	}
	for i := range basis {
		if !basis[i].Equal(&typedPK.CommitmentKeys[0].Basis[i]) {
			t.Fatalf("Basis point %d mismatch", i)
		}
	}
	sigma, err := source.G1("BasisExpSigma", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(sigma) != len(typedPK.CommitmentKeys[0].BasisExpSigma) {
		t.Fatalf("BasisExpSigma len = %d, want %d", len(sigma), len(typedPK.CommitmentKeys[0].BasisExpSigma))
	}
	for i := range sigma {
		if !sigma[i].Equal(&typedPK.CommitmentKeys[0].BasisExpSigma[i]) {
			t.Fatalf("BasisExpSigma point %d mismatch", i)
		}
	}

	assignment := &committedCircuit{P: 7, S: 7}
	witness, err := frontend.NewWitness(assignment, ecc.BLS12_381.ScalarField())
	if err != nil {
		t.Fatal(err)
	}
	streamProofGeneric, err := Prove(ccs, source, assignment)
	if err != nil {
		t.Fatal(err)
	}
	publicWitness, err := witness.Public()
	if err != nil {
		t.Fatal(err)
	}
	if err := groth16.Verify(streamProofGeneric, vk, publicWitness); err != nil {
		t.Fatalf("stream proof verify: %v", err)
	}

	streamProof := streamProofGeneric.(*groth16_bls12381.Proof)
	if len(streamProof.Commitments) != len(typedPK.CommitmentKeys) {
		t.Fatalf("commitments len = %d, want %d", len(streamProof.Commitments), len(typedPK.CommitmentKeys))
	}
	streamChallenge, streamDST, err := prover.CommitmentChallenge(streamProofGeneric)
	if err != nil {
		t.Fatal(err)
	}
	if streamDST != "bsb22-commitment" {
		t.Fatalf("challenge DST = %q", streamDST)
	}
	if len(streamChallenge) != 32 {
		t.Fatalf("challenge len = %d, want 32", len(streamChallenge))
	}
}
