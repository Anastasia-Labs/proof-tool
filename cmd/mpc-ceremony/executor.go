// Copyright 2026 Midgard Labs
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"proof-tool/internal/mpcceremony"
)

const proofToolVersion = "0.1.0"

type workflowExecutor struct{}

func (workflowExecutor) Execute(ctx context.Context, invocation Invocation) (CommandResult, error) {
	if err := ctx.Err(); err != nil {
		return CommandResult{}, err
	}
	switch invocation.Command {
	case CommandInit:
		return executeInit(invocation.Options.(InitOptions))
	case CommandPhase1Contribute:
		return executeContribution(mpcceremony.Phase1, invocation.Options.(ContributeOptions))
	case CommandPhase1Erasure:
		return executeErasure(mpcceremony.Phase1, invocation.Options.(ErasureOptions))
	case CommandPhase1Verify:
		return executeAccept(mpcceremony.Phase1, invocation.Options.(VerifyContributionOptions))
	case CommandPhase1Close:
		return executeClose(mpcceremony.Phase1, invocation.Options.(CloseOptions))
	case CommandPhase1Beacon:
		return executeBeacon(mpcceremony.Phase1, invocation.Options.(BeaconOptions))
	case CommandPhase1Seal:
		return executePhase1Seal(invocation.Options.(Phase1SealOptions))
	case CommandPhase2Init:
		return executePhase2Init(invocation.Options.(Phase2InitOptions))
	case CommandPhase2Contribute:
		return executeContribution(mpcceremony.Phase2, invocation.Options.(ContributeOptions))
	case CommandPhase2Erasure:
		return executeErasure(mpcceremony.Phase2, invocation.Options.(ErasureOptions))
	case CommandPhase2Verify:
		return executeAccept(mpcceremony.Phase2, invocation.Options.(VerifyContributionOptions))
	case CommandPhase2Close:
		return executeClose(mpcceremony.Phase2, invocation.Options.(CloseOptions))
	case CommandPhase2Beacon:
		return executeBeacon(mpcceremony.Phase2, invocation.Options.(BeaconOptions))
	case CommandFinalizePrepare:
		return executePrepareFinalization(invocation.Options.(PrepareFinalizationOptions))
	case CommandFinalizeComplete:
		return executeFinalize(invocation.Options.(FinalizeOptions))
	case CommandAudit:
		return executeAudit(invocation.Options.(AuditOptions))
	case CommandReleaseSign:
		return executeReleaseSign(invocation.Options.(ReleaseSignOptions))
	case CommandReleaseVerify:
		return executeReleaseVerify(invocation.Options.(ReleaseVerifyOptions))
	case CommandOpsExportSigning:
		return executeOpsExportSigning(invocation.Options.(OpsExportSigningOptions))
	case CommandOpsImportSig:
		return executeOpsImportSignature(invocation.Options.(OpsImportSignatureOptions))
	case CommandOpsVerify:
		return executeOpsVerify(invocation.Options.(OpsVerifyOptions))
	case CommandDecisionPrepare:
		return executeDecisionPrepare(invocation.Options.(DecisionPrepareOptions))
	case CommandDecisionSign:
		return executeDecisionSign(invocation.Options.(DecisionSignOptions))
	case CommandDecisionVerify:
		return executeDecisionVerify(invocation.Options.(DecisionVerifyOptions))
	default:
		return CommandResult{}, fmt.Errorf("%w: %s", errExecutorNotWired, invocation.Command)
	}
}

