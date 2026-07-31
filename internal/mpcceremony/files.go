package mpcceremony

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	gnarkmpc "github.com/consensys/gnark/backend/groth16/bls12-381/mpcsetup"
	"golang.org/x/crypto/blake2b"
)

// ReadPhase1File performs allocation-free preflight before native gnark
// deserialization and requires the native object to round-trip canonically.
func ReadPhase1File(path string, shape Phase1Shape) (*gnarkmpc.Phase1, ArtifactDigest, error) {
	expected, err := ExpectedPhase1Size(shape)
	if err != nil {
		return nil, ArtifactDigest{}, err
	}
	f, err := openRegularExact(path, expected)
	if err != nil {
		return nil, ArtifactDigest{}, err
	}
	defer f.Close()

	digest, err := PreflightPhase1(io.NewSectionReader(f, 0, expected), shape)
	if err != nil {
		return nil, ArtifactDigest{}, fmt.Errorf("preflight Phase 1 %q: %w", path, err)
	}

	var artifact gnarkmpc.Phase1
	if err := nativeReadExact(io.NewSectionReader(f, 0, expected), expected, &artifact); err != nil {
		return nil, ArtifactDigest{}, fmt.Errorf("decode Phase 1 %q: %w", path, err)
	}
	if len(artifact.Challenge) != int(shape.ChallengeLength) {
		return nil, ArtifactDigest{}, fmt.Errorf("%w: decoded Phase 1 challenge length %d, expected %d", ErrInvalidShape, len(artifact.Challenge), shape.ChallengeLength)
	}
	if err := requireCanonicalRoundTrip(&artifact, digest); err != nil {
		return nil, ArtifactDigest{}, fmt.Errorf("canonical Phase 1 %q: %w", path, err)
	}
	return &artifact, digest, nil
}

// ReadCommonsFile safely reads a canonical native gnark SrsCommons artifact.
func ReadCommonsFile(path string, shape CommonsShape) (*gnarkmpc.SrsCommons, ArtifactDigest, error) {
	expected, err := ExpectedCommonsSize(shape)
	if err != nil {
		return nil, ArtifactDigest{}, err
	}
	f, err := openRegularExact(path, expected)
	if err != nil {
		return nil, ArtifactDigest{}, err
	}
	defer f.Close()

	digest, err := PreflightCommons(io.NewSectionReader(f, 0, expected), shape)
	if err != nil {
		return nil, ArtifactDigest{}, fmt.Errorf("preflight SRS commons %q: %w", path, err)
	}

	var artifact gnarkmpc.SrsCommons
	if err := nativeReadExact(io.NewSectionReader(f, 0, expected), expected, &artifact); err != nil {
		return nil, ArtifactDigest{}, fmt.Errorf("decode SRS commons %q: %w", path, err)
	}
	if err := requireCanonicalRoundTrip(&artifact, digest); err != nil {
		return nil, ArtifactDigest{}, fmt.Errorf("canonical SRS commons %q: %w", path, err)
	}
	return &artifact, digest, nil
}

// ReadPhase2File safely reads a canonical native gnark Phase 2 artifact.
func ReadPhase2File(path string, shape Phase2Shape) (*gnarkmpc.Phase2, ArtifactDigest, error) {
	expected, err := ExpectedPhase2Size(shape)
	if err != nil {
		return nil, ArtifactDigest{}, err
	}
	f, err := openRegularExact(path, expected)
	if err != nil {
		return nil, ArtifactDigest{}, err
	}
	defer f.Close()

	digest, err := PreflightPhase2(io.NewSectionReader(f, 0, expected), shape)
	if err != nil {
		return nil, ArtifactDigest{}, fmt.Errorf("preflight Phase 2 %q: %w", path, err)
	}

	var artifact gnarkmpc.Phase2
	if err := nativeReadExact(io.NewSectionReader(f, 0, expected), expected, &artifact); err != nil {
		return nil, ArtifactDigest{}, fmt.Errorf("decode Phase 2 %q: %w", path, err)
	}
	if err := validateDecodedPhase2(&artifact, shape); err != nil {
		return nil, ArtifactDigest{}, err
	}
	if err := requireCanonicalRoundTrip(&artifact, digest); err != nil {
		return nil, ArtifactDigest{}, fmt.Errorf("canonical Phase 2 %q: %w", path, err)
	}
	return &artifact, digest, nil
}

