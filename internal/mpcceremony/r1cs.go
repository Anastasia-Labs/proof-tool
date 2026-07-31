package mpcceremony

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/constraint"
	bls12381cs "github.com/consensys/gnark/constraint/bls12-381"
	"golang.org/x/crypto/blake2b"

	"proof-tool/internal/keyprofile"
	"proof-tool/internal/prover"
)

const destinationV2CommitmentCount = 1

// CompiledCircuit couples the concrete gnark BLS12-381 R1CS used by the MPC
// engine with the exact public binding that must appear in the signed ceremony
// definition.
type CompiledCircuit struct {
	R1CS    *bls12381cs.R1CS
	Binding CircuitBinding

	validated bool
}

// CompileDestinationV2 compiles the repository's production destination-v2
// profile and derives its exact serialized R1CS identity and Phase 2 shape.
func CompileDestinationV2() (*CompiledCircuit, error) {
	profile, err := keyprofile.ForKeyVersion(prover.DefaultDestinationKeyVersion)
	if err != nil {
		return nil, fmt.Errorf("resolve destination-v2 circuit profile: %w", err)
	}
	if profile.KeyVersion != KeyVersionDestinationV2 || profile.CircuitID != CircuitIDDestinationV2 {
		return nil, fmt.Errorf(
			"destination-v2 profile identity is key_version=%q circuit_id=%q",
			profile.KeyVersion,
			profile.CircuitID,
		)
	}
	compiled, err := profile.Compile()
	if err != nil {
		return nil, fmt.Errorf("compile destination-v2 circuit: %w", err)
	}
	return bindDestinationV2R1CS(compiled)
}

// BindDestinationV2R1CS validates a loaded or independently compiled
// constraint system using the same curve, shape, and digest rules as
// CompileDestinationV2. Callers must still compare the resulting Binding to
// the signed ceremony definition before accepting externally supplied bytes.
func BindDestinationV2R1CS(compiled constraint.ConstraintSystem) (*CompiledCircuit, error) {
	return bindDestinationV2R1CS(compiled)
}

// ValidateCircuitBinding requires every field of the runtime circuit binding
// to match the signed expected binding. This includes both hashes and the exact
// native serialization size, not only circuit labels or counts.
func ValidateCircuitBinding(circuit *CompiledCircuit, expected CircuitBinding) error {
	if err := validateCompiledCircuit(circuit); err != nil {
		return err
	}
	if err := expected.Validate(); err != nil {
		return fmt.Errorf("expected circuit binding: %w", err)
	}
	if err := circuit.Binding.Validate(); err != nil {
		return fmt.Errorf("compiled circuit binding: %w", err)
	}
	if !equalCircuitBinding(circuit.Binding, expected) {
		return fmt.Errorf("compiled circuit binding does not match signed ceremony definition")
	}
	return nil
}

// ReadR1CSFile authenticates an exact-size frozen native gnark constraint
// system against a signed destination-v2 binding before decoding it. The
// digest check intentionally precedes native decoding, whose vector lengths
// are not safe to accept from an unauthenticated file.
func ReadR1CSFile(path string, expected CircuitBinding) (*CompiledCircuit, error) {
	if err := expected.Validate(); err != nil {
		return nil, fmt.Errorf("expected circuit binding: %w", err)
	}
	if expected.R1CS.Digest.Size > MaxArtifactSize {
		return nil, fmt.Errorf(
			"frozen R1CS is %d bytes, exceeds limit %d",
			expected.R1CS.Digest.Size,
			MaxArtifactSize,
		)
	}
	file, digest, err := preflightR1CSFile(path, expected.R1CS.Digest)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	ccs := groth16.NewCS(ecc.BLS12_381)
	native, ok := ccs.(*bls12381cs.R1CS)
	if !ok {
		return nil, fmt.Errorf("new BLS12-381 constraint system type is %T", ccs)
	}
	if err := nativeReadExact(
		io.NewSectionReader(file, 0, digest.Size),
		digest.Size,
		native,
	); err != nil {
		return nil, fmt.Errorf("decode frozen R1CS %q: %w", path, err)
	}
	compiled, err := bindDestinationV2R1CS(native)
	if err != nil {
		return nil, fmt.Errorf("validate frozen R1CS %q: %w", path, err)
	}
	if err := ValidateCircuitBinding(compiled, expected); err != nil {
		return nil, fmt.Errorf("frozen R1CS %q: %w", path, err)
	}
	return compiled, nil
}

