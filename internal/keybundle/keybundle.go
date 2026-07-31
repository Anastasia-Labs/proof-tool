// Package keybundle verifies signed native gnark proving/verifying-key bundles
// and provides the Ed25519 key-loading primitives shared by ceremony tools.
package keybundle

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"

	"proof-tool/internal/artifact"
	"proof-tool/internal/keyprofile"
	"proof-tool/internal/strictjson"
)

const (
	ManifestFile          = "manifest.json"
	ManifestSignatureFile = "manifest.sig"
	ManifestPublicKeyFile = "manifest-public-key.hex"
	maxManifestBytes      = 2 << 20
	maxSignatureHexBytes  = ed25519.SignatureSize*2 + 2
	maxPublicKeyHexBytes  = ed25519.PublicKeySize*2 + 2
	maxPrivateKeyHexBytes = ed25519.PrivateKeySize*2 + 2
)

// VerifyOptions defines the signed bundle identity and trust anchor expected by
// Verify. PublicKeyHex must come from the caller's chosen trust channel.
type VerifyOptions struct {
	KeysDir                string
	KeyVersion             string
	PublicKeyHex           string
	ExpectedSignatureKeyID string
	RequireProvingKey      bool
}

// Verify checks the supported circuit profile, native PK/VK file pins,
// signature-key identity, and Ed25519 signature over the exact manifest bytes.
func Verify(opts VerifyOptions) (*artifact.KeyManifest, error) {
	if strings.TrimSpace(opts.PublicKeyHex) == "" {
		return nil, errors.New("trusted manifest public key is required")
	}
	manifestBytes, err := readBoundedRegular(
		filepath.Join(opts.KeysDir, ManifestFile),
		maxManifestBytes,
		false,
	)
	if err != nil {
		return nil, fmt.Errorf("read manifest: %w", err)
	}
	if err := verifyManifestSignatureBytes(
		manifestBytes,
		filepath.Join(opts.KeysDir, ManifestSignatureFile),
		opts.PublicKeyHex,
	); err != nil {
		return nil, err
	}
	signedManifest, err := parseManifestBytes(manifestBytes)
	if err != nil {
		return nil, err
	}
	keyVersion := opts.KeyVersion
	if strings.TrimSpace(keyVersion) == "" {
		keyVersion = signedManifest.KeyVersion
	}
	profile, err := keyprofile.ForKeyVersion(keyVersion)
	if err != nil {
		return nil, err
	}
	status := profile.Inspect(opts.KeysDir, opts.RequireProvingKey)
	if !status.Ready {
		return nil, fmt.Errorf("key bundle is not ready: %s", status.Error)
	}
	if err := requireManifestMatch(signedManifest, status.Manifest); err != nil {
		return nil, err
	}
	manifest := signedManifest
	if opts.ExpectedSignatureKeyID != "" && manifest.SignatureKeyID != opts.ExpectedSignatureKeyID {
		return nil, fmt.Errorf(
			"manifest signature_key_id %q, want %q",
			manifest.SignatureKeyID,
			opts.ExpectedSignatureKeyID,
		)
	}
	return manifest, nil
}

// VerifyManifestSignature verifies the detached Ed25519 signature over the
// exact manifest bytes.
func VerifyManifestSignature(manifestPath, signaturePath, publicKeyHex string) error {
	manifestBytes, err := readBoundedRegular(manifestPath, maxManifestBytes, false)
	if err != nil {
		return fmt.Errorf("read manifest: %w", err)
	}
	return verifyManifestSignatureBytes(manifestBytes, signaturePath, publicKeyHex)
}

func verifyManifestSignatureBytes(manifestBytes []byte, signaturePath, publicKeyHex string) error {
	signatureHex, err := readBoundedRegular(signaturePath, maxSignatureHexBytes, false)
	if err != nil {
		return fmt.Errorf("read manifest signature: %w", err)
	}
	signature, err := hex.DecodeString(strings.TrimSpace(string(signatureHex)))
	if err != nil {
		return fmt.Errorf("decode manifest signature hex: %w", err)
	}
	if len(signature) != ed25519.SignatureSize {
		return fmt.Errorf("manifest signature is %d bytes, want %d", len(signature), ed25519.SignatureSize)
	}
	publicKey, err := DecodePublicKeyHex(publicKeyHex)
	if err != nil {
		return err
	}
	if !ed25519.Verify(publicKey, manifestBytes, signature) {
		return errors.New("manifest signature verification failed")
	}
	return nil
}

func parseManifestBytes(data []byte) (*artifact.KeyManifest, error) {
	var manifest artifact.KeyManifest
	if err := strictjson.Unmarshal(data, &manifest); err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}
	if manifest.Schema != artifact.ManifestSchema {
		return nil, fmt.Errorf(
			"manifest schema %q, want %q",
			manifest.Schema,
			artifact.ManifestSchema,
		)
	}
	return &manifest, nil
}

