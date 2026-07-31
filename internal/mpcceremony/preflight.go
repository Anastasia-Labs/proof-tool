package mpcceremony

import (
	"bufio"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash"
	"io"
	"math"
	"math/bits"

	"golang.org/x/crypto/blake2b"
)

const (
	// BLS12-381's scalar field has 2-adicity 32. Ceremonies in this package
	// must use a power-of-two FFT domain no larger than that.
	MaxDomainN uint64 = 1 << 32

	// gnark assigns a one-byte domain-separation tag to every Phase 2
	// commitment. More than 255 commitments aliases those tags.
	MaxPhase2Commitments uint16 = 255

	// MaxArtifactSize is an intentional fail-closed operational limit. Raising
	// it requires reviewing memory, disk and ceremony host requirements.
	MaxArtifactSize int64 = 16 << 30

	g1CompressedSize = uint64(48)
	g2CompressedSize = uint64(96)
	preflightBuffer  = 1 << 20
)

var (
	ErrInvalidShape      = errors.New("invalid MPC artifact shape")
	ErrArtifactTooLarge  = errors.New("MPC artifact exceeds size limit")
	ErrNonCanonicalPoint = errors.New("non-canonical compressed BLS12-381 point")
	ErrTrailingData      = errors.New("trailing data after MPC artifact")
)

// Phase1Shape is the public, allocation-safe shape needed to inspect a Phase 1
// transcript before handing it to gnark.
type Phase1Shape struct {
	DomainN         uint64
	ChallengeLength uint8
}

// CommonsShape is the public, allocation-safe shape of the sealed Phase 1
// common reference string.
type CommonsShape struct {
	DomainN uint64
}

// Phase2Shape is derived from a locally compiled, frozen R1CS. Never derive it
// from an untrusted Phase 2 artifact.
type Phase2Shape struct {
	Commitments     uint16
	PKK             uint32
	Z               uint32
	SigmaCKK        []uint32
	ChallengeLength uint8
}

// ArtifactDigest describes exactly the bytes inspected by a preflight or
// strict reader. Challenge is copied and may safely be retained by the caller.
type ArtifactDigest struct {
	Size       int64
	SHA256     [sha256.Size]byte
	BLAKE2b256 [blake2b.Size256]byte
	Challenge  []byte
}

func (s Phase1Shape) Validate() error {
	if err := validateDomain(s.DomainN); err != nil {
		return err
	}
	_, err := ExpectedPhase1Size(s)
	return err
}

func (s CommonsShape) Validate() error {
	if err := validateDomain(s.DomainN); err != nil {
		return err
	}
	_, err := ExpectedCommonsSize(s)
	return err
}

func (s Phase2Shape) Validate() error {
	if s.Commitments > MaxPhase2Commitments {
		return fmt.Errorf("%w: Phase 2 commitments %d exceed %d", ErrInvalidShape, s.Commitments, MaxPhase2Commitments)
	}
	if len(s.SigmaCKK) != int(s.Commitments) {
		return fmt.Errorf("%w: %d SigmaCKK lengths for %d commitments", ErrInvalidShape, len(s.SigmaCKK), s.Commitments)
	}
	_, err := ExpectedPhase2Size(s)
	return err
}

func validateDomain(n uint64) error {
	if n < 2 || n > MaxDomainN || n&(n-1) != 0 {
		return fmt.Errorf("%w: domain %d must be a power of two in [2,%d]", ErrInvalidShape, n, MaxDomainN)
	}
	return nil
}

// ExpectedCommonsSize returns the exact compressed gnark encoding size.
func ExpectedCommonsSize(s CommonsShape) (int64, error) {
	if err := validateDomain(s.DomainN); err != nil {
		return 0, err
	}

	// uint64 N, G2 Beta, (2N-2) G1 Tau, (N-1) G2 Tau,
	// N G1 BetaTau, N G1 AlphaTau = 288N - 88.
	nBytes, err := checkedMul(s.DomainN, 288)
	if err != nil {
		return 0, err
	}
	nBytes, err = checkedSub(nBytes, 88)
	if err != nil {
		return 0, err
	}
	return checkedArtifactSize(nBytes)
}

