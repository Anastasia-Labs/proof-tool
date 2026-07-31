package mpcceremony

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

type DetachedSignature struct {
	Schema               string `json:"schema"`
	Algorithm            string `json:"algorithm"`
	KeyID                string `json:"key_id"`
	PublicKeyFingerprint string `json:"public_key_fingerprint"`
	SignedSHA256         string `json:"signed_sha256"`
	SignatureHex         string `json:"signature_hex"`
}

func (s DetachedSignature) Validate() error {
	if s.Schema != DetachedSignatureSchema {
		return fmt.Errorf("signature schema %q, want %q", s.Schema, DetachedSignatureSchema)
	}
	if s.Algorithm != SignatureAlgorithm {
		return fmt.Errorf("signature algorithm %q, want %q", s.Algorithm, SignatureAlgorithm)
	}
	if err := validateID("signature key_id", s.KeyID); err != nil {
		return err
	}
	if err := validateTaggedHex(s.PublicKeyFingerprint, "sha256:", sha256.Size); err != nil {
		return fmt.Errorf("signature public_key_fingerprint: %w", err)
	}
	if err := validateTaggedHex(s.SignedSHA256, "sha256:", sha256.Size); err != nil {
		return fmt.Errorf("signature signed_sha256: %w", err)
	}
	if err := validateHex(s.SignatureHex, ed25519.SignatureSize); err != nil {
		return fmt.Errorf("signature_hex: %w", err)
	}
	return nil
}

// SignExact signs bytes exactly as supplied. Use SignRecord for typed records;
// SignExact exists for already-canonical artifacts such as a persisted manifest.
func SignExact(data []byte, keyID string, privateKey ed25519.PrivateKey) (DetachedSignature, error) {
	if len(data) == 0 {
		return DetachedSignature{}, errors.New("cannot sign empty data")
	}
	if err := validateID("signature key_id", keyID); err != nil {
		return DetachedSignature{}, err
	}
	if len(privateKey) != ed25519.PrivateKeySize {
		return DetachedSignature{}, fmt.Errorf("Ed25519 private key is %d bytes, want %d", len(privateKey), ed25519.PrivateKeySize)
	}
	publicKey, ok := privateKey.Public().(ed25519.PublicKey)
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return DetachedSignature{}, errors.New("derive Ed25519 public key")
	}
	signature := DetachedSignature{
		Schema:               DetachedSignatureSchema,
		Algorithm:            SignatureAlgorithm,
		KeyID:                keyID,
		PublicKeyFingerprint: taggedSHA256(publicKey),
		SignedSHA256:         taggedSHA256(data),
		SignatureHex:         hex.EncodeToString(ed25519.Sign(privateKey, data)),
	}
	return signature, signature.Validate()
}

func VerifyExact(data []byte, signature DetachedSignature, expectedKeyID string, publicKey ed25519.PublicKey) error {
	if err := signature.Validate(); err != nil {
		return err
	}
	if len(data) == 0 {
		return errors.New("signed data is empty")
	}
	if len(publicKey) != ed25519.PublicKeySize {
		return fmt.Errorf("Ed25519 public key is %d bytes, want %d", len(publicKey), ed25519.PublicKeySize)
	}
	if signature.KeyID != expectedKeyID {
		return fmt.Errorf("signature key_id %q, want %q", signature.KeyID, expectedKeyID)
	}
	if signature.PublicKeyFingerprint != taggedSHA256(publicKey) {
		return errors.New("signature public-key fingerprint mismatch")
	}
	if signature.SignedSHA256 != taggedSHA256(data) {
		return errors.New("signature signed-data digest mismatch")
	}
	rawSignature, err := hex.DecodeString(signature.SignatureHex)
	if err != nil {
		return fmt.Errorf("decode signature: %w", err)
	}
	if !ed25519.Verify(publicKey, data, rawSignature) {
		return errors.New("Ed25519 signature verification failed")
	}
	return nil
}

