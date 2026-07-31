package mpcceremony

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"time"

	"proof-tool/internal/artifact"
	"proof-tool/internal/keybundle"
	"proof-tool/internal/strictjson"
)

const (
	ProductionDecisionSchema          = "proof-tool-mpc-production-decision-v1"
	ProductionDecisionDraftSchema     = "proof-tool-mpc-production-decision-draft-v1"
	ProductionDecisionSignatureSchema = "proof-tool-mpc-production-decision-signature-v1"
	MaxProductionReleaseArtifacts     = 4096
)

type ProductionDecisionOutcome string

const (
	DecisionGO   ProductionDecisionOutcome = "GO"
	DecisionNOGO ProductionDecisionOutcome = "NO-GO"
)

type ProductionGateStatus string

const (
	GatePASS    ProductionGateStatus = "PASS"
	GateFAIL    ProductionGateStatus = "FAIL"
	GatePENDING ProductionGateStatus = "PENDING"
)

type ProductionGate string

const (
	GateSignedRelease          ProductionGate = "signed-release"
	GateOperationalEvidence    ProductionGate = "operational-evidence"
	GateIndependentAudits      ProductionGate = "two-independent-audits"
	GateExternalAudit          ProductionGate = "third-party-security-audit"
	GateK21Rehearsal           ProductionGate = "exact-k21-rehearsal"
	GateMainnetDeploymentPlan  ProductionGate = "mainnet-deployment-plan"
	GateFormalChecklist        ProductionGate = "formal-go-no-go-checklist"
	GateParticipantIndependent ProductionGate = "participant-independence"
	GateParticipantHost        ProductionGate = "participant-host-security"
	GateParticipantEntropy     ProductionGate = "participant-entropy"
	GateParticipantErasure     ProductionGate = "participant-erasure"
	GatePublicWitnessing       ProductionGate = "public-witnessing"
	GateImmutableMirrors       ProductionGate = "immutable-independent-mirrors"
	GateLiveTwentyParty        ProductionGate = "live-twenty-party-ceremony"
)

var requiredProductionGates = [...]ProductionGate{
	GateSignedRelease,
	GateOperationalEvidence,
	GateIndependentAudits,
	GateExternalAudit,
	GateK21Rehearsal,
	GateMainnetDeploymentPlan,
	GateFormalChecklist,
	GateParticipantIndependent,
	GateParticipantHost,
	GateParticipantEntropy,
	GateParticipantErasure,
	GatePublicWitnessing,
	GateImmutableMirrors,
	GateLiveTwentyParty,
}

// LocatedArtifactRef binds immutable content to the exact publication URI
// reviewed by the decision signers. Verification always hashes a caller-
// supplied local copy; it never fetches a URI or trusts mutable network state.
type LocatedArtifactRef struct {
	URI      string      `json:"uri"`
	Artifact ArtifactRef `json:"artifact"`
}

func (r LocatedArtifactRef) Validate() error {
	if err := validateImmutableEvidenceURI(r.URI); err != nil {
		return err
	}
	return r.Artifact.Validate()
}

type SignedLocatedArtifact struct {
	Record    LocatedArtifactRef `json:"record"`
	Signature LocatedArtifactRef `json:"signature"`
}

func (r SignedLocatedArtifact) Validate() error {
	if err := r.Record.Validate(); err != nil {
		return fmt.Errorf("record: %w", err)
	}
	if err := r.Signature.Validate(); err != nil {
		return fmt.Errorf("signature: %w", err)
	}
	if r.Record == r.Signature {
		return errors.New("signed record and signature must be distinct artifacts")
	}
	return nil
}

// SignedReleaseEvidence pins the release-signature inputs plus the
// coordinator-signed candidate and canonical final transcript. ReleaseID is
// derived from this entire structure, rather than supplied by an operator.
type SignedReleaseEvidence struct {
	ReleaseID         string                `json:"release_id"`
	CandidateID       string                `json:"candidate_id"`
	Manifest          LocatedArtifactRef    `json:"manifest"`
	ManifestSignature LocatedArtifactRef    `json:"manifest_signature"`
	ManifestPublicKey LocatedArtifactRef    `json:"manifest_public_key"`
	Candidate         SignedLocatedArtifact `json:"candidate"`
	FinalTranscript   LocatedArtifactRef    `json:"final_transcript"`
	Artifacts         []LocatedArtifactRef  `json:"artifacts"`
}

// SignedReleaseEvidenceDraft is the operator-authored release binding before
// its content-derived release_id is computed.
type SignedReleaseEvidenceDraft struct {
	CandidateID       string                `json:"candidate_id"`
	Manifest          LocatedArtifactRef    `json:"manifest"`
	ManifestSignature LocatedArtifactRef    `json:"manifest_signature"`
	ManifestPublicKey LocatedArtifactRef    `json:"manifest_public_key"`
	Candidate         SignedLocatedArtifact `json:"candidate"`
	FinalTranscript   LocatedArtifactRef    `json:"final_transcript"`
	Artifacts         []LocatedArtifactRef  `json:"artifacts"`
}

func (d SignedReleaseEvidenceDraft) release() (SignedReleaseEvidence, error) {
	return NewSignedReleaseEvidence(SignedReleaseEvidence{
		CandidateID:       d.CandidateID,
		Manifest:          d.Manifest,
		ManifestSignature: d.ManifestSignature,
		ManifestPublicKey: d.ManifestPublicKey,
		Candidate:         d.Candidate,
		FinalTranscript:   d.FinalTranscript,
		Artifacts:         d.Artifacts,
	})
}

func NewSignedReleaseEvidence(value SignedReleaseEvidence) (SignedReleaseEvidence, error) {
	value.ReleaseID = ""
	id, err := computeSignedReleaseID(value)
	if err != nil {
		return SignedReleaseEvidence{}, err
	}
	value.ReleaseID = id
	return value, value.Validate()
}

func (r SignedReleaseEvidence) Validate() error {
	if err := validateHashID("release_id", r.ReleaseID); err != nil {
		return err
	}
	expected, err := computeSignedReleaseID(r)
	if err != nil {
		return err
	}
	if r.ReleaseID != expected {
		return fmt.Errorf("release_id %q, want %q", r.ReleaseID, expected)
	}
	if err := validateHashID("candidate_id", r.CandidateID); err != nil {
		return err
	}
	for label, ref := range map[string]LocatedArtifactRef{
		"manifest":            r.Manifest,
		"manifest_signature":  r.ManifestSignature,
		"manifest_public_key": r.ManifestPublicKey,
		"final_transcript":    r.FinalTranscript,
	} {
		if err := ref.Validate(); err != nil {
			return fmt.Errorf("%s: %w", label, err)
		}
	}
	if err := r.Candidate.Validate(); err != nil {
		return fmt.Errorf("candidate: %w", err)
	}
	if len(r.Artifacts) < 16 || len(r.Artifacts) > MaxProductionReleaseArtifacts {
		return fmt.Errorf(
			"signed release artifact tree must contain between 16 and %d files, got %d",
			MaxProductionReleaseArtifacts,
			len(r.Artifacts),
		)
	}
	previous := ""
	for index, ref := range r.Artifacts {
		if err := ref.Validate(); err != nil {
			return fmt.Errorf("release artifact %d: %w", index, err)
		}
		if index > 0 && ref.Artifact.Name <= previous {
			return errors.New("release artifacts must be ordered by unique logical name")
		}
		previous = ref.Artifact.Name
	}
	return nil
}