func executeInit(options InitOptions) (CommandResult, error) {
	participants, err := mpcceremony.LoadInitParticipants(options.ParticipantsPath)
	if err != nil {
		return CommandResult{}, err
	}
	policy, err := mpcceremony.LoadInitPolicy(options.PolicyPath)
	if err != nil {
		return CommandResult{}, err
	}
	if participants.Coordinator.KeyID != options.CoordinatorKeyID {
		return CommandResult{}, fmt.Errorf(
			"--coordinator-key-id %q does not match participants coordinator key id %q",
			options.CoordinatorKeyID,
			participants.Coordinator.KeyID,
		)
	}
	runningSoftware, err := mpcceremony.RunningSoftwareBindingForMode(proofToolVersion, options.Mode)
	if err != nil {
		return CommandResult{}, err
	}
	nonce, err := sessionNonce(options.SessionNonceHex)
	if err != nil {
		return CommandResult{}, err
	}
	circuit, err := mpcceremony.CompileDestinationV2()
	if err != nil {
		return CommandResult{}, err
	}
	result, err := mpcceremony.InitializeCeremonyFiles(mpcceremony.InitFilesOptions{
		RootDir: options.OutDir,
		Circuit: circuit,
		Definition: mpcceremony.DefinitionOptions{
			Mode:            options.Mode,
			CreatedAt:       options.CreatedAt,
			SessionNonceHex: nonce,
			Software:        runningSoftware,
			Coordinator:     participants.Coordinator,
			ReleaseSigner:   participants.ReleaseSigner,
			Auditors:        participants.Auditors,
			Roster:          participants.Roster,
			Phase1Policy:    policy.Phase1Policy,
			Phase2Policy:    policy.Phase2Policy,
			BeaconPolicy:    policy.BeaconPolicy,
		},
		CoordinatorPrivateKeyPath: options.CoordinatorSigningKey,
	})
	if err != nil {
		return CommandResult{}, err
	}
	return CommandResult{
		CeremonyID: result.Definition.CeremonyID,
		Summary:    "initialized signed MPC ceremony",
		Outputs: map[string]string{
			"ceremony":               result.DefinitionPath,
			"ceremony_signature":     result.DefinitionSignaturePath,
			"coordinator_public_key": result.CoordinatorPublicKeyPath,
			"r1cs":                   result.R1CSPath,
			"phase1_genesis":         result.Phase1GenesisPath,
			"phase1_chain":           result.Phase1ChainPath,
			"phase1_chain_signature": result.Phase1ChainSignaturePath,
		},
	}, nil
}

func executeContribution(phase mpcceremony.Phase, options ContributeOptions) (CommandResult, error) {
	trust := trustPaths(
		options.CeremonyPath,
		options.CeremonySignaturePath,
		options.CoordinatorPublicKeyFile,
	)
	if err := verifyRunningTrust(trust); err != nil {
		return CommandResult{}, err
	}
	circuit, err := loadOperationalCircuit(trust, options.TranscriptDir)
	if err != nil {
		return CommandResult{}, err
	}
	environment, err := mpcceremony.LoadContributionEnvironment(options.EnvironmentPath)
	if err != nil {
		return CommandResult{}, err
	}
	result, err := mpcceremony.CreateContributionCandidate(mpcceremony.ContributionFilesOptions{
		Trust:                     trust,
		Circuit:                   circuit,
		Phase:                     phase,
		Transcript:                transcriptPaths(options.TranscriptDir, options.ChainPath, options.ChainSignaturePath),
		Phase1SealPath:            options.Phase1SealPath,
		Phase1SealSignaturePath:   options.Phase1SealSignaturePath,
		ParticipantID:             options.ParticipantID,
		ParticipantPrivateKeyPath: options.ParticipantSigningKey,
		Environment:               environment,
		ContributedAt:             options.ContributedAt,
		CandidateDir:              options.OutDir,
	})
	if err != nil {
		return CommandResult{}, err
	}
	return CommandResult{
		CeremonyID: result.Attestation.CeremonyID,
		Phase:      string(phase),
		Sequence:   int(result.Attestation.Index),
		Summary:    fmt.Sprintf("created %s contribution candidate", phase),
		Outputs: map[string]string{
			"contribution":          result.OutputPayloadPath,
			"attestation":           result.AttestationPath,
			"attestation_signature": result.AttestationSignaturePath,
		},
	}, nil
}