// SignRecord returns separately persisted canonical record and detached
// signature bytes.
func SignRecord(record any, keyID string, privateKey ed25519.PrivateKey) ([]byte, []byte, error) {
	recordBytes, err := MarshalCanonical(record)
	if err != nil {
		return nil, nil, err
	}
	signature, err := SignExact(recordBytes, keyID, privateKey)
	if err != nil {
		return nil, nil, err
	}
	signatureBytes, err := MarshalCanonical(signature)
	if err != nil {
		return nil, nil, err
	}
	return recordBytes, signatureBytes, nil
}

// VerifySignedRecord authenticates exact bytes before strict parsing. The
// public key is supplied out of band; the signature never supplies trust.
func VerifySignedRecord(recordBytes, signatureBytes []byte, destination any, expectedKeyID string, publicKey ed25519.PublicKey) error {
	var signature DetachedSignature
	if err := UnmarshalCanonical(signatureBytes, &signature); err != nil {
		return fmt.Errorf("signature: %w", err)
	}
	if err := VerifyExact(recordBytes, signature, expectedKeyID, publicKey); err != nil {
		return err
	}
	if err := UnmarshalCanonical(recordBytes, destination); err != nil {
		return fmt.Errorf("signed record: %w", err)
	}
	return nil
}

type ContributionEnvironment struct {
	OS                           string `json:"os"`
	Architecture                 string `json:"architecture"`
	EntropySource                string `json:"entropy_source"`
	SwapDisabled                 bool   `json:"swap_disabled"`
	CrashDumpsDisabled           bool   `json:"crash_dumps_disabled"`
	TelemetryDisabled            bool   `json:"telemetry_disabled"`
	EphemeralEnvironment         bool   `json:"ephemeral_environment"`
	EphemeralDestructionRequired bool   `json:"ephemeral_destruction_required"`
}

func (e ContributionEnvironment) Validate() error {
	if e.OS == "" || e.Architecture == "" {
		return errors.New("contribution environment OS and architecture are required")
	}
	if e.EntropySource != "operating-system-csprng" {
		return fmt.Errorf("entropy_source %q, want operating-system-csprng", e.EntropySource)
	}
	if !e.SwapDisabled || !e.CrashDumpsDisabled || !e.TelemetryDisabled ||
		!e.EphemeralEnvironment || !e.EphemeralDestructionRequired {
		return errors.New("all production contribution environment controls and the post-contribution destruction plan must be attested")
	}
	return nil
}

type ErasureAttestation struct {
	Schema                    string      `json:"schema"`
	ErasureID                 string      `json:"erasure_id"`
	CeremonyID                string      `json:"ceremony_id"`
	Phase                     Phase       `json:"phase"`
	PhaseID                   string      `json:"phase_id"`
	Index                     uint8       `json:"index"`
	ParticipantID             string      `json:"participant_id"`
	ParticipantKeyID          string      `json:"participant_key_id"`
	ContributionAttestationID string      `json:"contribution_attestation_id"`
	OutputPayload             ArtifactRef `json:"output_payload"`
	DestroyedAt               string      `json:"destroyed_at"`
	ProcessTerminated         bool        `json:"process_terminated"`
	EphemeralStorageDestroyed bool        `json:"ephemeral_storage_destroyed"`
	NoBackupRetained          bool        `json:"no_backup_retained"`
}

func NewErasureAttestation(attestation ErasureAttestation) (ErasureAttestation, error) {
	attestation.Schema = ErasureAttestationSchema
	attestation.ErasureID = ""
	id, err := ComputeErasureAttestationID(attestation)
	if err != nil {
		return ErasureAttestation{}, err
	}
	attestation.ErasureID = id
	if err := attestation.Validate(); err != nil {
		return ErasureAttestation{}, err
	}
	return attestation, nil
}

func ComputeErasureAttestationID(attestation ErasureAttestation) (string, error) {
	attestation.ErasureID = ""
	if err := attestation.validate(false); err != nil {
		return "", err
	}
	return canonicalHash("proof-tool/mpc-ceremony/erasure-attestation/v1", attestation)
}

func (a ErasureAttestation) Validate() error {
	if err := a.validate(true); err != nil {
		return err
	}
	expected, err := ComputeErasureAttestationID(a)
	if err != nil {
		return err
	}
	if a.ErasureID != expected {
		return fmt.Errorf("erasure_id %q, want %q", a.ErasureID, expected)
	}
	return nil
}

