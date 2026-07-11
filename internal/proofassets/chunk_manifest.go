package proofassets

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"golang.org/x/crypto/blake2b"

	"proof-tool/internal/artifact"
)

const (
	ChunkManifestSchema     = "proof-tool-proof-assets-chunk-manifest-v1"
	ProvingKeyIndexSchema   = "proof-tool-proving-key-index-v1"
	ReclaimDeploymentSchema = "proof-tool-reclaim-deployment-v1"
)

type ChunkManifest struct {
	Schema          string                  `json:"schema"`
	Release         string                  `json:"release,omitempty"`
	Profile         string                  `json:"profile,omitempty"`
	GeneratedAt     string                  `json:"generated_at"`
	SignatureKeyID  string                  `json:"signature_key_id"`
	Coherence       ChunkCoherence          `json:"coherence"`
	Transport       ChunkTransport          `json:"transport"`
	ProvingKey      ChunkedProvingKey       `json:"proving_key"`
	ProvingKeyIndex ManifestProvingKeyIndex `json:"proving_key_index"`
	Assets          map[string]AssetPin     `json:"assets,omitempty"`
}

type ChunkCoherence struct {
	KeyManifestSHA256      string `json:"key_manifest_sha256"`
	KeyManifestBlake2b256  string `json:"key_manifest_blake2b256"`
	KeyVersion             string `json:"key_version"`
	CircuitID              string `json:"circuit_id"`
	VKHash                 string `json:"vk_hash"`
	ProvingKeySize         int64  `json:"proving_key_size"`
	ProvingKeySHA256       string `json:"proving_key_sha256"`
	ProvingKeyBlake2b256   string `json:"proving_key_blake2b256"`
	VerifyingKeySHA256     string `json:"verifying_key_sha256"`
	VerifyingKeySize       int64  `json:"verifying_key_size"`
	ConstraintSystemHash   string `json:"constraint_system_hash,omitempty"`
	SetupTranscriptHash    string `json:"setup_transcript_hash,omitempty"`
	CircuitSourceCommit    string `json:"circuit_source_commit,omitempty"`
	GnarkVersion           string `json:"gnark_version,omitempty"`
	ProofToolVersion       string `json:"proof_tool_version,omitempty"`
	CardanoVKFormat        string `json:"cardano_vk_format,omitempty"`
	CardanoVKBlake2b256    string `json:"cardano_vk_blake2b256,omitempty"`
	DeploymentID           string `json:"deployment_id"`
	DeploymentSourceCommit string `json:"deployment_source_commit,omitempty"`
}

type ChunkTransport struct {
	BaseURL         string `json:"base_url,omitempty"`
	ContentEncoding string `json:"content_encoding"`
	RequiresHTTPS   bool   `json:"requires_https"`
	SupportsRange   bool   `json:"supports_range"`
}

type ChunkedProvingKey struct {
	Path                 string     `json:"path"`
	ChunkSize            int64      `json:"chunk_size"`
	ChunksRootBlake2b256 string     `json:"chunks_root_blake2b256"`
	Chunks               []ChunkPin `json:"chunks"`
}

type ChunkPin struct {
	Index      int    `json:"index"`
	Offset     int64  `json:"offset"`
	Size       int64  `json:"size"`
	Path       string `json:"path"`
	SHA256     string `json:"sha256"`
	Blake2b256 string `json:"blake2b256"`
}

type ManifestProvingKeyIndex struct {
	Schema     string              `json:"schema"`
	FileSize   int64               `json:"file_size"`
	SHA256     string              `json:"sha256"`
	Blake2b256 string              `json:"blake2b256"`
	Sections   []ManifestPKSection `json:"sections"`
}

type ManifestPKSection struct {
	Name     string `json:"name"`
	Offset   int64  `json:"offset"`
	Len      int64  `json:"len"`
	ElemSize int    `json:"elem_size"`
}

type AssetPin struct {
	Path       string `json:"path"`
	Size       int64  `json:"size"`
	SHA256     string `json:"sha256"`
	Blake2b256 string `json:"blake2b256"`
}

