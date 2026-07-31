package mpcceremony

import (
	"bytes"
	"crypto/ed25519"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	gnarkmpc "github.com/consensys/gnark/backend/groth16/bls12-381/mpcsetup"
	cs "github.com/consensys/gnark/constraint/bls12-381"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
)

const adversarialTinyDomain = uint64(8)

type adversarialCommittedCircuit struct {
	Public frontend.Variable `gnark:",public"`
	Secret frontend.Variable
}

func (c *adversarialCommittedCircuit) Define(api frontend.API) error {
	committer, ok := api.(frontend.Committer)
	if !ok {
		return errors.New("compiler does not implement frontend.Committer")
	}
	commitment, err := committer.Commit(c.Secret)
	if err != nil {
		return err
	}
	api.AssertIsDifferent(commitment, 0)
	api.AssertIsEqual(c.Public, c.Secret)
	return nil
}

func adversarialCompileCommitted(t testing.TB) *cs.R1CS {
	t.Helper()
	compiled, err := frontend.Compile(
		ecc.BLS12_381.ScalarField(),
		r1cs.NewBuilder,
		&adversarialCommittedCircuit{},
	)
	if err != nil {
		t.Fatalf("compile committed test circuit: %v", err)
	}
	native, ok := compiled.(*cs.R1CS)
	if !ok {
		t.Fatalf("compiled circuit type = %T, want *bls12-381.R1CS", compiled)
	}
	return native
}

func adversarialSerialize(t testing.TB, value io.WriterTo) []byte {
	t.Helper()
	var encoded bytes.Buffer
	if _, err := value.WriteTo(&encoded); err != nil {
		t.Fatalf("serialize %T: %v", value, err)
	}
	return encoded.Bytes()
}

func adversarialPhase1Contribution(t testing.TB) *gnarkmpc.Phase1 {
	t.Helper()
	contribution, err := ContributePhase1(adversarialTinyDomain, nil)
	if err != nil {
		t.Fatalf("create Phase 1 contribution: %v", err)
	}
	return contribution
}

func adversarialPhase2Contribution(t testing.TB) (*gnarkmpc.Phase2, Phase2Shape) {
	t.Helper()
	phase1 := adversarialPhase1Contribution(t)
	commons, err := SealPhase1(adversarialTinyDomain, bytes.Repeat([]byte{0x41}, 32), []*gnarkmpc.Phase1{phase1})
	if err != nil {
		t.Fatalf("seal Phase 1: %v", err)
	}
	var phase2 gnarkmpc.Phase2
	_ = phase2.Initialize(adversarialCompileCommitted(t), commons)
	phase2.Contribute()
	shape, err := DerivePhase2Shape(&phase2)
	if err != nil {
		t.Fatalf("derive Phase 2 shape: %v", err)
	}
	return &phase2, shape
}

func adversarialWriteRaw(t *testing.T, path string, raw []byte) {
	t.Helper()
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write raw artifact: %v", err)
	}
}

func adversarialPrivateKey(fill byte) ed25519.PrivateKey {
	return ed25519.NewKeyFromSeed(bytes.Repeat([]byte{fill}, ed25519.SeedSize))
}

func adversarialAttestation(t *testing.T) ContributionAttestation {
	t.Helper()
	attestation, err := NewContributionAttestation(ContributionAttestation{
		CeremonyID:       "sha256:" + strings.Repeat("11", 32),
		Phase:            Phase1,
		PhaseID:          "sha256:" + strings.Repeat("22", 32),
		Index:            1,
		ParticipantID:    "participant-01",
		ParticipantKeyID: "participant-key-01",
		PreviousPayload: ArtifactRef{
			Name:   "phase1/genesis.bin",
			Digest: NewDigest([]byte("genesis")),
		},
		OutputPayload: ArtifactRef{
			Name:   "phase1/contribution-01.bin",
			Digest: NewDigest([]byte("contribution")),
		},
		PreviousAcceptanceID: "sha256:" + strings.Repeat("33", 32),
		ToolBinary:           NewDigest([]byte("tool binary")),
		SourceCommit:         strings.Repeat("44", 20),
		GnarkVersion:         GnarkVersion,
		GnarkCryptoVersion:   GnarkCryptoVersion,
		DrandVersion:         DrandVersion,
		Environment: ContributionEnvironment{
			OS:                           "linux",
			Architecture:                 "amd64",
			EntropySource:                "operating-system-csprng",
			SwapDisabled:                 true,
			CrashDumpsDisabled:           true,
			TelemetryDisabled:            true,
			EphemeralEnvironment:         true,
			EphemeralDestructionRequired: true,
		},
		ContributedAt: "2026-07-23T12:00:00Z",
	})
	if err != nil {
		t.Fatalf("create contribution attestation: %v", err)
	}
	return attestation
}

func adversarialIdentity(t *testing.T, id string, fill byte) Identity {
	t.Helper()
	privateKey := adversarialPrivateKey(fill)
	identity, err := NewIdentity(
		id,
		"Test "+id,
		id+"-key",
		privateKey.Public().(ed25519.PublicKey),
	)
	if err != nil {
		t.Fatalf("create identity %q: %v", id, err)
	}
	return identity
}

func adversarialErasure(
	t *testing.T,
	contribution ContributionAttestation,
	destroyedAt string,
) ErasureAttestation {
	t.Helper()
	erasure, err := NewErasureAttestation(ErasureAttestation{
		CeremonyID:                contribution.CeremonyID,
		Phase:                     contribution.Phase,
		PhaseID:                   contribution.PhaseID,
		Index:                     contribution.Index,
		ParticipantID:             contribution.ParticipantID,
		ParticipantKeyID:          contribution.ParticipantKeyID,
		ContributionAttestationID: contribution.AttestationID,
		OutputPayload:             contribution.OutputPayload,
		DestroyedAt:               destroyedAt,
		ProcessTerminated:         true,
		EphemeralStorageDestroyed: true,
		NoBackupRetained:          true,
	})
	if err != nil {
		t.Fatalf("create erasure attestation: %v", err)
	}
	return erasure
}

