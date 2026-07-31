package mpcceremony

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"testing"

	curve "github.com/consensys/gnark-crypto/ecc/bls12-381"
	cryptompc "github.com/consensys/gnark-crypto/ecc/bls12-381/mpcsetup"
	gnarkmpc "github.com/consensys/gnark/backend/groth16/bls12-381/mpcsetup"
)

func TestExpectedArtifactSizes(t *testing.T) {
	t.Parallel()

	phase1Initial := Phase1Shape{DomainN: 2}
	if got, err := ExpectedPhase1Size(phase1Initial); err != nil || got != 921 {
		t.Fatalf("initial Phase 1 size = %d, %v; want 921", got, err)
	}
	phase1Contribution := Phase1Shape{DomainN: 2, ChallengeLength: 32}
	if got, err := ExpectedPhase1Size(phase1Contribution); err != nil || got != 953 {
		t.Fatalf("contributed Phase 1 size = %d, %v; want 953", got, err)
	}
	if got, err := ExpectedCommonsSize(CommonsShape{DomainN: 2}); err != nil || got != 488 {
		t.Fatalf("commons size = %d, %v; want 488", got, err)
	}

	phase2 := Phase2Shape{
		Commitments:     1,
		PKK:             2,
		Z:               1,
		SigmaCKK:        []uint32{1},
		ChallengeLength: 32,
	}
	if got, err := ExpectedPhase2Size(phase2); err != nil || got != 767 {
		t.Fatalf("Phase 2 size = %d, %v; want 767", got, err)
	}
}

func TestShapeValidationRejectsUnsafeBounds(t *testing.T) {
	t.Parallel()

	for _, n := range []uint64{0, 1, 3, MaxDomainN + 1} {
		if err := (Phase1Shape{DomainN: n}).Validate(); !errors.Is(err, ErrInvalidShape) {
			t.Errorf("domain %d error = %v; want ErrInvalidShape", n, err)
		}
	}
	if err := (Phase2Shape{
		Commitments: 256,
		SigmaCKK:    make([]uint32, 256),
	}).Validate(); !errors.Is(err, ErrInvalidShape) {
		t.Fatalf("256 commitments error = %v; want ErrInvalidShape", err)
	}
	if err := (Phase2Shape{Commitments: 1}).Validate(); !errors.Is(err, ErrInvalidShape) {
		t.Fatalf("missing SigmaCKK error = %v; want ErrInvalidShape", err)
	}
	if _, err := ExpectedPhase2Size(Phase2Shape{
		Commitments: 1,
		PKK:         math.MaxUint32,
		SigmaCKK:    []uint32{math.MaxUint32},
	}); !errors.Is(err, ErrArtifactTooLarge) {
		t.Fatalf("oversize Phase 2 error = %v; want ErrArtifactTooLarge", err)
	}
}

func TestPreflightPhase1CanonicalAndHostileDomain(t *testing.T) {
	t.Parallel()

	initial := gnarkmpc.NewPhase1(2)
	encoded := writeNative(t, initial)
	shape := Phase1Shape{DomainN: 2}

	digest, err := PreflightPhase1(bytes.NewReader(encoded), shape)
	if err != nil {
		t.Fatalf("preflight canonical Phase 1: %v", err)
	}
	if digest.Size != int64(len(encoded)) || len(digest.Challenge) != 0 {
		t.Fatalf("unexpected digest: %+v", digest)
	}

	for name, domain := range map[string]uint64{
		"zero":        0,
		"one":         1,
		"non-power":   3,
		"huge":        math.MaxUint64,
		"wrong-valid": 4,
	} {
		t.Run(name, func(t *testing.T) {
			mutated := bytes.Clone(encoded)
			// Three UpdateProofs, each one compressed G1 and G2.
			binary.BigEndian.PutUint64(mutated[3*(48+96):], domain)
			if _, err := PreflightPhase1(bytes.NewReader(mutated), shape); !errors.Is(err, ErrInvalidShape) {
				t.Fatalf("error = %v; want ErrInvalidShape", err)
			}
		})
	}
}

func TestPreflightRejectsNonCanonicalTrailingAndTruncatedPhase1(t *testing.T) {
	t.Parallel()

	initial := gnarkmpc.NewPhase1(2)
	encoded := writeNative(t, initial)
	shape := Phase1Shape{DomainN: 2}

	uncompressed := bytes.Clone(encoded)
	uncompressed[0] = 0x40
	if _, err := PreflightPhase1(bytes.NewReader(uncompressed), shape); !errors.Is(err, ErrNonCanonicalPoint) {
		t.Fatalf("uncompressed point error = %v; want ErrNonCanonicalPoint", err)
	}

	withTrailing := append(bytes.Clone(encoded), 0)
	if _, err := PreflightPhase1(bytes.NewReader(withTrailing), shape); !errors.Is(err, ErrTrailingData) {
		t.Fatalf("trailing error = %v; want ErrTrailingData", err)
	}

	for _, cut := range []int{0, 1, 143, 432, len(encoded) - 1} {
		if _, err := PreflightPhase1(bytes.NewReader(encoded[:cut]), shape); err == nil {
			t.Fatalf("truncation at %d unexpectedly accepted", cut)
		}
	}
}

