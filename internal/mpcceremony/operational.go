package mpcceremony

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

const (
	EnrollmentRecordSchema          = "proof-tool-mpc-enrollment-record-v1"
	TransferHandoffSchema           = "proof-tool-mpc-transfer-handoff-v1"
	TransferReceiptSchema           = "proof-tool-mpc-transfer-receipt-v1"
	PublicWitnessReceiptSchema      = "proof-tool-mpc-public-witness-receipt-v1"
	MultiRelayBeaconEvidenceSchema  = "proof-tool-mpc-multi-relay-beacon-evidence-v1"
	ImmutableMirrorReceiptSchema    = "proof-tool-mpc-immutable-mirror-receipt-v1"
	GovernanceRecordSchema          = "proof-tool-mpc-governance-record-v1"
	OperationalSigningRequestSchema = "proof-tool-mpc-operational-signing-request-v1"
)

type OperationalRecordType string

const (
	RecordEnrollment     OperationalRecordType = "enrollment"
	RecordHandoff        OperationalRecordType = "handoff"
	RecordReceipt        OperationalRecordType = "receipt"
	RecordPublicWitness  OperationalRecordType = "public-witness"
	RecordBeaconEvidence OperationalRecordType = "beacon-evidence"
	RecordMirrorReceipt  OperationalRecordType = "mirror-receipt"
	RecordEvidenceBundle OperationalRecordType = "evidence-bundle"
	RecordGovernance     OperationalRecordType = "governance"
)

func (t OperationalRecordType) Validate() error {
	switch t {
	case RecordEnrollment, RecordHandoff, RecordReceipt, RecordPublicWitness,
		RecordBeaconEvidence, RecordMirrorReceipt, RecordEvidenceBundle, RecordGovernance:
		return nil
	default:
		return fmt.Errorf("unsupported operational record type %q", t)
	}
}

type EnrollmentRole string

const (
	EnrollmentCoordinator    EnrollmentRole = "coordinator"
	EnrollmentReleaseSigner  EnrollmentRole = "release-signer"
	EnrollmentAuditor        EnrollmentRole = "auditor"
	EnrollmentParticipant    EnrollmentRole = "participant"
	EnrollmentPublicWitness  EnrollmentRole = "public-witness"
	EnrollmentMirrorOperator EnrollmentRole = "mirror-operator"
)

// EnrollmentRecord is the proof-of-possession message signed by an enrolled
// identity. Definition and roster digests make consent specific to one frozen
// ceremony, while the disclosure digest preserves a reviewable independence
// statement without embedding potentially sensitive prose in every mirror.
type EnrollmentRecord struct {
	Schema                 string         `json:"schema"`
	CeremonyID             string         `json:"ceremony_id"`
	Definition             Digest         `json:"definition"`
	FullRosterSHA256       string         `json:"full_roster_sha256"`
	Identity               Identity       `json:"identity"`
	Role                   EnrollmentRole `json:"role"`
	RoleIndex              uint16         `json:"role_index"`
	IndependenceDisclosure ArtifactRef    `json:"independence_disclosure"`
	EnrolledAt             string         `json:"enrolled_at"`
}

func (r EnrollmentRecord) Validate() error {
	if r.Schema != EnrollmentRecordSchema {
		return fmt.Errorf("enrollment schema %q, want %q", r.Schema, EnrollmentRecordSchema)
	}
	if err := validateHashID("ceremony_id", r.CeremonyID); err != nil {
		return err
	}
	if err := r.Definition.Validate(); err != nil {
		return fmt.Errorf("definition: %w", err)
	}
	if err := validateTaggedHex(r.FullRosterSHA256, "sha256:", sha256.Size); err != nil {
		return fmt.Errorf("full_roster_sha256: %w", err)
	}
	if err := r.Identity.Validate(); err != nil {
		return fmt.Errorf("identity: %w", err)
	}
	switch r.Role {
	case EnrollmentCoordinator, EnrollmentReleaseSigner, EnrollmentAuditor, EnrollmentParticipant,
		EnrollmentPublicWitness, EnrollmentMirrorOperator:
	default:
		return fmt.Errorf("unsupported enrollment role %q", r.Role)
	}
	if r.RoleIndex == 0 {
		return errors.New("role_index is one-based and must be positive")
	}
	if err := r.IndependenceDisclosure.Validate(); err != nil {
		return fmt.Errorf("independence_disclosure: %w", err)
	}
	return validateTimestamp("enrolled_at", r.EnrolledAt)
}

// TransferSourceBinding freezes the implementation and circuit that produced
// the transferred payload. It is copied into receipts so they remain
// independently machine-checkable even if an envelope is unavailable.
type TransferSourceBinding struct {
	SourceCommit string      `json:"source_commit"`
	ToolBinary   Digest      `json:"tool_binary"`
	R1CS         ArtifactRef `json:"r1cs"`
}

func (b TransferSourceBinding) Validate() error {
	if err := validateHex(b.SourceCommit, 20); err != nil {
		return fmt.Errorf("source_commit: %w", err)
	}
	if err := b.ToolBinary.Validate(); err != nil {
		return fmt.Errorf("tool_binary: %w", err)
	}
	if err := b.R1CS.Validate(); err != nil {
		return fmt.Errorf("r1cs: %w", err)
	}
	return nil
}