func computeSignedReleaseID(value SignedReleaseEvidence) (string, error) {
	value.ReleaseID = ""
	if err := validateHashID("candidate_id", value.CandidateID); err != nil {
		return "", err
	}
	return canonicalHash("proof-tool/mpc-ceremony/signed-release/v1", value)
}

type ProductionAuditEvidence struct {
	AuditorID    string                `json:"auditor_id"`
	AuditorKeyID string                `json:"auditor_key_id"`
	Audit        SignedLocatedArtifact `json:"audit"`
}

func (e ProductionAuditEvidence) Validate() error {
	if err := validateID("auditor_id", e.AuditorID); err != nil {
		return err
	}
	if err := validateID("auditor_key_id", e.AuditorKeyID); err != nil {
		return err
	}
	return e.Audit.Validate()
}

type ExternalAuditEvidence struct {
	Auditor Identity           `json:"auditor"`
	Report  LocatedArtifactRef `json:"report"`
	Signoff LocatedArtifactRef `json:"signoff"`
}

func (e ExternalAuditEvidence) Validate() error {
	if err := e.Auditor.Validate(); err != nil {
		return fmt.Errorf("external auditor: %w", err)
	}
	if err := e.Report.Validate(); err != nil {
		return fmt.Errorf("external audit report: %w", err)
	}
	if err := e.Signoff.Validate(); err != nil {
		return fmt.Errorf("external audit signoff: %w", err)
	}
	if e.Report == e.Signoff {
		return errors.New("external audit report and signoff must be distinct artifacts")
	}
	return nil
}

type K21RehearsalEvidence struct {
	KeyVersion  string             `json:"key_version"`
	CircuitID   string             `json:"circuit_id"`
	Curve       string             `json:"curve"`
	Backend     string             `json:"backend"`
	Constraints uint64             `json:"constraints"`
	DomainSize  uint64             `json:"domain_size"`
	Evidence    LocatedArtifactRef `json:"evidence"`
}

type SourceReleaseEvidence struct {
	SourceCommit         string             `json:"source_commit"`
	SignedTag            string             `json:"signed_tag"`
	SignatureFormat      string             `json:"signature_format"`
	SignerFingerprintHex string             `json:"signer_fingerprint_hex"`
	SignedTagObject      LocatedArtifactRef `json:"signed_tag_object"`
}

func (e SourceReleaseEvidence) Validate() error {
	if err := validateHex(e.SourceCommit, 20); err != nil {
		return fmt.Errorf("source_commit: %w", err)
	}
	if e.SignedTag == "" || len(e.SignedTag) > 160 {
		return errors.New("signed_tag must contain 1 to 160 characters")
	}
	for _, r := range e.SignedTag {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') &&
			(r < '0' || r > '9') && !strings.ContainsRune("._/+@-", r) {
			return fmt.Errorf("signed_tag %q contains an unsupported character", e.SignedTag)
		}
	}
	if e.SignatureFormat != "openpgp-primary-key-v4" {
		return fmt.Errorf("signature_format %q, want openpgp-primary-key-v4", e.SignatureFormat)
	}
	if err := validateHex(e.SignerFingerprintHex, 20); err != nil {
		return fmt.Errorf("signer_fingerprint_hex: %w", err)
	}
	return e.SignedTagObject.Validate()
}

func (e K21RehearsalEvidence) Validate() error {
	if e.KeyVersion != KeyVersionDestinationV2 ||
		e.CircuitID != CircuitIDDestinationV2 ||
		e.Curve != CurveBLS12381 ||
		e.Backend != BackendGroth16 {
		return errors.New("K21 rehearsal must bind the exact ownership-destination-v2 BLS12-381 Groth16 circuit")
	}
	if e.Constraints == 0 {
		return errors.New("K21 rehearsal constraint count must be positive")
	}
	if e.DomainSize != 1<<21 {
		return fmt.Errorf("K21 rehearsal domain_size %d, want %d", e.DomainSize, uint64(1<<21))
	}
	return e.Evidence.Validate()
}

type ProductionGateResult struct {
	Gate      ProductionGate       `json:"gate"`
	Status    ProductionGateStatus `json:"status"`
	Evidence  []LocatedArtifactRef `json:"evidence"`
	Rationale string               `json:"rationale"`
}

func (g ProductionGateResult) Validate() error {
	switch g.Status {
	case GatePASS:
		if len(g.Evidence) == 0 {
			return fmt.Errorf("PASS gate %q requires immutable evidence", g.Gate)
		}
	case GateFAIL, GatePENDING:
		if strings.TrimSpace(g.Rationale) == "" || g.Rationale != strings.TrimSpace(g.Rationale) {
			return fmt.Errorf("%s gate %q requires a non-empty trimmed rationale", g.Status, g.Gate)
		}
	default:
		return fmt.Errorf("unsupported production gate status %q", g.Status)
	}
	if len(g.Evidence) > 32 {
		return fmt.Errorf("gate %q has more than 32 evidence artifacts", g.Gate)
	}
	previous := ""
	for index, ref := range g.Evidence {
		if err := ref.Validate(); err != nil {
			return fmt.Errorf("gate %q evidence %d: %w", g.Gate, index, err)
		}
		if index > 0 && ref.URI <= previous {
			return fmt.Errorf("gate %q evidence must be ordered by unique URI", g.Gate)
		}
		previous = ref.URI
	}
	if g.Rationale != "" && (g.Rationale != strings.TrimSpace(g.Rationale) || len(g.Rationale) > 2048) {
		return fmt.Errorf("gate %q rationale must be trimmed and at most 2048 bytes", g.Gate)
	}
	return nil
}