func executeAccept(phase mpcceremony.Phase, options VerifyContributionOptions) (CommandResult, error) {
	trust := trustPaths(
		options.CeremonyPath,
		options.CeremonySignaturePath,
		options.CoordinatorPublicKeyFile,
	)
	if err := verifyRunningTrust(trust); err != nil {
		return CommandResult{}, err
	}
	circuit, err := loadOperationalCircuit(trust, options.TranscriptDir)
	if err != nil {
		return CommandResult{}, err
	}
	result, err := mpcceremony.VerifyAndAcceptContribution(mpcceremony.AcceptContributionFilesOptions{
		Trust:                     trust,
		Circuit:                   circuit,
		Phase:                     phase,
		Transcript:                transcriptPaths(options.TranscriptDir, options.ChainPath, options.ChainSignaturePath),
		Phase1SealPath:            options.Phase1SealPath,
		Phase1SealSignaturePath:   options.Phase1SealSignaturePath,
		CandidateDir:              options.CandidateDir,
		CoordinatorPrivateKeyPath: options.CoordinatorSigningKey,
		AcceptedAt:                options.AcceptedAt,
	})
	if err != nil {
		return CommandResult{}, err
	}
	return CommandResult{
		CeremonyID: result.Record.CeremonyID,
		Phase:      string(phase),
		Sequence:   int(result.Record.Index),
		Summary:    fmt.Sprintf("verified and accepted %s contribution", phase),
		Outputs: map[string]string{
			"accepted_contribution": result.AcceptedPayloadPath,
			"attestation":           result.AcceptedAttestationPath,
			"attestation_signature": result.AcceptedAttestationSignaturePath,
			"erasure":               result.AcceptedErasurePath,
			"erasure_signature":     result.AcceptedErasureSignaturePath,
			"verification":          result.VerificationPath,
			"chain":                 result.ChainPath,
			"chain_signature":       result.ChainSignaturePath,
		},
	}, nil
}

func executeErasure(phase mpcceremony.Phase, options ErasureOptions) (CommandResult, error) {
	trust := trustPaths(
		options.CeremonyPath,
		options.CeremonySignaturePath,
		options.CoordinatorPublicKeyFile,
	)
	if err := verifyRunningTrust(trust); err != nil {
		return CommandResult{}, err
	}
	result, err := mpcceremony.CreateErasureAttestationFiles(mpcceremony.CreateErasureAttestationFilesOptions{
		Trust:                     trust,
		ParticipantID:             options.ParticipantID,
		ParticipantPrivateKeyPath: options.ParticipantSigningKey,
		CandidateDir:              options.CandidateDir,
		DestroyedAt:               options.DestroyedAt,
	})
	if err != nil {
		return CommandResult{}, err
	}
	if result.Erasure.Phase != phase {
		return CommandResult{}, fmt.Errorf(
			"candidate phase is %q, but command is scoped to %q",
			result.Erasure.Phase,
			phase,
		)
	}
	return CommandResult{
		CeremonyID: result.Erasure.CeremonyID,
		Phase:      string(phase),
		Sequence:   int(result.Erasure.Index),
		Summary:    fmt.Sprintf("signed participant %s erasure attestation (not proof of erasure)", phase),
		Outputs: map[string]string{
			"erasure":           result.ErasurePath,
			"erasure_signature": result.SignaturePath,
		},
	}, nil
}

