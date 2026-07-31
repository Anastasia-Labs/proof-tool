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
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	gnarkmpc "github.com/consensys/gnark/backend/groth16/bls12-381/mpcsetup"
	"golang.org/x/crypto/blake2b"

	"proof-tool/internal/keybundle"
)

const (
	maxSignedRecordBytes          = 16 << 20
	verificationSchema            = "proof-tool-mpc-contribution-verification-v2"
	directTransitionVerification  = "direct-transition-from-authenticated-head-v1"
	closePublicationSafetyMargin  = 2 * time.Second
	closeRecordFilename           = "record.json"
	closeSignatureFilename        = "record.sig"
	closePublicationDirectoryName = "closure"
)

// DefaultSignaturePath returns the fixed detached-signature sidecar path used
// by workflow records. It does not search a directory or select a latest file.
func DefaultSignaturePath(recordPath string) string {
	ext := filepath.Ext(recordPath)
	if ext == "" {
		return recordPath + ".sig"
	}
	return strings.TrimSuffix(recordPath, ext) + ".sig"
}

// TrustPaths are all explicit. CoordinatorPublicKeyPath is an out-of-band
// trust anchor; a public-key copy inside the ceremony directory is not enough.
type TrustPaths struct {
	DefinitionPath           string
	DefinitionSignaturePath  string
	CoordinatorPublicKeyPath string
}

// TrustedCeremony is an authenticated ceremony definition coupled to its
// externally supplied coordinator trust anchor.
type TrustedCeremony struct {
	Definition           CeremonyDefinition
	CoordinatorPublicKey ed25519.PublicKey
}

// InitParticipants is the fixed-field, canonical enrollment input accepted by
// the coordinator init command. It contains public signing identities only.
type InitParticipants struct {
	Coordinator   Identity      `json:"coordinator"`
	ReleaseSigner Identity      `json:"release_signer"`
	Auditors      []Identity    `json:"auditors"`
	Roster        []Participant `json:"roster"`
}

func (p InitParticipants) Validate() error {
	if err := p.Coordinator.Validate(); err != nil {
		return fmt.Errorf("coordinator: %w", err)
	}
	if err := p.ReleaseSigner.Validate(); err != nil {
		return fmt.Errorf("release_signer: %w", err)
	}
	if len(p.Auditors) < 2 {
		return errors.New("at least two independent auditors are required")
	}
	if len(p.Roster) == 0 || len(p.Roster) > MaxParticipants {
		return fmt.Errorf("roster must contain between 1 and %d participants", MaxParticipants)
	}

	identityIDs := make(map[string]string, 2+len(p.Auditors)+len(p.Roster))
	keyIDs := make(map[string]string, 2+len(p.Auditors)+len(p.Roster))
	publicKeyFingerprints := make(map[string]string, 2+len(p.Auditors)+len(p.Roster))
	add := func(identity Identity, role string) error {
		if previous, exists := identityIDs[identity.ID]; exists {
			return fmt.Errorf("%s identity %q duplicates %s", role, identity.ID, previous)
		}
		if previous, exists := keyIDs[identity.KeyID]; exists {
			return fmt.Errorf("%s key %q duplicates %s", role, identity.KeyID, previous)
		}
		if previous, exists := publicKeyFingerprints[identity.PublicKeyFingerprint]; exists {
			return fmt.Errorf("%s public key duplicates %s", role, previous)
		}
		identityIDs[identity.ID] = role
		keyIDs[identity.KeyID] = role
		publicKeyFingerprints[identity.PublicKeyFingerprint] = role
		return nil
	}
	if err := add(p.Coordinator, "coordinator"); err != nil {
		return err
	}
	if err := add(p.ReleaseSigner, "release signer"); err != nil {
		return err
	}
	for index, auditor := range p.Auditors {
		if err := auditor.Validate(); err != nil {
			return fmt.Errorf("auditor %d: %w", index, err)
		}
		if err := add(auditor, "auditor"); err != nil {
			return err
		}
	}
	for index, participant := range p.Roster {
		if err := participant.Validate(); err != nil {
			return fmt.Errorf("roster participant %d: %w", index, err)
		}
		if err := add(participant.Identity, "participant"); err != nil {
			return err
		}
	}
	return nil
}

// InitPolicy is the fixed-field, canonical policy input accepted by init.
// Cross-checking policy participant IDs against InitParticipants happens when
// the ceremony definition is assembled and validated.
type InitPolicy struct {
	Phase1Policy PhasePolicy  `json:"phase1_policy"`
	Phase2Policy PhasePolicy  `json:"phase2_policy"`
	BeaconPolicy BeaconPolicy `json:"beacon_policy"`
}

func (p InitPolicy) Validate() error {
	if err := validateUnboundPhasePolicy(p.Phase1Policy); err != nil {
		return fmt.Errorf("phase1_policy: %w", err)
	}
	if err := validateUnboundPhasePolicy(p.Phase2Policy); err != nil {
		return fmt.Errorf("phase2_policy: %w", err)
	}
	if err := p.BeaconPolicy.Validate(); err != nil {
		return fmt.Errorf("beacon_policy: %w", err)
	}
	return nil
}

// LoadInitParticipants reads exact canonical enrollment JSON from a regular
// file. Unknown/duplicate fields, trailing bytes, and non-canonical encodings
// are rejected.
func LoadInitParticipants(path string) (InitParticipants, error) {
	var result InitParticipants
	if err := loadCanonicalInput(path, &result); err != nil {
		return InitParticipants{}, fmt.Errorf("load init participants: %w", err)
	}
	return result, nil
}

// LoadInitPolicy reads exact canonical initialization policy JSON.
func LoadInitPolicy(path string) (InitPolicy, error) {
	var result InitPolicy
	if err := loadCanonicalInput(path, &result); err != nil {
		return InitPolicy{}, fmt.Errorf("load init policy: %w", err)
	}
	return result, nil
}

// LoadContributionEnvironment reads the one canonical contribution preflight
// record used by the protocol model; there is no parallel CLI-only schema.
func LoadContributionEnvironment(path string) (ContributionEnvironment, error) {
	var result ContributionEnvironment
	if err := loadCanonicalInput(path, &result); err != nil {
		return ContributionEnvironment{}, fmt.Errorf("load contribution environment: %w", err)
	}
	return result, nil
}

// LoadSignedDefinition authenticates exact canonical definition bytes before
// they are used to resolve any transcript path or allocation shape.
func LoadSignedDefinition(paths TrustPaths) (*TrustedCeremony, error) {
	if strings.TrimSpace(paths.DefinitionPath) == "" ||
		strings.TrimSpace(paths.DefinitionSignaturePath) == "" ||
		strings.TrimSpace(paths.CoordinatorPublicKeyPath) == "" {
		return nil, errors.New("definition, definition signature, and external coordinator public-key paths are required")
	}
	definitionBytes, err := readRegularBounded(paths.DefinitionPath, maxSignedRecordBytes)
	if err != nil {
		return nil, err
	}
	signatureBytes, err := readRegularBounded(paths.DefinitionSignaturePath, maxSignedRecordBytes)
	if err != nil {
		return nil, err
	}
	publicKey, err := loadExternalPublicKey(paths.CoordinatorPublicKeyPath)
	if err != nil {
		return nil, err
	}

	var signature DetachedSignature
	if err := UnmarshalCanonical(signatureBytes, &signature); err != nil {
		return nil, fmt.Errorf("ceremony definition signature: %w", err)
	}
	// The signer key ID is authenticated here but is not trusted to identify a
	// protocol role. That binding is checked against the definition only after
	// the external trust anchor has authenticated the exact definition bytes.
	if err := VerifyExact(definitionBytes, signature, signature.KeyID, publicKey); err != nil {
		return nil, fmt.Errorf("verify ceremony definition signature: %w", err)
	}
	var definition CeremonyDefinition
	if err := UnmarshalCanonical(definitionBytes, &definition); err != nil {
		return nil, fmt.Errorf("ceremony definition: %w", err)
	}
	if signature.KeyID != definition.Coordinator.KeyID {
		return nil, fmt.Errorf(
			"ceremony definition signature key_id %q, want coordinator key %q",
			signature.KeyID,
			definition.Coordinator.KeyID,
		)
	}
	identityKey, err := identityPublicKey(definition.Coordinator)
	if err != nil {
		return nil, fmt.Errorf("coordinator identity: %w", err)
	}
	if !bytes.Equal(identityKey, publicKey) {
		return nil, errors.New("external coordinator public key does not match the signed coordinator identity")
	}
	return &TrustedCeremony{
		Definition:           definition,
		CoordinatorPublicKey: bytes.Clone(publicKey),
	}, nil
}

func loadOperationalCeremony(paths TrustPaths) (*TrustedCeremony, error) {
	trusted, err := LoadSignedDefinition(paths)
	if err != nil {
		return nil, err
	}
	if err := VerifyRunningSoftwareForMode(
		trusted.Definition.Software,
		trusted.Definition.Mode,
	); err != nil {
		return nil, fmt.Errorf("running software does not match signed ceremony definition: %w", err)
	}
	return trusted, nil
}

type InitFilesOptions struct {
	RootDir                   string
	Circuit                   *CompiledCircuit
	Definition                DefinitionOptions
	CoordinatorPrivateKeyPath string
}

type InitFilesResult struct {
	Definition               CeremonyDefinition
	Phase1Chain              Chain
	DefinitionPath           string
	DefinitionSignaturePath  string
	CoordinatorPublicKeyPath string
	R1CSPath                 string
	Phase1GenesisPath        string
	Phase1ChainPath          string
	Phase1ChainSignaturePath string
}

// InitializeCeremonyFiles creates a fresh ceremony root and deterministic
// Phase 1 genesis. The root must not already exist.
func InitializeCeremonyFiles(options InitFilesOptions) (result InitFilesResult, err error) {
	if options.Circuit == nil || options.Circuit.R1CS == nil {
		return result, errors.New("compiled circuit is required")
	}
	if strings.TrimSpace(options.RootDir) == "" {
		return result, errors.New("fresh ceremony root is required")
	}
	if err := options.Circuit.Binding.Validate(); err != nil {
		return result, fmt.Errorf("compiled circuit binding: %w", err)
	}
	privateKey, publicKey, err := loadMatchingPrivateKey(
		options.CoordinatorPrivateKeyPath,
		options.Definition.Coordinator,
	)
	if err != nil {
		return result, fmt.Errorf("coordinator signing key: %w", err)
	}
	if err := os.Mkdir(options.RootDir, 0o700); err != nil {
		return result, fmt.Errorf("create fresh ceremony root: %w", err)
	}
	createdRoot := true
	defer func() {
		if err != nil && createdRoot && !publicationWasCommitted(err) {
			_ = os.RemoveAll(options.RootDir)
		}
	}()
	phase1Dir := filepath.Join(options.RootDir, "phase1")
	if err := os.Mkdir(phase1Dir, 0o700); err != nil {
		return result, fmt.Errorf("create Phase 1 directory: %w", err)
	}

	result.DefinitionPath = filepath.Join(options.RootDir, "ceremony.json")
	result.DefinitionSignaturePath = filepath.Join(options.RootDir, "ceremony.sig")
	result.CoordinatorPublicKeyPath = filepath.Join(options.RootDir, "coordinator-public-key.hex")
	result.R1CSPath, err = resolveArtifactPath(options.RootDir, options.Circuit.Binding.R1CS.Name)
	if err != nil {
		return result, err
	}
	result.Phase1GenesisPath = filepath.Join(phase1Dir, "genesis.bin")
	result.Phase1ChainPath = filepath.Join(phase1Dir, "chain-0000.json")
	result.Phase1ChainSignaturePath = filepath.Join(phase1Dir, "chain-0000.sig")

	if _, err := writeWriterToNoReplace(
		result.R1CSPath,
		options.Circuit.R1CS,
		options.Circuit.Binding.R1CS.Digest,
	); err != nil {
		return result, fmt.Errorf("write frozen R1CS: %w", err)
	}

	genesis := gnarkmpc.NewPhase1(options.Circuit.Binding.DomainSize)
	genesisShape := Phase1Shape{DomainN: options.Circuit.Binding.DomainSize}
	genesisDigest, err := WritePhase1FileNoReplace(result.Phase1GenesisPath, genesis, genesisShape)
	if err != nil {
		return result, fmt.Errorf("write Phase 1 genesis: %w", err)
	}
	genesisRef := ArtifactRef{
		Name:   "phase1/genesis.bin",
		Digest: modelDigest(genesisDigest),
	}

	definitionOptions := options.Definition
	definitionOptions.Circuit = options.Circuit.Binding
	definitionOptions.Phase1Genesis = genesisRef
	definition, err := NewCeremonyDefinition(definitionOptions)
	if err != nil {
		return result, fmt.Errorf("create ceremony definition: %w", err)
	}
	phaseID, err := ComputePhaseID(definition.CeremonyID, Phase1, genesisRef, "")
	if err != nil {
		return result, fmt.Errorf("compute Phase 1 ID: %w", err)
	}
	chain, err := NewChain(definition.CeremonyID, Phase1, phaseID, genesisRef)
	if err != nil {
		return result, fmt.Errorf("create Phase 1 chain: %w", err)
	}

	if err := writeSignedRecordNoReplace(
		result.DefinitionPath,
		result.DefinitionSignaturePath,
		definition,
		definition.Coordinator.KeyID,
		privateKey,
	); err != nil {
		return result, fmt.Errorf("write signed ceremony definition: %w", err)
	}
	if err := writeSignedRecordNoReplace(
		result.Phase1ChainPath,
		result.Phase1ChainSignaturePath,
		chain,
		definition.Coordinator.KeyID,
		privateKey,
	); err != nil {
		return result, fmt.Errorf("write signed Phase 1 genesis chain: %w", err)
	}
	if err := writeBytesNoReplace(
		result.CoordinatorPublicKeyPath,
		[]byte(hex.EncodeToString(publicKey)+"\n"),
		0o600,
	); err != nil {
		return result, fmt.Errorf("write coordinator public-key copy: %w", err)
	}
	result.Definition = definition
	result.Phase1Chain = chain
	createdRoot = false
	return result, nil
}

