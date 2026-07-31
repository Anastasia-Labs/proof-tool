package mpcceremony

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/consensys/gnark/backend/groth16"
	"golang.org/x/crypto/blake2b"

	"proof-tool/internal/artifact"
	"proof-tool/internal/keybundle"
	"proof-tool/internal/prover"
)

const (
	OperationalEvidenceBundleFile    = "operational/evidence-bundle.json"
	OperationalEvidenceSignatureFile = "operational/evidence-bundle.sig"
)

type AuditOptions struct {
	Replay            ReplayPaths
	Circuit           *CompiledCircuit
	CandidateDir      string
	AuditorID         string
	AuditorSigningKey string
	OutPath           string
	SignatureOutPath  string
	AuditedAt         time.Time
}

type AuditResult struct {
	Record        AuditRecord
	RecordPath    string
	SignaturePath string
}

type AuditArtifact struct {
	RecordPath    string
	SignaturePath string
	LogicalName   string
}

type SignReleaseOptions struct {
	DefinitionPath           string
	DefinitionSignaturePath  string
	CoordinatorPublicKeyHex  string
	CandidateDir             string
	ReleaseDir               string
	Audits                   []AuditArtifact
	OperationalEvidenceRoot  string
	OperationalBundlePath    string
	OperationalSignaturePath string
	ReleaseSigningKey        string
	SignatureKeyID           string
	ReleasedAt               time.Time
}

type SignReleaseResult struct {
	ManifestPath        string
	ManifestSignature   string
	ManifestPublicKey   string
	FinalTranscript     string
	OperationalEvidence string
	ChecksumsPath       string
}

type VerifyReleaseOptions struct {
	DefinitionPath          string
	DefinitionSignaturePath string
	CoordinatorPublicKeyHex string
	KeysDir                 string
	TrustedPublicKeyHex     string
	ExpectedSignatureKeyID  string
	RequireProvingKey       bool
}

type VerifyReleaseResult struct {
	Manifest   *artifact.KeyManifest
	Transcript FinalTranscript
	Candidate  CandidateMetadata
}

// Audit independently replays both phases from explicit immutable paths,
// reproduces the final native keys and Cardano verifier bytes, validates the
// coordinator-signed candidate, and emits a signed passing audit record.
func Audit(options AuditOptions) (*AuditResult, error) {
	if options.Circuit == nil || options.Circuit.R1CS == nil {
		return nil, errors.New("independently compiled destination-v2 circuit is required")
	}
	if options.AuditedAt.IsZero() || options.AuditedAt.Location() != time.UTC {
		return nil, errors.New("audited_at must be a non-zero UTC time")
	}
	replay, err := loadReplay(options.Replay)
	if err != nil {
		return nil, err
	}
	if err := VerifyRunningSoftwareForMode(replay.definition.Software, replay.definition.Mode); err != nil {
		return nil, fmt.Errorf("running auditor software: %w", err)
	}
	if err := ValidateCircuitBinding(options.Circuit, replay.definition.Circuit); err != nil {
		return nil, err
	}
	auditor, ok := auditorByID(replay.definition, options.AuditorID)
	if !ok {
		return nil, fmt.Errorf("auditor %q is not enrolled in the ceremony definition", options.AuditorID)
	}
	privateKey, publicKey, err := keybundle.LoadExistingPrivateKey(options.AuditorSigningKey)
	if err != nil {
		return nil, err
	}
	if err := requireIdentityKey(auditor, publicKey); err != nil {
		return nil, fmt.Errorf("auditor signing key: %w", err)
	}
	candidate, candidateRef, err := verifyCandidate(replay.definition, replay.definitionRef, options.CandidateDir)
	if err != nil {
		return nil, err
	}
	candidateTime, err := time.Parse(time.RFC3339Nano, candidate.FinalizedAt)
	if err != nil {
		return nil, err
	}
	if !options.AuditedAt.After(candidateTime) {
		return nil, errors.New("audited_at must strictly postdate candidate finalization")
	}
	phase2Seal, err := loadCandidatePhase2Seal(replay.definition, candidate, options.CandidateDir)
	if err != nil {
		return nil, err
	}
	if err := ValidateSeal(replay.phase2Close, replay.phase2Beacon, phase2Seal); err != nil {
		return nil, fmt.Errorf("candidate phase2 seal: %w", err)
	}
	replay.phase2Seal = phase2Seal
	replayed, err := replayAll(options.Circuit, replay, options.Replay)
	if err != nil {
		return nil, err
	}
	if err := compareCandidateToReplay(
		options.Circuit,
		replay,
		replayed.pk,
		replayed.vk,
		candidate,
		options.CandidateDir,
		options.AuditedAt,
	); err != nil {
		return nil, err
	}
	replayRoot, err := replayRootSHA256(candidate)
	if err != nil {
		return nil, err
	}
	outputs := candidateAuditOutputs(candidate, candidateRef)
	record, err := NewAuditRecord(AuditRecord{
		Schema:           AuditRecordSchema,
		CeremonyID:       replay.definition.CeremonyID,
		AuditorID:        auditor.ID,
		AuditorKeyID:     auditor.KeyID,
		Definition:       replay.definitionRef,
		Phase1Chain:      replay.phase1ChainRef,
		Phase2Chain:      replay.phase2ChainRef,
		Phase1SealID:     replay.phase1Seal.SealID,
		Phase2SealID:     replay.phase2Seal.SealID,
		ReplayRootSHA256: replayRoot,
		Outputs:          outputs,
		Passed:           true,
		Findings:         []string{},
		AuditedAt:        options.AuditedAt.Format(time.RFC3339Nano),
	})
	if err != nil {
		return nil, err
	}
	if filepath.Clean(options.OutPath) == filepath.Clean(options.SignatureOutPath) {
		return nil, errors.New("audit record and signature output paths must differ")
	}
	if err := writeSignedRecordNoReplace(
		options.OutPath,
		options.SignatureOutPath,
		record,
		auditor.KeyID,
		privateKey,
	); err != nil {
		return nil, err
	}
	return &AuditResult{Record: record, RecordPath: options.OutPath, SignaturePath: options.SignatureOutPath}, nil
}

