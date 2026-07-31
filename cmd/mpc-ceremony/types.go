// Copyright 2026 Midgard Labs
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
)

const commandResultSchema = "proof-tool-mpc-command-result-v1"

type Command string

const (
	CommandInit             Command = "init"
	CommandPhase1Contribute Command = "phase1 contribute"
	CommandPhase1Erasure    Command = "phase1 attest-erasure"
	CommandPhase1Verify     Command = "phase1 verify"
	CommandPhase1Close      Command = "phase1 close"
	CommandPhase1Beacon     Command = "phase1 beacon"
	CommandPhase1Seal       Command = "phase1 seal"
	CommandPhase2Init       Command = "phase2 init"
	CommandPhase2Contribute Command = "phase2 contribute"
	CommandPhase2Erasure    Command = "phase2 attest-erasure"
	CommandPhase2Verify     Command = "phase2 verify"
	CommandPhase2Close      Command = "phase2 close"
	CommandPhase2Beacon     Command = "phase2 beacon"
	CommandFinalizePrepare  Command = "finalize prepare"
	CommandFinalizeComplete Command = "finalize complete"
	CommandAudit            Command = "audit"
	CommandReleaseSign      Command = "release sign"
	CommandReleaseVerify    Command = "release verify"
	CommandOpsExportSigning Command = "ops export-signing"
	CommandOpsImportSig     Command = "ops import-signature"
	CommandOpsVerify        Command = "ops verify"
	CommandDecisionPrepare  Command = "decision prepare"
	CommandDecisionSign     Command = "decision sign"
	CommandDecisionVerify   Command = "decision verify"
)

type GlobalOptions struct {
	Format string
	Quiet  bool
}

type Invocation struct {
	Global  GlobalOptions
	Command Command
	Options any
}

type InitOptions struct {
	SessionNonceHex       string
	CreatedAt             string
	KeyVersion            string
	ParticipantsPath      string
	PolicyPath            string
	CoordinatorKeyID      string
	CoordinatorSigningKey string
	OutDir                string
	Mode                  string
}

type ContributeOptions struct {
	CeremonyPath             string
	CeremonySignaturePath    string
	CoordinatorPublicKeyFile string
	Phase1SealPath           string
	Phase1SealSignaturePath  string
	TranscriptDir            string
	ChainPath                string
	ChainSignaturePath       string
	ParticipantID            string
	ParticipantSigningKey    string
	EnvironmentPath          string
	ContributedAt            string
	OutDir                   string
}

type VerifyContributionOptions struct {
	CeremonyPath             string
	CeremonySignaturePath    string
	CoordinatorPublicKeyFile string
	Phase1SealPath           string
	Phase1SealSignaturePath  string
	TranscriptDir            string
	ChainPath                string
	ChainSignaturePath       string
	CandidateDir             string
	CoordinatorSigningKey    string
	AcceptedAt               string
}

type ErasureOptions struct {
	CeremonyPath             string
	CeremonySignaturePath    string
	CoordinatorPublicKeyFile string
	ParticipantID            string
	ParticipantSigningKey    string
	CandidateDir             string
	DestroyedAt              string
}

type CloseOptions struct {
	CeremonyPath             string
	CeremonySignaturePath    string
	CoordinatorPublicKeyFile string
	Phase1SealPath           string
	Phase1SealSignaturePath  string
	TranscriptDir            string
	ChainPath                string
	ChainSignaturePath       string
	CoordinatorSigningKey    string
	BeaconRound              uint64
}

type Phase1SealOptions struct {
	CeremonyPath             string
	CeremonySignaturePath    string
	CoordinatorPublicKeyFile string
	TranscriptDir            string
	ClosurePath              string
	ClosureSignaturePath     string
	BeaconPath               string
	BeaconSignaturePath      string
	CoordinatorSigningKey    string
	OutDir                   string
}

type BeaconOptions struct {
	CeremonyPath             string
	CeremonySignaturePath    string
	CoordinatorPublicKeyFile string
	ClosurePath              string
	ClosureSignaturePath     string
	RawResponsePath          string
	PublishedAt              string
	CoordinatorSigningKey    string
	TranscriptDir            string
}

type Phase2InitOptions struct {
	CeremonyPath             string
	CeremonySignaturePath    string
	CoordinatorPublicKeyFile string
	Phase1TranscriptDir      string
	Phase1SealPath           string
	Phase1SealSignaturePath  string
	CoordinatorSigningKey    string
	OutDir                   string
}

type FinalizeOptions struct {
	CeremonyPath             string
	CeremonySignaturePath    string
	CoordinatorPublicKeyFile string
	Replay                   ReplayOptions
	CoordinatorSigningKey    string
	PublicEvidencePath       string
	FinalizedAt              string
	OutDir                   string
}