type PhaseTranscriptPaths struct {
	RootDir            string
	ChainPath          string
	ChainSignaturePath string
}

// LoadSignedChain verifies the exact coordinator-signed chain at paths.
func LoadSignedChain(trusted *TrustedCeremony, paths PhaseTranscriptPaths) (Chain, error) {
	if err := validateTrustedCeremony(trusted); err != nil {
		return Chain{}, err
	}
	if strings.TrimSpace(paths.RootDir) == "" ||
		strings.TrimSpace(paths.ChainPath) == "" ||
		strings.TrimSpace(paths.ChainSignaturePath) == "" {
		return Chain{}, errors.New("transcript root, chain, and chain signature paths are required")
	}
	if _, err := logicalPathWithin(paths.RootDir, paths.ChainPath); err != nil {
		return Chain{}, fmt.Errorf("chain path: %w", err)
	}
	if _, err := logicalPathWithin(paths.RootDir, paths.ChainSignaturePath); err != nil {
		return Chain{}, fmt.Errorf("chain signature path: %w", err)
	}
	var chain Chain
	if err := loadCoordinatorSignedRecord(
		trusted,
		paths.ChainPath,
		paths.ChainSignaturePath,
		&chain,
	); err != nil {
		return Chain{}, fmt.Errorf("load signed chain: %w", err)
	}
	if err := chain.ValidateAgainstDefinition(trusted.Definition); err != nil {
		return Chain{}, fmt.Errorf("chain against definition: %w", err)
	}
	return chain, nil
}

// LoadReplayPhase1Files strictly reads all accepted evidence and replays every
// native Phase 1 transition while retaining at most the states needed by gnark.
func loadVerifiedPhase1Files(
	trusted *TrustedCeremony,
	circuit *CompiledCircuit,
	paths PhaseTranscriptPaths,
) (Chain, error) {
	if err := validateWorkflowCircuit(trusted, circuit); err != nil {
		return Chain{}, err
	}
	chain, err := LoadSignedChain(trusted, paths)
	if err != nil {
		return Chain{}, err
	}
	if chain.Phase != Phase1 {
		return Chain{}, fmt.Errorf("chain phase is %q, want phase1", chain.Phase)
	}
	if chain.Genesis != trusted.Definition.Phase1Genesis {
		return Chain{}, errors.New("Phase 1 chain genesis differs from signed ceremony definition")
	}
	expectedPhaseID, err := ComputePhaseID(
		trusted.Definition.CeremonyID,
		Phase1,
		chain.Genesis,
		"",
	)
	if err != nil {
		return Chain{}, err
	}
	if chain.PhaseID != expectedPhaseID {
		return Chain{}, errors.New("Phase 1 chain ID does not bind the signed genesis")
	}
	if err := verifyChainFiles(trusted, paths.RootDir, chain, circuit.Binding.Phase2Shape); err != nil {
		return Chain{}, err
	}
	return chain, nil
}

func LoadReplayPhase1Files(
	trusted *TrustedCeremony,
	circuit *CompiledCircuit,
	paths PhaseTranscriptPaths,
) (Chain, error) {
	chain, _, err := loadReplayPhase1FilesState(trusted, circuit, paths)
	return chain, err
}

func loadReplayPhase1FilesState(
	trusted *TrustedCeremony,
	circuit *CompiledCircuit,
	paths PhaseTranscriptPaths,
) (Chain, *gnarkmpc.Phase1, error) {
	chain, err := loadVerifiedPhase1Files(trusted, circuit, paths)
	if err != nil {
		return Chain{}, nil, err
	}
	loader := phase1FileLoader(paths.RootDir, chain, circuit.Binding.DomainSize)
	head, err := replayPhase1State(circuit.Binding.DomainSize, len(chain.Records), loader)
	if err != nil {
		return Chain{}, nil, err
	}
	return chain, head, nil
}

// LoadReplayPhase2Files performs the equivalent strict complete-chain replay
// for Phase 2.
func loadVerifiedPhase2Files(
	trusted *TrustedCeremony,
	circuit *CompiledCircuit,
	commons *gnarkmpc.SrsCommons,
	phase1Seal SealRecord,
	paths PhaseTranscriptPaths,
) (Chain, error) {
	if err := validateWorkflowCircuit(trusted, circuit); err != nil {
		return Chain{}, err
	}
	if commons == nil {
		return Chain{}, errors.New("sealed Phase 1 commons are required")
	}
	chain, err := LoadSignedChain(trusted, paths)
	if err != nil {
		return Chain{}, err
	}
	if chain.Phase != Phase2 {
		return Chain{}, fmt.Errorf("chain phase is %q, want phase2", chain.Phase)
	}
	if phase1Seal.CeremonyID != trusted.Definition.CeremonyID || phase1Seal.Phase != Phase1 {
		return Chain{}, errors.New("Phase 2 chain requires the signed Phase 1 seal")
	}
	expectedPhaseID, err := ComputePhaseID(
		trusted.Definition.CeremonyID,
		Phase2,
		chain.Genesis,
		phase1Seal.SealID,
	)
	if err != nil {
		return Chain{}, err
	}
	if chain.PhaseID != expectedPhaseID {
		return Chain{}, errors.New("Phase 2 chain ID does not bind the signed Phase 1 seal")
	}
	deterministicGenesis, deterministicShape, err := InitializePhase2(circuit, commons)
	if err != nil {
		return Chain{}, fmt.Errorf("recompute deterministic Phase 2 genesis: %w", err)
	}
	if !equalPhase2Shape(deterministicShape, circuit.Binding.Phase2Shape) {
		return Chain{}, errors.New("deterministic Phase 2 genesis shape differs from signed circuit binding")
	}
	expectedGenesisSize, err := ExpectedPhase2Size(deterministicShape)
	if err != nil {
		return Chain{}, err
	}
	genesisHash := newDualHash()
	written, err := writeToWithPanicBoundary(
		"deterministic Phase 2 genesis encoder",
		deterministicGenesis,
		genesisHash,
	)
	if err != nil {
		return Chain{}, fmt.Errorf("hash deterministic Phase 2 genesis: %w", err)
	}
	if written != expectedGenesisSize {
		return Chain{}, fmt.Errorf("deterministic Phase 2 genesis wrote %d bytes, expected %d", written, expectedGenesisSize)
	}
	if modelDigest(genesisHash.digest(written, nil)) != chain.Genesis.Digest {
		return Chain{}, errors.New("Phase 2 chain genesis is not the deterministic circuit/commons initialization")
	}
	if err := verifyChainFiles(trusted, paths.RootDir, chain, circuit.Binding.Phase2Shape); err != nil {
		return Chain{}, err
	}
	return chain, nil
}

func LoadReplayPhase2Files(
	trusted *TrustedCeremony,
	circuit *CompiledCircuit,
	commons *gnarkmpc.SrsCommons,
	phase1Seal SealRecord,
	paths PhaseTranscriptPaths,
) (Chain, error) {
	chain, err := loadVerifiedPhase2Files(trusted, circuit, commons, phase1Seal, paths)
	if err != nil {
		return Chain{}, err
	}
	loader := phase2FileLoader(paths.RootDir, chain, contributionPhase2Shape(circuit.Binding.Phase2Shape))
	if err := ReplayPhase2Loaded(circuit, commons, len(chain.Records), loader); err != nil {
		return Chain{}, err
	}
	return chain, nil
}

type ContributionFilesOptions struct {
	Trust                     TrustPaths
	Circuit                   *CompiledCircuit
	Phase                     Phase
	Transcript                PhaseTranscriptPaths
	Phase1SealPath            string
	Phase1SealSignaturePath   string
	ParticipantID             string
	ParticipantPrivateKeyPath string
	Environment               ContributionEnvironment
	ContributedAt             string
	CandidateDir              string
}

type ContributionFilesResult struct {
	Attestation              ContributionAttestation
	OutputPayloadPath        string
	AttestationPath          string
	AttestationSignaturePath string
}

// CreateContributionCandidate replays the entire accepted chain before
// sampling contribution randomness. It never modifies the authoritative
// transcript and writes only to a fresh candidate directory.
func CreateContributionCandidate(options ContributionFilesOptions) (result ContributionFilesResult, err error) {
	trusted, err := loadOperationalCeremony(options.Trust)
	if err != nil {
		return result, err
	}
	if err := validateWorkflowCircuit(trusted, options.Circuit); err != nil {
		return result, err
	}
	if err := options.Phase.Validate(); err != nil {
		return result, err
	}
	if strings.TrimSpace(options.CandidateDir) == "" {
		return result, errors.New("fresh candidate directory is required")
	}
	participant, ok := trusted.Definition.ParticipantByID(options.ParticipantID)
	if !ok {
		return result, fmt.Errorf("participant %q is not in the signed roster", options.ParticipantID)
	}
	privateKey, _, err := loadMatchingPrivateKey(options.ParticipantPrivateKeyPath, participant.Identity)
	if err != nil {
		return result, fmt.Errorf("participant signing key: %w", err)
	}
	if err := options.Environment.Validate(); err != nil {
		return result, fmt.Errorf("contribution environment: %w", err)
	}
	if err := validateTimestamp("contributed_at", options.ContributedAt); err != nil {
		return result, err
	}

	var chain Chain
	var generateContributionWriter func() (func(string) (ArtifactDigest, error), error)
	switch options.Phase {
	case Phase1:
		chain, err = loadVerifiedPhase1Files(trusted, options.Circuit, options.Transcript)
		if err != nil {
			return result, err
		}
		generateContributionWriter = func() (func(string) (ArtifactDigest, error), error) {
			contribution, contributeErr := ContributePhase1Loaded(
				options.Circuit.Binding.DomainSize,
				len(chain.Records),
				phase1FileLoader(options.Transcript.RootDir, chain, options.Circuit.Binding.DomainSize),
			)
			if contributeErr != nil {
				return nil, contributeErr
			}
			shape := Phase1Shape{DomainN: options.Circuit.Binding.DomainSize, ChallengeLength: contributionChallengeSize}
			return func(path string) (ArtifactDigest, error) {
				return WritePhase1FileNoReplace(path, contribution, shape)
			}, nil
		}
	case Phase2:
		commons, phase1Seal, _, loadErr := loadPhase1CommonsForPhase2(trusted, options.Circuit, options.Transcript.RootDir, options.Phase1SealPath, options.Phase1SealSignaturePath)
		if loadErr != nil {
			return result, loadErr
		}
		chain, err = loadVerifiedPhase2Files(trusted, options.Circuit, commons, phase1Seal, options.Transcript)
		if err != nil {
			return result, err
		}
		generateContributionWriter = func() (func(string) (ArtifactDigest, error), error) {
			contribution, contributeErr := ContributePhase2Loaded(
				options.Circuit,
				commons,
				len(chain.Records),
				phase2FileLoader(options.Transcript.RootDir, chain, contributionPhase2Shape(options.Circuit.Binding.Phase2Shape)),
			)
			if contributeErr != nil {
				return nil, contributeErr
			}
			shape := contributionPhase2Shape(options.Circuit.Binding.Phase2Shape)
			return func(path string) (ArtifactDigest, error) {
				return WritePhase2FileNoReplace(path, contribution, shape)
			}, nil
		}
	}

	policy, _ := trusted.Definition.PolicyForPhase(options.Phase)
	index := len(chain.Records) + 1
	if index > len(policy.Participants) || policy.Participants[index-1] != options.ParticipantID {
		return result, fmt.Errorf("participant %q is not scheduled at contribution index %d", options.ParticipantID, index)
	}
	if _, statErr := os.Lstat(options.CandidateDir); statErr == nil {
		return result, fmt.Errorf("fresh candidate directory already exists: %w", fs.ErrExist)
	} else if !errors.Is(statErr, fs.ErrNotExist) {
		return result, fmt.Errorf("inspect fresh candidate directory: %w", statErr)
	}

	// Replay and MPC entropy sampling start only after all deterministic
	// schedule and destination preflights have succeeded. The directory itself
	// is created afterward so termination during replay does not strand an
	// empty candidate path; the ceremony root must remain access-controlled to
	// exclude a racing creator between this preflight and mkdir.
	contributionWriter, err := generateContributionWriter()
	if err != nil {
		return result, err
	}
	if err := os.Mkdir(options.CandidateDir, 0o700); err != nil {
		return result, fmt.Errorf("create fresh candidate directory: %w", err)
	}
	createdCandidate := true
	defer func() {
		if err != nil && createdCandidate && !publicationWasCommitted(err) {
			_ = os.RemoveAll(options.CandidateDir)
		}
	}()
	result.OutputPayloadPath = filepath.Join(options.CandidateDir, "contribution.bin")
	result.AttestationPath = filepath.Join(options.CandidateDir, "attestation.json")
	result.AttestationSignaturePath = filepath.Join(options.CandidateDir, "attestation.sig")

	outputDigest, err := contributionWriter(result.OutputPayloadPath)
	if err != nil {
		return result, err
	}
	previousPayload, _ := chain.HeadPayload()
	if err := requireChallengeMatchesDigest(outputDigest.Challenge, previousPayload.Digest); err != nil {
		return result, fmt.Errorf("generated contribution challenge: %w", err)
	}
	previousRecordID, _ := chain.HeadRecordID()
	names := contributionLogicalNames(options.Phase, index)
	outputRef := ArtifactRef{Name: names.Payload, Digest: modelDigest(outputDigest)}
	attestation, err := NewContributionAttestation(ContributionAttestation{
		CeremonyID:           trusted.Definition.CeremonyID,
		Phase:                options.Phase,
		PhaseID:              chain.PhaseID,
		Index:                uint8(index),
		ParticipantID:        participant.Identity.ID,
		ParticipantKeyID:     participant.Identity.KeyID,
		PreviousPayload:      previousPayload,
		OutputPayload:        outputRef,
		PreviousAcceptanceID: previousRecordID,
		ToolBinary:           trusted.Definition.Software.ToolBinary,
		SourceCommit:         trusted.Definition.Software.SourceCommit,
		GnarkVersion:         trusted.Definition.Software.GnarkVersion,
		GnarkCryptoVersion:   trusted.Definition.Software.GnarkCryptoVersion,
		DrandVersion:         trusted.Definition.Software.DrandVersion,
		Environment:          options.Environment,
		ContributedAt:        options.ContributedAt,
	})
	if err != nil {
		return result, err
	}
	if err := writeSignedRecordNoReplace(
		result.AttestationPath,
		result.AttestationSignaturePath,
		attestation,
		participant.Identity.KeyID,
		privateKey,
	); err != nil {
		return result, err
	}
	result.Attestation = attestation
	createdCandidate = false
	return result, nil
}