// WriteR1CSFileNoReplace writes the exact native gnark R1CS, syncs it, reads
// it back through ReadR1CSFile, and atomically publishes it without replacing
// any existing path.
func WriteR1CSFileNoReplace(path string, circuit *CompiledCircuit) (Digest, error) {
	if err := validateCompiledCircuit(circuit); err != nil {
		return Digest{}, err
	}
	if filepath.Base(path) != circuit.Binding.R1CS.Name {
		return Digest{}, fmt.Errorf(
			"frozen R1CS output name %q, want %q",
			filepath.Base(path),
			circuit.Binding.R1CS.Name,
		)
	}

	_, err := atomicWriteNoReplace(
		path,
		circuit.Binding.R1CS.Digest.Size,
		circuit.R1CS.WriteTo,
		func(tempPath string) (ArtifactDigest, error) {
			if _, err := ReadR1CSFile(tempPath, circuit.Binding); err != nil {
				return ArtifactDigest{}, err
			}
			return artifactDigestFromModel(circuit.Binding.R1CS.Digest)
		},
	)
	if err != nil {
		return Digest{}, err
	}
	return circuit.Binding.R1CS.Digest, nil
}

func bindDestinationV2R1CS(compiled constraint.ConstraintSystem) (*CompiledCircuit, error) {
	if compiled == nil {
		return nil, errors.New("constraint system is required")
	}
	native, ok := compiled.(*bls12381cs.R1CS)
	if !ok {
		return nil, fmt.Errorf("constraint system type is %T, want *bls12-381.R1CS", compiled)
	}
	if native.Field().Cmp(ecc.BLS12_381.ScalarField()) != 0 {
		return nil, errors.New("constraint system scalar field is not BLS12-381")
	}
	if native.GetNbConstraints() <= 0 {
		return nil, fmt.Errorf("constraint system has %d constraints", native.GetNbConstraints())
	}

	constraints := uint64(native.GetNbConstraints())
	domainN := ecc.NextPowerOfTwo(constraints)
	if err := validateDomain(domainN); err != nil {
		return nil, fmt.Errorf("constraint system domain: %w", err)
	}

	internal, secret, public := native.GetNbVariables()
	if internal <= 0 || secret <= 0 || public <= 0 {
		return nil, fmt.Errorf(
			"constraint system variable counts must be positive: internal=%d secret=%d public=%d",
			internal,
			secret,
			public,
		)
	}
	commitments, err := groth16Commitments(native)
	if err != nil {
		return nil, err
	}
	if len(commitments) != destinationV2CommitmentCount {
		return nil, fmt.Errorf(
			"destination-v2 constraint system has %d commitments, want %d",
			len(commitments),
			destinationV2CommitmentCount,
		)
	}

	digest, err := digestR1CS(native)
	if err != nil {
		return nil, err
	}
	phase2Shape, err := phase2ShapeFromR1CS(native, domainN, commitments)
	if err != nil {
		return nil, err
	}
	binding := CircuitBinding{
		KeyVersion:        KeyVersionDestinationV2,
		CircuitID:         CircuitIDDestinationV2,
		Curve:             CurveBLS12381,
		Backend:           BackendGroth16,
		R1CS:              ArtifactRef{Name: prover.DestinationConstraintSystemFile, Digest: digest},
		Constraints:       constraints,
		InternalVariables: uint64(internal),
		SecretVariables:   uint64(secret),
		PublicVariables:   uint64(public),
		DomainSize:        domainN,
		Phase2Shape:       phase2Shape,
	}
	if err := binding.Validate(); err != nil {
		return nil, fmt.Errorf("derived destination-v2 circuit binding: %w", err)
	}
	return &CompiledCircuit{R1CS: native, Binding: binding, validated: true}, nil
}