func (a ErasureAttestation) validate(requireID bool) error {
	if a.Schema != ErasureAttestationSchema {
		return fmt.Errorf("erasure schema %q, want %q", a.Schema, ErasureAttestationSchema)
	}
	if requireID {
		if err := validateTaggedHex(a.ErasureID, "sha256:", sha256.Size); err != nil {
			return fmt.Errorf("erasure_id: %w", err)
		}
	} else if a.ErasureID != "" {
		return errors.New("erasure_id must be empty while computing identity")
	}
	if err := validateTaggedHex(a.CeremonyID, "sha256:", sha256.Size); err != nil {
		return fmt.Errorf("ceremony_id: %w", err)
	}
	if err := a.Phase.Validate(); err != nil {
		return err
	}
	if err := validateTaggedHex(a.PhaseID, "sha256:", sha256.Size); err != nil {
		return fmt.Errorf("phase_id: %w", err)
	}
	if a.Index == 0 || a.Index > MaxParticipants {
		return fmt.Errorf("erasure index %d must be between 1 and %d", a.Index, MaxParticipants)
	}
	if err := validateID("participant_id", a.ParticipantID); err != nil {
		return err
	}
	if err := validateID("participant_key_id", a.ParticipantKeyID); err != nil {
		return err
	}
	if err := validateTaggedHex(a.ContributionAttestationID, "sha256:", sha256.Size); err != nil {
		return fmt.Errorf("contribution_attestation_id: %w", err)
	}
	if err := a.OutputPayload.Validate(); err != nil {
		return fmt.Errorf("output_payload: %w", err)
	}
	if err := validateTimestamp("destroyed_at", a.DestroyedAt); err != nil {
		return err
	}
	if !a.ProcessTerminated || !a.EphemeralStorageDestroyed || !a.NoBackupRetained {
		return errors.New("erasure attestation requires process termination, ephemeral storage destruction, and no retained backup")
	}
	return nil
}

// ValidateErasureForContribution binds a completed erasure statement to the
// exact contribution and enforces that destruction occurred afterward.
func ValidateErasureForContribution(contribution ContributionAttestation, erasure ErasureAttestation) error {
	if err := contribution.Validate(); err != nil {
		return fmt.Errorf("contribution: %w", err)
	}
	if err := erasure.Validate(); err != nil {
		return fmt.Errorf("erasure: %w", err)
	}
	if erasure.CeremonyID != contribution.CeremonyID ||
		erasure.Phase != contribution.Phase ||
		erasure.PhaseID != contribution.PhaseID ||
		erasure.Index != contribution.Index ||
		erasure.ParticipantID != contribution.ParticipantID ||
		erasure.ParticipantKeyID != contribution.ParticipantKeyID ||
		erasure.ContributionAttestationID != contribution.AttestationID ||
		erasure.OutputPayload != contribution.OutputPayload {
		return errors.New("erasure attestation does not exactly bind contribution")
	}
	contributedAt, _ := time.Parse(time.RFC3339Nano, contribution.ContributedAt)
	destroyedAt, _ := time.Parse(time.RFC3339Nano, erasure.DestroyedAt)
	if !destroyedAt.After(contributedAt) {
		return errors.New("destroyed_at must be strictly after contributed_at")
	}
	return nil
}

type ContributionAttestation struct {
	Schema               string                  `json:"schema"`
	AttestationID        string                  `json:"attestation_id"`
	CeremonyID           string                  `json:"ceremony_id"`
	Phase                Phase                   `json:"phase"`
	PhaseID              string                  `json:"phase_id"`
	Index                uint8                   `json:"index"`
	ParticipantID        string                  `json:"participant_id"`
	ParticipantKeyID     string                  `json:"participant_key_id"`
	PreviousPayload      ArtifactRef             `json:"previous_payload"`
	OutputPayload        ArtifactRef             `json:"output_payload"`
	PreviousAcceptanceID string                  `json:"previous_acceptance_id"`
	ToolBinary           Digest                  `json:"tool_binary"`
	SourceCommit         string                  `json:"source_commit"`
	GnarkVersion         string                  `json:"gnark_version"`
	GnarkCryptoVersion   string                  `json:"gnark_crypto_version"`
	DrandVersion         string                  `json:"drand_version"`
	Environment          ContributionEnvironment `json:"environment"`
	ContributedAt        string                  `json:"contributed_at"`
}