func validateDecodedPhase2(p *gnarkmpc.Phase2, shape Phase2Shape) error {
	if len(p.Sigmas) != int(shape.Commitments) ||
		len(p.Parameters.G2.Sigma) != int(shape.Commitments) ||
		len(p.Parameters.G1.SigmaCKK) != int(shape.Commitments) {
		return fmt.Errorf("%w: decoded Phase 2 commitment structure mismatch", ErrInvalidShape)
	}
	if len(p.Parameters.G1.PKK) != int(shape.PKK) {
		return fmt.Errorf("%w: decoded Phase 2 PKK length %d, expected %d", ErrInvalidShape, len(p.Parameters.G1.PKK), shape.PKK)
	}
	if len(p.Parameters.G1.Z) != int(shape.Z) {
		return fmt.Errorf("%w: decoded Phase 2 Z length %d, expected %d", ErrInvalidShape, len(p.Parameters.G1.Z), shape.Z)
	}
	for i, expected := range shape.SigmaCKK {
		if len(p.Parameters.G1.SigmaCKK[i]) != int(expected) {
			return fmt.Errorf("%w: decoded Phase 2 SigmaCKK[%d] length %d, expected %d", ErrInvalidShape, i, len(p.Parameters.G1.SigmaCKK[i]), expected)
		}
	}
	if len(p.Challenge) != int(shape.ChallengeLength) {
		return fmt.Errorf("%w: decoded Phase 2 challenge length %d, expected %d", ErrInvalidShape, len(p.Challenge), shape.ChallengeLength)
	}
	return nil
}

func openRegularExact(path string, expected int64) (*os.File, error) {
	linkInfo, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("inspect MPC artifact %q: %w", path, err)
	}
	if linkInfo.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("MPC artifact %q must not be a symbolic link", path)
	}
	if !linkInfo.Mode().IsRegular() {
		return nil, fmt.Errorf("MPC artifact %q is not a regular file", path)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open MPC artifact %q: %w", path, err)
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("stat MPC artifact %q: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		f.Close()
		return nil, fmt.Errorf("MPC artifact %q is not a regular file", path)
	}
	if !os.SameFile(linkInfo, info) {
		f.Close()
		return nil, fmt.Errorf("MPC artifact %q changed while being opened", path)
	}
	if info.Size() != expected {
		f.Close()
		return nil, fmt.Errorf("%w: MPC artifact %q is %d bytes, expected exactly %d", ErrInvalidShape, path, info.Size(), expected)
	}
	return f, nil
}

type fullReadReader struct {
	r io.Reader
}

func (r fullReadReader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	return io.ReadFull(r.r, p)
}

func nativeReadExact(r io.Reader, expected int64, dst io.ReaderFrom) error {
	limited := &io.LimitedReader{R: r, N: expected}
	n, err := readFromWithPanicBoundary(
		"native MPC decoder",
		dst,
		fullReadReader{r: limited},
	)
	if err != nil {
		return err
	}
	if n != expected {
		return fmt.Errorf("%w: native decoder consumed %d bytes, expected %d", ErrInvalidShape, n, expected)
	}
	if limited.N != 0 {
		return fmt.Errorf("%w: native decoder left %d bytes", ErrTrailingData, limited.N)
	}
	return nil
}

func requireCanonicalRoundTrip(src io.WriterTo, expected ArtifactDigest) error {
	sha := sha256.New()
	blake, err := blake2b.New256(nil)
	if err != nil {
		return fmt.Errorf("initialize BLAKE2b-256: %w", err)
	}
	n, err := writeToWithPanicBoundary(
		"native MPC canonical encoder",
		src,
		io.MultiWriter(sha, blake),
	)
	if err != nil {
		return err
	}
	if n != expected.Size {
		return fmt.Errorf("%w: native encoder wrote %d bytes, expected %d", ErrInvalidShape, n, expected.Size)
	}
	var shaSum [sha256.Size]byte
	var blakeSum [blake2b.Size256]byte
	copy(shaSum[:], sha.Sum(nil))
	copy(blakeSum[:], blake.Sum(nil))
	if shaSum != expected.SHA256 || blakeSum != expected.BLAKE2b256 {
		return errors.New("native canonical serialization digest does not match input")
	}
	return nil
}

// WritePhase1FileNoReplace writes, syncs, strictly reads back, and publishes a
// native Phase 1 artifact without ever replacing an existing destination.
func WritePhase1FileNoReplace(path string, artifact *gnarkmpc.Phase1, shape Phase1Shape) (ArtifactDigest, error) {
	if artifact == nil {
		return ArtifactDigest{}, errors.New("nil Phase 1 artifact")
	}
	expected, err := ExpectedPhase1Size(shape)
	if err != nil {
		return ArtifactDigest{}, err
	}
	return atomicWriteNoReplace(path, expected, artifact.WriteTo, func(tempPath string) (ArtifactDigest, error) {
		_, digest, err := ReadPhase1File(tempPath, shape)
		return digest, err
	})
}

// WriteCommonsFileNoReplace writes a native SrsCommons artifact atomically
// with no-replace semantics.
func WriteCommonsFileNoReplace(path string, artifact *gnarkmpc.SrsCommons, shape CommonsShape) (ArtifactDigest, error) {
	if artifact == nil {
		return ArtifactDigest{}, errors.New("nil SRS commons artifact")
	}
	expected, err := ExpectedCommonsSize(shape)
	if err != nil {
		return ArtifactDigest{}, err
	}
	return atomicWriteNoReplace(path, expected, artifact.WriteTo, func(tempPath string) (ArtifactDigest, error) {
		_, digest, err := ReadCommonsFile(tempPath, shape)
		return digest, err
	})
}