// ProductionDecision is a canonical, content-addressed GO/NO-GO record. It
// does not infer operational or organizational facts: external gate results
// must be supported by pinned evidence and accepted by the required signers.
type ProductionDecision struct {
	Schema                string                    `json:"schema"`
	DecisionID            string                    `json:"decision_id"`
	CeremonyID            string                    `json:"ceremony_id"`
	Release               SignedReleaseEvidence     `json:"release"`
	SourceRelease         SourceReleaseEvidence     `json:"source_release"`
	OperationalEvidence   SignedLocatedArtifact     `json:"operational_evidence"`
	Audits                []ProductionAuditEvidence `json:"audits"`
	ExternalAudits        []ExternalAuditEvidence   `json:"external_audits"`
	K21Rehearsal          K21RehearsalEvidence      `json:"k21_rehearsal"`
	MainnetDeploymentPlan LocatedArtifactRef        `json:"mainnet_deployment_plan"`
	FormalChecklist       LocatedArtifactRef        `json:"formal_checklist"`
	Gates                 []ProductionGateResult    `json:"gates"`
	Decision              ProductionDecisionOutcome `json:"decision"`
	DecidedAt             string                    `json:"decided_at"`
}

// ProductionDecisionDraft is a strict canonical operator input. It omits both
// content-derived IDs so an operator cannot accidentally sign stale IDs copied
// from another release or decision.
type ProductionDecisionDraft struct {
	Schema                string                     `json:"schema"`
	CeremonyID            string                     `json:"ceremony_id"`
	Release               SignedReleaseEvidenceDraft `json:"release"`
	SourceRelease         SourceReleaseEvidence      `json:"source_release"`
	OperationalEvidence   SignedLocatedArtifact      `json:"operational_evidence"`
	Audits                []ProductionAuditEvidence  `json:"audits"`
	ExternalAudits        []ExternalAuditEvidence    `json:"external_audits"`
	K21Rehearsal          K21RehearsalEvidence       `json:"k21_rehearsal"`
	MainnetDeploymentPlan LocatedArtifactRef         `json:"mainnet_deployment_plan"`
	FormalChecklist       LocatedArtifactRef         `json:"formal_checklist"`
	Gates                 []ProductionGateResult     `json:"gates"`
	Decision              ProductionDecisionOutcome  `json:"decision"`
	DecidedAt             string                     `json:"decided_at"`
}

func (d ProductionDecisionDraft) Validate() error {
	_, err := d.decision()
	return err
}

func (d ProductionDecisionDraft) decision() (ProductionDecision, error) {
	if d.Schema != ProductionDecisionDraftSchema {
		return ProductionDecision{}, fmt.Errorf(
			"production decision draft schema %q, want %q",
			d.Schema,
			ProductionDecisionDraftSchema,
		)
	}
	release, err := d.Release.release()
	if err != nil {
		return ProductionDecision{}, fmt.Errorf("draft release: %w", err)
	}
	return NewProductionDecision(ProductionDecision{
		CeremonyID:            d.CeremonyID,
		Release:               release,
		SourceRelease:         d.SourceRelease,
		OperationalEvidence:   d.OperationalEvidence,
		Audits:                d.Audits,
		ExternalAudits:        d.ExternalAudits,
		K21Rehearsal:          d.K21Rehearsal,
		MainnetDeploymentPlan: d.MainnetDeploymentPlan,
		FormalChecklist:       d.FormalChecklist,
		Gates:                 d.Gates,
		Decision:              d.Decision,
		DecidedAt:             d.DecidedAt,
	})
}

// PrepareProductionDecision strictly parses a canonical draft, derives both
// content IDs, and checks its ceremony/circuit/role bindings before returning
// the exact bytes that the accountable roles must sign.
func PrepareProductionDecision(
	definition CeremonyDefinition,
	draftBytes []byte,
) (ProductionDecision, []byte, error) {
	if err := definition.Validate(); err != nil {
		return ProductionDecision{}, nil, err
	}
	var draft ProductionDecisionDraft
	if err := UnmarshalCanonical(draftBytes, &draft); err != nil {
		return ProductionDecision{}, nil, fmt.Errorf("production decision draft: %w", err)
	}
	decision, err := draft.decision()
	if err != nil {
		return ProductionDecision{}, nil, err
	}
	if err := validateProductionDecisionBinding(definition, decision); err != nil {
		return ProductionDecision{}, nil, err
	}
	record, err := MarshalCanonical(decision)
	if err != nil {
		return ProductionDecision{}, nil, err
	}
	return decision, record, nil
}

func NewProductionDecision(value ProductionDecision) (ProductionDecision, error) {
	value.Schema = ProductionDecisionSchema
	value.DecisionID = ""
	id, err := computeProductionDecisionID(value)
	if err != nil {
		return ProductionDecision{}, err
	}
	value.DecisionID = id
	return value, value.Validate()
}

func (d ProductionDecision) Validate() error {
	if d.Schema != ProductionDecisionSchema {
		return fmt.Errorf("production decision schema %q, want %q", d.Schema, ProductionDecisionSchema)
	}
	if err := validateHashID("decision_id", d.DecisionID); err != nil {
		return err
	}
	expected, err := computeProductionDecisionID(d)
	if err != nil {
		return err
	}
	if d.DecisionID != expected {
		return fmt.Errorf("decision_id %q, want %q", d.DecisionID, expected)
	}
	if err := validateHashID("ceremony_id", d.CeremonyID); err != nil {
		return err
	}
	if err := d.Release.Validate(); err != nil {
		return fmt.Errorf("release: %w", err)
	}
	if err := d.SourceRelease.Validate(); err != nil {
		return fmt.Errorf("source_release: %w", err)
	}
	if err := d.OperationalEvidence.Validate(); err != nil {
		return fmt.Errorf("operational_evidence: %w", err)
	}
	if len(d.Audits) != 2 {
		return fmt.Errorf("production decision requires exactly two audits, got %d", len(d.Audits))
	}
	for index, audit := range d.Audits {
		if err := audit.Validate(); err != nil {
			return fmt.Errorf("audit %d: %w", index, err)
		}
		if index > 0 && audit.AuditorID <= d.Audits[index-1].AuditorID {
			return errors.New("audits must be ordered by distinct auditor_id")
		}
	}
	if d.Audits[0].AuditorKeyID == d.Audits[1].AuditorKeyID {
		return errors.New("production audit key ids must be distinct")
	}
	if len(d.ExternalAudits) != 2 {
		return fmt.Errorf("production decision requires exactly two external audits, got %d", len(d.ExternalAudits))
	}
	for index, external := range d.ExternalAudits {
		if err := external.Validate(); err != nil {
			return fmt.Errorf("external audit %d: %w", index, err)
		}
		if index > 0 && external.Auditor.ID <= d.ExternalAudits[index-1].Auditor.ID {
			return errors.New("external audits must be ordered by distinct auditor identity")
		}
	}
	if d.ExternalAudits[0].Auditor.PublicKeyFingerprint ==
		d.ExternalAudits[1].Auditor.PublicKeyFingerprint {
		return errors.New("external audit signer keys must be distinct")
	}
	if err := d.K21Rehearsal.Validate(); err != nil {
		return err
	}
	if err := d.MainnetDeploymentPlan.Validate(); err != nil {
		return fmt.Errorf("mainnet_deployment_plan: %w", err)
	}
	if err := d.FormalChecklist.Validate(); err != nil {
		return fmt.Errorf("formal_checklist: %w", err)
	}
	if path.Ext(d.FormalChecklist.Artifact.Name) != ".md" {
		return errors.New("formal checklist artifact must be Markdown with a .md logical name")
	}
	if len(d.Gates) != len(requiredProductionGates) {
		return fmt.Errorf("production decision has %d gates, want exactly %d", len(d.Gates), len(requiredProductionGates))
	}
	allPass := true
	for index, expectedGate := range requiredProductionGates {
		gate := d.Gates[index]
		if gate.Gate != expectedGate {
			return fmt.Errorf("gate %d is %q, want %q", index, gate.Gate, expectedGate)
		}
		if err := gate.Validate(); err != nil {
			return err
		}
		allPass = allPass && gate.Status == GatePASS
	}
	switch d.Decision {
	case DecisionGO:
		if !allPass {
			return errors.New("GO decision requires every production gate to be PASS")
		}
	case DecisionNOGO:
		if allPass {
			return errors.New("NO-GO decision must enumerate at least one FAIL or PENDING gate")
		}
	default:
		return fmt.Errorf("unsupported production decision %q", d.Decision)
	}
	if err := validateTimestamp("decided_at", d.DecidedAt); err != nil {
		return err
	}
	return validateLocatedArtifactCoherence(d)
}

