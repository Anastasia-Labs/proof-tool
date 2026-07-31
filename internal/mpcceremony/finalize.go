package mpcceremony

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark/backend/groth16"
	groth16bls12381 "github.com/consensys/gnark/backend/groth16/bls12-381"
	gnarkmpc "github.com/consensys/gnark/backend/groth16/bls12-381/mpcsetup"
	"github.com/consensys/gnark/backend/witness"
	"golang.org/x/crypto/blake2b"

	"proof-tool/internal/keybundle"
	"proof-tool/internal/prover"
)

const (
	CandidateMetadataSchema    = "proof-tool-mpc-release-candidate-v2"
	VerificationReportSchema   = "proof-tool-mpc-verification-report-v2"
	PublicEvidenceSchema       = "proof-tool-mpc-public-finalization-evidence-v1"
	CandidateMetadataFile      = "candidate.json"
	CandidateSignatureFile     = "candidate.sig.json"
	VerificationReportFile     = "verification-report.json"
	PublicEvidenceFile         = "public-finalization-evidence.json"
	PreliminaryMetadataSchema  = "proof-tool-mpc-preliminary-final-keys-v1"
	PreliminaryMetadataFile    = "preliminary-final-keys.json"
	PreliminarySignatureFile   = "preliminary-final-keys.sig.json"
	PreliminaryChecksumsFile   = "preliminary-checksums.sha256"
	CardanoVKBytesFile         = "cardano-vk.bin"
	CardanoVKHexFile           = "cardano-vk.hex"
	CardanoVKFormatFile        = "cardano-vk-format.txt"
	CandidateChecksumsFile     = "candidate-checksums.sha256"
	Phase2SealFile             = "phase2-seal.json"
	Phase2SealSignatureFile    = "phase2-seal.sig.json"
	FinalTranscriptFile        = "setup-transcript.json"
	ReleaseChecksumsFile       = "checksums.sha256"
	NativeProvingKeyFile       = "ownership.pk"
	NativeVerifyingKeyFile     = "ownership.vk"
	PublicCredentialBytes      = 28
	PublicDestinationBytes     = 58
	DestinationPublicDomain    = "ROOT-OWNERSHIP-DESTINATION-v1"
	GoldenPublicCredentialHex  = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4"
	GoldenPublicDestinationHex = "010038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da111" +
		"0000000000000000000000000000000000000000000000000000000000"
	expectedCardanoBSB22  = "groth16-bls12-381-bsb22"
	PublicEvidenceFixture = "repository-golden-destination-v2"
)

// ReplayPaths names every immutable input required to independently replay
// both phases. Contribution paths must be in accepted-chain order. No
// "latest" lookup or directory scan is performed by the engine.
type ReplayPaths struct {
	TranscriptRoot            string
	CoordinatorPublicKeyHex   string
	DefinitionPath            string
	DefinitionSignaturePath   string
	Phase1ChainPath           string
	Phase1ChainSignaturePath  string
	Phase1ClosePath           string
	Phase1CloseSignaturePath  string
	Phase1BeaconPath          string
	Phase1BeaconSignaturePath string
	Phase1SealPath            string
	Phase1SealSignaturePath   string
	Phase2ChainPath           string
	Phase2ChainSignaturePath  string
	Phase2ClosePath           string
	Phase2CloseSignaturePath  string
	Phase2BeaconPath          string
	Phase2BeaconSignaturePath string
}

type FinalizeOptions struct {
	Replay                ReplayPaths
	Circuit               *CompiledCircuit
	OutDir                string
	CoordinatorSigningKey string
	PublicEvidencePath    string
	FinalizedAt           time.Time
}

type PrepareFinalizationOptions struct {
	Replay                ReplayPaths
	Circuit               *CompiledCircuit
	OutDir                string
	CoordinatorSigningKey string
	PreparedAt            time.Time
}

type PreliminaryFinalKeys struct {
	Schema              string         `json:"schema"`
	CeremonyID          string         `json:"ceremony_id"`
	Definition          ArtifactRef    `json:"definition"`
	Circuit             CircuitBinding `json:"circuit"`
	Phase1Chain         ArtifactRef    `json:"phase1_chain"`
	Phase2Chain         ArtifactRef    `json:"phase2_chain"`
	ConstraintSystem    ArtifactRef    `json:"constraint_system"`
	ProvingKey          ArtifactRef    `json:"proving_key"`
	VerifyingKey        ArtifactRef    `json:"verifying_key"`
	CardanoVerifyingKey ArtifactRef    `json:"cardano_verifying_key"`
	CardanoVKHex        ArtifactRef    `json:"cardano_vk_hex"`
	CardanoVKFormat     ArtifactRef    `json:"cardano_vk_format"`
	CoordinatorID       string         `json:"coordinator_id"`
	CoordinatorKeyID    string         `json:"coordinator_key_id"`
	PreparedAt          string         `json:"prepared_at"`
}

func (p PreliminaryFinalKeys) Validate() error {
	if p.Schema != PreliminaryMetadataSchema {
		return fmt.Errorf("preliminary metadata schema %q, want %q", p.Schema, PreliminaryMetadataSchema)
	}
	if err := validateHashID("ceremony_id", p.CeremonyID); err != nil {
		return err
	}
	for label, ref := range map[string]ArtifactRef{
		"definition":            p.Definition,
		"phase1_chain":          p.Phase1Chain,
		"phase2_chain":          p.Phase2Chain,
		"constraint_system":     p.ConstraintSystem,
		"proving_key":           p.ProvingKey,
		"verifying_key":         p.VerifyingKey,
		"cardano_verifying_key": p.CardanoVerifyingKey,
		"cardano_vk_hex":        p.CardanoVKHex,
		"cardano_vk_format":     p.CardanoVKFormat,
	} {
		if err := ref.Validate(); err != nil {
			return fmt.Errorf("%s: %w", label, err)
		}
	}
	if err := p.Circuit.Validate(); err != nil {
		return err
	}
	if err := validateID("coordinator_id", p.CoordinatorID); err != nil {
		return err
	}
	if err := validateID("coordinator_key_id", p.CoordinatorKeyID); err != nil {
		return err
	}
	return validateTimestamp("prepared_at", p.PreparedAt)
}

type PrepareFinalizationResult struct {
	OutDir           string
	MetadataPath     string
	SignaturePath    string
	ProvingKeyPath   string
	VerifyingKeyPath string
	CardanoVKPath    string
	ChecksumsPath    string
}

type FinalizeResult struct {
	CeremonyID        string
	OutDir            string
	Candidate         CandidateMetadata
	CandidatePath     string
	CandidateSigPath  string
	VerificationPath  string
	ProvingKeyPath    string
	VerifyingKeyPath  string
	ConstraintSystem  string
	CardanoVKPath     string
	CandidateChecksum string
}

type VerificationReport struct {
	Schema                   string      `json:"schema"`
	CeremonyID               string      `json:"ceremony_id"`
	Fixture                  string      `json:"fixture"`
	NativeProofVerified      bool        `json:"native_proof_verified"`
	WrongCredentialRejected  bool        `json:"wrong_credential_rejected"`
	WrongDestinationRejected bool        `json:"wrong_destination_rejected"`
	WrongDigestRejected      bool        `json:"wrong_digest_rejected"`
	WrongProofRejected       bool        `json:"wrong_proof_rejected"`
	WrongVKRejected          bool        `json:"wrong_vk_rejected"`
	ProofTruncationRejected  bool        `json:"proof_truncation_rejected"`
	ProofAppendRejected      bool        `json:"proof_append_rejected"`
	CardanoProofFormat       string      `json:"cardano_proof_format"`
	CardanoProofBytes        int         `json:"cardano_proof_bytes"`
	CardanoProofRawDigest    Digest      `json:"cardano_proof_raw_digest"`
	CardanoVKFormat          string      `json:"cardano_vk_format"`
	CardanoVKBytes           int         `json:"cardano_vk_bytes"`
	CardanoVKRawDigest       Digest      `json:"cardano_vk_raw_digest"`
	PublicEvidence           ArtifactRef `json:"public_evidence"`
	CheckedAt                string      `json:"checked_at"`
}

type publicEvidenceVerification struct {
	NativeProofVerified      bool
	WrongCredentialRejected  bool
	WrongDestinationRejected bool
	WrongDigestRejected      bool
	WrongProofRejected       bool
	WrongVKRejected          bool
	ProofTruncationRejected  bool
	ProofAppendRejected      bool
}

func (r VerificationReport) Validate() error {
	if r.Schema != VerificationReportSchema {
		return fmt.Errorf("verification report schema %q, want %q", r.Schema, VerificationReportSchema)
	}
	if err := validateHashID("ceremony_id", r.CeremonyID); err != nil {
		return err
	}
	if r.Fixture != PublicEvidenceFixture {
		return fmt.Errorf("verification fixture %q, want %q", r.Fixture, PublicEvidenceFixture)
	}
	if !r.NativeProofVerified ||
		!r.WrongCredentialRejected ||
		!r.WrongDestinationRejected ||
		!r.WrongDigestRejected ||
		!r.WrongProofRejected ||
		!r.WrongVKRejected ||
		!r.ProofTruncationRejected ||
		!r.ProofAppendRejected {
		return errors.New("verification report requires positive and negative proof evidence")
	}
	if r.CardanoProofFormat != expectedCardanoBSB22 ||
		r.CardanoProofBytes != prover.CardanoProofCommitmentLen {
		return errors.New("verification report has unexpected Cardano proof encoding")
	}
	if err := r.CardanoProofRawDigest.Validate(); err != nil {
		return fmt.Errorf("cardano_proof_raw_digest: %w", err)
	}
	if r.CardanoProofRawDigest.Size != int64(r.CardanoProofBytes) {
		return errors.New("verification report Cardano proof digest size differs from proof byte count")
	}
	if r.CardanoVKFormat != expectedCardanoBSB22 ||
		r.CardanoVKBytes != prover.CardanoVKCommitmentLen {
		return errors.New("verification report has unexpected Cardano verifying-key encoding")
	}
	if err := r.CardanoVKRawDigest.Validate(); err != nil {
		return fmt.Errorf("cardano_vk_raw_digest: %w", err)
	}
	if r.CardanoVKRawDigest.Size != int64(r.CardanoVKBytes) {
		return errors.New("verification report Cardano verifying-key digest size differs from key byte count")
	}
	if err := r.PublicEvidence.Validate(); err != nil {
		return fmt.Errorf("public_evidence: %w", err)
	}
	if r.PublicEvidence.Name != PublicEvidenceFile {
		return fmt.Errorf("public evidence artifact is %q, want %q", r.PublicEvidence.Name, PublicEvidenceFile)
	}
	return validateTimestamp("checked_at", r.CheckedAt)
}