func executeClose(phase mpcceremony.Phase, options CloseOptions) (CommandResult, error) {
	trust := trustPaths(
		options.CeremonyPath,
		options.CeremonySignaturePath,
		options.CoordinatorPublicKeyFile,
	)
	if err := verifyRunningTrust(trust); err != nil {
		return CommandResult{}, err
	}
	circuit, err := loadOperationalCircuit(trust, options.TranscriptDir)
	if err != nil {
		return CommandResult{}, err
	}
	result, err := mpcceremony.ClosePhaseFiles(mpcceremony.ClosePhaseFilesOptions{
		Trust:                     trust,
		Circuit:                   circuit,
		Phase:                     phase,
		Transcript:                transcriptPaths(options.TranscriptDir, options.ChainPath, options.ChainSignaturePath),
		Phase1SealPath:            options.Phase1SealPath,
		Phase1SealSignaturePath:   options.Phase1SealSignaturePath,
		CoordinatorPrivateKeyPath: options.CoordinatorSigningKey,
		BeaconRound:               options.BeaconRound,
	})
	if err != nil {
		return CommandResult{}, err
	}
	return CommandResult{
		CeremonyID: result.Close.CeremonyID,
		Phase:      string(phase),
		Sequence:   int(result.Close.FinalIndex),
		ClosedAt:   result.Close.ClosedAt,
		Summary:    fmt.Sprintf("closed %s transcript", phase),
		Outputs: map[string]string{
			"closure":           result.ClosePath,
			"closure_signature": result.SignaturePath,
		},
	}, nil
}

func executeBeacon(phase mpcceremony.Phase, options BeaconOptions) (CommandResult, error) {
	trust := trustPaths(
		options.CeremonyPath,
		options.CeremonySignaturePath,
		options.CoordinatorPublicKeyFile,
	)
	if err := verifyRunningTrust(trust); err != nil {
		return CommandResult{}, err
	}
	result, err := mpcceremony.RecordBeaconFiles(mpcceremony.RecordBeaconFilesOptions{
		Trust:                     trust,
		TranscriptRoot:            options.TranscriptDir,
		Phase:                     phase,
		ClosePath:                 options.ClosurePath,
		CloseSignaturePath:        options.ClosureSignaturePath,
		RawResponsePath:           options.RawResponsePath,
		PublishedAt:               options.PublishedAt,
		CoordinatorPrivateKeyPath: options.CoordinatorSigningKey,
	})
	if err != nil {
		return CommandResult{}, err
	}
	return CommandResult{
		CeremonyID: result.Beacon.CeremonyID,
		Phase:      string(phase),
		Summary:    fmt.Sprintf("recorded signed %s beacon evidence", phase),
		Outputs: map[string]string{
			"raw_response":     result.RawResponsePath,
			"beacon":           result.BeaconPath,
			"beacon_signature": result.SignaturePath,
		},
	}, nil
}

func executePhase1Seal(options Phase1SealOptions) (CommandResult, error) {
	trust := trustPaths(
		options.CeremonyPath,
		options.CeremonySignaturePath,
		options.CoordinatorPublicKeyFile,
	)
	if err := verifyRunningTrust(trust); err != nil {
		return CommandResult{}, err
	}
	circuit, err := loadOperationalCircuit(trust, options.TranscriptDir)
	if err != nil {
		return CommandResult{}, err
	}
	result, err := mpcceremony.SealPhase1Files(mpcceremony.SealPhase1FilesOptions{
		Trust:                     trust,
		Circuit:                   circuit,
		TranscriptRoot:            options.TranscriptDir,
		ClosePath:                 options.ClosurePath,
		CloseSignaturePath:        options.ClosureSignaturePath,
		BeaconPath:                options.BeaconPath,
		BeaconSignaturePath:       options.BeaconSignaturePath,
		CoordinatorPrivateKeyPath: options.CoordinatorSigningKey,
		OutputDir:                 options.OutDir,
	})
	if err != nil {
		return CommandResult{}, err
	}
	return CommandResult{
		CeremonyID: result.Seal.CeremonyID,
		Phase:      string(mpcceremony.Phase1),
		Summary:    "sealed Phase 1 with signed beacon evidence",
		Outputs: map[string]string{
			"commons":        result.CommonsPath,
			"seal":           result.SealPath,
			"seal_signature": result.SignaturePath,
		},
	}, nil
}