func adversarialDefinition(t *testing.T) CeremonyDefinition {
	t.Helper()
	coordinator := adversarialIdentity(t, "coordinator", 0x01)
	releaseSigner := adversarialIdentity(t, "release-signer", 0x02)
	auditors := []Identity{
		adversarialIdentity(t, "auditor-01", 0x03),
		adversarialIdentity(t, "auditor-02", 0x04),
	}
	participants := []Participant{
		{Identity: adversarialIdentity(t, "participant-01", 0x11)},
		{Identity: adversarialIdentity(t, "participant-02", 0x12)},
		{Identity: adversarialIdentity(t, "participant-03", 0x13)},
	}
	definition, err := NewCeremonyDefinition(DefinitionOptions{
		Mode:            ModeProduction,
		CreatedAt:       "2026-07-23T12:00:00Z",
		SessionNonceHex: strings.Repeat("5a", 32),
		Circuit: CircuitBinding{
			KeyVersion:        KeyVersionDestinationV2,
			CircuitID:         CircuitIDDestinationV2,
			Curve:             CurveBLS12381,
			Backend:           BackendGroth16,
			R1CS:              ArtifactRef{Name: "ownership-destination.ccs", Digest: NewDigest([]byte("r1cs"))},
			Constraints:       7,
			InternalVariables: 3,
			SecretVariables:   2,
			PublicVariables:   1,
			DomainSize:        8,
			Phase2Shape: Phase2Shape{
				Commitments:     1,
				PKK:             1,
				Z:               7,
				SigmaCKK:        []uint32{1},
				ChallengeLength: 0,
			},
		},
		Software: SoftwareBinding{
			ProofToolVersion:   "0.1.0",
			GnarkVersion:       GnarkVersion,
			GnarkCryptoVersion: GnarkCryptoVersion,
			DrandVersion:       DrandVersion,
			GoVersion:          ProductionGoVersion,
			GoOS:               ProductionGOOS,
			GoArch:             ProductionGOARCH,
			GoAMD64:            ProductionGOAMD64,
			Compiler:           ProductionCompiler,
			BuildMode:          ProductionBuildMode,
			CGOEnabled:         false,
			TrimPath:           true,
			SourceCommit:       strings.Repeat("6b", 20),
			SourceDirty:        false,
			ToolBinary:         NewDigest([]byte("mpc-ceremony binary")),
		},
		Coordinator:   coordinator,
		ReleaseSigner: releaseSigner,
		Auditors:      auditors,
		Roster:        participants,
		Phase1Policy: PhasePolicy{
			Participants: []string{"participant-01", "participant-02", "participant-03"},
			Minimum:      3,
		},
		Phase2Policy: PhasePolicy{
			Participants: []string{"participant-01", "participant-02", "participant-03"},
			Minimum:      3,
		},
		BeaconPolicy: BeaconPolicy{
			Provider:                  BeaconProviderDrand,
			Network:                   BeaconNetworkQuicknet,
			ChainHashHex:              BeaconQuicknetChainHash,
			PublicKeyHex:              BeaconQuicknetPublicKey,
			Scheme:                    BeaconQuicknetScheme,
			GenesisTimeUnix:           BeaconQuicknetGenesis,
			PeriodSeconds:             BeaconQuicknetPeriod,
			Extraction:                BeaconExtractionV1,
			MinimumChallengeBytes:     32,
			MinimumWitnessLeadSeconds: ProductionMinimumWitnessLeadSeconds,
			FutureRoundRequired:       true,
		},
		Phase1Genesis: ArtifactRef{
			Name:   "phase1/genesis.bin",
			Digest: NewDigest([]byte("phase1 genesis")),
		},
	})
	if err != nil {
		t.Fatalf("create ceremony definition: %v", err)
	}
	return definition
}

func adversarialCandidate(t *testing.T, definition CeremonyDefinition) CandidateMetadata {
	t.Helper()
	ref := func(name, value string) ArtifactRef {
		return ArtifactRef{Name: name, Digest: NewDigest([]byte(value))}
	}
	phase1 := PhaseSummary{
		Phase:             Phase1,
		PhaseID:           NewDigest([]byte("phase1 id")).SHA256,
		Genesis:           definition.Phase1Genesis,
		Chain:             ref("phase1-chain.json", "phase1 chain"),
		ChainHeadID:       NewDigest([]byte("phase1 head")).SHA256,
		ContributionCount: 3,
		Participants:      []string{"participant-01", "participant-02", "participant-03"},
		CloseID:           NewDigest([]byte("phase1 close")).SHA256,
		BeaconID:          NewDigest([]byte("phase1 beacon")).SHA256,
		SealID:            NewDigest([]byte("phase1 seal")).SHA256,
		Outputs:           []ArtifactRef{ref("commons.bin", "commons")},
	}
	provingKey := ref(NativeProvingKeyFile, "proving key")
	verifyingKey := ref(NativeVerifyingKeyFile, "verifying key")
	phase2 := PhaseSummary{
		Phase:             Phase2,
		PhaseID:           NewDigest([]byte("phase2 id")).SHA256,
		Genesis:           ref("phase2-genesis.bin", "phase2 genesis"),
		Chain:             ref("phase2-chain.json", "phase2 chain"),
		ChainHeadID:       NewDigest([]byte("phase2 head")).SHA256,
		ContributionCount: 3,
		Participants:      []string{"participant-01", "participant-02", "participant-03"},
		CloseID:           NewDigest([]byte("phase2 close")).SHA256,
		BeaconID:          NewDigest([]byte("phase2 beacon")).SHA256,
		SealID:            NewDigest([]byte("phase2 seal")).SHA256,
		Outputs:           []ArtifactRef{provingKey, verifyingKey},
	}
	candidate, err := NewCandidateMetadata(CandidateMetadata{
		CeremonyID:          definition.CeremonyID,
		Definition:          ref("ceremony.json", "definition"),
		Circuit:             definition.Circuit,
		Phase1:              phase1,
		Phase2:              phase2,
		ConstraintSystem:    definition.Circuit.R1CS,
		ProvingKey:          provingKey,
		VerifyingKey:        verifyingKey,
		CardanoVerifyingKey: ref(CardanoVKBytesFile, "cardano vk"),
		CardanoVKHex:        ref(CardanoVKHexFile, "cardano vk hex"),
		CardanoVKFormat:     ref(CardanoVKFormatFile, "cardano vk format"),
		VerificationReport:  ref(VerificationReportFile, "verification report"),
		PublicEvidence:      ref(PublicEvidenceFile, "public finalization evidence"),
		Phase2SealRecord:    ref(Phase2SealFile, "phase2 seal record"),
		CoordinatorID:       definition.Coordinator.ID,
		CoordinatorKeyID:    definition.Coordinator.KeyID,
		FinalizedAt:         "2026-07-23T13:00:00Z",
	})
	if err != nil {
		t.Fatalf("create release candidate fixture: %v", err)
	}
	return candidate
}

func adversarialSignedAudit(
	t *testing.T,
	definition CeremonyDefinition,
	candidate CandidateMetadata,
	auditorIndex int,
	auditedAt string,
	outputs []ArtifactRef,
) AuditArtifact {
	t.Helper()
	candidateBytes, err := MarshalCanonical(candidate)
	if err != nil {
		t.Fatal(err)
	}
	replayRoot, err := replayRootSHA256(candidate)
	if err != nil {
		t.Fatal(err)
	}
	auditor := definition.Auditors[auditorIndex]
	record, err := NewAuditRecord(AuditRecord{
		CeremonyID:       definition.CeremonyID,
		AuditorID:        auditor.ID,
		AuditorKeyID:     auditor.KeyID,
		Definition:       candidate.Definition,
		Phase1Chain:      candidate.Phase1.Chain,
		Phase2Chain:      candidate.Phase2.Chain,
		Phase1SealID:     candidate.Phase1.SealID,
		Phase2SealID:     candidate.Phase2.SealID,
		ReplayRootSHA256: replayRoot,
		Outputs:          outputs,
		Passed:           true,
		Findings:         []string{},
		AuditedAt:        auditedAt,
	})
	if err != nil {
		t.Fatalf("create audit record: %v", err)
	}
	recordBytes, signatureBytes, err := SignRecord(
		record,
		auditor.KeyID,
		adversarialPrivateKey(byte(0x03+auditorIndex)),
	)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	recordPath := filepath.Join(dir, "audit-"+string(rune('1'+auditorIndex))+".json")
	signaturePath := filepath.Join(dir, "audit-"+string(rune('1'+auditorIndex))+".sig")
	adversarialWriteRaw(t, recordPath, recordBytes)
	adversarialWriteRaw(t, signaturePath, signatureBytes)

	expectedCandidateRef := ArtifactRef{Name: CandidateMetadataFile, Digest: NewDigest(candidateBytes)}
	if !slices.Contains(outputs, expectedCandidateRef) {
		t.Fatal("audit fixture does not bind candidate metadata")
	}
	return AuditArtifact{RecordPath: recordPath, SignaturePath: signaturePath}
}