// PublicFinalizationEvidence is safe to publish. It contains only the public
// statement and the Cardano wire proof produced by the finalized keys. It
// deliberately excludes the master XPrv, seed, derivation path, and any wallet
// material.
type PublicFinalizationEvidence struct {
	Schema                string      `json:"schema"`
	CeremonyID            string      `json:"ceremony_id"`
	Fixture               string      `json:"fixture"`
	CredentialHex         string      `json:"credential_hex"`
	DestinationHex        string      `json:"destination_hex"`
	PublicInputDigestHex  string      `json:"public_input_digest_hex"`
	CardanoProofHex       string      `json:"cardano_proof_hex"`
	CardanoProofFormat    string      `json:"cardano_proof_format"`
	CardanoProofRawDigest Digest      `json:"cardano_proof_raw_digest"`
	CardanoVerifyingKey   ArtifactRef `json:"cardano_verifying_key"`
}

func (e PublicFinalizationEvidence) Validate() error {
	if e.Schema != PublicEvidenceSchema {
		return fmt.Errorf("public evidence schema %q, want %q", e.Schema, PublicEvidenceSchema)
	}
	if err := validateHashID("ceremony_id", e.CeremonyID); err != nil {
		return err
	}
	if e.Fixture != PublicEvidenceFixture {
		return fmt.Errorf("public evidence fixture %q, want %q", e.Fixture, PublicEvidenceFixture)
	}
	if e.CredentialHex != GoldenPublicCredentialHex ||
		e.DestinationHex != GoldenPublicDestinationHex {
		return errors.New("public evidence does not use the exact repository golden public vector")
	}
	if err := validateHex(e.CredentialHex, PublicCredentialBytes); err != nil {
		return fmt.Errorf("credential_hex: %w", err)
	}
	if err := validateHex(e.DestinationHex, PublicDestinationBytes); err != nil {
		return fmt.Errorf("destination_hex: %w", err)
	}
	if err := validateHex(e.PublicInputDigestHex, blake2b.Size256); err != nil {
		return fmt.Errorf("public_input_digest_hex: %w", err)
	}
	if err := validateHex(e.CardanoProofHex, prover.CardanoProofCommitmentLen); err != nil {
		return fmt.Errorf("cardano_proof_hex: %w", err)
	}
	if e.CardanoProofFormat != expectedCardanoBSB22 {
		return fmt.Errorf("cardano proof format %q, want %q", e.CardanoProofFormat, expectedCardanoBSB22)
	}
	if err := e.CardanoProofRawDigest.Validate(); err != nil {
		return fmt.Errorf("cardano_proof_raw_digest: %w", err)
	}
	if e.CardanoProofRawDigest.Size != prover.CardanoProofCommitmentLen {
		return errors.New("public evidence proof digest size differs from exact Cardano proof length")
	}
	proof, _ := hex.DecodeString(e.CardanoProofHex)
	if NewDigest(proof) != e.CardanoProofRawDigest {
		return errors.New("public evidence proof digest differs from proof_hex")
	}
	if err := e.CardanoVerifyingKey.Validate(); err != nil {
		return fmt.Errorf("cardano_verifying_key: %w", err)
	}
	if e.CardanoVerifyingKey.Name != CardanoVKBytesFile {
		return fmt.Errorf("cardano verifying-key artifact is %q, want %q", e.CardanoVerifyingKey.Name, CardanoVKBytesFile)
	}
	credential, _ := hex.DecodeString(e.CredentialHex)
	destination, _ := hex.DecodeString(e.DestinationHex)
	digest := publicInputDigest(credential, destination)
	if hex.EncodeToString(digest) != e.PublicInputDigestHex {
		return errors.New("public input digest does not bind the public credential and destination")
	}
	return nil
}

// CandidateMetadata binds replay inputs to unsigned release artifacts. It is
// coordinator-signed, but deliberately is not a release manifest. Independent
// auditors must reproduce it before the distinct release signer may act.
type CandidateMetadata struct {
	Schema              string         `json:"schema"`
	CandidateID         string         `json:"candidate_id"`
	CeremonyID          string         `json:"ceremony_id"`
	Definition          ArtifactRef    `json:"definition"`
	Circuit             CircuitBinding `json:"circuit"`
	Phase1              PhaseSummary   `json:"phase1"`
	Phase2              PhaseSummary   `json:"phase2"`
	ConstraintSystem    ArtifactRef    `json:"constraint_system"`
	ProvingKey          ArtifactRef    `json:"proving_key"`
	VerifyingKey        ArtifactRef    `json:"verifying_key"`
	CardanoVerifyingKey ArtifactRef    `json:"cardano_verifying_key"`
	CardanoVKHex        ArtifactRef    `json:"cardano_vk_hex"`
	CardanoVKFormat     ArtifactRef    `json:"cardano_vk_format"`
	VerificationReport  ArtifactRef    `json:"verification_report"`
	PublicEvidence      ArtifactRef    `json:"public_finalization_evidence"`
	Phase2SealRecord    ArtifactRef    `json:"phase2_seal_record"`
	CoordinatorID       string         `json:"coordinator_id"`
	CoordinatorKeyID    string         `json:"coordinator_key_id"`
	FinalizedAt         string         `json:"finalized_at"`
}

func NewCandidateMetadata(candidate CandidateMetadata) (CandidateMetadata, error) {
	candidate.Schema = CandidateMetadataSchema
	candidate.CandidateID = ""
	id, err := computeCandidateID(candidate)
	if err != nil {
		return CandidateMetadata{}, err
	}
	candidate.CandidateID = id
	return candidate, candidate.Validate()
}

func (c CandidateMetadata) Validate() error {
	if c.Schema != CandidateMetadataSchema {
		return fmt.Errorf("candidate schema %q, want %q", c.Schema, CandidateMetadataSchema)
	}
	if err := validateHashID("candidate_id", c.CandidateID); err != nil {
		return err
	}
	expected, err := computeCandidateID(c)
	if err != nil {
		return err
	}
	if c.CandidateID != expected {
		return fmt.Errorf("candidate_id %q, want %q", c.CandidateID, expected)
	}
	if err := validateHashID("ceremony_id", c.CeremonyID); err != nil {
		return err
	}
	if err := c.Definition.Validate(); err != nil {
		return fmt.Errorf("definition: %w", err)
	}
	if err := c.Circuit.Validate(); err != nil {
		return fmt.Errorf("circuit: %w", err)
	}
	if err := c.Phase1.Validate(); err != nil || c.Phase1.Phase != Phase1 {
		return fmt.Errorf("phase1: invalid summary: %w", err)
	}
	if err := c.Phase2.Validate(); err != nil || c.Phase2.Phase != Phase2 {
		return fmt.Errorf("phase2: invalid summary: %w", err)
	}
	for label, ref := range map[string]ArtifactRef{
		"constraint_system":     c.ConstraintSystem,
		"proving_key":           c.ProvingKey,
		"verifying_key":         c.VerifyingKey,
		"cardano_verifying_key": c.CardanoVerifyingKey,
		"cardano_vk_hex":        c.CardanoVKHex,
		"cardano_vk_format":     c.CardanoVKFormat,
		"verification_report":   c.VerificationReport,
		"public_evidence":       c.PublicEvidence,
		"phase2_seal_record":    c.Phase2SealRecord,
	} {
		if err := ref.Validate(); err != nil {
			return fmt.Errorf("%s: %w", label, err)
		}
	}
	if err := validateID("coordinator_id", c.CoordinatorID); err != nil {
		return err
	}
	if err := validateID("coordinator_key_id", c.CoordinatorKeyID); err != nil {
		return err
	}
	return validateTimestamp("finalized_at", c.FinalizedAt)
}

func computeCandidateID(candidate CandidateMetadata) (string, error) {
	candidate.CandidateID = ""
	if candidate.Schema != CandidateMetadataSchema {
		return "", fmt.Errorf("candidate schema %q, want %q", candidate.Schema, CandidateMetadataSchema)
	}
	return canonicalHash("proof-tool/mpc-ceremony/release-candidate/v1", candidate)
}

type loadedReplay struct {
	definition     CeremonyDefinition
	definitionRef  ArtifactRef
	phase1Chain    Chain
	phase1ChainRef ArtifactRef
	phase1Close    CloseRecord
	phase1Beacon   BeaconRecord
	phase1Seal     SealRecord
	phase2Chain    Chain
	phase2ChainRef ArtifactRef
	phase2Close    CloseRecord
	phase2Beacon   BeaconRecord
	phase2Seal     SealRecord
}

type replayedKeys struct {
	commons *gnarkmpc.SrsCommons
	pk      groth16.ProvingKey
	vk      groth16.VerifyingKey
}