// TransferHandoff is signed by SenderID before bytes leave its custody.
type TransferHandoff struct {
	Schema            string                `json:"schema"`
	CeremonyID        string                `json:"ceremony_id"`
	Phase             Phase                 `json:"phase"`
	Index             uint8                 `json:"index"`
	PredecessorHeadID string                `json:"predecessor_head_id"`
	Source            TransferSourceBinding `json:"source"`
	Files             []ArtifactRef         `json:"files"`
	SenderID          string                `json:"sender_id"`
	SenderKeyID       string                `json:"sender_key_id"`
	RecipientID       string                `json:"recipient_id"`
	RecipientKeyID    string                `json:"recipient_key_id"`
	CreatedAt         string                `json:"created_at"`
	ExpiresAt         string                `json:"expires_at"`
}

func (r TransferHandoff) Validate() error {
	if r.Schema != TransferHandoffSchema {
		return fmt.Errorf("handoff schema %q, want %q", r.Schema, TransferHandoffSchema)
	}
	if err := validateOperationalScope(r.CeremonyID, r.Phase, r.Index, r.PredecessorHeadID); err != nil {
		return err
	}
	if err := r.Source.Validate(); err != nil {
		return fmt.Errorf("source: %w", err)
	}
	if err := validateArtifactSet("files", r.Files); err != nil {
		return err
	}
	if err := validateTransferIdentities(r.SenderID, r.SenderKeyID, r.RecipientID, r.RecipientKeyID); err != nil {
		return err
	}
	if err := validateTimestamp("created_at", r.CreatedAt); err != nil {
		return err
	}
	if err := validateTimestamp("expires_at", r.ExpiresAt); err != nil {
		return err
	}
	created, _ := time.Parse(time.RFC3339Nano, r.CreatedAt)
	expires, _ := time.Parse(time.RFC3339Nano, r.ExpiresAt)
	if !expires.After(created) {
		return errors.New("expires_at must be strictly after created_at")
	}
	return nil
}

type TransferReceiptKind string

const (
	ReceiptReceiver TransferReceiptKind = "receiver"
)

// TransferReceipt is always signed by the receiving custodian named by the
// handoff. Outbound and return custody therefore use separate handoffs and one
// receiver acknowledgement for each direction.
type TransferReceipt struct {
	Schema            string                `json:"schema"`
	Kind              TransferReceiptKind   `json:"kind"`
	HandoffSHA256     string                `json:"handoff_sha256"`
	CeremonyID        string                `json:"ceremony_id"`
	Phase             Phase                 `json:"phase"`
	Index             uint8                 `json:"index"`
	PredecessorHeadID string                `json:"predecessor_head_id"`
	Source            TransferSourceBinding `json:"source"`
	Files             []ArtifactRef         `json:"files"`
	SenderID          string                `json:"sender_id"`
	SenderKeyID       string                `json:"sender_key_id"`
	RecipientID       string                `json:"recipient_id"`
	RecipientKeyID    string                `json:"recipient_key_id"`
	SignerID          string                `json:"signer_id"`
	SignerKeyID       string                `json:"signer_key_id"`
	ReceivedAt        string                `json:"received_at"`
}

func (r TransferReceipt) Validate() error {
	if r.Schema != TransferReceiptSchema {
		return fmt.Errorf("receipt schema %q, want %q", r.Schema, TransferReceiptSchema)
	}
	switch r.Kind {
	case ReceiptReceiver:
	default:
		return fmt.Errorf("unsupported transfer receipt kind %q", r.Kind)
	}
	if err := validateTaggedHex(r.HandoffSHA256, "sha256:", sha256.Size); err != nil {
		return fmt.Errorf("handoff_sha256: %w", err)
	}
	if err := validateOperationalScope(r.CeremonyID, r.Phase, r.Index, r.PredecessorHeadID); err != nil {
		return err
	}
	if err := r.Source.Validate(); err != nil {
		return fmt.Errorf("source: %w", err)
	}
	if err := validateArtifactSet("files", r.Files); err != nil {
		return err
	}
	if err := validateTransferIdentities(r.SenderID, r.SenderKeyID, r.RecipientID, r.RecipientKeyID); err != nil {
		return err
	}
	if err := validateID("signer_id", r.SignerID); err != nil {
		return err
	}
	if err := validateID("signer_key_id", r.SignerKeyID); err != nil {
		return err
	}
	if r.SignerID != r.RecipientID || r.SignerKeyID != r.RecipientKeyID {
		return errors.New("transfer receipt must be signed by the handoff recipient")
	}
	return validateTimestamp("received_at", r.ReceivedAt)
}

type PublicWitnessReceipt struct {
	Schema                 string      `json:"schema"`
	CeremonyID             string      `json:"ceremony_id"`
	Phase                  Phase       `json:"phase"`
	CloseID                string      `json:"close_id"`
	ChainHeadID            string      `json:"chain_head_id"`
	Closure                ArtifactRef `json:"closure"`
	BeaconRound            uint64      `json:"beacon_round"`
	BeaconScheduledAt      string      `json:"beacon_scheduled_at"`
	PublicationLocationSHA string      `json:"publication_location_sha256"`
	Witness                Identity    `json:"witness"`
	ObservedAt             string      `json:"observed_at"`
}