func compareCandidateToReplay(
	circuit *CompiledCircuit,
	replay loadedReplay,
	pk groth16.ProvingKey,
	vk groth16.VerifyingKey,
	candidate CandidateMetadata,
	dir string,
	auditedAt time.Time,
) error {
	loadedCCS, err := ReadR1CSFile(filepath.Join(dir, candidate.ConstraintSystem.Name), replay.definition.Circuit)
	if err != nil {
		return fmt.Errorf("candidate frozen R1CS: %w", err)
	}
	if err := ValidateCircuitBinding(loadedCCS, circuit.Binding); err != nil {
		return fmt.Errorf("candidate R1CS differs from independent compile: %w", err)
	}
	pkDigest, err := rawProvingKeyDigest(pk)
	if err != nil {
		return err
	}
	if pkDigest != candidate.ProvingKey.Digest {
		return errors.New("independent replay proving key differs from candidate")
	}
	vkDigest, err := writerDigest(vk)
	if err != nil {
		return err
	}
	if vkDigest != candidate.VerifyingKey.Digest {
		return errors.New("independent replay verifying key differs from candidate")
	}
	cardanoVK, format, err := prover.SerializeCardanoVK(vk)
	if err != nil {
		return err
	}
	if format != expectedCardanoBSB22 || len(cardanoVK) != prover.CardanoVKCommitmentLen {
		return errors.New("independent replay Cardano verifying key is not exact BSB22 encoding")
	}
	if NewDigest(cardanoVK) != candidate.CardanoVerifyingKey.Digest {
		return errors.New("independent replay Cardano verifying key differs from candidate")
	}
	if err := verifyCardanoFiles(dir, candidate, vk); err != nil {
		return err
	}
	var candidateReport VerificationReport
	if _, err := readCanonicalFile(filepath.Join(dir, candidate.VerificationReport.Name), &candidateReport); err != nil {
		return err
	}
	if candidateReport.CardanoVKRawDigest != NewDigest(cardanoVK) ||
		candidateReport.CardanoVKBytes != len(cardanoVK) ||
		candidateReport.CardanoVKFormat != format ||
		candidateReport.CardanoProofBytes != prover.CardanoProofCommitmentLen ||
		candidateReport.CardanoProofFormat != expectedCardanoBSB22 ||
		!candidateReport.NativeProofVerified ||
		!candidateReport.WrongCredentialRejected ||
		!candidateReport.WrongDestinationRejected ||
		!candidateReport.WrongDigestRejected ||
		!candidateReport.WrongProofRejected ||
		!candidateReport.WrongVKRejected ||
		!candidateReport.ProofTruncationRejected ||
		!candidateReport.ProofAppendRejected {
		return errors.New("candidate verification report is not reproduced by independent evidence")
	}
	if err := verifyPublicFinalizationEvidence(dir, candidate, candidateReport); err != nil {
		return err
	}
	if _, _, _, err := loadAndVerifyPublicEvidence(
		filepath.Join(dir, candidate.PublicEvidence.Name),
		replay.definition.CeremonyID,
		vk,
		cardanoVK,
		candidate.CardanoVerifyingKey,
	); err != nil {
		return fmt.Errorf("independent native public-evidence verification: %w", err)
	}
	return nil
}

// SignRelease validates at least two distinct, enrolled, signed passing
// audits, assembles the final setup transcript and key manifest without
// replacing candidate files, then signs the exact manifest with the distinct
// pre-existing release key.
func SignRelease(options SignReleaseOptions) (*SignReleaseResult, error) {
	if options.ReleasedAt.IsZero() || options.ReleasedAt.Location() != time.UTC {
		return nil, errors.New("released_at must be a non-zero UTC time")
	}
	var definition CeremonyDefinition
	coordinatorPublicKey, err := keybundle.DecodePublicKeyHex(options.CoordinatorPublicKeyHex)
	if err != nil {
		return nil, fmt.Errorf("trusted coordinator public key: %w", err)
	}
	definitionRef, err := readTrustedDefinition(
		options.DefinitionPath,
		options.DefinitionSignaturePath,
		coordinatorPublicKey,
		&definition,
	)
	if err != nil {
		return nil, err
	}
	if err := requireIdentityKey(definition.Coordinator, coordinatorPublicKey); err != nil {
		return nil, err
	}
	if err := VerifyRunningSoftwareForMode(definition.Software, definition.Mode); err != nil {
		return nil, fmt.Errorf("running release-signing software: %w", err)
	}
	candidate, _, err := verifyCandidate(definition, definitionRef, options.CandidateDir)
	if err != nil {
		return nil, err
	}
	if options.SignatureKeyID != definition.ReleaseSigner.KeyID {
		return nil, fmt.Errorf(
			"release signature key id %q, want signed definition key id %q",
			options.SignatureKeyID,
			definition.ReleaseSigner.KeyID,
		)
	}
	privateKey, publicKey, err := keybundle.LoadExistingPrivateKey(options.ReleaseSigningKey)
	if err != nil {
		return nil, err
	}
	if err := requireIdentityKey(definition.ReleaseSigner, publicKey); err != nil {
		return nil, fmt.Errorf("release signing key: %w", err)
	}
	_, latestAudit, err := verifyPassingAudits(definition, candidate, options.Audits)
	if err != nil {
		return nil, err
	}
	if err := validateReleaseChronology(options.ReleasedAt, latestAudit); err != nil {
		return nil, err
	}
	operationalEvidence, err := verifyReleaseOperationalEvidence(
		definition,
		coordinatorPublicKey,
		candidate,
		options.OperationalEvidenceRoot,
		options.OperationalBundlePath,
		options.OperationalSignaturePath,
		options.ReleasedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("verify required operational evidence: %w", err)
	}
	if filepath.Clean(options.ReleaseDir) == filepath.Clean(options.CandidateDir) {
		return nil, errors.New("release directory must be distinct from candidate directory")
	}
	stagingDir, err := createRecoveryStagingDir(options.ReleaseDir)
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(stagingDir)
		}
	}()
	for _, name := range append(candidateChecksumNames(), CandidateChecksumsFile) {
		if err := copyRegularNoReplace(
			filepath.Join(options.CandidateDir, name),
			filepath.Join(stagingDir, name),
		); err != nil {
			return nil, err
		}
	}
	bundledAudits, err := bundleAuditArtifacts(options.Audits, stagingDir)
	if err != nil {
		return nil, err
	}
	auditRefs, _, err := verifyPassingAudits(definition, candidate, bundledAudits)
	if err != nil {
		return nil, fmt.Errorf("verify bundled audits: %w", err)
	}
	reservedReleaseNames := append(
		releaseChecksumNames(len(bundledAudits), nil),
		ReleaseChecksumsFile,
	)
	if err := copyOperationalEvidence(
		options.OperationalEvidenceRoot,
		stagingDir,
		operationalEvidence,
		reservedReleaseNames,
	); err != nil {
		return nil, fmt.Errorf("bundle operational evidence: %w", err)
	}
	bundledOperationalEvidence, err := verifyReleaseOperationalEvidence(
		definition,
		coordinatorPublicKey,
		candidate,
		stagingDir,
		filepath.Join(stagingDir, filepath.FromSlash(OperationalEvidenceBundleFile)),
		filepath.Join(stagingDir, filepath.FromSlash(OperationalEvidenceSignatureFile)),
		options.ReleasedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("verify bundled operational evidence: %w", err)
	}
	if !reflect.DeepEqual(bundledOperationalEvidence, operationalEvidence) {
		return nil, errors.New("bundled operational evidence differs from verified release input")
	}
	transcript, err := NewFinalTranscript(FinalTranscript{
		Schema:              FinalTranscriptSchema,
		CeremonyID:          definition.CeremonyID,
		Definition:          definitionRef,
		Circuit:             definition.Circuit,
		Phase1:              candidate.Phase1,
		Phase2:              candidate.Phase2,
		Audits:              auditRefs,
		OperationalEvidence: operationalEvidence.BundleRef,
		ProvingKey:          candidate.ProvingKey,
		VerifyingKey:        candidate.VerifyingKey,
		CardanoVerifyingKey: candidate.CardanoVerifyingKey,
		FinalizedAt:         options.ReleasedAt.Format(time.RFC3339Nano),
	})
	if err != nil {
		return nil, err
	}
	transcriptBytes, err := MarshalCanonical(transcript)
	if err != nil {
		return nil, err
	}
	transcriptPath := filepath.Join(stagingDir, FinalTranscriptFile)
	if err := writeBytesNoReplace(transcriptPath, transcriptBytes, 0o600); err != nil {
		return nil, err
	}
	manifest := artifact.KeyManifest{
		Schema:               artifact.ManifestSchema,
		KeyVersion:           definition.Circuit.KeyVersion,
		CircuitID:            definition.Circuit.CircuitID,
		Curve:                definition.Circuit.Curve,
		Backend:              definition.Circuit.Backend,
		VKHash:               candidate.VerifyingKey.Digest.Blake2b256,
		ProvingKeySHA256:     candidate.ProvingKey.Digest.SHA256,
		ProvingKeyBlake2b256: candidate.ProvingKey.Digest.Blake2b256,
		ProvingKeySize:       candidate.ProvingKey.Digest.Size,
		VerifyingKeySHA256:   candidate.VerifyingKey.Digest.SHA256,
		VerifyingKeySize:     candidate.VerifyingKey.Digest.Size,
		ConstraintSystemHash: candidate.ConstraintSystem.Digest.Blake2b256,
		CircuitSourceCommit:  definition.Software.SourceCommit,
		ProofToolVersion:     definition.Software.ProofToolVersion,
		GnarkVersion:         definition.Software.GnarkVersion,
		SetupTranscriptHash:  NewDigest(transcriptBytes).Blake2b256,
		PublishedAt:          options.ReleasedAt.Format(time.RFC3339Nano),
		SignatureKeyID:       definition.ReleaseSigner.KeyID,
	}
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, err
	}
	manifestBytes = append(manifestBytes, '\n')
	manifestPath := filepath.Join(stagingDir, keybundle.ManifestFile)
	if err := writeBytesNoReplace(manifestPath, manifestBytes, 0o600); err != nil {
		return nil, err
	}
	signaturePath := filepath.Join(stagingDir, keybundle.ManifestSignatureFile)
	signatureHex := hex.EncodeToString(ed25519.Sign(privateKey, manifestBytes)) + "\n"
	if err := writeBytesNoReplace(signaturePath, []byte(signatureHex), 0o600); err != nil {
		return nil, err
	}
	publicKeyPath := filepath.Join(stagingDir, keybundle.ManifestPublicKeyFile)
	if err := writeBytesNoReplace(publicKeyPath, []byte(hex.EncodeToString(publicKey)+"\n"), 0o600); err != nil {
		return nil, err
	}
	checksumsPath := filepath.Join(stagingDir, ReleaseChecksumsFile)
	if err := writeChecksumsNoReplace(
		stagingDir,
		checksumsPath,
		releaseChecksumNames(len(bundledAudits), operationalEvidence.Names),
	); err != nil {
		return nil, err
	}
	if _, err := VerifyRelease(VerifyReleaseOptions{
		DefinitionPath:          options.DefinitionPath,
		DefinitionSignaturePath: options.DefinitionSignaturePath,
		CoordinatorPublicKeyHex: options.CoordinatorPublicKeyHex,
		KeysDir:                 stagingDir,
		TrustedPublicKeyHex:     hex.EncodeToString(publicKey),
		ExpectedSignatureKeyID:  options.SignatureKeyID,
		RequireProvingKey:       true,
	}); err != nil {
		return nil, fmt.Errorf("strict release self-verification: %w", err)
	}
	if err := syncDirectory(stagingDir); err != nil {
		return nil, err
	}
	if err := publishReleaseDirectory(stagingDir, options.ReleaseDir); err != nil {
		return nil, fmt.Errorf("atomically publish fresh release directory: %w", err)
	}
	committed = true
	return &SignReleaseResult{
		ManifestPath:      filepath.Join(options.ReleaseDir, keybundle.ManifestFile),
		ManifestSignature: filepath.Join(options.ReleaseDir, keybundle.ManifestSignatureFile),
		ManifestPublicKey: filepath.Join(options.ReleaseDir, keybundle.ManifestPublicKeyFile),
		FinalTranscript:   filepath.Join(options.ReleaseDir, FinalTranscriptFile),
		OperationalEvidence: filepath.Join(
			options.ReleaseDir,
			filepath.FromSlash(OperationalEvidenceBundleFile),
		),
		ChecksumsPath: filepath.Join(options.ReleaseDir, ReleaseChecksumsFile),
	}, nil
}

