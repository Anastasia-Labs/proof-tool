package mpcceremony

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"testing"

	gnarkmpc "github.com/consensys/gnark/backend/groth16/bls12-381/mpcsetup"
)

func TestFullReadReaderFillsRequestedBuffer(t *testing.T) {
	t.Parallel()

	source := &oneByteReader{r: bytes.NewReader([]byte("challenge"))}
	got := make([]byte, len("challenge"))
	n, err := (fullReadReader{r: source}).Read(got)
	if err != nil {
		t.Fatalf("full read: %v", err)
	}
	if n != len(got) || string(got) != "challenge" {
		t.Fatalf("read %d bytes %q", n, got)
	}

	short := make([]byte, 10)
	if _, err := (fullReadReader{r: &oneByteReader{r: bytes.NewReader([]byte("short"))}}).Read(short); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("short read error = %v; want io.ErrUnexpectedEOF", err)
	}
}

type oneByteReader struct {
	r *bytes.Reader
}

func (r *oneByteReader) Read(p []byte) (int, error) {
	if len(p) > 1 {
		p = p[:1]
	}
	return r.r.Read(p)
}

type panicReaderFrom struct{}

func (panicReaderFrom) ReadFrom(io.Reader) (int64, error) {
	panic("decoder failure")
}

type panicWriterTo struct{}

func (panicWriterTo) WriteTo(io.Writer) (int64, error) {
	panic("encoder failure")
}

func TestNativeCodecPanicBoundaries(t *testing.T) {
	t.Parallel()

	if err := nativeReadExact(bytes.NewReader([]byte{0}), 1, panicReaderFrom{}); err == nil ||
		err.Error() != "native MPC decoder panic: decoder failure" {
		t.Fatalf("decoder panic error = %v", err)
	}
	if _, err := writeToWithPanicBoundary(
		"test encoder",
		panicWriterTo{},
		io.Discard,
	); err == nil || err.Error() != "test encoder panic: encoder failure" {
		t.Fatalf("encoder panic error = %v", err)
	}
}

func TestReadPhase1FileStrict(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "phase1.bin")
	phase1 := gnarkmpc.NewPhase1(2)
	encoded := writeNative(t, phase1)
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}

	got, digest, err := ReadPhase1File(path, Phase1Shape{DomainN: 2})
	if err != nil {
		t.Fatalf("strict read: %v", err)
	}
	if got == nil || digest.Size != int64(len(encoded)) {
		t.Fatalf("unexpected read result: object=%v digest=%+v", got, digest)
	}
}

func TestReadPhase1FilePreservesNativePointValidation(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "phase1.bin")
	encoded := writeNative(t, gnarkmpc.NewPhase1(2))
	// Keep the canonical compressed-infinity mask so structural preflight
	// succeeds, but violate the native infinity encoding's all-zero payload.
	encoded[1] = 1
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ReadPhase1File(path, Phase1Shape{DomainN: 2}); err == nil {
		t.Fatal("invalid compressed infinity unexpectedly passed native decoding")
	}
}

func TestReadFileRejectsWrongSizeAndNonRegular(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "phase1.bin")
	phase1 := gnarkmpc.NewPhase1(2)
	encoded := append(writeNative(t, phase1), 0)
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ReadPhase1File(path, Phase1Shape{DomainN: 2}); !errors.Is(err, ErrInvalidShape) {
		t.Fatalf("wrong-size error = %v; want ErrInvalidShape", err)
	}
	if _, _, err := ReadPhase1File(dir, Phase1Shape{DomainN: 2}); err == nil {
		t.Fatal("directory unexpectedly accepted as artifact")
	}
}

func TestReadPhase2FileStrict(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "phase2.bin")
	phase2, shape := smallPhase2(32)
	if err := os.WriteFile(path, writeNative(t, phase2), 0o600); err != nil {
		t.Fatal(err)
	}
	got, digest, err := ReadPhase2File(path, shape)
	if err != nil {
		t.Fatalf("strict Phase 2 read: %v", err)
	}
	if got == nil || !bytes.Equal(got.Challenge, digest.Challenge) {
		t.Fatal("strict Phase 2 read lost challenge")
	}
}