func executePhase2Init(options Phase2InitOptions) (CommandResult, error) {
	trust := trustPaths(
		options.CeremonyPath,
		options.CeremonySignaturePath,
		options.CoordinatorPublicKeyFile,
	)
	if err := verifyRunningTrust(trust); err != nil {
		return CommandResult{}, err
	}
	circuit, err := loadOperationalCircuit(trust, options.Phase1TranscriptDir)
	if err != nil {
		return CommandResult{}, err
	}
	result, err := mpcceremony.InitializePhase2Files(mpcceremony.InitPhase2FilesOptions{
		Trust:                     trust,
		Circuit:                   circuit,
		TranscriptRoot:            options.Phase1TranscriptDir,
		Phase1SealPath:            options.Phase1SealPath,
		Phase1SealSignaturePath:   options.Phase1SealSignaturePath,
		CoordinatorPrivateKeyPath: options.CoordinatorSigningKey,
		OutputDir:                 options.OutDir,
	})
	if err != nil {
		return CommandResult{}, err
	}
	return CommandResult{
		CeremonyID: result.Chain.CeremonyID,
		Phase:      string(mpcceremony.Phase2),
		Summary:    "initialized circuit-specific Phase 2",
		Outputs: map[string]string{
			"phase2_genesis":         result.GenesisPath,
			"phase2_chain":           result.ChainPath,
			"phase2_chain_signature": result.ChainSignaturePath,
		},
	}, nil
}

func executeFinalize(options FinalizeOptions) (CommandResult, error) {
	trust := trustPaths(
		options.CeremonyPath,
		options.CeremonySignaturePath,
		options.CoordinatorPublicKeyFile,
	)
	if err := verifyRunningTrust(trust); err != nil {
		return CommandResult{}, err
	}
	replay, err := replayPaths(trust, options.Replay)
	if err != nil {
		return CommandResult{}, err
	}
	circuit, err := mpcceremony.CompileDestinationV2()
	if err != nil {
		return CommandResult{}, err
	}
	finalizedAt, err := parseUTCTime("--finalized-at", options.FinalizedAt)
	if err != nil {
		return CommandResult{}, err
	}
	result, err := mpcceremony.Finalize(mpcceremony.FinalizeOptions{
		Replay:                replay,
		Circuit:               circuit,
		OutDir:                options.OutDir,
		CoordinatorSigningKey: options.CoordinatorSigningKey,
		PublicEvidencePath:    options.PublicEvidencePath,
		FinalizedAt:           finalizedAt,
	})
	if err != nil {
		return CommandResult{}, err
	}
	return CommandResult{
		CeremonyID: result.CeremonyID,
		Summary:    "independently replayed both phases and created an unsigned release candidate",
		Outputs: map[string]string{
			"candidate_dir":       result.OutDir,
			"candidate":           result.CandidatePath,
			"candidate_signature": result.CandidateSigPath,
			"verification_report": result.VerificationPath,
			"proving_key":         result.ProvingKeyPath,
			"verifying_key":       result.VerifyingKeyPath,
			"constraint_system":   result.ConstraintSystem,
			"cardano_vk":          result.CardanoVKPath,
			"checksums":           result.CandidateChecksum,
		},
	}, nil
}