// PrepareFinalization independently replays the ceremony and publishes only a
// coordinator-signed preliminary key tree. This tree exists solely so a
// separate local proof tool can create public proof evidence. It is not a
// candidate, has no candidate/release manifest, and is rejected by audit and
// release commands.
func PrepareFinalization(options PrepareFinalizationOptions) (*PrepareFinalizationResult, error) {
	if options.Circuit == nil || options.Circuit.R1CS == nil {
		return nil, errors.New("compiled destination-v2 circuit is required")
	}
	if options.PreparedAt.IsZero() || options.PreparedAt.Location() != time.UTC {
		return nil, errors.New("prepared_at must be a non-zero UTC time")
	}
	loaded, err := loadReplay(options.Replay)
	if err != nil {
		return nil, err
	}
	if err := VerifyRunningSoftwareForMode(loaded.definition.Software, loaded.definition.Mode); err != nil {
		return nil, fmt.Errorf("running preliminary finalizer software: %w", err)
	}
	if err := ValidateCircuitBinding(options.Circuit, loaded.definition.Circuit); err != nil {
		return nil, err
	}
	privateKey, publicKey, err := keybundle.LoadExistingPrivateKey(options.CoordinatorSigningKey)
	if err != nil {
		return nil, err
	}
	if err := requireIdentityKey(loaded.definition.Coordinator, publicKey); err != nil {
		return nil, fmt.Errorf("coordinator signing key: %w", err)
	}
	replayed, err := replayAll(options.Circuit, loaded, options.Replay)
	if err != nil {
		return nil, err
	}
	stagingDir, err := createRecoveryStagingDir(options.OutDir)
	if err != nil {
		return nil, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.RemoveAll(stagingDir)
			_ = syncDirectory(filepath.Dir(stagingDir))
		}
	}()

	ccsPath := filepath.Join(stagingDir, prover.DestinationConstraintSystemFile)
	ccsRef, err := writeR1CSNoReplace(ccsPath, options.Circuit)
	if err != nil {
		return nil, err
	}
	pkPath := filepath.Join(stagingDir, NativeProvingKeyFile)
	if err := saveNativeNoReplace(pkPath, func(path string) error { return prover.SavePK(replayed.pk, path) }); err != nil {
		return nil, err
	}
	vkPath := filepath.Join(stagingDir, NativeVerifyingKeyFile)
	if err := saveNativeNoReplace(vkPath, func(path string) error { return prover.SaveVK(replayed.vk, path) }); err != nil {
		return nil, err
	}
	pkRef, err := artifactRefForFile(NativeProvingKeyFile, pkPath)
	if err != nil {
		return nil, err
	}
	vkRef, err := artifactRefForFile(NativeVerifyingKeyFile, vkPath)
	if err != nil {
		return nil, err
	}
	cardanoRaw, cardanoFormat, err := prover.SerializeCardanoVK(replayed.vk)
	if err != nil {
		return nil, err
	}
	if cardanoFormat != expectedCardanoBSB22 || len(cardanoRaw) != prover.CardanoVKCommitmentLen {
		return nil, errors.New("preliminary Cardano verifying key is not exact BSB22 encoding")
	}
	cardanoPath := filepath.Join(stagingDir, CardanoVKBytesFile)
	cardanoHexPath := filepath.Join(stagingDir, CardanoVKHexFile)
	cardanoFormatPath := filepath.Join(stagingDir, CardanoVKFormatFile)
	if err := writeBytesNoReplace(cardanoPath, cardanoRaw, 0o600); err != nil {
		return nil, err
	}
	if err := writeBytesNoReplace(cardanoHexPath, []byte(hex.EncodeToString(cardanoRaw)+"\n"), 0o600); err != nil {
		return nil, err
	}
	if err := writeBytesNoReplace(cardanoFormatPath, []byte(cardanoFormat+"\n"), 0o600); err != nil {
		return nil, err
	}
	cardanoRef, err := artifactRefForFile(CardanoVKBytesFile, cardanoPath)
	if err != nil {
		return nil, err
	}
	cardanoHexRef, err := artifactRefForFile(CardanoVKHexFile, cardanoHexPath)
	if err != nil {
		return nil, err
	}
	cardanoFormatRef, err := artifactRefForFile(CardanoVKFormatFile, cardanoFormatPath)
	if err != nil {
		return nil, err
	}
	metadata := PreliminaryFinalKeys{
		Schema:              PreliminaryMetadataSchema,
		CeremonyID:          loaded.definition.CeremonyID,
		Definition:          loaded.definitionRef,
		Circuit:             loaded.definition.Circuit,
		Phase1Chain:         loaded.phase1ChainRef,
		Phase2Chain:         loaded.phase2ChainRef,
		ConstraintSystem:    ccsRef,
		ProvingKey:          pkRef,
		VerifyingKey:        vkRef,
		CardanoVerifyingKey: cardanoRef,
		CardanoVKHex:        cardanoHexRef,
		CardanoVKFormat:     cardanoFormatRef,
		CoordinatorID:       loaded.definition.Coordinator.ID,
		CoordinatorKeyID:    loaded.definition.Coordinator.KeyID,
		PreparedAt:          options.PreparedAt.Format(time.RFC3339Nano),
	}
	metadataPath := filepath.Join(stagingDir, PreliminaryMetadataFile)
	signaturePath := filepath.Join(stagingDir, PreliminarySignatureFile)
	if err := writeSignedRecordNoReplace(
		metadataPath,
		signaturePath,
		metadata,
		loaded.definition.Coordinator.KeyID,
		privateKey,
	); err != nil {
		return nil, err
	}
	checksumsPath := filepath.Join(stagingDir, PreliminaryChecksumsFile)
	names := []string{
		prover.DestinationConstraintSystemFile,
		NativeProvingKeyFile,
		NativeVerifyingKeyFile,
		CardanoVKBytesFile,
		CardanoVKHexFile,
		CardanoVKFormatFile,
		PreliminaryMetadataFile,
		PreliminarySignatureFile,
	}
	if err := writeChecksumsNoReplace(stagingDir, checksumsPath, names); err != nil {
		return nil, err
	}
	if err := syncDirectory(stagingDir); err != nil {
		return nil, err
	}
	if err := publishReleaseDirectory(stagingDir, options.OutDir); err != nil {
		return nil, err
	}
	cleanup = false
	return &PrepareFinalizationResult{
		OutDir:           options.OutDir,
		MetadataPath:     filepath.Join(options.OutDir, PreliminaryMetadataFile),
		SignaturePath:    filepath.Join(options.OutDir, PreliminarySignatureFile),
		ProvingKeyPath:   filepath.Join(options.OutDir, NativeProvingKeyFile),
		VerifyingKeyPath: filepath.Join(options.OutDir, NativeVerifyingKeyFile),
		CardanoVKPath:    filepath.Join(options.OutDir, CardanoVKBytesFile),
		ChecksumsPath:    filepath.Join(options.OutDir, PreliminaryChecksumsFile),
	}, nil
}

// VerifyPreliminaryFinalKeys authenticates the non-release key tree using the
// caller's out-of-band coordinator trust key and checks every exact artifact.
func VerifyPreliminaryFinalKeys(
	dir string,
	coordinatorPublicKeyHex string,
) (PreliminaryFinalKeys, error) {
	publicKey, err := keybundle.DecodePublicKeyHex(coordinatorPublicKeyHex)
	if err != nil {
		return PreliminaryFinalKeys{}, err
	}
	recordBytes, err := readRegularFile(filepath.Join(dir, PreliminaryMetadataFile))
	if err != nil {
		return PreliminaryFinalKeys{}, err
	}
	signatureBytes, err := readRegularFile(filepath.Join(dir, PreliminarySignatureFile))
	if err != nil {
		return PreliminaryFinalKeys{}, err
	}
	var metadata PreliminaryFinalKeys
	if err := UnmarshalCanonical(recordBytes, &metadata); err != nil {
		return PreliminaryFinalKeys{}, err
	}
	if err := VerifySignedRecord(
		recordBytes,
		signatureBytes,
		&metadata,
		metadata.CoordinatorKeyID,
		publicKey,
	); err != nil {
		return PreliminaryFinalKeys{}, fmt.Errorf("preliminary key signature: %w", err)
	}
	refs := []ArtifactRef{
		metadata.ConstraintSystem,
		metadata.ProvingKey,
		metadata.VerifyingKey,
		metadata.CardanoVerifyingKey,
		metadata.CardanoVKHex,
		metadata.CardanoVKFormat,
	}
	for _, ref := range refs {
		actual, err := artifactRefForFile(ref.Name, filepath.Join(dir, ref.Name))
		if err != nil {
			return PreliminaryFinalKeys{}, err
		}
		if actual != ref {
			return PreliminaryFinalKeys{}, fmt.Errorf("preliminary artifact %q digest mismatch", ref.Name)
		}
	}
	names := []string{
		prover.DestinationConstraintSystemFile,
		NativeProvingKeyFile,
		NativeVerifyingKeyFile,
		CardanoVKBytesFile,
		CardanoVKHexFile,
		CardanoVKFormatFile,
		PreliminaryMetadataFile,
		PreliminarySignatureFile,
	}
	if err := verifyChecksumsExact(
		dir,
		filepath.Join(dir, PreliminaryChecksumsFile),
		names,
	); err != nil {
		return PreliminaryFinalKeys{}, err
	}
	expectedEntries := make(map[string]struct{}, len(names)+1)
	for _, name := range names {
		expectedEntries[name] = struct{}{}
	}
	expectedEntries[PreliminaryChecksumsFile] = struct{}{}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return PreliminaryFinalKeys{}, err
	}
	for _, entry := range entries {
		if _, ok := expectedEntries[entry.Name()]; !ok {
			return PreliminaryFinalKeys{}, fmt.Errorf("unexpected preliminary key-tree entry %q", entry.Name())
		}
		delete(expectedEntries, entry.Name())
		info, err := entry.Info()
		if err != nil {
			return PreliminaryFinalKeys{}, err
		}
		if !info.Mode().IsRegular() {
			return PreliminaryFinalKeys{}, fmt.Errorf("preliminary key-tree entry %q is not a regular file", entry.Name())
		}
	}
	if len(expectedEntries) != 0 {
		return PreliminaryFinalKeys{}, errors.New("preliminary key tree is incomplete")
	}
	return metadata, nil
}

