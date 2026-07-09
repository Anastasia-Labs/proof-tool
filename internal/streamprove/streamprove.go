package streamprove

import (
	"fmt"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	groth16_bls12381 "github.com/consensys/gnark/backend/groth16/bls12-381"
	"github.com/consensys/gnark/constraint"
	cs_bls12381 "github.com/consensys/gnark/constraint/bls12-381"
	"github.com/consensys/gnark/frontend"

	"proof-tool/internal/streampk"
)

// Prove uses the vendored gnark ProveStream entrypoint while keeping the large
// proving-key point vectors in source instead of in the gnark ProvingKey shell.
func Prove(ccs constraint.ConstraintSystem, source *streampk.KeySource, assignment frontend.Circuit) (groth16.Proof, error) {
	if source == nil {
		return nil, fmt.Errorf("stream proving key source is required")
	}
	r1cs, ok := ccs.(*cs_bls12381.R1CS)
	if !ok {
		return nil, fmt.Errorf("constraint system has type %T, want *bls12-381.R1CS", ccs)
	}
	witness, err := frontend.NewWitness(assignment, ecc.BLS12_381.ScalarField())
	if err != nil {
		return nil, fmt.Errorf("new witness: %w", err)
	}

	pk := &groth16_bls12381.ProvingKey{}
	pk.Domain = source.Domain()
	pk.G1.Alpha = source.Alpha()
	pk.G1.Beta = source.Beta()
	pk.G1.Delta = source.Delta()
	pk.G2.Beta = source.G2Beta()
	pk.G2.Delta = source.G2Delta()
	pk.InfinityA = source.InfinityA()
	pk.InfinityB = source.InfinityB()
	pk.NbInfinityA = source.NbInfinityA()
	pk.NbInfinityB = source.NbInfinityB()
	pk.CommitmentKeys = source.CommitmentKeys()

	proof, err := groth16_bls12381.ProveStream(r1cs, pk, source, witness)
	if err != nil {
		return nil, fmt.Errorf("groth16 ProveStream: %w", err)
	}
	return proof, nil
}
