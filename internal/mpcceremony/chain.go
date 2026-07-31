package mpcceremony

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"math"
	"slices"
	"time"
)

type ChainRecord struct {
	Schema               string      `json:"schema"`
	RecordID             string      `json:"record_id"`
	CeremonyID           string      `json:"ceremony_id"`
	Phase                Phase       `json:"phase"`
	PhaseID              string      `json:"phase_id"`
	Index                uint8       `json:"index"`
	ParticipantID        string      `json:"participant_id"`
	PreviousPayload      ArtifactRef `json:"previous_payload"`
	OutputPayload        ArtifactRef `json:"output_payload"`
	AttestationID        string      `json:"attestation_id"`
	Attestation          ArtifactRef `json:"attestation"`
	AttestationSignature ArtifactRef `json:"attestation_signature"`
	ErasureID            string      `json:"erasure_id"`
	Erasure              ArtifactRef `json:"erasure"`
	ErasureSignature     ArtifactRef `json:"erasure_signature"`
	Verification         ArtifactRef `json:"verification"`
	PreviousRecordID     string      `json:"previous_record_id"`
	CoordinatorID        string      `json:"coordinator_id"`
	CoordinatorKeyID     string      `json:"coordinator_key_id"`
	AcceptedAt           string      `json:"accepted_at"`
}

func NewChainRecord(record ChainRecord) (ChainRecord, error) {
	record.Schema = ChainRecordSchema
	record.RecordID = ""
	id, err := ComputeChainRecordID(record)
	if err != nil {
		return ChainRecord{}, err
	}
	record.RecordID = id
	if err := record.Validate(); err != nil {
		return ChainRecord{}, err
	}
	return record, nil
}

func ComputeChainRecordID(record ChainRecord) (string, error) {
	record.RecordID = ""
	if err := record.validate(false); err != nil {
		return "", err
	}
	return canonicalHash("proof-tool/mpc-ceremony/acceptance-record/v1", record)
}

func (r ChainRecord) Validate() error {
	if err := r.validate(true); err != nil {
		return err
	}
	expected, err := ComputeChainRecordID(r)
	if err != nil {
		return err
	}
	if r.RecordID != expected {
		return fmt.Errorf("record_id %q, want %q", r.RecordID, expected)
	}
	return nil
}