// ExpectedPhase1Size returns the exact compressed gnark encoding size.
func ExpectedPhase1Size(s Phase1Shape) (int64, error) {
	commons, err := ExpectedCommonsSize(CommonsShape{DomainN: s.DomainN})
	if err != nil {
		return 0, err
	}

	// Three UpdateProofs (G1+G2), commons, one-byte challenge length.
	nBytes, err := checkedAdd(uint64(commons), 3*(g1CompressedSize+g2CompressedSize))
	if err != nil {
		return 0, err
	}
	nBytes, err = checkedAdd(nBytes, 1+uint64(s.ChallengeLength))
	if err != nil {
		return 0, err
	}
	return checkedArtifactSize(nBytes)
}

// ExpectedPhase2Size returns the exact compressed gnark encoding size.
func ExpectedPhase2Size(s Phase2Shape) (int64, error) {
	if s.Commitments > MaxPhase2Commitments {
		return 0, fmt.Errorf("%w: Phase 2 commitments %d exceed %d", ErrInvalidShape, s.Commitments, MaxPhase2Commitments)
	}
	if len(s.SigmaCKK) != int(s.Commitments) {
		return 0, fmt.Errorf("%w: %d SigmaCKK lengths for %d commitments", ErrInvalidShape, len(s.SigmaCKK), s.Commitments)
	}

	totalPoints := uint64(s.PKK) + uint64(s.Z)
	for _, n := range s.SigmaCKK {
		var err error
		totalPoints, err = checkedAdd(totalPoints, uint64(n))
		if err != nil {
			return 0, err
		}
	}

	// Fixed bytes are:
	//   commitments u16, Delta G1, PKK/Z length prefixes, Delta G2,
	//   Delta UpdateProof, challenge prefix = 299.
	// Per commitment:
	//   SigmaCKK length prefix, Sigma G2, Sigma UpdateProof = 244.
	nBytes, err := checkedMul(totalPoints, g1CompressedSize)
	if err != nil {
		return 0, err
	}
	nBytes, err = checkedAdd(nBytes, 299+uint64(s.ChallengeLength))
	if err != nil {
		return 0, err
	}
	perCommitment, err := checkedMul(uint64(s.Commitments), 244)
	if err != nil {
		return 0, err
	}
	nBytes, err = checkedAdd(nBytes, perCommitment)
	if err != nil {
		return 0, err
	}
	return checkedArtifactSize(nBytes)
}

func checkedArtifactSize(n uint64) (int64, error) {
	if n > uint64(math.MaxInt64) {
		return 0, fmt.Errorf("%w: byte length overflows int64", ErrInvalidShape)
	}
	if n > uint64(MaxArtifactSize) {
		return 0, fmt.Errorf("%w: %d > %d bytes", ErrArtifactTooLarge, n, MaxArtifactSize)
	}
	return int64(n), nil
}

func checkedAdd(a, b uint64) (uint64, error) {
	sum, carry := bits.Add64(a, b, 0)
	if carry != 0 {
		return 0, fmt.Errorf("%w: integer addition overflow", ErrInvalidShape)
	}
	return sum, nil
}

func checkedMul(a, b uint64) (uint64, error) {
	hi, lo := bits.Mul64(a, b)
	if hi != 0 {
		return 0, fmt.Errorf("%w: integer multiplication overflow", ErrInvalidShape)
	}
	return lo, nil
}

func checkedSub(a, b uint64) (uint64, error) {
	if b > a {
		return 0, fmt.Errorf("%w: integer subtraction underflow", ErrInvalidShape)
	}
	return a - b, nil
}

// PreflightPhase1 scans the complete canonical encoding without allocating any
// attacker-declared vector. The supplied shape must come from trusted local
// ceremony state.
func PreflightPhase1(r io.Reader, s Phase1Shape) (ArtifactDigest, error) {
	expected, err := ExpectedPhase1Size(s)
	if err != nil {
		return ArtifactDigest{}, err
	}
	sc, err := newPreflightScanner(r, expected)
	if err != nil {
		return ArtifactDigest{}, err
	}

	for range 3 {
		if err := sc.pointG1(); err != nil {
			return ArtifactDigest{}, fmt.Errorf("Phase 1 update proof G1: %w", err)
		}
		if err := sc.pointG2(); err != nil {
			return ArtifactDigest{}, fmt.Errorf("Phase 1 update proof G2: %w", err)
		}
	}

	n, err := sc.uint64()
	if err != nil {
		return ArtifactDigest{}, fmt.Errorf("Phase 1 domain: %w", err)
	}
	if n != s.DomainN {
		return ArtifactDigest{}, fmt.Errorf("%w: Phase 1 domain %d, expected %d", ErrInvalidShape, n, s.DomainN)
	}
	if err := scanCommonsBody(sc, n); err != nil {
		return ArtifactDigest{}, err
	}
	challenge, err := sc.challenge(s.ChallengeLength)
	if err != nil {
		return ArtifactDigest{}, err
	}
	return sc.finish(challenge)
}