// VerifyRelease authenticates the manifest using only the caller-supplied
// trust key and rechecks the final transcript, independent audits, frozen
// circuit, native keys, Cardano export, candidate signature, and checksums.
func VerifyRelease(options VerifyReleaseOptions) (*VerifyReleaseResult, error) {
	if strings.TrimSpace(options.TrustedPublicKeyHex) == "" {
		return nil, errors.New("out-of-band trusted release public key is required")
	}
	if !options.RequireProvingKey {
		return nil, errors.New("production release verification requires the native proving key")
	}
	var definition CeremonyDefinition
	coordinatorPublicKey, err := keybundle.DecodePublicKeyHex(options.CoordinatorPublicKeyHex)
	if err != nil {
		return nil, fmt.Errorf("trusted coordinator public key: %w", err)
	}
	definitionRef, err := readTrustedDefinition(
		options.DefinitionPath,
		options.DefinitionSignaturePath,
		coordinatorPublicKey,
		&definition,
	)
	if err != nil {
		return nil, err
	}
	if err := requireIdentityKey(definition.Coordinator, coordinatorPublicKey); err != nil {
		return nil, err
	}
	if options.ExpectedSignatureKeyID != definition.ReleaseSigner.KeyID {
		return nil, errors.New("expected release signature key id does not match ceremony definition")
	}
	trustedKey, err := keybundle.DecodePublicKeyHex(options.TrustedPublicKeyHex)
	if err != nil {
		return nil, err
	}
	if err := requireIdentityKey(definition.ReleaseSigner, trustedKey); err != nil {
		return nil, fmt.Errorf("trusted release public key: %w", err)
	}
	manifest, err := keybundle.Verify(keybundle.VerifyOptions{
		KeysDir:                options.KeysDir,
		KeyVersion:             definition.Circuit.KeyVersion,
		PublicKeyHex:           options.TrustedPublicKeyHex,
		ExpectedSignatureKeyID: options.ExpectedSignatureKeyID,
		RequireProvingKey:      options.RequireProvingKey,
	})
	if err != nil {
		return nil, err
	}
	bundledPublicKey, err := readRegularFile(filepath.Join(options.KeysDir, keybundle.ManifestPublicKeyFile))
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(string(bundledPublicKey)) != strings.ToLower(strings.TrimSpace(options.TrustedPublicKeyHex)) {
		return nil, errors.New("bundled release public key differs from out-of-band trust key")
	}
	candidate, _, err := verifyCandidate(definition, definitionRef, options.KeysDir)
	if err != nil {
		return nil, err
	}
	var transcript FinalTranscript
	transcriptRef, err := readCanonicalFile(filepath.Join(options.KeysDir, FinalTranscriptFile), &transcript)
	if err != nil {
		return nil, err
	}
	bundledAudits, err := bundledAuditsForTranscript(options.KeysDir, transcript.Audits)
	if err != nil {
		return nil, err
	}
	auditRefs, latestAudit, err := verifyPassingAudits(definition, candidate, bundledAudits)
	if err != nil {
		return nil, err
	}
	transcriptTime, _ := time.Parse(time.RFC3339Nano, transcript.FinalizedAt)
	if err := validateReleaseChronology(transcriptTime, latestAudit); err != nil {
		return nil, fmt.Errorf("final transcript: %w", err)
	}
	operationalEvidence, err := verifyReleaseOperationalEvidence(
		definition,
		coordinatorPublicKey,
		candidate,
		options.KeysDir,
		filepath.Join(options.KeysDir, filepath.FromSlash(OperationalEvidenceBundleFile)),
		filepath.Join(options.KeysDir, filepath.FromSlash(OperationalEvidenceSignatureFile)),
		transcriptTime,
	)
	if err != nil {
		return nil, fmt.Errorf("required operational evidence: %w", err)
	}
	if transcript.CeremonyID != definition.CeremonyID ||
		transcript.Definition != definitionRef ||
		!equalCircuitBinding(transcript.Circuit, definition.Circuit) ||
		!reflect.DeepEqual(transcript.Phase1, candidate.Phase1) ||
		!reflect.DeepEqual(transcript.Phase2, candidate.Phase2) ||
		transcript.ProvingKey != candidate.ProvingKey ||
		transcript.VerifyingKey != candidate.VerifyingKey ||
		transcript.CardanoVerifyingKey != candidate.CardanoVerifyingKey ||
		transcript.OperationalEvidence != operationalEvidence.BundleRef ||
		!slices.Equal(transcript.Audits, auditRefs) {
		return nil, errors.New(
			"final transcript does not exactly bind candidate, definition, audits, and operational evidence",
		)
	}
	if manifest.SetupTranscriptHash != transcriptRef.Digest.Blake2b256 {
		return nil, errors.New("manifest setup_transcript_hash does not match final transcript")
	}
	if manifest.PublishedAt != transcript.FinalizedAt {
		return nil, errors.New("manifest published_at does not match final transcript release time")
	}
	if manifest.KeyVersion != definition.Circuit.KeyVersion ||
		manifest.CircuitID != definition.Circuit.CircuitID ||
		manifest.Curve != definition.Circuit.Curve ||
		manifest.Backend != definition.Circuit.Backend ||
		manifest.CircuitSourceCommit != definition.Software.SourceCommit ||
		manifest.ProofToolVersion != definition.Software.ProofToolVersion ||
		manifest.GnarkVersion != definition.Software.GnarkVersion ||
		manifest.ConstraintSystemHash != candidate.ConstraintSystem.Digest.Blake2b256 ||
		manifest.VKHash != candidate.VerifyingKey.Digest.Blake2b256 ||
		manifest.ProvingKeySHA256 != candidate.ProvingKey.Digest.SHA256 ||
		manifest.ProvingKeyBlake2b256 != candidate.ProvingKey.Digest.Blake2b256 ||
		manifest.ProvingKeySize != candidate.ProvingKey.Digest.Size ||
		manifest.VerifyingKeySHA256 != candidate.VerifyingKey.Digest.SHA256 ||
		manifest.VerifyingKeySize != candidate.VerifyingKey.Digest.Size ||
		len(manifest.ArtifactURLs) != 0 {
		return nil, errors.New("manifest does not exactly bind candidate key artifacts and signed provenance")
	}
	if _, err := ReadR1CSFile(filepath.Join(options.KeysDir, candidate.ConstraintSystem.Name), definition.Circuit); err != nil {
		return nil, err
	}
	vk, err := prover.LoadVK(filepath.Join(options.KeysDir, NativeVerifyingKeyFile))
	if err != nil {
		return nil, err
	}
	if err := verifyCardanoFiles(options.KeysDir, candidate, vk); err != nil {
		return nil, err
	}
	if err := verifyChecksumsExact(
		options.KeysDir,
		filepath.Join(options.KeysDir, CandidateChecksumsFile),
		candidateChecksumNames(),
	); err != nil {
		return nil, err
	}
	if err := verifyChecksumsExact(
		options.KeysDir,
		filepath.Join(options.KeysDir, ReleaseChecksumsFile),
		releaseChecksumNames(len(bundledAudits), operationalEvidence.Names),
	); err != nil {
		return nil, err
	}
	if err := verifyReleaseTreeExact(
		options.KeysDir,
		len(bundledAudits),
		operationalEvidence.Names,
	); err != nil {
		return nil, err
	}
	return &VerifyReleaseResult{Manifest: manifest, Transcript: transcript, Candidate: candidate}, nil
}