func (r ChainRecord) validate(requireID bool) error {
	if r.Schema != ChainRecordSchema {
		return fmt.Errorf("chain record schema %q, want %q", r.Schema, ChainRecordSchema)
	}
	if requireID {
		if err := validateHashID("record_id", r.RecordID); err != nil {
			return err
		}
	} else if r.RecordID != "" {
		return errors.New("record_id must be empty while computing identity")
	}
	if err := validateHashID("ceremony_id", r.CeremonyID); err != nil {
		return err
	}
	if err := r.Phase.Validate(); err != nil {
		return err
	}
	if err := validateHashID("phase_id", r.PhaseID); err != nil {
		return err
	}
	if r.Index == 0 || r.Index > MaxParticipants {
		return fmt.Errorf("chain record index %d must be between 1 and %d", r.Index, MaxParticipants)
	}
	if err := validateID("participant_id", r.ParticipantID); err != nil {
		return err
	}
	if err := r.PreviousPayload.Validate(); err != nil {
		return fmt.Errorf("previous_payload: %w", err)
	}
	if err := r.OutputPayload.Validate(); err != nil {
		return fmt.Errorf("output_payload: %w", err)
	}
	if r.PreviousPayload.Digest.SHA256 == r.OutputPayload.Digest.SHA256 {
		return errors.New("accepted output payload must differ from previous payload")
	}
	if err := validateHashID("attestation_id", r.AttestationID); err != nil {
		return err
	}
	for name, artifact := range map[string]ArtifactRef{
		"attestation":           r.Attestation,
		"attestation_signature": r.AttestationSignature,
		"erasure":               r.Erasure,
		"erasure_signature":     r.ErasureSignature,
		"verification":          r.Verification,
	} {
		if err := artifact.Validate(); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	if err := validateHashID("erasure_id", r.ErasureID); err != nil {
		return err
	}
	if err := validateHashID("previous_record_id", r.PreviousRecordID); err != nil {
		return err
	}
	if err := validateID("coordinator_id", r.CoordinatorID); err != nil {
		return err
	}
	if err := validateID("coordinator_key_id", r.CoordinatorKeyID); err != nil {
		return err
	}
	return validateTimestamp("accepted_at", r.AcceptedAt)
}

type Chain struct {
	Schema     string        `json:"schema"`
	CeremonyID string        `json:"ceremony_id"`
	Phase      Phase         `json:"phase"`
	PhaseID    string        `json:"phase_id"`
	Genesis    ArtifactRef   `json:"genesis"`
	Records    []ChainRecord `json:"records"`
}

func NewChain(ceremonyID string, phase Phase, phaseID string, genesis ArtifactRef) (Chain, error) {
	chain := Chain{
		Schema:     ChainSchema,
		CeremonyID: ceremonyID,
		Phase:      phase,
		PhaseID:    phaseID,
		Genesis:    genesis,
		Records:    []ChainRecord{},
	}
	return chain, chain.Validate()
}

func (c Chain) Validate() error {
	if c.Schema != ChainSchema {
		return fmt.Errorf("chain schema %q, want %q", c.Schema, ChainSchema)
	}
	if err := validateHashID("ceremony_id", c.CeremonyID); err != nil {
		return err
	}
	if err := c.Phase.Validate(); err != nil {
		return err
	}
	if err := validateHashID("phase_id", c.PhaseID); err != nil {
		return err
	}
	if err := c.Genesis.Validate(); err != nil {
		return fmt.Errorf("genesis: %w", err)
	}
	if len(c.Records) > MaxParticipants {
		return fmt.Errorf("chain contains %d records, maximum is %d", len(c.Records), MaxParticipants)
	}
	previousPayload := c.Genesis
	previousRecordID, err := GenesisRecordID(c.CeremonyID, c.PhaseID, c.Genesis)
	if err != nil {
		return err
	}
	participants := make(map[string]struct{}, len(c.Records))
	var previousAcceptedAt time.Time
	for index, record := range c.Records {
		if err := record.Validate(); err != nil {
			return fmt.Errorf("record %d: %w", index, err)
		}
		acceptedAt, _ := time.Parse(time.RFC3339Nano, record.AcceptedAt)
		if index > 0 && !acceptedAt.After(previousAcceptedAt) {
			return fmt.Errorf("record %d accepted_at must be strictly after record %d", index, index-1)
		}
		if record.CeremonyID != c.CeremonyID || record.Phase != c.Phase || record.PhaseID != c.PhaseID {
			return fmt.Errorf("record %d ceremony or phase identity mismatch", index)
		}
		if int(record.Index) != index+1 {
			return fmt.Errorf("record %d index is %d, want %d", index, record.Index, index+1)
		}
		if record.PreviousPayload != previousPayload {
			return fmt.Errorf("record %d previous payload does not equal accepted chain head", index)
		}
		if record.PreviousRecordID != previousRecordID {
			return fmt.Errorf("record %d previous_record_id %q, want %q", index, record.PreviousRecordID, previousRecordID)
		}
		if _, duplicate := participants[record.ParticipantID]; duplicate {
			return fmt.Errorf("participant %q appears more than once in the phase", record.ParticipantID)
		}
		participants[record.ParticipantID] = struct{}{}
		previousPayload = record.OutputPayload
		previousRecordID = record.RecordID
		previousAcceptedAt = acceptedAt
	}
	return nil
}

func (c *Chain) Append(record ChainRecord) error {
	if c == nil {
		return errors.New("chain is nil")
	}
	candidate := *c
	candidate.Records = append(append([]ChainRecord(nil), c.Records...), record)
	if err := candidate.Validate(); err != nil {
		return err
	}
	c.Records = candidate.Records
	return nil
}

func (c Chain) HeadRecordID() (string, error) {
	if err := c.Validate(); err != nil {
		return "", err
	}
	if len(c.Records) == 0 {
		return GenesisRecordID(c.CeremonyID, c.PhaseID, c.Genesis)
	}
	return c.Records[len(c.Records)-1].RecordID, nil
}

func (c Chain) HeadPayload() (ArtifactRef, error) {
	if err := c.Validate(); err != nil {
		return ArtifactRef{}, err
	}
	if len(c.Records) == 0 {
		return c.Genesis, nil
	}
	return c.Records[len(c.Records)-1].OutputPayload, nil
}

func (c Chain) ParticipantIDs() ([]string, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	result := make([]string, len(c.Records))
	for index := range c.Records {
		result[index] = c.Records[index].ParticipantID
	}
	return result, nil
}

func (c Chain) ValidateAgainstDefinition(definition CeremonyDefinition) error {
	if err := c.Validate(); err != nil {
		return err
	}
	if err := definition.Validate(); err != nil {
		return err
	}
	if c.CeremonyID != definition.CeremonyID {
		return errors.New("chain ceremony_id does not match definition")
	}
	if c.Phase == Phase1 {
		expectedPhaseID, err := ComputePhaseID(definition.CeremonyID, Phase1, definition.Phase1Genesis, "")
		if err != nil {
			return err
		}
		if c.Genesis != definition.Phase1Genesis || c.PhaseID != expectedPhaseID {
			return errors.New("phase1 chain genesis or phase_id does not match definition")
		}
	}
	policy, err := definition.PolicyForPhase(c.Phase)
	if err != nil {
		return err
	}
	for index, record := range c.Records {
		if index >= len(policy.Participants) || record.ParticipantID != policy.Participants[index] {
			return fmt.Errorf("record %d participant %q does not match frozen order", index, record.ParticipantID)
		}
		participant, ok := definition.ParticipantByID(record.ParticipantID)
		if !ok {
			return fmt.Errorf("record %d participant %q is not in roster", index, record.ParticipantID)
		}
		if record.CoordinatorID != definition.Coordinator.ID || record.CoordinatorKeyID != definition.Coordinator.KeyID {
			return fmt.Errorf("record %d coordinator identity mismatch", index)
		}
		if record.AttestationID == "" || participant.Identity.KeyID == "" {
			return fmt.Errorf("record %d participant metadata is incomplete", index)
		}
	}
	return nil
}

func ValidateAttestationAcceptance(
	definition CeremonyDefinition,
	chain Chain,
	attestation ContributionAttestation,
	erasure ErasureAttestation,
	record ChainRecord,
) error {
	if err := definition.Validate(); err != nil {
		return err
	}
	if err := chain.ValidateAgainstDefinition(definition); err != nil {
		return err
	}
	if err := attestation.Validate(); err != nil {
		return err
	}
	if err := ValidateErasureForContribution(attestation, erasure); err != nil {
		return err
	}
	if err := record.Validate(); err != nil {
		return err
	}
	expectedIndex := uint8(len(chain.Records) + 1)
	headPayload, err := chain.HeadPayload()
	if err != nil {
		return err
	}
	headRecordID, err := chain.HeadRecordID()
	if err != nil {
		return err
	}
	if record.Index != expectedIndex || attestation.Index != expectedIndex ||
		record.PreviousPayload != headPayload || attestation.PreviousPayload != headPayload ||
		record.PreviousRecordID != headRecordID || attestation.PreviousAcceptanceID != headRecordID {
		return errors.New("attestation and acceptance are not the next child of the accepted chain head")
	}
	if record.Index != attestation.Index ||
		record.CeremonyID != attestation.CeremonyID ||
		record.Phase != attestation.Phase ||
		record.PhaseID != attestation.PhaseID ||
		record.ParticipantID != attestation.ParticipantID ||
		record.PreviousPayload != attestation.PreviousPayload ||
		record.OutputPayload != attestation.OutputPayload ||
		record.AttestationID != attestation.AttestationID ||
		record.ErasureID != erasure.ErasureID ||
		record.PreviousRecordID != attestation.PreviousAcceptanceID {
		return errors.New("acceptance record does not exactly bind contribution attestation")
	}
	participant, ok := definition.ParticipantByID(attestation.ParticipantID)
	if !ok || participant.Identity.KeyID != attestation.ParticipantKeyID {
		return errors.New("attestation participant identity does not match definition")
	}
	if definition.Software.ToolBinary != attestation.ToolBinary ||
		definition.Software.SourceCommit != attestation.SourceCommit ||
		definition.Software.GnarkVersion != attestation.GnarkVersion ||
		definition.Software.GnarkCryptoVersion != attestation.GnarkCryptoVersion ||
		definition.Software.DrandVersion != attestation.DrandVersion {
		return errors.New("attestation software binding does not match definition")
	}
	createdAt, _ := time.Parse(time.RFC3339Nano, definition.CreatedAt)
	contributedAt, _ := time.Parse(time.RFC3339Nano, attestation.ContributedAt)
	destroyedAt, _ := time.Parse(time.RFC3339Nano, erasure.DestroyedAt)
	acceptedAt, _ := time.Parse(time.RFC3339Nano, record.AcceptedAt)
	if !contributedAt.After(createdAt) {
		return errors.New("contributed_at must be strictly after the ceremony definition")
	}
	if len(chain.Records) > 0 {
		previousAcceptedAt, _ := time.Parse(
			time.RFC3339Nano,
			chain.Records[len(chain.Records)-1].AcceptedAt,
		)
		if !contributedAt.After(previousAcceptedAt) {
			return errors.New("contributed_at must be strictly after the previous acceptance")
		}
	}
	if !acceptedAt.After(destroyedAt) {
		return errors.New("accepted_at must be strictly after destroyed_at")
	}
	return nil
}

func GenesisRecordID(ceremonyID, phaseID string, genesis ArtifactRef) (string, error) {
	if err := validateHashID("ceremony_id", ceremonyID); err != nil {
		return "", err
	}
	if err := validateHashID("phase_id", phaseID); err != nil {
		return "", err
	}
	if err := genesis.Validate(); err != nil {
		return "", err
	}
	value := struct {
		CeremonyID string      `json:"ceremony_id"`
		PhaseID    string      `json:"phase_id"`
		Genesis    ArtifactRef `json:"genesis"`
	}{ceremonyID, phaseID, genesis}
	return canonicalHash("proof-tool/mpc-ceremony/genesis-record/v1", value)
}

type CloseRecord struct {
	Schema               string      `json:"schema"`
	CloseID              string      `json:"close_id"`
	CeremonyID           string      `json:"ceremony_id"`
	Phase                Phase       `json:"phase"`
	PhaseID              string      `json:"phase_id"`
	FinalIndex           uint8       `json:"final_index"`
	FinalPayload         ArtifactRef `json:"final_payload"`
	ChainHeadID          string      `json:"chain_head_id"`
	AcceptedParticipants []string    `json:"accepted_participants"`
	BeaconProvider       string      `json:"beacon_provider"`
	BeaconNetwork        string      `json:"beacon_network"`
	BeaconRound          uint64      `json:"beacon_round"`
	BeaconNotBefore      string      `json:"beacon_not_before"`
	ClosedAt             string      `json:"closed_at"`
	CoordinatorID        string      `json:"coordinator_id"`
	CoordinatorKeyID     string      `json:"coordinator_key_id"`
}

func NewCloseRecord(record CloseRecord) (CloseRecord, error) {
	record.Schema = CloseRecordSchema
	record.CloseID = ""
	id, err := ComputeCloseRecordID(record)
	if err != nil {
		return CloseRecord{}, err
	}
	record.CloseID = id
	return record, record.Validate()
}

func ComputeCloseRecordID(record CloseRecord) (string, error) {
	record.CloseID = ""
	if err := record.validate(false); err != nil {
		return "", err
	}
	return canonicalHash("proof-tool/mpc-ceremony/close-record/v1", record)
}

func (r CloseRecord) Validate() error {
	if err := r.validate(true); err != nil {
		return err
	}
	expected, err := ComputeCloseRecordID(r)
	if err != nil {
		return err
	}
	if r.CloseID != expected {
		return fmt.Errorf("close_id %q, want %q", r.CloseID, expected)
	}
	return nil
}

func (r CloseRecord) validate(requireID bool) error {
	if r.Schema != CloseRecordSchema {
		return fmt.Errorf("close schema %q, want %q", r.Schema, CloseRecordSchema)
	}
	if requireID {
		if err := validateHashID("close_id", r.CloseID); err != nil {
			return err
		}
	} else if r.CloseID != "" {
		return errors.New("close_id must be empty while computing identity")
	}
	if err := validateRecordScope(r.CeremonyID, r.Phase, r.PhaseID); err != nil {
		return err
	}
	if r.FinalIndex == 0 || r.FinalIndex > MaxParticipants || int(r.FinalIndex) != len(r.AcceptedParticipants) {
		return errors.New("final_index must equal the non-empty accepted participant count")
	}
	if err := r.FinalPayload.Validate(); err != nil {
		return fmt.Errorf("final_payload: %w", err)
	}
	if err := validateHashID("chain_head_id", r.ChainHeadID); err != nil {
		return err
	}
	if err := validateUniqueIDs("accepted participant", r.AcceptedParticipants, MaxParticipants); err != nil {
		return err
	}
	if err := validateID("beacon_provider", r.BeaconProvider); err != nil {
		return err
	}
	if err := validateID("beacon_network", r.BeaconNetwork); err != nil {
		return err
	}
	if r.BeaconRound == 0 {
		return errors.New("beacon_round must be positive")
	}
	if err := validateTimestamp("beacon_not_before", r.BeaconNotBefore); err != nil {
		return err
	}
	if err := validateTimestamp("closed_at", r.ClosedAt); err != nil {
		return err
	}
	notBefore, _ := time.Parse(time.RFC3339Nano, r.BeaconNotBefore)
	closed, _ := time.Parse(time.RFC3339Nano, r.ClosedAt)
	if !notBefore.After(closed) {
		return errors.New("beacon_not_before must be after closed_at")
	}
	roundTime, err := QuicknetRoundTime(r.BeaconRound)
	if err != nil {
		return err
	}
	if !notBefore.Equal(roundTime) {
		return fmt.Errorf(
			"beacon_not_before %s does not equal pinned beacon round %d schedule %s",
			r.BeaconNotBefore,
			r.BeaconRound,
			roundTime.Format(time.RFC3339),
		)
	}
	if err := validateID("coordinator_id", r.CoordinatorID); err != nil {
		return err
	}
	return validateID("coordinator_key_id", r.CoordinatorKeyID)
}

func ValidateClose(definition CeremonyDefinition, chain Chain, close CloseRecord) error {
	if err := definition.Validate(); err != nil {
		return err
	}
	if err := chain.ValidateAgainstDefinition(definition); err != nil {
		return err
	}
	if err := close.Validate(); err != nil {
		return err
	}
	head, _ := chain.HeadRecordID()
	payload, _ := chain.HeadPayload()
	participants, _ := chain.ParticipantIDs()
	policy, _ := definition.PolicyForPhase(chain.Phase)
	if definition.Mode == ModeProduction && len(chain.Records) != len(policy.Participants) {
		return fmt.Errorf(
			"production phase has %d accepted contributions, but all %d scheduled participants are required",
			len(chain.Records),
			len(policy.Participants),
		)
	}
	if definition.Mode == ModeRehearsal && len(chain.Records) < int(policy.Minimum) {
		return fmt.Errorf("phase has %d accepted contributions, minimum is %d", len(chain.Records), policy.Minimum)
	}
	if close.CeremonyID != chain.CeremonyID || close.Phase != chain.Phase || close.PhaseID != chain.PhaseID ||
		int(close.FinalIndex) != len(chain.Records) || close.FinalPayload != payload ||
		close.ChainHeadID != head || !slices.Equal(close.AcceptedParticipants, participants) {
		return errors.New("close record does not exactly bind accepted chain")
	}
	if close.BeaconProvider != definition.BeaconPolicy.Provider ||
		close.BeaconNetwork != definition.BeaconPolicy.Network {
		return errors.New("close record beacon does not match definition policy")
	}
	if close.CoordinatorID != definition.Coordinator.ID || close.CoordinatorKeyID != definition.Coordinator.KeyID {
		return errors.New("close record coordinator does not match definition")
	}
	createdAt, _ := time.Parse(time.RFC3339Nano, definition.CreatedAt)
	closedAt, _ := time.Parse(time.RFC3339Nano, close.ClosedAt)
	notBefore, _ := time.Parse(time.RFC3339Nano, close.BeaconNotBefore)
	if !closedAt.After(createdAt) {
		return errors.New("close record must be created after the ceremony definition")
	}
	if len(chain.Records) > 0 {
		finalAcceptedAt, _ := time.Parse(
			time.RFC3339Nano,
			chain.Records[len(chain.Records)-1].AcceptedAt,
		)
		if !closedAt.After(finalAcceptedAt) {
			return errors.New("close record must be created strictly after the final acceptance")
		}
	}
	roundTime, err := QuicknetRoundTime(close.BeaconRound)
	if err != nil {
		return err
	}
	if !roundTime.Equal(notBefore) {
		return fmt.Errorf(
			"beacon_not_before %s does not equal pinned beacon round %d schedule %s",
			close.BeaconNotBefore,
			close.BeaconRound,
			roundTime.Format(time.RFC3339),
		)
	}
	if !roundTime.After(closedAt) {
		return errors.New("beacon round was not in the future when the phase closed")
	}
	minimumLead := time.Duration(definition.BeaconPolicy.MinimumWitnessLeadSeconds) * time.Second
	if roundTime.Sub(closedAt) < minimumLead {
		return fmt.Errorf(
			"beacon round lead %s is below signed minimum %s",
			roundTime.Sub(closedAt),
			minimumLead,
		)
	}
	return nil
}

type BeaconRecord struct {
	Schema          string      `json:"schema"`
	BeaconID        string      `json:"beacon_id"`
	CeremonyID      string      `json:"ceremony_id"`
	Phase           Phase       `json:"phase"`
	PhaseID         string      `json:"phase_id"`
	CloseID         string      `json:"close_id"`
	Provider        string      `json:"provider"`
	Network         string      `json:"network"`
	Round           uint64      `json:"round"`
	PublishedAt     string      `json:"published_at"`
	RawResponse     ArtifactRef `json:"raw_response"`
	RandomnessHex   string      `json:"randomness_hex"`
	ChallengeHex    string      `json:"challenge_hex"`
	ChallengeSHA256 string      `json:"challenge_sha256"`
}

func NewBeaconRecord(record BeaconRecord) (BeaconRecord, error) {
	record.Schema = BeaconRecordSchema
	record.BeaconID = ""
	randomness, err := decodeBeaconRandomness(record.RandomnessHex)
	if err != nil {
		return BeaconRecord{}, err
	}
	challenge, err := DeriveBeaconChallenge(
		record.CloseID,
		record.Provider,
		record.Network,
		record.Round,
		randomness,
	)
	if err != nil {
		return BeaconRecord{}, err
	}
	challengeHex := hex.EncodeToString(challenge)
	challengeSHA256 := taggedSHA256(challenge)
	if record.ChallengeHex != "" && record.ChallengeHex != challengeHex {
		return BeaconRecord{}, errors.New("caller-supplied challenge_hex does not match deterministic beacon challenge")
	}
	if record.ChallengeSHA256 != "" && record.ChallengeSHA256 != challengeSHA256 {
		return BeaconRecord{}, errors.New("caller-supplied challenge_sha256 does not match deterministic beacon challenge")
	}
	record.ChallengeHex = challengeHex
	record.ChallengeSHA256 = challengeSHA256
	id, err := ComputeBeaconRecordID(record)
	if err != nil {
		return BeaconRecord{}, err
	}
	record.BeaconID = id
	return record, record.Validate()
}

func ComputeBeaconRecordID(record BeaconRecord) (string, error) {
	record.BeaconID = ""
	if err := record.validate(false); err != nil {
		return "", err
	}
	return canonicalHash("proof-tool/mpc-ceremony/beacon-record/v1", record)
}

func (r BeaconRecord) Validate() error {
	if err := r.validate(true); err != nil {
		return err
	}
	expected, err := ComputeBeaconRecordID(r)
	if err != nil {
		return err
	}
	if r.BeaconID != expected {
		return fmt.Errorf("beacon_id %q, want %q", r.BeaconID, expected)
	}
	return nil
}

func (r BeaconRecord) validate(requireID bool) error {
	if r.Schema != BeaconRecordSchema {
		return fmt.Errorf("beacon schema %q, want %q", r.Schema, BeaconRecordSchema)
	}
	if requireID {
		if err := validateHashID("beacon_id", r.BeaconID); err != nil {
			return err
		}
	} else if r.BeaconID != "" {
		return errors.New("beacon_id must be empty while computing identity")
	}
	if err := validateRecordScope(r.CeremonyID, r.Phase, r.PhaseID); err != nil {
		return err
	}
	if err := validateHashID("close_id", r.CloseID); err != nil {
		return err
	}
	if err := validateID("provider", r.Provider); err != nil {
		return err
	}
	if err := validateID("network", r.Network); err != nil {
		return err
	}
	if r.Round == 0 {
		return errors.New("beacon round must be positive")
	}
	if err := validateTimestamp("published_at", r.PublishedAt); err != nil {
		return err
	}
	if err := r.RawResponse.Validate(); err != nil {
		return fmt.Errorf("raw_response: %w", err)
	}
	randomness, err := decodeBeaconRandomness(r.RandomnessHex)
	if err != nil {
		return err
	}
	challenge, err := DeriveBeaconChallenge(r.CloseID, r.Provider, r.Network, r.Round, randomness)
	if err != nil {
		return err
	}
	if r.ChallengeHex != hex.EncodeToString(challenge) ||
		r.ChallengeSHA256 != taggedSHA256(challenge) {
		return errors.New("beacon challenge does not match deterministic derivation")
	}
	return nil
}

func ValidateBeacon(definition CeremonyDefinition, close CloseRecord, beacon BeaconRecord) error {
	if err := definition.Validate(); err != nil {
		return err
	}
	if err := close.Validate(); err != nil {
		return err
	}
	if err := beacon.Validate(); err != nil {
		return err
	}
	if close.CeremonyID != definition.CeremonyID ||
		close.BeaconProvider != definition.BeaconPolicy.Provider ||
		close.BeaconNetwork != definition.BeaconPolicy.Network {
		return errors.New("close record does not match ceremony definition or beacon policy")
	}
	if beacon.CeremonyID != close.CeremonyID || beacon.Phase != close.Phase ||
		beacon.PhaseID != close.PhaseID || beacon.CloseID != close.CloseID ||
		beacon.Provider != close.BeaconProvider || beacon.Network != close.BeaconNetwork ||
		beacon.Round != close.BeaconRound {
		return errors.New("beacon record does not exactly bind close record")
	}
	randomness, err := decodeBeaconRandomness(beacon.RandomnessHex)
	if err != nil {
		return err
	}
	challenge, err := DeriveBeaconChallenge(
		close.CloseID,
		close.BeaconProvider,
		close.BeaconNetwork,
		close.BeaconRound,
		randomness,
	)
	if err != nil {
		return err
	}
	if beacon.ChallengeHex != hex.EncodeToString(challenge) ||
		beacon.ChallengeSHA256 != taggedSHA256(challenge) {
		return errors.New("beacon challenge does not match the bound close record")
	}
	published, _ := time.Parse(time.RFC3339Nano, beacon.PublishedAt)
	notBefore, _ := time.Parse(time.RFC3339Nano, close.BeaconNotBefore)
	if published.Before(notBefore) {
		return errors.New("beacon was published before the committed future time")
	}
	roundTime, err := QuicknetRoundTime(close.BeaconRound)
	if err != nil {
		return err
	}
	if published.Before(roundTime) {
		return errors.New("beacon published_at predates the pinned quicknet round schedule")
	}
	if len(challenge) < int(definition.BeaconPolicy.MinimumChallengeBytes) {
		return errors.New("beacon challenge is shorter than definition policy")
	}
	return nil
}

// QuicknetRoundTime returns the scheduled UTC publication time for a pinned
// drand quicknet mainnet round.
func QuicknetRoundTime(round uint64) (time.Time, error) {
	if round == 0 {
		return time.Time{}, errors.New("beacon round must be positive")
	}
	offset := round - 1
	period := uint64(BeaconQuicknetPeriod)
	maxOffset := uint64(math.MaxInt64-BeaconQuicknetGenesis) / period
	if offset > maxOffset {
		return time.Time{}, errors.New("beacon round time overflows int64 Unix seconds")
	}
	seconds := BeaconQuicknetGenesis + int64(offset*period)
	return time.Unix(seconds, 0).UTC(), nil
}

// DeriveBeaconChallenge maps authenticated public beacon randomness to the
// exact 32-byte challenge supplied to gnark. Length prefixes make every input
// tuple unambiguous and the domain tag prevents reuse in another protocol.
func DeriveBeaconChallenge(closeID, provider, network string, round uint64, randomness []byte) ([]byte, error) {
	if err := validateHashID("close_id", closeID); err != nil {
		return nil, err
	}
	if provider != BeaconProviderDrand {
		return nil, fmt.Errorf("beacon provider %q, want %q", provider, BeaconProviderDrand)
	}
	if network != BeaconNetworkQuicknet {
		return nil, fmt.Errorf("beacon network %q, want %q", network, BeaconNetworkQuicknet)
	}
	if round == 0 {
		return nil, errors.New("beacon round must be positive")
	}
	if len(randomness) != sha256.Size {
		return nil, fmt.Errorf("beacon randomness must contain exactly %d bytes, got %d", sha256.Size, len(randomness))
	}

	digest := sha256.New()
	digest.Write([]byte("proof-tool/mpc-ceremony/beacon-challenge/v1"))
	digest.Write([]byte{0})
	writeBeaconChallengeField(digest, []byte(closeID))
	writeBeaconChallengeField(digest, []byte(provider))
	writeBeaconChallengeField(digest, []byte(network))
	var encodedRound [8]byte
	binary.BigEndian.PutUint64(encodedRound[:], round)
	digest.Write(encodedRound[:])
	writeBeaconChallengeField(digest, randomness)
	return digest.Sum(nil), nil
}

func writeBeaconChallengeField(destination hash.Hash, value []byte) {
	var encodedLength [4]byte
	binary.BigEndian.PutUint32(encodedLength[:], uint32(len(value)))
	destination.Write(encodedLength[:])
	destination.Write(value)
}

func decodeBeaconRandomness(value string) ([]byte, error) {
	if len(value) != sha256.Size*2 {
		return nil, fmt.Errorf("randomness_hex must contain exactly %d bytes", sha256.Size)
	}
	if value != stringLower(value) {
		return nil, errors.New("randomness_hex must be lowercase hexadecimal")
	}
	randomness, err := hex.DecodeString(value)
	if err != nil {
		return nil, errors.New("randomness_hex must be lowercase hexadecimal")
	}
	return randomness, nil
}

type SealRecord struct {
	Schema       string        `json:"schema"`
	SealID       string        `json:"seal_id"`
	CeremonyID   string        `json:"ceremony_id"`
	Phase        Phase         `json:"phase"`
	PhaseID      string        `json:"phase_id"`
	CloseID      string        `json:"close_id"`
	BeaconID     string        `json:"beacon_id"`
	FinalPayload ArtifactRef   `json:"final_payload"`
	Outputs      []ArtifactRef `json:"outputs"`
	SealedAt     string        `json:"sealed_at"`
}

func NewSealRecord(record SealRecord) (SealRecord, error) {
	record.Schema = SealRecordSchema
	record.SealID = ""
	id, err := ComputeSealRecordID(record)
	if err != nil {
		return SealRecord{}, err
	}
	record.SealID = id
	return record, record.Validate()
}

func ComputeSealRecordID(record SealRecord) (string, error) {
	record.SealID = ""
	if err := record.validate(false); err != nil {
		return "", err
	}
	return canonicalHash("proof-tool/mpc-ceremony/seal-record/v1", record)
}

func (r SealRecord) Validate() error {
	if err := r.validate(true); err != nil {
		return err
	}
	expected, err := ComputeSealRecordID(r)
	if err != nil {
		return err
	}
	if r.SealID != expected {
		return fmt.Errorf("seal_id %q, want %q", r.SealID, expected)
	}
	return nil
}

func (r SealRecord) validate(requireID bool) error {
	if r.Schema != SealRecordSchema {
		return fmt.Errorf("seal schema %q, want %q", r.Schema, SealRecordSchema)
	}
	if requireID {
		if err := validateHashID("seal_id", r.SealID); err != nil {
			return err
		}
	} else if r.SealID != "" {
		return errors.New("seal_id must be empty while computing identity")
	}
	if err := validateRecordScope(r.CeremonyID, r.Phase, r.PhaseID); err != nil {
		return err
	}
	if err := validateHashID("close_id", r.CloseID); err != nil {
		return err
	}
	if err := validateHashID("beacon_id", r.BeaconID); err != nil {
		return err
	}
	if err := r.FinalPayload.Validate(); err != nil {
		return fmt.Errorf("final_payload: %w", err)
	}
	if err := validateArtifactList("seal outputs", r.Outputs, 8); err != nil {
		return err
	}
	return validateTimestamp("sealed_at", r.SealedAt)
}

func ValidateSeal(close CloseRecord, beacon BeaconRecord, seal SealRecord) error {
	if err := close.Validate(); err != nil {
		return err
	}
	if err := beacon.Validate(); err != nil {
		return err
	}
	if err := seal.Validate(); err != nil {
		return err
	}
	if seal.CeremonyID != close.CeremonyID || seal.Phase != close.Phase ||
		seal.PhaseID != close.PhaseID || seal.CloseID != close.CloseID ||
		seal.BeaconID != beacon.BeaconID || seal.FinalPayload != close.FinalPayload {
		return errors.New("seal record does not exactly bind close and beacon records")
	}
	sealed, _ := time.Parse(time.RFC3339Nano, seal.SealedAt)
	published, _ := time.Parse(time.RFC3339Nano, beacon.PublishedAt)
	if sealed.Before(published) {
		return errors.New("seal predates beacon publication")
	}
	return nil
}

type AuditRecord struct {
	Schema           string        `json:"schema"`
	AuditID          string        `json:"audit_id"`
	CeremonyID       string        `json:"ceremony_id"`
	AuditorID        string        `json:"auditor_id"`
	AuditorKeyID     string        `json:"auditor_key_id"`
	Definition       ArtifactRef   `json:"definition"`
	Phase1Chain      ArtifactRef   `json:"phase1_chain"`
	Phase2Chain      ArtifactRef   `json:"phase2_chain"`
	Phase1SealID     string        `json:"phase1_seal_id"`
	Phase2SealID     string        `json:"phase2_seal_id"`
	ReplayRootSHA256 string        `json:"replay_root_sha256"`
	Outputs          []ArtifactRef `json:"outputs"`
	Passed           bool          `json:"passed"`
	Findings         []string      `json:"findings"`
	AuditedAt        string        `json:"audited_at"`
}

func NewAuditRecord(record AuditRecord) (AuditRecord, error) {
	record.Schema = AuditRecordSchema
	record.AuditID = ""
	id, err := ComputeAuditRecordID(record)
	if err != nil {
		return AuditRecord{}, err
	}
	record.AuditID = id
	return record, record.Validate()
}

func ComputeAuditRecordID(record AuditRecord) (string, error) {
	record.AuditID = ""
	if err := record.validate(false); err != nil {
		return "", err
	}
	return canonicalHash("proof-tool/mpc-ceremony/audit-record/v1", record)
}

func (r AuditRecord) Validate() error {
	if err := r.validate(true); err != nil {
		return err
	}
	expected, err := ComputeAuditRecordID(r)
	if err != nil {
		return err
	}
	if r.AuditID != expected {
		return fmt.Errorf("audit_id %q, want %q", r.AuditID, expected)
	}
	return nil
}

func (r AuditRecord) validate(requireID bool) error {
	if r.Schema != AuditRecordSchema {
		return fmt.Errorf("audit schema %q, want %q", r.Schema, AuditRecordSchema)
	}
	if requireID {
		if err := validateHashID("audit_id", r.AuditID); err != nil {
			return err
		}
	} else if r.AuditID != "" {
		return errors.New("audit_id must be empty while computing identity")
	}
	if err := validateHashID("ceremony_id", r.CeremonyID); err != nil {
		return err
	}
	if err := validateID("auditor_id", r.AuditorID); err != nil {
		return err
	}
	if err := validateID("auditor_key_id", r.AuditorKeyID); err != nil {
		return err
	}
	for label, artifact := range map[string]ArtifactRef{
		"definition":   r.Definition,
		"phase1_chain": r.Phase1Chain,
		"phase2_chain": r.Phase2Chain,
	} {
		if err := artifact.Validate(); err != nil {
			return fmt.Errorf("%s: %w", label, err)
		}
	}
	if err := validateHashID("phase1_seal_id", r.Phase1SealID); err != nil {
		return err
	}
	if err := validateHashID("phase2_seal_id", r.Phase2SealID); err != nil {
		return err
	}
	if err := validateHashID("replay_root_sha256", r.ReplayRootSHA256); err != nil {
		return err
	}
	if err := validateArtifactList("audit outputs", r.Outputs, 16); err != nil {
		return err
	}
	if r.Passed && len(r.Findings) != 0 {
		return errors.New("passing audit must not contain findings")
	}
	if !r.Passed && len(r.Findings) == 0 {
		return errors.New("failed audit must contain at least one finding")
	}
	for _, finding := range r.Findings {
		if finding == "" {
			return errors.New("audit findings must not be empty")
		}
	}
	return validateTimestamp("audited_at", r.AuditedAt)
}

type PhaseSummary struct {
	Phase             Phase         `json:"phase"`
	PhaseID           string        `json:"phase_id"`
	Genesis           ArtifactRef   `json:"genesis"`
	Chain             ArtifactRef   `json:"chain"`
	ChainHeadID       string        `json:"chain_head_id"`
	ContributionCount uint8         `json:"contribution_count"`
	Participants      []string      `json:"participants"`
	CloseID           string        `json:"close_id"`
	BeaconID          string        `json:"beacon_id"`
	SealID            string        `json:"seal_id"`
	Outputs           []ArtifactRef `json:"outputs"`
}

func (s PhaseSummary) Validate() error {
	if err := s.Phase.Validate(); err != nil {
		return err
	}
	if err := validateHashID("phase_id", s.PhaseID); err != nil {
		return err
	}
	if err := s.Genesis.Validate(); err != nil {
		return fmt.Errorf("genesis: %w", err)
	}
	if err := s.Chain.Validate(); err != nil {
		return fmt.Errorf("chain: %w", err)
	}
	if err := validateHashID("chain_head_id", s.ChainHeadID); err != nil {
		return err
	}
	if s.ContributionCount == 0 || int(s.ContributionCount) != len(s.Participants) {
		return errors.New("contribution_count must equal non-empty participants")
	}
	if err := validateUniqueIDs("participant", s.Participants, MaxParticipants); err != nil {
		return err
	}
	for label, id := range map[string]string{
		"close_id":  s.CloseID,
		"beacon_id": s.BeaconID,
		"seal_id":   s.SealID,
	} {
		if err := validateHashID(label, id); err != nil {
			return err
		}
	}
	return validateArtifactList("phase outputs", s.Outputs, 8)
}

type FinalTranscript struct {
	Schema              string             `json:"schema"`
	TranscriptID        string             `json:"transcript_id"`
	CeremonyID          string             `json:"ceremony_id"`
	Definition          ArtifactRef        `json:"definition"`
	Circuit             CircuitBinding     `json:"circuit"`
	Phase1              PhaseSummary       `json:"phase1"`
	Phase2              PhaseSummary       `json:"phase2"`
	Audits              []ArtifactRef      `json:"audits"`
	OperationalEvidence SignedArtifactRefs `json:"operational_evidence"`
	ProvingKey          ArtifactRef        `json:"proving_key"`
	VerifyingKey        ArtifactRef        `json:"verifying_key"`
	CardanoVerifyingKey ArtifactRef        `json:"cardano_verifying_key"`
	FinalizedAt         string             `json:"finalized_at"`
}

func NewFinalTranscript(record FinalTranscript) (FinalTranscript, error) {
	record.Schema = FinalTranscriptSchema
	record.TranscriptID = ""
	id, err := ComputeFinalTranscriptID(record)
	if err != nil {
		return FinalTranscript{}, err
	}
	record.TranscriptID = id
	return record, record.Validate()
}

func ComputeFinalTranscriptID(record FinalTranscript) (string, error) {
	record.TranscriptID = ""
	if err := record.validate(false); err != nil {
		return "", err
	}
	return canonicalHash("proof-tool/mpc-ceremony/final-transcript/v1", record)
}

func (r FinalTranscript) Validate() error {
	if err := r.validate(true); err != nil {
		return err
	}
	expected, err := ComputeFinalTranscriptID(r)
	if err != nil {
		return err
	}
	if r.TranscriptID != expected {
		return fmt.Errorf("transcript_id %q, want %q", r.TranscriptID, expected)
	}
	return nil
}

func (r FinalTranscript) validate(requireID bool) error {
	if r.Schema != FinalTranscriptSchema {
		return fmt.Errorf("transcript schema %q, want %q", r.Schema, FinalTranscriptSchema)
	}
	if requireID {
		if err := validateHashID("transcript_id", r.TranscriptID); err != nil {
			return err
		}
	} else if r.TranscriptID != "" {
		return errors.New("transcript_id must be empty while computing identity")
	}
	if err := validateHashID("ceremony_id", r.CeremonyID); err != nil {
		return err
	}
	if err := r.Definition.Validate(); err != nil {
		return fmt.Errorf("definition: %w", err)
	}
	if err := r.Circuit.Validate(); err != nil {
		return fmt.Errorf("circuit: %w", err)
	}
	if err := r.Phase1.Validate(); err != nil {
		return fmt.Errorf("phase1: %w", err)
	}
	if r.Phase1.Phase != Phase1 {
		return errors.New("phase1 summary has wrong phase")
	}
	if err := r.Phase2.Validate(); err != nil {
		return fmt.Errorf("phase2: %w", err)
	}
	if r.Phase2.Phase != Phase2 {
		return errors.New("phase2 summary has wrong phase")
	}
	if len(r.Audits) < 2 {
		return errors.New("final transcript requires at least two independent audit artifacts")
	}
	if err := validateArtifactList("audits", r.Audits, MaxParticipants); err != nil {
		return err
	}
	if err := r.OperationalEvidence.Validate(); err != nil {
		return fmt.Errorf("operational_evidence: %w", err)
	}
	for label, artifact := range map[string]ArtifactRef{
		"proving_key":           r.ProvingKey,
		"verifying_key":         r.VerifyingKey,
		"cardano_verifying_key": r.CardanoVerifyingKey,
	} {
		if err := artifact.Validate(); err != nil {
			return fmt.Errorf("%s: %w", label, err)
		}
	}
	return validateTimestamp("finalized_at", r.FinalizedAt)
}

func validateRecordScope(ceremonyID string, phase Phase, phaseID string) error {
	if err := validateHashID("ceremony_id", ceremonyID); err != nil {
		return err
	}
	if err := phase.Validate(); err != nil {
		return err
	}
	return validateHashID("phase_id", phaseID)
}

func validateHashID(label, value string) error {
	if err := validateTaggedHex(value, "sha256:", sha256.Size); err != nil {
		return fmt.Errorf("%s: %w", label, err)
	}
	return nil
}

func validateUniqueIDs(label string, values []string, maximum int) error {
	if len(values) == 0 || len(values) > maximum {
		return fmt.Errorf("%s list must contain between 1 and %d entries", label, maximum)
	}
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if err := validateID(label, value); err != nil {
			return err
		}
		if _, duplicate := seen[value]; duplicate {
			return fmt.Errorf("%s %q is duplicated", label, value)
		}
		seen[value] = struct{}{}
	}
	return nil
}

func validateArtifactList(label string, artifacts []ArtifactRef, maximum int) error {
	if len(artifacts) == 0 || len(artifacts) > maximum {
		return fmt.Errorf("%s must contain between 1 and %d artifacts", label, maximum)
	}
	names := make(map[string]struct{}, len(artifacts))
	for index, artifact := range artifacts {
		if err := artifact.Validate(); err != nil {
			return fmt.Errorf("%s %d: %w", label, index, err)
		}
		if _, duplicate := names[artifact.Name]; duplicate {
			return fmt.Errorf("%s artifact name %q is duplicated", label, artifact.Name)
		}
		names[artifact.Name] = struct{}{}
	}
	return nil
}

func stringLower(value string) string {
	result := make([]byte, len(value))
	for index := range value {
		c := value[index]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		result[index] = c
	}
	return string(result)
}