func TestCeremonyDefinitionRejectsMetadataDrift(t *testing.T) {
	valid := adversarialDefinition(t)
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid definition rejected: %v", err)
	}

	cases := []struct {
		name   string
		mutate func(*CeremonyDefinition)
	}{
		{name: "wrong curve", mutate: func(d *CeremonyDefinition) { d.Circuit.Curve = "BN254" }},
		{name: "wrong backend", mutate: func(d *CeremonyDefinition) { d.Circuit.Backend = "plonk" }},
		{name: "wrong circuit", mutate: func(d *CeremonyDefinition) { d.Circuit.CircuitID = "other-circuit" }},
		{name: "wrong key version", mutate: func(d *CeremonyDefinition) { d.Circuit.KeyVersion = "other-key" }},
		{name: "wrong domain", mutate: func(d *CeremonyDefinition) { d.Circuit.DomainSize = 16 }},
		{name: "wrong R1CS digest", mutate: func(d *CeremonyDefinition) {
			d.Circuit.R1CS.Digest = NewDigest([]byte("different r1cs"))
		}},
		{name: "wrong gnark", mutate: func(d *CeremonyDefinition) { d.Software.GnarkVersion = "v0.14.0" }},
		{name: "wrong gnark crypto", mutate: func(d *CeremonyDefinition) {
			d.Software.GnarkCryptoVersion = "v0.19.0"
		}},
		{name: "wrong drand", mutate: func(d *CeremonyDefinition) {
			d.Software.DrandVersion = "v2.1.5"
		}},
		{name: "dirty source", mutate: func(d *CeremonyDefinition) { d.Software.SourceDirty = true }},
		{name: "wrong Go version", mutate: func(d *CeremonyDefinition) {
			d.Software.GoVersion = "go1.26.6"
		}},
		{name: "wrong target OS", mutate: func(d *CeremonyDefinition) {
			d.Software.GoOS = "darwin"
		}},
		{name: "wrong target architecture", mutate: func(d *CeremonyDefinition) {
			d.Software.GoArch = "arm64"
		}},
		{name: "wrong amd64 level", mutate: func(d *CeremonyDefinition) {
			d.Software.GoAMD64 = "v3"
		}},
		{name: "wrong compiler", mutate: func(d *CeremonyDefinition) {
			d.Software.Compiler = "gccgo"
		}},
		{name: "wrong build mode", mutate: func(d *CeremonyDefinition) {
			d.Software.BuildMode = "pie"
		}},
		{name: "CGO enabled", mutate: func(d *CeremonyDefinition) {
			d.Software.CGOEnabled = true
		}},
		{name: "trimpath disabled", mutate: func(d *CeremonyDefinition) {
			d.Software.TrimPath = false
		}},
		{name: "different tool binary", mutate: func(d *CeremonyDefinition) {
			d.Software.ToolBinary = NewDigest([]byte("different binary"))
		}},
		{name: "duplicate participant", mutate: func(d *CeremonyDefinition) {
			d.Roster[1] = d.Roster[0]
		}},
		{name: "below phase threshold", mutate: func(d *CeremonyDefinition) {
			d.Phase1Policy.Minimum = 0
		}},
		{name: "beacon policy weakened", mutate: func(d *CeremonyDefinition) {
			d.BeaconPolicy.FutureRoundRequired = false
		}},
		{name: "beacon witness lead weakened", mutate: func(d *CeremonyDefinition) {
			d.BeaconPolicy.MinimumWitnessLeadSeconds = ProductionMinimumWitnessLeadSeconds - 1
		}},
		{name: "beacon chain replaced", mutate: func(d *CeremonyDefinition) {
			d.BeaconPolicy.ChainHashHex = strings.Repeat("00", 32)
		}},
		{name: "beacon public key replaced", mutate: func(d *CeremonyDefinition) {
			d.BeaconPolicy.PublicKeyHex = strings.Repeat("00", 96)
		}},
		{name: "beacon timing replaced", mutate: func(d *CeremonyDefinition) {
			d.BeaconPolicy.GenesisTimeUnix++
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			changed := valid
			changed.Roster = append([]Participant(nil), valid.Roster...)
			changed.Phase1Policy = clonePhasePolicy(valid.Phase1Policy)
			changed.Phase2Policy = clonePhasePolicy(valid.Phase2Policy)
			tc.mutate(&changed)
			if err := changed.Validate(); err == nil {
				t.Fatal("drifted ceremony metadata unexpectedly accepted")
			}
		})
	}
}

func adversarialChainRecord(
	t *testing.T,
	definition CeremonyDefinition,
	phaseID string,
	index uint8,
	participantID string,
	previousPayload ArtifactRef,
	previousRecordID string,
	outputLabel string,
) ChainRecord {
	t.Helper()
	record, err := NewChainRecord(ChainRecord{
		CeremonyID:      definition.CeremonyID,
		Phase:           Phase1,
		PhaseID:         phaseID,
		Index:           index,
		ParticipantID:   participantID,
		PreviousPayload: previousPayload,
		OutputPayload:   ArtifactRef{Name: "phase1/" + outputLabel + ".bin", Digest: NewDigest([]byte(outputLabel))},
		AttestationID:   NewDigest([]byte(outputLabel + " attestation id")).SHA256,
		Attestation:     ArtifactRef{Name: "phase1/" + outputLabel + ".attestation.json", Digest: NewDigest([]byte(outputLabel + " attestation"))},
		AttestationSignature: ArtifactRef{
			Name:   "phase1/" + outputLabel + ".attestation.sig",
			Digest: NewDigest([]byte(outputLabel + " attestation signature")),
		},
		ErasureID: NewDigest([]byte(outputLabel + " erasure id")).SHA256,
		Erasure: ArtifactRef{
			Name:   "phase1/" + outputLabel + ".erasure.json",
			Digest: NewDigest([]byte(outputLabel + " erasure")),
		},
		ErasureSignature: ArtifactRef{
			Name:   "phase1/" + outputLabel + ".erasure.sig",
			Digest: NewDigest([]byte(outputLabel + " erasure signature")),
		},
		Verification:     ArtifactRef{Name: "phase1/" + outputLabel + ".verification.json", Digest: NewDigest([]byte(outputLabel + " verification"))},
		PreviousRecordID: previousRecordID,
		CoordinatorID:    definition.Coordinator.ID,
		CoordinatorKeyID: definition.Coordinator.KeyID,
		AcceptedAt:       "2026-07-23T12:00:0" + string(rune('0'+index)) + "Z",
	})
	if err != nil {
		t.Fatalf("create chain record %d: %v", index, err)
	}
	return record
}

