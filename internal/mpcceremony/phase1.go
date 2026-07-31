package mpcceremony

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"

	gnarkmpc "github.com/consensys/gnark/backend/groth16/bls12-381/mpcsetup"
)

const contributionChallengeSize = sha256.Size

// Phase1Loader returns a freshly decoded contribution by zero-based ordinal.
// File-oriented callers should implement it with the strict preflight reader.
// Loader-based APIs keep fewer than 20 production-sized states from all being
// retained in memory at once.
type Phase1Loader func(index int) (*gnarkmpc.Phase1, error)

// InitializePhase1 returns gnark's deterministic Powers-of-Tau genesis state
// and the exact strict-reader shape for its canonical encoding.
func InitializePhase1(domainN uint64) (*gnarkmpc.Phase1, Phase1Shape, error) {
	if err := validateDomainN(domainN); err != nil {
		return nil, Phase1Shape{}, fmt.Errorf("initialize Phase 1: %w", err)
	}
	initial := gnarkmpc.NewPhase1(domainN)
	shape := Phase1Shape{DomainN: domainN, ChallengeLength: 0}
	if err := shape.Validate(); err != nil {
		return nil, Phase1Shape{}, fmt.Errorf("initial Phase 1 shape: %w", err)
	}
	return initial, shape, nil
}

// ReplayPhase1 verifies every Phase 1 transition from gnark's deterministic
// genesis state. The supplied contribution objects are never mutated.
func ReplayPhase1(domainN uint64, contributions []*gnarkmpc.Phase1) error {
	_, err := replayPhase1State(domainN, len(contributions), phase1SliceLoader(contributions))
	return err
}

// ReplayPhase1Loaded is the streaming-loader form of ReplayPhase1.
func ReplayPhase1Loaded(domainN uint64, contributionCount int, load Phase1Loader) error {
	_, err := replayPhase1State(domainN, contributionCount, load)
	return err
}

// ContributePhase1 verifies the complete existing chain and returns one fresh
// contribution derived from its head. Neither the chain nor its head is
// mutated.
//
// gnark obtains contribution randomness from crypto/rand through
// fr.Element.SetRandom. A failure in that path is reported as an error rather
// than allowing a panic to escape the engine boundary.
func ContributePhase1(domainN uint64, contributions []*gnarkmpc.Phase1) (*gnarkmpc.Phase1, error) {
	return ContributePhase1Loaded(domainN, len(contributions), phase1SliceLoader(contributions))
}

// ContributePhase1Loaded is the streaming-loader form of ContributePhase1.
func ContributePhase1Loaded(domainN uint64, contributionCount int, load Phase1Loader) (*gnarkmpc.Phase1, error) {
	head, err := replayPhase1State(domainN, contributionCount, load)
	if err != nil {
		return nil, err
	}

	next := new(gnarkmpc.Phase1)
	if err := streamClone(head, next); err != nil {
		return nil, fmt.Errorf("clone Phase 1 head: %w", err)
	}
	if err := runGnarkMutation("Phase 1 contribution", next.Contribute); err != nil {
		return nil, err
	}
	if err := requireContributionChallenge(next.Challenge, "new Phase 1 contribution"); err != nil {
		return nil, err
	}

	// Verify the generated update before handing it to the caller. Verify may
	// assign next.Challenge, but next is the newly allocated result, not an
	// archived input.
	if err := runGnarkVerification("verify new Phase 1 contribution", func() error {
		return head.Verify(next)
	}); err != nil {
		return nil, fmt.Errorf("verify new Phase 1 contribution: %w", err)
	}
	return next, nil
}

// SealPhase1 verifies the complete Phase 1 chain and applies an exact 32-byte
// public beacon challenge to a private clone of its head. At least one
// contribution is required; beacon-only setup is intentionally excluded from
// the production engine.
func SealPhase1(domainN uint64, beaconChallenge []byte, contributions []*gnarkmpc.Phase1) (*gnarkmpc.SrsCommons, error) {
	return SealPhase1Loaded(domainN, beaconChallenge, len(contributions), phase1SliceLoader(contributions))
}

