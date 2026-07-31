package mpcceremony

import (
	"errors"
	"fmt"
	"math"

	groth16bls "github.com/consensys/gnark/backend/groth16/bls12-381"
	gnarkmpc "github.com/consensys/gnark/backend/groth16/bls12-381/mpcsetup"
)

// Phase2Loader returns a freshly decoded contribution by zero-based ordinal.
// File-oriented callers should implement it with the strict preflight reader.
type Phase2Loader func(index int) (*gnarkmpc.Phase2, error)

// InitializePhase2 deterministically derives the circuit-specific Phase 2
// genesis state from the exact compiled circuit and sealed Phase 1 commons.
func InitializePhase2(circuit *CompiledCircuit, commons *gnarkmpc.SrsCommons) (*gnarkmpc.Phase2, Phase2Shape, error) {
	if err := validatePhase2Inputs(circuit, commons); err != nil {
		return nil, Phase2Shape{}, err
	}

	initial := new(gnarkmpc.Phase2)
	if err := runGnarkMutation("initialize Phase 2", func() {
		_ = initial.Initialize(circuit.R1CS, commons)
	}); err != nil {
		return nil, Phase2Shape{}, err
	}
	shape, err := DerivePhase2Shape(initial)
	if err != nil {
		return nil, Phase2Shape{}, fmt.Errorf("derive initial Phase 2 shape: %w", err)
	}
	if shape.ChallengeLength != 0 {
		return nil, Phase2Shape{}, fmt.Errorf("initial Phase 2 challenge is %d bytes, want 0", shape.ChallengeLength)
	}
	if !equalPhase2Shape(shape, circuit.Binding.Phase2Shape) {
		return nil, Phase2Shape{}, fmt.Errorf(
			"initialized Phase 2 shape %+v does not match circuit binding %+v",
			shape,
			circuit.Binding.Phase2Shape,
		)
	}
	return initial, shape, nil
}

// DerivePhase2Shape returns the serialization/preflight shape of a Phase 2
// object. It rejects inconsistent or non-representable slice lengths before
// they can be used as trusted preflight limits.
func DerivePhase2Shape(phase2 *gnarkmpc.Phase2) (Phase2Shape, error) {
	if phase2 == nil {
		return Phase2Shape{}, errors.New("Phase 2 object is required")
	}

	commitments := len(phase2.Parameters.G2.Sigma)
	if commitments > int(MaxPhase2Commitments) {
		return Phase2Shape{}, fmt.Errorf("Phase 2 commitments %d exceed %d", commitments, MaxPhase2Commitments)
	}
	if len(phase2.Parameters.G1.SigmaCKK) != commitments {
		return Phase2Shape{}, fmt.Errorf(
			"Phase 2 SigmaCKK count %d does not match Sigma count %d",
			len(phase2.Parameters.G1.SigmaCKK),
			commitments,
		)
	}
	if len(phase2.Sigmas) != commitments {
		return Phase2Shape{}, fmt.Errorf(
			"Phase 2 update-proof count %d does not match commitment count %d",
			len(phase2.Sigmas),
			commitments,
		)
	}
	if len(phase2.Parameters.G1.PKK) > math.MaxUint32 {
		return Phase2Shape{}, fmt.Errorf("Phase 2 PKK length %d exceeds uint32", len(phase2.Parameters.G1.PKK))
	}
	if len(phase2.Parameters.G1.Z) > math.MaxUint32 {
		return Phase2Shape{}, fmt.Errorf("Phase 2 Z length %d exceeds uint32", len(phase2.Parameters.G1.Z))
	}
	if len(phase2.Challenge) > math.MaxUint8 {
		return Phase2Shape{}, fmt.Errorf("Phase 2 challenge length %d exceeds uint8", len(phase2.Challenge))
	}

	shape := Phase2Shape{
		Commitments:     uint16(commitments),
		PKK:             uint32(len(phase2.Parameters.G1.PKK)),
		Z:               uint32(len(phase2.Parameters.G1.Z)),
		SigmaCKK:        make([]uint32, commitments),
		ChallengeLength: uint8(len(phase2.Challenge)),
	}
	for i := range phase2.Parameters.G1.SigmaCKK {
		if len(phase2.Parameters.G1.SigmaCKK[i]) > math.MaxUint32 {
			return Phase2Shape{}, fmt.Errorf(
				"Phase 2 SigmaCKK[%d] length %d exceeds uint32",
				i,
				len(phase2.Parameters.G1.SigmaCKK[i]),
			)
		}
		shape.SigmaCKK[i] = uint32(len(phase2.Parameters.G1.SigmaCKK[i]))
	}
	if err := shape.Validate(); err != nil {
		return Phase2Shape{}, fmt.Errorf("Phase 2 shape: %w", err)
	}
	return shape, nil
}

