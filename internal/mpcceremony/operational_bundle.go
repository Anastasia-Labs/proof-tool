package mpcceremony

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

const OperationalEvidenceBundleSchema = "proof-tool-mpc-operational-evidence-bundle-v1"

type SignedArtifactRefs struct {
	Record    ArtifactRef `json:"record"`
	Signature ArtifactRef `json:"signature"`
}

func (r SignedArtifactRefs) Validate() error {
	if err := r.Record.Validate(); err != nil {
		return fmt.Errorf("record: %w", err)
	}
	if err := r.Signature.Validate(); err != nil {
		return fmt.Errorf("signature: %w", err)
	}
	if r.Record.Name == r.Signature.Name {
		return errors.New("signed artifact record and signature names must be distinct")
	}
	return nil
}

type AcceptedHeadOperationalEvidence struct {
	Index               uint8                `json:"index"`
	PredecessorHeadID   string               `json:"predecessor_head_id"`
	AcceptedHeadID      string               `json:"accepted_head_id"`
	OutboundHandoff     SignedArtifactRefs   `json:"outbound_handoff"`
	OutboundReceipt     SignedArtifactRefs   `json:"outbound_receipt"`
	ReturnHandoff       SignedArtifactRefs   `json:"return_handoff"`
	ReturnReceipt       SignedArtifactRefs   `json:"return_receipt"`
	AcceptedChainPrefix SignedArtifactRefs   `json:"accepted_chain_prefix"`
	MirrorReceipts      []SignedArtifactRefs `json:"mirror_receipts"`
}

func (e AcceptedHeadOperationalEvidence) Validate() error {
	if e.Index == 0 || e.Index > MaxParticipants {
		return fmt.Errorf("accepted head index must be between 1 and %d", MaxParticipants)
	}
	if err := validateHashID("accepted_head_id", e.AcceptedHeadID); err != nil {
		return err
	}
	if err := validateHashID("predecessor_head_id", e.PredecessorHeadID); err != nil {
		return err
	}
	if e.PredecessorHeadID == e.AcceptedHeadID {
		return errors.New("accepted head must differ from predecessor head")
	}
	if err := e.OutboundHandoff.Validate(); err != nil {
		return fmt.Errorf("outbound_handoff: %w", err)
	}
	if err := e.OutboundReceipt.Validate(); err != nil {
		return fmt.Errorf("outbound_receipt: %w", err)
	}
	if err := e.ReturnHandoff.Validate(); err != nil {
		return fmt.Errorf("return_handoff: %w", err)
	}
	if err := e.ReturnReceipt.Validate(); err != nil {
		return fmt.Errorf("return_receipt: %w", err)
	}
	if err := e.AcceptedChainPrefix.Validate(); err != nil {
		return fmt.Errorf("accepted_chain_prefix: %w", err)
	}
	if len(e.MirrorReceipts) < 2 || len(e.MirrorReceipts) > 8 {
		return errors.New("accepted head requires between 2 and 8 immutable mirror receipts")
	}
	return validateSignedArtifactSet("mirror_receipts", e.MirrorReceipts)
}

type PhaseOperationalEvidence struct {
	Phase                    Phase                             `json:"phase"`
	AcceptedChain            SignedArtifactRefs                `json:"accepted_chain"`
	Close                    SignedArtifactRefs                `json:"close"`
	AcceptedHeads            []AcceptedHeadOperationalEvidence `json:"accepted_heads"`
	PublicWitnessQuorum      uint8                             `json:"public_witness_quorum"`
	PublicWitnessReceipts    []SignedArtifactRefs              `json:"public_witness_receipts"`
	MultiRelayBeaconEvidence SignedArtifactRefs                `json:"multi_relay_beacon_evidence"`
	RawBeaconResponses       []ArtifactRef                     `json:"raw_beacon_responses"`
}

func (p PhaseOperationalEvidence) Validate() error {
	if err := p.Phase.Validate(); err != nil {
		return err
	}
	if err := p.AcceptedChain.Validate(); err != nil {
		return fmt.Errorf("accepted_chain: %w", err)
	}
	if err := p.Close.Validate(); err != nil {
		return fmt.Errorf("close: %w", err)
	}
	if len(p.AcceptedHeads) == 0 || len(p.AcceptedHeads) > MaxParticipants {
		return fmt.Errorf("accepted_heads must contain between 1 and %d entries", MaxParticipants)
	}
	for index, head := range p.AcceptedHeads {
		if err := head.Validate(); err != nil {
			return fmt.Errorf("accepted head %d: %w", index, err)
		}
		if head.Index != uint8(index+1) {
			return errors.New("accepted heads must be complete and ordered by one-based index")
		}
	}
	if p.PublicWitnessQuorum < 2 {
		return errors.New("public_witness_quorum must be at least 2")
	}
	if len(p.PublicWitnessReceipts) < int(p.PublicWitnessQuorum) || len(p.PublicWitnessReceipts) > 32 {
		return fmt.Errorf(
			"public witness receipt count %d does not satisfy quorum %d or maximum 32",
			len(p.PublicWitnessReceipts),
			p.PublicWitnessQuorum,
		)
	}
	if err := validateSignedArtifactSet("public_witness_receipts", p.PublicWitnessReceipts); err != nil {
		return err
	}
	if err := p.MultiRelayBeaconEvidence.Validate(); err != nil {
		return fmt.Errorf("multi_relay_beacon_evidence: %w", err)
	}
	if err := validateArtifactSet("raw_beacon_responses", p.RawBeaconResponses); err != nil {
		return err
	}
	return nil
}