// SealPhase1Loaded is the streaming-loader form of SealPhase1.
func SealPhase1Loaded(
	domainN uint64,
	beaconChallenge []byte,
	contributionCount int,
	load Phase1Loader,
) (*gnarkmpc.SrsCommons, error) {
	if err := requireBeaconChallenge(beaconChallenge); err != nil {
		return nil, err
	}
	if contributionCount == 0 {
		return nil, errors.New("seal Phase 1: at least one contribution is required")
	}
	head, err := replayPhase1State(domainN, contributionCount, load)
	if err != nil {
		return nil, err
	}

	return sealReplayedPhase1Head(domainN, beaconChallenge, head)
}

// sealReplayedPhase1Head consumes a freshly replayed head. gnark's Seal
// intentionally mutates that head, so callers must not retain or reuse it.
func sealReplayedPhase1Head(
	domainN uint64,
	beaconChallenge []byte,
	head *gnarkmpc.Phase1,
) (*gnarkmpc.SrsCommons, error) {
	if err := validateDomainN(domainN); err != nil {
		return nil, fmt.Errorf("seal Phase 1: %w", err)
	}
	if err := requireBeaconChallenge(beaconChallenge); err != nil {
		return nil, err
	}
	if head == nil {
		return nil, errors.New("seal Phase 1: replayed head is required")
	}
	var commons gnarkmpc.SrsCommons
	if err := runGnarkMutation("seal Phase 1", func() {
		commons = head.Seal(bytes.Clone(beaconChallenge))
	}); err != nil {
		return nil, err
	}
	if err := validateCommonsDomain(&commons, domainN); err != nil {
		return nil, fmt.Errorf("sealed Phase 1 commons: %w", err)
	}
	return &commons, nil
}

func replayPhase1State(domainN uint64, contributionCount int, load Phase1Loader) (*gnarkmpc.Phase1, error) {
	if err := validateDomainN(domainN); err != nil {
		return nil, fmt.Errorf("replay Phase 1: %w", err)
	}
	if contributionCount < 0 {
		return nil, fmt.Errorf("replay Phase 1: contribution count %d is negative", contributionCount)
	}
	if contributionCount > 0 && load == nil {
		return nil, errors.New("replay Phase 1: contribution loader is required")
	}

	previous, _, err := InitializePhase1(domainN)
	if err != nil {
		return nil, err
	}
	for i := 0; i < contributionCount; i++ {
		archived, err := load(i)
		if err != nil {
			return nil, fmt.Errorf("load Phase 1 contribution %d: %w", i+1, err)
		}
		if archived == nil {
			return nil, fmt.Errorf("replay Phase 1 contribution %d: nil contribution", i+1)
		}
		if err := requireContributionChallenge(archived.Challenge, fmt.Sprintf("Phase 1 contribution %d", i+1)); err != nil {
			return nil, err
		}

		next := new(gnarkmpc.Phase1)
		if err := streamClone(archived, next); err != nil {
			return nil, fmt.Errorf("clone Phase 1 contribution %d: %w", i+1, err)
		}
		if err := verifyPhase1Transition(domainN, previous, next); err != nil {
			return nil, fmt.Errorf("verify Phase 1 contribution %d: %w", i+1, err)
		}
		previous = next
	}
	return previous, nil
}

func verifyPhase1Transition(
	domainN uint64,
	previous *gnarkmpc.Phase1,
	next *gnarkmpc.Phase1,
) error {
	if err := validateDomainN(domainN); err != nil {
		return err
	}
	if previous == nil || next == nil {
		return errors.New("Phase 1 transition requires previous and next states")
	}
	if err := requireContributionChallenge(next.Challenge, "Phase 1 transition"); err != nil {
		return err
	}
	if err := runGnarkVerification(
		"verify Phase 1 transition",
		func() error { return previous.Verify(next) },
	); err != nil {
		return err
	}
	return nil
}

