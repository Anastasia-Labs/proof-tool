package mpcceremony

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveArtifactPathRejectsSymlinkComponent(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "genesis.bin"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "phase1")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := resolveArtifactPath(root, "phase1/genesis.bin"); err == nil ||
		!strings.Contains(err.Error(), "symbolic-link") {
		t.Fatalf("resolve through symlink error = %v, want symbolic-link rejection", err)
	}
}

func TestReadRegularBoundedRejectsSymlinkLeaf(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target.json")
	if err := os.WriteFile(target, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link.json")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := readRegularBounded(link, 1024); err == nil ||
		!strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("read symlink error = %v, want symbolic-link rejection", err)
	}
}

func TestCanonicalInitInputsRejectUnknownAndNonCanonicalJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "environment.json")
	valid := ContributionEnvironment{
		OS:                           "linux",
		Architecture:                 "amd64",
		EntropySource:                "operating-system-csprng",
		SwapDisabled:                 true,
		CrashDumpsDisabled:           true,
		TelemetryDisabled:            true,
		EphemeralEnvironment:         true,
		EphemeralDestructionRequired: true,
	}
	data, err := MarshalCanonical(valid)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadContributionEnvironment(path); err != nil {
		t.Fatalf("load canonical environment: %v", err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadContributionEnvironment(path); err == nil {
		t.Fatal("non-canonical JSON with trailing newline was accepted")
	}
}

func TestLoadSignedDefinitionAuthenticatesBeforeSemanticParsing(t *testing.T) {
	definition := adversarialDefinition(t)
	definitionBytes, err := MarshalCanonical(definition)
	if err != nil {
		t.Fatal(err)
	}
	privateKey := adversarialPrivateKey(0x01)
	signature, err := SignExact(definitionBytes, definition.Coordinator.KeyID, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	signatureBytes, err := MarshalCanonical(signature)
	if err != nil {
		t.Fatal(err)
	}

	// This remains canonical JSON but is semantically invalid. Because its
	// detached signature covers the original bytes, authentication must fail
	// before the invalid mode is interpreted.
	tamperedDefinition := bytes.Replace(
		definitionBytes,
		[]byte(`"mode":"production"`),
		[]byte(`"mode":"invalid-mode"`),
		1,
	)
	if bytes.Equal(tamperedDefinition, definitionBytes) {
		t.Fatal("test did not tamper definition")
	}

	dir := t.TempDir()
	definitionPath := filepath.Join(dir, "ceremony.json")
	signaturePath := filepath.Join(dir, "ceremony.sig")
	publicKeyPath := filepath.Join(dir, "coordinator-public-key.hex")
	if err := os.WriteFile(definitionPath, tamperedDefinition, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(signaturePath, signatureBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	publicKey := privateKey.Public().(ed25519.PublicKey)
	if err := os.WriteFile(publicKeyPath, []byte(hex.EncodeToString(publicKey)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err = LoadSignedDefinition(TrustPaths{
		DefinitionPath:           definitionPath,
		DefinitionSignaturePath:  signaturePath,
		CoordinatorPublicKeyPath: publicKeyPath,
	})
	if err == nil {
		t.Fatal("tampered definition unexpectedly accepted")
	}
	if !strings.Contains(err.Error(), "signed-data digest mismatch") {
		t.Fatalf("LoadSignedDefinition() error = %v, want authentication failure before semantic parsing", err)
	}
	if strings.Contains(err.Error(), "mode") {
		t.Fatalf("LoadSignedDefinition() parsed unauthenticated mode before verification: %v", err)
	}
}