// OperationalEvidenceBundle is the one canonical release input for
// independently witnessed pre-beacon publication and multi-relay beacon
// retrieval in both phases. Every referenced byte string is content-addressed
// and resolved below one caller-supplied evidence root.
type OperationalEvidenceBundle struct {
	Schema            string                   `json:"schema"`
	CeremonyID        string                   `json:"ceremony_id"`
	Enrollments       []SignedArtifactRefs     `json:"enrollments"`
	GovernanceRecords []SignedArtifactRefs     `json:"governance_records"`
	Phase1            PhaseOperationalEvidence `json:"phase1"`
	Phase2            PhaseOperationalEvidence `json:"phase2"`
	CoordinatorID     string                   `json:"coordinator_id"`
	CoordinatorKeyID  string                   `json:"coordinator_key_id"`
	AssembledAt       string                   `json:"assembled_at"`
}

func (b OperationalEvidenceBundle) Validate() error {
	if b.Schema != OperationalEvidenceBundleSchema {
		return fmt.Errorf("operational evidence schema %q, want %q", b.Schema, OperationalEvidenceBundleSchema)
	}
	if err := validateHashID("ceremony_id", b.CeremonyID); err != nil {
		return err
	}
	minimumEnrollments := 6 // coordinator, release signer, two auditors, one participant, one witness
	if len(b.Enrollments) < minimumEnrollments || len(b.Enrollments) > 128 {
		return fmt.Errorf("enrollments must contain between %d and 128 records", minimumEnrollments)
	}
	if err := validateSignedArtifactSet("enrollments", b.Enrollments); err != nil {
		return err
	}
	if len(b.GovernanceRecords) > 128 {
		return errors.New("governance_records exceeds maximum 128")
	}
	if len(b.GovernanceRecords) > 0 {
		if err := validateSignedArtifactSet("governance_records", b.GovernanceRecords); err != nil {
			return err
		}
	}
	if err := b.Phase1.Validate(); err != nil {
		return fmt.Errorf("phase1: %w", err)
	}
	if b.Phase1.Phase != Phase1 {
		return errors.New("phase1 evidence has wrong phase")
	}
	if err := b.Phase2.Validate(); err != nil {
		return fmt.Errorf("phase2: %w", err)
	}
	if b.Phase2.Phase != Phase2 {
		return errors.New("phase2 evidence has wrong phase")
	}
	if err := validateID("coordinator_id", b.CoordinatorID); err != nil {
		return err
	}
	if err := validateID("coordinator_key_id", b.CoordinatorKeyID); err != nil {
		return err
	}
	return validateTimestamp("assembled_at", b.AssembledAt)
}

type AuthenticatedCloseEvidence struct {
	Record         CloseRecord
	RecordBytes    []byte
	SignatureBytes []byte
}

// LoadAuthenticatedCloseEvidence loads exact close bytes named by a signed
// operational bundle. Authentication is deliberately completed only by
// VerifyOperationalEvidenceBundle with the external coordinator trust anchor.
func LoadAuthenticatedCloseEvidence(root string, refs SignedArtifactRefs) (AuthenticatedCloseEvidence, error) {
	if err := refs.Validate(); err != nil {
		return AuthenticatedCloseEvidence{}, err
	}
	recordBytes, err := verifyArtifactBytes(root, refs.Record, maxSignedRecordBytes)
	if err != nil {
		return AuthenticatedCloseEvidence{}, err
	}
	signatureBytes, err := verifyArtifactBytes(root, refs.Signature, maxSignedRecordBytes)
	if err != nil {
		return AuthenticatedCloseEvidence{}, err
	}
	var record CloseRecord
	if err := UnmarshalCanonical(recordBytes, &record); err != nil {
		return AuthenticatedCloseEvidence{}, err
	}
	return AuthenticatedCloseEvidence{
		Record:         record,
		RecordBytes:    recordBytes,
		SignatureBytes: signatureBytes,
	}, nil
}

type VerifyOperationalEvidenceOptions struct {
	Definition           CeremonyDefinition
	CoordinatorPublicKey ed25519.PublicKey
	EvidenceRoot         string
	BundleBytes          []byte
	BundleSignatureBytes []byte
	Phase1Close          AuthenticatedCloseEvidence
	Phase2Close          AuthenticatedCloseEvidence
}

type VerifiedOperationalEvidence struct {
	Bundle              OperationalEvidenceBundle
	BundleDigest        Digest
	BundleSignature     Digest
	ReferencedArtifacts []ArtifactRef
}