// ReplayPhase2 deterministically initializes Phase 2 and verifies every
// contribution in order. Supplied contribution objects are never mutated.
func ReplayPhase2(circuit *CompiledCircuit, commons *gnarkmpc.SrsCommons, contributions []*gnarkmpc.Phase2) error {
	_, _, err := replayPhase2State(circuit, commons, len(contributions), phase2SliceLoader(contributions))
	return err
}

// ReplayPhase2Loaded is the streaming-loader form of ReplayPhase2.
func ReplayPhase2Loaded(
	circuit *CompiledCircuit,
	commons *gnarkmpc.SrsCommons,
	contributionCount int,
	load Phase2Loader,
) error {
	_, _, err := replayPhase2State(circuit, commons, contributionCount, load)
	return err
}

// ContributePhase2 verifies the complete Phase 2 chain and returns a fresh
// contribution derived from its head. Neither the archived chain nor the
// sealed Phase 1 commons is mutated.
func ContributePhase2(circuit *CompiledCircuit, commons *gnarkmpc.SrsCommons, contributions []*gnarkmpc.Phase2) (*gnarkmpc.Phase2, error) {
	return ContributePhase2Loaded(circuit, commons, len(contributions), phase2SliceLoader(contributions))
}

// ContributePhase2Loaded is the streaming-loader form of ContributePhase2.
func ContributePhase2Loaded(
	circuit *CompiledCircuit,
	commons *gnarkmpc.SrsCommons,
	contributionCount int,
	load Phase2Loader,
) (*gnarkmpc.Phase2, error) {
	head, _, err := replayPhase2State(circuit, commons, contributionCount, load)
	if err != nil {
		return nil, err
	}

	next := new(gnarkmpc.Phase2)
	if err := streamClone(head, next); err != nil {
		return nil, fmt.Errorf("clone Phase 2 head: %w", err)
	}
	if err := runGnarkMutation("Phase 2 contribution", next.Contribute); err != nil {
		return nil, err
	}
	if err := requireContributionChallenge(next.Challenge, "new Phase 2 contribution"); err != nil {
		return nil, err
	}
	if err := requireSamePhase2Structure(head, next); err != nil {
		return nil, fmt.Errorf("new Phase 2 contribution shape: %w", err)
	}
	if err := runGnarkVerification("verify new Phase 2 contribution", func() error {
		return head.Verify(next)
	}); err != nil {
		return nil, fmt.Errorf("verify new Phase 2 contribution: %w", err)
	}
	return next, nil
}

// SealPhase2 verifies the complete chain, applies an exact 32-byte public
// beacon to a private clone of its head, and returns native gnark BLS12-381
// proving and verifying keys.
func SealPhase2(
	circuit *CompiledCircuit,
	commons *gnarkmpc.SrsCommons,
	beaconChallenge []byte,
	contributions []*gnarkmpc.Phase2,
) (*groth16bls.ProvingKey, *groth16bls.VerifyingKey, error) {
	return SealPhase2Loaded(
		circuit,
		commons,
		beaconChallenge,
		len(contributions),
		phase2SliceLoader(contributions),
	)
}

// SealPhase2Loaded is the streaming-loader form of SealPhase2.
func SealPhase2Loaded(
	circuit *CompiledCircuit,
	commons *gnarkmpc.SrsCommons,
	beaconChallenge []byte,
	contributionCount int,
	load Phase2Loader,
) (*groth16bls.ProvingKey, *groth16bls.VerifyingKey, error) {
	if err := requireBeaconChallenge(beaconChallenge); err != nil {
		return nil, nil, err
	}
	if contributionCount == 0 {
		return nil, nil, errors.New("seal Phase 2: at least one contribution is required")
	}

	head, evaluations, err := replayPhase2State(circuit, commons, contributionCount, load)
	if err != nil {
		return nil, nil, err
	}

	var provingKey, verifyingKey any
	if err := runGnarkMutation("seal Phase 2", func() {
		provingKey, verifyingKey = head.Seal(commons, evaluations, append([]byte(nil), beaconChallenge...))
	}); err != nil {
		return nil, nil, err
	}
	nativePK, ok := provingKey.(*groth16bls.ProvingKey)
	if !ok {
		return nil, nil, fmt.Errorf("seal Phase 2 proving key type is %T, want *bls12-381.ProvingKey", provingKey)
	}
	nativeVK, ok := verifyingKey.(*groth16bls.VerifyingKey)
	if !ok {
		return nil, nil, fmt.Errorf("seal Phase 2 verifying key type is %T, want *bls12-381.VerifyingKey", verifyingKey)
	}
	return nativePK, nativeVK, nil
}

