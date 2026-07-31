package mpcceremony

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/blake2b"
)

const (
	DefinitionSchema              = "proof-tool-mpc-ceremony-definition-v1"
	DetachedSignatureSchema       = "proof-tool-mpc-detached-signature-v1"
	ContributionAttestationSchema = "proof-tool-mpc-contribution-attestation-v1"
	ErasureAttestationSchema      = "proof-tool-mpc-erasure-attestation-v1"
	ChainSchema                   = "proof-tool-mpc-accepted-chain-v1"
	ChainRecordSchema             = "proof-tool-mpc-acceptance-record-v1"
	CloseRecordSchema             = "proof-tool-mpc-close-record-v1"
	BeaconRecordSchema            = "proof-tool-mpc-beacon-record-v1"
	SealRecordSchema              = "proof-tool-mpc-seal-record-v1"
	AuditRecordSchema             = "proof-tool-mpc-audit-record-v1"
	FinalTranscriptSchema         = "proof-tool-mpc-final-transcript-v1"

	KeyVersionDestinationV2 = "ownership-destination-v2"
	CircuitIDDestinationV2  = "root-ownership-destination-v2/bls12-381/groth16"
	CurveBLS12381           = "BLS12-381"
	BackendGroth16          = "groth16"
	GnarkVersion            = "v0.15.0"
	GnarkCryptoVersion      = "v0.20.1"
	DrandVersion            = "v2.1.6"
	ProductionGoVersion     = "go1.26.5"
	ProductionGOOS          = "linux"
	ProductionGOARCH        = "amd64"
	ProductionGOAMD64       = "v1"
	ProductionCompiler      = "gc"
	ProductionBuildMode     = "exe"
	SignatureAlgorithm      = "Ed25519"
	BeaconExtractionV1      = "sha256-domain-separated-length-prefixed-v1"
	BeaconProviderDrand     = "drand"
	BeaconNetworkQuicknet   = "quicknet-mainnet"
	BeaconQuicknetChainHash = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"
	BeaconQuicknetPublicKey = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a"
	BeaconQuicknetScheme    = "bls-unchained-g1-rfc9380"
	BeaconQuicknetGenesis   = int64(1692803367)
	BeaconQuicknetPeriod    = uint32(3)
	ModeRehearsal           = "rehearsal"
	ModeProduction          = "production"

	MaxParticipants = 20
)

type Phase string

const (
	Phase1 Phase = "phase1"
	Phase2 Phase = "phase2"
)

func (p Phase) Validate() error {
	switch p {
	case Phase1, Phase2:
		return nil
	default:
		return fmt.Errorf("unsupported phase %q", p)
	}
}

// Digest binds both hashes used by the existing proof artifact pipeline.
type Digest struct {
	SHA256     string `json:"sha256"`
	Blake2b256 string `json:"blake2b256"`
	Size       int64  `json:"size"`
}

func NewDigest(data []byte) Digest {
	sha := sha256.Sum256(data)
	blake := blake2b.Sum256(data)
	return Digest{
		SHA256:     "sha256:" + hex.EncodeToString(sha[:]),
		Blake2b256: "blake2b256:" + hex.EncodeToString(blake[:]),
		Size:       int64(len(data)),
	}
}

func (d Digest) Validate() error {
	if err := validateTaggedHex(d.SHA256, "sha256:", sha256.Size); err != nil {
		return fmt.Errorf("sha256: %w", err)
	}
	if err := validateTaggedHex(d.Blake2b256, "blake2b256:", blake2b.Size256); err != nil {
		return fmt.Errorf("blake2b256: %w", err)
	}
	if d.Size <= 0 {
		return fmt.Errorf("size must be positive, got %d", d.Size)
	}
	return nil
}

type ArtifactRef struct {
	Name   string `json:"name"`
	Digest Digest `json:"digest"`
}