func executePrepareFinalization(options PrepareFinalizationOptions) (CommandResult, error) {
	trust := trustPaths(
		options.CeremonyPath,
		options.CeremonySignaturePath,
		options.CoordinatorPublicKeyFile,
	)
	if err := verifyRunningTrust(trust); err != nil {
		return CommandResult{}, err
	}
	replay, err := replayPaths(trust, options.Replay)
	if err != nil {
		return CommandResult{}, err
	}
	circuit, err := mpcceremony.CompileDestinationV2()
	if err != nil {
		return CommandResult{}, err
	}
	preparedAt, err := parseUTCTime("--prepared-at", options.PreparedAt)
	if err != nil {
		return CommandResult{}, err
	}
	result, err := mpcceremony.PrepareFinalization(mpcceremony.PrepareFinalizationOptions{
		Replay:                replay,
		Circuit:               circuit,
		OutDir:                options.OutDir,
		CoordinatorSigningKey: options.CoordinatorSigningKey,
		PreparedAt:            preparedAt,
	})
	if err != nil {
		return CommandResult{}, err
	}
	return CommandResult{
		Summary: "independently replayed both phases and published preliminary final keys for external public-proof generation",
		Outputs: map[string]string{
			"preliminary_dir":       result.OutDir,
			"preliminary_metadata":  result.MetadataPath,
			"preliminary_signature": result.SignaturePath,
			"proving_key":           result.ProvingKeyPath,
			"verifying_key":         result.VerifyingKeyPath,
			"cardano_vk":            result.CardanoVKPath,
			"checksums":             result.ChecksumsPath,
		},
	}, nil
}

func executeAudit(options AuditOptions) (CommandResult, error) {
	trust := trustPaths(
		options.CeremonyPath,
		options.CeremonySignaturePath,
		options.CoordinatorPublicKeyFile,
	)
	if err := verifyRunningTrust(trust); err != nil {
		return CommandResult{}, err
	}
	replay, err := replayPaths(trust, options.Replay)
	if err != nil {
		return CommandResult{}, err
	}
	circuit, err := mpcceremony.CompileDestinationV2()
	if err != nil {
		return CommandResult{}, err
	}
	auditedAt, err := parseUTCTime("--audited-at", options.AuditedAt)
	if err != nil {
		return CommandResult{}, err
	}
	result, err := mpcceremony.Audit(mpcceremony.AuditOptions{
		Replay:            replay,
		Circuit:           circuit,
		CandidateDir:      options.CandidateBundleDir,
		AuditorID:         options.AuditorID,
		AuditorSigningKey: options.AuditorSigningKey,
		OutPath:           options.OutPath,
		SignatureOutPath:  options.SignatureOutPath,
		AuditedAt:         auditedAt,
	})
	if err != nil {
		return CommandResult{}, err
	}
	return CommandResult{
		CeremonyID: result.Record.CeremonyID,
		Summary:    "independently replayed the ceremony and wrote a signed passing audit",
		Outputs: map[string]string{
			"audit":           result.RecordPath,
			"audit_signature": result.SignaturePath,
		},
	}, nil
}

func executeReleaseSign(options ReleaseSignOptions) (CommandResult, error) {
	trust := trustPaths(
		options.CeremonyPath,
		options.CeremonySignaturePath,
		options.CoordinatorPublicKeyFile,
	)
	if err := verifyRunningTrust(trust); err != nil {
		return CommandResult{}, err
	}
	coordinatorPublicKey, err := readPublicKeyHex(options.CoordinatorPublicKeyFile)
	if err != nil {
		return CommandResult{}, err
	}
	releasedAt, err := parseUTCTime("--released-at", options.ReleasedAt)
	if err != nil {
		return CommandResult{}, err
	}
	result, err := mpcceremony.SignRelease(mpcceremony.SignReleaseOptions{
		DefinitionPath:           options.CeremonyPath,
		DefinitionSignaturePath:  options.CeremonySignaturePath,
		CoordinatorPublicKeyHex:  coordinatorPublicKey,
		CandidateDir:             options.CandidateBundleDir,
		ReleaseDir:               options.ReleaseDir,
		Audits:                   auditArtifacts(options.AuditReportPaths, options.AuditSignaturePaths),
		OperationalEvidenceRoot:  options.OperationalEvidenceRoot,
		OperationalBundlePath:    options.OperationalBundlePath,
		OperationalSignaturePath: options.OperationalSignaturePath,
		ReleaseSigningKey:        options.ReleaseSigningKey,
		SignatureKeyID:           options.SignatureKeyID,
		ReleasedAt:               releasedAt,
	})
	if err != nil {
		return CommandResult{}, err
	}
	return CommandResult{
		Summary: "published a fresh release bundle after verifying audits, public-witness quorums, and multi-relay beacon evidence",
		Outputs: map[string]string{
			"release_dir":          options.ReleaseDir,
			"manifest":             result.ManifestPath,
			"manifest_signature":   result.ManifestSignature,
			"manifest_public_key":  result.ManifestPublicKey,
			"setup_transcript":     result.FinalTranscript,
			"operational_evidence": result.OperationalEvidence,
			"checksums":            result.ChecksumsPath,
		},
	}, nil
}