func validateCompiledCircuit(circuit *CompiledCircuit) error {
	if circuit == nil || circuit.R1CS == nil {
		return errors.New("compiled BLS12-381 circuit is required")
	}
	if !circuit.validated {
		return errors.New("compiled circuit was not created by an exact MPC circuit binder")
	}
	if err := circuit.Binding.Validate(); err != nil {
		return fmt.Errorf("compiled circuit binding: %w", err)
	}
	if circuit.R1CS.Field().Cmp(ecc.BLS12_381.ScalarField()) != 0 {
		return errors.New("compiled circuit scalar field is not BLS12-381")
	}
	if uint64(circuit.R1CS.GetNbConstraints()) != circuit.Binding.Constraints {
		return fmt.Errorf(
			"compiled circuit constraints %d, binding pins %d",
			circuit.R1CS.GetNbConstraints(),
			circuit.Binding.Constraints,
		)
	}
	internal, secret, public := circuit.R1CS.GetNbVariables()
	if uint64(internal) != circuit.Binding.InternalVariables ||
		uint64(secret) != circuit.Binding.SecretVariables ||
		uint64(public) != circuit.Binding.PublicVariables {
		return errors.New("compiled circuit variable counts do not match binding")
	}
	if got := ecc.NextPowerOfTwo(uint64(circuit.R1CS.GetNbConstraints())); got != circuit.Binding.DomainSize {
		return fmt.Errorf("compiled circuit domain %d, binding pins %d", got, circuit.Binding.DomainSize)
	}
	commitments, err := groth16Commitments(circuit.R1CS)
	if err != nil {
		return err
	}
	shape, err := phase2ShapeFromR1CS(circuit.R1CS, circuit.Binding.DomainSize, commitments)
	if err != nil {
		return err
	}
	if !equalPhase2Shape(shape, circuit.Binding.Phase2Shape) {
		return errors.New("compiled circuit Phase 2 shape does not match binding")
	}
	return nil
}

func preflightR1CSFile(path string, expected Digest) (*os.File, ArtifactDigest, error) {
	if err := expected.Validate(); err != nil {
		return nil, ArtifactDigest{}, fmt.Errorf("expected R1CS digest: %w", err)
	}
	file, err := openRegularExact(path, expected.Size)
	if err != nil {
		return nil, ArtifactDigest{}, err
	}
	sha := sha256.New()
	blake, err := blake2b.New256(nil)
	if err != nil {
		file.Close()
		return nil, ArtifactDigest{}, fmt.Errorf("initialize BLAKE2b-256: %w", err)
	}
	size, err := io.Copy(
		io.MultiWriter(sha, blake),
		io.NewSectionReader(file, 0, expected.Size),
	)
	if err != nil {
		file.Close()
		return nil, ArtifactDigest{}, fmt.Errorf("digest frozen R1CS %q: %w", path, err)
	}
	var digest ArtifactDigest
	digest.Size = size
	copy(digest.SHA256[:], sha.Sum(nil))
	copy(digest.BLAKE2b256[:], blake.Sum(nil))
	if got := modelDigestFromArtifact(digest); got != expected {
		file.Close()
		return nil, ArtifactDigest{}, fmt.Errorf("frozen R1CS %q digest does not match signed binding", path)
	}
	return file, digest, nil
}

func modelDigestFromArtifact(digest ArtifactDigest) Digest {
	return Digest{
		SHA256:     "sha256:" + hex.EncodeToString(digest.SHA256[:]),
		Blake2b256: "blake2b256:" + hex.EncodeToString(digest.BLAKE2b256[:]),
		Size:       digest.Size,
	}
}

func artifactDigestFromModel(digest Digest) (ArtifactDigest, error) {
	if err := digest.Validate(); err != nil {
		return ArtifactDigest{}, err
	}
	shaBytes, err := hex.DecodeString(strings.TrimPrefix(digest.SHA256, "sha256:"))
	if err != nil {
		return ArtifactDigest{}, err
	}
	blakeBytes, err := hex.DecodeString(strings.TrimPrefix(digest.Blake2b256, "blake2b256:"))
	if err != nil {
		return ArtifactDigest{}, err
	}
	var result ArtifactDigest
	result.Size = digest.Size
	copy(result.SHA256[:], shaBytes)
	copy(result.BLAKE2b256[:], blakeBytes)
	return result, nil
}

func groth16Commitments(r1cs *bls12381cs.R1CS) (constraint.Groth16Commitments, error) {
	commitments, ok := r1cs.CommitmentInfo.(constraint.Groth16Commitments)
	if !ok {
		return nil, fmt.Errorf(
			"constraint system commitment metadata type is %T, want constraint.Groth16Commitments",
			r1cs.CommitmentInfo,
		)
	}
	return commitments, nil
}