// Finalize replays every accepted contribution, applies both committed
// beacons, writes native gnark artifacts into a fresh directory, reloads them,
// runs real repository-backed proof evidence, and coordinator-signs an
// unsigned release candidate. It never creates a release signing key or a
// release manifest.
func Finalize(options FinalizeOptions) (*FinalizeResult, error) {
	if options.Circuit == nil || options.Circuit.R1CS == nil {
		return nil, errors.New("compiled destination-v2 circuit is required")
	}
	if options.FinalizedAt.IsZero() {
		return nil, errors.New("finalized_at is required")
	}
	if options.FinalizedAt.Location() != time.UTC {
		return nil, errors.New("finalized_at must use UTC")
	}
	if strings.TrimSpace(options.PublicEvidencePath) == "" {
		return nil, errors.New("public finalization evidence path is required")
	}
	if _, err := readRegularFile(options.PublicEvidencePath); err != nil {
		return nil, fmt.Errorf("public finalization evidence preflight: %w", err)
	}
	loaded, err := loadReplay(options.Replay)
	if err != nil {
		return nil, err
	}
	if err := VerifyRunningSoftwareForMode(loaded.definition.Software, loaded.definition.Mode); err != nil {
		return nil, fmt.Errorf("running finalizer software: %w", err)
	}
	if err := ValidateCircuitBinding(options.Circuit, loaded.definition.Circuit); err != nil {
		return nil, err
	}
	privateKey, publicKey, err := keybundle.LoadExistingPrivateKey(options.CoordinatorSigningKey)
	if err != nil {
		return nil, err
	}
	if err := requireIdentityKey(loaded.definition.Coordinator, publicKey); err != nil {
		return nil, fmt.Errorf("coordinator signing key: %w", err)
	}
	replayed, err := replayAll(options.Circuit, loaded, options.Replay)
	if err != nil {
		return nil, err
	}
	stagingDir, err := createRecoveryStagingDir(options.OutDir)
	if err != nil {
		return nil, err
	}

	cleanup := true
	defer func() {
		// The authoritative destination is published only after the complete
		// candidate has been synced. A handled failure removes only this
		// invocation's unpublished staging directory.
		if cleanup {
			_ = os.RemoveAll(stagingDir)
			_ = syncDirectory(filepath.Dir(stagingDir))
		}
	}()

	ccsPath := filepath.Join(stagingDir, prover.DestinationConstraintSystemFile)
	ccsRef, err := writeR1CSNoReplace(ccsPath, options.Circuit)
	if err != nil {
		return nil, err
	}
	pkPath := filepath.Join(stagingDir, NativeProvingKeyFile)
	if err := saveNativeNoReplace(pkPath, func(path string) error {
		return prover.SavePK(replayed.pk, path)
	}); err != nil {
		return nil, err
	}
	vkPath := filepath.Join(stagingDir, NativeVerifyingKeyFile)
	if err := saveNativeNoReplace(vkPath, func(path string) error {
		return prover.SaveVK(replayed.vk, path)
	}); err != nil {
		return nil, err
	}
	if _, err := prover.LoadPK(pkPath); err != nil {
		return nil, fmt.Errorf("reload finalized proving key: %w", err)
	}
	vk, err := prover.LoadVK(vkPath)
	if err != nil {
		return nil, fmt.Errorf("reload finalized verifying key: %w", err)
	}
	pkRef, err := artifactRefForFile(NativeProvingKeyFile, pkPath)
	if err != nil {
		return nil, err
	}
	vkRef, err := artifactRefForFile(NativeVerifyingKeyFile, vkPath)
	if err != nil {
		return nil, err
	}
	phase2Seal, err := NewSealRecord(SealRecord{
		Schema:       SealRecordSchema,
		CeremonyID:   loaded.definition.CeremonyID,
		Phase:        Phase2,
		PhaseID:      loaded.phase2Chain.PhaseID,
		CloseID:      loaded.phase2Close.CloseID,
		BeaconID:     loaded.phase2Beacon.BeaconID,
		FinalPayload: loaded.phase2Close.FinalPayload,
		Outputs:      []ArtifactRef{pkRef, vkRef},
		SealedAt:     options.FinalizedAt.Format(time.RFC3339Nano),
	})
	if err != nil {
		return nil, fmt.Errorf("create phase2 seal: %w", err)
	}
	if err := ValidateSeal(loaded.phase2Close, loaded.phase2Beacon, phase2Seal); err != nil {
		return nil, fmt.Errorf("validate phase2 seal: %w", err)
	}
	phase2SealBytes, err := MarshalCanonical(phase2Seal)
	if err != nil {
		return nil, err
	}
	phase2SealPath := filepath.Join(stagingDir, Phase2SealFile)
	if err := writeSignedRecordNoReplace(
		phase2SealPath,
		filepath.Join(stagingDir, Phase2SealSignatureFile),
		phase2Seal,
		loaded.definition.Coordinator.KeyID,
		privateKey,
	); err != nil {
		return nil, err
	}
	phase2SealRef := ArtifactRef{Name: Phase2SealFile, Digest: NewDigest(phase2SealBytes)}
	loaded.phase2Seal = phase2Seal

	cardanoRaw, cardanoFormat, err := prover.SerializeCardanoVK(vk)
	if err != nil {
		return nil, err
	}
	if cardanoFormat != expectedCardanoBSB22 || len(cardanoRaw) != prover.CardanoVKCommitmentLen {
		return nil, fmt.Errorf(
			"cardano verifying key is format %q and %d bytes, want %q and %d bytes",
			cardanoFormat, len(cardanoRaw), expectedCardanoBSB22, prover.CardanoVKCommitmentLen,
		)
	}
	cardanoRawPath := filepath.Join(stagingDir, CardanoVKBytesFile)
	if err := writeBytesNoReplace(cardanoRawPath, cardanoRaw, 0o600); err != nil {
		return nil, err
	}
	cardanoHexPath := filepath.Join(stagingDir, CardanoVKHexFile)
	if err := writeBytesNoReplace(cardanoHexPath, []byte(hex.EncodeToString(cardanoRaw)+"\n"), 0o600); err != nil {
		return nil, err
	}
	cardanoFormatPath := filepath.Join(stagingDir, CardanoVKFormatFile)
	if err := writeBytesNoReplace(cardanoFormatPath, []byte(cardanoFormat+"\n"), 0o600); err != nil {
		return nil, err
	}
	cardanoRawRef, err := artifactRefForFile(CardanoVKBytesFile, cardanoRawPath)
	if err != nil {
		return nil, err
	}
	cardanoHexRef, err := artifactRefForFile(CardanoVKHexFile, cardanoHexPath)
	if err != nil {
		return nil, err
	}
	cardanoFormatRef, err := artifactRefForFile(CardanoVKFormatFile, cardanoFormatPath)
	if err != nil {
		return nil, err
	}

	publicEvidence, publicEvidenceBytes, verification, err := loadAndVerifyPublicEvidence(
		options.PublicEvidencePath,
		loaded.definition.CeremonyID,
		vk,
		cardanoRaw,
		cardanoRawRef,
	)
	if err != nil {
		return nil, err
	}
	publicEvidencePath := filepath.Join(stagingDir, PublicEvidenceFile)
	if err := writeBytesNoReplace(publicEvidencePath, publicEvidenceBytes, 0o600); err != nil {
		return nil, err
	}
	publicEvidenceRef := ArtifactRef{Name: PublicEvidenceFile, Digest: NewDigest(publicEvidenceBytes)}
	report := VerificationReport{
		Schema:                   VerificationReportSchema,
		CeremonyID:               loaded.definition.CeremonyID,
		Fixture:                  publicEvidence.Fixture,
		NativeProofVerified:      verification.NativeProofVerified,
		WrongCredentialRejected:  verification.WrongCredentialRejected,
		WrongDestinationRejected: verification.WrongDestinationRejected,
		WrongDigestRejected:      verification.WrongDigestRejected,
		WrongProofRejected:       verification.WrongProofRejected,
		WrongVKRejected:          verification.WrongVKRejected,
		ProofTruncationRejected:  verification.ProofTruncationRejected,
		ProofAppendRejected:      verification.ProofAppendRejected,
		CardanoProofFormat:       publicEvidence.CardanoProofFormat,
		CardanoProofBytes:        prover.CardanoProofCommitmentLen,
		CardanoProofRawDigest:    publicEvidence.CardanoProofRawDigest,
		CardanoVKFormat:          cardanoFormat,
		CardanoVKBytes:           len(cardanoRaw),
		CardanoVKRawDigest:       NewDigest(cardanoRaw),
		PublicEvidence:           publicEvidenceRef,
		CheckedAt:                options.FinalizedAt.Format(time.RFC3339Nano),
	}
	if report.PublicEvidence != publicEvidenceRef {
		return nil, errors.New("verification report does not hash-bind the exact public evidence artifact")
	}
	reportBytes, err := MarshalCanonical(report)
	if err != nil {
		return nil, err
	}
	reportPath := filepath.Join(stagingDir, VerificationReportFile)
	if err := writeBytesNoReplace(reportPath, reportBytes, 0o600); err != nil {
		return nil, err
	}
	reportRef := ArtifactRef{Name: VerificationReportFile, Digest: NewDigest(reportBytes)}

	phase1Summary, err := phaseSummary(loaded.phase1Chain, loaded.phase1ChainRef, loaded.phase1Close, loaded.phase1Beacon, loaded.phase1Seal)
	if err != nil {
		return nil, err
	}
	phase2Summary, err := phaseSummary(loaded.phase2Chain, loaded.phase2ChainRef, loaded.phase2Close, loaded.phase2Beacon, loaded.phase2Seal)
	if err != nil {
		return nil, err
	}
	candidate, err := NewCandidateMetadata(CandidateMetadata{
		Schema:              CandidateMetadataSchema,
		CeremonyID:          loaded.definition.CeremonyID,
		Definition:          loaded.definitionRef,
		Circuit:             loaded.definition.Circuit,
		Phase1:              phase1Summary,
		Phase2:              phase2Summary,
		ConstraintSystem:    ccsRef,
		ProvingKey:          pkRef,
		VerifyingKey:        vkRef,
		CardanoVerifyingKey: cardanoRawRef,
		CardanoVKHex:        cardanoHexRef,
		CardanoVKFormat:     cardanoFormatRef,
		VerificationReport:  reportRef,
		PublicEvidence:      publicEvidenceRef,
		Phase2SealRecord:    phase2SealRef,
		CoordinatorID:       loaded.definition.Coordinator.ID,
		CoordinatorKeyID:    loaded.definition.Coordinator.KeyID,
		FinalizedAt:         options.FinalizedAt.Format(time.RFC3339Nano),
	})
	if err != nil {
		return nil, err
	}
	candidatePath := filepath.Join(stagingDir, CandidateMetadataFile)
	signaturePath := filepath.Join(stagingDir, CandidateSignatureFile)
	if err := writeSignedRecordNoReplace(
		candidatePath,
		signaturePath,
		candidate,
		loaded.definition.Coordinator.KeyID,
		privateKey,
	); err != nil {
		return nil, err
	}
	checksumsPath := filepath.Join(stagingDir, CandidateChecksumsFile)
	if err := writeChecksumsNoReplace(stagingDir, checksumsPath, candidateChecksumNames()); err != nil {
		return nil, err
	}
	if err := syncDirectory(stagingDir); err != nil {
		return nil, err
	}
	if err := publishReleaseDirectory(stagingDir, options.OutDir); err != nil {
		return nil, fmt.Errorf("atomically publish finalized candidate directory: %w", err)
	}
	cleanup = false
	return &FinalizeResult{
		CeremonyID:        loaded.definition.CeremonyID,
		OutDir:            options.OutDir,
		Candidate:         candidate,
		CandidatePath:     filepath.Join(options.OutDir, CandidateMetadataFile),
		CandidateSigPath:  filepath.Join(options.OutDir, CandidateSignatureFile),
		VerificationPath:  filepath.Join(options.OutDir, VerificationReportFile),
		ProvingKeyPath:    filepath.Join(options.OutDir, NativeProvingKeyFile),
		VerifyingKeyPath:  filepath.Join(options.OutDir, NativeVerifyingKeyFile),
		ConstraintSystem:  filepath.Join(options.OutDir, prover.DestinationConstraintSystemFile),
		CardanoVKPath:     filepath.Join(options.OutDir, CardanoVKBytesFile),
		CandidateChecksum: filepath.Join(options.OutDir, CandidateChecksumsFile),
	}, nil
}