type ReclaimDeploymentManifest struct {
	Schema        string `json:"schema"`
	DeploymentID  string `json:"deployment_id"`
	SourceCommit  string `json:"source_commit"`
	ReclaimGlobal struct {
		VerifierVKHash        string `json:"verifier_vk_hash"`
		ProofProfile          string `json:"proof_profile"`
		ProofSlotEncoding     string `json:"proof_slot_encoding,omitempty"`
		BatchTranscriptVKHash string `json:"batch_transcript_vk_hash,omitempty"`
	} `json:"reclaim_global"`
	Proof struct {
		CircuitID                  string `json:"circuit_id"`
		KeyVersion                 string `json:"key_version"`
		DestinationAddressEncoding string `json:"destination_address_encoding"`
		VKHash                     string `json:"vk_hash"`
		CardanoVKBlake2b256        string `json:"cardano_vk_blake2b256"`
	} `json:"proof"`
}

type ChunkManifestOptions struct {
	KeyManifest         *artifact.KeyManifest
	KeyManifestDigest   FileDigest
	Deployment          *ReclaimDeploymentManifest
	ProvingKeyPath      string
	ProvingKeyName      string
	ChunkOutDir         string
	ChunkSize           int64
	Release             string
	Profile             string
	BaseURL             string
	SignatureKeyID      string
	GeneratedAt         time.Time
	CardanoVKFormat     string
	CardanoVKBlake2b256 string
	Assets              map[string]AssetPin
}

type ChunkManifestExpectations struct {
	KeyManifest         *artifact.KeyManifest
	KeyManifestDigest   FileDigest
	Deployment          *ReclaimDeploymentManifest
	CardanoVKFormat     string
	CardanoVKBlake2b256 string
}

func GenerateChunkManifest(opts ChunkManifestOptions) (*ChunkManifest, error) {
	if opts.KeyManifest == nil {
		return nil, errors.New("key manifest is required")
	}
	if opts.Deployment == nil {
		return nil, errors.New("deployment manifest is required")
	}
	if opts.ProvingKeyPath == "" {
		return nil, errors.New("proving key path is required")
	}
	if opts.ProvingKeyName == "" {
		opts.ProvingKeyName = "ownership.pk"
	}
	if opts.ChunkSize <= 0 {
		return nil, errors.New("chunk size must be positive")
	}
	if opts.GeneratedAt.IsZero() {
		opts.GeneratedAt = time.Now().UTC()
	}
	opts.GeneratedAt = opts.GeneratedAt.UTC()
	if strings.TrimSpace(opts.SignatureKeyID) == "" {
		return nil, errors.New("signature key id is required")
	}

	pkDigest, err := DigestFile(opts.ProvingKeyPath)
	if err != nil {
		return nil, err
	}
	if err := checkKeyManifestPK(opts.KeyManifest, pkDigest); err != nil {
		return nil, err
	}
	if err := ValidateReclaimDeployment(opts.Deployment, opts.KeyManifest, opts.CardanoVKBlake2b256); err != nil {
		return nil, err
	}

	idx, err := BuildPKIndex(opts.ProvingKeyPath)
	if err != nil {
		return nil, err
	}
	if idx.FileSize != pkDigest.Size {
		return nil, fmt.Errorf("index file size %d, proving key size %d", idx.FileSize, pkDigest.Size)
	}
	manifestIndex, err := ManifestIndexFromPKIndex(idx)
	if err != nil {
		return nil, err
	}

	chunks, root, err := BuildChunkPins(ChunkPinOptions{
		SourcePath: opts.ProvingKeyPath,
		OutDir:     opts.ChunkOutDir,
		ChunkSize:  opts.ChunkSize,
		PathPrefix: strings.TrimSuffix(opts.ProvingKeyName, ".pk") + ".pk.part",
		WriteFiles: opts.ChunkOutDir != "",
	})
	if err != nil {
		return nil, err
	}
	assets := opts.Assets
	if assets == nil {
		assets = map[string]AssetPin{}
	}
	return &ChunkManifest{
		Schema:         ChunkManifestSchema,
		Release:        opts.Release,
		Profile:        opts.Profile,
		GeneratedAt:    opts.GeneratedAt.Format(time.RFC3339),
		SignatureKeyID: opts.SignatureKeyID,
		Coherence: ChunkCoherence{
			KeyManifestSHA256:      opts.KeyManifestDigest.SHA256,
			KeyManifestBlake2b256:  opts.KeyManifestDigest.Blake2b256,
			KeyVersion:             opts.KeyManifest.KeyVersion,
			CircuitID:              opts.KeyManifest.CircuitID,
			VKHash:                 opts.KeyManifest.VKHash,
			ProvingKeySize:         opts.KeyManifest.ProvingKeySize,
			ProvingKeySHA256:       opts.KeyManifest.ProvingKeySHA256,
			ProvingKeyBlake2b256:   opts.KeyManifest.ProvingKeyBlake2b256,
			VerifyingKeySHA256:     opts.KeyManifest.VerifyingKeySHA256,
			VerifyingKeySize:       opts.KeyManifest.VerifyingKeySize,
			ConstraintSystemHash:   opts.KeyManifest.ConstraintSystemHash,
			SetupTranscriptHash:    opts.KeyManifest.SetupTranscriptHash,
			CircuitSourceCommit:    opts.KeyManifest.CircuitSourceCommit,
			GnarkVersion:           opts.KeyManifest.GnarkVersion,
			ProofToolVersion:       opts.KeyManifest.ProofToolVersion,
			CardanoVKFormat:        opts.CardanoVKFormat,
			CardanoVKBlake2b256:    opts.CardanoVKBlake2b256,
			DeploymentID:           opts.Deployment.DeploymentID,
			DeploymentSourceCommit: opts.Deployment.SourceCommit,
		},
		Transport: ChunkTransport{
			BaseURL:         opts.BaseURL,
			ContentEncoding: "identity",
			RequiresHTTPS:   true,
			SupportsRange:   true,
		},
		ProvingKey: ChunkedProvingKey{
			Path:                 opts.ProvingKeyName,
			ChunkSize:            opts.ChunkSize,
			ChunksRootBlake2b256: root,
			Chunks:               chunks,
		},
		ProvingKeyIndex: manifestIndex,
		Assets:          assets,
	}, nil
}