type CreateErasureAttestationFilesOptions struct {
	Trust                     TrustPaths
	ParticipantID             string
	ParticipantPrivateKeyPath string
	CandidateDir              string
	DestroyedAt               string
}

type CreateErasureAttestationFilesResult struct {
	Erasure       ErasureAttestation
	ErasurePath   string
	SignaturePath string
}

// CreateErasureAttestationFiles authenticates the participant's contribution
// attestation and records the required post-contribution destruction evidence.
// It does not touch ceremony wallet material or modify the contribution.
func CreateErasureAttestationFiles(
	options CreateErasureAttestationFilesOptions,
) (result CreateErasureAttestationFilesResult, err error) {
	trusted, err := loadOperationalCeremony(options.Trust)
	if err != nil {
		return result, err
	}
	participant, ok := trusted.Definition.ParticipantByID(options.ParticipantID)
	if !ok {
		return result, fmt.Errorf("participant %q is not in the signed roster", options.ParticipantID)
	}
	privateKey, publicKey, err := loadMatchingPrivateKey(
		options.ParticipantPrivateKeyPath,
		participant.Identity,
	)
	if err != nil {
		return result, fmt.Errorf("participant signing key: %w", err)
	}
	attestationPath := filepath.Join(options.CandidateDir, "attestation.json")
	signaturePath := filepath.Join(options.CandidateDir, "attestation.sig")
	attestationBytes, err := readRegularBounded(attestationPath, maxSignedRecordBytes)
	if err != nil {
		return result, err
	}
	signatureBytes, err := readRegularBounded(signaturePath, maxSignedRecordBytes)
	if err != nil {
		return result, err
	}
	var attestation ContributionAttestation
	if err := VerifySignedRecord(
		attestationBytes,
		signatureBytes,
		&attestation,
		participant.Identity.KeyID,
		publicKey,
	); err != nil {
		return result, fmt.Errorf("verify contribution attestation: %w", err)
	}
	if attestation.ParticipantID != participant.Identity.ID ||
		attestation.ParticipantKeyID != participant.Identity.KeyID ||
		attestation.CeremonyID != trusted.Definition.CeremonyID {
		return result, errors.New("contribution attestation does not match participant or ceremony")
	}
	erasure, err := NewErasureAttestation(ErasureAttestation{
		CeremonyID:                attestation.CeremonyID,
		Phase:                     attestation.Phase,
		PhaseID:                   attestation.PhaseID,
		Index:                     attestation.Index,
		ParticipantID:             attestation.ParticipantID,
		ParticipantKeyID:          attestation.ParticipantKeyID,
		ContributionAttestationID: attestation.AttestationID,
		OutputPayload:             attestation.OutputPayload,
		DestroyedAt:               options.DestroyedAt,
		ProcessTerminated:         true,
		EphemeralStorageDestroyed: true,
		NoBackupRetained:          true,
	})
	if err != nil {
		return result, err
	}
	if err := ValidateErasureForContribution(attestation, erasure); err != nil {
		return result, err
	}
	result.ErasurePath = filepath.Join(options.CandidateDir, "erasure.json")
	result.SignaturePath = filepath.Join(options.CandidateDir, "erasure.sig")
	if err := writeSignedRecordNoReplace(
		result.ErasurePath,
		result.SignaturePath,
		erasure,
		participant.Identity.KeyID,
		privateKey,
	); err != nil {
		return result, err
	}
	result.Erasure = erasure
	return result, nil
}

// RecordErasureFiles is a participant-CLI-friendly alias.
type RecordErasureFilesOptions = CreateErasureAttestationFilesOptions
type RecordErasureFilesResult = CreateErasureAttestationFilesResult

func RecordErasureFiles(options RecordErasureFilesOptions) (RecordErasureFilesResult, error) {
	return CreateErasureAttestationFiles(options)
}

type AcceptContributionFilesOptions struct {
	Trust                     TrustPaths
	Circuit                   *CompiledCircuit
	Phase                     Phase
	Transcript                PhaseTranscriptPaths
	Phase1SealPath            string
	Phase1SealSignaturePath   string
	CandidateDir              string
	CoordinatorPrivateKeyPath string
	AcceptedAt                string
}

type AcceptContributionFilesResult struct {
	Record                           ChainRecord
	Chain                            Chain
	AcceptedPayloadPath              string
	AcceptedAttestationPath          string
	AcceptedAttestationSignaturePath string
	AcceptedErasurePath              string
	AcceptedErasureSignaturePath     string
	VerificationPath                 string
	ChainPath                        string
	ChainSignaturePath               string
}

// VerifyAndAcceptContribution verifies a candidate independently, publishes
// immutable evidence, and writes a new signed chain document last. The input
// chain is never overwritten.
func VerifyAndAcceptContribution(options AcceptContributionFilesOptions) (result AcceptContributionFilesResult, err error) {
	trusted, err := loadOperationalCeremony(options.Trust)
	if err != nil {
		return result, err
	}
	if err := validateWorkflowCircuit(trusted, options.Circuit); err != nil {
		return result, err
	}
	if err := options.Phase.Validate(); err != nil {
		return result, err
	}
	if err := validateTimestamp("accepted_at", options.AcceptedAt); err != nil {
		return result, err
	}
	coordinatorPrivate, _, err := loadMatchingPrivateKey(
		options.CoordinatorPrivateKeyPath,
		trusted.Definition.Coordinator,
	)
	if err != nil {
		return result, fmt.Errorf("coordinator signing key: %w", err)
	}

	var chain Chain
	var candidateDigest ArtifactDigest
	var candidateChallenge []byte
	var phase1Candidate *gnarkmpc.Phase1
	var phase2Candidate *gnarkmpc.Phase2
	var phase2Commons *gnarkmpc.SrsCommons
	var phase1Seal SealRecord
	switch options.Phase {
	case Phase1:
		chain, err = loadVerifiedPhase1Files(trusted, options.Circuit, options.Transcript)
		if err != nil {
			return result, err
		}
	case Phase2:
		phase2Commons, phase1Seal, _, err = loadAuthenticatedPhase1CommonsForCoordinator(
			trusted,
			options.Circuit,
			options.Transcript.RootDir,
			options.Phase1SealPath,
			options.Phase1SealSignaturePath,
		)
		loadErr := err
		if loadErr != nil {
			return result, loadErr
		}
		chain, err = loadVerifiedPhase2Files(trusted, options.Circuit, phase2Commons, phase1Seal, options.Transcript)
		if err != nil {
			return result, err
		}
	}
	index := len(chain.Records) + 1
	names := contributionLogicalNames(options.Phase, index)
	candidatePayloadPath := filepath.Join(options.CandidateDir, "contribution.bin")
	candidateAttestationPath := filepath.Join(options.CandidateDir, "attestation.json")
	candidateSignaturePath := filepath.Join(options.CandidateDir, "attestation.sig")
	candidateErasurePath := filepath.Join(options.CandidateDir, "erasure.json")
	candidateErasureSignaturePath := filepath.Join(options.CandidateDir, "erasure.sig")

	attestationBytes, err := readRegularBounded(candidateAttestationPath, maxSignedRecordBytes)
	if err != nil {
		return result, err
	}
	var attestation ContributionAttestation
	if err := UnmarshalCanonical(attestationBytes, &attestation); err != nil {
		return result, fmt.Errorf("candidate attestation: %w", err)
	}
	participant, ok := trusted.Definition.ParticipantByID(attestation.ParticipantID)
	if !ok {
		return result, fmt.Errorf("candidate participant %q is not in roster", attestation.ParticipantID)
	}
	participantKey, err := identityPublicKey(participant.Identity)
	if err != nil {
		return result, err
	}
	attestationSignatureBytes, err := readRegularBounded(candidateSignaturePath, maxSignedRecordBytes)
	if err != nil {
		return result, err
	}
	if err := VerifySignedRecord(
		attestationBytes,
		attestationSignatureBytes,
		&attestation,
		participant.Identity.KeyID,
		participantKey,
	); err != nil {
		return result, fmt.Errorf("verify candidate attestation: %w", err)
	}
	if attestation.Index != uint8(index) || attestation.Phase != options.Phase ||
		attestation.PhaseID != chain.PhaseID || attestation.CeremonyID != trusted.Definition.CeremonyID ||
		attestation.OutputPayload.Name != names.Payload {
		return result, errors.New("candidate attestation does not match the expected chain position")
	}
	previousPayload, _ := chain.HeadPayload()
	previousRecordID, _ := chain.HeadRecordID()
	if attestation.PreviousPayload != previousPayload || attestation.PreviousAcceptanceID != previousRecordID {
		return result, errors.New("candidate attestation is not based on the accepted chain head")
	}
	erasureBytes, err := readRegularBounded(candidateErasurePath, maxSignedRecordBytes)
	if err != nil {
		return result, err
	}
	erasureSignatureBytes, err := readRegularBounded(candidateErasureSignaturePath, maxSignedRecordBytes)
	if err != nil {
		return result, err
	}
	var erasure ErasureAttestation
	if err := VerifySignedRecord(
		erasureBytes,
		erasureSignatureBytes,
		&erasure,
		participant.Identity.KeyID,
		participantKey,
	); err != nil {
		return result, fmt.Errorf("verify candidate erasure attestation: %w", err)
	}
	if err := ValidateErasureForContribution(attestation, erasure); err != nil {
		return result, fmt.Errorf("candidate erasure attestation: %w", err)
	}

	switch options.Phase {
	case Phase1:
		candidate, digest, readErr := ReadPhase1File(
			candidatePayloadPath,
			Phase1Shape{DomainN: options.Circuit.Binding.DomainSize, ChallengeLength: contributionChallengeSize},
		)
		if readErr != nil {
			return result, readErr
		}
		phase1Candidate = candidate
		candidateDigest, candidateChallenge = digest, digest.Challenge
		var previous *gnarkmpc.Phase1
		if index == 1 {
			previous, _, err = InitializePhase1(options.Circuit.Binding.DomainSize)
		} else {
			previous, err = phase1FileLoader(
				options.Transcript.RootDir,
				chain,
				options.Circuit.Binding.DomainSize,
			)(index - 2)
		}
		if err != nil {
			return result, fmt.Errorf("load authenticated Phase 1 head: %w", err)
		}
		if err := verifyPhase1Transition(
			options.Circuit.Binding.DomainSize,
			previous,
			candidate,
		); err != nil {
			return result, fmt.Errorf("verify candidate Phase 1 transition: %w", err)
		}
	case Phase2:
		candidate, digest, readErr := ReadPhase2File(candidatePayloadPath, contributionPhase2Shape(options.Circuit.Binding.Phase2Shape))
		if readErr != nil {
			return result, readErr
		}
		phase2Candidate = candidate
		candidateDigest, candidateChallenge = digest, digest.Challenge
		var previous *gnarkmpc.Phase2
		if index == 1 {
			previous, _, err = InitializePhase2(options.Circuit, phase2Commons)
		} else {
			previous, err = phase2FileLoader(
				options.Transcript.RootDir,
				chain,
				contributionPhase2Shape(options.Circuit.Binding.Phase2Shape),
			)(index - 2)
		}
		if err != nil {
			return result, fmt.Errorf("load authenticated Phase 2 head: %w", err)
		}
		if err := verifyPhase2Transition(previous, candidate); err != nil {
			return result, fmt.Errorf("verify candidate Phase 2 transition: %w", err)
		}
	}
	if modelDigest(candidateDigest) != attestation.OutputPayload.Digest {
		return result, errors.New("candidate contribution digest does not match attestation")
	}
	if err := requireChallengeMatchesDigest(candidateChallenge, previousPayload.Digest); err != nil {
		return result, err
	}

	attestationRef := ArtifactRef{Name: names.Attestation, Digest: digestBytes(attestationBytes)}
	attestationSignatureRef := ArtifactRef{Name: names.AttestationSignature, Digest: digestBytes(attestationSignatureBytes)}
	erasureRef := ArtifactRef{Name: names.Erasure, Digest: digestBytes(erasureBytes)}
	erasureSignatureRef := ArtifactRef{Name: names.ErasureSignature, Digest: digestBytes(erasureSignatureBytes)}
	verification := ContributionVerification{
		Schema:           verificationSchema,
		VerificationMode: directTransitionVerification,
		CeremonyID:       trusted.Definition.CeremonyID,
		Phase:            options.Phase,
		PhaseID:          chain.PhaseID,
		Index:            uint8(index),
		ParticipantID:    attestation.ParticipantID,
		PreviousPayload:  previousPayload,
		OutputPayload:    attestation.OutputPayload,
		AttestationID:    attestation.AttestationID,
		ErasureID:        erasure.ErasureID,
		PreviousRecordID: previousRecordID,
		CoordinatorID:    trusted.Definition.Coordinator.ID,
		CoordinatorKeyID: trusted.Definition.Coordinator.KeyID,
		Passed:           true,
		VerifiedAt:       options.AcceptedAt,
	}
	verificationBytes, err := MarshalCanonical(verification)
	if err != nil {
		return result, err
	}
	verificationRef := ArtifactRef{Name: names.Verification, Digest: digestBytes(verificationBytes)}
	record, err := NewChainRecord(ChainRecord{
		CeremonyID:           trusted.Definition.CeremonyID,
		Phase:                options.Phase,
		PhaseID:              chain.PhaseID,
		Index:                uint8(index),
		ParticipantID:        attestation.ParticipantID,
		PreviousPayload:      previousPayload,
		OutputPayload:        attestation.OutputPayload,
		AttestationID:        attestation.AttestationID,
		Attestation:          attestationRef,
		AttestationSignature: attestationSignatureRef,
		ErasureID:            erasure.ErasureID,
		Erasure:              erasureRef,
		ErasureSignature:     erasureSignatureRef,
		Verification:         verificationRef,
		PreviousRecordID:     previousRecordID,
		CoordinatorID:        trusted.Definition.Coordinator.ID,
		CoordinatorKeyID:     trusted.Definition.Coordinator.KeyID,
		AcceptedAt:           options.AcceptedAt,
	})
	if err != nil {
		return result, err
	}
	if err := ValidateAttestationAcceptance(trusted.Definition, chain, attestation, erasure, record); err != nil {
		return result, err
	}
	nextChain := chain
	if err := nextChain.Append(record); err != nil {
		return result, err
	}

	result.AcceptedPayloadPath, err = resolveArtifactPath(options.Transcript.RootDir, names.Payload)
	if err != nil {
		return result, err
	}
	result.AcceptedAttestationPath, err = resolveArtifactPath(options.Transcript.RootDir, names.Attestation)
	if err != nil {
		return result, err
	}
	result.AcceptedAttestationSignaturePath, err = resolveArtifactPath(options.Transcript.RootDir, names.AttestationSignature)
	if err != nil {
		return result, err
	}
	result.AcceptedErasurePath, err = resolveArtifactPath(options.Transcript.RootDir, names.Erasure)
	if err != nil {
		return result, err
	}
	result.AcceptedErasureSignaturePath, err = resolveArtifactPath(options.Transcript.RootDir, names.ErasureSignature)
	if err != nil {
		return result, err
	}
	result.VerificationPath, err = resolveArtifactPath(options.Transcript.RootDir, names.Verification)
	if err != nil {
		return result, err
	}
	contributionDir := filepath.Dir(result.AcceptedPayloadPath)
	phaseDir := filepath.Join(options.Transcript.RootDir, string(options.Phase))
	if err := mkdirAllPrivateDurable(contributionDir); err != nil {
		return result, err
	}
	if err := requirePrivateRealDirectory(contributionDir); err != nil {
		return result, err
	}
	if err := requireDirectoryEntriesSubset(contributionDir, []string{
		filepath.Base(result.AcceptedPayloadPath),
		filepath.Base(result.AcceptedAttestationPath),
		filepath.Base(result.AcceptedAttestationSignaturePath),
		filepath.Base(result.AcceptedErasurePath),
		filepath.Base(result.AcceptedErasureSignaturePath),
		filepath.Base(result.VerificationPath),
	}); err != nil {
		return result, err
	}
	result.ChainPath = filepath.Join(phaseDir, fmt.Sprintf("chain-%04d.json", index))
	result.ChainSignaturePath = filepath.Join(phaseDir, fmt.Sprintf("chain-%04d.sig", index))
	chainBytes, chainSignatureBytes, err := SignRecord(
		nextChain,
		trusted.Definition.Coordinator.KeyID,
		coordinatorPrivate,
	)
	if err != nil {
		return result, err
	}

	// Check every possible retry artifact before publishing any new bytes.
	// A complete or partial byte-identical prefix is resumable; a mismatch
	// aborts without modifying the existing transcript.
	switch options.Phase {
	case Phase1:
		if err := requireAbsentOrExactPhase1(
			result.AcceptedPayloadPath,
			Phase1Shape{DomainN: options.Circuit.Binding.DomainSize, ChallengeLength: contributionChallengeSize},
			attestation.OutputPayload.Digest,
		); err != nil {
			return result, err
		}
	case Phase2:
		if err := requireAbsentOrExactPhase2(
			result.AcceptedPayloadPath,
			contributionPhase2Shape(options.Circuit.Binding.Phase2Shape),
			attestation.OutputPayload.Digest,
		); err != nil {
			return result, err
		}
	}
	for _, item := range []struct {
		path string
		data []byte
	}{
		{result.AcceptedAttestationPath, attestationBytes},
		{result.AcceptedAttestationSignaturePath, attestationSignatureBytes},
		{result.AcceptedErasurePath, erasureBytes},
		{result.AcceptedErasureSignaturePath, erasureSignatureBytes},
		{result.VerificationPath, verificationBytes},
		{result.ChainSignaturePath, chainSignatureBytes},
		{result.ChainPath, chainBytes},
	} {
		if err := requireAbsentOrExact(item.path, item.data, maxSignedRecordBytes); err != nil {
			return result, err
		}
	}

	switch options.Phase {
	case Phase1:
		if _, err := writePhase1FileNoReplaceOrExact(
			result.AcceptedPayloadPath,
			phase1Candidate,
			Phase1Shape{DomainN: options.Circuit.Binding.DomainSize, ChallengeLength: contributionChallengeSize},
			attestation.OutputPayload.Digest,
		); err != nil {
			return result, err
		}
	case Phase2:
		if _, err := writePhase2FileNoReplaceOrExact(
			result.AcceptedPayloadPath,
			phase2Candidate,
			contributionPhase2Shape(options.Circuit.Binding.Phase2Shape),
			attestation.OutputPayload.Digest,
		); err != nil {
			return result, err
		}
	}
	if err := writeBytesNoReplaceOrExact(result.AcceptedAttestationPath, attestationBytes, 0o600, maxSignedRecordBytes); err != nil {
		return result, err
	}
	if err := writeBytesNoReplaceOrExact(result.AcceptedAttestationSignaturePath, attestationSignatureBytes, 0o600, maxSignedRecordBytes); err != nil {
		return result, err
	}
	if err := writeBytesNoReplaceOrExact(result.AcceptedErasurePath, erasureBytes, 0o600, maxSignedRecordBytes); err != nil {
		return result, err
	}
	if err := writeBytesNoReplaceOrExact(result.AcceptedErasureSignaturePath, erasureSignatureBytes, 0o600, maxSignedRecordBytes); err != nil {
		return result, err
	}
	if err := writeBytesNoReplaceOrExact(result.VerificationPath, verificationBytes, 0o600, maxSignedRecordBytes); err != nil {
		return result, err
	}
	if err := writeSignedRecordNoReplace(
		result.ChainPath,
		result.ChainSignaturePath,
		nextChain,
		trusted.Definition.Coordinator.KeyID,
		coordinatorPrivate,
	); err != nil {
		return result, err
	}
	result.Record = record
	result.Chain = nextChain
	return result, nil
}