func verifyCandidate(
	definition CeremonyDefinition,
	definitionRef ArtifactRef,
	dir string,
) (CandidateMetadata, ArtifactRef, error) {
	candidateBytes, err := readRegularFile(filepath.Join(dir, CandidateMetadataFile))
	if err != nil {
		return CandidateMetadata{}, ArtifactRef{}, err
	}
	signatureBytes, err := readRegularFile(filepath.Join(dir, CandidateSignatureFile))
	if err != nil {
		return CandidateMetadata{}, ArtifactRef{}, err
	}
	publicKey, err := keybundle.DecodePublicKeyHex(definition.Coordinator.Ed25519PublicKeyHex)
	if err != nil {
		return CandidateMetadata{}, ArtifactRef{}, err
	}
	var candidate CandidateMetadata
	if err := VerifySignedRecord(
		candidateBytes,
		signatureBytes,
		&candidate,
		definition.Coordinator.KeyID,
		publicKey,
	); err != nil {
		return CandidateMetadata{}, ArtifactRef{}, fmt.Errorf("candidate coordinator signature: %w", err)
	}
	if candidate.CeremonyID != definition.CeremonyID ||
		candidate.Definition != definitionRef ||
		!equalCircuitBinding(candidate.Circuit, definition.Circuit) ||
		candidate.CoordinatorID != definition.Coordinator.ID ||
		candidate.CoordinatorKeyID != definition.Coordinator.KeyID {
		return CandidateMetadata{}, ArtifactRef{}, errors.New("candidate does not exactly bind ceremony definition")
	}
	for _, ref := range candidateFileRefs(candidate) {
		actual, err := artifactRefForFile(ref.Name, filepath.Join(dir, ref.Name))
		if err != nil {
			return CandidateMetadata{}, ArtifactRef{}, err
		}
		if actual != ref {
			return CandidateMetadata{}, ArtifactRef{}, fmt.Errorf("candidate artifact %q digest mismatch", ref.Name)
		}
	}
	if err := verifyChecksumsExact(
		dir,
		filepath.Join(dir, CandidateChecksumsFile),
		candidateChecksumNames(),
	); err != nil {
		return CandidateMetadata{}, ArtifactRef{}, err
	}
	var report VerificationReport
	if _, err := readCanonicalFile(filepath.Join(dir, candidate.VerificationReport.Name), &report); err != nil {
		return CandidateMetadata{}, ArtifactRef{}, err
	}
	if err := verifyPublicFinalizationEvidence(dir, candidate, report); err != nil {
		return CandidateMetadata{}, ArtifactRef{}, err
	}
	if _, err := loadCandidatePhase2Seal(definition, candidate, dir); err != nil {
		return CandidateMetadata{}, ArtifactRef{}, err
	}
	ref := ArtifactRef{Name: CandidateMetadataFile, Digest: NewDigest(candidateBytes)}
	return candidate, ref, nil
}

func candidateFileRefs(candidate CandidateMetadata) []ArtifactRef {
	return []ArtifactRef{
		candidate.ConstraintSystem,
		candidate.ProvingKey,
		candidate.VerifyingKey,
		candidate.CardanoVerifyingKey,
		candidate.CardanoVKHex,
		candidate.CardanoVKFormat,
		candidate.VerificationReport,
		candidate.PublicEvidence,
		candidate.Phase2SealRecord,
	}
}