// PreflightCommons scans a complete canonical SrsCommons encoding.
func PreflightCommons(r io.Reader, s CommonsShape) (ArtifactDigest, error) {
	expected, err := ExpectedCommonsSize(s)
	if err != nil {
		return ArtifactDigest{}, err
	}
	sc, err := newPreflightScanner(r, expected)
	if err != nil {
		return ArtifactDigest{}, err
	}

	n, err := sc.uint64()
	if err != nil {
		return ArtifactDigest{}, fmt.Errorf("SRS commons domain: %w", err)
	}
	if n != s.DomainN {
		return ArtifactDigest{}, fmt.Errorf("%w: SRS commons domain %d, expected %d", ErrInvalidShape, n, s.DomainN)
	}
	if err := scanCommonsBody(sc, n); err != nil {
		return ArtifactDigest{}, err
	}
	return sc.finish(nil)
}

func scanCommonsBody(sc *preflightScanner, n uint64) error {
	if err := sc.pointG2(); err != nil {
		return fmt.Errorf("SRS commons G2 Beta: %w", err)
	}
	if err := sc.pointsG1(2*n - 2); err != nil {
		return fmt.Errorf("SRS commons G1 Tau: %w", err)
	}
	if err := sc.pointsG2(n - 1); err != nil {
		return fmt.Errorf("SRS commons G2 Tau: %w", err)
	}
	if err := sc.pointsG1(n); err != nil {
		return fmt.Errorf("SRS commons G1 BetaTau: %w", err)
	}
	if err := sc.pointsG1(n); err != nil {
		return fmt.Errorf("SRS commons G1 AlphaTau: %w", err)
	}
	return nil
}

// PreflightPhase2 scans the complete canonical encoding and checks every
// attacker-controlled vector length before native gnark decoding.
func PreflightPhase2(r io.Reader, s Phase2Shape) (ArtifactDigest, error) {
	expected, err := ExpectedPhase2Size(s)
	if err != nil {
		return ArtifactDigest{}, err
	}
	sc, err := newPreflightScanner(r, expected)
	if err != nil {
		return ArtifactDigest{}, err
	}

	commitments, err := sc.uint16()
	if err != nil {
		return ArtifactDigest{}, fmt.Errorf("Phase 2 commitments: %w", err)
	}
	if commitments != s.Commitments {
		return ArtifactDigest{}, fmt.Errorf("%w: Phase 2 commitments %d, expected %d", ErrInvalidShape, commitments, s.Commitments)
	}
	if err := sc.pointG1(); err != nil {
		return ArtifactDigest{}, fmt.Errorf("Phase 2 G1 Delta: %w", err)
	}
	if err := sc.vectorG1("Phase 2 PKK", s.PKK); err != nil {
		return ArtifactDigest{}, err
	}
	if err := sc.vectorG1("Phase 2 Z", s.Z); err != nil {
		return ArtifactDigest{}, err
	}
	if err := sc.pointG2(); err != nil {
		return ArtifactDigest{}, fmt.Errorf("Phase 2 G2 Delta: %w", err)
	}
	for i, want := range s.SigmaCKK {
		if err := sc.vectorG1(fmt.Sprintf("Phase 2 SigmaCKK[%d]", i), want); err != nil {
			return ArtifactDigest{}, err
		}
	}
	if err := sc.pointsG2(uint64(s.Commitments)); err != nil {
		return ArtifactDigest{}, fmt.Errorf("Phase 2 G2 Sigma: %w", err)
	}
	if err := sc.updateProof("Phase 2 Delta proof"); err != nil {
		return ArtifactDigest{}, err
	}
	for i := uint16(0); i < s.Commitments; i++ {
		if err := sc.updateProof(fmt.Sprintf("Phase 2 Sigma proof[%d]", i)); err != nil {
			return ArtifactDigest{}, err
		}
	}
	challenge, err := sc.challenge(s.ChallengeLength)
	if err != nil {
		return ArtifactDigest{}, err
	}
	return sc.finish(challenge)
}

type preflightScanner struct {
	r        *bufio.Reader
	expected int64
	n        int64
	sha      hash.Hash
	blake    hash.Hash
}