type ChunkPinOptions struct {
	SourcePath string
	OutDir     string
	ChunkSize  int64
	PathPrefix string
	WriteFiles bool
}

func BuildChunkPins(opts ChunkPinOptions) ([]ChunkPin, string, error) {
	if opts.SourcePath == "" {
		return nil, "", errors.New("source path is required")
	}
	if opts.ChunkSize <= 0 {
		return nil, "", errors.New("chunk size must be positive")
	}
	if opts.PathPrefix == "" {
		opts.PathPrefix = "ownership.pk.part"
	}
	if opts.ChunkSize > int64(int(^uint(0)>>1)) {
		return nil, "", fmt.Errorf("chunk size %d exceeds maximum buffer size", opts.ChunkSize)
	}
	src, err := os.Open(opts.SourcePath)
	if err != nil {
		return nil, "", fmt.Errorf("open proving key %s: %w", opts.SourcePath, err)
	}
	defer src.Close()
	if opts.WriteFiles {
		if err := os.MkdirAll(opts.OutDir, 0o700); err != nil {
			return nil, "", fmt.Errorf("create chunk output directory %s: %w", opts.OutDir, err)
		}
	}
	buf := make([]byte, int(opts.ChunkSize))
	var chunks []ChunkPin
	var offset int64
	for {
		n, readErr := io.ReadFull(src, buf)
		if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
			return nil, "", fmt.Errorf("read proving key chunk %d: %w", len(chunks), readErr)
		}
		if n == 0 {
			break
		}
		raw := buf[:n]
		name := fmt.Sprintf("%s%04d", opts.PathPrefix, len(chunks))
		digest, err := DigestBytes(raw)
		if err != nil {
			return nil, "", err
		}
		if opts.WriteFiles {
			if err := os.WriteFile(filepath.Join(opts.OutDir, name), raw, 0o600); err != nil {
				return nil, "", fmt.Errorf("write chunk %s: %w", name, err)
			}
		}
		chunks = append(chunks, ChunkPin{
			Index:      len(chunks),
			Offset:     offset,
			Size:       int64(n),
			Path:       name,
			SHA256:     digest.SHA256,
			Blake2b256: digest.Blake2b256,
		})
		offset += int64(n)
		if errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF) {
			break
		}
	}
	root, err := chunksRootBlake2b256(chunks)
	if err != nil {
		return nil, "", err
	}
	return chunks, root, nil
}