// VerifyOperationalEvidenceBundle fail-closes across the signed bundle,
// authenticated close records, witness signatures/quorum/timing, every raw
// relay response, and the pinned drand verification policy.
func VerifyOperationalEvidenceBundle(options VerifyOperationalEvidenceOptions) (VerifiedOperationalEvidence, error) {
	if err := options.Definition.Validate(); err != nil {
		return VerifiedOperationalEvidence{}, err
	}
	if len(options.CoordinatorPublicKey) != ed25519.PublicKeySize {
		return VerifiedOperationalEvidence{}, errors.New("coordinator public key is invalid")
	}
	var bundle OperationalEvidenceBundle
	if err := VerifySignedRecord(
		options.BundleBytes,
		options.BundleSignatureBytes,
		&bundle,
		options.Definition.Coordinator.KeyID,
		options.CoordinatorPublicKey,
	); err != nil {
		return VerifiedOperationalEvidence{}, fmt.Errorf("operational evidence bundle: %w", err)
	}
	if bundle.CeremonyID != options.Definition.CeremonyID ||
		bundle.CoordinatorID != options.Definition.Coordinator.ID ||
		bundle.CoordinatorKeyID != options.Definition.Coordinator.KeyID {
		return VerifiedOperationalEvidence{}, errors.New("operational evidence bundle does not bind ceremony coordinator")
	}
	definitionBytes, err := MarshalCanonical(options.Definition)
	if err != nil {
		return VerifiedOperationalEvidence{}, err
	}
	enrollments, enrollmentRefs, err := verifyEnrollmentEvidence(
		options.Definition,
		definitionBytes,
		options.EvidenceRoot,
		bundle.Enrollments,
	)
	if err != nil {
		return VerifiedOperationalEvidence{}, err
	}
	governanceRefs, err := verifyGovernanceEvidence(
		options.Definition,
		definitionBytes,
		options.EvidenceRoot,
		bundle.GovernanceRecords,
	)
	if err != nil {
		return VerifiedOperationalEvidence{}, err
	}
	if options.Phase1Close.Record.BeaconRound == options.Phase2Close.Record.BeaconRound {
		return VerifiedOperationalEvidence{}, errors.New("phase 1 and phase 2 operational evidence reuse a beacon round")
	}

	phase1Refs, err := verifyPhaseOperationalEvidence(
		options.Definition,
		options.CoordinatorPublicKey,
		options.EvidenceRoot,
		bundle.Phase1,
		options.Phase1Close,
		enrollments,
	)
	if err != nil {
		return VerifiedOperationalEvidence{}, fmt.Errorf("phase1 operational evidence: %w", err)
	}
	phase2Refs, err := verifyPhaseOperationalEvidence(
		options.Definition,
		options.CoordinatorPublicKey,
		options.EvidenceRoot,
		bundle.Phase2,
		options.Phase2Close,
		enrollments,
	)
	if err != nil {
		return VerifiedOperationalEvidence{}, fmt.Errorf("phase2 operational evidence: %w", err)
	}
	latest, err := latestOperationalTimestamp(options.EvidenceRoot, bundle)
	if err != nil {
		return VerifiedOperationalEvidence{}, err
	}
	assembled, _ := time.Parse(time.RFC3339Nano, bundle.AssembledAt)
	if !assembled.After(latest) {
		return VerifiedOperationalEvidence{}, fmt.Errorf(
			"bundle assembled_at %s must strictly postdate latest operational evidence %s",
			bundle.AssembledAt,
			latest.Format(time.RFC3339Nano),
		)
	}
	all := append(enrollmentRefs, governanceRefs...)
	all = append(all, phase1Refs...)
	all = append(all, phase2Refs...)
	slices.SortFunc(all, func(a, b ArtifactRef) int {
		if a.Name < b.Name {
			return -1
		}
		if a.Name > b.Name {
			return 1
		}
		return 0
	})
	unique := all[:0]
	for _, ref := range all {
		if len(unique) > 0 && unique[len(unique)-1].Name == ref.Name {
			if unique[len(unique)-1] != ref {
				return VerifiedOperationalEvidence{}, fmt.Errorf("operational artifact name %q is equivocated", ref.Name)
			}
			// A final accepted-chain file can also be the signed prefix for
			// its last head. Preserve one exact content-addressed reference.
			continue
		}
		unique = append(unique, ref)
	}
	all = unique
	return VerifiedOperationalEvidence{
		Bundle:              bundle,
		BundleDigest:        NewDigest(options.BundleBytes),
		BundleSignature:     NewDigest(options.BundleSignatureBytes),
		ReferencedArtifacts: all,
	}, nil
}

func latestOperationalTimestamp(root string, bundle OperationalEvidenceBundle) (time.Time, error) {
	var latest time.Time
	advance := func(value string) {
		parsed, _ := time.Parse(time.RFC3339Nano, value)
		if parsed.After(latest) {
			latest = parsed
		}
	}
	for _, pair := range bundle.Enrollments {
		raw, err := verifyArtifactBytes(root, pair.Record, maxSignedRecordBytes)
		if err != nil {
			return time.Time{}, err
		}
		var record EnrollmentRecord
		if err := UnmarshalCanonical(raw, &record); err != nil {
			return time.Time{}, err
		}
		advance(record.EnrolledAt)
	}
	for _, pair := range bundle.GovernanceRecords {
		raw, err := verifyArtifactBytes(root, pair.Record, maxSignedRecordBytes)
		if err != nil {
			return time.Time{}, err
		}
		var record GovernanceRecord
		if err := UnmarshalCanonical(raw, &record); err != nil {
			return time.Time{}, err
		}
		advance(record.RecordedAt)
	}
	for _, phase := range []PhaseOperationalEvidence{bundle.Phase1, bundle.Phase2} {
		chainBytes, err := verifyArtifactBytes(root, phase.AcceptedChain.Record, maxSignedRecordBytes)
		if err != nil {
			return time.Time{}, err
		}
		var chain Chain
		if err := UnmarshalCanonical(chainBytes, &chain); err != nil {
			return time.Time{}, err
		}
		for _, record := range chain.Records {
			advance(record.AcceptedAt)
		}
		closeBytes, err := verifyArtifactBytes(root, phase.Close.Record, maxSignedRecordBytes)
		if err != nil {
			return time.Time{}, err
		}
		var close CloseRecord
		if err := UnmarshalCanonical(closeBytes, &close); err != nil {
			return time.Time{}, err
		}
		advance(close.ClosedAt)
		for _, head := range phase.AcceptedHeads {
			for _, pair := range []SignedArtifactRefs{head.OutboundHandoff, head.ReturnHandoff} {
				raw, err := verifyArtifactBytes(root, pair.Record, maxSignedRecordBytes)
				if err != nil {
					return time.Time{}, err
				}
				var record TransferHandoff
				if err := UnmarshalCanonical(raw, &record); err != nil {
					return time.Time{}, err
				}
				advance(record.CreatedAt)
			}
			for _, pair := range []SignedArtifactRefs{head.OutboundReceipt, head.ReturnReceipt} {
				raw, err := verifyArtifactBytes(root, pair.Record, maxSignedRecordBytes)
				if err != nil {
					return time.Time{}, err
				}
				var record TransferReceipt
				if err := UnmarshalCanonical(raw, &record); err != nil {
					return time.Time{}, err
				}
				advance(record.ReceivedAt)
			}
			for _, pair := range head.MirrorReceipts {
				raw, err := verifyArtifactBytes(root, pair.Record, maxSignedRecordBytes)
				if err != nil {
					return time.Time{}, err
				}
				var record ImmutableMirrorReceipt
				if err := UnmarshalCanonical(raw, &record); err != nil {
					return time.Time{}, err
				}
				advance(record.StoredAt)
			}
		}
		for _, pair := range phase.PublicWitnessReceipts {
			raw, err := verifyArtifactBytes(root, pair.Record, maxSignedRecordBytes)
			if err != nil {
				return time.Time{}, err
			}
			var record PublicWitnessReceipt
			if err := UnmarshalCanonical(raw, &record); err != nil {
				return time.Time{}, err
			}
			advance(record.ObservedAt)
		}
		beaconBytes, err := verifyArtifactBytes(root, phase.MultiRelayBeaconEvidence.Record, maxSignedRecordBytes)
		if err != nil {
			return time.Time{}, err
		}
		var beacon MultiRelayBeaconEvidence
		if err := UnmarshalCanonical(beaconBytes, &beacon); err != nil {
			return time.Time{}, err
		}
		advance(beacon.RecordedAt)
		for _, observation := range beacon.Observations {
			advance(observation.RetrievedAt)
		}
	}
	if latest.IsZero() {
		return time.Time{}, errors.New("operational evidence has no timestamp")
	}
	return latest, nil
}