func requireManifestMatch(signed, inspected *artifact.KeyManifest) error {
	if signed == nil || inspected == nil || !reflect.DeepEqual(*signed, *inspected) {
		return errors.New("manifest changed after signature verification")
	}
	return nil
}

// ManifestPublicKeyForVerification resolves a caller-supplied public key or,
// for local integrity checks, the copy bundled beside the manifest. The
// returned bool is true only for a caller-supplied trust anchor.
func ManifestPublicKeyForVerification(keysDir, publicKeyHex, publicKeyFile string) (string, bool, error) {
	if publicKeyHex != "" && publicKeyFile != "" {
		return "", false, errors.New("use only one of --manifest-public-key or --manifest-public-key-file")
	}
	if publicKeyHex != "" {
		return strings.TrimSpace(publicKeyHex), true, nil
	}
	if publicKeyFile != "" {
		value, err := readTrimmedFile(publicKeyFile)
		return value, true, err
	}
	value, err := readTrimmedFile(filepath.Join(keysDir, ManifestPublicKeyFile))
	return value, false, err
}

// LoadExistingPrivateKey loads an existing hex-encoded Ed25519 seed or private
// key and derives its public key. It never creates or modifies any file.
func LoadExistingPrivateKey(path string) (ed25519.PrivateKey, ed25519.PublicKey, error) {
	if strings.TrimSpace(path) == "" {
		return nil, nil, errors.New("signing key path is required")
	}
	rawHex, err := readBoundedRegular(path, maxPrivateKeyHexBytes, true)
	if err != nil {
		return nil, nil, fmt.Errorf("read signing key %s: %w", path, err)
	}
	privateKey, err := DecodePrivateKeyHex(strings.TrimSpace(string(rawHex)))
	if err != nil {
		return nil, nil, fmt.Errorf("read signing key %s: %w", path, err)
	}
	publicKey := privateKey.Public().(ed25519.PublicKey)
	return privateKey, publicKey, nil
}

// DecodePrivateKeyHex accepts either a 32-byte Ed25519 seed or a 64-byte
// Ed25519 private key.
func DecodePrivateKeyHex(value string) (ed25519.PrivateKey, error) {
	raw, err := hex.DecodeString(strings.TrimSpace(value))
	if err != nil {
		return nil, err
	}
	switch len(raw) {
	case ed25519.SeedSize:
		return ed25519.NewKeyFromSeed(raw), nil
	case ed25519.PrivateKeySize:
		derived := ed25519.NewKeyFromSeed(raw[:ed25519.SeedSize])
		if !bytes.Equal(raw, derived) {
			return nil, errors.New("Ed25519 private key public half does not match its seed")
		}
		return derived, nil
	default:
		return nil, fmt.Errorf(
			"Ed25519 private key is %d bytes, want %d-byte seed or %d-byte private key",
			len(raw),
			ed25519.SeedSize,
			ed25519.PrivateKeySize,
		)
	}
}

// DecodePublicKeyHex decodes the 32-byte Ed25519 public key used to authenticate
// key manifests.
func DecodePublicKeyHex(value string) (ed25519.PublicKey, error) {
	raw, err := hex.DecodeString(strings.TrimSpace(value))
	if err != nil {
		return nil, fmt.Errorf("decode manifest public key hex: %w", err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("manifest public key is %d bytes, want %d", len(raw), ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(raw), nil
}

func readTrimmedFile(path string) (string, error) {
	value, err := readBoundedRegular(path, maxPublicKeyHexBytes, false)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	return strings.TrimSpace(string(value)), nil
}

func readBoundedRegular(path string, maximum int64, secret bool) ([]byte, error) {
	linkInfo, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !linkInfo.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", path)
	}
	if secret && runtime.GOOS != "windows" && linkInfo.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%s has group/world permission bits; require mode 0600 or stricter", path)
	}
	if linkInfo.Size() <= 0 || linkInfo.Size() > maximum {
		return nil, fmt.Errorf("%s size %d is outside [1,%d]", path, linkInfo.Size(), maximum)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || !os.SameFile(linkInfo, info) {
		return nil, fmt.Errorf("%s changed while being opened", path)
	}
	if info.Size() != linkInfo.Size() {
		return nil, fmt.Errorf("%s changed size while being opened", path)
	}
	data := make([]byte, info.Size())
	if _, err := io.ReadFull(file, data); err != nil {
		return nil, err
	}
	var extra [1]byte
	if n, err := file.Read(extra[:]); n != 0 || (err != nil && !errors.Is(err, io.EOF)) {
		return nil, fmt.Errorf("%s changed while being read", path)
	}
	return data, nil
}