func (r PublicWitnessReceipt) Validate() error {
	if r.Schema != PublicWitnessReceiptSchema {
		return fmt.Errorf("public witness schema %q, want %q", r.Schema, PublicWitnessReceiptSchema)
	}
	if err := validateHashID("ceremony_id", r.CeremonyID); err != nil {
		return err
	}
	if err := r.Phase.Validate(); err != nil {
		return err
	}
	if err := validateHashID("close_id", r.CloseID); err != nil {
		return err
	}
	if err := validateHashID("chain_head_id", r.ChainHeadID); err != nil {
		return err
	}
	if err := r.Closure.Validate(); err != nil {
		return fmt.Errorf("closure: %w", err)
	}
	if r.BeaconRound == 0 {
		return errors.New("beacon_round must be positive")
	}
	if err := validateTimestamp("beacon_scheduled_at", r.BeaconScheduledAt); err != nil {
		return err
	}
	if err := validateTaggedHex(r.PublicationLocationSHA, "sha256:", sha256.Size); err != nil {
		return fmt.Errorf("publication_location_sha256: %w", err)
	}
	if err := r.Witness.Validate(); err != nil {
		return fmt.Errorf("witness: %w", err)
	}
	if err := validateTimestamp("observed_at", r.ObservedAt); err != nil {
		return err
	}
	scheduled, _ := time.Parse(time.RFC3339Nano, r.BeaconScheduledAt)
	observed, _ := time.Parse(time.RFC3339Nano, r.ObservedAt)
	if !observed.Before(scheduled) {
		return errors.New("public witness observation must be strictly before the beacon round")
	}
	return nil
}

type RelayObservation struct {
	RelayID            string      `json:"relay_id"`
	OperatorID         string      `json:"operator_id"`
	EndpointSHA256     string      `json:"endpoint_sha256"`
	RawResponse        ArtifactRef `json:"raw_response"`
	RetrievedAt        string      `json:"retrieved_at"`
	VerifiedRandomness string      `json:"verified_randomness_hex"`
}

func (r RelayObservation) Validate() error {
	if err := validateID("relay_id", r.RelayID); err != nil {
		return err
	}
	if err := validateID("operator_id", r.OperatorID); err != nil {
		return err
	}
	if err := validateTaggedHex(r.EndpointSHA256, "sha256:", sha256.Size); err != nil {
		return fmt.Errorf("endpoint_sha256: %w", err)
	}
	if err := r.RawResponse.Validate(); err != nil {
		return fmt.Errorf("raw_response: %w", err)
	}
	if err := validateTimestamp("retrieved_at", r.RetrievedAt); err != nil {
		return err
	}
	return validateHex(r.VerifiedRandomness, sha256.Size)
}

type MultiRelayBeaconEvidence struct {
	Schema           string             `json:"schema"`
	CeremonyID       string             `json:"ceremony_id"`
	Phase            Phase              `json:"phase"`
	CloseID          string             `json:"close_id"`
	BeaconRound      uint64             `json:"beacon_round"`
	Provider         string             `json:"provider"`
	Network          string             `json:"network"`
	Observations     []RelayObservation `json:"observations"`
	CoordinatorID    string             `json:"coordinator_id"`
	CoordinatorKeyID string             `json:"coordinator_key_id"`
	RecordedAt       string             `json:"recorded_at"`
}

// ImmutableMirrorReceipt is signed by an independent archive operator after
// durably storing the exact accepted-head artifacts.
type ImmutableMirrorReceipt struct {
	Schema                string        `json:"schema"`
	CeremonyID            string        `json:"ceremony_id"`
	Phase                 Phase         `json:"phase"`
	Index                 uint8         `json:"index"`
	AcceptedHeadID        string        `json:"accepted_head_id"`
	Files                 []ArtifactRef `json:"files"`
	Mirror                Identity      `json:"mirror"`
	StorageLocationSHA256 string        `json:"storage_location_sha256"`
	StoredAt              string        `json:"stored_at"`
}

func (r ImmutableMirrorReceipt) Validate() error {
	if r.Schema != ImmutableMirrorReceiptSchema {
		return fmt.Errorf("mirror receipt schema %q, want %q", r.Schema, ImmutableMirrorReceiptSchema)
	}
	if err := validateOperationalScope(r.CeremonyID, r.Phase, r.Index, r.AcceptedHeadID); err != nil {
		return err
	}
	if err := validateArtifactSet("files", r.Files); err != nil {
		return err
	}
	if err := r.Mirror.Validate(); err != nil {
		return fmt.Errorf("mirror: %w", err)
	}
	if err := validateTaggedHex(r.StorageLocationSHA256, "sha256:", sha256.Size); err != nil {
		return fmt.Errorf("storage_location_sha256: %w", err)
	}
	return validateTimestamp("stored_at", r.StoredAt)
}