func verifyPhaseOperationalEvidence(
	definition CeremonyDefinition,
	coordinatorPublicKey ed25519.PublicKey,
	root string,
	phaseEvidence PhaseOperationalEvidence,
	authenticated AuthenticatedCloseEvidence,
	enrollments map[string]EnrollmentRecord,
) ([]ArtifactRef, error) {
	if err := authenticated.Record.Validate(); err != nil {
		return nil, err
	}
	if authenticated.Record.CeremonyID != definition.CeremonyID ||
		authenticated.Record.Phase != phaseEvidence.Phase {
		return nil, errors.New("authenticated close has wrong ceremony or phase")
	}
	var closeSignature DetachedSignature
	if err := UnmarshalCanonical(authenticated.SignatureBytes, &closeSignature); err != nil {
		return nil, fmt.Errorf("close signature: %w", err)
	}
	if err := VerifyExact(
		authenticated.RecordBytes,
		closeSignature,
		definition.Coordinator.KeyID,
		coordinatorPublicKey,
	); err != nil {
		return nil, fmt.Errorf("authenticate close: %w", err)
	}
	if NewDigest(authenticated.RecordBytes) != phaseEvidence.Close.Record.Digest ||
		NewDigest(authenticated.SignatureBytes) != phaseEvidence.Close.Signature.Digest {
		return nil, errors.New("phase evidence close references do not match authenticated close bytes")
	}
	chainBytes, err := verifyArtifactBytes(root, phaseEvidence.AcceptedChain.Record, maxSignedRecordBytes)
	if err != nil {
		return nil, fmt.Errorf("accepted chain: %w", err)
	}
	chainSignatureBytes, err := verifyArtifactBytes(root, phaseEvidence.AcceptedChain.Signature, maxSignedRecordBytes)
	if err != nil {
		return nil, fmt.Errorf("accepted chain signature: %w", err)
	}
	var chain Chain
	if err := VerifySignedRecord(
		chainBytes,
		chainSignatureBytes,
		&chain,
		definition.Coordinator.KeyID,
		coordinatorPublicKey,
	); err != nil {
		return nil, fmt.Errorf("accepted chain: %w", err)
	}
	if chain.Phase != phaseEvidence.Phase {
		return nil, errors.New("accepted chain has wrong phase")
	}
	if err := ValidateClose(definition, chain, authenticated.Record); err != nil {
		return nil, fmt.Errorf("accepted chain/close coherence: %w", err)
	}
	payloadRefs := make([]ArtifactRef, 0, len(chain.Records)+1)
	if err := verifyLargeOperationalArtifact(root, chain.Genesis); err != nil {
		return nil, fmt.Errorf("accepted chain genesis: %w", err)
	}
	payloadRefs = append(payloadRefs, chain.Genesis)
	for index, record := range chain.Records {
		if err := verifyLargeOperationalArtifact(root, record.OutputPayload); err != nil {
			return nil, fmt.Errorf("accepted head %d output payload: %w", index+1, err)
		}
		payloadRefs = append(payloadRefs, record.OutputPayload)
	}
	acceptedHeadIDs := make([]string, len(chain.Records))
	for index, record := range chain.Records {
		acceptedHeadIDs[index] = record.RecordID
	}
	if len(phaseEvidence.AcceptedHeads) != len(acceptedHeadIDs) {
		return nil, errors.New("operational evidence does not cover every authenticated accepted head")
	}
	if acceptedHeadIDs[len(acceptedHeadIDs)-1] != authenticated.Record.ChainHeadID {
		return nil, errors.New("authenticated accepted heads do not terminate at close chain head")
	}
	headRefs, err := verifyAcceptedHeadEvidence(
		definition,
		root,
		phaseEvidence.Phase,
		phaseEvidence.AcceptedHeads,
		chain,
		enrollments,
	)
	if err != nil {
		return nil, err
	}

	witnesses := make([]SignedPublicWitness, len(phaseEvidence.PublicWitnessReceipts))
	refs := []ArtifactRef{
		phaseEvidence.AcceptedChain.Record,
		phaseEvidence.AcceptedChain.Signature,
		phaseEvidence.Close.Record,
		phaseEvidence.Close.Signature,
	}
	refs = append(refs, payloadRefs...)
	refs = append(refs, headRefs...)
	for index, pair := range phaseEvidence.PublicWitnessReceipts {
		recordBytes, err := verifyArtifactBytes(root, pair.Record, maxSignedRecordBytes)
		if err != nil {
			return nil, fmt.Errorf("witness %d record: %w", index, err)
		}
		signatureBytes, err := verifyArtifactBytes(root, pair.Signature, maxSignedRecordBytes)
		if err != nil {
			return nil, fmt.Errorf("witness %d signature: %w", index, err)
		}
		var receipt PublicWitnessReceipt
		if err := UnmarshalCanonical(recordBytes, &receipt); err != nil {
			return nil, fmt.Errorf("witness %d: %w", index, err)
		}
		enrollment, ok := enrollments[receipt.Witness.ID]
		if !ok || enrollment.Role != EnrollmentPublicWitness ||
			enrollment.Identity != receipt.Witness {
			return nil, fmt.Errorf("witness %q has no matching public-witness enrollment", receipt.Witness.ID)
		}
		publicKey, err := identityPublicKey(receipt.Witness)
		if err != nil {
			return nil, fmt.Errorf("witness %d identity: %w", index, err)
		}
		witnesses[index] = SignedPublicWitness{
			RecordBytes:    recordBytes,
			SignatureBytes: signatureBytes,
			TrustedKey:     publicKey,
		}
		refs = append(refs, pair.Record, pair.Signature)
	}
	if err := VerifyPublicWitnessQuorum(
		definition,
		authenticated.Record,
		authenticated.RecordBytes,
		witnesses,
		int(phaseEvidence.PublicWitnessQuorum),
	); err != nil {
		return nil, err
	}

	beaconBytes, err := verifyArtifactBytes(
		root,
		phaseEvidence.MultiRelayBeaconEvidence.Record,
		maxSignedRecordBytes,
	)
	if err != nil {
		return nil, err
	}
	beaconSignatureBytes, err := verifyArtifactBytes(
		root,
		phaseEvidence.MultiRelayBeaconEvidence.Signature,
		maxSignedRecordBytes,
	)
	if err != nil {
		return nil, err
	}
	var beaconEvidence MultiRelayBeaconEvidence
	if err := VerifySignedRecord(
		beaconBytes,
		beaconSignatureBytes,
		&beaconEvidence,
		definition.Coordinator.KeyID,
		coordinatorPublicKey,
	); err != nil {
		return nil, fmt.Errorf("multi-relay beacon evidence signature: %w", err)
	}
	rawResponses := make(map[string][]byte, len(phaseEvidence.RawBeaconResponses))
	if len(phaseEvidence.RawBeaconResponses) != len(beaconEvidence.Observations) {
		return nil, errors.New("raw response reference count does not match relay observations")
	}
	for _, rawRef := range phaseEvidence.RawBeaconResponses {
		raw, err := verifyArtifactBytes(root, rawRef, maxDrandResponseBytes)
		if err != nil {
			return nil, err
		}
		matched := false
		for _, observation := range beaconEvidence.Observations {
			if observation.RawResponse == rawRef {
				if _, duplicate := rawResponses[observation.RelayID]; duplicate {
					return nil, fmt.Errorf("relay %q raw response is duplicated", observation.RelayID)
				}
				rawResponses[observation.RelayID] = raw
				matched = true
				break
			}
		}
		if !matched {
			return nil, fmt.Errorf("raw beacon response %q is not named by a relay observation", rawRef.Name)
		}
	}
	if err := ValidateMultiRelayBeaconEvidence(
		definition,
		authenticated.Record,
		beaconEvidence,
		rawResponses,
	); err != nil {
		return nil, err
	}
	refs = append(
		refs,
		phaseEvidence.MultiRelayBeaconEvidence.Record,
		phaseEvidence.MultiRelayBeaconEvidence.Signature,
	)
	refs = append(refs, phaseEvidence.RawBeaconResponses...)
	return refs, nil
}