func newPreflightScanner(r io.Reader, expected int64) (*preflightScanner, error) {
	if r == nil {
		return nil, errors.New("nil MPC artifact reader")
	}
	sha := sha256.New()
	blake, err := blake2b.New256(nil)
	if err != nil {
		return nil, fmt.Errorf("initialize BLAKE2b-256: %w", err)
	}
	tee := io.TeeReader(r, io.MultiWriter(sha, blake))
	return &preflightScanner{
		r:        bufio.NewReaderSize(tee, preflightBuffer),
		expected: expected,
		sha:      sha,
		blake:    blake,
	}, nil
}

func (s *preflightScanner) readFull(p []byte) error {
	n, err := io.ReadFull(s.r, p)
	s.n += int64(n)
	if err != nil {
		return err
	}
	if s.n > s.expected {
		return fmt.Errorf("%w: artifact exceeds expected %d bytes", ErrTrailingData, s.expected)
	}
	return nil
}

func (s *preflightScanner) uint16() (uint16, error) {
	var b [2]byte
	if err := s.readFull(b[:]); err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint16(b[:]), nil
}

func (s *preflightScanner) uint32() (uint32, error) {
	var b [4]byte
	if err := s.readFull(b[:]); err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint32(b[:]), nil
}

func (s *preflightScanner) uint64() (uint64, error) {
	var b [8]byte
	if err := s.readFull(b[:]); err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint64(b[:]), nil
}

func (s *preflightScanner) pointG1() error {
	return s.point(g1CompressedSize)
}

func (s *preflightScanner) pointG2() error {
	return s.point(g2CompressedSize)
}

func (s *preflightScanner) point(size uint64) error {
	var encoded [g2CompressedSize]byte
	if err := s.readFull(encoded[:size]); err != nil {
		return err
	}
	switch encoded[0] & 0xe0 {
	case 0x80, 0xa0, 0xc0:
		return nil
	default:
		return ErrNonCanonicalPoint
	}
}

func (s *preflightScanner) pointsG1(n uint64) error {
	for i := uint64(0); i < n; i++ {
		if err := s.pointG1(); err != nil {
			return fmt.Errorf("point %d: %w", i, err)
		}
	}
	return nil
}

func (s *preflightScanner) pointsG2(n uint64) error {
	for i := uint64(0); i < n; i++ {
		if err := s.pointG2(); err != nil {
			return fmt.Errorf("point %d: %w", i, err)
		}
	}
	return nil
}

func (s *preflightScanner) vectorG1(name string, expected uint32) error {
	n, err := s.uint32()
	if err != nil {
		return fmt.Errorf("%s length: %w", name, err)
	}
	if n != expected {
		return fmt.Errorf("%w: %s length %d, expected %d", ErrInvalidShape, name, n, expected)
	}
	if err := s.pointsG1(uint64(n)); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

func (s *preflightScanner) updateProof(name string) error {
	if err := s.pointG1(); err != nil {
		return fmt.Errorf("%s G1: %w", name, err)
	}
	if err := s.pointG2(); err != nil {
		return fmt.Errorf("%s G2: %w", name, err)
	}
	return nil
}

func (s *preflightScanner) challenge(expected uint8) ([]byte, error) {
	var length [1]byte
	if err := s.readFull(length[:]); err != nil {
		return nil, fmt.Errorf("challenge length: %w", err)
	}
	if length[0] != expected {
		return nil, fmt.Errorf("%w: challenge length %d, expected %d", ErrInvalidShape, length[0], expected)
	}
	challenge := make([]byte, int(expected))
	if err := s.readFull(challenge); err != nil {
		return nil, fmt.Errorf("challenge: %w", err)
	}
	return challenge, nil
}

func (s *preflightScanner) finish(challenge []byte) (ArtifactDigest, error) {
	if s.n != s.expected {
		return ArtifactDigest{}, fmt.Errorf("%w: read %d bytes, expected %d", ErrInvalidShape, s.n, s.expected)
	}
	var extra [1]byte
	n, err := io.ReadFull(s.r, extra[:])
	s.n += int64(n)
	if err == nil || n != 0 {
		return ArtifactDigest{}, ErrTrailingData
	}
	if !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return ArtifactDigest{}, fmt.Errorf("check artifact EOF: %w", err)
	}

	var digest ArtifactDigest
	digest.Size = s.expected
	copy(digest.SHA256[:], s.sha.Sum(nil))
	copy(digest.BLAKE2b256[:], s.blake.Sum(nil))
	digest.Challenge = append([]byte(nil), challenge...)
	return digest, nil
}