func candidateAuditOutputs(candidate CandidateMetadata, candidateRef ArtifactRef) []ArtifactRef {
	return []ArtifactRef{
		candidateRef,
		candidate.ConstraintSystem,
		candidate.ProvingKey,
		candidate.VerifyingKey,
		candidate.CardanoVerifyingKey,
		candidate.CardanoVKHex,
		candidate.CardanoVKFormat,
		candidate.VerificationReport,
		candidate.PublicEvidence,
		candidate.Phase2SealRecord,
	}
}

func verifyPublicFinalizationEvidence(
	dir string,
	candidate CandidateMetadata,
	report VerificationReport,
) error {
	if report.CeremonyID != candidate.CeremonyID {
		return errors.New("verification report ceremony id differs from candidate")
	}
	if report.PublicEvidence != candidate.PublicEvidence {
		return errors.New("verification report does not hash-bind candidate public evidence")
	}
	if report.CardanoVKRawDigest != candidate.CardanoVerifyingKey.Digest {
		return errors.New("verification report Cardano key digest differs from candidate")
	}
	var evidence PublicFinalizationEvidence
	ref, err := readCanonicalFile(filepath.Join(dir, candidate.PublicEvidence.Name), &evidence)
	if err != nil {
		return err
	}
	ref.Name = candidate.PublicEvidence.Name
	if ref != candidate.PublicEvidence {
		return errors.New("public finalization evidence artifact digest mismatch")
	}
	if evidence.CeremonyID != candidate.CeremonyID ||
		evidence.CardanoVerifyingKey != candidate.CardanoVerifyingKey {
		return errors.New("public finalization evidence does not bind candidate ceremony and Cardano key")
	}
	if evidence.CardanoProofRawDigest != report.CardanoProofRawDigest {
		return errors.New("verification report proof digest differs from public finalization evidence")
	}
	return nil
}

func loadCandidatePhase2Seal(
	definition CeremonyDefinition,
	candidate CandidateMetadata,
	dir string,
) (SealRecord, error) {
	recordPath := filepath.Join(dir, candidate.Phase2SealRecord.Name)
	recordBytes, err := readRegularFile(recordPath)
	if err != nil {
		return SealRecord{}, err
	}
	if actual := (ArtifactRef{Name: candidate.Phase2SealRecord.Name, Digest: NewDigest(recordBytes)}); actual != candidate.Phase2SealRecord {
		return SealRecord{}, errors.New("candidate phase2 seal record digest mismatch")
	}
	signatureBytes, err := readRegularFile(filepath.Join(dir, Phase2SealSignatureFile))
	if err != nil {
		return SealRecord{}, err
	}
	publicKey, err := keybundle.DecodePublicKeyHex(definition.Coordinator.Ed25519PublicKeyHex)
	if err != nil {
		return SealRecord{}, err
	}
	var seal SealRecord
	if err := VerifySignedRecord(
		recordBytes,
		signatureBytes,
		&seal,
		definition.Coordinator.KeyID,
		publicKey,
	); err != nil {
		return SealRecord{}, fmt.Errorf("phase2 seal signature: %w", err)
	}
	if seal.CeremonyID != candidate.CeremonyID ||
		seal.Phase != Phase2 ||
		seal.PhaseID != candidate.Phase2.PhaseID ||
		seal.CloseID != candidate.Phase2.CloseID ||
		seal.BeaconID != candidate.Phase2.BeaconID ||
		seal.SealID != candidate.Phase2.SealID ||
		!slices.Equal(seal.Outputs, candidate.Phase2.Outputs) {
		return SealRecord{}, errors.New("phase2 seal does not exactly bind candidate phase summary")
	}
	return seal, nil
}

func verifyCardanoFiles(dir string, candidate CandidateMetadata, vk groth16.VerifyingKey) error {
	raw, format, err := prover.SerializeCardanoVK(vk)
	if err != nil {
		return err
	}
	if format != expectedCardanoBSB22 ||
		len(raw) != prover.CardanoVKCommitmentLen ||
		NewDigest(raw) != candidate.CardanoVerifyingKey.Digest {
		return errors.New("cardano verifying key is not coherent exact BSB22 bytes")
	}
	storedRaw, err := readRegularFile(filepath.Join(dir, candidate.CardanoVerifyingKey.Name))
	if err != nil {
		return err
	}
	if !bytes.Equal(storedRaw, raw) {
		return errors.New("cardano raw verifying-key file differs from native serializer")
	}
	storedHex, err := readRegularFile(filepath.Join(dir, candidate.CardanoVKHex.Name))
	if err != nil {
		return err
	}
	expectedHex := hex.EncodeToString(raw) + "\n"
	if string(storedHex) != expectedHex {
		return errors.New("cardano verifying-key hex is not exact lowercase hex of raw bytes")
	}
	storedFormat, err := readRegularFile(filepath.Join(dir, candidate.CardanoVKFormat.Name))
	if err != nil {
		return err
	}
	if string(storedFormat) != format+"\n" {
		return errors.New("cardano verifying-key format file does not match native serializer")
	}
	return nil
}