func computeProductionDecisionID(value ProductionDecision) (string, error) {
	value.DecisionID = ""
	if value.Schema != ProductionDecisionSchema {
		return "", fmt.Errorf("production decision schema %q, want %q", value.Schema, ProductionDecisionSchema)
	}
	return canonicalHash("proof-tool/mpc-ceremony/production-decision/v1", value)
}

type DecisionSignerRole string

const (
	DecisionSignerCoordinator DecisionSignerRole = "coordinator"
	DecisionSignerAuditor     DecisionSignerRole = "auditor"
	DecisionSignerRelease     DecisionSignerRole = "release_signer"
)

type ProductionDecisionSignature struct {
	Schema    string             `json:"schema"`
	Role      DecisionSignerRole `json:"role"`
	SignerID  string             `json:"signer_id"`
	Signature DetachedSignature  `json:"signature"`
}

func (s ProductionDecisionSignature) Validate() error {
	if s.Schema != ProductionDecisionSignatureSchema {
		return fmt.Errorf("decision signature schema %q, want %q", s.Schema, ProductionDecisionSignatureSchema)
	}
	switch s.Role {
	case DecisionSignerCoordinator, DecisionSignerAuditor, DecisionSignerRelease:
	default:
		return fmt.Errorf("unsupported decision signer role %q", s.Role)
	}
	if err := validateID("decision signer_id", s.SignerID); err != nil {
		return err
	}
	return s.Signature.Validate()
}

func SignProductionDecision(
	definition CeremonyDefinition,
	decisionBytes []byte,
	role DecisionSignerRole,
	signerID string,
	privateKey ed25519.PrivateKey,
) ([]byte, error) {
	var decision ProductionDecision
	if err := UnmarshalCanonical(decisionBytes, &decision); err != nil {
		return nil, fmt.Errorf("production decision: %w", err)
	}
	identity, err := decisionSignerIdentity(definition, decision, role, signerID)
	if err != nil {
		return nil, err
	}
	publicKey, err := identityPublicKey(identity)
	if err != nil {
		return nil, err
	}
	if len(privateKey) != ed25519.PrivateKeySize ||
		!bytes.Equal(privateKey[ed25519.PrivateKeySize-ed25519.PublicKeySize:], publicKey) {
		return nil, errors.New("decision signing key does not match the required ceremony identity")
	}
	detached, err := SignExact(decisionBytes, identity.KeyID, privateKey)
	if err != nil {
		return nil, err
	}
	return MarshalCanonical(ProductionDecisionSignature{
		Schema:    ProductionDecisionSignatureSchema,
		Role:      role,
		SignerID:  signerID,
		Signature: detached,
	})
}

type VerifyProductionDecisionOptions struct {
	Definition     CeremonyDefinition
	DecisionBytes  []byte
	SignatureBytes [][]byte
	EvidenceRoot   string
}

type VerifyProductionDecisionEvidenceOptions struct {
	Definition    CeremonyDefinition
	DecisionBytes []byte
	EvidenceRoot  string
}

type VerifiedProductionDecision struct {
	Decision          ProductionDecision
	DecisionDigest    Digest
	VerifiedSigners   []string
	VerifiedArtifacts []LocatedArtifactRef
}

// VerifyProductionDecision authenticates all supplied signatures, verifies
// every pinned local evidence byte string, and fail-closes the GO threshold.
// URI retrieval and real-world independence/erasure claims remain external.
func VerifyProductionDecision(options VerifyProductionDecisionOptions) (VerifiedProductionDecision, error) {
	evidence, err := VerifyProductionDecisionEvidence(VerifyProductionDecisionEvidenceOptions{
		Definition:    options.Definition,
		DecisionBytes: options.DecisionBytes,
		EvidenceRoot:  options.EvidenceRoot,
	})
	if err != nil {
		return VerifiedProductionDecision{}, err
	}
	decision := evidence.Decision

	seen := make(map[string]struct{}, len(options.SignatureBytes))
	verified := make([]string, 0, len(options.SignatureBytes))
	for index, raw := range options.SignatureBytes {
		var signature ProductionDecisionSignature
		if err := UnmarshalCanonical(raw, &signature); err != nil {
			return VerifiedProductionDecision{}, fmt.Errorf("decision signature %d: %w", index, err)
		}
		identity, err := decisionSignerIdentity(
			options.Definition,
			decision,
			signature.Role,
			signature.SignerID,
		)
		if err != nil {
			return VerifiedProductionDecision{}, fmt.Errorf("decision signature %d: %w", index, err)
		}
		key := string(signature.Role) + "\x00" + signature.SignerID
		if _, duplicate := seen[key]; duplicate {
			return VerifiedProductionDecision{}, fmt.Errorf("duplicate decision signature for %s %q", signature.Role, signature.SignerID)
		}
		seen[key] = struct{}{}
		publicKey, err := identityPublicKey(identity)
		if err != nil {
			return VerifiedProductionDecision{}, err
		}
		if err := VerifyExact(
			options.DecisionBytes,
			signature.Signature,
			identity.KeyID,
			publicKey,
		); err != nil {
			return VerifiedProductionDecision{}, fmt.Errorf("decision signature %d: %w", index, err)
		}
		verified = append(verified, key)
	}
	if len(verified) == 0 {
		return VerifiedProductionDecision{}, errors.New("production decision has no verified signatures")
	}
	if decision.Decision == DecisionGO {
		required := requiredDecisionSigners(options.Definition, decision)
		for _, signer := range required {
			if _, ok := seen[signer]; !ok {
				role, id, _ := strings.Cut(signer, "\x00")
				return VerifiedProductionDecision{}, fmt.Errorf("GO decision is missing required %s signature from %q", role, id)
			}
		}
		if len(seen) != len(required) {
			return VerifiedProductionDecision{}, errors.New("GO decision contains a signature outside the exact required threshold")
		}
	}
	slices.Sort(verified)
	evidence.VerifiedSigners = verified
	return evidence, nil
}