func loadReplay(paths ReplayPaths) (loadedReplay, error) {
	var result loadedReplay
	var err error
	coordinatorPublicKey, err := keybundle.DecodePublicKeyHex(paths.CoordinatorPublicKeyHex)
	if err != nil {
		return result, fmt.Errorf("trusted coordinator public key: %w", err)
	}
	if result.definitionRef, err = readTrustedDefinition(
		paths.DefinitionPath,
		paths.DefinitionSignaturePath,
		coordinatorPublicKey,
		&result.definition,
	); err != nil {
		return result, fmt.Errorf("ceremony definition: %w", err)
	}
	if err := requireIdentityKey(result.definition.Coordinator, coordinatorPublicKey); err != nil {
		return result, fmt.Errorf("trusted coordinator key does not match definition: %w", err)
	}
	coordinator := result.definition.Coordinator
	if result.phase1ChainRef, err = readSignedCanonicalFile(
		paths.Phase1ChainPath,
		paths.Phase1ChainSignaturePath,
		&result.phase1Chain,
		coordinator,
	); err != nil {
		return result, fmt.Errorf("phase1 chain: %w", err)
	}
	if _, err = readSignedCanonicalFile(
		paths.Phase1ClosePath,
		paths.Phase1CloseSignaturePath,
		&result.phase1Close,
		coordinator,
	); err != nil {
		return result, fmt.Errorf("phase1 close: %w", err)
	}
	if _, err = readSignedCanonicalFile(
		paths.Phase1BeaconPath,
		paths.Phase1BeaconSignaturePath,
		&result.phase1Beacon,
		coordinator,
	); err != nil {
		return result, fmt.Errorf("phase1 beacon: %w", err)
	}
	if err := validateBeaconRawResponse(
		result.definition,
		paths.TranscriptRoot,
		result.phase1Beacon,
	); err != nil {
		return result, fmt.Errorf("phase1 beacon raw response: %w", err)
	}
	if _, err = readSignedCanonicalFile(
		paths.Phase1SealPath,
		paths.Phase1SealSignaturePath,
		&result.phase1Seal,
		coordinator,
	); err != nil {
		return result, fmt.Errorf("phase1 seal: %w", err)
	}
	if result.phase2ChainRef, err = readSignedCanonicalFile(
		paths.Phase2ChainPath,
		paths.Phase2ChainSignaturePath,
		&result.phase2Chain,
		coordinator,
	); err != nil {
		return result, fmt.Errorf("phase2 chain: %w", err)
	}
	if _, err = readSignedCanonicalFile(
		paths.Phase2ClosePath,
		paths.Phase2CloseSignaturePath,
		&result.phase2Close,
		coordinator,
	); err != nil {
		return result, fmt.Errorf("phase2 close: %w", err)
	}
	if _, err = readSignedCanonicalFile(
		paths.Phase2BeaconPath,
		paths.Phase2BeaconSignaturePath,
		&result.phase2Beacon,
		coordinator,
	); err != nil {
		return result, fmt.Errorf("phase2 beacon: %w", err)
	}
	if err := validateBeaconRawResponse(
		result.definition,
		paths.TranscriptRoot,
		result.phase2Beacon,
	); err != nil {
		return result, fmt.Errorf("phase2 beacon raw response: %w", err)
	}
	if err := validateReplayRecords(result); err != nil {
		return result, err
	}
	if err := validateContributionEvidence(
		paths.TranscriptRoot,
		result.definition,
		result.phase1Chain,
	); err != nil {
		return result, fmt.Errorf("phase1 contribution evidence: %w", err)
	}
	if err := validateContributionEvidence(
		paths.TranscriptRoot,
		result.definition,
		result.phase2Chain,
	); err != nil {
		return result, fmt.Errorf("phase2 contribution evidence: %w", err)
	}
	return result, nil
}

func validateReplayRecords(replay loadedReplay) error {
	if err := replay.phase1Chain.ValidateAgainstDefinition(replay.definition); err != nil {
		return fmt.Errorf("phase1 chain: %w", err)
	}
	if replay.phase1Chain.Phase != Phase1 ||
		replay.phase1Chain.Genesis != replay.definition.Phase1Genesis {
		return errors.New("phase1 chain does not start at signed definition genesis")
	}
	phase1ID, err := ComputePhaseID(replay.definition.CeremonyID, Phase1, replay.definition.Phase1Genesis, "")
	if err != nil || replay.phase1Chain.PhaseID != phase1ID {
		return errors.New("phase1 chain phase identity mismatch")
	}
	if err := ValidateClose(replay.definition, replay.phase1Chain, replay.phase1Close); err != nil {
		return fmt.Errorf("phase1 close: %w", err)
	}
	if err := ValidateBeacon(replay.definition, replay.phase1Close, replay.phase1Beacon); err != nil {
		return fmt.Errorf("phase1 beacon: %w", err)
	}
	if err := ValidateSeal(replay.phase1Close, replay.phase1Beacon, replay.phase1Seal); err != nil {
		return fmt.Errorf("phase1 seal: %w", err)
	}
	if err := replay.phase2Chain.ValidateAgainstDefinition(replay.definition); err != nil {
		return fmt.Errorf("phase2 chain: %w", err)
	}
	if replay.phase2Chain.Phase != Phase2 {
		return errors.New("phase2 chain has wrong phase")
	}
	phase2ID, err := ComputePhaseID(
		replay.definition.CeremonyID,
		Phase2,
		replay.phase2Chain.Genesis,
		replay.phase1Seal.SealID,
	)
	if err != nil || replay.phase2Chain.PhaseID != phase2ID {
		return errors.New("phase2 chain phase identity mismatch")
	}
	if err := ValidateClose(replay.definition, replay.phase2Chain, replay.phase2Close); err != nil {
		return fmt.Errorf("phase2 close: %w", err)
	}
	if err := ValidateBeacon(replay.definition, replay.phase2Close, replay.phase2Beacon); err != nil {
		return fmt.Errorf("phase2 beacon: %w", err)
	}
	if replay.phase1Beacon.ChallengeSHA256 == replay.phase2Beacon.ChallengeSHA256 ||
		(replay.phase1Beacon.Provider == replay.phase2Beacon.Provider &&
			replay.phase1Beacon.Network == replay.phase2Beacon.Network &&
			replay.phase1Beacon.Round == replay.phase2Beacon.Round) {
		return errors.New("phase1 and phase2 must use distinct beacon challenges and rounds")
	}
	return nil
}