func ManifestIndexFromPKIndex(idx *PKIndex) (ManifestProvingKeyIndex, error) {
	if err := ValidatePKIndex(idx); err != nil {
		return ManifestProvingKeyIndex{}, err
	}
	sections := make([]ManifestPKSection, 0, len(idx.Sections))
	for _, sec := range idx.Sections {
		sections = append(sections, ManifestPKSection(sec))
	}
	sort.Slice(sections, func(i, j int) bool { return sections[i].Name < sections[j].Name })
	body := manifestIndexDigestBody{
		Schema:   ProvingKeyIndexSchema,
		FileSize: idx.FileSize,
		Sections: sections,
	}
	digest, err := digestCanonicalJSON(body)
	if err != nil {
		return ManifestProvingKeyIndex{}, err
	}
	return ManifestProvingKeyIndex{
		Schema:     ProvingKeyIndexSchema,
		FileSize:   idx.FileSize,
		SHA256:     digest.SHA256,
		Blake2b256: digest.Blake2b256,
		Sections:   sections,
	}, nil
}

func ValidateChunkManifest(m *ChunkManifest, expected ChunkManifestExpectations) error {
	if m == nil {
		return errors.New("chunk manifest is required")
	}
	if m.Schema != ChunkManifestSchema {
		return fmt.Errorf("chunk manifest schema %q, want %q", m.Schema, ChunkManifestSchema)
	}
	if _, err := time.Parse(time.RFC3339, m.GeneratedAt); err != nil {
		return fmt.Errorf("generated_at must be RFC3339: %w", err)
	}
	if strings.TrimSpace(m.SignatureKeyID) == "" {
		return errors.New("signature_key_id is required")
	}
	if err := validateTransport(m.Transport); err != nil {
		return err
	}
	if err := validateChunks(m.ProvingKey, m.Coherence.ProvingKeySize); err != nil {
		return err
	}
	if err := validateManifestIndex(m.ProvingKeyIndex, m.Coherence.ProvingKeySize); err != nil {
		return err
	}
	for name, pin := range m.Assets {
		if err := validateAssetPin(name, pin); err != nil {
			return err
		}
	}
	if expected.KeyManifest != nil {
		if err := validateAgainstKeyManifest(m, expected.KeyManifest); err != nil {
			return err
		}
	}
	if expected.KeyManifestDigest.Size != 0 || expected.KeyManifestDigest.SHA256 != "" || expected.KeyManifestDigest.Blake2b256 != "" {
		if m.Coherence.KeyManifestSHA256 != expected.KeyManifestDigest.SHA256 {
			return fmt.Errorf("key manifest sha256 mismatch: manifest %s, expected %s", m.Coherence.KeyManifestSHA256, expected.KeyManifestDigest.SHA256)
		}
		if m.Coherence.KeyManifestBlake2b256 != expected.KeyManifestDigest.Blake2b256 {
			return fmt.Errorf("key manifest blake2b256 mismatch: manifest %s, expected %s", m.Coherence.KeyManifestBlake2b256, expected.KeyManifestDigest.Blake2b256)
		}
	}
	if expected.Deployment != nil {
		if m.Coherence.DeploymentID != expected.Deployment.DeploymentID {
			return fmt.Errorf("deployment id mismatch: manifest %q, expected %q", m.Coherence.DeploymentID, expected.Deployment.DeploymentID)
		}
		if m.Coherence.DeploymentSourceCommit != expected.Deployment.SourceCommit {
			return fmt.Errorf("deployment source commit mismatch: manifest %q, expected %q", m.Coherence.DeploymentSourceCommit, expected.Deployment.SourceCommit)
		}
	}
	if expected.CardanoVKFormat != "" && m.Coherence.CardanoVKFormat != expected.CardanoVKFormat {
		return fmt.Errorf("cardano vk format mismatch: manifest %q, expected %q", m.Coherence.CardanoVKFormat, expected.CardanoVKFormat)
	}
	if expected.CardanoVKBlake2b256 != "" && m.Coherence.CardanoVKBlake2b256 != expected.CardanoVKBlake2b256 {
		return fmt.Errorf("cardano vk blake2b256 mismatch: manifest %s, expected %s", m.Coherence.CardanoVKBlake2b256, expected.CardanoVKBlake2b256)
	}
	return nil
}