// ContributionVerification is coordinator evidence referenced from each
// accepted chain record.
type ContributionVerification struct {
	Schema           string      `json:"schema"`
	VerificationMode string      `json:"verification_mode"`
	CeremonyID       string      `json:"ceremony_id"`
	Phase            Phase       `json:"phase"`
	PhaseID          string      `json:"phase_id"`
	Index            uint8       `json:"index"`
	ParticipantID    string      `json:"participant_id"`
	PreviousPayload  ArtifactRef `json:"previous_payload"`
	OutputPayload    ArtifactRef `json:"output_payload"`
	AttestationID    string      `json:"attestation_id"`
	ErasureID        string      `json:"erasure_id"`
	PreviousRecordID string      `json:"previous_record_id"`
	CoordinatorID    string      `json:"coordinator_id"`
	CoordinatorKeyID string      `json:"coordinator_key_id"`
	Passed           bool        `json:"passed"`
	VerifiedAt       string      `json:"verified_at"`
}

func (v ContributionVerification) Validate() error {
	if v.Schema != verificationSchema {
		return fmt.Errorf("verification schema %q, want %q", v.Schema, verificationSchema)
	}
	if v.VerificationMode != directTransitionVerification {
		return fmt.Errorf(
			"verification mode %q, want %q",
			v.VerificationMode,
			directTransitionVerification,
		)
	}
	if err := validateRecordScope(v.CeremonyID, v.Phase, v.PhaseID); err != nil {
		return err
	}
	if v.Index == 0 || v.Index > MaxParticipants {
		return fmt.Errorf("verification index %d is invalid", v.Index)
	}
	if err := validateID("participant_id", v.ParticipantID); err != nil {
		return err
	}
	if err := v.PreviousPayload.Validate(); err != nil {
		return err
	}
	if err := v.OutputPayload.Validate(); err != nil {
		return err
	}
	if err := validateHashID("attestation_id", v.AttestationID); err != nil {
		return err
	}
	if err := validateHashID("erasure_id", v.ErasureID); err != nil {
		return err
	}
	if err := validateHashID("previous_record_id", v.PreviousRecordID); err != nil {
		return err
	}
	if err := validateID("coordinator_id", v.CoordinatorID); err != nil {
		return err
	}
	if err := validateID("coordinator_key_id", v.CoordinatorKeyID); err != nil {
		return err
	}
	if !v.Passed {
		return errors.New("accepted contribution verification must pass")
	}
	return validateTimestamp("verified_at", v.VerifiedAt)
}

func validateContributionVerification(record ChainRecord, verification ContributionVerification) error {
	if err := verification.Validate(); err != nil {
		return err
	}
	if verification.CeremonyID != record.CeremonyID ||
		verification.Phase != record.Phase ||
		verification.PhaseID != record.PhaseID ||
		verification.Index != record.Index ||
		verification.ParticipantID != record.ParticipantID ||
		verification.PreviousPayload != record.PreviousPayload ||
		verification.OutputPayload != record.OutputPayload ||
		verification.AttestationID != record.AttestationID ||
		verification.ErasureID != record.ErasureID ||
		verification.PreviousRecordID != record.PreviousRecordID ||
		verification.CoordinatorID != record.CoordinatorID ||
		verification.CoordinatorKeyID != record.CoordinatorKeyID ||
		verification.VerifiedAt != record.AcceptedAt {
		return errors.New("verification evidence does not match accepted chain record")
	}
	return nil
}

type ClosePhaseFilesOptions struct {
	Trust                     TrustPaths
	Circuit                   *CompiledCircuit
	Phase                     Phase
	Transcript                PhaseTranscriptPaths
	Phase1SealPath            string
	Phase1SealSignaturePath   string
	CoordinatorPrivateKeyPath string
	BeaconRound               uint64
}

type ClosePhaseFilesResult struct {
	Close         CloseRecord
	ClosePath     string
	SignaturePath string
}

// ClosePhaseFiles replays the exact signed chain and publishes a signed
// closure as one atomic directory at the fixed per-phase path. Closure time is
// sampled only after replay, and the future-round lead is checked again
// immediately before the directory is committed.
func ClosePhaseFiles(options ClosePhaseFilesOptions) (ClosePhaseFilesResult, error) {
	return closePhaseFiles(options, time.Now)
}

func closePhaseFiles(
	options ClosePhaseFilesOptions,
	now func() time.Time,
) (ClosePhaseFilesResult, error) {
	if now == nil {
		return ClosePhaseFilesResult{}, errors.New("closure clock is required")
	}
	trusted, err := loadOperationalCeremony(options.Trust)
	if err != nil {
		return ClosePhaseFilesResult{}, err
	}
	return closePhaseFilesAuthenticated(options, trusted, now)
}

func closePhaseFilesAuthenticated(
	options ClosePhaseFilesOptions,
	trusted *TrustedCeremony,
	now func() time.Time,
) (ClosePhaseFilesResult, error) {
	var result ClosePhaseFilesResult
	if err := validateWorkflowCircuit(trusted, options.Circuit); err != nil {
		return result, err
	}
	var chain Chain
	var err error
	switch options.Phase {
	case Phase1:
		chain, err = LoadReplayPhase1Files(trusted, options.Circuit, options.Transcript)
	case Phase2:
		var commons *gnarkmpc.SrsCommons
		var phase1Seal SealRecord
		var phase1Close CloseRecord
		commons, phase1Seal, phase1Close, err = loadPhase1CommonsForPhase2(
			trusted,
			options.Circuit,
			options.Transcript.RootDir,
			options.Phase1SealPath,
			options.Phase1SealSignaturePath,
		)
		if err == nil && options.BeaconRound == phase1Close.BeaconRound {
			err = fmt.Errorf(
				"phase2 beacon round %d reuses the authenticated phase1 beacon round; a distinct round is required",
				options.BeaconRound,
			)
		}
		if err == nil {
			chain, err = LoadReplayPhase2Files(trusted, options.Circuit, commons, phase1Seal, options.Transcript)
		}
	default:
		err = fmt.Errorf("unsupported phase %q", options.Phase)
	}
	if err != nil {
		return result, err
	}
	return publishReplayedPhaseClose(options, trusted, chain, now)
}