func TestWritePhase1FileNoReplace(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "phase1.bin")
	phase1 := gnarkmpc.NewPhase1(2)
	shape := Phase1Shape{DomainN: 2}

	digest, err := WritePhase1FileNoReplace(path, phase1, shape)
	if err != nil {
		t.Fatalf("write Phase 1: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("permissions = %04o; want 0600", info.Mode().Perm())
	}
	if info.Size() != digest.Size {
		t.Fatalf("published size = %d, digest size = %d", info.Size(), digest.Size)
	}

	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := WritePhase1FileNoReplace(path, phase1, shape); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("second write error = %v; want fs.ErrExist", err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("failed no-replace write changed existing artifact")
	}
	assertNoPartials(t, dir)
}

func TestWriteNoReplaceDoesNotPublishInvalidShape(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "phase1.bin")
	phase1 := gnarkmpc.NewPhase1(2)
	_, err := WritePhase1FileNoReplace(path, phase1, Phase1Shape{DomainN: 4})
	if err == nil {
		t.Fatal("shape-mismatched write unexpectedly succeeded")
	}
	if _, statErr := os.Stat(path); !errors.Is(statErr, fs.ErrNotExist) {
		t.Fatalf("final path after failed write: %v", statErr)
	}
	assertNoPartials(t, dir)
}

func TestWriteNoReplaceRejectsExistingSymlink(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "phase1.bin")
	target := filepath.Join(dir, "missing-target")
	if err := os.Symlink(target, path); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	phase1 := gnarkmpc.NewPhase1(2)
	_, err := WritePhase1FileNoReplace(path, phase1, Phase1Shape{DomainN: 2})
	if !errors.Is(err, fs.ErrExist) {
		t.Fatalf("symlink output error = %v; want fs.ErrExist", err)
	}
	linkTarget, err := os.Readlink(path)
	if err != nil {
		t.Fatalf("read preserved symlink: %v", err)
	}
	if linkTarget != target {
		t.Fatalf("symlink target = %q; want %q", linkTarget, target)
	}
	assertNoPartials(t, dir)
}

func TestWritePhase2AndCommonsNoReplace(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	phase2Path := filepath.Join(dir, "phase2.bin")
	phase2, phase2Shape := smallPhase2(32)
	if _, err := WritePhase2FileNoReplace(phase2Path, phase2, phase2Shape); err != nil {
		t.Fatalf("write Phase 2: %v", err)
	}
	if _, _, err := ReadPhase2File(phase2Path, phase2Shape); err != nil {
		t.Fatalf("read written Phase 2: %v", err)
	}

	phase1 := gnarkmpc.NewPhase1(2)
	commons := phase1.Seal([]byte("test beacon"))
	commonsPath := filepath.Join(dir, "commons.bin")
	commonsShape := CommonsShape{DomainN: 2}
	if _, err := WriteCommonsFileNoReplace(commonsPath, &commons, commonsShape); err != nil {
		t.Fatalf("write commons: %v", err)
	}
	if _, _, err := ReadCommonsFile(commonsPath, commonsShape); err != nil {
		t.Fatalf("read written commons: %v", err)
	}
}

func TestConcurrentNoReplaceHasSingleWinner(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "phase1.bin")
	phase1 := gnarkmpc.NewPhase1(2)
	shape := Phase1Shape{DomainN: 2}

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := WritePhase1FileNoReplace(path, phase1, shape)
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)

	var successes, exists int
	for err := range errs {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, fs.ErrExist):
			exists++
		default:
			t.Errorf("unexpected writer error: %v", err)
		}
	}
	if successes != 1 || exists != 1 {
		t.Fatalf("successes=%d exists=%d; want 1/1", successes, exists)
	}
	assertNoPartials(t, dir)
}

func assertNoPartials(t *testing.T, dir string) {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dir, ".*.partial-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("temporary files remain: %v", matches)
	}
}
