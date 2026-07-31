package keybundle

import (
	"crypto/ed25519"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"proof-tool/internal/artifact"
)

func TestLoadExistingPrivateKeyDoesNotGenerate(t *testing.T) {
	dir := t.TempDir()
	missingPath := filepath.Join(dir, "missing.private.hex")
	if _, _, err := LoadExistingPrivateKey(missingPath); err == nil {
		t.Fatal("missing private key unexpectedly loaded")
	}
	if _, err := os.Stat(missingPath); !os.IsNotExist(err) {
		t.Fatalf("missing key was created: %v", err)
	}

	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	keyPath := filepath.Join(dir, "existing.private.hex")
	if err := os.WriteFile(keyPath, []byte(hex.EncodeToString(seed)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	privateKey, publicKey, err := LoadExistingPrivateKey(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(privateKey) != ed25519.PrivateKeySize || len(publicKey) != ed25519.PublicKeySize {
		t.Fatalf("key sizes = %d/%d", len(privateKey), len(publicKey))
	}
}

func TestLoadExistingPrivateKeyRejectsSymlinkAndLoosePermissions(t *testing.T) {
	dir := t.TempDir()
	seed := make([]byte, ed25519.SeedSize)
	target := filepath.Join(dir, "target.private.hex")
	if err := os.WriteFile(target, []byte(hex.EncodeToString(seed)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.private.hex")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, _, err := LoadExistingPrivateKey(link); err == nil {
		t.Fatal("symlinked private key was accepted")
	}

	if runtime.GOOS != "windows" {
		loose := filepath.Join(dir, "loose.private.hex")
		if err := os.WriteFile(loose, []byte(hex.EncodeToString(seed)+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, _, err := LoadExistingPrivateKey(loose); err == nil || !strings.Contains(err.Error(), "permission") {
			t.Fatalf("loosely permissioned private key error = %v", err)
		}
	}
}

func TestLoadExistingPrivateKeyRejectsOversizedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "oversized.private.hex")
	if err := os.WriteFile(path, []byte(strings.Repeat("0", maxPrivateKeyHexBytes+1)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := LoadExistingPrivateKey(path); err == nil || !strings.Contains(err.Error(), "outside") {
		t.Fatalf("oversized private key error = %v", err)
	}
}

func TestDecodePrivateKeyHexRejectsInconsistentPublicHalf(t *testing.T) {
	privateKey := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	privateKey[ed25519.SeedSize] ^= 1
	if _, err := DecodePrivateKeyHex(hex.EncodeToString(privateKey)); err == nil ||
		!strings.Contains(err.Error(), "public half") {
		t.Fatalf("inconsistent private key error = %v", err)
	}
}

func TestVerifyManifestSignatureRejectsTampering(t *testing.T) {
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, ManifestFile)
	signaturePath := filepath.Join(dir, ManifestSignatureFile)
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	manifest := []byte("{\"schema\":\"test\"}\n")
	if err := os.WriteFile(manifestPath, manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	signature := hex.EncodeToString(ed25519.Sign(privateKey, manifest)) + "\n"
	if err := os.WriteFile(signaturePath, []byte(signature), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := VerifyManifestSignature(manifestPath, signaturePath, hex.EncodeToString(publicKey)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifestPath, []byte("{\"schema\":\"tampered\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	err = VerifyManifestSignature(manifestPath, signaturePath, hex.EncodeToString(publicKey))
	if err == nil || !strings.Contains(err.Error(), "signature verification failed") {
		t.Fatalf("tampered manifest err = %v", err)
	}
}

func TestRequireManifestMatchRejectsInspectedManifestMismatch(t *testing.T) {
	signed := &artifact.KeyManifest{
		Schema:     artifact.ManifestSchema,
		KeyVersion: "signed-version",
		CircuitID:  "signed-circuit",
	}
	inspected := *signed
	inspected.CircuitID = "swapped-circuit"
	if err := requireManifestMatch(signed, &inspected); err == nil ||
		!strings.Contains(err.Error(), "changed after signature verification") {
		t.Fatalf("manifest mismatch error = %v", err)
	}
}