func replayAll(circuit *CompiledCircuit, records loadedReplay, paths ReplayPaths) (replayedKeys, error) {
	genesis := gnarkmpc.NewPhase1(circuit.Binding.DomainSize)
	genesisDigest, err := writerDigest(genesis)
	if err != nil {
		return replayedKeys{}, fmt.Errorf("digest deterministic phase1 genesis: %w", err)
	}
	if genesisDigest != records.definition.Phase1Genesis.Digest {
		return replayedKeys{}, errors.New("deterministic phase1 genesis does not match signed definition")
	}
	phase1GenesisPath, err := resolveArtifactPath(
		paths.TranscriptRoot,
		records.definition.Phase1Genesis.Name,
	)
	if err != nil {
		return replayedKeys{}, fmt.Errorf("resolve phase1 genesis: %w", err)
	}
	_, archivedGenesisDigest, err := ReadPhase1File(
		phase1GenesisPath,
		Phase1Shape{DomainN: circuit.Binding.DomainSize},
	)
	if err != nil {
		return replayedKeys{}, fmt.Errorf("read archived phase1 genesis: %w", err)
	}
	if artifactDigest(archivedGenesisDigest) != genesisDigest {
		return replayedKeys{}, errors.New("archived phase1 genesis differs from deterministic genesis")
	}
	phase1Shape := Phase1Shape{DomainN: circuit.Binding.DomainSize, ChallengeLength: contributionChallengeSize}
	phase1Loader := func(index int) (*gnarkmpc.Phase1, error) {
		expected := records.phase1Chain.Records[index].OutputPayload
		path, err := resolveArtifactPath(paths.TranscriptRoot, expected.Name)
		if err != nil {
			return nil, err
		}
		value, digest, err := ReadPhase1File(path, phase1Shape)
		if err != nil {
			return nil, err
		}
		if err := requireArchivedArtifact(
			paths.TranscriptRoot,
			path,
			artifactDigest(digest),
			expected,
		); err != nil {
			return nil, err
		}
		return value, nil
	}
	phase1Challenge, err := exactBeaconChallenge(records.phase1Beacon)
	if err != nil {
		return replayedKeys{}, err
	}
	commons, err := SealPhase1Loaded(circuit.Binding.DomainSize, phase1Challenge, len(records.phase1Chain.Records), phase1Loader)
	if err != nil {
		return replayedKeys{}, fmt.Errorf("full phase1 replay: %w", err)
	}
	commonsDigest, err := writerDigest(commons)
	if err != nil {
		return replayedKeys{}, fmt.Errorf("digest phase1 commons: %w", err)
	}
	commonsRef, err := sealOutputByDigest(records.phase1Seal, commonsDigest)
	if err != nil {
		return replayedKeys{}, fmt.Errorf("phase1 seal output: %w", err)
	}
	phase1CommonsPath, err := resolveArtifactPath(paths.TranscriptRoot, commonsRef.Name)
	if err != nil {
		return replayedKeys{}, fmt.Errorf("resolve phase1 commons: %w", err)
	}
	_, archivedCommonsDigest, err := ReadCommonsFile(
		phase1CommonsPath,
		CommonsShape{DomainN: circuit.Binding.DomainSize},
	)
	if err != nil {
		return replayedKeys{}, fmt.Errorf("read archived phase1 commons: %w", err)
	}
	if artifactDigest(archivedCommonsDigest) != commonsDigest {
		return replayedKeys{}, errors.New("archived phase1 commons differs from full replay")
	}

	initialPhase2, _, err := InitializePhase2(circuit, commons)
	if err != nil {
		return replayedKeys{}, err
	}
	initialDigest, err := writerDigest(initialPhase2)
	if err != nil {
		return replayedKeys{}, err
	}
	if initialDigest != records.phase2Chain.Genesis.Digest {
		return replayedKeys{}, errors.New("deterministic phase2 genesis does not match signed chain")
	}
	phase2GenesisPath, err := resolveArtifactPath(
		paths.TranscriptRoot,
		records.phase2Chain.Genesis.Name,
	)
	if err != nil {
		return replayedKeys{}, fmt.Errorf("resolve phase2 genesis: %w", err)
	}
	_, archivedPhase2GenesisDigest, err := ReadPhase2File(
		phase2GenesisPath,
		circuit.Binding.Phase2Shape,
	)
	if err != nil {
		return replayedKeys{}, fmt.Errorf("read archived phase2 genesis: %w", err)
	}
	if artifactDigest(archivedPhase2GenesisDigest) != initialDigest {
		return replayedKeys{}, errors.New("archived phase2 genesis differs from deterministic genesis")
	}
	phase2Shape := circuit.Binding.Phase2Shape
	phase2Shape.ChallengeLength = contributionChallengeSize
	phase2Loader := func(index int) (*gnarkmpc.Phase2, error) {
		expected := records.phase2Chain.Records[index].OutputPayload
		path, err := resolveArtifactPath(paths.TranscriptRoot, expected.Name)
		if err != nil {
			return nil, err
		}
		value, digest, err := ReadPhase2File(path, phase2Shape)
		if err != nil {
			return nil, err
		}
		if err := requireArchivedArtifact(
			paths.TranscriptRoot,
			path,
			artifactDigest(digest),
			expected,
		); err != nil {
			return nil, err
		}
		return value, nil
	}
	phase2Challenge, err := exactBeaconChallenge(records.phase2Beacon)
	if err != nil {
		return replayedKeys{}, err
	}
	pk, vk, err := SealPhase2Loaded(circuit, commons, phase2Challenge, len(records.phase2Chain.Records), phase2Loader)
	if err != nil {
		return replayedKeys{}, fmt.Errorf("full phase2 replay: %w", err)
	}
	return replayedKeys{commons: commons, pk: pk, vk: vk}, nil
}

func loadAndVerifyPublicEvidence(
	path string,
	ceremonyID string,
	vk groth16.VerifyingKey,
	cardanoVK []byte,
	cardanoVKRef ArtifactRef,
) (PublicFinalizationEvidence, []byte, publicEvidenceVerification, error) {
	var verification publicEvidenceVerification
	if strings.TrimSpace(path) == "" {
		return PublicFinalizationEvidence{}, nil, verification, errors.New("public finalization evidence path is required")
	}
	data, err := readRegularFile(path)
	if err != nil {
		return PublicFinalizationEvidence{}, nil, verification, err
	}
	var evidence PublicFinalizationEvidence
	if err := UnmarshalCanonical(data, &evidence); err != nil {
		return PublicFinalizationEvidence{}, nil, verification, fmt.Errorf("public finalization evidence: %w", err)
	}
	if evidence.CeremonyID != ceremonyID {
		return PublicFinalizationEvidence{}, nil, verification, errors.New("public finalization evidence ceremony id differs from replay")
	}
	if cardanoVKRef.Name != CardanoVKBytesFile || cardanoVKRef.Digest != NewDigest(cardanoVK) {
		return PublicFinalizationEvidence{}, nil, verification, errors.New("public evidence Cardano key reference differs from exact serialized key")
	}
	if evidence.CardanoVerifyingKey != cardanoVKRef {
		return PublicFinalizationEvidence{}, nil, verification, errors.New("public finalization evidence binds a different Cardano verifying key")
	}
	proofBytes, err := hex.DecodeString(evidence.CardanoProofHex)
	if err != nil {
		return PublicFinalizationEvidence{}, nil, verification, err
	}
	proof, err := parseCardanoProof(proofBytes)
	if err != nil {
		return PublicFinalizationEvidence{}, nil, verification, fmt.Errorf("public evidence Cardano proof: %w", err)
	}
	digest, _ := hex.DecodeString(evidence.PublicInputDigestHex)
	if err := verifyProofForDigest(vk, proof, digest); err != nil {
		return PublicFinalizationEvidence{}, nil, verification, fmt.Errorf("native verification of public evidence: %w", err)
	}
	verification.NativeProofVerified = true
	credential, _ := hex.DecodeString(evidence.CredentialHex)
	destination, _ := hex.DecodeString(evidence.DestinationHex)
	changedDestination := bytes.Clone(destination)
	changedDestination[0] ^= 1
	wrongDigest := publicInputDigest(credential, changedDestination)
	if err := verifyProofForDigest(vk, proof, wrongDigest); err == nil {
		return PublicFinalizationEvidence{}, nil, verification, errors.New("public evidence proof accepted a changed destination")
	}
	verification.WrongDestinationRejected = true
	changedCredential := bytes.Clone(credential)
	changedCredential[0] ^= 1
	wrongCredentialDigest := publicInputDigest(changedCredential, destination)
	if err := verifyProofForDigest(vk, proof, wrongCredentialDigest); err == nil {
		return PublicFinalizationEvidence{}, nil, verification, errors.New("public evidence proof accepted a changed credential")
	}
	verification.WrongCredentialRejected = true
	changedDigest := bytes.Clone(digest)
	changedDigest[0] ^= 1
	if err := verifyProofForDigest(vk, proof, changedDigest); err == nil {
		return PublicFinalizationEvidence{}, nil, verification, errors.New("public evidence proof accepted a changed public-input digest")
	}
	verification.WrongDigestRejected = true
	changedProofBytes := bytes.Clone(proofBytes)
	changedProofBytes[0] ^= 1
	if changedProof, parseErr := parseCardanoProof(changedProofBytes); parseErr == nil {
		if err := verifyProofForDigest(vk, changedProof, digest); err == nil {
			return PublicFinalizationEvidence{}, nil, verification, errors.New("changed public evidence proof was accepted")
		}
	}
	verification.WrongProofRejected = true
	wrongVK, err := cloneWrongVerifyingKey(vk)
	if err != nil {
		return PublicFinalizationEvidence{}, nil, verification, err
	}
	if err := verifyProofForDigest(wrongVK, proof, digest); err == nil {
		return PublicFinalizationEvidence{}, nil, verification, errors.New("public evidence proof accepted a changed verifying key")
	}
	verification.WrongVKRejected = true
	if _, err := parseCardanoProof(proofBytes[:len(proofBytes)-1]); err == nil {
		return PublicFinalizationEvidence{}, nil, verification, errors.New("truncated public evidence proof was accepted")
	}
	verification.ProofTruncationRejected = true
	appendedProof := append(bytes.Clone(proofBytes), 0)
	if _, err := parseCardanoProof(appendedProof); err == nil {
		return PublicFinalizationEvidence{}, nil, verification, errors.New("appended public evidence proof was accepted")
	}
	verification.ProofAppendRejected = true
	return evidence, data, verification, nil
}