func (r ArtifactRef) Validate() error {
	if err := validateArtifactName(r.Name); err != nil {
		return err
	}
	if err := r.Digest.Validate(); err != nil {
		return fmt.Errorf("artifact %q digest: %w", r.Name, err)
	}
	return nil
}

type Identity struct {
	ID                   string `json:"id"`
	DisplayName          string `json:"display_name"`
	KeyID                string `json:"key_id"`
	Ed25519PublicKeyHex  string `json:"ed25519_public_key_hex"`
	PublicKeyFingerprint string `json:"public_key_fingerprint"`
}

func (i Identity) Validate() error {
	if err := validateID("identity id", i.ID); err != nil {
		return err
	}
	if strings.TrimSpace(i.DisplayName) == "" || i.DisplayName != strings.TrimSpace(i.DisplayName) {
		return errors.New("identity display_name must be non-empty and trimmed")
	}
	if !utf8.ValidString(i.DisplayName) {
		return errors.New("identity display_name must be valid UTF-8")
	}
	if err := validateID("identity key_id", i.KeyID); err != nil {
		return err
	}
	pub, err := decodeFixedHex(i.Ed25519PublicKeyHex, 32)
	if err != nil {
		return fmt.Errorf("identity ed25519_public_key_hex: %w", err)
	}
	want := taggedSHA256(pub)
	if i.PublicKeyFingerprint != want {
		return fmt.Errorf("identity public_key_fingerprint %q, want %q", i.PublicKeyFingerprint, want)
	}
	return nil
}

func NewIdentity(id, displayName, keyID string, publicKey []byte) (Identity, error) {
	result := Identity{
		ID:                   id,
		DisplayName:          displayName,
		KeyID:                keyID,
		Ed25519PublicKeyHex:  hex.EncodeToString(publicKey),
		PublicKeyFingerprint: taggedSHA256(publicKey),
	}
	return result, result.Validate()
}

type Participant struct {
	Identity Identity `json:"identity"`
}

func (p Participant) Validate() error {
	return p.Identity.Validate()
}

type PhasePolicy struct {
	Participants []string `json:"participants"`
	Minimum      uint8    `json:"minimum"`
}

func (p PhasePolicy) Validate(roster map[string]Participant) error {
	if len(p.Participants) == 0 {
		return errors.New("phase participants must not be empty")
	}
	if len(p.Participants) > MaxParticipants {
		return fmt.Errorf("phase participants exceed maximum %d", MaxParticipants)
	}
	if p.Minimum == 0 || int(p.Minimum) > len(p.Participants) {
		return fmt.Errorf("phase minimum %d must be between 1 and %d", p.Minimum, len(p.Participants))
	}
	seen := make(map[string]struct{}, len(p.Participants))
	for index, participantID := range p.Participants {
		if _, ok := roster[participantID]; !ok {
			return fmt.Errorf("phase participant %d %q is not in the roster", index, participantID)
		}
		if _, duplicate := seen[participantID]; duplicate {
			return fmt.Errorf("phase participant %q is duplicated", participantID)
		}
		seen[participantID] = struct{}{}
	}
	return nil
}

type CircuitBinding struct {
	KeyVersion        string      `json:"key_version"`
	CircuitID         string      `json:"circuit_id"`
	Curve             string      `json:"curve"`
	Backend           string      `json:"backend"`
	R1CS              ArtifactRef `json:"r1cs"`
	Constraints       uint64      `json:"constraints"`
	InternalVariables uint64      `json:"internal_variables"`
	SecretVariables   uint64      `json:"secret_variables"`
	PublicVariables   uint64      `json:"public_variables"`
	DomainSize        uint64      `json:"domain_size"`
	Phase2Shape       Phase2Shape `json:"phase2_shape"`
}

