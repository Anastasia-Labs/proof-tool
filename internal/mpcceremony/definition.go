package mpcceremony

import (
	"errors"
	"fmt"
)

const ProductionMinimumWitnessLeadSeconds uint32 = 24 * 60 * 60

type CeremonyDefinition struct {
	Schema          string          `json:"schema"`
	CeremonyID      string          `json:"ceremony_id"`
	Mode            string          `json:"mode"`
	CreatedAt       string          `json:"created_at"`
	SessionNonceHex string          `json:"session_nonce_hex"`
	Circuit         CircuitBinding  `json:"circuit"`
	Software        SoftwareBinding `json:"software"`
	Coordinator     Identity        `json:"coordinator"`
	ReleaseSigner   Identity        `json:"release_signer"`
	Auditors        []Identity      `json:"auditors"`
	Roster          []Participant   `json:"roster"`
	Phase1Policy    PhasePolicy     `json:"phase1_policy"`
	Phase2Policy    PhasePolicy     `json:"phase2_policy"`
	BeaconPolicy    BeaconPolicy    `json:"beacon_policy"`
	Phase1Genesis   ArtifactRef     `json:"phase1_genesis"`
}

type DefinitionOptions struct {
	Mode            string
	CreatedAt       string
	SessionNonceHex string
	Circuit         CircuitBinding
	Software        SoftwareBinding
	Coordinator     Identity
	ReleaseSigner   Identity
	Auditors        []Identity
	Roster          []Participant
	Phase1Policy    PhasePolicy
	Phase2Policy    PhasePolicy
	BeaconPolicy    BeaconPolicy
	Phase1Genesis   ArtifactRef
}

func NewCeremonyDefinition(options DefinitionOptions) (CeremonyDefinition, error) {
	definition := CeremonyDefinition{
		Schema:          DefinitionSchema,
		Mode:            options.Mode,
		CreatedAt:       options.CreatedAt,
		SessionNonceHex: options.SessionNonceHex,
		Circuit:         options.Circuit,
		Software:        options.Software,
		Coordinator:     options.Coordinator,
		ReleaseSigner:   options.ReleaseSigner,
		Auditors:        append([]Identity(nil), options.Auditors...),
		Roster:          append([]Participant(nil), options.Roster...),
		Phase1Policy:    clonePhasePolicy(options.Phase1Policy),
		Phase2Policy:    clonePhasePolicy(options.Phase2Policy),
		BeaconPolicy:    options.BeaconPolicy,
		Phase1Genesis:   options.Phase1Genesis,
	}
	id, err := ComputeCeremonyID(definition)
	if err != nil {
		return CeremonyDefinition{}, err
	}
	definition.CeremonyID = id
	if err := definition.Validate(); err != nil {
		return CeremonyDefinition{}, err
	}
	return definition, nil
}

// FinalizeCeremonyDefinition validates an assembled definition and fills its
// content-derived CeremonyID. It is useful to decouple expensive circuit
// compilation from metadata construction.
func FinalizeCeremonyDefinition(definition CeremonyDefinition) (CeremonyDefinition, error) {
	definition.Schema = DefinitionSchema
	definition.CeremonyID = ""
	id, err := ComputeCeremonyID(definition)
	if err != nil {
		return CeremonyDefinition{}, err
	}
	definition.CeremonyID = id
	if err := definition.Validate(); err != nil {
		return CeremonyDefinition{}, err
	}
	return definition, nil
}

func ComputeCeremonyID(definition CeremonyDefinition) (string, error) {
	definition.CeremonyID = ""
	if err := definition.validate(false); err != nil {
		return "", err
	}
	return canonicalHash("proof-tool/mpc-ceremony/root/v1", definition)
}

func (d CeremonyDefinition) Validate() error {
	if err := d.validate(true); err != nil {
		return err
	}
	expected, err := ComputeCeremonyID(d)
	if err != nil {
		return err
	}
	if d.CeremonyID != expected {
		return fmt.Errorf("ceremony_id %q, want %q", d.CeremonyID, expected)
	}
	return nil
}