func publicInputDigest(credential, destination []byte) []byte {
	preimage := make([]byte, 0, len(DestinationPublicDomain)+len(credential)+len(destination))
	preimage = append(preimage, DestinationPublicDomain...)
	preimage = append(preimage, credential...)
	preimage = append(preimage, destination...)
	digest := blake2b.Sum256(preimage)
	return digest[:]
}

func publicInputScalar(digest []byte) *big.Int {
	reversed := bytes.Clone(digest)
	for left, right := 0, len(reversed)-1; left < right; left, right = left+1, right-1 {
		reversed[left], reversed[right] = reversed[right], reversed[left]
	}
	value := new(big.Int).SetBytes(reversed)
	return value.Mod(value, ecc.BLS12_381.ScalarField())
}

func parseCardanoProof(data []byte) (*groth16bls12381.Proof, error) {
	if len(data) != prover.CardanoProofCommitmentLen {
		return nil, fmt.Errorf("proof is %d bytes, want %d", len(data), prover.CardanoProofCommitmentLen)
	}
	proof := new(groth16bls12381.Proof)
	if _, err := proof.Ar.SetBytes(data[:48]); err != nil {
		return nil, fmt.Errorf("proof A: %w", err)
	}
	if _, err := proof.Bs.SetBytes(data[48:144]); err != nil {
		return nil, fmt.Errorf("proof B: %w", err)
	}
	if _, err := proof.Krs.SetBytes(data[144:192]); err != nil {
		return nil, fmt.Errorf("proof C: %w", err)
	}
	proof.Commitments = make([]bls12381.G1Affine, 1)
	if _, err := proof.Commitments[0].SetBytes(data[prover.CmtOff:prover.PokOff]); err != nil {
		return nil, fmt.Errorf("commitment: %w", err)
	}
	if _, err := proof.CommitmentPok.SetBytes(data[prover.PokOff:]); err != nil {
		return nil, fmt.Errorf("commitment proof: %w", err)
	}
	return proof, nil
}

func verifyProofForDigest(vk groth16.VerifyingKey, proof groth16.Proof, digest []byte) error {
	if len(digest) != blake2b.Size256 {
		return errors.New("public input digest must be exactly 32 bytes")
	}
	publicWitness, err := witness.New(ecc.BLS12_381.ScalarField())
	if err != nil {
		return err
	}
	values := make(chan any, 1)
	values <- publicInputScalar(digest)
	close(values)
	if err := publicWitness.Fill(1, 0, values); err != nil {
		return err
	}
	return groth16.Verify(proof, vk, publicWitness)
}

func cloneWrongVerifyingKey(vk groth16.VerifyingKey) (groth16.VerifyingKey, error) {
	var encoded bytes.Buffer
	if _, err := vk.WriteTo(&encoded); err != nil {
		return nil, fmt.Errorf("serialize verifying key for negative check: %w", err)
	}
	wrong := groth16.NewVerifyingKey(ecc.BLS12_381)
	if _, err := wrong.ReadFrom(bytes.NewReader(encoded.Bytes())); err != nil {
		return nil, fmt.Errorf("reload verifying key for negative check: %w", err)
	}
	concrete, ok := wrong.(*groth16bls12381.VerifyingKey)
	if !ok {
		return nil, fmt.Errorf("unexpected verifying key type %T", wrong)
	}
	if len(concrete.G1.K) == 0 {
		return nil, errors.New("verifying key has no public-input basis")
	}
	// G1.K is consumed directly by gnark's verifier. Mutating Alpha after
	// ReadFrom is not a valid negative test: the verifier uses the precomputed
	// pairing E, so a stale Alpha field can change serialized/Cardano bytes
	// without changing verification behavior.
	original := concrete.G1.K[0]
	if original.IsInfinity() {
		return nil, errors.New("verifying key has an unusable identity public-input basis")
	}
	concrete.G1.K[0].Neg(&original)
	if concrete.G1.K[0].Equal(&original) {
		return nil, errors.New("failed to construct a distinct wrong verifying key")
	}
	return wrong, nil
}

func phaseSummary(chain Chain, chainRef ArtifactRef, close CloseRecord, beacon BeaconRecord, seal SealRecord) (PhaseSummary, error) {
	head, err := chain.HeadRecordID()
	if err != nil {
		return PhaseSummary{}, err
	}
	participants, err := chain.ParticipantIDs()
	if err != nil {
		return PhaseSummary{}, err
	}
	summary := PhaseSummary{
		Phase:             chain.Phase,
		PhaseID:           chain.PhaseID,
		Genesis:           chain.Genesis,
		Chain:             chainRef,
		ChainHeadID:       head,
		ContributionCount: uint8(len(chain.Records)),
		Participants:      participants,
		CloseID:           close.CloseID,
		BeaconID:          beacon.BeaconID,
		SealID:            seal.SealID,
		Outputs:           append([]ArtifactRef(nil), seal.Outputs...),
	}
	return summary, summary.Validate()
}

func exactBeaconChallenge(record BeaconRecord) ([]byte, error) {
	challenge, err := hex.DecodeString(record.ChallengeHex)
	if err != nil {
		return nil, err
	}
	if len(challenge) != contributionChallengeSize {
		return nil, fmt.Errorf("beacon challenge is %d bytes, want exactly %d", len(challenge), contributionChallengeSize)
	}
	return challenge, nil
}

func artifactDigest(value ArtifactDigest) Digest {
	return Digest{
		SHA256:     "sha256:" + hex.EncodeToString(value.SHA256[:]),
		Blake2b256: "blake2b256:" + hex.EncodeToString(value.BLAKE2b256[:]),
		Size:       value.Size,
	}
}

func writerDigest(value io.WriterTo) (Digest, error) {
	sha := sha256.New()
	blake, err := blake2b.New256(nil)
	if err != nil {
		return Digest{}, err
	}
	n, err := writeToWithPanicBoundary(
		"native key digest encoder",
		value,
		io.MultiWriter(sha, blake),
	)
	if err != nil {
		return Digest{}, err
	}
	return Digest{
		SHA256:     "sha256:" + hex.EncodeToString(sha.Sum(nil)),
		Blake2b256: "blake2b256:" + hex.EncodeToString(blake.Sum(nil)),
		Size:       n,
	}, nil
}

func requireArchivedArtifact(root, path string, digest Digest, expected ArtifactRef) error {
	if err := requireArtifactPath(root, path, expected); err != nil {
		return err
	}
	if digest != expected.Digest {
		return fmt.Errorf("artifact %q digest does not match accepted chain", expected.Name)
	}
	return nil
}

func requireArtifactPath(root, path string, expected ArtifactRef) error {
	expectedPath, err := resolveArtifactPath(root, expected.Name)
	if err != nil {
		return err
	}
	if filepath.Clean(path) != filepath.Clean(expectedPath) {
		return fmt.Errorf("artifact path %q, want explicit signed path %q", path, expectedPath)
	}
	return nil
}

func sealOutputByDigest(seal SealRecord, expected Digest) (ArtifactRef, error) {
	var found ArtifactRef
	for _, output := range seal.Outputs {
		if output.Digest == expected {
			if found.Name != "" {
				return ArtifactRef{}, errors.New("seal repeats reproduced output digest")
			}
			found = output
		}
	}
	if found.Name == "" {
		return ArtifactRef{}, errors.New("seal does not bind reproduced output digest")
	}
	return found, nil
}

func readCanonicalFile(path string, destination any) (ArtifactRef, error) {
	if strings.TrimSpace(path) == "" {
		return ArtifactRef{}, errors.New("canonical artifact path is required")
	}
	data, err := readRegularFile(path)
	if err != nil {
		return ArtifactRef{}, err
	}
	if err := UnmarshalCanonical(data, destination); err != nil {
		return ArtifactRef{}, err
	}
	ref := ArtifactRef{Name: filepath.Base(path), Digest: NewDigest(data)}
	return ref, ref.Validate()
}

func readTrustedDefinition(
	recordPath string,
	signaturePath string,
	trustedPublicKey ed25519.PublicKey,
	definition *CeremonyDefinition,
) (ArtifactRef, error) {
	recordBytes, err := readRegularFile(recordPath)
	if err != nil {
		return ArtifactRef{}, err
	}
	signatureBytes, err := readRegularFile(signaturePath)
	if err != nil {
		return ArtifactRef{}, err
	}
	var signature DetachedSignature
	if err := UnmarshalCanonical(signatureBytes, &signature); err != nil {
		return ArtifactRef{}, fmt.Errorf("definition signature: %w", err)
	}
	if err := VerifyExact(recordBytes, signature, signature.KeyID, trustedPublicKey); err != nil {
		return ArtifactRef{}, fmt.Errorf("definition signature: %w", err)
	}
	if err := UnmarshalCanonical(recordBytes, definition); err != nil {
		return ArtifactRef{}, err
	}
	if signature.KeyID != definition.Coordinator.KeyID {
		return ArtifactRef{}, errors.New("definition signature key id does not match coordinator identity")
	}
	ref := ArtifactRef{Name: filepath.Base(recordPath), Digest: NewDigest(recordBytes)}
	return ref, ref.Validate()
}

