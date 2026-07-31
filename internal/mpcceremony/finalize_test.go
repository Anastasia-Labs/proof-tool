package mpcceremony

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"proof-tool/internal/keybundle"
)

func TestWriteBytesNoReplacePreservesExistingArtifact(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "artifact.bin")
	if err := writeBytesNoReplace(path, []byte("accepted"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := writeBytesNoReplace(path, []byte("replacement"), 0o600)
	if !errors.Is(err, fs.ErrExist) {
		t.Fatalf("second write error = %v, want fs.ErrExist", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "accepted" {
		t.Fatalf("existing artifact changed to %q", got)
	}
}

func TestMakeFreshPrivateDirRejectsExistingDirectory(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "candidate")
	if err := makeFreshPrivateDir(path); err != nil {
		t.Fatal(err)
	}
	if err := makeFreshPrivateDir(path); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("second directory creation error = %v, want fs.ErrExist", err)
	}
}

func TestRequireIdentityKeyRejectsDifferentExistingKey(t *testing.T) {
	t.Parallel()

	publicA, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicB, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := NewIdentity("release", "Release signer", "release-key", publicA)
	if err != nil {
		t.Fatal(err)
	}
	if err := requireIdentityKey(identity, publicB); err == nil {
		t.Fatal("different public key was accepted for signed identity")
	}
}

func TestLoadExistingReleaseKeyNeverGeneratesMissingKey(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "missing-release-key.hex")
	if _, _, err := keybundle.LoadExistingPrivateKey(path); err == nil {
		t.Fatal("missing release key was accepted")
	}
	if _, err := os.Lstat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing release key was created: %v", err)
	}
}

func TestExactBeaconChallengeRequiresExactly32Bytes(t *testing.T) {
	t.Parallel()

	record := BeaconRecord{ChallengeHex: hex.EncodeToString(make([]byte, 33))}
	if _, err := exactBeaconChallenge(record); err == nil || !strings.Contains(err.Error(), "exactly 32") {
		t.Fatalf("33-byte challenge error = %v", err)
	}
	record.ChallengeHex = hex.EncodeToString(make([]byte, 32))
	challenge, err := exactBeaconChallenge(record)
	if err != nil {
		t.Fatal(err)
	}
	if len(challenge) != 32 {
		t.Fatalf("challenge length = %d", len(challenge))
	}
}

func TestPublicFinalizationEvidenceBindsOnlyPublicStatementAndProof(t *testing.T) {
	t.Parallel()

	readGoldenHex := func(name string) []byte {
		t.Helper()
		data, err := os.ReadFile(filepath.Join(
			"..", "..", "contracts", "ownership-verifier", "testdata", name,
		))
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := hex.DecodeString(strings.TrimSpace(string(data)))
		if err != nil {
			t.Fatal(err)
		}
		return decoded
	}
	credential, err := hex.DecodeString(GoldenPublicCredentialHex)
	if err != nil {
		t.Fatal(err)
	}
	destination, err := hex.DecodeString(GoldenPublicDestinationHex)
	if err != nil {
		t.Fatal(err)
	}
	publicInputDigest := readGoldenHex("ownership-destination-pub.hex")
	proof := readGoldenHex("ownership-destination-proof.hex")
	cardanoVK := readGoldenHex("ownership-destination-vk.hex")
	evidence := PublicFinalizationEvidence{
		Schema:                PublicEvidenceSchema,
		CeremonyID:            NewDigest([]byte("ceremony")).SHA256,
		Fixture:               PublicEvidenceFixture,
		CredentialHex:         hex.EncodeToString(credential),
		DestinationHex:        hex.EncodeToString(destination),
		PublicInputDigestHex:  hex.EncodeToString(publicInputDigest),
		CardanoProofHex:       hex.EncodeToString(proof),
		CardanoProofFormat:    expectedCardanoBSB22,
		CardanoProofRawDigest: NewDigest(proof),
		CardanoVerifyingKey:   refForTest(CardanoVKBytesFile, cardanoVK),
	}
	if err := evidence.Validate(); err != nil {
		t.Fatalf("valid public evidence rejected: %v", err)
	}
	changedDestination := evidence
	changedDestination.DestinationHex = changedDestination.DestinationHex[:len(changedDestination.DestinationHex)-1] + "1"
	if err := changedDestination.Validate(); err == nil {
		t.Fatal("public evidence accepted a destination that differs from its digest")
	}
	changedCredential := evidence
	changedCredential.CredentialHex = "18" + changedCredential.CredentialHex[2:]
	if err := changedCredential.Validate(); err == nil {
		t.Fatal("public evidence accepted a non-golden credential")
	}
	changedProof := evidence
	changedProof.CardanoProofHex = "34" + changedProof.CardanoProofHex[2:]
	if err := changedProof.Validate(); err == nil {
		t.Fatal("public evidence accepted proof bytes that differ from the reportable proof digest")
	}
}

