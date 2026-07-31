package mpcceremony

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	gnarkmpc "github.com/consensys/gnark/backend/groth16/bls12-381/mpcsetup"
)

func TestSignedRecordPublicationResumesExactPrefixes(t *testing.T) {
	t.Parallel()

	record := adversarialAttestation(t)
	privateKey := adversarialPrivateKey(0x52)
	recordBytes, signatureBytes, err := SignRecord(record, record.ParticipantKeyID, privateKey)
	if err != nil {
		t.Fatal(err)
	}

	t.Run("signature only", func(t *testing.T) {
		dir := t.TempDir()
		recordPath := filepath.Join(dir, "record.json")
		signaturePath := filepath.Join(dir, "record.sig")
		if err := writeBytesNoReplace(signaturePath, signatureBytes, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := writeSignedRecordNoReplace(
			recordPath,
			signaturePath,
			record,
			record.ParticipantKeyID,
			privateKey,
		); err != nil {
			t.Fatalf("resume signature-only publication: %v", err)
		}
		assertExactFile(t, recordPath, recordBytes)
		assertExactFile(t, signaturePath, signatureBytes)
		if err := writeSignedRecordNoReplace(
			recordPath,
			signaturePath,
			record,
			record.ParticipantKeyID,
			privateKey,
		); err != nil {
			t.Fatalf("idempotent exact retry: %v", err)
		}
	})

	t.Run("mismatched record", func(t *testing.T) {
		dir := t.TempDir()
		recordPath := filepath.Join(dir, "record.json")
		signaturePath := filepath.Join(dir, "record.sig")
		mismatch := []byte("different authoritative bytes")
		if err := writeBytesNoReplace(recordPath, mismatch, 0o600); err != nil {
			t.Fatal(err)
		}
		err := writeSignedRecordNoReplace(
			recordPath,
			signaturePath,
			record,
			record.ParticipantKeyID,
			privateKey,
		)
		if !errors.Is(err, fs.ErrExist) {
			t.Fatalf("mismatched retry error = %v, want fs.ErrExist", err)
		}
		assertExactFile(t, recordPath, mismatch)
		if _, statErr := os.Lstat(signaturePath); !errors.Is(statErr, fs.ErrNotExist) {
			t.Fatalf("mismatched preflight published signature: %v", statErr)
		}
	})
}

func TestNativePublicationResumesOnlyExactArtifact(t *testing.T) {
	t.Parallel()

	phase1 := gnarkmpc.NewPhase1(adversarialTinyDomain)
	shape := Phase1Shape{DomainN: adversarialTinyDomain}
	expected, err := writerDigest(phase1)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "phase1.bin")
	if _, err := writePhase1FileNoReplaceOrExact(path, phase1, shape, expected); err != nil {
		t.Fatal(err)
	}
	if _, err := writePhase1FileNoReplaceOrExact(path, phase1, shape, expected); err != nil {
		t.Fatalf("exact native retry: %v", err)
	}
	wrong := NewDigest([]byte("different artifact"))
	if _, err := writePhase1FileNoReplaceOrExact(path, phase1, shape, wrong); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("mismatched native retry error = %v, want fs.ErrExist", err)
	}
}

func TestMakeOrResumePrivateDirRejectsUnsafeExistingPath(t *testing.T) {
	t.Parallel()

	parent := t.TempDir()
	path := filepath.Join(parent, "resume")
	created, err := makeOrResumePrivateDir(path)
	if err != nil || !created {
		t.Fatalf("create private retry dir = %v, created %v", err, created)
	}
	created, err = makeOrResumePrivateDir(path)
	if err != nil || created {
		t.Fatalf("resume private retry dir = %v, created %v", err, created)
	}
	if err := os.WriteFile(filepath.Join(path, "unexpected"), []byte("stray"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := requireDirectoryEntriesSubset(path, []string{"expected"}); err == nil {
		t.Fatal("retry directory accepted an unexpected entry")
	}

	cleanupDir := filepath.Join(parent, "cleanup")
	if err := os.Mkdir(cleanupDir, 0o700); err != nil {
		t.Fatal(err)
	}
	temporary := filepath.Join(cleanupDir, ".expected.partial-interrupted")
	if err := os.WriteFile(temporary, []byte("unpublished"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := requireDirectoryEntriesSubset(cleanupDir, []string{"expected"}); err != nil {
		t.Fatalf("clean interrupted temporary: %v", err)
	}
	if _, err := os.Lstat(temporary); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("interrupted temporary remains: %v", err)
	}

	filePath := filepath.Join(parent, "not-a-dir")
	if err := os.WriteFile(filePath, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := makeOrResumePrivateDir(filePath); err == nil {
		t.Fatal("regular file accepted as retry directory")
	}
}

func TestMkdirAllPrivateDurableCreatesPrivateHierarchy(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "phase1", "contributions", "0001")
	if err := mkdirAllPrivateDurable(path); err != nil {
		t.Fatal(err)
	}
	for current := path; filepath.Base(current) != "phase1"; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil {
			t.Fatal(err)
		}
		if !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("created directory %s mode = %v", current, info.Mode())
		}
	}
}

func assertExactFile(t *testing.T, path string, expected []byte) {
	t.Helper()
	actual, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, expected) {
		t.Fatalf("%s differs from expected bytes", path)
	}
}