func (b CircuitBinding) Validate() error {
	if b.KeyVersion != KeyVersionDestinationV2 {
		return fmt.Errorf("key_version %q, want %q", b.KeyVersion, KeyVersionDestinationV2)
	}
	if b.CircuitID != CircuitIDDestinationV2 {
		return fmt.Errorf("circuit_id %q, want %q", b.CircuitID, CircuitIDDestinationV2)
	}
	if b.Curve != CurveBLS12381 {
		return fmt.Errorf("curve %q, want %q", b.Curve, CurveBLS12381)
	}
	if b.Backend != BackendGroth16 {
		return fmt.Errorf("backend %q, want %q", b.Backend, BackendGroth16)
	}
	if err := b.R1CS.Validate(); err != nil {
		return fmt.Errorf("r1cs: %w", err)
	}
	if b.Constraints == 0 || b.InternalVariables == 0 || b.SecretVariables == 0 || b.PublicVariables == 0 {
		return errors.New("circuit counts must all be positive")
	}
	if !isPowerOfTwo(b.DomainSize) || b.DomainSize < b.Constraints {
		return fmt.Errorf("domain_size %d must be a power of two covering %d constraints", b.DomainSize, b.Constraints)
	}
	if err := b.Phase2Shape.Validate(); err != nil {
		return fmt.Errorf("phase2_shape: %w", err)
	}
	if b.Phase2Shape.ChallengeLength != 0 {
		return fmt.Errorf("phase2_shape challenge_length %d, want 0 for deterministic genesis", b.Phase2Shape.ChallengeLength)
	}
	return nil
}

type SoftwareBinding struct {
	ProofToolVersion   string `json:"proof_tool_version"`
	GnarkVersion       string `json:"gnark_version"`
	GnarkCryptoVersion string `json:"gnark_crypto_version"`
	DrandVersion       string `json:"drand_version"`
	GoVersion          string `json:"go_version"`
	GoOS               string `json:"goos"`
	GoArch             string `json:"goarch"`
	GoAMD64            string `json:"goamd64,omitempty"`
	Compiler           string `json:"compiler"`
	BuildMode          string `json:"build_mode"`
	CGOEnabled         bool   `json:"cgo_enabled"`
	TrimPath           bool   `json:"trimpath"`
	SourceCommit       string `json:"source_commit"`
	SourceDirty        bool   `json:"source_dirty"`
	ToolBinary         Digest `json:"tool_binary"`
}

func (b SoftwareBinding) Validate() error {
	if strings.TrimSpace(b.ProofToolVersion) == "" {
		return errors.New("proof_tool_version is required")
	}
	if b.GnarkVersion != GnarkVersion {
		return fmt.Errorf("gnark_version %q, want %q", b.GnarkVersion, GnarkVersion)
	}
	if b.GnarkCryptoVersion != GnarkCryptoVersion {
		return fmt.Errorf("gnark_crypto_version %q, want %q", b.GnarkCryptoVersion, GnarkCryptoVersion)
	}
	if b.DrandVersion != DrandVersion {
		return fmt.Errorf("drand_version %q, want %q", b.DrandVersion, DrandVersion)
	}
	if strings.TrimSpace(b.GoVersion) == "" {
		return errors.New("go_version is required")
	}
	if strings.TrimSpace(b.GoOS) == "" {
		return errors.New("goos is required")
	}
	if strings.TrimSpace(b.GoArch) == "" {
		return errors.New("goarch is required")
	}
	if b.GoArch == ProductionGOARCH && strings.TrimSpace(b.GoAMD64) == "" {
		return errors.New("goamd64 is required for amd64 binaries")
	}
	if strings.TrimSpace(b.Compiler) == "" {
		return errors.New("compiler is required")
	}
	if strings.TrimSpace(b.BuildMode) == "" {
		return errors.New("build_mode is required")
	}
	if err := validateHex(b.SourceCommit, 20); err != nil {
		return fmt.Errorf("source_commit: %w", err)
	}
	if err := b.ToolBinary.Validate(); err != nil {
		return fmt.Errorf("tool_binary: %w", err)
	}
	return nil
}