func verifyPassingAudits(
	definition CeremonyDefinition,
	candidate CandidateMetadata,
	inputs []AuditArtifact,
) ([]ArtifactRef, time.Time, error) {
	if len(inputs) < 2 {
		return nil, time.Time{}, errors.New("at least two independently signed audit reports are required")
	}
	replayRoot, err := replayRootSHA256(candidate)
	if err != nil {
		return nil, time.Time{}, err
	}
	candidateTime, err := time.Parse(time.RFC3339Nano, candidate.FinalizedAt)
	if err != nil {
		return nil, time.Time{}, err
	}
	seenAuditor := make(map[string]struct{}, len(inputs))
	seenKey := make(map[string]struct{}, len(inputs))
	refs := make([]ArtifactRef, 0, len(inputs))
	var latestAudit time.Time
	candidateBytes, err := MarshalCanonical(candidate)
	if err != nil {
		return nil, time.Time{}, err
	}
	expectedOutputs := candidateAuditOutputs(candidate, ArtifactRef{
		Name:   CandidateMetadataFile,
		Digest: NewDigest(candidateBytes),
	})
	for index, input := range inputs {
		recordBytes, err := readRegularFile(input.RecordPath)
		if err != nil {
			return nil, time.Time{}, fmt.Errorf("audit %d: %w", index, err)
		}
		signatureBytes, err := readRegularFile(input.SignaturePath)
		if err != nil {
			return nil, time.Time{}, fmt.Errorf("audit %d signature: %w", index, err)
		}
		var unsigned AuditRecord
		if err := UnmarshalCanonical(recordBytes, &unsigned); err != nil {
			return nil, time.Time{}, fmt.Errorf("audit %d: %w", index, err)
		}
		auditor, ok := auditorByID(definition, unsigned.AuditorID)
		if !ok || auditor.KeyID != unsigned.AuditorKeyID {
			return nil, time.Time{}, fmt.Errorf("audit %d signer is not enrolled", index)
		}
		publicKey, err := keybundle.DecodePublicKeyHex(auditor.Ed25519PublicKeyHex)
		if err != nil {
			return nil, time.Time{}, err
		}
		var record AuditRecord
		if err := VerifySignedRecord(recordBytes, signatureBytes, &record, auditor.KeyID, publicKey); err != nil {
			return nil, time.Time{}, fmt.Errorf("audit %d signature: %w", index, err)
		}
		if !record.Passed || len(record.Findings) != 0 {
			return nil, time.Time{}, fmt.Errorf("audit %d is not a passing audit", index)
		}
		if record.CeremonyID != definition.CeremonyID ||
			record.Definition != candidate.Definition ||
			record.Phase1Chain != candidate.Phase1.Chain ||
			record.Phase2Chain != candidate.Phase2.Chain ||
			record.Phase1SealID != candidate.Phase1.SealID ||
			record.Phase2SealID != candidate.Phase2.SealID ||
			record.ReplayRootSHA256 != replayRoot {
			return nil, time.Time{}, fmt.Errorf("audit %d does not bind this exact candidate replay", index)
		}
		if !slices.Equal(record.Outputs, expectedOutputs) {
			return nil, time.Time{}, fmt.Errorf("audit %d outputs are not the exact candidate output set", index)
		}
		auditedAt, _ := time.Parse(time.RFC3339Nano, record.AuditedAt)
		if !auditedAt.After(candidateTime) {
			return nil, time.Time{}, fmt.Errorf("audit %d does not strictly postdate candidate finalization", index)
		}
		if auditedAt.After(latestAudit) {
			latestAudit = auditedAt
		}
		if _, duplicate := seenAuditor[record.AuditorID]; duplicate {
			return nil, time.Time{}, fmt.Errorf("auditor %q appears more than once", record.AuditorID)
		}
		if _, duplicate := seenKey[record.AuditorKeyID]; duplicate {
			return nil, time.Time{}, fmt.Errorf("auditor key %q appears more than once", record.AuditorKeyID)
		}
		seenAuditor[record.AuditorID] = struct{}{}
		seenKey[record.AuditorKeyID] = struct{}{}
		name := input.LogicalName
		if name == "" {
			name = filepath.Base(input.RecordPath)
		}
		ref := ArtifactRef{Name: name, Digest: NewDigest(recordBytes)}
		if err := ref.Validate(); err != nil {
			return nil, time.Time{}, err
		}
		refs = append(refs, ref)
	}
	return refs, latestAudit, nil
}

func validateReleaseChronology(releasedAt, latestAudit time.Time) error {
	if !releasedAt.After(latestAudit) {
		return errors.New("released_at must strictly postdate every accepted independent audit")
	}
	return nil
}

func auditorByID(definition CeremonyDefinition, id string) (Identity, bool) {
	for _, auditor := range definition.Auditors {
		if auditor.ID == id {
			return auditor, true
		}
	}
	return Identity{}, false
}

func replayRootSHA256(candidate CandidateMetadata) (string, error) {
	value := struct {
		CandidateID  string      `json:"candidate_id"`
		Phase1SealID string      `json:"phase1_seal_id"`
		Phase2SealID string      `json:"phase2_seal_id"`
		ProvingKey   ArtifactRef `json:"proving_key"`
		VerifyingKey ArtifactRef `json:"verifying_key"`
		CardanoVK    ArtifactRef `json:"cardano_vk"`
	}{
		candidate.CandidateID,
		candidate.Phase1.SealID,
		candidate.Phase2.SealID,
		candidate.ProvingKey,
		candidate.VerifyingKey,
		candidate.CardanoVerifyingKey,
	}
	return canonicalHash("proof-tool/mpc-ceremony/full-replay/v1", value)
}

func rawProvingKeyDigest(pk groth16.ProvingKey) (Digest, error) {
	raw, ok := pk.(interface {
		WriteRawTo(io.Writer) (int64, error)
	})
	if !ok {
		return Digest{}, fmt.Errorf("proving key type %T does not support native raw serialization", pk)
	}
	return streamingDigest(raw.WriteRawTo)
}

func streamingDigest(write func(io.Writer) (int64, error)) (Digest, error) {
	sha := sha256.New()
	blake, err := blake2b.New256(nil)
	if err != nil {
		return Digest{}, err
	}
	n, err := write(io.MultiWriter(sha, blake))
	if err != nil {
		return Digest{}, err
	}
	digest := Digest{
		SHA256:     "sha256:" + hex.EncodeToString(sha.Sum(nil)),
		Blake2b256: "blake2b256:" + hex.EncodeToString(blake.Sum(nil)),
		Size:       n,
	}
	return digest, digest.Validate()
}

func verifyChecksumsExact(dir, checksumPath string, expectedNames []string) error {
	data, err := readRegularFile(checksumPath)
	if err != nil {
		return err
	}
	checksumName, err := logicalPathWithin(dir, checksumPath)
	if err != nil {
		return fmt.Errorf("checksum file path: %w", err)
	}
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	if len(lines) == 0 || (len(lines) == 1 && lines[0] == "") {
		return errors.New("checksum file is empty")
	}
	expected := append([]string(nil), expectedNames...)
	slices.Sort(expected)
	if len(lines) != len(expected) {
		return fmt.Errorf("checksum file has %d entries, want exactly %d", len(lines), len(expected))
	}
	seen := make(map[string]struct{}, len(lines))
	for index, line := range lines {
		if len(line) < 67 || line[64:66] != "  " {
			return errors.New("invalid checksum line")
		}
		hashHex, name := line[:64], line[66:]
		if _, err := hex.DecodeString(hashHex); err != nil {
			return errors.New("invalid checksum hash")
		}
		if err := validateArtifactName(name); err != nil || name == checksumName {
			return errors.New("invalid checksum artifact name")
		}
		if name != expected[index] {
			return fmt.Errorf("checksum entry %d is %q, want %q", index, name, expected[index])
		}
		if _, duplicate := seen[name]; duplicate {
			return fmt.Errorf("duplicate checksum for %q", name)
		}
		seen[name] = struct{}{}
		path, err := resolveArtifactPath(dir, name)
		if err != nil {
			return err
		}
		ref, err := artifactRefForFile(name, path)
		if err != nil {
			return err
		}
		if strings.TrimPrefix(ref.Digest.SHA256, "sha256:") != hashHex {
			return fmt.Errorf("checksum mismatch for %q", name)
		}
	}
	return nil
}

func candidateChecksumNames() []string {
	return []string{
		prover.DestinationConstraintSystemFile,
		NativeProvingKeyFile,
		NativeVerifyingKeyFile,
		CardanoVKBytesFile,
		CardanoVKHexFile,
		CardanoVKFormatFile,
		VerificationReportFile,
		PublicEvidenceFile,
		Phase2SealFile,
		Phase2SealSignatureFile,
		CandidateMetadataFile,
		CandidateSignatureFile,
	}
}

func releaseChecksumNames(auditCount int, operationalNames []string) []string {
	names := append(candidateChecksumNames(),
		CandidateChecksumsFile,
		FinalTranscriptFile,
		keybundle.ManifestFile,
		keybundle.ManifestSignatureFile,
		keybundle.ManifestPublicKeyFile,
	)
	for index := 0; index < auditCount; index++ {
		names = append(
			names,
			fmt.Sprintf("audits/%04d.json", index+1),
			fmt.Sprintf("audits/%04d.sig", index+1),
		)
	}
	names = append(names, operationalNames...)
	return names
}