func executeReleaseVerify(options ReleaseVerifyOptions) (CommandResult, error) {
	trust := trustPaths(
		options.CeremonyPath,
		options.CeremonySignaturePath,
		options.CoordinatorPublicKeyFile,
	)
	if err := verifyRunningTrust(trust); err != nil {
		return CommandResult{}, err
	}
	coordinatorPublicKey, err := readPublicKeyHex(options.CoordinatorPublicKeyFile)
	if err != nil {
		return CommandResult{}, err
	}
	releasePublicKey, err := readPublicKeyHex(options.ManifestPublicKeyFile)
	if err != nil {
		return CommandResult{}, err
	}
	result, err := mpcceremony.VerifyRelease(mpcceremony.VerifyReleaseOptions{
		DefinitionPath:          options.CeremonyPath,
		DefinitionSignaturePath: options.CeremonySignaturePath,
		CoordinatorPublicKeyHex: coordinatorPublicKey,
		KeysDir:                 options.KeysDir,
		TrustedPublicKeyHex:     releasePublicKey,
		ExpectedSignatureKeyID:  options.SignatureKeyID,
		RequireProvingKey:       true,
	})
	if err != nil {
		return CommandResult{}, err
	}
	return CommandResult{
		CeremonyID: result.Transcript.CeremonyID,
		Summary:    "verified the release signature, bundled audits, native keys, Cardano export, and ceremony coherence",
		Outputs: map[string]string{
			"keys_dir": options.KeysDir,
		},
	}, nil
}

func sessionNonce(value string) (string, error) {
	if value != "" {
		return value, nil
	}
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("generate session nonce: %w", err)
	}
	return hex.EncodeToString(nonce), nil
}

func trustPaths(definition, signature, publicKey string) mpcceremony.TrustPaths {
	return mpcceremony.TrustPaths{
		DefinitionPath:           definition,
		DefinitionSignaturePath:  signature,
		CoordinatorPublicKeyPath: publicKey,
	}
}

func transcriptPaths(root, chain, signature string) mpcceremony.PhaseTranscriptPaths {
	return mpcceremony.PhaseTranscriptPaths{
		RootDir:            root,
		ChainPath:          chain,
		ChainSignaturePath: signature,
	}
}