// VerifyProductionDecisionEvidence performs the complete public-evidence
// verification without requiring decision signatures. GO signers use this
// before their private signing key is loaded.
func VerifyProductionDecisionEvidence(
	options VerifyProductionDecisionEvidenceOptions,
) (VerifiedProductionDecision, error) {
	if err := options.Definition.Validate(); err != nil {
		return VerifiedProductionDecision{}, err
	}
	var decision ProductionDecision
	if err := UnmarshalCanonical(options.DecisionBytes, &decision); err != nil {
		return VerifiedProductionDecision{}, fmt.Errorf("production decision: %w", err)
	}
	if err := validateProductionDecisionBinding(options.Definition, decision); err != nil {
		return VerifiedProductionDecision{}, err
	}
	artifacts := uniqueLocatedArtifacts(decision)
	for _, located := range artifacts {
		resolved, err := resolveArtifactPath(options.EvidenceRoot, located.Artifact.Name)
		if err != nil {
			return VerifiedProductionDecision{}, err
		}
		actual, err := artifactRefForFile(located.Artifact.Name, resolved)
		if err != nil {
			return VerifiedProductionDecision{}, err
		}
		if actual != located.Artifact {
			return VerifiedProductionDecision{}, fmt.Errorf("decision evidence %q changed or has the wrong digest", located.Artifact.Name)
		}
	}
	if err := verifyDecisionRelease(options.Definition, decision, options.EvidenceRoot); err != nil {
		return VerifiedProductionDecision{}, fmt.Errorf("signed release evidence: %w", err)
	}
	if err := verifyDecisionOperationalEvidence(options.Definition, decision, options.EvidenceRoot); err != nil {
		return VerifiedProductionDecision{}, fmt.Errorf("operational evidence: %w", err)
	}
	if err := verifyDecisionAudits(options.Definition, decision, options.EvidenceRoot); err != nil {
		return VerifiedProductionDecision{}, fmt.Errorf("independent audits: %w", err)
	}
	if err := verifyDecisionExternalAudits(decision, options.EvidenceRoot); err != nil {
		return VerifiedProductionDecision{}, fmt.Errorf("external audit: %w", err)
	}
	return VerifiedProductionDecision{
		Decision:          decision,
		DecisionDigest:    NewDigest(options.DecisionBytes),
		VerifiedArtifacts: artifacts,
	}, nil
}

func validateProductionDecisionBinding(definition CeremonyDefinition, decision ProductionDecision) error {
	if decision.CeremonyID != definition.CeremonyID {
		return errors.New("production decision ceremony_id does not match the signed definition")
	}
	if decision.SourceRelease.SourceCommit != definition.Software.SourceCommit {
		return errors.New("production decision source release does not match ceremony build provenance")
	}
	if decision.K21Rehearsal.KeyVersion != definition.Circuit.KeyVersion ||
		decision.K21Rehearsal.CircuitID != definition.Circuit.CircuitID ||
		decision.K21Rehearsal.Curve != definition.Circuit.Curve ||
		decision.K21Rehearsal.Backend != definition.Circuit.Backend ||
		decision.K21Rehearsal.Constraints != definition.Circuit.Constraints ||
		decision.K21Rehearsal.DomainSize != definition.Circuit.DomainSize {
		return errors.New("K21 rehearsal does not bind the ceremony definition's exact compiled circuit")
	}
	for _, audit := range decision.Audits {
		enrolled, ok := auditorByID(definition, audit.AuditorID)
		if !ok || enrolled.KeyID != audit.AuditorKeyID {
			return fmt.Errorf("decision auditor %q is not enrolled with key %q", audit.AuditorID, audit.AuditorKeyID)
		}
	}
	for _, external := range decision.ExternalAudits {
		externalFP := external.Auditor.PublicKeyFingerprint
		if externalFP == definition.Coordinator.PublicKeyFingerprint ||
			externalFP == definition.ReleaseSigner.PublicKeyFingerprint {
			return errors.New("external auditor key must be distinct from ceremony coordinator and release signer")
		}
		for _, auditor := range definition.Auditors {
			if externalFP == auditor.PublicKeyFingerprint {
				return errors.New("external auditor key must be distinct from enrolled ceremony auditors")
			}
		}
	}
	return nil
}