func (d CeremonyDefinition) validate(requireID bool) error {
	if d.Schema != DefinitionSchema {
		return fmt.Errorf("definition schema %q, want %q", d.Schema, DefinitionSchema)
	}
	if requireID {
		if err := validateTaggedHex(d.CeremonyID, "sha256:", 32); err != nil {
			return fmt.Errorf("ceremony_id: %w", err)
		}
	} else if d.CeremonyID != "" {
		return errors.New("ceremony_id must be empty while computing the definition identity")
	}
	switch d.Mode {
	case ModeRehearsal:
	case ModeProduction:
		if d.Software.SourceDirty {
			return errors.New("production ceremony requires a clean source tree")
		}
		if err := validateProductionBuildProfile(
			d.Software.GoVersion,
			d.Software.GoOS,
			d.Software.GoArch,
			d.Software.GoAMD64,
			d.Software.Compiler,
			d.Software.BuildMode,
			d.Software.CGOEnabled,
			d.Software.TrimPath,
		); err != nil {
			return fmt.Errorf("production software profile: %w", err)
		}
	default:
		return fmt.Errorf("mode %q, want %q or %q", d.Mode, ModeRehearsal, ModeProduction)
	}
	if err := validateTimestamp("created_at", d.CreatedAt); err != nil {
		return err
	}
	if err := validateHex(d.SessionNonceHex, 32); err != nil {
		return fmt.Errorf("session_nonce_hex: %w", err)
	}
	if err := d.Circuit.Validate(); err != nil {
		return fmt.Errorf("circuit: %w", err)
	}
	if err := d.Software.Validate(); err != nil {
		return fmt.Errorf("software: %w", err)
	}
	if err := d.Coordinator.Validate(); err != nil {
		return fmt.Errorf("coordinator: %w", err)
	}
	if err := d.ReleaseSigner.Validate(); err != nil {
		return fmt.Errorf("release_signer: %w", err)
	}
	if d.ReleaseSigner.ID == d.Coordinator.ID || d.ReleaseSigner.KeyID == d.Coordinator.KeyID {
		return errors.New("release signer must be distinct from coordinator")
	}
	if len(d.Auditors) < 2 {
		return errors.New("at least two independent auditors are required")
	}
	identityIDs := map[string]string{
		d.Coordinator.ID:   "coordinator",
		d.ReleaseSigner.ID: "release signer",
	}
	keyIDs := map[string]string{
		d.Coordinator.KeyID:   "coordinator",
		d.ReleaseSigner.KeyID: "release signer",
	}
	publicKeyFingerprints := map[string]string{
		d.Coordinator.PublicKeyFingerprint: "coordinator",
	}
	if previous, exists := publicKeyFingerprints[d.ReleaseSigner.PublicKeyFingerprint]; exists {
		return fmt.Errorf("release signer public key duplicates %s", previous)
	}
	publicKeyFingerprints[d.ReleaseSigner.PublicKeyFingerprint] = "release signer"
	for index, auditor := range d.Auditors {
		if err := auditor.Validate(); err != nil {
			return fmt.Errorf("auditor %d: %w", index, err)
		}
		if previous, exists := identityIDs[auditor.ID]; exists {
			return fmt.Errorf("auditor identity %q duplicates %s", auditor.ID, previous)
		}
		if previous, exists := keyIDs[auditor.KeyID]; exists {
			return fmt.Errorf("auditor key %q duplicates %s", auditor.KeyID, previous)
		}
		if previous, exists := publicKeyFingerprints[auditor.PublicKeyFingerprint]; exists {
			return fmt.Errorf("auditor public key duplicates %s", previous)
		}
		identityIDs[auditor.ID] = "auditor"
		keyIDs[auditor.KeyID] = "auditor"
		publicKeyFingerprints[auditor.PublicKeyFingerprint] = "auditor"
	}
	if len(d.Roster) == 0 || len(d.Roster) > MaxParticipants {
		return fmt.Errorf("roster must contain between 1 and %d participants", MaxParticipants)
	}
	roster := make(map[string]Participant, len(d.Roster))
	for index, participant := range d.Roster {
		if err := participant.Validate(); err != nil {
			return fmt.Errorf("roster participant %d: %w", index, err)
		}
		id := participant.Identity.ID
		keyID := participant.Identity.KeyID
		if _, duplicate := roster[id]; duplicate {
			return fmt.Errorf("roster participant %q is duplicated", id)
		}
		if previous, exists := identityIDs[id]; exists {
			return fmt.Errorf("participant identity %q duplicates %s", id, previous)
		}
		if previous, exists := keyIDs[keyID]; exists {
			return fmt.Errorf("participant key %q duplicates %s", keyID, previous)
		}
		if previous, exists := publicKeyFingerprints[participant.Identity.PublicKeyFingerprint]; exists {
			return fmt.Errorf("participant public key duplicates %s", previous)
		}
		roster[id] = participant
		identityIDs[id] = "participant"
		keyIDs[keyID] = "participant"
		publicKeyFingerprints[participant.Identity.PublicKeyFingerprint] = "participant"
	}
	if err := d.Phase1Policy.Validate(roster); err != nil {
		return fmt.Errorf("phase1_policy: %w", err)
	}
	if err := d.Phase2Policy.Validate(roster); err != nil {
		return fmt.Errorf("phase2_policy: %w", err)
	}
	if d.Mode == ModeProduction {
		if d.BeaconPolicy.MinimumWitnessLeadSeconds < ProductionMinimumWitnessLeadSeconds {
			return fmt.Errorf(
				"production beacon minimum_witness_lead_seconds %d is below required %d",
				d.BeaconPolicy.MinimumWitnessLeadSeconds,
				ProductionMinimumWitnessLeadSeconds,
			)
		}
		if len(d.Roster) < 2 {
			return errors.New("production ceremony requires at least two distinct roster participants")
		}
		if len(d.Phase1Policy.Participants) < 2 {
			return errors.New("production phase1 policy requires at least two scheduled participants")
		}
		if int(d.Phase1Policy.Minimum) != len(d.Phase1Policy.Participants) {
			return errors.New("production phase1 minimum must equal the complete scheduled participant count")
		}
		if len(d.Phase2Policy.Participants) < 2 {
			return errors.New("production phase2 policy requires at least two scheduled participants")
		}
		if int(d.Phase2Policy.Minimum) != len(d.Phase2Policy.Participants) {
			return errors.New("production phase2 minimum must equal the complete scheduled participant count")
		}
	}
	if err := d.BeaconPolicy.Validate(); err != nil {
		return fmt.Errorf("beacon_policy: %w", err)
	}
	if err := d.Phase1Genesis.Validate(); err != nil {
		return fmt.Errorf("phase1_genesis: %w", err)
	}
	return nil
}