func VerifyChunkFiles(m *ChunkManifest, baseDir string) error {
	if err := ValidateChunkManifest(m, ChunkManifestExpectations{}); err != nil {
		return err
	}
	for _, chunk := range m.ProvingKey.Chunks {
		digest, err := DigestFile(filepath.Join(baseDir, chunk.Path))
		if err != nil {
			return err
		}
		if digest.Size != chunk.Size {
			return fmt.Errorf("chunk %d size mismatch: manifest %d, file %d", chunk.Index, chunk.Size, digest.Size)
		}
		if digest.SHA256 != chunk.SHA256 {
			return fmt.Errorf("chunk %d sha256 mismatch: manifest %s, file %s", chunk.Index, chunk.SHA256, digest.SHA256)
		}
		if digest.Blake2b256 != chunk.Blake2b256 {
			return fmt.Errorf("chunk %d blake2b256 mismatch: manifest %s, file %s", chunk.Index, chunk.Blake2b256, digest.Blake2b256)
		}
	}
	return nil
}

func ReadChunkManifest(path string) (*ChunkManifest, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read chunk manifest %s: %w", path, err)
	}
	var m ChunkManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("parse chunk manifest %s: %w", path, err)
	}
	return &m, nil
}

func WriteChunkManifest(path string, m *ChunkManifest) error {
	if err := ValidateChunkManifest(m, ChunkManifestExpectations{}); err != nil {
		return err
	}
	raw, err := MarshalChunkManifest(m)
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return fmt.Errorf("write chunk manifest %s: %w", path, err)
	}
	return nil
}

func MarshalChunkManifest(m *ChunkManifest) ([]byte, error) {
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshal chunk manifest: %w", err)
	}
	return append(raw, '\n'), nil
}

func ReadReclaimDeployment(path string) (*ReclaimDeploymentManifest, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read deployment manifest %s: %w", path, err)
	}
	var m ReclaimDeploymentManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("parse deployment manifest %s: %w", path, err)
	}
	if m.Schema != ReclaimDeploymentSchema {
		return nil, fmt.Errorf("deployment manifest schema %q, want %q", m.Schema, ReclaimDeploymentSchema)
	}
	return &m, nil
}