func replayPhase2State(
	circuit *CompiledCircuit,
	commons *gnarkmpc.SrsCommons,
	contributionCount int,
	load Phase2Loader,
) (*gnarkmpc.Phase2, *gnarkmpc.Phase2Evaluations, error) {
	if err := validatePhase2Inputs(circuit, commons); err != nil {
		return nil, nil, err
	}
	if contributionCount < 0 {
		return nil, nil, fmt.Errorf("replay Phase 2: contribution count %d is negative", contributionCount)
	}
	if contributionCount > 0 && load == nil {
		return nil, nil, errors.New("replay Phase 2: contribution loader is required")
	}

	previous := new(gnarkmpc.Phase2)
	var evaluations gnarkmpc.Phase2Evaluations
	if err := runGnarkMutation("initialize Phase 2", func() {
		evaluations = previous.Initialize(circuit.R1CS, commons)
	}); err != nil {
		return nil, nil, err
	}
	initialShape, err := DerivePhase2Shape(previous)
	if err != nil {
		return nil, nil, fmt.Errorf("derive initial Phase 2 shape: %w", err)
	}
	if !equalPhase2Shape(initialShape, circuit.Binding.Phase2Shape) {
		return nil, nil, errors.New("initialized Phase 2 shape does not match circuit binding")
	}

	for i := 0; i < contributionCount; i++ {
		archived, err := load(i)
		if err != nil {
			return nil, nil, fmt.Errorf("load Phase 2 contribution %d: %w", i+1, err)
		}
		if archived == nil {
			return nil, nil, fmt.Errorf("replay Phase 2 contribution %d: nil contribution", i+1)
		}
		if err := requireContributionChallenge(archived.Challenge, fmt.Sprintf("Phase 2 contribution %d", i+1)); err != nil {
			return nil, nil, err
		}

		next := new(gnarkmpc.Phase2)
		if err := streamClone(archived, next); err != nil {
			return nil, nil, fmt.Errorf("clone Phase 2 contribution %d: %w", i+1, err)
		}
		if err := requirePhase2Structure(initialShape, next); err != nil {
			return nil, nil, fmt.Errorf("Phase 2 contribution %d shape: %w", i+1, err)
		}
		if err := verifyPhase2Transition(previous, next); err != nil {
			return nil, nil, fmt.Errorf("verify Phase 2 contribution %d: %w", i+1, err)
		}
		previous = next
	}
	return previous, &evaluations, nil
}

func verifyPhase2Transition(previous, next *gnarkmpc.Phase2) error {
	if previous == nil || next == nil {
		return errors.New("Phase 2 transition requires previous and next states")
	}
	if err := requireContributionChallenge(next.Challenge, "Phase 2 transition"); err != nil {
		return err
	}
	if err := requireSamePhase2Structure(previous, next); err != nil {
		return err
	}
	return runGnarkVerification(
		"verify Phase 2 transition",
		func() error { return previous.Verify(next) },
	)
}

func phase2SliceLoader(contributions []*gnarkmpc.Phase2) Phase2Loader {
	return func(index int) (*gnarkmpc.Phase2, error) {
		if index < 0 || index >= len(contributions) {
			return nil, fmt.Errorf("contribution index %d outside [0,%d)", index, len(contributions))
		}
		return contributions[index], nil
	}
}

func validatePhase2Inputs(circuit *CompiledCircuit, commons *gnarkmpc.SrsCommons) error {
	if err := validateCompiledCircuit(circuit); err != nil {
		return err
	}
	if commons == nil {
		return errors.New("sealed Phase 1 commons are required")
	}
	if err := validateDomainN(circuit.Binding.DomainSize); err != nil {
		return fmt.Errorf("compiled circuit domain: %w", err)
	}
	if err := validateCommonsDomain(commons, circuit.Binding.DomainSize); err != nil {
		return fmt.Errorf("sealed Phase 1 commons: %w", err)
	}
	return nil
}

func requireSamePhase2Structure(previous, next *gnarkmpc.Phase2) error {
	expected, err := DerivePhase2Shape(previous)
	if err != nil {
		return err
	}
	return requirePhase2Structure(expected, next)
}

func requirePhase2Structure(expected Phase2Shape, actual *gnarkmpc.Phase2) error {
	got, err := DerivePhase2Shape(actual)
	if err != nil {
		return err
	}
	// Contributions have a 32-byte challenge while genesis has none. The
	// remaining fields must be exactly invariant across the phase.
	gotChallengeLength := got.ChallengeLength
	got.ChallengeLength = expected.ChallengeLength
	if got.Commitments != expected.Commitments ||
		got.PKK != expected.PKK ||
		got.Z != expected.Z ||
		len(got.SigmaCKK) != len(expected.SigmaCKK) {
		return fmt.Errorf("got %+v, want structure %+v (challenge length %d)", got, expected, gotChallengeLength)
	}
	for i := range got.SigmaCKK {
		if got.SigmaCKK[i] != expected.SigmaCKK[i] {
			return fmt.Errorf(
				"SigmaCKK[%d] length %d, want %d",
				i,
				got.SigmaCKK[i],
				expected.SigmaCKK[i],
			)
		}
	}
	return nil
}