func verifyDecisionRelease(definition CeremonyDefinition, decision ProductionDecision, root string) error {
	if err := verifyDecisionReleaseTree(decision.Release, root); err != nil {
		return err
	}
	manifestBytes, err := decisionArtifactBytes(root, decision.Release.Manifest, maxSignedRecordBytes)
	if err != nil {
		return err
	}
	signatureBytes, err := decisionArtifactBytes(root, decision.Release.ManifestSignature, 4096)
	if err != nil {
		return err
	}
	publicKeyBytes, err := decisionArtifactBytes(root, decision.Release.ManifestPublicKey, 4096)
	if err != nil {
		return err
	}
	expectedPublicKey := definition.ReleaseSigner.Ed25519PublicKeyHex + "\n"
	if string(publicKeyBytes) != expectedPublicKey {
		return errors.New("release public-key artifact does not exactly match the enrolled release signer")
	}
	if len(signatureBytes) != ed25519.SignatureSize*2+1 ||
		signatureBytes[len(signatureBytes)-1] != '\n' {
		return errors.New("release manifest signature is not exact lowercase hex plus newline")
	}
	rawSignature, err := hex.DecodeString(string(signatureBytes[:len(signatureBytes)-1]))
	if err != nil {
		return errors.New("decode release manifest signature")
	}
	releaseKey, err := identityPublicKey(definition.ReleaseSigner)
	if err != nil {
		return err
	}
	if !ed25519.Verify(releaseKey, manifestBytes, rawSignature) {
		return errors.New("release manifest Ed25519 signature verification failed")
	}
	var manifest artifact.KeyManifest
	if err := strictjson.Unmarshal(manifestBytes, &manifest); err != nil {
		return fmt.Errorf("release manifest: %w", err)
	}
	if manifest.Schema != artifact.ManifestSchema ||
		manifest.SignatureKeyID != definition.ReleaseSigner.KeyID ||
		manifest.KeyVersion != definition.Circuit.KeyVersion ||
		manifest.CircuitID != definition.Circuit.CircuitID ||
		manifest.Curve != definition.Circuit.Curve ||
		manifest.Backend != definition.Circuit.Backend {
		return errors.New("release manifest does not bind the ceremony circuit and release signer")
	}

	candidateBytes, err := decisionArtifactBytes(root, decision.Release.Candidate.Record, maxSignedRecordBytes)
	if err != nil {
		return err
	}
	candidateSignatureBytes, err := decisionArtifactBytes(root, decision.Release.Candidate.Signature, maxSignedRecordBytes)
	if err != nil {
		return err
	}
	coordinatorKey, err := identityPublicKey(definition.Coordinator)
	if err != nil {
		return err
	}
	var candidate CandidateMetadata
	if err := VerifySignedRecord(
		candidateBytes,
		candidateSignatureBytes,
		&candidate,
		definition.Coordinator.KeyID,
		coordinatorKey,
	); err != nil {
		return fmt.Errorf("release candidate: %w", err)
	}
	definitionBytes, err := MarshalCanonical(definition)
	if err != nil {
		return err
	}
	if candidate.CandidateID != decision.Release.CandidateID ||
		candidate.CeremonyID != definition.CeremonyID ||
		candidate.Definition.Digest != NewDigest(definitionBytes) ||
		!equalCircuitBinding(candidate.Circuit, definition.Circuit) ||
		candidate.CoordinatorID != definition.Coordinator.ID ||
		candidate.CoordinatorKeyID != definition.Coordinator.KeyID {
		return errors.New("release candidate does not exactly bind the decision and ceremony")
	}
	releaseDirName := path.Dir(decision.Release.Manifest.Artifact.Name)
	requiredTreeRefs := []ArtifactRef{
		decision.Release.Manifest.Artifact,
		decision.Release.ManifestSignature.Artifact,
		decision.Release.ManifestPublicKey.Artifact,
		decision.Release.Candidate.Record.Artifact,
		decision.Release.Candidate.Signature.Artifact,
		decision.Release.FinalTranscript.Artifact,
	}
	for _, candidateRef := range candidateFileRefs(candidate) {
		requiredTreeRefs = append(requiredTreeRefs, releaseTreeArtifact(releaseDirName, candidateRef))
	}
	treeRefs := make(map[ArtifactRef]struct{}, len(decision.Release.Artifacts))
	treeNames := make(map[string]struct{}, len(decision.Release.Artifacts))
	for _, located := range decision.Release.Artifacts {
		treeRefs[located.Artifact] = struct{}{}
		treeNames[located.Artifact.Name] = struct{}{}
	}
	for _, required := range requiredTreeRefs {
		if _, ok := treeRefs[required]; !ok {
			return fmt.Errorf("signed release tree does not contain exact required artifact %q", required.Name)
		}
	}
	for _, name := range []string{CandidateChecksumsFile, ReleaseChecksumsFile} {
		fullName := path.Join(releaseDirName, name)
		if releaseDirName == "." {
			fullName = name
		}
		if _, ok := treeNames[fullName]; !ok {
			return fmt.Errorf("signed release tree is missing %q", fullName)
		}
	}
	if manifest.VKHash != candidate.VerifyingKey.Digest.Blake2b256 ||
		manifest.ProvingKeySHA256 != candidate.ProvingKey.Digest.SHA256 ||
		manifest.ProvingKeyBlake2b256 != candidate.ProvingKey.Digest.Blake2b256 ||
		manifest.ProvingKeySize != candidate.ProvingKey.Digest.Size ||
		manifest.VerifyingKeySHA256 != candidate.VerifyingKey.Digest.SHA256 ||
		manifest.VerifyingKeySize != candidate.VerifyingKey.Digest.Size ||
		manifest.ConstraintSystemHash != candidate.ConstraintSystem.Digest.Blake2b256 ||
		manifest.CircuitSourceCommit != definition.Software.SourceCommit ||
		manifest.ProofToolVersion != definition.Software.ProofToolVersion ||
		manifest.GnarkVersion != definition.Software.GnarkVersion ||
		len(manifest.ArtifactURLs) != 0 {
		return errors.New("release manifest does not bind the candidate key artifacts")
	}

	transcriptBytes, err := decisionArtifactBytes(root, decision.Release.FinalTranscript, maxSignedRecordBytes)
	if err != nil {
		return err
	}
	var transcript FinalTranscript
	if err := UnmarshalCanonical(transcriptBytes, &transcript); err != nil {
		return fmt.Errorf("final transcript: %w", err)
	}
	expectedAuditRefs := []ArtifactRef{
		releaseLogicalArtifact(releaseDirName, decision.Audits[0].Audit.Record.Artifact),
		releaseLogicalArtifact(releaseDirName, decision.Audits[1].Audit.Record.Artifact),
	}
	expectedOperationalRefs := SignedArtifactRefs{
		Record: releaseLogicalArtifact(
			releaseDirName,
			decision.OperationalEvidence.Record.Artifact,
		),
		Signature: releaseLogicalArtifact(
			releaseDirName,
			decision.OperationalEvidence.Signature.Artifact,
		),
	}
	if transcript.CeremonyID != definition.CeremonyID ||
		transcript.Definition != candidate.Definition ||
		!equalCircuitBinding(transcript.Circuit, candidate.Circuit) ||
		!reflect.DeepEqual(transcript.Phase1, candidate.Phase1) ||
		!reflect.DeepEqual(transcript.Phase2, candidate.Phase2) ||
		!slices.Equal(transcript.Audits, expectedAuditRefs) ||
		transcript.OperationalEvidence != expectedOperationalRefs ||
		transcript.ProvingKey != candidate.ProvingKey ||
		transcript.VerifyingKey != candidate.VerifyingKey ||
		transcript.CardanoVerifyingKey != candidate.CardanoVerifyingKey ||
		manifest.SetupTranscriptHash != NewDigest(transcriptBytes).Blake2b256 {
		return errors.New("final transcript does not cohere with decision, candidate, audits, operational evidence, and manifest")
	}
	if manifest.PublishedAt != transcript.FinalizedAt {
		return errors.New("release manifest published_at does not match final transcript")
	}
	transcriptTime, err := time.Parse(time.RFC3339Nano, transcript.FinalizedAt)
	if err != nil {
		return fmt.Errorf("final transcript release time: %w", err)
	}
	coordinatorKey, err = identityPublicKey(definition.Coordinator)
	if err != nil {
		return err
	}
	releaseRoot, err := resolveArtifactPath(root, releaseDirName)
	if err != nil {
		return err
	}
	operationalEvidence, err := verifyReleaseOperationalEvidence(
		definition,
		coordinatorKey,
		candidate,
		releaseRoot,
		filepath.Join(releaseRoot, filepath.FromSlash(OperationalEvidenceBundleFile)),
		filepath.Join(releaseRoot, filepath.FromSlash(OperationalEvidenceSignatureFile)),
		transcriptTime,
	)
	if err != nil {
		return fmt.Errorf("full operational evidence verification: %w", err)
	}
	if transcript.OperationalEvidence != operationalEvidence.BundleRef ||
		expectedOperationalRefs != operationalEvidence.BundleRef {
		return errors.New("decision operational evidence does not match the recursively verified release bundle")
	}
	if err := verifyChecksumsExact(
		releaseRoot,
		filepath.Join(releaseRoot, CandidateChecksumsFile),
		candidateChecksumNames(),
	); err != nil {
		return fmt.Errorf("candidate checksums: %w", err)
	}
	if err := verifyChecksumsExact(
		releaseRoot,
		filepath.Join(releaseRoot, ReleaseChecksumsFile),
		releaseChecksumNames(len(decision.Audits), operationalEvidence.Names),
	); err != nil {
		return fmt.Errorf("release checksums: %w", err)
	}
	if err := verifyReleaseTreeExact(
		releaseRoot,
		len(decision.Audits),
		operationalEvidence.Names,
	); err != nil {
		return fmt.Errorf("exact release artifact set: %w", err)
	}
	return nil
}