type verifiedReleaseOperationalEvidence struct {
	Verified  VerifiedOperationalEvidence
	BundleRef SignedArtifactRefs
	Names     []string
}

func verifyReleaseOperationalEvidence(
	definition CeremonyDefinition,
	coordinatorPublicKey ed25519.PublicKey,
	candidate CandidateMetadata,
	root, bundlePath, signaturePath string,
	releasedAt time.Time,
) (verifiedReleaseOperationalEvidence, error) {
	if strings.TrimSpace(root) == "" {
		return verifiedReleaseOperationalEvidence{}, errors.New("operational evidence root is required")
	}
	bundleName, err := logicalPathWithin(root, bundlePath)
	if err != nil {
		return verifiedReleaseOperationalEvidence{}, fmt.Errorf("operational evidence bundle path: %w", err)
	}
	if bundleName != OperationalEvidenceBundleFile {
		return verifiedReleaseOperationalEvidence{}, fmt.Errorf(
			"operational evidence bundle name %q, want %q",
			bundleName,
			OperationalEvidenceBundleFile,
		)
	}
	signatureName, err := logicalPathWithin(root, signaturePath)
	if err != nil {
		return verifiedReleaseOperationalEvidence{}, fmt.Errorf("operational evidence signature path: %w", err)
	}
	if signatureName != OperationalEvidenceSignatureFile {
		return verifiedReleaseOperationalEvidence{}, fmt.Errorf(
			"operational evidence signature name %q, want %q",
			signatureName,
			OperationalEvidenceSignatureFile,
		)
	}
	bundleBytes, err := readRegularBounded(bundlePath, maxSignedRecordBytes)
	if err != nil {
		return verifiedReleaseOperationalEvidence{}, err
	}
	signatureBytes, err := readRegularBounded(signaturePath, maxSignedRecordBytes)
	if err != nil {
		return verifiedReleaseOperationalEvidence{}, err
	}
	var bundle OperationalEvidenceBundle
	if err := UnmarshalCanonical(bundleBytes, &bundle); err != nil {
		return verifiedReleaseOperationalEvidence{}, fmt.Errorf("operational evidence bundle: %w", err)
	}
	phase1Close, err := LoadAuthenticatedCloseEvidence(root, bundle.Phase1.Close)
	if err != nil {
		return verifiedReleaseOperationalEvidence{}, fmt.Errorf("phase1 close evidence: %w", err)
	}
	phase2Close, err := LoadAuthenticatedCloseEvidence(root, bundle.Phase2.Close)
	if err != nil {
		return verifiedReleaseOperationalEvidence{}, fmt.Errorf("phase2 close evidence: %w", err)
	}
	verified, err := VerifyOperationalEvidenceBundle(VerifyOperationalEvidenceOptions{
		Definition:           definition,
		CoordinatorPublicKey: coordinatorPublicKey,
		EvidenceRoot:         root,
		BundleBytes:          bundleBytes,
		BundleSignatureBytes: signatureBytes,
		Phase1Close:          phase1Close,
		Phase2Close:          phase2Close,
	})
	if err != nil {
		return verifiedReleaseOperationalEvidence{}, err
	}
	if phase1Close.Record.CloseID != candidate.Phase1.CloseID ||
		phase2Close.Record.CloseID != candidate.Phase2.CloseID {
		return verifiedReleaseOperationalEvidence{}, errors.New(
			"operational evidence closes do not match finalized candidate phase summaries",
		)
	}
	if err := releaseChainMatchesCandidate(
		root,
		verified.Bundle.Phase1.AcceptedChain.Record,
		candidate.Phase1,
	); err != nil {
		return verifiedReleaseOperationalEvidence{}, fmt.Errorf(
			"operational phase1 chain does not match finalized candidate: %w",
			err,
		)
	}
	if err := releaseChainMatchesCandidate(
		root,
		verified.Bundle.Phase2.AcceptedChain.Record,
		candidate.Phase2,
	); err != nil {
		return verifiedReleaseOperationalEvidence{}, fmt.Errorf(
			"operational phase2 chain does not match finalized candidate: %w",
			err,
		)
	}
	assembledAt, _ := time.Parse(time.RFC3339Nano, verified.Bundle.AssembledAt)
	if !releasedAt.After(assembledAt) {
		return verifiedReleaseOperationalEvidence{}, errors.New(
			"release time must strictly postdate operational evidence assembly",
		)
	}
	bundleRef := SignedArtifactRefs{
		Record: ArtifactRef{
			Name:   OperationalEvidenceBundleFile,
			Digest: verified.BundleDigest,
		},
		Signature: ArtifactRef{
			Name:   OperationalEvidenceSignatureFile,
			Digest: verified.BundleSignature,
		},
	}
	names := make([]string, 0, len(verified.ReferencedArtifacts)+2)
	names = append(names, bundleRef.Record.Name, bundleRef.Signature.Name)
	for _, ref := range verified.ReferencedArtifacts {
		names = append(names, ref.Name)
	}
	slices.Sort(names)
	for index := 1; index < len(names); index++ {
		if names[index-1] == names[index] {
			return verifiedReleaseOperationalEvidence{}, fmt.Errorf(
				"operational release artifact name %q is reused",
				names[index],
			)
		}
	}
	return verifiedReleaseOperationalEvidence{
		Verified:  verified,
		BundleRef: bundleRef,
		Names:     names,
	}, nil
}

func releaseChainMatchesCandidate(
	root string,
	operational ArtifactRef,
	candidate PhaseSummary,
) error {
	if operational.Digest != candidate.Chain.Digest {
		return errors.New("accepted-chain digest differs")
	}
	raw, err := verifyArtifactBytes(root, operational, maxSignedRecordBytes)
	if err != nil {
		return err
	}
	var chain Chain
	if err := UnmarshalCanonical(raw, &chain); err != nil {
		return err
	}
	head, err := chain.HeadRecordID()
	if err != nil {
		return err
	}
	participants, err := chain.ParticipantIDs()
	if err != nil {
		return err
	}
	if chain.Phase != candidate.Phase ||
		chain.PhaseID != candidate.PhaseID ||
		chain.Genesis != candidate.Genesis ||
		head != candidate.ChainHeadID ||
		len(chain.Records) != int(candidate.ContributionCount) ||
		!slices.Equal(participants, candidate.Participants) {
		return errors.New("accepted-chain phase, head, count, or participants differ")
	}
	return nil
}

func copyOperationalEvidence(
	sourceRoot, stagingDir string,
	evidence verifiedReleaseOperationalEvidence,
	reserved []string,
) error {
	reservedNames := make(map[string]struct{}, len(reserved))
	for _, name := range reserved {
		reservedNames[name] = struct{}{}
	}
	refs := make([]ArtifactRef, 0, len(evidence.Verified.ReferencedArtifacts)+2)
	refs = append(refs, evidence.BundleRef.Record, evidence.BundleRef.Signature)
	refs = append(refs, evidence.Verified.ReferencedArtifacts...)
	for _, ref := range refs {
		if _, collision := reservedNames[ref.Name]; collision {
			return fmt.Errorf("operational artifact %q collides with a release artifact", ref.Name)
		}
		if strings.HasPrefix(ref.Name, "audits/") {
			return fmt.Errorf("operational artifact %q is reserved for audit evidence", ref.Name)
		}
		sourcePath, err := resolveArtifactPath(sourceRoot, ref.Name)
		if err != nil {
			return err
		}
		destinationPath, err := resolveArtifactPath(stagingDir, ref.Name)
		if err != nil {
			return err
		}
		if err := mkdirAllPrivateDurable(filepath.Dir(destinationPath)); err != nil {
			return err
		}
		if err := copyRegularNoReplace(sourcePath, destinationPath); err != nil {
			return err
		}
		copied, err := artifactRefForFile(ref.Name, destinationPath)
		if err != nil {
			return err
		}
		if copied != ref {
			return fmt.Errorf("copied operational artifact %q digest mismatch", ref.Name)
		}
	}
	return nil
}