func (d CeremonyDefinition) PolicyForPhase(phase Phase) (PhasePolicy, error) {
	switch phase {
	case Phase1:
		return clonePhasePolicy(d.Phase1Policy), nil
	case Phase2:
		return clonePhasePolicy(d.Phase2Policy), nil
	default:
		return PhasePolicy{}, fmt.Errorf("unsupported phase %q", phase)
	}
}

func (d CeremonyDefinition) ParticipantByID(id string) (Participant, bool) {
	for _, participant := range d.Roster {
		if participant.Identity.ID == id {
			return participant, true
		}
	}
	return Participant{}, false
}

func ComputePhaseID(ceremonyID string, phase Phase, genesis ArtifactRef, parentSealID string) (string, error) {
	if err := validateTaggedHex(ceremonyID, "sha256:", 32); err != nil {
		return "", fmt.Errorf("ceremony_id: %w", err)
	}
	if err := phase.Validate(); err != nil {
		return "", err
	}
	if err := genesis.Validate(); err != nil {
		return "", fmt.Errorf("genesis: %w", err)
	}
	if phase == Phase1 && parentSealID != "" {
		return "", errors.New("phase1 must not have a parent seal")
	}
	if phase == Phase2 {
		if err := validateTaggedHex(parentSealID, "sha256:", 32); err != nil {
			return "", fmt.Errorf("phase2 parent seal: %w", err)
		}
	}
	value := struct {
		CeremonyID   string      `json:"ceremony_id"`
		Phase        Phase       `json:"phase"`
		Genesis      ArtifactRef `json:"genesis"`
		ParentSealID string      `json:"parent_seal_id"`
	}{ceremonyID, phase, genesis, parentSealID}
	return canonicalHash("proof-tool/mpc-ceremony/phase/v1", value)
}

func clonePhasePolicy(policy PhasePolicy) PhasePolicy {
	return PhasePolicy{
		Participants: append([]string(nil), policy.Participants...),
		Minimum:      policy.Minimum,
	}
}