func publishReplayedPhaseClose(
	options ClosePhaseFilesOptions,
	trusted *TrustedCeremony,
	chain Chain,
	now func() time.Time,
) (ClosePhaseFilesResult, error) {
	var result ClosePhaseFilesResult
	privateKey, _, err := loadMatchingPrivateKey(options.CoordinatorPrivateKeyPath, trusted.Definition.Coordinator)
	if err != nil {
		return result, err
	}
	headID, _ := chain.HeadRecordID()
	headPayload, _ := chain.HeadPayload()
	participants, _ := chain.ParticipantIDs()
	phaseDir := filepath.Join(options.Transcript.RootDir, string(options.Phase))
	closeDir := filepath.Join(phaseDir, closePublicationDirectoryName)
	result.ClosePath = filepath.Join(closeDir, closeRecordFilename)
	result.SignaturePath = filepath.Join(closeDir, closeSignatureFilename)

	if _, statErr := os.Lstat(closeDir); statErr == nil {
		if err := requirePrivateRealDirectory(closeDir); err != nil {
			return result, fmt.Errorf("validate existing atomic phase closure directory: %w", err)
		}
		if err := requireDirectoryEntriesSubset(closeDir, []string{
			closeRecordFilename,
			closeSignatureFilename,
		}); err != nil {
			return result, fmt.Errorf("validate existing atomic phase closure members: %w", err)
		}
		var existing CloseRecord
		if err := loadCoordinatorSignedRecord(
			trusted,
			result.ClosePath,
			result.SignaturePath,
			&existing,
		); err != nil {
			return result, fmt.Errorf("load existing atomic phase closure: %w", err)
		}
		if existing.BeaconRound != options.BeaconRound {
			return result, fmt.Errorf(
				"existing phase closure commits beacon round %d, not requested round %d",
				existing.BeaconRound,
				options.BeaconRound,
			)
		}
		if err := ValidateClose(trusted.Definition, chain, existing); err != nil {
			return result, fmt.Errorf("validate existing atomic phase closure: %w", err)
		}
		// A previous attempt may have completed the no-replace rename but
		// returned after a persistent parent-directory fsync failure. Re-sync
		// the phase directory before reporting an exact committed retry as
		// successful.
		if err := syncDirectory(phaseDir); err != nil {
			return result, fmt.Errorf("recover existing phase closure durability: %w", err)
		}
		result.Close = existing
		return result, nil
	} else if !errors.Is(statErr, fs.ErrNotExist) {
		return result, fmt.Errorf("inspect phase closure destination: %w", statErr)
	}

	roundTime, err := QuicknetRoundTime(options.BeaconRound)
	if err != nil {
		return result, err
	}
	closedAt := now().UTC()
	if closedAt.IsZero() {
		return result, errors.New("closure clock returned the zero time")
	}
	closeRecord, err := NewCloseRecord(CloseRecord{
		CeremonyID:           trusted.Definition.CeremonyID,
		Phase:                options.Phase,
		PhaseID:              chain.PhaseID,
		FinalIndex:           uint8(len(chain.Records)),
		FinalPayload:         headPayload,
		ChainHeadID:          headID,
		AcceptedParticipants: participants,
		BeaconProvider:       trusted.Definition.BeaconPolicy.Provider,
		BeaconNetwork:        trusted.Definition.BeaconPolicy.Network,
		BeaconRound:          options.BeaconRound,
		BeaconNotBefore:      roundTime.Format(time.RFC3339Nano),
		ClosedAt:             closedAt.Format(time.RFC3339Nano),
		CoordinatorID:        trusted.Definition.Coordinator.ID,
		CoordinatorKeyID:     trusted.Definition.Coordinator.KeyID,
	})
	if err != nil {
		return result, err
	}
	if err := ValidateClose(trusted.Definition, chain, closeRecord); err != nil {
		return result, err
	}

	stagingDir, err := os.MkdirTemp(phaseDir, ".closure.staging-")
	if err != nil {
		return result, fmt.Errorf("create phase closure staging directory: %w", err)
	}
	defer func() {
		_ = os.RemoveAll(stagingDir)
	}()
	stagedRecord := filepath.Join(stagingDir, closeRecordFilename)
	stagedSignature := filepath.Join(stagingDir, closeSignatureFilename)
	if err := writeSignedRecordNoReplace(
		stagedRecord,
		stagedSignature,
		closeRecord,
		trusted.Definition.Coordinator.KeyID,
		privateKey,
	); err != nil {
		return result, err
	}

	if err := publishDirectoryNoReplaceOrExactGuarded(
		stagingDir,
		closeDir,
		func() error {
			return validateCloseCommitTime(
				closedAt,
				now().UTC(),
				roundTime,
				trusted.Definition.BeaconPolicy.MinimumWitnessLeadSeconds,
			)
		},
	); err != nil {
		return result, fmt.Errorf("atomically publish phase closure: %w", err)
	}
	result.Close = closeRecord
	return result, nil
}

func validateCloseCommitTime(
	closedAt time.Time,
	commitTime time.Time,
	roundTime time.Time,
	minimumWitnessLeadSeconds uint32,
) error {
	if closedAt.IsZero() {
		return errors.New("closure clock returned the zero time")
	}
	if commitTime.IsZero() {
		return errors.New("closure clock returned the zero time before publication")
	}
	if commitTime.Before(closedAt) {
		return errors.New("closure clock moved backwards before publication")
	}
	minimumLead := time.Duration(minimumWitnessLeadSeconds) * time.Second
	requiredLead := minimumLead + closePublicationSafetyMargin
	if roundTime.Sub(commitTime) < requiredLead {
		return fmt.Errorf(
			"beacon round lead at closure publication %s is below required %s (signed witness lead %s plus publication margin %s)",
			roundTime.Sub(commitTime),
			requiredLead,
			minimumLead,
			closePublicationSafetyMargin,
		)
	}
	return nil
}

type RecordBeaconFilesOptions struct {
	Trust                     TrustPaths
	TranscriptRoot            string
	Phase                     Phase
	ClosePath                 string
	CloseSignaturePath        string
	RawResponsePath           string
	PublishedAt               string
	CoordinatorPrivateKeyPath string
}

type RecordBeaconFilesResult struct {
	Beacon          BeaconRecord
	RawResponsePath string
	BeaconPath      string
	SignaturePath   string
}

// RecordBeaconFiles strictly verifies a local drand response against the
// definition-pinned quicknet key and scheme, derives its randomness from the
// verified signature, and preserves the raw response for independent replay.
func RecordBeaconFiles(options RecordBeaconFilesOptions) (result RecordBeaconFilesResult, err error) {
	trusted, err := loadOperationalCeremony(options.Trust)
	if err != nil {
		return result, err
	}
	if err := options.Phase.Validate(); err != nil {
		return result, err
	}
	if strings.TrimSpace(options.TranscriptRoot) == "" {
		return result, errors.New("transcript root is required")
	}
	var closeRecord CloseRecord
	if err := loadCoordinatorSignedRecord(
		trusted,
		options.ClosePath,
		options.CloseSignaturePath,
		&closeRecord,
	); err != nil {
		return result, fmt.Errorf("load signed close record: %w", err)
	}
	if closeRecord.Phase != options.Phase {
		return result, fmt.Errorf("close record phase is %q, want %q", closeRecord.Phase, options.Phase)
	}
	if closeRecord.CeremonyID != trusted.Definition.CeremonyID {
		return result, errors.New("close record ceremony does not match signed definition")
	}
	privateKey, _, err := loadMatchingPrivateKey(
		options.CoordinatorPrivateKeyPath,
		trusted.Definition.Coordinator,
	)
	if err != nil {
		return result, fmt.Errorf("coordinator signing key: %w", err)
	}
	rawResponse, err := readRegularBounded(options.RawResponsePath, maxDrandResponseBytes)
	if err != nil {
		return result, fmt.Errorf("read raw beacon response: %w", err)
	}
	if len(rawResponse) == 0 {
		return result, errors.New("raw beacon response must not be empty")
	}
	randomnessHex, err := VerifyDrandBeaconResponse(
		trusted.Definition.BeaconPolicy,
		closeRecord.BeaconRound,
		rawResponse,
	)
	if err != nil {
		return result, fmt.Errorf("verify raw drand response: %w", err)
	}

	evidenceDir := filepath.Join(options.TranscriptRoot, string(options.Phase), "beacon")
	createdEvidence, err := makeOrResumePrivateDir(evidenceDir)
	if err != nil {
		return result, fmt.Errorf("create or resume beacon evidence directory: %w", err)
	}
	defer func() {
		if err != nil && createdEvidence && !publicationWasCommitted(err) {
			_ = os.RemoveAll(evidenceDir)
			_ = syncDirectory(filepath.Dir(evidenceDir))
		}
	}()
	if err := requireDirectoryEntriesSubset(evidenceDir, []string{
		"raw-response.bin",
		"record.json",
		"record.sig",
	}); err != nil {
		return result, err
	}
	result.RawResponsePath = filepath.Join(evidenceDir, "raw-response.bin")
	result.BeaconPath = filepath.Join(evidenceDir, "record.json")
	result.SignaturePath = filepath.Join(evidenceDir, "record.sig")
	rawName, err := logicalPathWithin(options.TranscriptRoot, result.RawResponsePath)
	if err != nil {
		return result, err
	}
	rawRef := ArtifactRef{Name: rawName, Digest: digestBytes(rawResponse)}
	beacon, err := NewBeaconRecord(BeaconRecord{
		CeremonyID:    trusted.Definition.CeremonyID,
		Phase:         options.Phase,
		PhaseID:       closeRecord.PhaseID,
		CloseID:       closeRecord.CloseID,
		Provider:      closeRecord.BeaconProvider,
		Network:       closeRecord.BeaconNetwork,
		Round:         closeRecord.BeaconRound,
		PublishedAt:   options.PublishedAt,
		RawResponse:   rawRef,
		RandomnessHex: randomnessHex,
	})
	if err != nil {
		return result, fmt.Errorf("create beacon record: %w", err)
	}
	if err := ValidateBeacon(trusted.Definition, closeRecord, beacon); err != nil {
		return result, fmt.Errorf("validate beacon record: %w", err)
	}
	beaconBytes, beaconSignatureBytes, err := SignRecord(
		beacon,
		trusted.Definition.Coordinator.KeyID,
		privateKey,
	)
	if err != nil {
		return result, err
	}
	for _, item := range []struct {
		path    string
		data    []byte
		maximum int64
	}{
		{result.RawResponsePath, rawResponse, maxDrandResponseBytes},
		{result.SignaturePath, beaconSignatureBytes, maxSignedRecordBytes},
		{result.BeaconPath, beaconBytes, maxSignedRecordBytes},
	} {
		if err := requireAbsentOrExact(item.path, item.data, item.maximum); err != nil {
			return result, err
		}
	}
	if err := writeBytesNoReplaceOrExact(
		result.RawResponsePath,
		rawResponse,
		0o600,
		maxDrandResponseBytes,
	); err != nil {
		return result, fmt.Errorf("write raw beacon response: %w", err)
	}
	if err := writeSignedRecordNoReplace(
		result.BeaconPath,
		result.SignaturePath,
		beacon,
		trusted.Definition.Coordinator.KeyID,
		privateKey,
	); err != nil {
		return result, err
	}
	result.Beacon = beacon
	createdEvidence = false
	return result, nil
}

type SealPhase1FilesOptions struct {
	Trust                     TrustPaths
	Circuit                   *CompiledCircuit
	TranscriptRoot            string
	ClosePath                 string
	CloseSignaturePath        string
	BeaconPath                string
	BeaconSignaturePath       string
	CoordinatorPrivateKeyPath string
	OutputDir                 string
}

type SealPhase1FilesResult struct {
	Seal          SealRecord
	CommonsPath   string
	SealPath      string
	SignaturePath string
}

// SealPhase1Files verifies the signed closure and future beacon, replays Phase
// 1 from immutable files, and publishes native commons plus a signed seal.
func SealPhase1Files(options SealPhase1FilesOptions) (result SealPhase1FilesResult, err error) {
	trusted, err := loadOperationalCeremony(options.Trust)
	if err != nil {
		return result, err
	}
	if err := validateWorkflowCircuit(trusted, options.Circuit); err != nil {
		return result, err
	}
	var closeRecord CloseRecord
	if err := loadCoordinatorSignedRecord(trusted, options.ClosePath, options.CloseSignaturePath, &closeRecord); err != nil {
		return result, err
	}
	var beacon BeaconRecord
	if err := loadCoordinatorSignedRecord(trusted, options.BeaconPath, options.BeaconSignaturePath, &beacon); err != nil {
		return result, err
	}
	if closeRecord.Phase != Phase1 {
		return result, errors.New("Phase 1 seal received a non-Phase-1 close record")
	}
	chainPath := filepath.Join(options.TranscriptRoot, "phase1", fmt.Sprintf("chain-%04d.json", closeRecord.FinalIndex))
	chainPaths := PhaseTranscriptPaths{
		RootDir:            options.TranscriptRoot,
		ChainPath:          chainPath,
		ChainSignaturePath: DefaultSignaturePath(chainPath),
	}
	chain, replayedHead, err := loadReplayPhase1FilesState(trusted, options.Circuit, chainPaths)
	if err != nil {
		return result, err
	}
	if err := ValidateClose(trusted.Definition, chain, closeRecord); err != nil {
		return result, err
	}
	if err := ValidateBeacon(trusted.Definition, closeRecord, beacon); err != nil {
		return result, err
	}
	if err := VerifyBeaconRecordFiles(trusted, options.TranscriptRoot, closeRecord, beacon); err != nil {
		return result, fmt.Errorf("verify archived Phase 1 beacon response: %w", err)
	}
	challenge, err := hex.DecodeString(beacon.ChallengeHex)
	if err != nil || len(challenge) != contributionChallengeSize {
		return result, fmt.Errorf("Phase 1 beacon challenge must be exactly %d bytes", contributionChallengeSize)
	}
	privateKey, _, err := loadMatchingPrivateKey(options.CoordinatorPrivateKeyPath, trusted.Definition.Coordinator)
	if err != nil {
		return result, err
	}
	commons, err := sealReplayedPhase1Head(
		options.Circuit.Binding.DomainSize,
		challenge,
		replayedHead,
	)
	if err != nil {
		return result, err
	}
	createdOutput, err := makeOrResumePrivateDir(options.OutputDir)
	if err != nil {
		return result, fmt.Errorf("create or resume Phase 1 seal directory: %w", err)
	}
	defer func() {
		if err != nil && createdOutput && !publicationWasCommitted(err) {
			_ = os.RemoveAll(options.OutputDir)
			_ = syncDirectory(filepath.Dir(options.OutputDir))
		}
	}()
	if err := requireDirectoryEntriesSubset(options.OutputDir, []string{
		"commons.bin",
		"seal.json",
		"seal.sig",
	}); err != nil {
		return result, err
	}
	result.CommonsPath = filepath.Join(options.OutputDir, "commons.bin")
	result.SealPath = filepath.Join(options.OutputDir, "seal.json")
	result.SignaturePath = filepath.Join(options.OutputDir, "seal.sig")
	expectedCommons, err := writerDigest(commons)
	if err != nil {
		return result, err
	}
	commonsName, err := logicalPathWithin(options.TranscriptRoot, result.CommonsPath)
	if err != nil {
		return result, err
	}
	commonsRef := ArtifactRef{Name: commonsName, Digest: expectedCommons}
	seal, err := NewSealRecord(SealRecord{
		CeremonyID:   trusted.Definition.CeremonyID,
		Phase:        Phase1,
		PhaseID:      closeRecord.PhaseID,
		CloseID:      closeRecord.CloseID,
		BeaconID:     beacon.BeaconID,
		FinalPayload: closeRecord.FinalPayload,
		Outputs:      []ArtifactRef{commonsRef},
		SealedAt:     beacon.PublishedAt,
	})
	if err != nil {
		return result, err
	}
	if err := ValidateSeal(closeRecord, beacon, seal); err != nil {
		return result, err
	}
	sealBytes, sealSignatureBytes, err := SignRecord(
		seal,
		trusted.Definition.Coordinator.KeyID,
		privateKey,
	)
	if err != nil {
		return result, err
	}
	if err := requireAbsentOrExactCommons(
		result.CommonsPath,
		CommonsShape{DomainN: options.Circuit.Binding.DomainSize},
		expectedCommons,
	); err != nil {
		return result, err
	}
	if err := requireAbsentOrExact(result.SignaturePath, sealSignatureBytes, maxSignedRecordBytes); err != nil {
		return result, err
	}
	if err := requireAbsentOrExact(result.SealPath, sealBytes, maxSignedRecordBytes); err != nil {
		return result, err
	}
	if _, err := writeCommonsFileNoReplaceOrExact(
		result.CommonsPath,
		commons,
		CommonsShape{DomainN: options.Circuit.Binding.DomainSize},
		expectedCommons,
	); err != nil {
		return result, err
	}
	if err := writeSignedRecordNoReplace(
		result.SealPath,
		result.SignaturePath,
		seal,
		trusted.Definition.Coordinator.KeyID,
		privateKey,
	); err != nil {
		return result, err
	}
	result.Seal = seal
	createdOutput = false
	return result, nil
}