// WritePhase2FileNoReplace writes a native Phase 2 artifact atomically with
// no-replace semantics.
func WritePhase2FileNoReplace(path string, artifact *gnarkmpc.Phase2, shape Phase2Shape) (ArtifactDigest, error) {
	if artifact == nil {
		return ArtifactDigest{}, errors.New("nil Phase 2 artifact")
	}
	expected, err := ExpectedPhase2Size(shape)
	if err != nil {
		return ArtifactDigest{}, err
	}
	return atomicWriteNoReplace(path, expected, artifact.WriteTo, func(tempPath string) (ArtifactDigest, error) {
		_, digest, err := ReadPhase2File(tempPath, shape)
		return digest, err
	})
}

func atomicWriteNoReplace(
	path string,
	expected int64,
	write func(io.Writer) (int64, error),
	validate func(string) (ArtifactDigest, error),
) (digest ArtifactDigest, err error) {
	if path == "" {
		return ArtifactDigest{}, errors.New("empty MPC artifact output path")
	}
	dir := filepath.Dir(path)
	base := filepath.Base(path)
	dirInfo, err := os.Stat(dir)
	if err != nil {
		return ArtifactDigest{}, fmt.Errorf("stat MPC artifact output directory %q: %w", dir, err)
	}
	if !dirInfo.IsDir() {
		return ArtifactDigest{}, fmt.Errorf("MPC artifact output parent %q is not a directory", dir)
	}

	temp, err := os.CreateTemp(dir, "."+base+".partial-*")
	if err != nil {
		return ArtifactDigest{}, fmt.Errorf("create MPC artifact temporary file: %w", err)
	}
	tempPath := temp.Name()
	tempOpen := true
	defer func() {
		if tempOpen {
			_ = temp.Close()
		}
		_ = os.Remove(tempPath)
	}()
	if err := temp.Chmod(0o600); err != nil {
		return ArtifactDigest{}, fmt.Errorf("restrict MPC artifact temporary permissions: %w", err)
	}

	n, err := writeWithPanicBoundary("native MPC artifact encoder", write, temp)
	if err != nil {
		return ArtifactDigest{}, fmt.Errorf("write MPC artifact temporary file: %w", err)
	}
	if n != expected {
		return ArtifactDigest{}, fmt.Errorf("%w: native encoder wrote %d bytes, expected %d", ErrInvalidShape, n, expected)
	}
	info, err := temp.Stat()
	if err != nil {
		return ArtifactDigest{}, fmt.Errorf("stat MPC artifact temporary file: %w", err)
	}
	if info.Size() != expected {
		return ArtifactDigest{}, fmt.Errorf("%w: temporary file is %d bytes, expected %d", ErrInvalidShape, info.Size(), expected)
	}
	if err := temp.Sync(); err != nil {
		return ArtifactDigest{}, fmt.Errorf("sync MPC artifact temporary file: %w", err)
	}
	if err := temp.Close(); err != nil {
		tempOpen = false
		return ArtifactDigest{}, fmt.Errorf("close MPC artifact temporary file: %w", err)
	}
	tempOpen = false

	digest, err = validate(tempPath)
	if err != nil {
		return ArtifactDigest{}, fmt.Errorf("validate MPC artifact temporary file: %w", err)
	}
	if digest.Size != expected {
		return ArtifactDigest{}, fmt.Errorf("%w: validated file is %d bytes, expected %d", ErrInvalidShape, digest.Size, expected)
	}

	if err := publishFileNoReplace(tempPath, path); err != nil {
		return ArtifactDigest{}, fmt.Errorf("publish MPC artifact without replacement: %w", err)
	}
	return digest, nil
}

func readFromWithPanicBoundary(
	label string,
	dst io.ReaderFrom,
	src io.Reader,
) (n int64, err error) {
	if dst == nil || src == nil {
		return 0, fmt.Errorf("%s requires a reader and decoder", label)
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			n = 0
			err = fmt.Errorf("%s panic: %v", label, recovered)
		}
	}()
	return dst.ReadFrom(src)
}

func writeToWithPanicBoundary(
	label string,
	src io.WriterTo,
	dst io.Writer,
) (n int64, err error) {
	if src == nil || dst == nil {
		return 0, fmt.Errorf("%s requires an encoder and writer", label)
	}
	return writeWithPanicBoundary(label, src.WriteTo, dst)
}

func writeWithPanicBoundary(
	label string,
	write func(io.Writer) (int64, error),
	dst io.Writer,
) (n int64, err error) {
	if write == nil || dst == nil {
		return 0, fmt.Errorf("%s requires an encoder and writer", label)
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			n = 0
			err = fmt.Errorf("%s panic: %v", label, recovered)
		}
	}()
	return write(dst)
}

func syncDirectory(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("open MPC artifact output directory for sync: %w", err)
	}
	defer f.Close()
	if err := f.Sync(); err != nil {
		return fmt.Errorf("sync MPC artifact output directory: %w", err)
	}
	return nil
}
