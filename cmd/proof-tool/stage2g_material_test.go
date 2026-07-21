package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/blake2b"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownershipdest"
	"proof-tool/internal/prover"
)

func TestParseStage2gDestination(t *testing.T) {
	addressBytes := strings.Repeat("ab", stage2gDestinationByteCount)
	got, err := parseStage2gDestination("addr_test1stage2gdestination", addressBytes)
	if err != nil {
		t.Fatalf("parseStage2gDestination() error = %v", err)
	}
	if len(got) != stage2gDestinationByteCount {
		t.Fatalf("destination length = %d, want %d", len(got), stage2gDestinationByteCount)
	}
	if _, err := parseStage2gDestination("addr1mainnet", addressBytes); err == nil {
		t.Fatal("mainnet destination unexpectedly accepted")
	}
}

func TestValidateStage2gCardanoVKRequiresExactCommitmentLength(t *testing.T) {
	if prover.CardanoVKCommitmentLen != 672 {
		t.Fatalf("Cardano commitment VK length = %d, want 672", prover.CardanoVKCommitmentLen)
	}
	for _, length := range []int{671, 673} {
		if err := validateStage2gCardanoVK(make([]byte, length), "groth16-bls12-381-bsb22"); err == nil {
			t.Fatalf("validateStage2gCardanoVK accepted %d-byte VK", length)
		}
	}
	if err := validateStage2gCardanoVK(make([]byte, 672), "groth16-bls12-381-bsb22"); err != nil {
		t.Fatalf("validateStage2gCardanoVK rejected exact 672-byte commitment VK: %v", err)
	}
	if err := validateStage2gCardanoVK(make([]byte, 672), "groth16-bls12-381"); err == nil {
		t.Fatal("validateStage2gCardanoVK accepted vanilla VK format")
	}
}

func TestValidateStage2gCardanoProofRequiresExactCommitmentLength(t *testing.T) {
	if prover.CardanoProofCommitmentLen != 336 {
		t.Fatalf("Cardano commitment proof length = %d, want 336", prover.CardanoProofCommitmentLen)
	}
	for _, length := range []int{335, 337} {
		if err := validateStage2gCardanoProofArtifact("groth16-bls12-381-bsb22", strings.Repeat("ab", length), strings.Repeat("cd", 32)); err == nil {
			t.Fatalf("validateStage2gCardanoProofArtifact accepted %d-byte proof", length)
		}
	}
	if err := validateStage2gCardanoProofArtifact("groth16-bls12-381-bsb22", strings.Repeat("ab", 336), strings.Repeat("cd", 32)); err != nil {
		t.Fatalf("validateStage2gCardanoProofArtifact rejected exact 336-byte commitment proof: %v", err)
	}
	if err := validateStage2gCardanoProofArtifact("groth16-bls12-381", strings.Repeat("ab", 336), strings.Repeat("cd", 32)); err == nil {
		t.Fatal("validateStage2gCardanoProofArtifact accepted vanilla proof format")
	}
}

func TestReadStage2gCompromisedMasterDoesNotEchoMnemonic(t *testing.T) {
	const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
	path := filepath.Join(t.TempDir(), "wallets.json")
	contents := `{"wallets":{"compromised_user":{"mnemonic":"` + mnemonic + `"}}}`
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	master, err := readStage2gCompromisedMaster(path)
	if err != nil {
		t.Fatalf("readStage2gCompromisedMaster() error = %v", err)
	}
	if len(master) != 96 {
		t.Fatalf("master length = %d, want 96", len(master))
	}
	clear(master)

	missingPath := filepath.Join(t.TempDir(), "missing.json")
	if _, err := readStage2gCompromisedMaster(missingPath); err == nil || strings.Contains(err.Error(), mnemonic) {
		t.Fatalf("missing wallet error leaked mnemonic or did not fail: %v", err)
	}
}