type InitPhase2FilesOptions struct {
	Trust                     TrustPaths
	Circuit                   *CompiledCircuit
	TranscriptRoot            string
	Phase1SealPath            string
	Phase1SealSignaturePath   string
	CoordinatorPrivateKeyPath string
	OutputDir                 string
}

type InitPhase2FilesResult struct {
	Chain              Chain
	GenesisPath        string
	ChainPath          string
	ChainSignaturePath string
}

// InitializePhase2Files binds signed Phase 1 commons to the exact local R1CS
// and publishes deterministic Phase 2 genesis and its signed chain.
func InitializePhase2Files(options InitPhase2FilesOptions) (result InitPhase2FilesResult, err error) {
	trusted, err := loadOperationalCeremony(options.Trust)
	if err != nil {
		return result, err
	}
	if err := validateWorkflowCircuit(trusted, options.Circuit); err != nil {
		return result, err
	}
	commons, phase1Seal, _, err := loadPhase1CommonsForPhase2(
		trusted,
		options.Circuit,
		options.TranscriptRoot,
		options.Phase1SealPath,
		options.Phase1SealSignaturePath,
	)
	if err != nil {
		return result, err
	}
	privateKey, _, err := loadMatchingPrivateKey(options.CoordinatorPrivateKeyPath, trusted.Definition.Coordinator)
	if err != nil {
		return result, err
	}
	initial, shape, err := InitializePhase2(options.Circuit, commons)
	if err != nil {
		return result, err
	}
	if !equalPhase2Shape(shape, options.Circuit.Binding.Phase2Shape) {
		return result, errors.New("initialized Phase 2 shape differs from signed circuit binding")
	}
	createdOutput, err := makeOrResumePrivateDir(options.OutputDir)
	if err != nil {
		return result, fmt.Errorf("create or resume Phase 2 directory: %w", err)
	}
	defer func() {
		if err != nil && createdOutput && !publicationWasCommitted(err) {
			_ = os.RemoveAll(options.OutputDir)
			_ = syncDirectory(filepath.Dir(options.OutputDir))
		}
	}()
	if err := requireDirectoryEntriesSubset(options.OutputDir, []string{
		"genesis.bin",
		"chain-0000.json",
		"chain-0000.sig",
	}); err != nil {
		return result, err
	}
	result.GenesisPath = filepath.Join(options.OutputDir, "genesis.bin")
	result.ChainPath = filepath.Join(options.OutputDir, "chain-0000.json")
	result.ChainSignaturePath = filepath.Join(options.OutputDir, "chain-0000.sig")
	expectedGenesis, err := writerDigest(initial)
	if err != nil {
		return result, err
	}
	genesisName, err := logicalPathWithin(options.TranscriptRoot, result.GenesisPath)
	if err != nil {
		return result, err
	}
	genesisRef := ArtifactRef{Name: genesisName, Digest: expectedGenesis}
	phaseID, err := ComputePhaseID(
		trusted.Definition.CeremonyID,
		Phase2,
		genesisRef,
		phase1Seal.SealID,
	)
	if err != nil {
		return result, err
	}
	chain, err := NewChain(trusted.Definition.CeremonyID, Phase2, phaseID, genesisRef)
	if err != nil {
		return result, err
	}
	chainBytes, chainSignatureBytes, err := SignRecord(
		chain,
		trusted.Definition.Coordinator.KeyID,
		privateKey,
	)
	if err != nil {
		return result, err
	}
	if err := requireAbsentOrExactPhase2(result.GenesisPath, shape, expectedGenesis); err != nil {
		return result, err
	}
	if err := requireAbsentOrExact(result.ChainSignaturePath, chainSignatureBytes, maxSignedRecordBytes); err != nil {
		return result, err
	}
	if err := requireAbsentOrExact(result.ChainPath, chainBytes, maxSignedRecordBytes); err != nil {
		return result, err
	}
	if _, err := writePhase2FileNoReplaceOrExact(
		result.GenesisPath,
		initial,
		shape,
		expectedGenesis,
	); err != nil {
		return result, err
	}
	if err := writeSignedRecordNoReplace(
		result.ChainPath,
		result.ChainSignaturePath,
		chain,
		trusted.Definition.Coordinator.KeyID,
		privateKey,
	); err != nil {
		return result, err
	}
	result.Chain = chain
	createdOutput = false
	return result, nil
}

type contributionNames struct {
	Payload              string
	Attestation          string
	AttestationSignature string
	Erasure              string
	ErasureSignature     string
	Verification         string
}

func contributionLogicalNames(phase Phase, index int) contributionNames {
	base := fmt.Sprintf("%s/contributions/%04d", phase, index)
	return contributionNames{
		Payload:              base + "/contribution.bin",
		Attestation:          base + "/attestation.json",
		AttestationSignature: base + "/attestation.sig",
		Erasure:              base + "/erasure.json",
		ErasureSignature:     base + "/erasure.sig",
		Verification:         base + "/verification.json",
	}
}

func validateTrustedCeremony(trusted *TrustedCeremony) error {
	if trusted == nil {
		return errors.New("trusted ceremony is required")
	}
	if err := trusted.Definition.Validate(); err != nil {
		return err
	}
	if len(trusted.CoordinatorPublicKey) != ed25519.PublicKeySize {
		return errors.New("trusted coordinator public key is invalid")
	}
	return nil
}

func validateWorkflowCircuit(trusted *TrustedCeremony, circuit *CompiledCircuit) error {
	if err := validateTrustedCeremony(trusted); err != nil {
		return err
	}
	return ValidateCircuitBinding(circuit, trusted.Definition.Circuit)
}

func validateUnboundPhasePolicy(policy PhasePolicy) error {
	if len(policy.Participants) == 0 {
		return errors.New("phase participants must not be empty")
	}
	if len(policy.Participants) > MaxParticipants {
		return fmt.Errorf("phase participants exceed maximum %d", MaxParticipants)
	}
	if policy.Minimum == 0 || int(policy.Minimum) > len(policy.Participants) {
		return fmt.Errorf("phase minimum %d must be between 1 and %d", policy.Minimum, len(policy.Participants))
	}
	seen := make(map[string]struct{}, len(policy.Participants))
	for index, participantID := range policy.Participants {
		if err := validateID("phase participant", participantID); err != nil {
			return fmt.Errorf("phase participant %d: %w", index, err)
		}
		if _, duplicate := seen[participantID]; duplicate {
			return fmt.Errorf("phase participant %q is duplicated", participantID)
		}
		seen[participantID] = struct{}{}
	}
	return nil
}

func loadCanonicalInput(path string, destination any) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("canonical input path is required")
	}
	data, err := readRegularBounded(path, maxSignedRecordBytes)
	if err != nil {
		return err
	}
	return UnmarshalCanonical(data, destination)
}

func loadCoordinatorSignedRecord(trusted *TrustedCeremony, recordPath, signaturePath string, destination any) error {
	if strings.TrimSpace(recordPath) == "" || strings.TrimSpace(signaturePath) == "" {
		return errors.New("record and signature paths are required")
	}
	recordBytes, err := readRegularBounded(recordPath, maxSignedRecordBytes)
	if err != nil {
		return err
	}
	signatureBytes, err := readRegularBounded(signaturePath, maxSignedRecordBytes)
	if err != nil {
		return err
	}
	return VerifySignedRecord(
		recordBytes,
		signatureBytes,
		destination,
		trusted.Definition.Coordinator.KeyID,
		trusted.CoordinatorPublicKey,
	)
}

func loadExternalPublicKey(path string) (ed25519.PublicKey, error) {
	raw, err := readRegularBounded(path, 4096)
	if err != nil {
		return nil, err
	}
	return keybundle.DecodePublicKeyHex(strings.TrimSpace(string(raw)))
}

func identityPublicKey(identity Identity) (ed25519.PublicKey, error) {
	raw, err := keybundle.DecodePublicKeyHex(identity.Ed25519PublicKeyHex)
	if err != nil {
		return nil, err
	}
	if identity.PublicKeyFingerprint != taggedSHA256(raw) {
		return nil, errors.New("identity public-key fingerprint mismatch")
	}
	return raw, nil
}

func loadMatchingPrivateKey(path string, identity Identity) (ed25519.PrivateKey, ed25519.PublicKey, error) {
	privateKey, publicKey, err := keybundle.LoadExistingPrivateKey(path)
	if err != nil {
		return nil, nil, err
	}
	expected, err := identityPublicKey(identity)
	if err != nil {
		return nil, nil, err
	}
	if !bytes.Equal(publicKey, expected) {
		return nil, nil, fmt.Errorf("private key does not match identity %q", identity.ID)
	}
	return privateKey, publicKey, nil
}

func readRegularBounded(path string, max int64) ([]byte, error) {
	linkInfo, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("inspect %q: %w", path, err)
	}
	if linkInfo.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("%q must not be a symbolic link", path)
	}
	if !linkInfo.Mode().IsRegular() {
		return nil, fmt.Errorf("%q is not a regular file", path)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %q: %w", path, err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat %q: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%q is not a regular file", path)
	}
	if !os.SameFile(linkInfo, info) {
		return nil, fmt.Errorf("%q changed while being opened", path)
	}
	if info.Size() <= 0 || info.Size() > max {
		return nil, fmt.Errorf("%q size %d is outside [1,%d]", path, info.Size(), max)
	}
	data := make([]byte, info.Size())
	if _, err := io.ReadFull(f, data); err != nil {
		return nil, fmt.Errorf("read %q: %w", path, err)
	}
	var extra [1]byte
	if n, err := f.Read(extra[:]); n != 0 || (err != nil && !errors.Is(err, io.EOF)) {
		return nil, fmt.Errorf("%q changed while being read", path)
	}
	return data, nil
}

func writeSignedRecordNoReplace(recordPath, signaturePath string, record any, keyID string, privateKey ed25519.PrivateKey) error {
	recordBytes, signatureBytes, err := SignRecord(record, keyID, privateKey)
	if err != nil {
		return err
	}
	// Preflight both destinations before publishing either one. Existing
	// byte-identical artifacts are an interrupted publication that this call
	// may safely resume; any mismatch is preserved and rejected.
	if err := requireAbsentOrExact(signaturePath, signatureBytes, maxSignedRecordBytes); err != nil {
		return err
	}
	if err := requireAbsentOrExact(recordPath, recordBytes, maxSignedRecordBytes); err != nil {
		return err
	}
	// Publish the detached signature first and the authenticated record last.
	// A failure can therefore never expose a newly published record without
	// its signature. Retrying completes an exact signature-only prefix.
	if err := writeBytesNoReplaceOrExact(signaturePath, signatureBytes, 0o600, maxSignedRecordBytes); err != nil {
		return err
	}
	if err := writeBytesNoReplaceOrExact(recordPath, recordBytes, 0o600, maxSignedRecordBytes); err != nil {
		return err
	}
	return nil
}

func requireAbsentOrExact(path string, expected []byte, maximum int64) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("output path is required")
	}
	if _, err := os.Lstat(path); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	actual, err := readRegularBounded(path, maximum)
	if err != nil {
		return err
	}
	if !bytes.Equal(actual, expected) {
		return fmt.Errorf("existing output %q differs from the exact retry artifact: %w", path, fs.ErrExist)
	}
	return nil
}

func writeBytesNoReplaceOrExact(path string, data []byte, mode fs.FileMode, maximum int64) error {
	if err := writeBytesNoReplace(path, data, mode); err == nil {
		return nil
	} else if !errors.Is(err, fs.ErrExist) {
		return err
	}
	return requireAbsentOrExact(path, data, maximum)
}

func writePhase1FileNoReplaceOrExact(
	path string,
	artifact *gnarkmpc.Phase1,
	shape Phase1Shape,
	expected Digest,
) (ArtifactDigest, error) {
	digest, err := WritePhase1FileNoReplace(path, artifact, shape)
	if err == nil {
		if modelDigest(digest) != expected {
			return ArtifactDigest{}, errors.New("published Phase 1 artifact differs from expected digest")
		}
		return digest, nil
	}
	if !errors.Is(err, fs.ErrExist) {
		return ArtifactDigest{}, err
	}
	if err := requireAbsentOrExactPhase1(path, shape, expected); err != nil {
		return ArtifactDigest{}, err
	}
	_, digest, err = ReadPhase1File(path, shape)
	if err != nil {
		return ArtifactDigest{}, fmt.Errorf("existing Phase 1 retry artifact: %w", err)
	}
	return digest, nil
}