func releaseTreeArtifact(releaseDirName string, logical ArtifactRef) ArtifactRef {
	name := path.Join(releaseDirName, logical.Name)
	if releaseDirName == "." {
		name = logical.Name
	}
	return ArtifactRef{Name: name, Digest: logical.Digest}
}

func releaseLogicalArtifact(releaseDirName string, tree ArtifactRef) ArtifactRef {
	if releaseDirName == "." {
		return tree
	}
	return ArtifactRef{
		Name:   strings.TrimPrefix(tree.Name, releaseDirName+"/"),
		Digest: tree.Digest,
	}
}

func verifyDecisionReleaseTree(release SignedReleaseEvidence, root string) error {
	releaseDirName := path.Dir(release.Manifest.Artifact.Name)
	if path.Base(release.Manifest.Artifact.Name) != keybundle.ManifestFile {
		return fmt.Errorf("release manifest logical name must end in %q", keybundle.ManifestFile)
	}
	releaseDir, err := resolveArtifactPath(root, releaseDirName)
	if err != nil {
		return err
	}
	expected := make(map[string]LocatedArtifactRef, len(release.Artifacts))
	for _, located := range release.Artifacts {
		if path.Dir(located.Artifact.Name) != releaseDirName &&
			!strings.HasPrefix(located.Artifact.Name, releaseDirName+"/") {
			return fmt.Errorf("release artifact %q is outside release directory %q", located.Artifact.Name, releaseDirName)
		}
		expected[located.Artifact.Name] = located
	}
	actual := make(map[string]struct{}, len(expected))
	err = filepath.WalkDir(releaseDir, func(file string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if file == releaseDir {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("release tree contains forbidden symlink %q", file)
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("release tree contains non-regular file %q", file)
		}
		relative, err := filepath.Rel(root, file)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(relative)
		located, ok := expected[name]
		if !ok {
			return fmt.Errorf("release tree contains unpinned file %q", name)
		}
		ref, err := artifactRefForFile(name, file)
		if err != nil {
			return err
		}
		if ref != located.Artifact {
			return fmt.Errorf("release artifact %q changed or has the wrong digest", name)
		}
		actual[name] = struct{}{}
		return nil
	})
	if err != nil {
		return err
	}
	if len(actual) != len(expected) {
		return errors.New("one or more pinned release artifacts are missing from the exact release tree")
	}
	return nil
}

func verifyDecisionOperationalEvidence(definition CeremonyDefinition, decision ProductionDecision, root string) error {
	recordBytes, err := decisionArtifactBytes(root, decision.OperationalEvidence.Record, maxSignedRecordBytes)
	if err != nil {
		return err
	}
	signatureBytes, err := decisionArtifactBytes(root, decision.OperationalEvidence.Signature, maxSignedRecordBytes)
	if err != nil {
		return err
	}
	publicKey, err := identityPublicKey(definition.Coordinator)
	if err != nil {
		return err
	}
	var bundle OperationalEvidenceBundle
	if err := VerifySignedRecord(
		recordBytes,
		signatureBytes,
		&bundle,
		definition.Coordinator.KeyID,
		publicKey,
	); err != nil {
		return err
	}
	if bundle.CeremonyID != definition.CeremonyID ||
		bundle.CoordinatorID != definition.Coordinator.ID ||
		bundle.CoordinatorKeyID != definition.Coordinator.KeyID {
		return errors.New("operational evidence bundle does not bind the ceremony coordinator")
	}
	return nil
}

func verifyDecisionAudits(definition CeremonyDefinition, decision ProductionDecision, root string) error {
	candidateBytes, err := decisionArtifactBytes(root, decision.Release.Candidate.Record, maxSignedRecordBytes)
	if err != nil {
		return err
	}
	var candidate CandidateMetadata
	if err := UnmarshalCanonical(candidateBytes, &candidate); err != nil {
		return err
	}
	replayRoot, err := replayRootSHA256(candidate)
	if err != nil {
		return err
	}
	expectedOutputs := candidateAuditOutputs(candidate, ArtifactRef{
		Name: CandidateMetadataFile, Digest: decision.Release.Candidate.Record.Artifact.Digest,
	})
	for index, evidence := range decision.Audits {
		recordBytes, err := decisionArtifactBytes(root, evidence.Audit.Record, maxSignedRecordBytes)
		if err != nil {
			return err
		}
		signatureBytes, err := decisionArtifactBytes(root, evidence.Audit.Signature, maxSignedRecordBytes)
		if err != nil {
			return err
		}
		identity, _ := auditorByID(definition, evidence.AuditorID)
		publicKey, err := identityPublicKey(identity)
		if err != nil {
			return err
		}
		var audit AuditRecord
		if err := VerifySignedRecord(recordBytes, signatureBytes, &audit, identity.KeyID, publicKey); err != nil {
			return fmt.Errorf("audit %d signature: %w", index, err)
		}
		if audit.AuditorID != evidence.AuditorID ||
			audit.AuditorKeyID != evidence.AuditorKeyID ||
			audit.CeremonyID != definition.CeremonyID ||
			!audit.Passed ||
			len(audit.Findings) != 0 ||
			audit.Definition != candidate.Definition ||
			audit.Phase1Chain != candidate.Phase1.Chain ||
			audit.Phase2Chain != candidate.Phase2.Chain ||
			audit.Phase1SealID != candidate.Phase1.SealID ||
			audit.Phase2SealID != candidate.Phase2.SealID ||
			audit.ReplayRootSHA256 != replayRoot ||
			!slices.Equal(audit.Outputs, expectedOutputs) {
			return fmt.Errorf("audit %d is not a passing exact-candidate audit", index)
		}
	}
	return nil
}