func TestCmdGenerateStage2gV2MaterialDoesNotEchoUnexpectedPositionalArgument(t *testing.T) {
	const sensitiveArgument = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
	err := cmdGenerateStage2gV2Material([]string{sensitiveArgument})
	if err == nil {
		t.Fatal("cmdGenerateStage2gV2Material accepted an unexpected positional argument")
	}
	if strings.Contains(err.Error(), sensitiveArgument) {
		t.Fatalf("unexpected positional argument leaked through the error: %v", err)
	}
}

func TestCmdGenerateStage2gV2MaterialRequiresTrustFlagsBeforeWalletAccess(t *testing.T) {
	const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
	walletPath := filepath.Join(t.TempDir(), "wallet-with-"+mnemonic)
	for _, args := range [][]string{
		{"--wallet-file", walletPath, "--keys-dir", t.TempDir()},
		{"--wallet-file", walletPath, "--keys-dir", t.TempDir(), "--manifest-public-key-file", filepath.Join(t.TempDir(), "trusted.hex")},
		{"--wallet-file", walletPath, "--keys-dir", t.TempDir(), "--manifest-public-key-file", " ", "--signature-key-id", "stage2g-test-signer"},
		{"--wallet-file", walletPath, "--keys-dir", t.TempDir(), "--manifest-public-key-file", filepath.Join(t.TempDir(), "trusted.hex"), "--signature-key-id", " "},
	} {
		err := cmdGenerateStage2gV2Material(args)
		if err == nil || !strings.Contains(err.Error(), "--manifest-public-key-file and --signature-key-id are required") {
			t.Fatalf("missing trust flags error = %v", err)
		}
		if strings.Contains(err.Error(), mnemonic) || strings.Contains(err.Error(), "read local Stage 2g wallet file") {
			t.Fatalf("missing trust flags accessed or leaked wallet material: %v", err)
		}
	}
}