func (r MultiRelayBeaconEvidence) Validate() error {
	if r.Schema != MultiRelayBeaconEvidenceSchema {
		return fmt.Errorf("multi-relay beacon schema %q, want %q", r.Schema, MultiRelayBeaconEvidenceSchema)
	}
	if err := validateHashID("ceremony_id", r.CeremonyID); err != nil {
		return err
	}
	if err := r.Phase.Validate(); err != nil {
		return err
	}
	if err := validateHashID("close_id", r.CloseID); err != nil {
		return err
	}
	if r.BeaconRound == 0 {
		return errors.New("beacon_round must be positive")
	}
	if err := validateID("provider", r.Provider); err != nil {
		return err
	}
	if err := validateID("network", r.Network); err != nil {
		return err
	}
	if len(r.Observations) < 3 || len(r.Observations) > 16 {
		return errors.New("multi-relay beacon evidence requires between 3 and 16 observations")
	}
	relayIDs := make(map[string]struct{}, len(r.Observations))
	operatorIDs := make(map[string]struct{}, len(r.Observations))
	endpoints := make(map[string]struct{}, len(r.Observations))
	randomness := ""
	previousRelay := ""
	for index, observation := range r.Observations {
		if err := observation.Validate(); err != nil {
			return fmt.Errorf("observation %d: %w", index, err)
		}
		if index > 0 && observation.RelayID <= previousRelay {
			return errors.New("beacon observations must be ordered by unique relay_id")
		}
		previousRelay = observation.RelayID
		if _, duplicate := relayIDs[observation.RelayID]; duplicate {
			return fmt.Errorf("relay_id %q is duplicated", observation.RelayID)
		}
		relayIDs[observation.RelayID] = struct{}{}
		if _, duplicate := operatorIDs[observation.OperatorID]; duplicate {
			return fmt.Errorf("beacon operator_id %q is duplicated", observation.OperatorID)
		}
		operatorIDs[observation.OperatorID] = struct{}{}
		if _, duplicate := endpoints[observation.EndpointSHA256]; duplicate {
			return errors.New("beacon relay endpoint digest is duplicated")
		}
		endpoints[observation.EndpointSHA256] = struct{}{}
		if randomness == "" {
			randomness = observation.VerifiedRandomness
		} else if observation.VerifiedRandomness != randomness {
			return errors.New("beacon relays do not agree on verified randomness")
		}
	}
	if err := validateID("coordinator_id", r.CoordinatorID); err != nil {
		return err
	}
	if err := validateID("coordinator_key_id", r.CoordinatorKeyID); err != nil {
		return err
	}
	if err := validateTimestamp("recorded_at", r.RecordedAt); err != nil {
		return err
	}
	recorded, _ := time.Parse(time.RFC3339Nano, r.RecordedAt)
	for _, observation := range r.Observations {
		retrieved, _ := time.Parse(time.RFC3339Nano, observation.RetrievedAt)
		if recorded.Before(retrieved) {
			return fmt.Errorf("recorded_at predates retrieval from relay %q", observation.RelayID)
		}
	}
	return nil
}

type GovernanceKind string

const (
	GovernanceIncident  GovernanceKind = "incident"
	GovernanceRejection GovernanceKind = "rejection"
	GovernanceAbort     GovernanceKind = "abort"
	GovernanceRestart   GovernanceKind = "restart"
)

type GovernanceRecord struct {
	Schema          string         `json:"schema"`
	Kind            GovernanceKind `json:"kind"`
	CeremonyID      string         `json:"ceremony_id"`
	Phase           Phase          `json:"phase"`
	Index           uint8          `json:"index"`
	HeadID          string         `json:"head_id"`
	Evidence        []ArtifactRef  `json:"evidence"`
	ReasonCode      string         `json:"reason_code"`
	StatementSHA256 string         `json:"statement_sha256"`
	NewCeremonyID   string         `json:"new_ceremony_id"`
	SignerID        string         `json:"signer_id"`
	SignerKeyID     string         `json:"signer_key_id"`
	RecordedAt      string         `json:"recorded_at"`
}

func (r GovernanceRecord) Validate() error {
	if r.Schema != GovernanceRecordSchema {
		return fmt.Errorf("governance schema %q, want %q", r.Schema, GovernanceRecordSchema)
	}
	switch r.Kind {
	case GovernanceIncident, GovernanceRejection, GovernanceAbort, GovernanceRestart:
	default:
		return fmt.Errorf("unsupported governance kind %q", r.Kind)
	}
	if err := validateOperationalScope(r.CeremonyID, r.Phase, r.Index, r.HeadID); err != nil {
		return err
	}
	if err := validateArtifactSet("evidence", r.Evidence); err != nil {
		return err
	}
	if err := validateID("reason_code", r.ReasonCode); err != nil {
		return err
	}
	if err := validateTaggedHex(r.StatementSHA256, "sha256:", sha256.Size); err != nil {
		return fmt.Errorf("statement_sha256: %w", err)
	}
	if r.Kind == GovernanceRestart {
		if err := validateHashID("new_ceremony_id", r.NewCeremonyID); err != nil {
			return err
		}
		if r.NewCeremonyID == r.CeremonyID {
			return errors.New("restart must bind a distinct new_ceremony_id")
		}
	} else if r.NewCeremonyID != "" {
		return errors.New("new_ceremony_id is permitted only for a restart record")
	}
	if err := validateID("signer_id", r.SignerID); err != nil {
		return err
	}
	if err := validateID("signer_key_id", r.SignerKeyID); err != nil {
		return err
	}
	return validateTimestamp("recorded_at", r.RecordedAt)
}

type OperationalSigningRequest struct {
	Schema       string                `json:"schema"`
	RecordType   OperationalRecordType `json:"record_type"`
	RecordSHA256 string                `json:"record_sha256"`
	RecordSize   int64                 `json:"record_size"`
}

func NewOperationalSigningRequest(recordType OperationalRecordType, canonical []byte) (OperationalSigningRequest, error) {
	if err := recordType.Validate(); err != nil {
		return OperationalSigningRequest{}, err
	}
	if len(canonical) == 0 {
		return OperationalSigningRequest{}, errors.New("canonical record is empty")
	}
	request := OperationalSigningRequest{
		Schema:       OperationalSigningRequestSchema,
		RecordType:   recordType,
		RecordSHA256: taggedSHA256(canonical),
		RecordSize:   int64(len(canonical)),
	}
	return request, request.Validate()
}

func (r OperationalSigningRequest) Validate() error {
	if r.Schema != OperationalSigningRequestSchema {
		return fmt.Errorf("signing request schema %q, want %q", r.Schema, OperationalSigningRequestSchema)
	}
	if err := r.RecordType.Validate(); err != nil {
		return err
	}
	if err := validateTaggedHex(r.RecordSHA256, "sha256:", sha256.Size); err != nil {
		return fmt.Errorf("record_sha256: %w", err)
	}
	if r.RecordSize <= 0 || r.RecordSize > 16<<20 {
		return fmt.Errorf("record_size %d is outside [1,%d]", r.RecordSize, 16<<20)
	}
	return nil
}