func readSignedCanonicalFile(
	recordPath string,
	signaturePath string,
	destination any,
	signer Identity,
) (ArtifactRef, error) {
	recordBytes, err := readRegularFile(recordPath)
	if err != nil {
		return ArtifactRef{}, err
	}
	signatureBytes, err := readRegularFile(signaturePath)
	if err != nil {
		return ArtifactRef{}, err
	}
	publicKey, err := keybundle.DecodePublicKeyHex(signer.Ed25519PublicKeyHex)
	if err != nil {
		return ArtifactRef{}, err
	}
	if err := VerifySignedRecord(recordBytes, signatureBytes, destination, signer.KeyID, publicKey); err != nil {
		return ArtifactRef{}, err
	}
	ref := ArtifactRef{Name: filepath.Base(recordPath), Digest: NewDigest(recordBytes)}
	return ref, ref.Validate()
}

func validateContributionEvidence(
	root string,
	definition CeremonyDefinition,
	chain Chain,
) error {
	for index, record := range chain.Records {
		attestationBytes, err := verifyArtifactBytes(root, record.Attestation, maxSignedRecordBytes)
		if err != nil {
			return fmt.Errorf("contribution %d attestation artifact: %w", index+1, err)
		}
		signatureBytes, err := verifyArtifactBytes(root, record.AttestationSignature, maxSignedRecordBytes)
		if err != nil {
			return fmt.Errorf("contribution %d attestation signature artifact: %w", index+1, err)
		}
		erasureBytes, err := verifyArtifactBytes(root, record.Erasure, maxSignedRecordBytes)
		if err != nil {
			return fmt.Errorf("contribution %d erasure artifact: %w", index+1, err)
		}
		erasureSignatureBytes, err := verifyArtifactBytes(root, record.ErasureSignature, maxSignedRecordBytes)
		if err != nil {
			return fmt.Errorf("contribution %d erasure signature artifact: %w", index+1, err)
		}
		verificationBytes, err := verifyArtifactBytes(root, record.Verification, maxSignedRecordBytes)
		if err != nil {
			return fmt.Errorf("contribution %d verification artifact: %w", index+1, err)
		}
		var verification ContributionVerification
		if err := UnmarshalCanonical(verificationBytes, &verification); err != nil {
			return fmt.Errorf("contribution %d verification record: %w", index+1, err)
		}
		if err := validateContributionVerification(record, verification); err != nil {
			return fmt.Errorf("contribution %d verification record: %w", index+1, err)
		}
		participant, ok := definition.ParticipantByID(record.ParticipantID)
		if !ok {
			return fmt.Errorf("contribution %d participant is not enrolled", index+1)
		}
		publicKey, err := keybundle.DecodePublicKeyHex(participant.Identity.Ed25519PublicKeyHex)
		if err != nil {
			return err
		}
		var attestation ContributionAttestation
		if err := VerifySignedRecord(
			attestationBytes,
			signatureBytes,
			&attestation,
			participant.Identity.KeyID,
			publicKey,
		); err != nil {
			return fmt.Errorf("contribution %d attestation signature: %w", index+1, err)
		}
		var erasure ErasureAttestation
		if err := VerifySignedRecord(
			erasureBytes,
			erasureSignatureBytes,
			&erasure,
			participant.Identity.KeyID,
			publicKey,
		); err != nil {
			return fmt.Errorf("contribution %d erasure signature: %w", index+1, err)
		}
		prefix := chain
		prefix.Records = append([]ChainRecord(nil), chain.Records[:index]...)
		if err := ValidateAttestationAcceptance(definition, prefix, attestation, erasure, record); err != nil {
			return fmt.Errorf("contribution %d attestation binding: %w", index+1, err)
		}
	}
	return nil
}

func validateBeaconRawResponse(definition CeremonyDefinition, root string, beacon BeaconRecord) error {
	path, err := resolveArtifactPath(root, beacon.RawResponse.Name)
	if err != nil {
		return err
	}
	data, err := readRegularBounded(path, maxDrandResponseBytes)
	if err != nil {
		return err
	}
	if err := requireEvidenceArtifact(root, path, data, beacon.RawResponse); err != nil {
		return err
	}
	randomnessHex, err := VerifyDrandBeaconResponse(
		definition.BeaconPolicy,
		beacon.Round,
		data,
	)
	if err != nil {
		return err
	}
	if randomnessHex != beacon.RandomnessHex {
		return errors.New("signed beacon randomness differs from verified archived drand response")
	}
	return nil
}

func requireEvidenceArtifact(root, path string, data []byte, expected ArtifactRef) error {
	expectedPath, err := resolveArtifactPath(root, expected.Name)
	if err != nil {
		return err
	}
	if filepath.Clean(path) != filepath.Clean(expectedPath) {
		return fmt.Errorf("artifact path %q, want signed path %q", path, expectedPath)
	}
	if NewDigest(data) != expected.Digest {
		return errors.New("artifact digest mismatch")
	}
	return nil
}

func artifactRefForFile(name, path string) (ArtifactRef, error) {
	linkInfo, err := os.Lstat(path)
	if err != nil {
		return ArtifactRef{}, err
	}
	if !linkInfo.Mode().IsRegular() {
		return ArtifactRef{}, fmt.Errorf("%q is not a regular file", path)
	}
	file, err := os.Open(path)
	if err != nil {
		return ArtifactRef{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return ArtifactRef{}, err
	}
	if !info.Mode().IsRegular() {
		return ArtifactRef{}, fmt.Errorf("%q is not a regular file", path)
	}
	if !os.SameFile(linkInfo, info) {
		return ArtifactRef{}, fmt.Errorf("%q changed while being opened", path)
	}
	if info.Size() <= 0 || info.Size() > MaxArtifactSize {
		return ArtifactRef{}, fmt.Errorf(
			"%q size %d is outside [1,%d]",
			path,
			info.Size(),
			MaxArtifactSize,
		)
	}
	sha := sha256.New()
	blake, err := blake2b.New256(nil)
	if err != nil {
		return ArtifactRef{}, err
	}
	n, err := io.Copy(io.MultiWriter(sha, blake), file)
	if err != nil {
		return ArtifactRef{}, err
	}
	if n != info.Size() {
		return ArtifactRef{}, fmt.Errorf("%q changed size while hashing", path)
	}
	ref := ArtifactRef{
		Name: name,
		Digest: Digest{
			SHA256:     "sha256:" + hex.EncodeToString(sha.Sum(nil)),
			Blake2b256: "blake2b256:" + hex.EncodeToString(blake.Sum(nil)),
			Size:       n,
		},
	}
	return ref, ref.Validate()
}

func readRegularFile(path string) ([]byte, error) {
	return readRegularBounded(path, maxSignedRecordBytes)
}

func requireIdentityKey(identity Identity, publicKey ed25519.PublicKey) error {
	if err := identity.Validate(); err != nil {
		return err
	}
	expected, err := hex.DecodeString(identity.Ed25519PublicKeyHex)
	if err != nil {
		return err
	}
	if !bytes.Equal(expected, publicKey) {
		return errors.New("public key does not match signed ceremony identity")
	}
	return nil
}

func makeFreshPrivateDir(path string) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("fresh output directory is required")
	}
	parent := filepath.Dir(path)
	info, err := os.Stat(parent)
	if err != nil {
		return fmt.Errorf("stat output parent: %w", err)
	}
	if !info.IsDir() {
		return errors.New("output parent is not a directory")
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		return fmt.Errorf("create fresh output directory: %w", err)
	}
	return nil
}

func writeR1CSNoReplace(path string, circuit *CompiledCircuit) (ArtifactRef, error) {
	digest, err := WriteR1CSFileNoReplace(path, circuit)
	if err != nil {
		return ArtifactRef{}, err
	}
	return ArtifactRef{Name: prover.DestinationConstraintSystemFile, Digest: digest}, nil
}

func saveNativeNoReplace(path string, save func(string) error) (err error) {
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".partial-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Remove(tempPath); err != nil {
		return err
	}
	defer os.Remove(tempPath)
	if err := save(tempPath); err != nil {
		return err
	}
	file, err := os.Open(tempPath)
	if err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := publishFileNoReplace(tempPath, path); err != nil {
		return fmt.Errorf("publish native artifact without replacement: %w", err)
	}
	return nil
}

func writeBytesNoReplace(path string, data []byte, mode fs.FileMode) (err error) {
	if strings.TrimSpace(path) == "" {
		return errors.New("output path is required")
	}
	dir := filepath.Dir(path)
	file, err := os.CreateTemp(dir, "."+filepath.Base(path)+".partial-*")
	if err != nil {
		return fmt.Errorf("create temporary file for %s: %w", path, err)
	}
	tempPath := file.Name()
	fileOpen := true
	defer func() {
		if fileOpen {
			_ = file.Close()
		}
		_ = os.Remove(tempPath)
	}()
	if err := file.Chmod(mode); err != nil {
		return fmt.Errorf("chmod temporary file for %s: %w", path, err)
	}
	n, err := file.Write(data)
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	if n != len(data) {
		return fmt.Errorf("write %s: %w", path, io.ErrShortWrite)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync %s: %w", path, err)
	}
	if err := file.Close(); err != nil {
		fileOpen = false
		return fmt.Errorf("close %s: %w", path, err)
	}
	fileOpen = false
	if err := publishFileNoReplace(tempPath, path); err != nil {
		return fmt.Errorf("publish %s without replacement: %w", path, err)
	}
	return nil
}

func writeChecksumsNoReplace(dir, outputPath string, names []string) error {
	sorted := append([]string(nil), names...)
	sort.Strings(sorted)
	var output strings.Builder
	for _, name := range sorted {
		path, err := resolveArtifactPath(dir, name)
		if err != nil {
			return err
		}
		ref, err := artifactRefForFile(name, path)
		if err != nil {
			return err
		}
		output.WriteString(strings.TrimPrefix(ref.Digest.SHA256, "sha256:"))
		output.WriteString("  ")
		output.WriteString(name)
		output.WriteByte('\n')
	}
	return writeBytesNoReplace(outputPath, []byte(output.String()), 0o600)
}