func requireAbsentOrExactPhase1(path string, shape Phase1Shape, expected Digest) error {
	if _, err := os.Lstat(path); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	_, digest, err := ReadPhase1File(path, shape)
	if err != nil {
		return fmt.Errorf("existing Phase 1 retry artifact: %w", err)
	}
	if modelDigest(digest) != expected {
		return fmt.Errorf("existing Phase 1 retry artifact differs from expected digest: %w", fs.ErrExist)
	}
	return nil
}

func writePhase2FileNoReplaceOrExact(
	path string,
	artifact *gnarkmpc.Phase2,
	shape Phase2Shape,
	expected Digest,
) (ArtifactDigest, error) {
	digest, err := WritePhase2FileNoReplace(path, artifact, shape)
	if err == nil {
		if modelDigest(digest) != expected {
			return ArtifactDigest{}, errors.New("published Phase 2 artifact differs from expected digest")
		}
		return digest, nil
	}
	if !errors.Is(err, fs.ErrExist) {
		return ArtifactDigest{}, err
	}
	if err := requireAbsentOrExactPhase2(path, shape, expected); err != nil {
		return ArtifactDigest{}, err
	}
	_, digest, err = ReadPhase2File(path, shape)
	if err != nil {
		return ArtifactDigest{}, fmt.Errorf("existing Phase 2 retry artifact: %w", err)
	}
	return digest, nil
}

func requireAbsentOrExactPhase2(path string, shape Phase2Shape, expected Digest) error {
	if _, err := os.Lstat(path); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	_, digest, err := ReadPhase2File(path, shape)
	if err != nil {
		return fmt.Errorf("existing Phase 2 retry artifact: %w", err)
	}
	if modelDigest(digest) != expected {
		return fmt.Errorf("existing Phase 2 retry artifact differs from expected digest: %w", fs.ErrExist)
	}
	return nil
}

func writeCommonsFileNoReplaceOrExact(
	path string,
	artifact *gnarkmpc.SrsCommons,
	shape CommonsShape,
	expected Digest,
) (ArtifactDigest, error) {
	digest, err := WriteCommonsFileNoReplace(path, artifact, shape)
	if err == nil {
		if modelDigest(digest) != expected {
			return ArtifactDigest{}, errors.New("published commons artifact differs from expected digest")
		}
		return digest, nil
	}
	if !errors.Is(err, fs.ErrExist) {
		return ArtifactDigest{}, err
	}
	if err := requireAbsentOrExactCommons(path, shape, expected); err != nil {
		return ArtifactDigest{}, err
	}
	_, digest, err = ReadCommonsFile(path, shape)
	if err != nil {
		return ArtifactDigest{}, fmt.Errorf("existing commons retry artifact: %w", err)
	}
	return digest, nil
}

func requireAbsentOrExactCommons(path string, shape CommonsShape, expected Digest) error {
	if _, err := os.Lstat(path); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	_, digest, err := ReadCommonsFile(path, shape)
	if err != nil {
		return fmt.Errorf("existing commons retry artifact: %w", err)
	}
	if modelDigest(digest) != expected {
		return fmt.Errorf("existing commons retry artifact differs from expected digest: %w", fs.ErrExist)
	}
	return nil
}

func makeOrResumePrivateDir(path string) (created bool, err error) {
	if strings.TrimSpace(path) == "" {
		return false, errors.New("output directory is required")
	}
	if err := os.Mkdir(path, 0o700); err == nil {
		if err := syncDirectory(filepath.Dir(path)); err != nil {
			_ = os.Remove(path)
			_ = syncDirectory(filepath.Dir(path))
			return false, err
		}
		return true, nil
	} else if !errors.Is(err, fs.ErrExist) {
		return false, err
	}
	return false, requirePrivateRealDirectory(path)
}

func requirePrivateRealDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("retry output %q is not a real directory", path)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("retry output directory %q has group/world permissions", path)
	}
	return nil
}

func requireDirectoryEntriesSubset(dir string, allowed []string) error {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, name := range allowed {
		if filepath.Base(name) != name || name == "." || name == "" {
			return fmt.Errorf("invalid allowed retry entry %q", name)
		}
		allowedSet[name] = struct{}{}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	removedTemporary := false
	for _, entry := range entries {
		if _, ok := allowedSet[entry.Name()]; ok {
			continue
		}
		temporary := false
		for name := range allowedSet {
			if strings.HasPrefix(entry.Name(), "."+name+".partial-") {
				temporary = true
				break
			}
		}
		if !temporary {
			return fmt.Errorf("retry directory %q contains unexpected entry %q", dir, entry.Name())
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("retry temporary entry %q is not a regular file", entry.Name())
		}
		if err := os.Remove(filepath.Join(dir, entry.Name())); err != nil {
			return fmt.Errorf("remove unpublished retry temporary %q: %w", entry.Name(), err)
		}
		removedTemporary = true
	}
	if removedTemporary {
		return syncDirectory(dir)
	}
	return nil
}

func mkdirAllPrivateDurable(path string) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("directory path is required")
	}
	info, err := os.Lstat(path)
	if err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("directory path %q is not a real directory", path)
		}
		return nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	parent := filepath.Dir(path)
	if parent == path {
		return fmt.Errorf("cannot create directory root %q", path)
	}
	if err := mkdirAllPrivateDurable(parent); err != nil {
		return err
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		if !errors.Is(err, fs.ErrExist) {
			return err
		}
		if info, statErr := os.Lstat(path); statErr != nil ||
			!info.IsDir() ||
			info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("concurrent directory creation for %q was not a real directory", path)
		}
		return nil
	}
	if err := syncDirectory(parent); err != nil {
		_ = os.Remove(path)
		_ = syncDirectory(parent)
		return err
	}
	return nil
}

func writeWriterToNoReplace(path string, src io.WriterTo, expected Digest) (ArtifactDigest, error) {
	if err := expected.Validate(); err != nil {
		return ArtifactDigest{}, err
	}
	return atomicWriteNoReplace(
		path,
		expected.Size,
		src.WriteTo,
		func(tempPath string) (ArtifactDigest, error) {
			digest, err := digestRegularFile(tempPath, expected.Size)
			if err != nil {
				return ArtifactDigest{}, err
			}
			if modelDigest(digest) != expected {
				return ArtifactDigest{}, errors.New("native artifact digest differs from expected binding")
			}
			return digest, nil
		},
	)
}

func digestRegularFile(path string, expectedSize int64) (ArtifactDigest, error) {
	f, err := openRegularExact(path, expectedSize)
	if err != nil {
		return ArtifactDigest{}, err
	}
	defer f.Close()
	dataHash := newDualHash()
	n, err := io.Copy(dataHash, f)
	if err != nil {
		return ArtifactDigest{}, err
	}
	if n != expectedSize {
		return ArtifactDigest{}, fmt.Errorf("hashed %d bytes, expected %d", n, expectedSize)
	}
	return dataHash.digest(n, nil), nil
}

type dualHash struct {
	sha   hashWriter
	blake hashWriter
}

type hashWriter interface {
	io.Writer
	Sum([]byte) []byte
}

func newDualHash() *dualHash {
	blake, _ := blake2bNew256()
	return &dualHash{sha: sha256.New(), blake: blake}
}

func (h *dualHash) Write(p []byte) (int, error) {
	n, err := h.sha.Write(p)
	if err != nil {
		return n, err
	}
	n2, err := h.blake.Write(p)
	if err != nil {
		return n2, err
	}
	if n2 != n {
		return n2, io.ErrShortWrite
	}
	return n, nil
}

func (h *dualHash) digest(size int64, challenge []byte) ArtifactDigest {
	var result ArtifactDigest
	result.Size = size
	copy(result.SHA256[:], h.sha.Sum(nil))
	copy(result.BLAKE2b256[:], h.blake.Sum(nil))
	result.Challenge = bytes.Clone(challenge)
	return result
}

// Kept behind a helper so the impossible nil-key initialization error has one
// audited handling point.
func blake2bNew256() (hashWriter, error) {
	return blake2b.New256(nil)
}

func artifactDigestBytes(data []byte) ArtifactDigest {
	sha := sha256.Sum256(data)
	blake := blake2b.Sum256(data)
	return ArtifactDigest{
		Size:       int64(len(data)),
		SHA256:     sha,
		BLAKE2b256: blake,
	}
}

func digestBytes(data []byte) Digest {
	return modelDigest(artifactDigestBytes(data))
}

func modelDigest(d ArtifactDigest) Digest {
	return Digest{
		SHA256:     "sha256:" + hex.EncodeToString(d.SHA256[:]),
		Blake2b256: "blake2b256:" + hex.EncodeToString(d.BLAKE2b256[:]),
		Size:       d.Size,
	}
}

func resolveArtifactPath(root, name string) (string, error) {
	if err := validateArtifactName(name); err != nil {
		return "", err
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	pathAbs, err := filepath.Abs(filepath.Join(rootAbs, filepath.FromSlash(name)))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(rootAbs, pathAbs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("artifact %q escapes transcript root", name)
	}
	if err := rejectSymlinkComponents(pathAbs); err != nil {
		return "", fmt.Errorf("artifact %q path: %w", name, err)
	}
	return pathAbs, nil
}

func logicalPathWithin(root, path string) (string, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	pathAbs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(rootAbs, pathAbs)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("output path must be inside the transcript root")
	}
	if err := rejectSymlinkComponents(pathAbs); err != nil {
		return "", fmt.Errorf("output path: %w", err)
	}
	name := filepath.ToSlash(rel)
	if err := validateArtifactName(name); err != nil {
		return "", err
	}
	return name, nil
}

// rejectSymlinkComponents is the portable transcript path defense. It rejects
// every existing symlink component before an open. It does not claim the
// race-free guarantee of Linux openat2 with RESOLVE_NO_SYMLINKS.
func rejectSymlinkComponents(path string) error {
	pathAbs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	volume := filepath.VolumeName(pathAbs)
	remainder := strings.TrimPrefix(pathAbs, volume)
	remainder = strings.TrimLeft(remainder, string(filepath.Separator))
	current := volume + string(filepath.Separator)
	parts := strings.Split(remainder, string(filepath.Separator))
	for index, part := range parts {
		if part == "" || part == "." {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) {
			// Missing descendants cannot currently redirect resolution.
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("symbolic-link component %q is forbidden", current)
		}
		if index < len(parts)-1 && !info.IsDir() {
			return fmt.Errorf("path component %q is not a directory", current)
		}
	}
	return nil
}

func verifyArtifactBytes(root string, ref ArtifactRef, max int64) ([]byte, error) {
	path, err := resolveArtifactPath(root, ref.Name)
	if err != nil {
		return nil, err
	}
	data, err := readRegularBounded(path, max)
	if err != nil {
		return nil, err
	}
	if digestBytes(data) != ref.Digest {
		return nil, fmt.Errorf("artifact %q digest mismatch", ref.Name)
	}
	return data, nil
}

func verifyChainFiles(trusted *TrustedCeremony, root string, chain Chain, basePhase2Shape Phase2Shape) error {
	if chain.Phase == Phase1 {
		path, err := resolveArtifactPath(root, chain.Genesis.Name)
		if err != nil {
			return err
		}
		_, digest, err := ReadPhase1File(path, Phase1Shape{DomainN: trusted.Definition.Circuit.DomainSize})
		if err != nil {
			return err
		}
		if modelDigest(digest) != chain.Genesis.Digest {
			return errors.New("Phase 1 genesis digest mismatch")
		}
	} else {
		path, err := resolveArtifactPath(root, chain.Genesis.Name)
		if err != nil {
			return err
		}
		shape := basePhase2Shape
		shape.ChallengeLength = 0
		_, digest, err := ReadPhase2File(path, shape)
		if err != nil {
			return err
		}
		if modelDigest(digest) != chain.Genesis.Digest {
			return errors.New("Phase 2 genesis digest mismatch")
		}
	}

	prefix := chain
	prefix.Records = nil
	previous := chain.Genesis
	for i, record := range chain.Records {
		path, err := resolveArtifactPath(root, record.OutputPayload.Name)
		if err != nil {
			return err
		}
		var nativeDigest ArtifactDigest
		switch chain.Phase {
		case Phase1:
			_, nativeDigest, err = ReadPhase1File(path, Phase1Shape{
				DomainN:         trusted.Definition.Circuit.DomainSize,
				ChallengeLength: contributionChallengeSize,
			})
		case Phase2:
			shape := contributionPhase2Shape(basePhase2Shape)
			_, nativeDigest, err = ReadPhase2File(path, shape)
		}
		if err != nil {
			return fmt.Errorf("record %d native payload: %w", i, err)
		}
		if modelDigest(nativeDigest) != record.OutputPayload.Digest {
			return fmt.Errorf("record %d output payload digest mismatch", i)
		}
		if err := requireChallengeMatchesDigest(nativeDigest.Challenge, previous.Digest); err != nil {
			return fmt.Errorf("record %d: %w", i, err)
		}
		attestationBytes, err := verifyArtifactBytes(root, record.Attestation, maxSignedRecordBytes)
		if err != nil {
			return err
		}
		signatureBytes, err := verifyArtifactBytes(root, record.AttestationSignature, maxSignedRecordBytes)
		if err != nil {
			return err
		}
		var attestation ContributionAttestation
		participant, ok := trusted.Definition.ParticipantByID(record.ParticipantID)
		if !ok {
			return fmt.Errorf("record %d participant missing", i)
		}
		publicKey, err := identityPublicKey(participant.Identity)
		if err != nil {
			return err
		}
		if err := VerifySignedRecord(
			attestationBytes,
			signatureBytes,
			&attestation,
			participant.Identity.KeyID,
			publicKey,
		); err != nil {
			return fmt.Errorf("record %d participant attestation: %w", i, err)
		}
		erasureBytes, err := verifyArtifactBytes(root, record.Erasure, maxSignedRecordBytes)
		if err != nil {
			return err
		}
		erasureSignatureBytes, err := verifyArtifactBytes(root, record.ErasureSignature, maxSignedRecordBytes)
		if err != nil {
			return err
		}
		var erasure ErasureAttestation
		if err := VerifySignedRecord(
			erasureBytes,
			erasureSignatureBytes,
			&erasure,
			participant.Identity.KeyID,
			publicKey,
		); err != nil {
			return fmt.Errorf("record %d erasure attestation: %w", i, err)
		}
		if erasure.ErasureID != record.ErasureID {
			return fmt.Errorf("record %d erasure ID mismatch", i)
		}
		if err := ValidateErasureForContribution(attestation, erasure); err != nil {
			return fmt.Errorf("record %d erasure binding: %w", i, err)
		}
		verificationBytes, err := verifyArtifactBytes(root, record.Verification, maxSignedRecordBytes)
		if err != nil {
			return err
		}
		var verification ContributionVerification
		if err := UnmarshalCanonical(verificationBytes, &verification); err != nil {
			return fmt.Errorf("record %d verification: %w", i, err)
		}
		if err := validateContributionVerification(record, verification); err != nil {
			return fmt.Errorf("record %d verification: %w", i, err)
		}
		if err := ValidateAttestationAcceptance(trusted.Definition, prefix, attestation, erasure, record); err != nil {
			return fmt.Errorf("record %d acceptance: %w", i, err)
		}
		if err := prefix.Append(record); err != nil {
			return err
		}
		previous = record.OutputPayload
	}
	return nil
}