func NewContributionAttestation(attestation ContributionAttestation) (ContributionAttestation, error) {
	attestation.Schema = ContributionAttestationSchema
	attestation.AttestationID = ""
	id, err := ComputeContributionAttestationID(attestation)
	if err != nil {
		return ContributionAttestation{}, err
	}
	attestation.AttestationID = id
	if err := attestation.Validate(); err != nil {
		return ContributionAttestation{}, err
	}
	return attestation, nil
}

func ComputeContributionAttestationID(attestation ContributionAttestation) (string, error) {
	attestation.AttestationID = ""
	if err := attestation.validate(false); err != nil {
		return "", err
	}
	return canonicalHash("proof-tool/mpc-ceremony/contribution-attestation/v1", attestation)
}

func (a ContributionAttestation) Validate() error {
	if err := a.validate(true); err != nil {
		return err
	}
	expected, err := ComputeContributionAttestationID(a)
	if err != nil {
		return err
	}
	if a.AttestationID != expected {
		return fmt.Errorf("attestation_id %q, want %q", a.AttestationID, expected)
	}
	return nil
}

func (a ContributionAttestation) validate(requireID bool) error {
	if a.Schema != ContributionAttestationSchema {
		return fmt.Errorf("attestation schema %q, want %q", a.Schema, ContributionAttestationSchema)
	}
	if requireID {
		if err := validateTaggedHex(a.AttestationID, "sha256:", sha256.Size); err != nil {
			return fmt.Errorf("attestation_id: %w", err)
		}
	} else if a.AttestationID != "" {
		return errors.New("attestation_id must be empty while computing identity")
	}
	if err := validateTaggedHex(a.CeremonyID, "sha256:", sha256.Size); err != nil {
		return fmt.Errorf("ceremony_id: %w", err)
	}
	if err := a.Phase.Validate(); err != nil {
		return err
	}
	if err := validateTaggedHex(a.PhaseID, "sha256:", sha256.Size); err != nil {
		return fmt.Errorf("phase_id: %w", err)
	}
	if a.Index == 0 || a.Index > MaxParticipants {
		return fmt.Errorf("contribution index %d must be between 1 and %d", a.Index, MaxParticipants)
	}
	if err := validateID("participant_id", a.ParticipantID); err != nil {
		return err
	}
	if err := validateID("participant_key_id", a.ParticipantKeyID); err != nil {
		return err
	}
	if err := a.PreviousPayload.Validate(); err != nil {
		return fmt.Errorf("previous_payload: %w", err)
	}
	if err := a.OutputPayload.Validate(); err != nil {
		return fmt.Errorf("output_payload: %w", err)
	}
	if a.PreviousPayload.Digest.SHA256 == a.OutputPayload.Digest.SHA256 {
		return errors.New("contribution output must differ from previous payload")
	}
	if err := validateTaggedHex(a.PreviousAcceptanceID, "sha256:", sha256.Size); err != nil {
		return fmt.Errorf("previous_acceptance_id: %w", err)
	}
	if err := a.ToolBinary.Validate(); err != nil {
		return fmt.Errorf("tool_binary: %w", err)
	}
	if err := validateHex(a.SourceCommit, 20); err != nil {
		return fmt.Errorf("source_commit: %w", err)
	}
	if a.GnarkVersion != GnarkVersion {
		return fmt.Errorf("gnark_version %q, want %q", a.GnarkVersion, GnarkVersion)
	}
	if a.GnarkCryptoVersion != GnarkCryptoVersion {
		return fmt.Errorf("gnark_crypto_version %q, want %q", a.GnarkCryptoVersion, GnarkCryptoVersion)
	}
	if a.DrandVersion != DrandVersion {
		return fmt.Errorf("drand_version %q, want %q", a.DrandVersion, DrandVersion)
	}
	if err := a.Environment.Validate(); err != nil {
		return fmt.Errorf("environment: %w", err)
	}
	return validateTimestamp("contributed_at", a.ContributedAt)
}