// ParseOperationalRecord strictly accepts only the canonical bytes that will
// be signed. It never normalizes attacker-controlled JSON before verification.
func ParseOperationalRecord(recordType OperationalRecordType, canonical []byte) (any, error) {
	var destination any
	switch recordType {
	case RecordEnrollment:
		destination = &EnrollmentRecord{}
	case RecordHandoff:
		destination = &TransferHandoff{}
	case RecordReceipt:
		destination = &TransferReceipt{}
	case RecordPublicWitness:
		destination = &PublicWitnessReceipt{}
	case RecordBeaconEvidence:
		destination = &MultiRelayBeaconEvidence{}
	case RecordMirrorReceipt:
		destination = &ImmutableMirrorReceipt{}
	case RecordEvidenceBundle:
		destination = &OperationalEvidenceBundle{}
	case RecordGovernance:
		destination = &GovernanceRecord{}
	default:
		return nil, fmt.Errorf("unsupported operational record type %q", recordType)
	}
	if err := UnmarshalCanonical(canonical, destination); err != nil {
		return nil, err
	}
	return destination, nil
}

// ImportOperationalSignature converts a raw offline Ed25519 signature into the
// repository's detached signature format only after verifying it over the
// exact exported canonical bytes.
func ImportOperationalSignature(
	canonical []byte,
	keyID string,
	publicKey ed25519.PublicKey,
	rawSignature []byte,
) (DetachedSignature, error) {
	if len(canonical) == 0 {
		return DetachedSignature{}, errors.New("canonical record is empty")
	}
	if err := validateID("signature key_id", keyID); err != nil {
		return DetachedSignature{}, err
	}
	if len(publicKey) != ed25519.PublicKeySize {
		return DetachedSignature{}, fmt.Errorf("Ed25519 public key is %d bytes, want %d", len(publicKey), ed25519.PublicKeySize)
	}
	if len(rawSignature) != ed25519.SignatureSize {
		return DetachedSignature{}, fmt.Errorf("Ed25519 signature is %d bytes, want %d", len(rawSignature), ed25519.SignatureSize)
	}
	if !ed25519.Verify(publicKey, canonical, rawSignature) {
		return DetachedSignature{}, errors.New("offline Ed25519 signature verification failed")
	}
	signature := DetachedSignature{
		Schema:               DetachedSignatureSchema,
		Algorithm:            SignatureAlgorithm,
		KeyID:                keyID,
		PublicKeyFingerprint: taggedSHA256(publicKey),
		SignedSHA256:         taggedSHA256(canonical),
		SignatureHex:         hex.EncodeToString(rawSignature),
	}
	return signature, signature.Validate()
}

// VerifyOperationalRecordBinding checks immutable ceremony fields and the
// record signer. Cross-record checks (receipt/handoff, witness quorum, relay
// raw responses, and restart target) have dedicated validators below.
func VerifyOperationalRecordBinding(
	definition CeremonyDefinition,
	definitionBytes []byte,
	record any,
) (Identity, error) {
	if err := definition.Validate(); err != nil {
		return Identity{}, err
	}
	if len(definitionBytes) == 0 {
		return Identity{}, errors.New("canonical definition bytes are required")
	}
	var ceremonyID, signerID, signerKeyID string
	switch r := record.(type) {
	case *EnrollmentRecord:
		ceremonyID, signerID, signerKeyID = r.CeremonyID, r.Identity.ID, r.Identity.KeyID
		if err := verifyEnrollmentBinding(definition, definitionBytes, *r); err != nil {
			return Identity{}, err
		}
	case *TransferHandoff:
		ceremonyID, signerID, signerKeyID = r.CeremonyID, r.SenderID, r.SenderKeyID
		if err := verifyTransferSource(definition, r.Source); err != nil {
			return Identity{}, err
		}
		if err := verifyTransferParty(definition, r.SenderID, r.SenderKeyID); err != nil {
			return Identity{}, fmt.Errorf("sender: %w", err)
		}
		if err := verifyTransferParty(definition, r.RecipientID, r.RecipientKeyID); err != nil {
			return Identity{}, fmt.Errorf("recipient: %w", err)
		}
	case *TransferReceipt:
		ceremonyID, signerID, signerKeyID = r.CeremonyID, r.SignerID, r.SignerKeyID
		if err := verifyTransferSource(definition, r.Source); err != nil {
			return Identity{}, err
		}
		if err := verifyTransferParty(definition, r.SenderID, r.SenderKeyID); err != nil {
			return Identity{}, fmt.Errorf("sender: %w", err)
		}
		if err := verifyTransferParty(definition, r.RecipientID, r.RecipientKeyID); err != nil {
			return Identity{}, fmt.Errorf("recipient: %w", err)
		}
	case *PublicWitnessReceipt:
		ceremonyID = r.CeremonyID
		signerID, signerKeyID = r.Witness.ID, r.Witness.KeyID
	case *MultiRelayBeaconEvidence:
		ceremonyID, signerID, signerKeyID = r.CeremonyID, r.CoordinatorID, r.CoordinatorKeyID
		if r.Provider != definition.BeaconPolicy.Provider || r.Network != definition.BeaconPolicy.Network {
			return Identity{}, errors.New("multi-relay beacon provider/network does not match ceremony")
		}
	case *ImmutableMirrorReceipt:
		ceremonyID = r.CeremonyID
		signerID, signerKeyID = r.Mirror.ID, r.Mirror.KeyID
	case *OperationalEvidenceBundle:
		ceremonyID, signerID, signerKeyID = r.CeremonyID, r.CoordinatorID, r.CoordinatorKeyID
	case *GovernanceRecord:
		ceremonyID, signerID, signerKeyID = r.CeremonyID, r.SignerID, r.SignerKeyID
	default:
		return Identity{}, fmt.Errorf("unsupported operational record %T", record)
	}
	if ceremonyID != definition.CeremonyID {
		return Identity{}, errors.New("operational record ceremony_id does not match definition")
	}
	if enrollment, ok := record.(*EnrollmentRecord); ok {
		return enrollment.Identity, nil
	}
	if witness, ok := record.(*PublicWitnessReceipt); ok {
		if witness.Witness.KeyID != signerKeyID {
			return Identity{}, errors.New("public witness signer key mismatch")
		}
		return witness.Witness, nil
	}
	if mirror, ok := record.(*ImmutableMirrorReceipt); ok {
		if mirror.Mirror.KeyID != signerKeyID {
			return Identity{}, errors.New("immutable mirror signer key mismatch")
		}
		return mirror.Mirror, nil
	}
	identity, ok := definitionIdentityByID(definition, signerID)
	if !ok || identity.KeyID != signerKeyID {
		return Identity{}, errors.New("operational record signer is not the matching enrolled identity")
	}
	return identity, nil
}