func verifyDecisionExternalAudits(decision ProductionDecision, root string) error {
	for index, external := range decision.ExternalAudits {
		reportBytes, err := decisionArtifactBytes(root, external.Report, maxSignedRecordBytes)
		if err != nil {
			return err
		}
		signoffBytes, err := decisionArtifactBytes(root, external.Signoff, maxSignedRecordBytes)
		if err != nil {
			return err
		}
		var signoff DetachedSignature
		if err := UnmarshalCanonical(signoffBytes, &signoff); err != nil {
			return err
		}
		publicKey, err := identityPublicKey(external.Auditor)
		if err != nil {
			return err
		}
		if err := VerifyExact(reportBytes, signoff, external.Auditor.KeyID, publicKey); err != nil {
			return fmt.Errorf("external audit %d: %w", index, err)
		}
	}
	return nil
}

func decisionArtifactBytes(root string, located LocatedArtifactRef, maximum int64) ([]byte, error) {
	return verifyArtifactBytes(root, located.Artifact, maximum)
}

func decisionSignerIdentity(
	definition CeremonyDefinition,
	decision ProductionDecision,
	role DecisionSignerRole,
	id string,
) (Identity, error) {
	if err := validateProductionDecisionBinding(definition, decision); err != nil {
		return Identity{}, err
	}
	switch role {
	case DecisionSignerCoordinator:
		if id != definition.Coordinator.ID {
			return Identity{}, errors.New("coordinator decision signature has the wrong identity")
		}
		return definition.Coordinator, nil
	case DecisionSignerRelease:
		if id != definition.ReleaseSigner.ID {
			return Identity{}, errors.New("release-signer decision signature has the wrong identity")
		}
		return definition.ReleaseSigner, nil
	case DecisionSignerAuditor:
		for _, audit := range decision.Audits {
			if audit.AuditorID == id {
				identity, ok := auditorByID(definition, id)
				if !ok || identity.KeyID != audit.AuditorKeyID {
					break
				}
				return identity, nil
			}
		}
		return Identity{}, errors.New("auditor decision signature is not from either audit bound by the decision")
	default:
		return Identity{}, fmt.Errorf("unsupported decision signer role %q", role)
	}
}

func requiredDecisionSigners(definition CeremonyDefinition, decision ProductionDecision) []string {
	return []string{
		string(DecisionSignerCoordinator) + "\x00" + definition.Coordinator.ID,
		string(DecisionSignerAuditor) + "\x00" + decision.Audits[0].AuditorID,
		string(DecisionSignerAuditor) + "\x00" + decision.Audits[1].AuditorID,
		string(DecisionSignerRelease) + "\x00" + definition.ReleaseSigner.ID,
	}
}

func validateLocatedArtifactCoherence(decision ProductionDecision) error {
	byName := make(map[string]LocatedArtifactRef)
	byURI := make(map[string]LocatedArtifactRef)
	for _, ref := range allLocatedArtifacts(decision) {
		if previous, ok := byName[ref.Artifact.Name]; ok && previous != ref {
			return fmt.Errorf("artifact name %q is bound to conflicting evidence", ref.Artifact.Name)
		}
		if previous, ok := byURI[ref.URI]; ok && previous != ref {
			return fmt.Errorf("artifact URI %q is bound to conflicting evidence", ref.URI)
		}
		byName[ref.Artifact.Name] = ref
		byURI[ref.URI] = ref
	}
	return nil
}

func allLocatedArtifacts(decision ProductionDecision) []LocatedArtifactRef {
	refs := []LocatedArtifactRef{
		decision.Release.Manifest,
		decision.Release.ManifestSignature,
		decision.Release.ManifestPublicKey,
		decision.Release.Candidate.Record,
		decision.Release.Candidate.Signature,
		decision.Release.FinalTranscript,
		decision.SourceRelease.SignedTagObject,
		decision.OperationalEvidence.Record,
		decision.OperationalEvidence.Signature,
		decision.Audits[0].Audit.Record,
		decision.Audits[0].Audit.Signature,
		decision.Audits[1].Audit.Record,
		decision.Audits[1].Audit.Signature,
		decision.K21Rehearsal.Evidence,
		decision.MainnetDeploymentPlan,
		decision.FormalChecklist,
	}
	refs = append(refs, decision.Release.Artifacts...)
	for _, external := range decision.ExternalAudits {
		refs = append(refs, external.Report, external.Signoff)
	}
	for _, gate := range decision.Gates {
		refs = append(refs, gate.Evidence...)
	}
	return refs
}

func uniqueLocatedArtifacts(decision ProductionDecision) []LocatedArtifactRef {
	byURI := make(map[string]LocatedArtifactRef)
	for _, ref := range allLocatedArtifacts(decision) {
		byURI[ref.URI] = ref
	}
	result := make([]LocatedArtifactRef, 0, len(byURI))
	for _, ref := range byURI {
		result = append(result, ref)
	}
	slices.SortFunc(result, func(a, b LocatedArtifactRef) int {
		return strings.Compare(a.URI, b.URI)
	})
	return result
}

func validateImmutableEvidenceURI(value string) error {
	if value == "" || len(value) > 2048 || value != strings.TrimSpace(value) {
		return errors.New("evidence URI must be non-empty, trimmed, and at most 2048 bytes")
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.String() != value {
		return errors.New("evidence URI must use canonical URL encoding")
	}
	if parsed.User != nil || parsed.Fragment != "" {
		return errors.New("evidence URI must not contain userinfo or a fragment")
	}
	switch parsed.Scheme {
	case "https", "ipfs":
	default:
		return fmt.Errorf("evidence URI scheme %q is not an immutable-publication transport", parsed.Scheme)
	}
	if parsed.Host == "" {
		return errors.New("evidence URI must contain a host or content identifier")
	}
	return nil
}