func ValidateReclaimDeployment(deployment *ReclaimDeploymentManifest, manifest *artifact.KeyManifest, cardanoVKBlake2b256 string) error {
	if deployment == nil {
		return errors.New("deployment manifest is required")
	}
	if manifest == nil {
		return errors.New("key manifest is required")
	}
	if deployment.Schema != ReclaimDeploymentSchema {
		return fmt.Errorf("deployment manifest schema %q, want %q", deployment.Schema, ReclaimDeploymentSchema)
	}
	if strings.TrimSpace(deployment.DeploymentID) == "" {
		return errors.New("deployment_id is required")
	}
	if deployment.Proof.VKHash != manifest.VKHash {
		return fmt.Errorf("deployment proof.vk_hash %q, want %q", deployment.Proof.VKHash, manifest.VKHash)
	}
	if deployment.ReclaimGlobal.VerifierVKHash != manifest.VKHash {
		return fmt.Errorf("deployment reclaim_global.verifier_vk_hash %q, want %q", deployment.ReclaimGlobal.VerifierVKHash, manifest.VKHash)
	}
	if deployment.Proof.CircuitID != manifest.CircuitID {
		return fmt.Errorf("deployment proof.circuit_id %q, want %q", deployment.Proof.CircuitID, manifest.CircuitID)
	}
	if deployment.Proof.KeyVersion != manifest.KeyVersion {
		return fmt.Errorf("deployment proof.key_version %q, want %q", deployment.Proof.KeyVersion, manifest.KeyVersion)
	}
	if cardanoVKBlake2b256 != "" && deployment.Proof.CardanoVKBlake2b256 != cardanoVKBlake2b256 {
		return fmt.Errorf("deployment proof.cardano_vk_blake2b256 %q, want %q", deployment.Proof.CardanoVKBlake2b256, cardanoVKBlake2b256)
	}
	const statementBoundV2 = "full-proof-plus-public-input-digest-v2"
	const sameAsPreviousV1 = "bytes-empty-same-as-previous-v1"
	switch deployment.ReclaimGlobal.ProofSlotEncoding {
	case "":
		if deployment.ReclaimGlobal.BatchTranscriptVKHash != "" {
			return errors.New("deployment reclaim_global.batch_transcript_vk_hash requires proof_slot_encoding")
		}
	case statementBoundV2:
		if deployment.ReclaimGlobal.BatchTranscriptVKHash == "" {
			return errors.New("deployment statement-bound V2 requires reclaim_global.batch_transcript_vk_hash")
		}
		if deployment.ReclaimGlobal.BatchTranscriptVKHash != deployment.Proof.CardanoVKBlake2b256 {
			return fmt.Errorf("deployment reclaim_global.batch_transcript_vk_hash %q, want %q", deployment.ReclaimGlobal.BatchTranscriptVKHash, deployment.Proof.CardanoVKBlake2b256)
		}
	case sameAsPreviousV1:
		if deployment.ReclaimGlobal.BatchTranscriptVKHash != "" {
			return errors.New("deployment V1 proof-slot encoding must not set batch_transcript_vk_hash")
		}
	default:
		return fmt.Errorf("deployment reclaim_global.proof_slot_encoding %q is unsupported", deployment.ReclaimGlobal.ProofSlotEncoding)
	}
	return nil
}

func SignDetached(raw []byte, privateKey ed25519.PrivateKey) string {
	return hex.EncodeToString(ed25519.Sign(privateKey, raw))
}

func VerifyDetachedSignature(raw []byte, signatureHex string, publicKeyHex string) error {
	signature, err := hex.DecodeString(strings.TrimSpace(signatureHex))
	if err != nil {
		return fmt.Errorf("decode signature hex: %w", err)
	}
	if len(signature) != ed25519.SignatureSize {
		return fmt.Errorf("signature is %d bytes, want %d", len(signature), ed25519.SignatureSize)
	}
	publicKey, err := DecodeEd25519PublicKeyHex(publicKeyHex)
	if err != nil {
		return err
	}
	if !ed25519.Verify(publicKey, raw, signature) {
		return errors.New("signature verification failed")
	}
	return nil
}