func VerifyTransferReceipt(handoffBytes []byte, handoff TransferHandoff, receipt TransferReceipt) error {
	if err := handoff.Validate(); err != nil {
		return fmt.Errorf("handoff: %w", err)
	}
	if err := receipt.Validate(); err != nil {
		return fmt.Errorf("receipt: %w", err)
	}
	if taggedSHA256(handoffBytes) != receipt.HandoffSHA256 {
		return errors.New("receipt handoff_sha256 does not match exact handoff bytes")
	}
	if receipt.CeremonyID != handoff.CeremonyID || receipt.Phase != handoff.Phase ||
		receipt.Index != handoff.Index || receipt.PredecessorHeadID != handoff.PredecessorHeadID ||
		receipt.Source != handoff.Source || !slices.Equal(receipt.Files, handoff.Files) ||
		receipt.SenderID != handoff.SenderID || receipt.SenderKeyID != handoff.SenderKeyID ||
		receipt.RecipientID != handoff.RecipientID || receipt.RecipientKeyID != handoff.RecipientKeyID {
		return errors.New("receipt does not exactly bind handoff scope, source, files, sender, and recipient")
	}
	received, _ := time.Parse(time.RFC3339Nano, receipt.ReceivedAt)
	created, _ := time.Parse(time.RFC3339Nano, handoff.CreatedAt)
	expires, _ := time.Parse(time.RFC3339Nano, handoff.ExpiresAt)
	if !received.After(created) || received.After(expires) {
		return errors.New("receipt received_at is outside the handoff validity window")
	}
	return nil
}

type SignedPublicWitness struct {
	RecordBytes    []byte
	SignatureBytes []byte
	TrustedKey     ed25519.PublicKey
}

func VerifyPublicWitnessQuorum(
	definition CeremonyDefinition,
	close CloseRecord,
	closeBytes []byte,
	receipts []SignedPublicWitness,
	minimum int,
) error {
	if minimum < 2 {
		return errors.New("public witness quorum minimum must be at least 2")
	}
	if len(receipts) < minimum {
		return fmt.Errorf("have %d public witness receipts, need %d", len(receipts), minimum)
	}
	seenIDs := make(map[string]struct{}, len(receipts))
	seenKeys := make(map[string]struct{}, len(receipts))
	var common *PublicWitnessReceipt
	for index, signed := range receipts {
		var receipt PublicWitnessReceipt
		if err := VerifySignedRecord(signed.RecordBytes, signed.SignatureBytes, &receipt, witnessKeyID(signed.RecordBytes), signed.TrustedKey); err != nil {
			return fmt.Errorf("public witness %d: %w", index, err)
		}
		if err := ValidatePublicWitnessReceipt(definition, close, closeBytes, receipt); err != nil {
			return fmt.Errorf("public witness %d: %w", index, err)
		}
		embeddedKey, err := identityPublicKey(receipt.Witness)
		if err != nil {
			return fmt.Errorf("public witness %d identity: %w", index, err)
		}
		if !bytes.Equal(embeddedKey, signed.TrustedKey) {
			return fmt.Errorf("public witness %d trusted key does not match receipt identity", index)
		}
		if _, duplicate := seenIDs[receipt.Witness.ID]; duplicate {
			return fmt.Errorf("public witness identity %q is duplicated", receipt.Witness.ID)
		}
		seenIDs[receipt.Witness.ID] = struct{}{}
		if _, duplicate := seenKeys[receipt.Witness.PublicKeyFingerprint]; duplicate {
			return errors.New("public witness key is duplicated")
		}
		seenKeys[receipt.Witness.PublicKeyFingerprint] = struct{}{}
		if common == nil {
			copy := receipt
			common = &copy
		} else if receipt.CeremonyID != common.CeremonyID || receipt.Phase != common.Phase ||
			receipt.CloseID != common.CloseID || receipt.ChainHeadID != common.ChainHeadID ||
			receipt.Closure != common.Closure || receipt.BeaconRound != common.BeaconRound ||
			receipt.BeaconScheduledAt != common.BeaconScheduledAt {
			return errors.New("public witness receipts do not attest the same closure and beacon round")
		}
	}
	return nil
}