// phase2ShapeFromR1CS mirrors the length-only part of gnark v0.15.0
// mpcsetup.Phase2.Initialize. It avoids evaluating the full K=21 QAP merely
// to establish allocation-safe transcript bounds in the ceremony definition.
// engine_test checks this result against DerivePhase2Shape on an initialized
// committed circuit.
func phase2ShapeFromR1CS(
	r1cs *bls12381cs.R1CS,
	domainN uint64,
	commitments constraint.Groth16Commitments,
) (Phase2Shape, error) {
	if domainN == 0 || domainN > math.MaxUint32+1 {
		return Phase2Shape{}, fmt.Errorf("Phase 2 domain %d cannot be represented", domainN)
	}
	if len(commitments) > int(MaxPhase2Commitments) {
		return Phase2Shape{}, fmt.Errorf(
			"Phase 2 commitment count %d exceeds %d",
			len(commitments),
			MaxPhase2Commitments,
		)
	}

	internal, secret, _ := r1cs.GetNbVariables()
	committed := 0
	shape := Phase2Shape{
		Commitments:     uint16(len(commitments)),
		Z:               uint32(domainN - 1),
		SigmaCKK:        make([]uint32, len(commitments)),
		ChallengeLength: 0,
	}
	for i := range commitments {
		count := len(commitments[i].PrivateCommitted)
		if count > math.MaxUint32 {
			return Phase2Shape{}, fmt.Errorf("commitment %d private committed count %d exceeds uint32", i, count)
		}
		if committed > math.MaxInt-count {
			return Phase2Shape{}, errors.New("total private committed count overflows int")
		}
		committed += count
		shape.SigmaCKK[i] = uint32(count)
	}
	pkk := internal + secret - committed - len(commitments)
	if pkk < 0 || pkk > math.MaxUint32 {
		return Phase2Shape{}, fmt.Errorf("derived Phase 2 PKK length %d is invalid", pkk)
	}
	shape.PKK = uint32(pkk)
	if err := shape.Validate(); err != nil {
		return Phase2Shape{}, fmt.Errorf("derived Phase 2 shape: %w", err)
	}
	return shape, nil
}

func digestR1CS(r1cs *bls12381cs.R1CS) (Digest, error) {
	sha := sha256.New()
	blake, err := blake2b.New256(nil)
	if err != nil {
		return Digest{}, fmt.Errorf("initialize BLAKE2b-256: %w", err)
	}
	size, err := writeToWithPanicBoundary(
		"constraint-system encoder",
		r1cs,
		io.MultiWriter(sha, blake),
	)
	if err != nil {
		return Digest{}, fmt.Errorf("serialize constraint system: %w", err)
	}
	digest := Digest{
		SHA256:     "sha256:" + hex.EncodeToString(sha.Sum(nil)),
		Blake2b256: "blake2b256:" + hex.EncodeToString(blake.Sum(nil)),
		Size:       size,
	}
	if err := digest.Validate(); err != nil {
		return Digest{}, fmt.Errorf("constraint system digest: %w", err)
	}
	return digest, nil
}

func equalCircuitBinding(left, right CircuitBinding) bool {
	if left.KeyVersion != right.KeyVersion ||
		left.CircuitID != right.CircuitID ||
		left.Curve != right.Curve ||
		left.Backend != right.Backend ||
		left.R1CS != right.R1CS ||
		left.Constraints != right.Constraints ||
		left.InternalVariables != right.InternalVariables ||
		left.SecretVariables != right.SecretVariables ||
		left.PublicVariables != right.PublicVariables ||
		left.DomainSize != right.DomainSize {
		return false
	}
	return equalPhase2Shape(left.Phase2Shape, right.Phase2Shape)
}

func equalPhase2Shape(left, right Phase2Shape) bool {
	if left.Commitments != right.Commitments ||
		left.PKK != right.PKK ||
		left.Z != right.Z ||
		left.ChallengeLength != right.ChallengeLength ||
		len(left.SigmaCKK) != len(right.SigmaCKK) {
		return false
	}
	for i := range left.SigmaCKK {
		if left.SigmaCKK[i] != right.SigmaCKK[i] {
			return false
		}
	}
	return true
}