func TestStage2gTrustedManifestPublicKeyRejectsBundledPublicKeyFile(t *testing.T) {
	keysDir := t.TempDir()
	bundledPublicKey := filepath.Join(keysDir, manifestPublicKeyFile)
	if err := os.WriteFile(bundledPublicKey, []byte(strings.Repeat("ab", 32)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := stage2gTrustedManifestPublicKey(keysDir, bundledPublicKey); err == nil || err.Error() != "--manifest-public-key-file must be outside --keys-dir" {
		t.Fatalf("bundled trust-anchor error = %v", err)
	}
}

func TestStage2gTrustedManifestPublicKeyRejectsSymlinkContainedPublicKeyFile(t *testing.T) {
	keysDir := t.TempDir()
	bundledPublicKey := filepath.Join(keysDir, manifestPublicKeyFile)
	if err := os.WriteFile(bundledPublicKey, []byte(strings.Repeat("ab", 32)), 0o600); err != nil {
		t.Fatal(err)
	}
	redirect := filepath.Join(t.TempDir(), "bundle-link")
	if err := os.Symlink(keysDir, redirect); err != nil {
		t.Fatal(err)
	}
	if _, err := stage2gTrustedManifestPublicKey(keysDir, filepath.Join(redirect, manifestPublicKeyFile)); err == nil || err.Error() != "--manifest-public-key-file must be outside --keys-dir" {
		t.Fatalf("symlink-contained trust-anchor error = %v", err)
	}
}

func TestStage2gTrustedManifestPublicKeyRejectsHardLinkContainedPublicKeyFile(t *testing.T) {
	keysDir := t.TempDir()
	bundledPublicKey := filepath.Join(keysDir, manifestPublicKeyFile)
	if err := os.WriteFile(bundledPublicKey, []byte(strings.Repeat("ab", 32)), 0o600); err != nil {
		t.Fatal(err)
	}
	externalHardLink := filepath.Join(t.TempDir(), "trusted-manifest-public-key.hex")
	if err := os.Link(bundledPublicKey, externalHardLink); err != nil {
		t.Fatal(err)
	}
	if _, err := stage2gTrustedManifestPublicKey(keysDir, externalHardLink); err == nil || err.Error() != "--manifest-public-key-file must not be hard-linked into --keys-dir" {
		t.Fatalf("hard-linked trust-anchor error = %v", err)
	}
}

func TestStage2gTrustedManifestPublicKeyAcceptsExternalRegularFile(t *testing.T) {
	keysDir := t.TempDir()
	trustedPublicKey := filepath.Join(t.TempDir(), "trusted-manifest-public-key.hex")
	want := strings.Repeat("ab", 32)
	if err := os.WriteFile(trustedPublicKey, []byte(want), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := stage2gTrustedManifestPublicKey(keysDir, trustedPublicKey)
	if err != nil {
		t.Fatalf("stage2gTrustedManifestPublicKey() error = %v", err)
	}
	if got != want {
		t.Fatalf("trusted public key = %q, want %q", got, want)
	}
}

func TestCmdGenerateStage2gV2MaterialRejectsWrongSignatureKeyIDBeforeWalletAccess(t *testing.T) {
	keysDir, trustedPublicKey, signatureKeyID := writeStage2gTestSignedBundle(t)
	missingWallet := filepath.Join(t.TempDir(), "wallets.json")
	err := cmdGenerateStage2gV2Material(stage2gTestCommandArgs(missingWallet, keysDir, trustedPublicKey, "wrong-"+signatureKeyID))
	if err == nil || !strings.Contains(err.Error(), "manifest signature_key_id") {
		t.Fatalf("wrong signature key id error = %v", err)
	}
	if strings.Contains(err.Error(), "read local Stage 2g wallet file") {
		t.Fatalf("wrong signature key id reached wallet access: %v", err)
	}
}

func TestCmdGenerateStage2gV2MaterialAcceptsValidExternalSignedBundleBeforeWalletAccess(t *testing.T) {
	keysDir, trustedPublicKey, signatureKeyID := writeStage2gTestSignedBundle(t)
	missingWallet := filepath.Join(t.TempDir(), "wallets.json")
	err := cmdGenerateStage2gV2Material(stage2gTestCommandArgs(missingWallet, keysDir, trustedPublicKey, signatureKeyID))
	if err == nil || err.Error() != "read local Stage 2g wallet file" {
		t.Fatalf("valid external signed bundle did not reach wallet stage: %v", err)
	}
}

func TestWriteStage2gMaterialIsPrivateAndExclusive(t *testing.T) {
	repoRoot := t.TempDir()
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(repoRoot); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chdir(workingDirectory) }()
	out := filepath.Join("output", "preprod-e2e", "stage2g-v2", "nested", "material.json")
	material := stage2gMaterial{Schema: stage2gMaterialSchema, Network: stage2gNetwork, Policy: stage2gFixedPolicy()}
	if err := writeStage2gMaterial(out, material); err != nil {
		t.Fatalf("writeStage2gMaterial() error = %v", err)
	}
	info, err := os.Stat(out)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("material mode = %o, want 600", got)
	}
	if err := writeStage2gMaterial(out, material); err == nil {
		t.Fatal("writeStage2gMaterial overwrote an existing material file")
	}
	if err := writeStage2gMaterial(filepath.Join(repoRoot, "outside.json"), material); err == nil {
		t.Fatal("writeStage2gMaterial accepted an output outside its dedicated directory")
	}
	if err := writeStage2gMaterial(filepath.Join(repoRoot, "output", "preprod-e2e", "stage2g-v2", "absolute.json"), material); err == nil {
		t.Fatal("writeStage2gMaterial accepted an absolute output path")
	}
}

func TestWriteStage2gMaterialRejectsExistingIntermediateSymlink(t *testing.T) {
	repoRoot := t.TempDir()
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(repoRoot); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chdir(workingDirectory) }()

	stageRoot := filepath.Join("output", "preprod-e2e", "stage2g-v2")
	if err := os.MkdirAll(stageRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	escapedDirectory := filepath.Join(repoRoot, "outside-stage2g-root")
	if err := os.MkdirAll(escapedDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	redirect := filepath.Join(stageRoot, "redirect")
	if err := os.Symlink(escapedDirectory, redirect); err != nil {
		t.Fatal(err)
	}

	materialPath := filepath.Join(redirect, "material.json")
	material := stage2gMaterial{Schema: stage2gMaterialSchema, Network: stage2gNetwork, Policy: stage2gFixedPolicy()}
	if err := writeStage2gMaterial(materialPath, material); err == nil {
		t.Fatal("writeStage2gMaterial accepted an output through an intermediate symbolic link")
	}
	if _, err := os.Lstat(filepath.Join(escapedDirectory, "material.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("writeStage2gMaterial wrote through an intermediate symbolic link: %v", err)
	}
}

func TestStage2gSyntheticHashesAreStableAndDistinct(t *testing.T) {
	first := stage2gSyntheticHash("params-utxo")
	if len(first) != 64 || first != stage2gSyntheticHash("params-utxo") {
		t.Fatalf("synthetic hash is not stable 32-byte hex: %q", first)
	}
	if first == stage2gSyntheticHash("bootstrap-0") {
		t.Fatal("different synthetic labels produced the same outref hash")
	}
}

func stage2gTestCommandArgs(walletPath, keysDir, trustedPublicKey, signatureKeyID string) []string {
	return []string{
		"--wallet-file", walletPath,
		"--keys-dir", keysDir,
		"--manifest-public-key-file", trustedPublicKey,
		"--signature-key-id", signatureKeyID,
		"--destination-address", "addr_test1stage2gdestination",
		"--destination-address-bytes", strings.Repeat("ab", stage2gDestinationByteCount),
	}
}

func writeStage2gTestSignedBundle(t *testing.T) (keysDir, trustedPublicKey, signatureKeyID string) {
	t.Helper()
	keysDir = t.TempDir()
	pk := []byte("stage2g test proving key")
	vk := []byte("stage2g test verifying key")
	pkPath := filepath.Join(keysDir, "ownership.pk")
	vkPath := filepath.Join(keysDir, "ownership.vk")
	if err := os.WriteFile(pkPath, pk, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(vkPath, vk, 0o600); err != nil {
		t.Fatal(err)
	}
	pkSHA256, pkBlake2b256 := stage2gTestFileDigests(pk)
	vkSHA256, vkBlake2b256 := stage2gTestFileDigests(vk)
	signatureKeyID = "stage2g-test-signer"
	manifest := &artifact.KeyManifest{
		Schema:               artifact.ManifestSchema,
		KeyVersion:           prover.DefaultDestinationKeyVersion,
		CircuitID:            ownershipdest.CircuitID,
		Curve:                "BLS12-381",
		Backend:              "groth16",
		VKHash:               vkBlake2b256,
		ProvingKeySHA256:     pkSHA256,
		ProvingKeyBlake2b256: pkBlake2b256,
		ProvingKeySize:       int64(len(pk)),
		VerifyingKeySHA256:   vkSHA256,
		VerifyingKeySize:     int64(len(vk)),
		SignatureKeyID:       signatureKeyID,
	}
	manifestPath := filepath.Join(keysDir, "manifest.json")
	if err := artifact.WriteJSON(manifestPath, manifest); err != nil {
		t.Fatal(err)
	}
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index + 1)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	signature := ed25519.Sign(privateKey, manifestBytes)
	if err := os.WriteFile(filepath.Join(keysDir, manifestSignatureFile), []byte(hex.EncodeToString(signature)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	trustedPublicKey = filepath.Join(t.TempDir(), "trusted-manifest-public-key.hex")
	publicKey := privateKey.Public().(ed25519.PublicKey)
	if err := os.WriteFile(trustedPublicKey, []byte(hex.EncodeToString(publicKey)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return keysDir, trustedPublicKey, signatureKeyID
}

func stage2gTestFileDigests(data []byte) (sha256Digest, blake2b256Digest string) {
	sha := sha256.Sum256(data)
	blake := blake2b.Sum256(data)
	return "sha256:" + hex.EncodeToString(sha[:]), "blake2b256:" + hex.EncodeToString(blake[:])
}