type BeaconPolicy struct {
	Provider                  string `json:"provider"`
	Network                   string `json:"network"`
	ChainHashHex              string `json:"chain_hash_hex"`
	PublicKeyHex              string `json:"public_key_hex"`
	Scheme                    string `json:"scheme"`
	GenesisTimeUnix           int64  `json:"genesis_time_unix"`
	PeriodSeconds             uint32 `json:"period_seconds"`
	Extraction                string `json:"extraction"`
	MinimumChallengeBytes     uint16 `json:"minimum_challenge_bytes"`
	MinimumWitnessLeadSeconds uint32 `json:"minimum_witness_lead_seconds"`
	FutureRoundRequired       bool   `json:"future_round_required"`
}

func (p BeaconPolicy) Validate() error {
	if p.Provider != BeaconProviderDrand {
		return fmt.Errorf("beacon provider %q, want %q", p.Provider, BeaconProviderDrand)
	}
	if p.Network != BeaconNetworkQuicknet {
		return fmt.Errorf("beacon network %q, want %q", p.Network, BeaconNetworkQuicknet)
	}
	if p.ChainHashHex != BeaconQuicknetChainHash {
		return errors.New("beacon chain_hash_hex does not match pinned drand quicknet mainnet")
	}
	if p.PublicKeyHex != BeaconQuicknetPublicKey {
		return errors.New("beacon public_key_hex does not match pinned drand quicknet mainnet")
	}
	if err := validateHex(p.PublicKeyHex, 96); err != nil {
		return fmt.Errorf("beacon public_key_hex: %w", err)
	}
	if p.Scheme != BeaconQuicknetScheme {
		return fmt.Errorf("beacon scheme %q, want %q", p.Scheme, BeaconQuicknetScheme)
	}
	if p.GenesisTimeUnix != BeaconQuicknetGenesis {
		return fmt.Errorf("beacon genesis_time_unix %d, want %d", p.GenesisTimeUnix, BeaconQuicknetGenesis)
	}
	if p.PeriodSeconds != BeaconQuicknetPeriod {
		return fmt.Errorf("beacon period_seconds %d, want %d", p.PeriodSeconds, BeaconQuicknetPeriod)
	}
	if p.Extraction != BeaconExtractionV1 {
		return fmt.Errorf("beacon extraction %q, want %q", p.Extraction, BeaconExtractionV1)
	}
	if p.MinimumChallengeBytes != sha256.Size {
		return fmt.Errorf("beacon minimum_challenge_bytes must be exactly %d", sha256.Size)
	}
	if p.MinimumWitnessLeadSeconds == 0 {
		return errors.New("beacon minimum_witness_lead_seconds must be positive")
	}
	if !p.FutureRoundRequired {
		return errors.New("beacon future_round_required must be true")
	}
	return nil
}

type validatable interface {
	Validate() error
}

// MarshalCanonical is the sole encoding accepted for signed records. Struct field
// order is part of the schema; callers must not pass maps.
func MarshalCanonical(value any) ([]byte, error) {
	if value == nil {
		return nil, errors.New("cannot marshal nil canonical value")
	}
	if _, isMap := value.(map[string]any); isMap {
		return nil, errors.New("canonical records must use fixed-field structs, not maps")
	}
	v, ok := value.(validatable)
	if !ok {
		return nil, errors.New("canonical records must implement Validate")
	}
	if err := v.Validate(); err != nil {
		return nil, err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("marshal canonical JSON: %w", err)
	}
	return data, nil
}