func TestCoordinatorResignedVerificationCannotDriftFromAcceptedRecord(t *testing.T) {
	definition := adversarialDefinition(t)
	phaseID, err := ComputePhaseID(definition.CeremonyID, Phase1, definition.Phase1Genesis, "")
	if err != nil {
		t.Fatal(err)
	}
	baseChain, err := NewChain(definition.CeremonyID, Phase1, phaseID, definition.Phase1Genesis)
	if err != nil {
		t.Fatal(err)
	}
	headPayload, err := baseChain.HeadPayload()
	if err != nil {
		t.Fatal(err)
	}
	headID, err := baseChain.HeadRecordID()
	if err != nil {
		t.Fatal(err)
	}
	record := adversarialChainRecord(
		t,
		definition,
		phaseID,
		1,
		"participant-01",
		headPayload,
		headID,
		"contribution-1",
	)
	valid := ContributionVerification{
		Schema:           verificationSchema,
		VerificationMode: directTransitionVerification,
		CeremonyID:       record.CeremonyID,
		Phase:            record.Phase,
		PhaseID:          record.PhaseID,
		Index:            record.Index,
		ParticipantID:    record.ParticipantID,
		PreviousPayload:  record.PreviousPayload,
		OutputPayload:    record.OutputPayload,
		AttestationID:    record.AttestationID,
		ErasureID:        record.ErasureID,
		PreviousRecordID: record.PreviousRecordID,
		CoordinatorID:    record.CoordinatorID,
		CoordinatorKeyID: record.CoordinatorKeyID,
		Passed:           true,
		VerifiedAt:       record.AcceptedAt,
	}
	if err := validateContributionVerification(record, valid); err != nil {
		t.Fatalf("valid verification rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*ContributionVerification)
	}{
		{
			name: "erasure id",
			mutate: func(verification *ContributionVerification) {
				verification.ErasureID = NewDigest([]byte("different erasure")).SHA256
			},
		},
		{
			name: "verified timestamp",
			mutate: func(verification *ContributionVerification) {
				verification.VerifiedAt = "2026-07-23T12:00:02Z"
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			verification := valid
			tc.mutate(&verification)
			verificationBytes, err := MarshalCanonical(verification)
			if err != nil {
				t.Fatal(err)
			}

			resignedRecord := record
			resignedRecord.Verification.Digest = NewDigest(verificationBytes)
			resignedRecord, err = NewChainRecord(resignedRecord)
			if err != nil {
				t.Fatal(err)
			}
			resignedChain := baseChain
			if err := resignedChain.Append(resignedRecord); err != nil {
				t.Fatal(err)
			}

			coordinatorPrivate := adversarialPrivateKey(0x01)
			chainBytes, signatureBytes, err := SignRecord(
				resignedChain,
				definition.Coordinator.KeyID,
				coordinatorPrivate,
			)
			if err != nil {
				t.Fatal(err)
			}
			var authenticated Chain
			if err := VerifySignedRecord(
				chainBytes,
				signatureBytes,
				&authenticated,
				definition.Coordinator.KeyID,
				coordinatorPrivate.Public().(ed25519.PublicKey),
			); err != nil {
				t.Fatalf("maliciously re-signed chain did not authenticate: %v", err)
			}
			var archivedVerification ContributionVerification
			if err := UnmarshalCanonical(verificationBytes, &archivedVerification); err != nil {
				t.Fatal(err)
			}
			if err := validateContributionVerification(
				authenticated.Records[0],
				archivedVerification,
			); err == nil {
				t.Fatal("coordinator-authenticated verification drift unexpectedly accepted")
			}
		})
	}
}

func TestAcceptedChainRejectsReorderReplayAndForkMerge(t *testing.T) {
	definition := adversarialDefinition(t)
	phaseID, err := ComputePhaseID(definition.CeremonyID, Phase1, definition.Phase1Genesis, "")
	if err != nil {
		t.Fatal(err)
	}
	chain, err := NewChain(definition.CeremonyID, Phase1, phaseID, definition.Phase1Genesis)
	if err != nil {
		t.Fatal(err)
	}
	for index, participantID := range definition.Phase1Policy.Participants {
		headPayload, err := chain.HeadPayload()
		if err != nil {
			t.Fatal(err)
		}
		headID, err := chain.HeadRecordID()
		if err != nil {
			t.Fatal(err)
		}
		record := adversarialChainRecord(
			t,
			definition,
			phaseID,
			uint8(index+1),
			participantID,
			headPayload,
			headID,
			"contribution-"+string(rune('1'+index)),
		)
		if err := chain.Append(record); err != nil {
			t.Fatalf("append valid record %d: %v", index+1, err)
		}
	}
	if err := chain.ValidateAgainstDefinition(definition); err != nil {
		t.Fatalf("valid accepted chain rejected: %v", err)
	}

	regressedTime := chain
	regressedTime.Records = append([]ChainRecord(nil), chain.Records[:2]...)
	second := regressedTime.Records[1]
	second.AcceptedAt = regressedTime.Records[0].AcceptedAt
	second, err = NewChainRecord(second)
	if err != nil {
		t.Fatal(err)
	}
	regressedTime.Records[1] = second
	if err := regressedTime.Validate(); err == nil {
		t.Fatal("accepted chain with non-increasing acceptance timestamps unexpectedly validated")
	}

	reordered := chain
	reordered.Records = append([]ChainRecord(nil), chain.Records...)
	reordered.Records[1], reordered.Records[2] = reordered.Records[2], reordered.Records[1]
	if err := reordered.Validate(); err == nil {
		t.Fatal("reordered accepted chain unexpectedly validated")
	}

	replayed := chain
	replayed.Records = append([]ChainRecord(nil), chain.Records...)
	replayed.Records[2] = replayed.Records[1]
	if err := replayed.Validate(); err == nil {
		t.Fatal("replayed accepted record unexpectedly validated")
	}

	// Two candidates derived from the same accepted head are individually
	// valid forks. Exactly one may advance a chain; the stale sibling must
	// never be merged afterward.
	base, err := NewChain(definition.CeremonyID, Phase1, phaseID, definition.Phase1Genesis)
	if err != nil {
		t.Fatal(err)
	}
	genesisID, err := base.HeadRecordID()
	if err != nil {
		t.Fatal(err)
	}
	first := adversarialChainRecord(
		t, definition, phaseID, 1, "participant-01",
		definition.Phase1Genesis, genesisID, "fork-root",
	)
	if err := base.Append(first); err != nil {
		t.Fatal(err)
	}
	headPayload, _ := base.HeadPayload()
	headID, _ := base.HeadRecordID()
	left := adversarialChainRecord(
		t, definition, phaseID, 2, "participant-02",
		headPayload, headID, "fork-left",
	)
	right := adversarialChainRecord(
		t, definition, phaseID, 2, "participant-02",
		headPayload, headID, "fork-right",
	)
	leftChain := base
	leftChain.Records = append([]ChainRecord(nil), base.Records...)
	if err := leftChain.Append(left); err != nil {
		t.Fatalf("append left fork: %v", err)
	}
	rightChain := base
	rightChain.Records = append([]ChainRecord(nil), base.Records...)
	if err := rightChain.Append(right); err != nil {
		t.Fatalf("append right fork: %v", err)
	}
	if err := leftChain.Append(right); err == nil {
		t.Fatal("stale right fork unexpectedly merged after left fork")
	}
	if len(leftChain.Records) != 2 || leftChain.Records[1].RecordID != left.RecordID {
		t.Fatal("rejected fork append mutated the accepted chain")
	}
}

func TestAcceptanceRecordMustExactlyBindAttestation(t *testing.T) {
	definition := adversarialDefinition(t)
	phaseID, err := ComputePhaseID(definition.CeremonyID, Phase1, definition.Phase1Genesis, "")
	if err != nil {
		t.Fatal(err)
	}
	chain, err := NewChain(definition.CeremonyID, Phase1, phaseID, definition.Phase1Genesis)
	if err != nil {
		t.Fatal(err)
	}
	previousRecordID, err := chain.HeadRecordID()
	if err != nil {
		t.Fatal(err)
	}
	output := ArtifactRef{Name: "phase1/contribution-1.bin", Digest: NewDigest([]byte("output one"))}
	attestation, err := NewContributionAttestation(ContributionAttestation{
		CeremonyID:           definition.CeremonyID,
		Phase:                Phase1,
		PhaseID:              phaseID,
		Index:                1,
		ParticipantID:        "participant-01",
		ParticipantKeyID:     definition.Roster[0].Identity.KeyID,
		PreviousPayload:      definition.Phase1Genesis,
		OutputPayload:        output,
		PreviousAcceptanceID: previousRecordID,
		ToolBinary:           definition.Software.ToolBinary,
		SourceCommit:         definition.Software.SourceCommit,
		GnarkVersion:         definition.Software.GnarkVersion,
		GnarkCryptoVersion:   definition.Software.GnarkCryptoVersion,
		DrandVersion:         definition.Software.DrandVersion,
		Environment: ContributionEnvironment{
			OS:                           "linux",
			Architecture:                 "amd64",
			EntropySource:                "operating-system-csprng",
			SwapDisabled:                 true,
			CrashDumpsDisabled:           true,
			TelemetryDisabled:            true,
			EphemeralEnvironment:         true,
			EphemeralDestructionRequired: true,
		},
		ContributedAt: "2026-07-23T12:01:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	erasure := adversarialErasure(t, attestation, "2026-07-23T12:01:30Z")
	record, err := NewChainRecord(ChainRecord{
		CeremonyID:      definition.CeremonyID,
		Phase:           Phase1,
		PhaseID:         phaseID,
		Index:           1,
		ParticipantID:   attestation.ParticipantID,
		PreviousPayload: attestation.PreviousPayload,
		OutputPayload:   attestation.OutputPayload,
		AttestationID:   attestation.AttestationID,
		Attestation:     ArtifactRef{Name: "phase1/contribution-1.attestation.json", Digest: NewDigest([]byte("attestation"))},
		AttestationSignature: ArtifactRef{
			Name:   "phase1/contribution-1.attestation.sig",
			Digest: NewDigest([]byte("signature")),
		},
		ErasureID: erasure.ErasureID,
		Erasure: ArtifactRef{
			Name:   "phase1/contribution-1.erasure.json",
			Digest: NewDigest([]byte("erasure")),
		},
		ErasureSignature: ArtifactRef{
			Name:   "phase1/contribution-1.erasure.sig",
			Digest: NewDigest([]byte("erasure signature")),
		},
		Verification:     ArtifactRef{Name: "phase1/contribution-1.verification.json", Digest: NewDigest([]byte("verification"))},
		PreviousRecordID: previousRecordID,
		CoordinatorID:    definition.Coordinator.ID,
		CoordinatorKeyID: definition.Coordinator.KeyID,
		AcceptedAt:       "2026-07-23T12:02:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateAttestationAcceptance(definition, chain, attestation, erasure, record); err != nil {
		t.Fatalf("valid attestation acceptance rejected: %v", err)
	}

	atDefinition := attestation
	atDefinition.ContributedAt = definition.CreatedAt
	atDefinition, err = NewContributionAttestation(atDefinition)
	if err != nil {
		t.Fatal(err)
	}
	atDefinitionErasure := adversarialErasure(t, atDefinition, "2026-07-23T12:00:01Z")
	atDefinitionRecord := record
	atDefinitionRecord.AttestationID = atDefinition.AttestationID
	atDefinitionRecord.ErasureID = atDefinitionErasure.ErasureID
	atDefinitionRecord.AcceptedAt = "2026-07-23T12:00:02Z"
	atDefinitionRecord, err = NewChainRecord(atDefinitionRecord)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateAttestationAcceptance(
		definition,
		chain,
		atDefinition,
		atDefinitionErasure,
		atDefinitionRecord,
	); err == nil {
		t.Fatal("contribution at the definition timestamp unexpectedly accepted")
	}

	acceptedBeforeDestruction := record
	acceptedBeforeDestruction.AcceptedAt = erasure.DestroyedAt
	acceptedBeforeDestruction, err = NewChainRecord(acceptedBeforeDestruction)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateAttestationAcceptance(
		definition,
		chain,
		attestation,
		erasure,
		acceptedBeforeDestruction,
	); err == nil {
		t.Fatal("acceptance at the erasure timestamp unexpectedly accepted")
	}

	advancedChain := chain
	advancedChain.Records = append([]ChainRecord(nil), chain.Records...)
	if err := advancedChain.Append(record); err != nil {
		t.Fatal(err)
	}
	secondOutput := ArtifactRef{
		Name:   "phase1/contribution-2.bin",
		Digest: NewDigest([]byte("output two")),
	}
	secondAttestation := attestation
	secondAttestation.Index = 2
	secondAttestation.ParticipantID = "participant-02"
	secondAttestation.ParticipantKeyID = definition.Roster[1].Identity.KeyID
	secondAttestation.PreviousPayload = record.OutputPayload
	secondAttestation.OutputPayload = secondOutput
	secondAttestation.PreviousAcceptanceID = record.RecordID
	secondAttestation.ContributedAt = record.AcceptedAt
	secondAttestation, err = NewContributionAttestation(secondAttestation)
	if err != nil {
		t.Fatal(err)
	}
	secondErasure := adversarialErasure(t, secondAttestation, "2026-07-23T12:02:30Z")
	secondRecord, err := NewChainRecord(ChainRecord{
		CeremonyID:      definition.CeremonyID,
		Phase:           Phase1,
		PhaseID:         phaseID,
		Index:           2,
		ParticipantID:   secondAttestation.ParticipantID,
		PreviousPayload: secondAttestation.PreviousPayload,
		OutputPayload:   secondAttestation.OutputPayload,
		AttestationID:   secondAttestation.AttestationID,
		Attestation: ArtifactRef{
			Name:   "phase1/contribution-2.attestation.json",
			Digest: NewDigest([]byte("attestation two")),
		},
		AttestationSignature: ArtifactRef{
			Name:   "phase1/contribution-2.attestation.sig",
			Digest: NewDigest([]byte("signature two")),
		},
		ErasureID: secondErasure.ErasureID,
		Erasure: ArtifactRef{
			Name:   "phase1/contribution-2.erasure.json",
			Digest: NewDigest([]byte("erasure two")),
		},
		ErasureSignature: ArtifactRef{
			Name:   "phase1/contribution-2.erasure.sig",
			Digest: NewDigest([]byte("erasure signature two")),
		},
		Verification: ArtifactRef{
			Name:   "phase1/contribution-2.verification.json",
			Digest: NewDigest([]byte("verification two")),
		},
		PreviousRecordID: record.RecordID,
		CoordinatorID:    definition.Coordinator.ID,
		CoordinatorKeyID: definition.Coordinator.KeyID,
		AcceptedAt:       "2026-07-23T12:03:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateAttestationAcceptance(
		definition,
		advancedChain,
		secondAttestation,
		secondErasure,
		secondRecord,
	); err == nil {
		t.Fatal("contribution at the previous acceptance timestamp unexpectedly accepted")
	}

	differentOutput := ArtifactRef{Name: "phase1/other.bin", Digest: NewDigest([]byte("other output"))}
	mismatchedRecord := record
	mismatchedRecord.OutputPayload = differentOutput
	mismatchedRecord, err = NewChainRecord(mismatchedRecord)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateAttestationAcceptance(definition, chain, attestation, erasure, mismatchedRecord); err == nil {
		t.Fatal("acceptance record for a different output unexpectedly bound the attestation")
	}

	wrongIdentity := attestation
	wrongIdentity.ParticipantKeyID = "unregistered-participant-key"
	wrongIdentity, err = NewContributionAttestation(wrongIdentity)
	if err != nil {
		t.Fatal(err)
	}
	wrongIdentityErasure := adversarialErasure(t, wrongIdentity, "2026-07-23T12:01:30Z")
	wrongIdentityRecord := record
	wrongIdentityRecord.AttestationID = wrongIdentity.AttestationID
	wrongIdentityRecord.ErasureID = wrongIdentityErasure.ErasureID
	wrongIdentityRecord, err = NewChainRecord(wrongIdentityRecord)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateAttestationAcceptance(
		definition,
		chain,
		wrongIdentity,
		wrongIdentityErasure,
		wrongIdentityRecord,
	); err == nil {
		t.Fatal("attestation under a different participant key unexpectedly accepted")
	}
}

func TestErasureAttestationRequiresExactPostContributionDestruction(t *testing.T) {
	contribution := adversarialAttestation(t)
	erasure := adversarialErasure(t, contribution, "2026-07-23T12:00:01Z")
	if err := ValidateErasureForContribution(contribution, erasure); err != nil {
		t.Fatalf("valid post-contribution erasure rejected: %v", err)
	}

	notAfter := erasure
	notAfter.DestroyedAt = contribution.ContributedAt
	notAfter, err := NewErasureAttestation(notAfter)
	if err != nil {
		t.Fatalf("create chronologically invalid erasure record: %v", err)
	}
	if err := ValidateErasureForContribution(contribution, notAfter); err == nil {
		t.Fatal("erasure at the contribution timestamp unexpectedly accepted")
	}

	wrongOutput := erasure
	wrongOutput.OutputPayload = ArtifactRef{
		Name:   "phase1/different-output.bin",
		Digest: NewDigest([]byte("different output")),
	}
	wrongOutput, err = NewErasureAttestation(wrongOutput)
	if err != nil {
		t.Fatalf("create wrong-output erasure record: %v", err)
	}
	if err := ValidateErasureForContribution(contribution, wrongOutput); err == nil {
		t.Fatal("erasure for a different output unexpectedly accepted")
	}

	incomplete := erasure
	incomplete.NoBackupRetained = false
	if _, err := NewErasureAttestation(incomplete); err == nil {
		t.Fatal("erasure with a retained backup unexpectedly accepted")
	}
}

func TestPinnedQuicknetBeaconVerificationRejectsMalformedOrForgedEvidence(t *testing.T) {
	// Public round-1 response from the pinned quicknet chain:
	// https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/1
	const valid = `{"round":1,"randomness":"1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a","signature":"b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b"}`
	policy := adversarialDefinition(t).BeaconPolicy
	randomness, err := VerifyDrandBeaconResponse(policy, 1, []byte(valid))
	if err != nil {
		t.Fatalf("verify pinned quicknet response: %v", err)
	}
	if randomness != "1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a" {
		t.Fatalf("verified randomness = %q", randomness)
	}

	cases := []struct {
		name          string
		expectedRound uint64
		response      string
	}{
		{name: "wrong committed round", expectedRound: 2, response: valid},
		{
			name:          "forged randomness",
			expectedRound: 1,
			response: strings.Replace(
				valid,
				"1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a",
				strings.Repeat("00", 32),
				1,
			),
		},
		{
			name:          "forged signature",
			expectedRound: 1,
			response: strings.Replace(
				valid,
				"b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b",
				strings.Repeat("00", 48),
				1,
			),
		},
		{name: "unknown field", expectedRound: 1, response: strings.TrimSuffix(valid, "}") + `,"challenge":"00"}`},
		{name: "duplicate key", expectedRound: 1, response: strings.Replace(valid, `"round":1`, `"round":1,"round":1`, 1)},
		{name: "trailing JSON", expectedRound: 1, response: valid + `{}`},
		{name: "chained response", expectedRound: 1, response: strings.TrimSuffix(valid, "}") + `,"previous_signature":"00"}`},
		{name: "uppercase randomness", expectedRound: 1, response: strings.Replace(valid, `"randomness":"1`, `"randomness":"A`, 1)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := VerifyDrandBeaconResponse(policy, tc.expectedRound, []byte(tc.response)); err == nil {
				t.Fatal("invalid drand evidence unexpectedly verified")
			}
		})
	}
}

func TestReleaseRequiresTwoExactChronologicalIndependentAudits(t *testing.T) {
	definition := adversarialDefinition(t)
	candidate := adversarialCandidate(t, definition)
	candidateBytes, err := MarshalCanonical(candidate)
	if err != nil {
		t.Fatal(err)
	}
	outputs := candidateAuditOutputs(candidate, ArtifactRef{
		Name:   CandidateMetadataFile,
		Digest: NewDigest(candidateBytes),
	})
	first := adversarialSignedAudit(
		t,
		definition,
		candidate,
		0,
		"2026-07-23T13:01:00Z",
		outputs,
	)
	second := adversarialSignedAudit(
		t,
		definition,
		candidate,
		1,
		"2026-07-23T13:02:00Z",
		outputs,
	)
	refs, latest, err := verifyPassingAudits(
		definition,
		candidate,
		[]AuditArtifact{first, second},
	)
	if err != nil {
		t.Fatalf("two exact independent audits rejected: %v", err)
	}
	if len(refs) != 2 || latest.Format(time.RFC3339Nano) != "2026-07-23T13:02:00Z" {
		t.Fatalf("verified audit result = %d refs, latest %s", len(refs), latest.Format(time.RFC3339Nano))
	}

	if _, _, err := verifyPassingAudits(
		definition,
		candidate,
		[]AuditArtifact{first, first},
	); err == nil {
		t.Fatal("same auditor and key counted twice toward release threshold")
	}

	extraOutputs := append(append([]ArtifactRef(nil), outputs...), ArtifactRef{
		Name:   "unexpected-auditor-output.txt",
		Digest: NewDigest([]byte("unexpected output")),
	})
	extra := adversarialSignedAudit(
		t,
		definition,
		candidate,
		0,
		"2026-07-23T13:01:00Z",
		extraOutputs,
	)
	if _, _, err := verifyPassingAudits(
		definition,
		candidate,
		[]AuditArtifact{extra, second},
	); err == nil {
		t.Fatal("audit output superset unexpectedly treated as exact candidate binding")
	}

	predating := adversarialSignedAudit(
		t,
		definition,
		candidate,
		0,
		"2026-07-23T12:59:59Z",
		outputs,
	)
	if _, _, err := verifyPassingAudits(
		definition,
		candidate,
		[]AuditArtifact{predating, second},
	); err == nil {
		t.Fatal("audit predating candidate finalization unexpectedly accepted")
	}

	if err := validateReleaseChronology(latest, latest); err == nil {
		t.Fatal("release at the latest audit timestamp unexpectedly accepted")
	}
	if err := validateReleaseChronology(latest.Add(time.Nanosecond), latest); err != nil {
		t.Fatalf("release strictly after the latest audit rejected: %v", err)
	}
}

func TestSignedContributionAttestationRejectsTamperingAndWrongTrust(t *testing.T) {
	attestation := adversarialAttestation(t)
	privateKey := adversarialPrivateKey(0x51)
	publicKey := privateKey.Public().(ed25519.PublicKey)

	recordBytes, signatureBytes, err := SignRecord(attestation, attestation.ParticipantKeyID, privateKey)
	if err != nil {
		t.Fatalf("sign attestation: %v", err)
	}
	var verified ContributionAttestation
	if err := VerifySignedRecord(
		recordBytes,
		signatureBytes,
		&verified,
		attestation.ParticipantKeyID,
		publicKey,
	); err != nil {
		t.Fatalf("verify valid signed attestation: %v", err)
	}
	if verified.AttestationID != attestation.AttestationID {
		t.Fatalf("verified attestation id = %q, want %q", verified.AttestationID, attestation.AttestationID)
	}

	tampered := bytes.Replace(recordBytes, []byte(`"phase":"phase1"`), []byte(`"phase":"phase2"`), 1)
	if bytes.Equal(tampered, recordBytes) {
		t.Fatal("test failed to tamper phase")
	}
	if err := VerifySignedRecord(
		tampered,
		signatureBytes,
		&ContributionAttestation{},
		attestation.ParticipantKeyID,
		publicKey,
	); err == nil {
		t.Fatal("tampered signed attestation unexpectedly verified")
	}

	wrongPrivateKey := adversarialPrivateKey(0x52)
	wrongPublicKey := wrongPrivateKey.Public().(ed25519.PublicKey)
	if err := VerifySignedRecord(
		recordBytes,
		signatureBytes,
		&ContributionAttestation{},
		attestation.ParticipantKeyID,
		wrongPublicKey,
	); err == nil {
		t.Fatal("signature unexpectedly verified under the wrong public key")
	}
	if err := VerifySignedRecord(
		recordBytes,
		signatureBytes,
		&ContributionAttestation{},
		"another-participant-key",
		publicKey,
	); err == nil {
		t.Fatal("signature unexpectedly verified under the wrong trusted key id")
	}
}

func TestSignedContributionAttestationStillAppliesSemanticValidation(t *testing.T) {
	attestation := adversarialAttestation(t)
	attestation.GnarkVersion = "v0.14.0"

	// SignExact deliberately allows already-canonical arbitrary artifacts.
	// Even a cryptographically valid signature must not bypass strict typed
	// validation when the bytes are consumed as an attestation.
	invalidRecord, err := json.Marshal(attestation)
	if err != nil {
		t.Fatal(err)
	}
	privateKey := adversarialPrivateKey(0x61)
	signature, err := SignExact(invalidRecord, attestation.ParticipantKeyID, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	signatureBytes, err := MarshalCanonical(signature)
	if err != nil {
		t.Fatal(err)
	}
	err = VerifySignedRecord(
		invalidRecord,
		signatureBytes,
		&ContributionAttestation{},
		attestation.ParticipantKeyID,
		privateKey.Public().(ed25519.PublicKey),
	)
	if err == nil || !strings.Contains(err.Error(), "gnark_version") {
		t.Fatalf("signed wrong-software attestation error = %v", err)
	}
}

func TestCanonicalRecordDecoderRejectsDuplicateUnknownTrailingAndNoncanonical(t *testing.T) {
	attestation := adversarialAttestation(t)
	canonical, err := MarshalCanonical(attestation)
	if err != nil {
		t.Fatal(err)
	}
	if err := UnmarshalCanonical(canonical, &ContributionAttestation{}); err != nil {
		t.Fatalf("canonical attestation rejected: %v", err)
	}

	var object map[string]json.RawMessage
	if err := json.Unmarshal(canonical, &object); err != nil {
		t.Fatal(err)
	}
	duplicate := append(bytes.Clone(canonical[:len(canonical)-1]), []byte(`,"phase":"phase1"}`)...)
	unknown := append(bytes.Clone(canonical[:len(canonical)-1]), []byte(`,"unexpected":true}`)...)
	pretty := new(bytes.Buffer)
	if err := json.Indent(pretty, canonical, "", "  "); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		raw  []byte
	}{
		{name: "duplicate field", raw: duplicate},
		{name: "unknown field", raw: unknown},
		{name: "trailing JSON", raw: append(bytes.Clone(canonical), []byte(`{}`)...)},
		{name: "trailing whitespace", raw: append(bytes.Clone(canonical), '\n')},
		{name: "pretty but noncanonical", raw: pretty.Bytes()},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := UnmarshalCanonical(tc.raw, &ContributionAttestation{}); err == nil {
				t.Fatal("noncanonical record unexpectedly accepted")
			}
		})
	}
}

func TestPhase1StrictReaderRejectsMalformedArtifacts(t *testing.T) {
	contribution := adversarialPhase1Contribution(t)
	valid := adversarialSerialize(t, contribution)
	shape := Phase1Shape{DomainN: adversarialTinyDomain, ChallengeLength: 32}
	expected, err := ExpectedPhase1Size(shape)
	if err != nil {
		t.Fatal(err)
	}
	if int64(len(valid)) != expected {
		t.Fatalf("valid Phase 1 size = %d, expected %d", len(valid), expected)
	}

	// Phase1.WriteTo places three fixed-size update proofs before the embedded
	// uint64 domain. A forged domain must be rejected by preflight before
	// gnark's decoder can allocate vectors from it.
	domainOffset := 3 * (48 + 96)
	cases := []struct {
		name string
		raw  func() []byte
	}{
		{
			name: "truncated",
			raw: func() []byte {
				return bytes.Clone(valid[:len(valid)-1])
			},
		},
		{
			name: "trailing byte",
			raw: func() []byte {
				return append(bytes.Clone(valid), 0)
			},
		},
		{
			name: "uncompressed update proof point",
			raw: func() []byte {
				out := bytes.Clone(valid)
				out[0] &= 0x1f
				return out
			},
		},
		{
			name: "oversized embedded domain",
			raw: func() []byte {
				out := bytes.Clone(valid)
				binary.BigEndian.PutUint64(out[domainOffset:domainOffset+8], math.MaxUint64)
				return out
			},
		},
		{
			name: "wrong embedded domain",
			raw: func() []byte {
				out := bytes.Clone(valid)
				binary.BigEndian.PutUint64(out[domainOffset:domainOffset+8], adversarialTinyDomain*2)
				return out
			},
		},
		{
			name: "wrong challenge length",
			raw: func() []byte {
				out := bytes.Clone(valid)
				out[len(out)-33] = 31
				return out
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "phase1.bin")
			adversarialWriteRaw(t, path, tc.raw())
			if _, _, err := ReadPhase1File(path, shape); err == nil {
				t.Fatal("malformed Phase 1 artifact unexpectedly accepted")
			}
		})
	}
}

func TestPhase1PreflightRejectsTrailingData(t *testing.T) {
	valid := adversarialSerialize(t, adversarialPhase1Contribution(t))
	shape := Phase1Shape{DomainN: adversarialTinyDomain, ChallengeLength: 32}
	if _, err := PreflightPhase1(bytes.NewReader(append(valid, 0)), shape); !errors.Is(err, ErrTrailingData) {
		t.Fatalf("trailing byte error = %v, want ErrTrailingData", err)
	}
}

func TestPhase2StrictReaderRejectsMaliciousPrefixesAndFraming(t *testing.T) {
	contribution, shape := adversarialPhase2Contribution(t)
	valid := adversarialSerialize(t, contribution)
	expected, err := ExpectedPhase2Size(shape)
	if err != nil {
		t.Fatal(err)
	}
	if int64(len(valid)) != expected {
		t.Fatalf("valid Phase 2 size = %d, expected %d", len(valid), expected)
	}

	// Phase2 starts with commitments(u16), Delta(G1), then PKK's uint32
	// vector length. Those attacker-controlled prefixes must be checked before
	// native decoding.
	const (
		commitmentsOffset = 0
		deltaOffset       = 2
		pkkLengthOffset   = deltaOffset + 48
	)
	cases := []struct {
		name string
		raw  func() []byte
	}{
		{
			name: "truncated",
			raw: func() []byte {
				return bytes.Clone(valid[:len(valid)/2])
			},
		},
		{
			name: "trailing byte",
			raw: func() []byte {
				return append(bytes.Clone(valid), 0xff)
			},
		},
		{
			name: "uncompressed delta",
			raw: func() []byte {
				out := bytes.Clone(valid)
				out[deltaOffset] &= 0x1f
				return out
			},
		},
		{
			name: "max commitment count",
			raw: func() []byte {
				out := bytes.Clone(valid)
				binary.BigEndian.PutUint16(out[commitmentsOffset:commitmentsOffset+2], math.MaxUint16)
				return out
			},
		},
		{
			name: "max PKK vector",
			raw: func() []byte {
				out := bytes.Clone(valid)
				binary.BigEndian.PutUint32(out[pkkLengthOffset:pkkLengthOffset+4], math.MaxUint32)
				return out
			},
		},
		{
			name: "wrong challenge length",
			raw: func() []byte {
				out := bytes.Clone(valid)
				out[len(out)-33] = 31
				return out
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "phase2.bin")
			adversarialWriteRaw(t, path, tc.raw())
			if _, _, err := ReadPhase2File(path, shape); err == nil {
				t.Fatal("malformed Phase 2 artifact unexpectedly accepted")
			}
		})
	}
}