func bundleAuditArtifacts(inputs []AuditArtifact, stagingDir string) ([]AuditArtifact, error) {
	auditDir := filepath.Join(stagingDir, "audits")
	if err := os.Mkdir(auditDir, 0o700); err != nil {
		return nil, err
	}
	result := make([]AuditArtifact, len(inputs))
	for index, input := range inputs {
		logicalRecord := fmt.Sprintf("audits/%04d.json", index+1)
		logicalSignature := fmt.Sprintf("audits/%04d.sig", index+1)
		recordPath := filepath.Join(stagingDir, filepath.FromSlash(logicalRecord))
		signaturePath := filepath.Join(stagingDir, filepath.FromSlash(logicalSignature))
		if err := copyRegularNoReplace(input.RecordPath, recordPath); err != nil {
			return nil, err
		}
		if err := copyRegularNoReplace(input.SignaturePath, signaturePath); err != nil {
			return nil, err
		}
		result[index] = AuditArtifact{
			RecordPath:    recordPath,
			SignaturePath: signaturePath,
			LogicalName:   logicalRecord,
		}
	}
	return result, nil
}

func bundledAuditsForTranscript(keysDir string, refs []ArtifactRef) ([]AuditArtifact, error) {
	result := make([]AuditArtifact, len(refs))
	for index, ref := range refs {
		expected := fmt.Sprintf("audits/%04d.json", index+1)
		if ref.Name != expected {
			return nil, fmt.Errorf("transcript audit %d name %q, want %q", index, ref.Name, expected)
		}
		recordPath, err := resolveArtifactPath(keysDir, ref.Name)
		if err != nil {
			return nil, err
		}
		signatureName := fmt.Sprintf("audits/%04d.sig", index+1)
		signaturePath, err := resolveArtifactPath(keysDir, signatureName)
		if err != nil {
			return nil, err
		}
		actual, err := artifactRefForFile(ref.Name, recordPath)
		if err != nil {
			return nil, err
		}
		if actual != ref {
			return nil, fmt.Errorf("bundled audit %d digest mismatch", index)
		}
		result[index] = AuditArtifact{
			RecordPath:    recordPath,
			SignaturePath: signaturePath,
			LogicalName:   ref.Name,
		}
	}
	return result, nil
}

func createReleaseStagingDir(releaseDir, candidateDir string) (string, error) {
	if filepath.Clean(releaseDir) == filepath.Clean(candidateDir) {
		return "", errors.New("release directory must be distinct from candidate directory")
	}
	return createFreshStagingDir(releaseDir)
}

func createFreshStagingDir(destination string) (string, error) {
	if strings.TrimSpace(destination) == "" {
		return "", errors.New("fresh destination directory is required")
	}
	if _, err := os.Lstat(destination); err == nil {
		return "", fmt.Errorf("destination directory %q already exists: %w", destination, fs.ErrExist)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	parent := filepath.Dir(destination)
	info, err := os.Lstat(parent)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("destination directory parent is not a real directory")
	}
	staging, err := os.MkdirTemp(parent, "."+filepath.Base(destination)+".partial-*")
	if err != nil {
		return "", err
	}
	if err := os.Chmod(staging, 0o700); err != nil {
		_ = os.RemoveAll(staging)
		return "", err
	}
	return staging, nil
}

func copyRegularNoReplace(source, destination string) (err error) {
	destinationDir := filepath.Dir(destination)
	sourceInfo, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !sourceInfo.Mode().IsRegular() || sourceInfo.Size() <= 0 || sourceInfo.Size() > MaxArtifactSize {
		return fmt.Errorf("release source %q is not a bounded regular file", source)
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	openInfo, err := input.Stat()
	if err != nil {
		return err
	}
	if !openInfo.Mode().IsRegular() ||
		!os.SameFile(sourceInfo, openInfo) ||
		openInfo.Size() != sourceInfo.Size() {
		return fmt.Errorf("release source %q changed while being opened", source)
	}
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	remove := true
	defer func() {
		_ = output.Close()
		if remove {
			_ = os.Remove(destination)
			_ = syncDirectory(destinationDir)
		}
	}()
	n, err := io.CopyN(output, input, sourceInfo.Size())
	if err != nil {
		return err
	}
	if n != sourceInfo.Size() {
		return fmt.Errorf("release source %q changed size while copying", source)
	}
	var extra [1]byte
	if n, err := input.Read(extra[:]); n != 0 || (err != nil && !errors.Is(err, io.EOF)) {
		return fmt.Errorf("release source %q grew while copying", source)
	}
	finalInfo, err := input.Stat()
	if err != nil {
		return err
	}
	if !finalInfo.Mode().IsRegular() ||
		!os.SameFile(sourceInfo, finalInfo) ||
		finalInfo.Size() != sourceInfo.Size() {
		return fmt.Errorf("release source %q changed while being copied", source)
	}
	if err := output.Sync(); err != nil {
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	if err := syncDirectory(destinationDir); err != nil {
		return err
	}
	remove = false
	return nil
}

func publishReleaseDirectory(stagingDir, releaseDir string) (err error) {
	return publishDirectoryNoReplaceOrExact(stagingDir, releaseDir)
}

func verifyReleaseTreeExact(dir string, auditCount int, operationalNames []string) error {
	expectedFiles := make(map[string]struct{})
	expectedDirectories := map[string]struct{}{".": {}}
	for _, name := range append(
		releaseChecksumNames(auditCount, operationalNames),
		ReleaseChecksumsFile,
	) {
		if err := validateArtifactName(name); err != nil {
			return fmt.Errorf("expected release artifact %q: %w", name, err)
		}
		if _, duplicate := expectedFiles[name]; duplicate {
			return fmt.Errorf("expected release artifact %q is duplicated", name)
		}
		expectedFiles[name] = struct{}{}
		for parent := filepath.ToSlash(filepath.Dir(filepath.FromSlash(name))); parent != "."; parent = filepath.ToSlash(filepath.Dir(filepath.FromSlash(parent))) {
			expectedDirectories[parent] = struct{}{}
		}
	}
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(relative)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("release-tree entry %q is a symbolic link", name)
		}
		if entry.IsDir() {
			if _, ok := expectedDirectories[name]; !ok {
				return fmt.Errorf("unexpected release-tree directory %q", name)
			}
			delete(expectedDirectories, name)
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("release-tree entry %q is not a regular file", name)
		}
		if _, ok := expectedFiles[name]; !ok {
			return fmt.Errorf("unexpected release-tree entry %q", name)
		}
		delete(expectedFiles, name)
		return nil
	})
	if err != nil {
		return err
	}
	if len(expectedFiles) != 0 || len(expectedDirectories) != 0 {
		return errors.New("release tree is missing required files or directories")
	}
	return nil
}