func TestPreflightPhase1ContributionChallenge(t *testing.T) {
	t.Parallel()

	contribution := gnarkmpc.NewPhase1(2)
	contribution.Contribute()
	encoded := writeNative(t, contribution)
	shape := Phase1Shape{DomainN: 2, ChallengeLength: 32}
	digest, err := PreflightPhase1(bytes.NewReader(encoded), shape)
	if err != nil {
		t.Fatalf("preflight contribution: %v", err)
	}
	if !bytes.Equal(digest.Challenge, contribution.Challenge) {
		t.Fatal("preflight challenge differs from native contribution")
	}

	wrongShape := shape
	wrongShape.ChallengeLength = 0
	if _, err := PreflightPhase1(bytes.NewReader(encoded), wrongShape); err == nil {
		t.Fatal("contribution accepted as zero-challenge genesis")
	}
}

func TestPreflightCommons(t *testing.T) {
	t.Parallel()

	phase1 := gnarkmpc.NewPhase1(2)
	commons := phase1.Seal([]byte("test beacon"))
	encoded := writeNative(t, &commons)

	if _, err := PreflightCommons(bytes.NewReader(encoded), CommonsShape{DomainN: 2}); err != nil {
		t.Fatalf("preflight commons: %v", err)
	}
	mutated := bytes.Clone(encoded)
	binary.BigEndian.PutUint64(mutated, math.MaxUint64)
	if _, err := PreflightCommons(bytes.NewReader(mutated), CommonsShape{DomainN: 2}); !errors.Is(err, ErrInvalidShape) {
		t.Fatalf("hostile commons domain error = %v; want ErrInvalidShape", err)
	}
}

func TestPreflightPhase2ChecksEveryLengthPrefix(t *testing.T) {
	t.Parallel()

	phase2, shape := smallPhase2(32)
	encoded := writeNative(t, phase2)
	if got := int64(len(encoded)); got != 767 {
		t.Fatalf("encoded Phase 2 size = %d; want 767", got)
	}
	if _, err := PreflightPhase2(bytes.NewReader(encoded), shape); err != nil {
		t.Fatalf("preflight Phase 2: %v", err)
	}

	mutateUint16 := func(offset int, value uint16) []byte {
		out := bytes.Clone(encoded)
		binary.BigEndian.PutUint16(out[offset:], value)
		return out
	}
	mutateUint32 := func(offset int, value uint32) []byte {
		out := bytes.Clone(encoded)
		binary.BigEndian.PutUint32(out[offset:], value)
		return out
	}

	// Layout before vector payloads:
	// commitments(2), DeltaG1(48), PKK length(4), PKK(2*48),
	// Z length(4), Z(48), DeltaG2(96), SigmaCKK length(4).
	pkkOffset := 2 + 48
	zOffset := pkkOffset + 4 + 2*48
	sigmaCKKOffset := zOffset + 4 + 48 + 96
	cases := map[string][]byte{
		"commitments": mutateUint16(0, math.MaxUint16),
		"PKK":         mutateUint32(pkkOffset, math.MaxUint32),
		"Z":           mutateUint32(zOffset, math.MaxUint32),
		"SigmaCKK":    mutateUint32(sigmaCKKOffset, math.MaxUint32),
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := PreflightPhase2(bytes.NewReader(input), shape); !errors.Is(err, ErrInvalidShape) {
				t.Fatalf("error = %v; want ErrInvalidShape", err)
			}
		})
	}
}

func TestPreflightPhase2RejectsTrailingAndUncompressed(t *testing.T) {
	t.Parallel()

	phase2, shape := smallPhase2(32)
	encoded := writeNative(t, phase2)

	uncompressed := bytes.Clone(encoded)
	uncompressed[2] = 0x40
	if _, err := PreflightPhase2(bytes.NewReader(uncompressed), shape); !errors.Is(err, ErrNonCanonicalPoint) {
		t.Fatalf("uncompressed error = %v; want ErrNonCanonicalPoint", err)
	}
	if _, err := PreflightPhase2(bytes.NewReader(append(encoded, 0)), shape); !errors.Is(err, ErrTrailingData) {
		t.Fatalf("trailing error = %v; want ErrTrailingData", err)
	}
	if _, err := PreflightPhase2(bytes.NewReader(encoded[:len(encoded)-1]), shape); err == nil {
		t.Fatal("truncated challenge unexpectedly accepted")
	}
}

func writeNative(t *testing.T, artifact io.WriterTo) []byte {
	t.Helper()
	var buf bytes.Buffer
	n, err := artifact.WriteTo(&buf)
	if err != nil {
		t.Fatalf("write native artifact: %v", err)
	}
	if n != int64(buf.Len()) {
		t.Fatalf("native count = %d, buffer = %d", n, buf.Len())
	}
	return buf.Bytes()
}

func smallPhase2(challengeLength int) (*gnarkmpc.Phase2, Phase2Shape) {
	p := new(gnarkmpc.Phase2)
	p.Parameters.G1.PKK = make([]curve.G1Affine, 2)
	p.Parameters.G1.Z = make([]curve.G1Affine, 1)
	p.Parameters.G1.SigmaCKK = [][]curve.G1Affine{make([]curve.G1Affine, 1)}
	p.Parameters.G2.Sigma = make([]curve.G2Affine, 1)
	p.Sigmas = make([]cryptompc.UpdateProof, 1)
	p.Challenge = make([]byte, challengeLength)
	return p, Phase2Shape{
		Commitments:     1,
		PKK:             2,
		Z:               1,
		SigmaCKK:        []uint32{1},
		ChallengeLength: uint8(challengeLength),
	}
}
