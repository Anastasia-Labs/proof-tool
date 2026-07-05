package artifact

import (
	"encoding/json"
	"fmt"
	"os"
)

const (
	ManifestSchema = "proof-tool-key-manifest-v1"
	ProofSchema    = "root-ownership-proof-artifact-v1"
)

type KeyManifest struct {
	Schema               string            `json:"schema"`
	KeyVersion           string            `json:"key_version,omitempty"`
	CircuitID            string            `json:"circuit_id"`
	Curve                string            `json:"curve"`
	Backend              string            `json:"backend"`
	VKHash               string            `json:"vk_hash"`
	ProvingKeySHA256     string            `json:"proving_key_sha256,omitempty"`
	ProvingKeyBlake2b256 string            `json:"proving_key_blake2b256,omitempty"`
	ProvingKeySize       int64             `json:"proving_key_size,omitempty"`
	VerifyingKeySHA256   string            `json:"verifying_key_sha256,omitempty"`
	VerifyingKeySize     int64             `json:"verifying_key_size,omitempty"`
	ConstraintSystemHash string            `json:"constraint_system_hash,omitempty"`
	CircuitSourceCommit  string            `json:"circuit_source_commit,omitempty"`
	ProofToolVersion     string            `json:"proof_tool_version,omitempty"`
	GnarkVersion         string            `json:"gnark_version,omitempty"`
	SetupTranscriptHash  string            `json:"setup_transcript_hash,omitempty"`
	PublishedAt          string            `json:"published_at,omitempty"`
	ArtifactURLs         map[string]string `json:"artifact_urls,omitempty"`
	SignatureKeyID       string            `json:"signature_key_id,omitempty"`
}

type PathMetadata struct {
	Account uint32 `json:"account"`
	Role    uint32 `json:"role"`
	Index   uint32 `json:"index"`
}

type ProofArtifact struct {
	Schema                     string         `json:"schema"`
	CircuitID                  string         `json:"circuit_id"`
	VKHash                     string         `json:"vk_hash"`
	TargetCredential           string         `json:"target_credential,omitempty"`
	TargetCredentials          []string       `json:"target_credentials,omitempty"`
	DestinationAddressEncoding string         `json:"destination_address_encoding,omitempty"`
	DestinationAddress         string         `json:"destination_address,omitempty"`
	CredentialCount            int            `json:"credential_count,omitempty"`
	PublicInputEncoding        string         `json:"public_input_encoding,omitempty"`
	PublicInput                string         `json:"public_input"`
	Proof                      string         `json:"proof"`
	Cardano                    *CardanoProof  `json:"cardano,omitempty"`
	Path                       *PathMetadata  `json:"path,omitempty"`
	Paths                      []PathMetadata `json:"paths,omitempty"`
}

type CardanoProof struct {
	Format               string `json:"format"`
	ProofHex             string `json:"proof_hex"`
	PublicInputDigestHex string `json:"public_input_digest_hex"`
}

func BackendProofArtifact(value ProofArtifact) ProofArtifact {
	value.Path = nil
	value.Paths = nil
	return value
}

func WriteJSON(path string, value any) error {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal %s: %w", path, err)
	}
	b = append(b, '\n')
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

func ReadKeyManifest(path string) (*KeyManifest, error) {
	var m KeyManifest
	if err := readJSON(path, &m); err != nil {
		return nil, err
	}
	if m.Schema != ManifestSchema {
		return nil, fmt.Errorf("manifest schema %q, want %q", m.Schema, ManifestSchema)
	}
	return &m, nil
}

func ReadProof(path string) (*ProofArtifact, error) {
	var p ProofArtifact
	if err := readJSON(path, &p); err != nil {
		return nil, err
	}
	if p.Schema != ProofSchema {
		return nil, fmt.Errorf("proof schema %q, want %q", p.Schema, ProofSchema)
	}
	return &p, nil
}

func readJSON(path string, value any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if err := json.Unmarshal(b, value); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	return nil
}