func TestArtifactWritersNeverReplaceAndDoNotMutateInputs(t *testing.T) {
	phase1 := adversarialPhase1Contribution(t)
	phase1Before := adversarialSerialize(t, phase1)
	phase1Shape := Phase1Shape{DomainN: adversarialTinyDomain, ChallengeLength: 32}
	phase1Path := filepath.Join(t.TempDir(), "phase1.bin")
	if _, err := WritePhase1FileNoReplace(phase1Path, phase1, phase1Shape); err != nil {
		t.Fatalf("write Phase 1: %v", err)
	}
	publishedBefore, err := os.ReadFile(phase1Path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := WritePhase1FileNoReplace(phase1Path, phase1, phase1Shape); err == nil {
		t.Fatal("second Phase 1 write unexpectedly replaced destination")
	}
	publishedAfter, err := os.ReadFile(phase1Path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(publishedAfter, publishedBefore) {
		t.Fatal("existing Phase 1 destination changed after rejected replacement")
	}
	if got := adversarialSerialize(t, phase1); !bytes.Equal(got, phase1Before) {
		t.Fatal("Phase 1 input mutated by writer")
	}

	phase2, phase2Shape := adversarialPhase2Contribution(t)
	phase2Before := adversarialSerialize(t, phase2)
	phase2Path := filepath.Join(t.TempDir(), "phase2.bin")
	if _, err := WritePhase2FileNoReplace(phase2Path, phase2, phase2Shape); err != nil {
		t.Fatalf("write Phase 2: %v", err)
	}
	if _, err := WritePhase2FileNoReplace(phase2Path, phase2, phase2Shape); err == nil {
		t.Fatal("second Phase 2 write unexpectedly replaced destination")
	}
	if got := adversarialSerialize(t, phase2); !bytes.Equal(got, phase2Before) {
		t.Fatal("Phase 2 input mutated by writer")
	}
}

func TestReplayRejectsReorderedContributionsWithoutMutatingArchive(t *testing.T) {
	var phase1 []*gnarkmpc.Phase1
	for range 3 {
		next, err := ContributePhase1(adversarialTinyDomain, phase1)
		if err != nil {
			t.Fatalf("contribute Phase 1: %v", err)
		}
		phase1 = append(phase1, next)
	}
	archive := make([][]byte, len(phase1))
	for i := range phase1 {
		archive[i] = adversarialSerialize(t, phase1[i])
	}

	reordered := []*gnarkmpc.Phase1{phase1[0], phase1[2], phase1[1]}
	if err := ReplayPhase1(adversarialTinyDomain, reordered); err == nil {
		t.Fatal("reordered Phase 1 chain unexpectedly accepted")
	}
	for i := range phase1 {
		if got := adversarialSerialize(t, phase1[i]); !bytes.Equal(got, archive[i]) {
			t.Fatalf("archived Phase 1 contribution %d mutated during replay", i+1)
		}
	}
	if err := ReplayPhase1(adversarialTinyDomain*2, phase1); err == nil {
		t.Fatal("Phase 1 chain unexpectedly replayed under a different domain")
	}
	for _, size := range []int{0, 31, 33} {
		if _, err := SealPhase1(adversarialTinyDomain, bytes.Repeat([]byte{1}, size), phase1); err == nil {
			t.Fatalf("Phase 1 accepted a %d-byte beacon", size)
		}
	}
}

func TestFinalReplayAcceptsWorkflowNestedLogicalArtifactName(t *testing.T) {
	root := t.TempDir()
	logicalName := "phase1/contributions/0001/contribution.bin"
	path := filepath.Join(root, filepath.FromSlash(logicalName))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	payload := []byte("accepted workflow contribution")
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	expected := ArtifactRef{Name: logicalName, Digest: NewDigest(payload)}

	if err := requireArchivedArtifact(root, path, NewDigest(payload), expected); err != nil {
		t.Fatalf("workflow-produced nested artifact rejected by final replay: %v", err)
	}
}

func TestWorkflowArtifactReadRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	outsidePhase := filepath.Join(outside, "phase1")
	if err := os.Mkdir(outsidePhase, 0o700); err != nil {
		t.Fatal(err)
	}
	payload := []byte("outside transcript root")
	if err := os.WriteFile(filepath.Join(outsidePhase, "artifact.bin"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsidePhase, filepath.Join(root, "phase1")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	ref := ArtifactRef{
		Name:   "phase1/artifact.bin",
		Digest: NewDigest(payload),
	}
	if _, err := verifyArtifactBytes(root, ref, 1<<20); err == nil {
		t.Fatal("artifact reached through a symlink outside the transcript root was accepted")
	}
}

func TestSignedRecordPublicationFailureLeavesNoUnsignedRecord(t *testing.T) {
	root := t.TempDir()
	recordPath := filepath.Join(root, "record.json")
	signaturePath := filepath.Join(root, "missing", "record.sig")

	err := writeSignedRecordNoReplace(
		recordPath,
		signaturePath,
		adversarialAttestation(t),
		"participant-key-01",
		adversarialPrivateKey(0x71),
	)
	if err == nil {
		t.Fatal("signed-record publication unexpectedly succeeded without a signature directory")
	}
	if _, statErr := os.Lstat(recordPath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("failed publication left an unsigned record at %q: %v", recordPath, statErr)
	}
}