func verifyLargeOperationalArtifact(root string, expected ArtifactRef) error {
	path, err := resolveArtifactPath(root, expected.Name)
	if err != nil {
		return err
	}
	actual, err := artifactRefForFile(expected.Name, path)
	if err != nil {
		return err
	}
	if actual != expected {
		return fmt.Errorf("artifact %q digest or size mismatch", expected.Name)
	}
	return nil
}

func verifyEnrollmentEvidence(
	definition CeremonyDefinition,
	definitionBytes []byte,
	root string,
	pairs []SignedArtifactRefs,
) (map[string]EnrollmentRecord, []ArtifactRef, error) {
	enrollments := make(map[string]EnrollmentRecord, len(pairs))
	keys := make(map[string]struct{}, len(pairs))
	roleIndexes := make(map[string]struct{}, len(pairs))
	refs := make([]ArtifactRef, 0, len(pairs)*2)
	for index, pair := range pairs {
		recordBytes, err := verifyArtifactBytes(root, pair.Record, maxSignedRecordBytes)
		if err != nil {
			return nil, nil, fmt.Errorf("enrollment %d: %w", index, err)
		}
		signatureBytes, err := verifyArtifactBytes(root, pair.Signature, maxSignedRecordBytes)
		if err != nil {
			return nil, nil, fmt.Errorf("enrollment %d signature: %w", index, err)
		}
		var record EnrollmentRecord
		if err := UnmarshalCanonical(recordBytes, &record); err != nil {
			return nil, nil, fmt.Errorf("enrollment %d: %w", index, err)
		}
		signer, err := VerifyOperationalRecordBinding(definition, definitionBytes, &record)
		if err != nil {
			return nil, nil, fmt.Errorf("enrollment %d binding: %w", index, err)
		}
		publicKey, err := identityPublicKey(signer)
		if err != nil {
			return nil, nil, err
		}
		var signature DetachedSignature
		if err := UnmarshalCanonical(signatureBytes, &signature); err != nil {
			return nil, nil, err
		}
		if err := VerifyExact(recordBytes, signature, signer.KeyID, publicKey); err != nil {
			return nil, nil, fmt.Errorf("enrollment %d proof of possession: %w", index, err)
		}
		if _, err := verifyArtifactBytes(root, record.IndependenceDisclosure, 1<<20); err != nil {
			return nil, nil, fmt.Errorf("enrollment %d independence disclosure: %w", index, err)
		}
		if _, duplicate := enrollments[signer.ID]; duplicate {
			return nil, nil, fmt.Errorf("enrollment identity %q is duplicated", signer.ID)
		}
		if _, duplicate := keys[signer.PublicKeyFingerprint]; duplicate {
			return nil, nil, errors.New("enrollment public key is duplicated")
		}
		roleIndex := fmt.Sprintf("%s:%d", record.Role, record.RoleIndex)
		if _, duplicate := roleIndexes[roleIndex]; duplicate {
			return nil, nil, fmt.Errorf("enrollment role/index %q is duplicated", roleIndex)
		}
		enrollments[signer.ID] = record
		keys[signer.PublicKeyFingerprint] = struct{}{}
		roleIndexes[roleIndex] = struct{}{}
		refs = append(refs, pair.Record, pair.Signature, record.IndependenceDisclosure)
	}
	required := []Identity{definition.Coordinator, definition.ReleaseSigner}
	required = append(required, definition.Auditors...)
	for _, participant := range definition.Roster {
		required = append(required, participant.Identity)
	}
	for _, identity := range required {
		record, ok := enrollments[identity.ID]
		if !ok || record.Identity != identity {
			return nil, nil, fmt.Errorf("required proof-of-possession enrollment for %q is missing", identity.ID)
		}
	}
	return enrollments, refs, nil
}