func phase1FileLoader(root string, chain Chain, domainN uint64) Phase1Loader {
	return func(index int) (*gnarkmpc.Phase1, error) {
		if index < 0 || index >= len(chain.Records) {
			return nil, fmt.Errorf("Phase 1 contribution index %d out of range", index)
		}
		path, err := resolveArtifactPath(root, chain.Records[index].OutputPayload.Name)
		if err != nil {
			return nil, err
		}
		artifact, _, err := ReadPhase1File(path, Phase1Shape{DomainN: domainN, ChallengeLength: contributionChallengeSize})
		return artifact, err
	}
}

func phase2FileLoader(root string, chain Chain, shape Phase2Shape) Phase2Loader {
	return func(index int) (*gnarkmpc.Phase2, error) {
		if index < 0 || index >= len(chain.Records) {
			return nil, fmt.Errorf("Phase 2 contribution index %d out of range", index)
		}
		path, err := resolveArtifactPath(root, chain.Records[index].OutputPayload.Name)
		if err != nil {
			return nil, err
		}
		artifact, _, err := ReadPhase2File(path, shape)
		return artifact, err
	}
}

func appendedPhase1Loader(root string, chain Chain, domainN uint64, candidate *gnarkmpc.Phase1) Phase1Loader {
	base := phase1FileLoader(root, chain, domainN)
	return func(index int) (*gnarkmpc.Phase1, error) {
		if index == len(chain.Records) {
			return candidate, nil
		}
		return base(index)
	}
}

func appendedPhase2Loader(root string, chain Chain, shape Phase2Shape, candidate *gnarkmpc.Phase2) Phase2Loader {
	base := phase2FileLoader(root, chain, shape)
	return func(index int) (*gnarkmpc.Phase2, error) {
		if index == len(chain.Records) {
			return candidate, nil
		}
		return base(index)
	}
}

func contributionPhase2Shape(base Phase2Shape) Phase2Shape {
	shape := base
	shape.SigmaCKK = slices.Clone(base.SigmaCKK)
	shape.ChallengeLength = contributionChallengeSize
	return shape
}

func requireChallengeMatchesDigest(challenge []byte, digest Digest) error {
	if !strings.HasPrefix(digest.SHA256, "sha256:") {
		return errors.New("previous payload SHA-256 is not tagged")
	}
	raw, err := hex.DecodeString(strings.TrimPrefix(digest.SHA256, "sha256:"))
	if err != nil || len(raw) != sha256.Size {
		return errors.New("previous payload SHA-256 is invalid")
	}
	if !bytes.Equal(challenge, raw) {
		return errors.New("contribution challenge does not equal previous payload SHA-256")
	}
	return nil
}

// loadAuthenticatedPhase1CommonsForCoordinator is restricted to coordinator
// acceptance of a candidate Phase 2 edge. It authenticates the already
// published seal and commons, while loadVerifiedPhase2Files binds those
// commons to the coordinator-signed Phase 2 genesis. Participant contribution,
// initialization, closure, finalization, and audit paths must instead call
// loadPhase1CommonsForPhase2, which independently replays Phase 1 and derives
// the commons before any secret randomness is sampled.
func loadAuthenticatedPhase1CommonsForCoordinator(
	trusted *TrustedCeremony,
	circuit *CompiledCircuit,
	transcriptRoot, sealPath, sealSignaturePath string,
) (*gnarkmpc.SrsCommons, SealRecord, CloseRecord, error) {
	if strings.TrimSpace(sealPath) == "" || strings.TrimSpace(sealSignaturePath) == "" {
		return nil, SealRecord{}, CloseRecord{}, errors.New("signed Phase 1 seal paths are required")
	}
	var seal SealRecord
	if err := loadCoordinatorSignedRecord(trusted, sealPath, sealSignaturePath, &seal); err != nil {
		return nil, SealRecord{}, CloseRecord{}, err
	}
	if seal.CeremonyID != trusted.Definition.CeremonyID || seal.Phase != Phase1 {
		return nil, SealRecord{}, CloseRecord{}, errors.New("Phase 1 seal ceremony or phase mismatch")
	}
	closePath := filepath.Join(
		transcriptRoot,
		string(Phase1),
		closePublicationDirectoryName,
		closeRecordFilename,
	)
	closeSignaturePath := filepath.Join(
		transcriptRoot,
		string(Phase1),
		closePublicationDirectoryName,
		closeSignatureFilename,
	)
	var closeRecord CloseRecord
	if err := loadCoordinatorSignedRecord(
		trusted,
		closePath,
		closeSignaturePath,
		&closeRecord,
	); err != nil {
		return nil, SealRecord{}, CloseRecord{}, fmt.Errorf("load closed Phase 1 for coordinator acceptance: %w", err)
	}
	beaconPath := filepath.Join(transcriptRoot, string(Phase1), "beacon", "record.json")
	beaconSignaturePath := filepath.Join(transcriptRoot, string(Phase1), "beacon", "record.sig")
	var beacon BeaconRecord
	if err := loadCoordinatorSignedRecord(
		trusted,
		beaconPath,
		beaconSignaturePath,
		&beacon,
	); err != nil {
		return nil, SealRecord{}, CloseRecord{}, fmt.Errorf("load Phase 1 beacon for coordinator acceptance: %w", err)
	}
	if err := VerifyBeaconRecordFiles(trusted, transcriptRoot, closeRecord, beacon); err != nil {
		return nil, SealRecord{}, CloseRecord{}, fmt.Errorf("verify Phase 1 beacon for coordinator acceptance: %w", err)
	}
	if err := ValidateSeal(closeRecord, beacon, seal); err != nil {
		return nil, SealRecord{}, CloseRecord{}, fmt.Errorf("validate Phase 1 seal for coordinator acceptance: %w", err)
	}
	commonsRef, err := phase1CommonsOutput(seal)
	if err != nil {
		return nil, SealRecord{}, CloseRecord{}, err
	}
	path, err := resolveArtifactPath(transcriptRoot, commonsRef.Name)
	if err != nil {
		return nil, SealRecord{}, CloseRecord{}, err
	}
	commons, digest, err := ReadCommonsFile(
		path,
		CommonsShape{DomainN: circuit.Binding.DomainSize},
	)
	if err != nil {
		return nil, SealRecord{}, CloseRecord{}, err
	}
	if modelDigest(digest) != commonsRef.Digest {
		return nil, SealRecord{}, CloseRecord{}, errors.New("Phase 1 commons digest does not match signed seal")
	}
	return commons, seal, closeRecord, nil
}

func phase1CommonsOutput(seal SealRecord) (ArtifactRef, error) {
	var commonsRef *ArtifactRef
	for i := range seal.Outputs {
		if strings.HasSuffix(seal.Outputs[i].Name, "/commons.bin") ||
			seal.Outputs[i].Name == "commons.bin" {
			if commonsRef != nil {
				return ArtifactRef{}, errors.New("Phase 1 seal contains multiple commons outputs")
			}
			commonsRef = &seal.Outputs[i]
		}
	}
	if commonsRef == nil {
		return ArtifactRef{}, errors.New("Phase 1 seal does not contain commons.bin")
	}
	return *commonsRef, nil
}

func loadPhase1CommonsForPhase2(
	trusted *TrustedCeremony,
	circuit *CompiledCircuit,
	transcriptRoot, sealPath, sealSignaturePath string,
) (*gnarkmpc.SrsCommons, SealRecord, CloseRecord, error) {
	if strings.TrimSpace(sealPath) == "" || strings.TrimSpace(sealSignaturePath) == "" {
		return nil, SealRecord{}, CloseRecord{}, errors.New("signed Phase 1 seal paths are required")
	}
	var seal SealRecord
	if err := loadCoordinatorSignedRecord(trusted, sealPath, sealSignaturePath, &seal); err != nil {
		return nil, SealRecord{}, CloseRecord{}, err
	}
	if seal.CeremonyID != trusted.Definition.CeremonyID || seal.Phase != Phase1 {
		return nil, SealRecord{}, CloseRecord{}, errors.New("Phase 1 seal ceremony or phase mismatch")
	}

	// A coordinator signature makes the seal attributable, but it does not
	// make the sealed state valid. Every Phase 2 operation independently
	// verifies the complete closed Phase 1 transcript before it accepts the
	// derived commons. This prevents a malicious or mistaken coordinator from
	// inducing Phase 2 participants to contribute against an invalid Phase 1
	// state and deferring discovery until finalization.
	closePath := filepath.Join(
		transcriptRoot,
		string(Phase1),
		closePublicationDirectoryName,
		closeRecordFilename,
	)
	closeSignaturePath := filepath.Join(
		transcriptRoot,
		string(Phase1),
		closePublicationDirectoryName,
		closeSignatureFilename,
	)
	var closeRecord CloseRecord
	if err := loadCoordinatorSignedRecord(
		trusted,
		closePath,
		closeSignaturePath,
		&closeRecord,
	); err != nil {
		return nil, SealRecord{}, CloseRecord{}, fmt.Errorf("load closed Phase 1 for Phase 2: %w", err)
	}
	if closeRecord.CeremonyID != trusted.Definition.CeremonyID ||
		closeRecord.Phase != Phase1 {
		return nil, SealRecord{}, CloseRecord{}, errors.New("Phase 1 closure ceremony or phase mismatch")
	}
	chainPath := filepath.Join(
		transcriptRoot,
		string(Phase1),
		fmt.Sprintf("chain-%04d.json", closeRecord.FinalIndex),
	)
	chain, replayedHead, err := loadReplayPhase1FilesState(
		trusted,
		circuit,
		PhaseTranscriptPaths{
			RootDir:            transcriptRoot,
			ChainPath:          chainPath,
			ChainSignaturePath: DefaultSignaturePath(chainPath),
		},
	)
	if err != nil {
		return nil, SealRecord{}, CloseRecord{}, fmt.Errorf("replay closed Phase 1 for Phase 2: %w", err)
	}
	if err := ValidateClose(trusted.Definition, chain, closeRecord); err != nil {
		return nil, SealRecord{}, CloseRecord{}, fmt.Errorf("validate closed Phase 1 for Phase 2: %w", err)
	}
	beaconPath := filepath.Join(transcriptRoot, string(Phase1), "beacon", "record.json")
	beaconSignaturePath := filepath.Join(transcriptRoot, string(Phase1), "beacon", "record.sig")
	var beacon BeaconRecord
	if err := loadCoordinatorSignedRecord(
		trusted,
		beaconPath,
		beaconSignaturePath,
		&beacon,
	); err != nil {
		return nil, SealRecord{}, CloseRecord{}, fmt.Errorf("load Phase 1 beacon for Phase 2: %w", err)
	}
	if err := VerifyBeaconRecordFiles(trusted, transcriptRoot, closeRecord, beacon); err != nil {
		return nil, SealRecord{}, CloseRecord{}, fmt.Errorf("verify Phase 1 beacon for Phase 2: %w", err)
	}
	if err := ValidateSeal(closeRecord, beacon, seal); err != nil {
		return nil, SealRecord{}, CloseRecord{}, fmt.Errorf("validate Phase 1 seal for Phase 2: %w", err)
	}
	challenge, err := hex.DecodeString(beacon.ChallengeHex)
	if err != nil || len(challenge) != contributionChallengeSize {
		return nil, SealRecord{}, CloseRecord{}, fmt.Errorf(
			"Phase 1 beacon challenge must be exactly %d bytes",
			contributionChallengeSize,
		)
	}
	derivedCommons, err := sealReplayedPhase1Head(
		circuit.Binding.DomainSize,
		challenge,
		replayedHead,
	)
	if err != nil {
		return nil, SealRecord{}, CloseRecord{}, fmt.Errorf(
			"derive Phase 1 commons from authenticated chain and beacon: %w",
			err,
		)
	}
	derivedDigest, err := writerDigest(derivedCommons)
	if err != nil {
		return nil, SealRecord{}, CloseRecord{}, fmt.Errorf(
			"digest derived Phase 1 commons: %w",
			err,
		)
	}

	commonsRef, err := phase1CommonsOutput(seal)
	if err != nil {
		return nil, SealRecord{}, CloseRecord{}, err
	}
	path, err := resolveArtifactPath(transcriptRoot, commonsRef.Name)
	if err != nil {
		return nil, SealRecord{}, CloseRecord{}, err
	}
	_, digest, err := ReadCommonsFile(path, CommonsShape{DomainN: circuit.Binding.DomainSize})
	if err != nil {
		return nil, SealRecord{}, CloseRecord{}, err
	}
	if modelDigest(digest) != commonsRef.Digest {
		return nil, SealRecord{}, CloseRecord{}, errors.New("Phase 1 commons digest does not match signed seal")
	}
	if derivedDigest != commonsRef.Digest {
		return nil, SealRecord{}, CloseRecord{}, errors.New(
			"Phase 1 commons were not derived from the authenticated accepted chain and beacon",
		)
	}
	return derivedCommons, seal, closeRecord, nil
}