func ValidatePublicWitnessReceipt(
	definition CeremonyDefinition,
	close CloseRecord,
	closeBytes []byte,
	receipt PublicWitnessReceipt,
) error {
	if err := definition.Validate(); err != nil {
		return err
	}
	if err := close.Validate(); err != nil {
		return err
	}
	if err := receipt.Validate(); err != nil {
		return err
	}
	if identityOverlapsDefinition(definition, receipt.Witness) {
		return errors.New("public witness identity or key overlaps a ceremony actor")
	}
	roundTime, err := QuicknetRoundTime(close.BeaconRound)
	if err != nil {
		return err
	}
	scheduled, _ := time.Parse(time.RFC3339Nano, receipt.BeaconScheduledAt)
	observed, _ := time.Parse(time.RFC3339Nano, receipt.ObservedAt)
	closed, _ := time.Parse(time.RFC3339Nano, close.ClosedAt)
	if !scheduled.Equal(roundTime) {
		return errors.New("public witness beacon_scheduled_at does not match pinned round schedule")
	}
	if !observed.After(closed) || !observed.Before(roundTime) {
		return errors.New("public witness must observe publication after closure and before beacon round")
	}
	minimumLead := time.Duration(definition.BeaconPolicy.MinimumWitnessLeadSeconds) * time.Second
	if roundTime.Sub(observed) < minimumLead {
		return fmt.Errorf(
			"public witness lead %s is below signed minimum %s",
			roundTime.Sub(observed),
			minimumLead,
		)
	}
	if receipt.CeremonyID != definition.CeremonyID || receipt.CeremonyID != close.CeremonyID ||
		receipt.Phase != close.Phase || receipt.CloseID != close.CloseID ||
		receipt.ChainHeadID != close.ChainHeadID || receipt.BeaconRound != close.BeaconRound ||
		receipt.Closure.Digest != NewDigest(closeBytes) {
		return errors.New("public witness receipt does not exactly bind the signed closure")
	}
	return nil
}

func ValidateMultiRelayBeaconEvidence(
	definition CeremonyDefinition,
	close CloseRecord,
	evidence MultiRelayBeaconEvidence,
	rawResponses map[string][]byte,
) error {
	if err := definition.Validate(); err != nil {
		return err
	}
	if err := close.Validate(); err != nil {
		return err
	}
	if err := evidence.Validate(); err != nil {
		return err
	}
	if evidence.CeremonyID != definition.CeremonyID || evidence.CeremonyID != close.CeremonyID ||
		evidence.Phase != close.Phase || evidence.CloseID != close.CloseID ||
		evidence.BeaconRound != close.BeaconRound ||
		evidence.Provider != definition.BeaconPolicy.Provider ||
		evidence.Network != definition.BeaconPolicy.Network ||
		evidence.CoordinatorID != definition.Coordinator.ID ||
		evidence.CoordinatorKeyID != definition.Coordinator.KeyID {
		return errors.New("multi-relay beacon evidence does not exactly bind ceremony closure and coordinator")
	}
	roundTime, err := QuicknetRoundTime(close.BeaconRound)
	if err != nil {
		return err
	}
	for _, observation := range evidence.Observations {
		raw, ok := rawResponses[observation.RelayID]
		if !ok {
			return fmt.Errorf("raw response for relay %q is missing", observation.RelayID)
		}
		if NewDigest(raw) != observation.RawResponse.Digest {
			return fmt.Errorf("raw response for relay %q has wrong digest or size", observation.RelayID)
		}
		randomness, err := VerifyDrandBeaconResponse(definition.BeaconPolicy, close.BeaconRound, raw)
		if err != nil {
			return fmt.Errorf("relay %q: %w", observation.RelayID, err)
		}
		if randomness != observation.VerifiedRandomness {
			return fmt.Errorf("relay %q verified randomness mismatch", observation.RelayID)
		}
		retrieved, _ := time.Parse(time.RFC3339Nano, observation.RetrievedAt)
		if retrieved.Before(roundTime) {
			return fmt.Errorf("relay %q response predates beacon round", observation.RelayID)
		}
	}
	return nil
}

func ValidateRestartRecord(oldDefinition, newDefinition CeremonyDefinition, record GovernanceRecord) error {
	if err := oldDefinition.Validate(); err != nil {
		return err
	}
	if err := newDefinition.Validate(); err != nil {
		return err
	}
	if err := record.Validate(); err != nil {
		return err
	}
	if record.Kind != GovernanceRestart {
		return errors.New("governance record is not a restart")
	}
	if record.CeremonyID != oldDefinition.CeremonyID || record.NewCeremonyID != newDefinition.CeremonyID {
		return errors.New("restart record does not bind exact old and new ceremony IDs")
	}
	if oldDefinition.CeremonyID == newDefinition.CeremonyID {
		return errors.New("restart definition did not create a fresh ceremony ID")
	}
	return nil
}