func verifyGovernanceEvidence(
	definition CeremonyDefinition,
	definitionBytes []byte,
	root string,
	pairs []SignedArtifactRefs,
) ([]ArtifactRef, error) {
	refs := make([]ArtifactRef, 0, len(pairs)*3)
	for index, pair := range pairs {
		recordAny, pairRefs, err := verifyOperationalPair(
			definition,
			definitionBytes,
			root,
			pair,
			RecordGovernance,
		)
		if err != nil {
			return nil, fmt.Errorf("governance record %d: %w", index, err)
		}
		record := recordAny.(*GovernanceRecord)
		refs = append(refs, pairRefs...)
		for evidenceIndex, evidence := range record.Evidence {
			if err := verifyLargeOperationalArtifact(root, evidence); err != nil {
				return nil, fmt.Errorf(
					"governance record %d evidence %d: %w",
					index,
					evidenceIndex,
					err,
				)
			}
			refs = append(refs, evidence)
		}
	}
	return refs, nil
}

func verifyAcceptedHeadEvidence(
	definition CeremonyDefinition,
	root string,
	phase Phase,
	heads []AcceptedHeadOperationalEvidence,
	chain Chain,
	enrollments map[string]EnrollmentRecord,
) ([]ArtifactRef, error) {
	definitionBytes, err := MarshalCanonical(definition)
	if err != nil {
		return nil, err
	}
	policy, err := definition.PolicyForPhase(phase)
	if err != nil {
		return nil, err
	}
	refs := make([]ArtifactRef, 0, len(heads)*10)
	for index, evidence := range heads {
		record := chain.Records[index]
		if evidence.AcceptedHeadID != record.RecordID ||
			evidence.PredecessorHeadID != record.PreviousRecordID {
			return nil, fmt.Errorf("accepted head %d does not match authenticated predecessor/current chain IDs", index+1)
		}
		prefixBytes, err := verifyArtifactBytes(root, evidence.AcceptedChainPrefix.Record, maxSignedRecordBytes)
		if err != nil {
			return nil, fmt.Errorf("accepted head %d chain prefix: %w", index+1, err)
		}
		prefixSignatureBytes, err := verifyArtifactBytes(root, evidence.AcceptedChainPrefix.Signature, maxSignedRecordBytes)
		if err != nil {
			return nil, fmt.Errorf("accepted head %d chain prefix signature: %w", index+1, err)
		}
		var signedPrefix Chain
		coordinatorKey, err := identityPublicKey(definition.Coordinator)
		if err != nil {
			return nil, err
		}
		if err := VerifySignedRecord(
			prefixBytes,
			prefixSignatureBytes,
			&signedPrefix,
			definition.Coordinator.KeyID,
			coordinatorKey,
		); err != nil {
			return nil, fmt.Errorf("accepted head %d chain prefix: %w", index+1, err)
		}
		if signedPrefix.CeremonyID != chain.CeremonyID ||
			signedPrefix.Phase != chain.Phase ||
			signedPrefix.PhaseID != chain.PhaseID ||
			signedPrefix.Genesis != chain.Genesis ||
			len(signedPrefix.Records) != index+1 ||
			!slices.Equal(signedPrefix.Records, chain.Records[:index+1]) {
			return nil, fmt.Errorf("accepted head %d signed chain prefix is not the exact authenticated prefix", index+1)
		}
		refs = append(refs, evidence.AcceptedChainPrefix.Record, evidence.AcceptedChainPrefix.Signature)
		participant, ok := definition.ParticipantByID(policy.Participants[index])
		if !ok {
			return nil, fmt.Errorf("scheduled participant %q is missing", policy.Participants[index])
		}
		attestationBytes, err := verifyArtifactBytes(root, record.Attestation, maxSignedRecordBytes)
		if err != nil {
			return nil, fmt.Errorf("accepted head %d attestation: %w", index+1, err)
		}
		attestationSignature, err := verifyArtifactBytes(root, record.AttestationSignature, maxSignedRecordBytes)
		if err != nil {
			return nil, fmt.Errorf("accepted head %d attestation signature: %w", index+1, err)
		}
		var attestation ContributionAttestation
		participantKey, err := identityPublicKey(participant.Identity)
		if err != nil {
			return nil, err
		}
		if err := VerifySignedRecord(
			attestationBytes,
			attestationSignature,
			&attestation,
			participant.Identity.KeyID,
			participantKey,
		); err != nil {
			return nil, fmt.Errorf("accepted head %d attestation: %w", index+1, err)
		}
		erasureBytes, err := verifyArtifactBytes(root, record.Erasure, maxSignedRecordBytes)
		if err != nil {
			return nil, fmt.Errorf("accepted head %d erasure: %w", index+1, err)
		}
		erasureSignature, err := verifyArtifactBytes(root, record.ErasureSignature, maxSignedRecordBytes)
		if err != nil {
			return nil, fmt.Errorf("accepted head %d erasure signature: %w", index+1, err)
		}
		var erasure ErasureAttestation
		if err := VerifySignedRecord(
			erasureBytes,
			erasureSignature,
			&erasure,
			participant.Identity.KeyID,
			participantKey,
		); err != nil {
			return nil, fmt.Errorf("accepted head %d erasure: %w", index+1, err)
		}
		if err := ValidateErasureForContribution(attestation, erasure); err != nil {
			return nil, fmt.Errorf("accepted head %d erasure coherence: %w", index+1, err)
		}
		prefix := chain
		prefix.Records = append([]ChainRecord(nil), chain.Records[:index]...)
		if err := ValidateAttestationAcceptance(definition, prefix, attestation, erasure, record); err != nil {
			return nil, fmt.Errorf("accepted head %d attestation/acceptance coherence: %w", index+1, err)
		}
		verificationBytes, err := verifyArtifactBytes(root, record.Verification, maxSignedRecordBytes)
		if err != nil {
			return nil, fmt.Errorf("accepted head %d verification: %w", index+1, err)
		}
		var verification ContributionVerification
		if err := UnmarshalCanonical(verificationBytes, &verification); err != nil {
			return nil, fmt.Errorf("accepted head %d verification: %w", index+1, err)
		}
		if err := validateContributionVerification(record, verification); err != nil {
			return nil, fmt.Errorf("accepted head %d verification coherence: %w", index+1, err)
		}
		refs = append(
			refs,
			record.Attestation,
			record.AttestationSignature,
			record.Erasure,
			record.ErasureSignature,
			record.Verification,
		)

		outboundAny, pairRefs, err := verifyOperationalPair(
			definition,
			definitionBytes,
			root,
			evidence.OutboundHandoff,
			RecordHandoff,
		)
		if err != nil {
			return nil, fmt.Errorf("accepted head %d outbound handoff: %w", index+1, err)
		}
		outbound := outboundAny.(*TransferHandoff)
		if outbound.Phase != phase || outbound.Index != uint8(index+1) ||
			outbound.PredecessorHeadID != record.PreviousRecordID ||
			outbound.SenderID != definition.Coordinator.ID ||
			outbound.SenderKeyID != definition.Coordinator.KeyID ||
			outbound.RecipientID != participant.Identity.ID ||
			outbound.RecipientKeyID != participant.Identity.KeyID ||
			!slices.Equal(outbound.Files, []ArtifactRef{record.PreviousPayload}) {
			return nil, fmt.Errorf("accepted head %d outbound handoff does not bind coordinator, participant, predecessor, and input", index+1)
		}
		refs = append(refs, pairRefs...)

		outboundReceiptAny, outboundReceiptRefs, err := verifyOperationalPair(
			definition,
			definitionBytes,
			root,
			evidence.OutboundReceipt,
			RecordReceipt,
		)
		if err != nil {
			return nil, fmt.Errorf("accepted head %d outbound receipt: %w", index+1, err)
		}
		outboundReceipt := outboundReceiptAny.(*TransferReceipt)
		if outboundReceipt.Kind != ReceiptReceiver {
			return nil, fmt.Errorf("accepted head %d outbound receipt has wrong kind", index+1)
		}
		outboundBytes, err := verifyArtifactBytes(root, evidence.OutboundHandoff.Record, maxSignedRecordBytes)
		if err != nil {
			return nil, err
		}
		if err := VerifyTransferReceipt(outboundBytes, *outbound, *outboundReceipt); err != nil {
			return nil, err
		}
		refs = append(refs, outboundReceiptRefs...)

		returnHandoffAny, returnHandoffRefs, err := verifyOperationalPair(
			definition,
			definitionBytes,
			root,
			evidence.ReturnHandoff,
			RecordHandoff,
		)
		if err != nil {
			return nil, fmt.Errorf("accepted head %d return handoff: %w", index+1, err)
		}
		returnHandoff := returnHandoffAny.(*TransferHandoff)
		expectedReturnFiles := []ArtifactRef{
			record.Attestation,
			record.AttestationSignature,
			record.Erasure,
			record.ErasureSignature,
			record.OutputPayload,
		}
		slices.SortFunc(expectedReturnFiles, compareArtifactRefName)
		if returnHandoff.Phase != phase || returnHandoff.Index != uint8(index+1) ||
			returnHandoff.PredecessorHeadID != record.PreviousRecordID ||
			returnHandoff.SenderID != participant.Identity.ID ||
			returnHandoff.SenderKeyID != participant.Identity.KeyID ||
			returnHandoff.RecipientID != definition.Coordinator.ID ||
			returnHandoff.RecipientKeyID != definition.Coordinator.KeyID ||
			!slices.Equal(returnHandoff.Files, expectedReturnFiles) {
			return nil, fmt.Errorf("accepted head %d return handoff does not bind participant, coordinator, predecessor head, and output evidence", index+1)
		}
		refs = append(refs, returnHandoffRefs...)

		returnReceiptAny, returnReceiptRefs, err := verifyOperationalPair(
			definition,
			definitionBytes,
			root,
			evidence.ReturnReceipt,
			RecordReceipt,
		)
		if err != nil {
			return nil, fmt.Errorf("accepted head %d return receipt: %w", index+1, err)
		}
		returnReceipt := returnReceiptAny.(*TransferReceipt)
		if returnReceipt.Kind != ReceiptReceiver {
			return nil, fmt.Errorf("accepted head %d return receipt has wrong kind", index+1)
		}
		returnHandoffBytes, err := verifyArtifactBytes(root, evidence.ReturnHandoff.Record, maxSignedRecordBytes)
		if err != nil {
			return nil, err
		}
		if err := VerifyTransferReceipt(returnHandoffBytes, *returnHandoff, *returnReceipt); err != nil {
			return nil, err
		}
		refs = append(refs, returnReceiptRefs...)

		predecessorAcceptedAt := definition.CreatedAt
		if index > 0 {
			predecessorAcceptedAt = chain.Records[index-1].AcceptedAt
		}
		predecessorAccepted, _ := time.Parse(time.RFC3339Nano, predecessorAcceptedAt)
		outboundCreated, _ := time.Parse(time.RFC3339Nano, outbound.CreatedAt)
		outboundReceived, _ := time.Parse(time.RFC3339Nano, outboundReceipt.ReceivedAt)
		contributed, _ := time.Parse(time.RFC3339Nano, attestation.ContributedAt)
		destroyed, _ := time.Parse(time.RFC3339Nano, erasure.DestroyedAt)
		returnCreated, _ := time.Parse(time.RFC3339Nano, returnHandoff.CreatedAt)
		returnReceived, _ := time.Parse(time.RFC3339Nano, returnReceipt.ReceivedAt)
		accepted, _ := time.Parse(time.RFC3339Nano, record.AcceptedAt)
		if !outboundCreated.After(predecessorAccepted) ||
			!outboundReceived.After(outboundCreated) ||
			!contributed.After(outboundReceived) ||
			!returnCreated.After(contributed) ||
			!returnCreated.After(destroyed) ||
			!returnReceived.After(returnCreated) ||
			!accepted.After(returnReceived) {
			return nil, fmt.Errorf("accepted head %d custody/contribution/erasure/acceptance timestamps are not strictly ordered", index+1)
		}

		mirrorIDs := make(map[string]struct{}, len(evidence.MirrorReceipts))
		mirrorKeys := make(map[string]struct{}, len(evidence.MirrorReceipts))
		expectedMirrorFiles := append([]ArtifactRef(nil), expectedReturnFiles...)
		expectedMirrorFiles = append(
			expectedMirrorFiles,
			record.Verification,
			evidence.AcceptedChainPrefix.Record,
			evidence.AcceptedChainPrefix.Signature,
		)
		slices.SortFunc(expectedMirrorFiles, compareArtifactRefName)
		for mirrorIndex, pair := range evidence.MirrorReceipts {
			mirrorAny, mirrorRefs, err := verifyOperationalPair(
				definition,
				definitionBytes,
				root,
				pair,
				RecordMirrorReceipt,
			)
			if err != nil {
				return nil, fmt.Errorf("accepted head %d mirror %d: %w", index+1, mirrorIndex+1, err)
			}
			mirror := mirrorAny.(*ImmutableMirrorReceipt)
			if mirror.CeremonyID != definition.CeremonyID || mirror.Phase != phase ||
				mirror.Index != uint8(index+1) || mirror.AcceptedHeadID != evidence.AcceptedHeadID ||
				!slices.Equal(mirror.Files, expectedMirrorFiles) {
				return nil, fmt.Errorf("accepted head %d mirror %d does not bind exact head files", index+1, mirrorIndex+1)
			}
			stored, _ := time.Parse(time.RFC3339Nano, mirror.StoredAt)
			if !stored.After(accepted) {
				return nil, fmt.Errorf("accepted head %d mirror %d predates acceptance", index+1, mirrorIndex+1)
			}
			enrollment, ok := enrollments[mirror.Mirror.ID]
			if !ok || enrollment.Role != EnrollmentMirrorOperator ||
				enrollment.Identity != mirror.Mirror {
				return nil, fmt.Errorf("mirror %q has no matching mirror-operator enrollment", mirror.Mirror.ID)
			}
			if _, duplicate := mirrorIDs[mirror.Mirror.ID]; duplicate {
				return nil, fmt.Errorf("accepted head %d mirror identity is duplicated", index+1)
			}
			if _, duplicate := mirrorKeys[mirror.Mirror.PublicKeyFingerprint]; duplicate {
				return nil, fmt.Errorf("accepted head %d mirror key is duplicated", index+1)
			}
			mirrorIDs[mirror.Mirror.ID] = struct{}{}
			mirrorKeys[mirror.Mirror.PublicKeyFingerprint] = struct{}{}
			refs = append(refs, mirrorRefs...)
		}
	}
	return refs, nil
}