// UnmarshalCanonical rejects duplicate and unknown fields, trailing input, and
// every byte encoding other than MarshalCanonical's exact output.
func UnmarshalCanonical(data []byte, destination any) error {
	if destination == nil {
		return errors.New("canonical JSON destination is nil")
	}
	if err := rejectDuplicateKeysAndTrailing(data); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("decode canonical JSON: %w", err)
	}
	if token, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return fmt.Errorf("unexpected trailing JSON token %v", token)
		}
		return fmt.Errorf("read canonical JSON trailer: %w", err)
	}
	v, ok := destination.(validatable)
	if !ok {
		return errors.New("canonical JSON destination does not implement Validate")
	}
	if err := v.Validate(); err != nil {
		return err
	}
	canonical, err := json.Marshal(destination)
	if err != nil {
		return fmt.Errorf("remarshal canonical JSON: %w", err)
	}
	if !bytes.Equal(data, canonical) {
		return errors.New("JSON is valid but is not in canonical encoding")
	}
	return nil
}

func canonicalHash(domain string, value any) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	hash.Write([]byte(domain))
	hash.Write([]byte{0})
	hash.Write(data)
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), nil
}

func rejectDuplicateKeysAndTrailing(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := scanJSONValue(decoder); err != nil {
		return err
	}
	if token, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return fmt.Errorf("unexpected trailing JSON token %v", token)
		}
		return fmt.Errorf("invalid trailing JSON: %w", err)
	}
	return nil
}

func scanJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	delim, isDelim := token.(json.Delim)
	if !isDelim {
		return nil
	}
	switch delim {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return fmt.Errorf("invalid JSON object key: %w", err)
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is not a string")
			}
			if _, duplicate := seen[key]; duplicate {
				return fmt.Errorf("duplicate JSON object key %q", key)
			}
			seen[key] = struct{}{}
			if err := scanJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("invalid JSON object end: %w", err)
		}
		if end != json.Delim('}') {
			return errors.New("invalid JSON object delimiter")
		}
	case '[':
		for decoder.More() {
			if err := scanJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("invalid JSON array end: %w", err)
		}
		if end != json.Delim(']') {
			return errors.New("invalid JSON array delimiter")
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter %q", delim)
	}
	return nil
}

func validateTaggedHex(value, prefix string, bytes int) error {
	if !strings.HasPrefix(value, prefix) {
		return fmt.Errorf("must start with %q", prefix)
	}
	return validateHex(strings.TrimPrefix(value, prefix), bytes)
}

func validateHex(value string, bytes int) error {
	if len(value) != bytes*2 {
		return fmt.Errorf("must contain %d lowercase hexadecimal bytes", bytes)
	}
	if value != strings.ToLower(value) {
		return errors.New("must use lowercase hexadecimal")
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != bytes {
		return fmt.Errorf("invalid hexadecimal value")
	}
	return nil
}

func decodeFixedHex(value string, bytes int) ([]byte, error) {
	if err := validateHex(value, bytes); err != nil {
		return nil, err
	}
	return hex.DecodeString(value)
}

func validateID(label, value string) error {
	if value == "" || len(value) > 128 {
		return fmt.Errorf("%s must contain 1 to 128 characters", label)
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' && r != '_' && r != '.' && r != ':' {
			return fmt.Errorf("%s %q contains an unsupported character", label, value)
		}
	}
	return nil
}

func validateArtifactName(value string) error {
	if value == "" || len(value) > 512 || !utf8.ValidString(value) {
		return errors.New("artifact name must be non-empty valid UTF-8 of at most 512 bytes")
	}
	if strings.Contains(value, "\\") || strings.HasPrefix(value, "/") || path.Clean(value) != value || value == "." {
		return fmt.Errorf("artifact name %q must be a clean relative logical path", value)
	}
	return nil
}

func validateTimestamp(label, value string) error {
	if value == "" || !strings.HasSuffix(value, "Z") {
		return fmt.Errorf("%s must be a UTC RFC3339 timestamp ending in Z", label)
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return fmt.Errorf("%s: %w", label, err)
	}
	if parsed.Format(time.RFC3339Nano) != value {
		return fmt.Errorf("%s is not a canonical RFC3339 timestamp", label)
	}
	return nil
}

func taggedSHA256(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func isPowerOfTwo(value uint64) bool {
	return value != 0 && value&(value-1) == 0
}