func replayPaths(trust mpcceremony.TrustPaths, replay ReplayOptions) (mpcceremony.ReplayPaths, error) {
	coordinatorPublicKey, err := readPublicKeyHex(trust.CoordinatorPublicKeyPath)
	if err != nil {
		return mpcceremony.ReplayPaths{}, err
	}
	return mpcceremony.ReplayPaths{
		TranscriptRoot:            replay.TranscriptRoot,
		CoordinatorPublicKeyHex:   coordinatorPublicKey,
		DefinitionPath:            trust.DefinitionPath,
		DefinitionSignaturePath:   trust.DefinitionSignaturePath,
		Phase1ChainPath:           replay.Phase1ChainPath,
		Phase1ChainSignaturePath:  replay.Phase1ChainSignaturePath,
		Phase1ClosePath:           replay.Phase1ClosePath,
		Phase1CloseSignaturePath:  replay.Phase1CloseSignaturePath,
		Phase1BeaconPath:          replay.Phase1BeaconPath,
		Phase1BeaconSignaturePath: replay.Phase1BeaconSignaturePath,
		Phase1SealPath:            replay.Phase1SealPath,
		Phase1SealSignaturePath:   replay.Phase1SealSignaturePath,
		Phase2ChainPath:           replay.Phase2ChainPath,
		Phase2ChainSignaturePath:  replay.Phase2ChainSignaturePath,
		Phase2ClosePath:           replay.Phase2ClosePath,
		Phase2CloseSignaturePath:  replay.Phase2CloseSignaturePath,
		Phase2BeaconPath:          replay.Phase2BeaconPath,
		Phase2BeaconSignaturePath: replay.Phase2BeaconSignaturePath,
	}, nil
}

func auditArtifacts(records, signatures []string) []mpcceremony.AuditArtifact {
	result := make([]mpcceremony.AuditArtifact, len(records))
	for index := range records {
		result[index] = mpcceremony.AuditArtifact{
			RecordPath:    records[index],
			SignaturePath: signatures[index],
		}
	}
	return result
}

func parseUTCTime(flagName, value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("%s must be an RFC3339 timestamp: %w", flagName, err)
	}
	if parsed.IsZero() || parsed.Location() != time.UTC {
		return time.Time{}, fmt.Errorf("%s must use UTC with a Z suffix", flagName)
	}
	return parsed, nil
}

func readPublicKeyHex(path string) (string, error) {
	linkInfo, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if linkInfo.Mode()&fs.ModeSymlink != 0 || !linkInfo.Mode().IsRegular() {
		return "", fmt.Errorf("trusted public key %q must be a regular file, not a symlink", path)
	}
	if linkInfo.Size() <= 0 || linkInfo.Size() > 4096 {
		return "", fmt.Errorf("trusted public key %q size %d is outside [1,4096]", path, linkInfo.Size())
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() ||
		!os.SameFile(linkInfo, info) ||
		info.Size() != linkInfo.Size() {
		return "", fmt.Errorf("trusted public key %q changed while being opened", path)
	}
	raw := make([]byte, info.Size())
	if _, err := io.ReadFull(file, raw); err != nil {
		return "", err
	}
	var extra [1]byte
	if n, err := file.Read(extra[:]); n != 0 || (err != nil && !errors.Is(err, io.EOF)) {
		return "", fmt.Errorf("trusted public key %q changed while being read", path)
	}
	value := strings.TrimSpace(string(raw))
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != ed25519.PublicKeySize {
		return "", fmt.Errorf("trusted public key %q must contain exactly %d bytes of hex", path, ed25519.PublicKeySize)
	}
	return strings.ToLower(value), nil
}

func verifyRunningTrust(paths mpcceremony.TrustPaths) error {
	trusted, err := mpcceremony.LoadSignedDefinition(paths)
	if err != nil {
		return err
	}
	return mpcceremony.VerifyRunningSoftwareForMode(
		trusted.Definition.Software,
		trusted.Definition.Mode,
	)
}

func loadOperationalCircuit(paths mpcceremony.TrustPaths, transcriptRoot string) (*mpcceremony.CompiledCircuit, error) {
	trusted, err := mpcceremony.LoadSignedDefinition(paths)
	if err != nil {
		return nil, err
	}
	if err := mpcceremony.VerifyRunningSoftwareForMode(
		trusted.Definition.Software,
		trusted.Definition.Mode,
	); err != nil {
		return nil, err
	}
	r1csPath := filepath.Join(transcriptRoot, filepath.FromSlash(trusted.Definition.Circuit.R1CS.Name))
	return mpcceremony.ReadR1CSFile(r1csPath, trusted.Definition.Circuit)
}