func refForTest(name string, content []byte) ArtifactRef {
	return ArtifactRef{Name: name, Digest: NewDigest(content)}
}

func TestCandidateChecksumsDetectTampering(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	name := "candidate.json"
	if err := writeBytesNoReplace(filepath.Join(dir, name), []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	checksums := filepath.Join(dir, CandidateChecksumsFile)
	if err := writeChecksumsNoReplace(dir, checksums, []string{name}); err != nil {
		t.Fatal(err)
	}
	if err := verifyChecksumsExact(dir, checksums, []string{name}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := verifyChecksumsExact(dir, checksums, []string{name}); err == nil {
		t.Fatal("tampered candidate passed checksum verification")
	}
}

func TestChecksumsRequireExactExpectedSet(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	for _, name := range []string{"a.bin", "b.bin"} {
		if err := writeBytesNoReplace(filepath.Join(dir, name), []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	checksums := filepath.Join(dir, CandidateChecksumsFile)
	if err := writeChecksumsNoReplace(dir, checksums, []string{"a.bin"}); err != nil {
		t.Fatal(err)
	}
	if err := verifyChecksumsExact(dir, checksums, []string{"a.bin", "b.bin"}); err == nil {
		t.Fatal("checksum file omitting an expected artifact was accepted")
	}
}

func TestReleaseChecksumsAndTreeRequireExactBundledAuditAndOperationalEvidenceSet(t *testing.T) {
	dir := t.TempDir()
	operationalNames := []string{
		"operational/evidence-bundle.json",
		"operational/evidence-bundle.sig",
		"operational/enrollments/witness-01.json",
		"operational/enrollments/witness-01.sig",
		"operational/phase1/close.json",
		"operational/phase1/close.sig",
	}
	names := releaseChecksumNames(2, operationalNames)
	for _, name := range names {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("artifact:"+name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	checksums := filepath.Join(dir, ReleaseChecksumsFile)
	if err := writeChecksumsNoReplace(dir, checksums, names); err != nil {
		t.Fatal(err)
	}
	if err := verifyChecksumsExact(dir, checksums, names); err != nil {
		t.Fatal(err)
	}
	if err := verifyReleaseTreeExact(dir, 2, operationalNames); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "unexpected.txt"), []byte("injected"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := verifyReleaseTreeExact(dir, 2, operationalNames); err == nil {
		t.Fatal("release tree accepted an unexpected injected file")
	}
}

func TestArtifactRefRejectsSymlink(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	target := filepath.Join(dir, "target.bin")
	if err := os.WriteFile(target, []byte("artifact"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.bin")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := artifactRefForFile("link.bin", link); err == nil {
		t.Fatal("symlink artifact was accepted")
	}
}

func TestReleaseStagingRequiresFreshDistinctDestination(t *testing.T) {
	t.Parallel()

	parent := t.TempDir()
	candidate := filepath.Join(parent, "candidate")
	if err := os.Mkdir(candidate, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := createReleaseStagingDir(candidate, candidate); err == nil {
		t.Fatal("candidate directory was accepted as release destination")
	}
	existing := filepath.Join(parent, "release")
	if err := os.Mkdir(existing, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := createReleaseStagingDir(existing, candidate); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("existing release destination error = %v, want fs.ErrExist", err)
	}
}

func TestLinuxReleasePublicationNeverReplacesEmptyDestination(t *testing.T) {
	t.Parallel()
	if runtime.GOOS != "linux" {
		t.Skip("production no-replace directory publication is Linux-specific")
	}

	parent := t.TempDir()
	staging := filepath.Join(parent, "staging")
	destination := filepath.Join(parent, "release")
	if err := os.Mkdir(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "artifact"), []byte("candidate"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(destination, 0o700); err != nil {
		t.Fatal(err)
	}

	if err := publishReleaseDirectory(staging, destination); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("publish over empty destination error = %v, want fs.ErrExist", err)
	}
	if _, err := os.Stat(filepath.Join(staging, "artifact")); err != nil {
		t.Fatalf("failed publication changed staging directory: %v", err)
	}
	entries, err := os.ReadDir(destination)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatal("failed publication replaced or populated existing destination")
	}
}