func verifyEnrollmentBinding(definition CeremonyDefinition, definitionBytes []byte, record EnrollmentRecord) error {
	if record.Definition != NewDigest(definitionBytes) {
		return errors.New("enrollment definition digest does not match exact canonical definition")
	}
	rosterBytes, err := json.Marshal(definition.Roster)
	if err != nil {
		return fmt.Errorf("marshal full roster: %w", err)
	}
	if record.FullRosterSHA256 != taggedSHA256(rosterBytes) {
		return errors.New("enrollment full_roster_sha256 does not match frozen full roster")
	}
	identity, role, index, ok := definitionRoleAt(definition, record.Identity.ID)
	switch record.Role {
	case EnrollmentPublicWitness, EnrollmentMirrorOperator:
		if ok || identityOverlapsDefinition(definition, record.Identity) {
			return errors.New("external operational identity overlaps a ceremony actor")
		}
	default:
		if !ok || identity != record.Identity || role != record.Role || index != record.RoleIndex {
			return errors.New("enrollment identity, role, or one-based index does not match definition")
		}
	}
	created, _ := time.Parse(time.RFC3339Nano, definition.CreatedAt)
	enrolled, _ := time.Parse(time.RFC3339Nano, record.EnrolledAt)
	if enrolled.Before(created) {
		return errors.New("enrollment predates ceremony definition")
	}
	return nil
}

func identityOverlapsDefinition(definition CeremonyDefinition, candidate Identity) bool {
	all := []Identity{definition.Coordinator, definition.ReleaseSigner}
	all = append(all, definition.Auditors...)
	for _, participant := range definition.Roster {
		all = append(all, participant.Identity)
	}
	for _, identity := range all {
		if identity.ID == candidate.ID || identity.KeyID == candidate.KeyID ||
			identity.PublicKeyFingerprint == candidate.PublicKeyFingerprint {
			return true
		}
	}
	return false
}

func verifyTransferSource(definition CeremonyDefinition, source TransferSourceBinding) error {
	if source.SourceCommit != definition.Software.SourceCommit ||
		source.ToolBinary != definition.Software.ToolBinary ||
		source.R1CS != definition.Circuit.R1CS {
		return errors.New("transfer source, binary, or R1CS binding does not match ceremony definition")
	}
	return nil
}

func verifyTransferParty(definition CeremonyDefinition, id, keyID string) error {
	identity, ok := definitionIdentityByID(definition, id)
	if !ok || identity.KeyID != keyID {
		return errors.New("identity/key is not enrolled in the ceremony definition")
	}
	return nil
}

func definitionRoleAt(definition CeremonyDefinition, id string) (Identity, EnrollmentRole, uint16, bool) {
	if definition.Coordinator.ID == id {
		return definition.Coordinator, EnrollmentCoordinator, 1, true
	}
	if definition.ReleaseSigner.ID == id {
		return definition.ReleaseSigner, EnrollmentReleaseSigner, 1, true
	}
	for index, identity := range definition.Auditors {
		if identity.ID == id {
			return identity, EnrollmentAuditor, uint16(index + 1), true
		}
	}
	for index, participant := range definition.Roster {
		if participant.Identity.ID == id {
			return participant.Identity, EnrollmentParticipant, uint16(index + 1), true
		}
	}
	return Identity{}, "", 0, false
}

func definitionIdentityByID(definition CeremonyDefinition, id string) (Identity, bool) {
	identity, _, _, ok := definitionRoleAt(definition, id)
	return identity, ok
}

func validateOperationalScope(ceremonyID string, phase Phase, index uint8, headID string) error {
	if err := validateHashID("ceremony_id", ceremonyID); err != nil {
		return err
	}
	if err := phase.Validate(); err != nil {
		return err
	}
	if index == 0 || index > MaxParticipants {
		return fmt.Errorf("index must be between 1 and %d", MaxParticipants)
	}
	return validateHashID("predecessor/head id", headID)
}

func validateTransferIdentities(senderID, senderKeyID, recipientID, recipientKeyID string) error {
	if err := validateID("sender_id", senderID); err != nil {
		return err
	}
	if err := validateID("sender_key_id", senderKeyID); err != nil {
		return err
	}
	if err := validateID("recipient_id", recipientID); err != nil {
		return err
	}
	if err := validateID("recipient_key_id", recipientKeyID); err != nil {
		return err
	}
	if senderID == recipientID || senderKeyID == recipientKeyID {
		return errors.New("transfer sender and recipient identities and keys must be distinct")
	}
	return nil
}

func validateArtifactSet(label string, artifacts []ArtifactRef) error {
	if len(artifacts) == 0 || len(artifacts) > 128 {
		return fmt.Errorf("%s must contain between 1 and 128 artifacts", label)
	}
	previous := ""
	for index, artifact := range artifacts {
		if err := artifact.Validate(); err != nil {
			return fmt.Errorf("%s %d: %w", label, index, err)
		}
		if index > 0 && artifact.Name <= previous {
			return fmt.Errorf("%s must be ordered by unique artifact name", label)
		}
		previous = artifact.Name
	}
	return nil
}

func witnessKeyID(recordBytes []byte) string {
	var receipt PublicWitnessReceipt
	if err := json.Unmarshal(recordBytes, &receipt); err != nil {
		return ""
	}
	return receipt.Witness.KeyID
}

func decodeOfflineSignature(data []byte) ([]byte, error) {
	if len(data) == ed25519.SignatureSize {
		return append([]byte(nil), data...), nil
	}
	trimmed := bytes.TrimSpace(data)
	decoded := make([]byte, ed25519.SignatureSize)
	n, err := hex.Decode(decoded, trimmed)
	if err != nil || n != ed25519.SignatureSize || string(trimmed) != strings.ToLower(string(trimmed)) {
		return nil, errors.New("offline signature must be 64 raw bytes or exactly 128 lowercase hexadecimal characters")
	}
	return decoded, nil
}

// DecodeOfflineSignature accepts the two conventional offline transport forms.
func DecodeOfflineSignature(data []byte) ([]byte, error) {
	return decodeOfflineSignature(data)
}