func DecodeEd25519PublicKeyHex(value string) (ed25519.PublicKey, error) {
	raw, err := hex.DecodeString(strings.TrimSpace(value))
	if err != nil {
		return nil, fmt.Errorf("decode public key hex: %w", err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("public key is %d bytes, want %d", len(raw), ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(raw), nil
}

func checkKeyManifestPK(manifest *artifact.KeyManifest, digest FileDigest) error {
	if manifest.ProvingKeySHA256 == "" || manifest.ProvingKeyBlake2b256 == "" || manifest.ProvingKeySize <= 0 {
		return errors.New("key manifest must include proving key sha256, blake2b256, and size")
	}
	if manifest.ProvingKeySHA256 != digest.SHA256 {
		return fmt.Errorf("proving key sha256 mismatch: manifest %s, file %s", manifest.ProvingKeySHA256, digest.SHA256)
	}
	if manifest.ProvingKeyBlake2b256 != digest.Blake2b256 {
		return fmt.Errorf("proving key blake2b256 mismatch: manifest %s, file %s", manifest.ProvingKeyBlake2b256, digest.Blake2b256)
	}
	if manifest.ProvingKeySize != digest.Size {
		return fmt.Errorf("proving key size mismatch: manifest %d, file %d", manifest.ProvingKeySize, digest.Size)
	}
	return nil
}

func validateAgainstKeyManifest(m *ChunkManifest, manifest *artifact.KeyManifest) error {
	c := m.Coherence
	checks := []struct {
		name string
		got  string
		want string
	}{
		{"key_version", c.KeyVersion, manifest.KeyVersion},
		{"circuit_id", c.CircuitID, manifest.CircuitID},
		{"vk_hash", c.VKHash, manifest.VKHash},
		{"proving_key_sha256", c.ProvingKeySHA256, manifest.ProvingKeySHA256},
		{"proving_key_blake2b256", c.ProvingKeyBlake2b256, manifest.ProvingKeyBlake2b256},
		{"verifying_key_sha256", c.VerifyingKeySHA256, manifest.VerifyingKeySHA256},
		{"constraint_system_hash", c.ConstraintSystemHash, manifest.ConstraintSystemHash},
	}
	for _, check := range checks {
		if check.want != "" && check.got != check.want {
			return fmt.Errorf("%s mismatch: manifest %q, expected %q", check.name, check.got, check.want)
		}
	}
	if manifest.ProvingKeySize > 0 && c.ProvingKeySize != manifest.ProvingKeySize {
		return fmt.Errorf("proving_key_size mismatch: manifest %d, expected %d", c.ProvingKeySize, manifest.ProvingKeySize)
	}
	if manifest.VerifyingKeySize > 0 && c.VerifyingKeySize != manifest.VerifyingKeySize {
		return fmt.Errorf("verifying_key_size mismatch: manifest %d, expected %d", c.VerifyingKeySize, manifest.VerifyingKeySize)
	}
	return nil
}

func validateTransport(t ChunkTransport) error {
	if t.ContentEncoding != "identity" {
		return fmt.Errorf("transport content_encoding %q, want identity", t.ContentEncoding)
	}
	if t.BaseURL != "" {
		u, err := url.Parse(t.BaseURL)
		if err != nil || u.Scheme == "" || u.Host == "" {
			return fmt.Errorf("transport base_url must be an absolute URL")
		}
		if t.RequiresHTTPS && u.Scheme != "https" && u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" {
			return fmt.Errorf("transport base_url must use https outside loopback")
		}
	}
	return nil
}

func validateChunks(pk ChunkedProvingKey, provingKeySize int64) error {
	if err := safeRelativePath(pk.Path); err != nil {
		return fmt.Errorf("proving key path: %w", err)
	}
	if pk.ChunkSize <= 0 {
		return errors.New("proving key chunk_size must be positive")
	}
	if len(pk.Chunks) == 0 {
		return errors.New("proving key chunks are required")
	}
	var next int64
	for i, chunk := range pk.Chunks {
		if chunk.Index != i {
			return fmt.Errorf("chunk %d index is %d", i, chunk.Index)
		}
		if chunk.Offset != next {
			return fmt.Errorf("chunk %d offset %d, want %d", i, chunk.Offset, next)
		}
		if chunk.Size <= 0 {
			return fmt.Errorf("chunk %d size must be positive", i)
		}
		if i < len(pk.Chunks)-1 && chunk.Size != pk.ChunkSize {
			return fmt.Errorf("chunk %d size %d, want chunk_size %d", i, chunk.Size, pk.ChunkSize)
		}
		if err := safeRelativePath(chunk.Path); err != nil {
			return fmt.Errorf("chunk %d path: %w", i, err)
		}
		if err := validateDigest("sha256", chunk.SHA256); err != nil {
			return fmt.Errorf("chunk %d sha256: %w", i, err)
		}
		if err := validateDigest("blake2b256", chunk.Blake2b256); err != nil {
			return fmt.Errorf("chunk %d blake2b256: %w", i, err)
		}
		next += chunk.Size
	}
	if next != provingKeySize {
		return fmt.Errorf("chunk table ends at %d, proving key size is %d", next, provingKeySize)
	}
	root, err := chunksRootBlake2b256(pk.Chunks)
	if err != nil {
		return err
	}
	if root != pk.ChunksRootBlake2b256 {
		return fmt.Errorf("chunks_root_blake2b256 mismatch: manifest %s, computed %s", pk.ChunksRootBlake2b256, root)
	}
	return nil
}

func validateManifestIndex(idx ManifestProvingKeyIndex, provingKeySize int64) error {
	if idx.Schema != ProvingKeyIndexSchema {
		return fmt.Errorf("proving key index schema %q, want %q", idx.Schema, ProvingKeyIndexSchema)
	}
	if idx.FileSize != provingKeySize {
		return fmt.Errorf("proving key index file_size %d, proving key size %d", idx.FileSize, provingKeySize)
	}
	sections := map[string]PKSection{}
	for _, sec := range idx.Sections {
		sections[sec.Name] = PKSection(sec)
	}
	if err := ValidatePKIndex(&PKIndex{Sections: sections, FileSize: idx.FileSize}); err != nil {
		return err
	}
	body := manifestIndexDigestBody{Schema: idx.Schema, FileSize: idx.FileSize, Sections: idx.Sections}
	digest, err := digestCanonicalJSON(body)
	if err != nil {
		return err
	}
	if digest.SHA256 != idx.SHA256 {
		return fmt.Errorf("proving key index sha256 mismatch: manifest %s, computed %s", idx.SHA256, digest.SHA256)
	}
	if digest.Blake2b256 != idx.Blake2b256 {
		return fmt.Errorf("proving key index blake2b256 mismatch: manifest %s, computed %s", idx.Blake2b256, digest.Blake2b256)
	}
	return nil
}

func validateAssetPin(name string, pin AssetPin) error {
	if err := safeRelativePath(pin.Path); err != nil {
		return fmt.Errorf("asset %s path: %w", name, err)
	}
	if pin.Size <= 0 {
		return fmt.Errorf("asset %s size must be positive", name)
	}
	if err := validateDigest("sha256", pin.SHA256); err != nil {
		return fmt.Errorf("asset %s sha256: %w", name, err)
	}
	if err := validateDigest("blake2b256", pin.Blake2b256); err != nil {
		return fmt.Errorf("asset %s blake2b256: %w", name, err)
	}
	return nil
}

func safeRelativePath(value string) error {
	if value == "" {
		return errors.New("path is required")
	}
	if filepath.IsAbs(value) || strings.Contains(value, "\\") || strings.Contains(value, "://") || strings.ContainsAny(value, "?#") {
		return fmt.Errorf("%q is not a safe relative path", value)
	}
	clean := path.Clean(value)
	if clean == "." || clean != value || strings.HasPrefix(clean, "../") || strings.Contains(clean, "/../") {
		return fmt.Errorf("%q is not a safe relative path", value)
	}
	return nil
}

func validateDigest(prefix, value string) error {
	raw, err := decodePrefixedDigest(prefix, value)
	if err != nil {
		return err
	}
	if len(raw) != 32 {
		return fmt.Errorf("digest is %d bytes, want 32", len(raw))
	}
	return nil
}

func decodePrefixedDigest(prefix, value string) ([]byte, error) {
	wantPrefix := prefix + ":"
	if !strings.HasPrefix(value, wantPrefix) {
		return nil, fmt.Errorf("digest %q missing %q prefix", value, wantPrefix)
	}
	raw, err := hex.DecodeString(strings.TrimPrefix(value, wantPrefix))
	if err != nil {
		return nil, err
	}
	return raw, nil
}

func chunksRootBlake2b256(chunks []ChunkPin) (string, error) {
	h, err := blake2b.New256(nil)
	if err != nil {
		return "", fmt.Errorf("create blake2b digest: %w", err)
	}
	for _, chunk := range chunks {
		raw, err := decodePrefixedDigest("blake2b256", chunk.Blake2b256)
		if err != nil {
			return "", fmt.Errorf("chunk %d blake2b256: %w", chunk.Index, err)
		}
		if _, err := h.Write(raw); err != nil {
			return "", err
		}
	}
	return "blake2b256:" + hex.EncodeToString(h.Sum(nil)), nil
}

type manifestIndexDigestBody struct {
	Schema   string              `json:"schema"`
	FileSize int64               `json:"file_size"`
	Sections []ManifestPKSection `json:"sections"`
}

func digestCanonicalJSON(value any) (FileDigest, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return FileDigest{}, fmt.Errorf("marshal digest body: %w", err)
	}
	return DigestBytes(raw)
}