type PrepareFinalizationOptions struct {
	CeremonyPath             string
	CeremonySignaturePath    string
	CoordinatorPublicKeyFile string
	Replay                   ReplayOptions
	CoordinatorSigningKey    string
	PreparedAt               string
	OutDir                   string
}

type AuditOptions struct {
	CeremonyPath             string
	CeremonySignaturePath    string
	CoordinatorPublicKeyFile string
	Replay                   ReplayOptions
	CandidateBundleDir       string
	AuditorID                string
	AuditorSigningKey        string
	AuditedAt                string
	OutPath                  string
	SignatureOutPath         string
}

type ReleaseSignOptions struct {
	CeremonyPath             string
	CeremonySignaturePath    string
	CoordinatorPublicKeyFile string
	CandidateBundleDir       string
	AuditReportPaths         []string
	AuditSignaturePaths      []string
	OperationalEvidenceRoot  string
	OperationalBundlePath    string
	OperationalSignaturePath string
	ReleaseSigningKey        string
	SignatureKeyID           string
	ReleasedAt               string
	ReleaseDir               string
}

type ReleaseVerifyOptions struct {
	CeremonyPath             string
	CeremonySignaturePath    string
	CoordinatorPublicKeyFile string
	KeysDir                  string
	ManifestPublicKeyFile    string
	SignatureKeyID           string
}

type OpsExportSigningOptions struct {
	RecordType               string
	RecordPath               string
	CeremonyPath             string
	CeremonySignaturePath    string
	CoordinatorPublicKeyFile string
	OutDir                   string
}

type OpsImportSignatureOptions struct {
	RecordType               string
	CanonicalPath            string
	CeremonyPath             string
	CeremonySignaturePath    string
	CoordinatorPublicKeyFile string
	SignerPublicKeyFile      string
	RawSignaturePath         string
	OutPath                  string
}

type OpsVerifyOptions struct {
	RecordType               string
	RecordPath               string
	SignaturePath            string
	CeremonyPath             string
	CeremonySignaturePath    string
	CoordinatorPublicKeyFile string
	SignerPublicKeyFile      string
	RelatedRecordPath        string
	EvidenceRoot             string
}

type DecisionSignOptions struct {
	CeremonyPath             string
	CeremonySignaturePath    string
	CoordinatorPublicKeyFile string
	DecisionPath             string
	EvidenceRoot             string
	Role                     string
	SignerID                 string
	SigningKey               string
	OutPath                  string
}

type DecisionPrepareOptions struct {
	CeremonyPath             string
	CeremonySignaturePath    string
	CoordinatorPublicKeyFile string
	DraftPath                string
	OutPath                  string
}

type DecisionVerifyOptions struct {
	CeremonyPath             string
	CeremonySignaturePath    string
	CoordinatorPublicKeyFile string
	DecisionPath             string
	SignaturePaths           []string
	EvidenceRoot             string
}

type ReplayOptions struct {
	TranscriptRoot            string
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

type CommandResult struct {
	Schema                     string            `json:"schema"`
	OK                         bool              `json:"ok"`
	Command                    Command           `json:"command"`
	CeremonyID                 string            `json:"ceremony_id,omitempty"`
	Phase                      string            `json:"phase,omitempty"`
	Sequence                   int               `json:"sequence,omitempty"`
	ClosedAt                   string            `json:"closed_at,omitempty"`
	Decision                   string            `json:"decision,omitempty"`
	DecisionID                 string            `json:"decision_id,omitempty"`
	ReleaseID                  string            `json:"release_id,omitempty"`
	CandidateID                string            `json:"candidate_id,omitempty"`
	SourceCommit               string            `json:"source_commit,omitempty"`
	SourceSignedTag            string            `json:"source_signed_tag,omitempty"`
	SourceTagSignerFingerprint string            `json:"source_tag_signer_fingerprint,omitempty"`
	SourceTagObjectSHA256      string            `json:"source_tag_object_sha256,omitempty"`
	Outputs                    map[string]string `json:"outputs,omitempty"`
	Summary                    string            `json:"summary,omitempty"`
}

type Executor interface {
	Execute(context.Context, Invocation) (CommandResult, error)
}

type executorFunc func(context.Context, Invocation) (CommandResult, error)

func (f executorFunc) Execute(ctx context.Context, invocation Invocation) (CommandResult, error) {
	return f(ctx, invocation)
}

var errExecutorNotWired = errors.New("MPC ceremony operation engine is not wired")

type unwiredExecutor struct{}

func (unwiredExecutor) Execute(context.Context, Invocation) (CommandResult, error) {
	return CommandResult{}, errExecutorNotWired
}