func phase1SliceLoader(contributions []*gnarkmpc.Phase1) Phase1Loader {
	return func(index int) (*gnarkmpc.Phase1, error) {
		if index < 0 || index >= len(contributions) {
			return nil, fmt.Errorf("contribution index %d outside [0,%d)", index, len(contributions))
		}
		return contributions[index], nil
	}
}

func validateCommonsDomain(commons *gnarkmpc.SrsCommons, domainN uint64) error {
	if commons == nil {
		return errors.New("SRS commons are required")
	}
	if err := validateDomainN(domainN); err != nil {
		return err
	}
	checks := []struct {
		name string
		got  int
		want uint64
	}{
		{name: "G1 Tau", got: len(commons.G1.Tau), want: 2*domainN - 1},
		{name: "G1 AlphaTau", got: len(commons.G1.AlphaTau), want: domainN},
		{name: "G1 BetaTau", got: len(commons.G1.BetaTau), want: domainN},
		{name: "G2 Tau", got: len(commons.G2.Tau), want: domainN},
	}
	for _, check := range checks {
		if uint64(check.got) != check.want {
			return fmt.Errorf("%s length %d, want %d for domain %d", check.name, check.got, check.want, domainN)
		}
	}
	return nil
}

func validateDomainN(domainN uint64) error {
	return validateDomain(domainN)
}

func requireContributionChallenge(challenge []byte, label string) error {
	if len(challenge) != contributionChallengeSize {
		return fmt.Errorf("%s challenge is %d bytes, want %d", label, len(challenge), contributionChallengeSize)
	}
	return nil
}

func requireBeaconChallenge(challenge []byte) error {
	if len(challenge) != contributionChallengeSize {
		return fmt.Errorf("beacon challenge is %d bytes, want %d", len(challenge), contributionChallengeSize)
	}
	return nil
}

// streamClone makes a canonical serialization round trip without buffering a
// production-sized transcript in memory. The destination must be a fresh,
// zero-valued object of the corresponding type.
func streamClone(src io.WriterTo, dst io.ReaderFrom) error {
	if src == nil || dst == nil {
		return errors.New("clone source and destination are required")
	}

	reader, writer := io.Pipe()
	type writeResult struct {
		n   int64
		err error
	}
	written := make(chan writeResult, 1)
	go func() {
		var result writeResult
		defer func() {
			_ = writer.CloseWithError(result.err)
			written <- result
		}()
		result.n, result.err = writeToWithPanicBoundary("serialize transcript", src, writer)
	}()

	readN, readErr := readFromWithPanicBoundary("deserialize transcript", dst, reader)
	if readErr != nil {
		_ = reader.CloseWithError(readErr)
		result := <-written
		if result.err != nil {
			return fmt.Errorf("read transcript: %w (writer: %v)", readErr, result.err)
		}
		return fmt.Errorf("read transcript: %w", readErr)
	}
	trailing, drainErr := io.Copy(io.Discard, reader)
	closeErr := reader.Close()
	result := <-written
	if result.err != nil {
		return fmt.Errorf("write transcript: %w", result.err)
	}
	if drainErr != nil {
		return fmt.Errorf("check transcript EOF: %w", drainErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close transcript reader: %w", closeErr)
	}
	if trailing != 0 {
		return fmt.Errorf("transcript has %d trailing bytes", trailing)
	}
	if readN != result.n {
		return fmt.Errorf("transcript byte count mismatch: read %d, wrote %d", readN, result.n)
	}
	return nil
}

func runGnarkMutation(label string, mutate func()) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("%s panic: %v", label, recovered)
		}
	}()
	mutate()
	return nil
}

// runGnarkVerification keeps panics from the upstream verifier—including
// crypto/rand or pairing failures—inside the error-returning engine boundary.
// The caller must still supply a clone when the upstream verifier mutates its
// argument while assigning the expected transcript challenge.
func runGnarkVerification(label string, verify func() error) (err error) {
	if verify == nil {
		return fmt.Errorf("%s callback is required", label)
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("%s panic: %v", label, recovered)
		}
	}()
	return verify()
}