func compareArtifactRefName(a, b ArtifactRef) int {
	return strings.Compare(a.Name, b.Name)
}

func verifyOperationalPair(
	definition CeremonyDefinition,
	definitionBytes []byte,
	root string,
	pair SignedArtifactRefs,
	recordType OperationalRecordType,
) (any, []ArtifactRef, error) {
	recordBytes, err := verifyArtifactBytes(root, pair.Record, maxSignedRecordBytes)
	if err != nil {
		return nil, nil, err
	}
	signatureBytes, err := verifyArtifactBytes(root, pair.Signature, maxSignedRecordBytes)
	if err != nil {
		return nil, nil, err
	}
	record, err := ParseOperationalRecord(recordType, recordBytes)
	if err != nil {
		return nil, nil, err
	}
	signer, err := VerifyOperationalRecordBinding(definition, definitionBytes, record)
	if err != nil {
		return nil, nil, err
	}
	publicKey, err := identityPublicKey(signer)
	if err != nil {
		return nil, nil, err
	}
	var signature DetachedSignature
	if err := UnmarshalCanonical(signatureBytes, &signature); err != nil {
		return nil, nil, err
	}
	if err := VerifyExact(recordBytes, signature, signer.KeyID, publicKey); err != nil {
		return nil, nil, err
	}
	return record, []ArtifactRef{pair.Record, pair.Signature}, nil
}

func validateSignedArtifactSet(label string, artifacts []SignedArtifactRefs) error {
	previous := ""
	for index, artifact := range artifacts {
		if err := artifact.Validate(); err != nil {
			return fmt.Errorf("%s %d: %w", label, index, err)
		}
		if index > 0 && artifact.Record.Name <= previous {
			return fmt.Errorf("%s must be ordered by unique record name", label)
		}
		previous = artifact.Record.Name
	}
	return nil
}
