// Copyright 2026 Midgard Labs
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"

	"proof-tool/internal/mpcceremony"
)

const supportedKeyVersion = "ownership-destination-v2"

type helpRequest struct {
	topic []string
}

func (h *helpRequest) Error() string { return "help requested" }

type usageError struct {
	message string
	topic   []string
}

func (e *usageError) Error() string { return e.message }

func parseInvocation(args []string) (Invocation, error) {
	global := flag.NewFlagSet("mpc-ceremony", flag.ContinueOnError)
	global.SetOutput(io.Discard)
	format := global.String("format", "human", "output format: human or json")
	quiet := global.Bool("quiet", false, "suppress progress output")
	showHelp := global.Bool("help", false, "show help")
	if err := global.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return Invocation{}, &helpRequest{}
		}
		return Invocation{}, &usageError{message: err.Error()}
	}
	if *format != "human" && *format != "json" {
		return Invocation{}, &usageError{message: "--format must be human or json"}
	}
	rest := global.Args()
	if *showHelp {
		return Invocation{}, &helpRequest{topic: rest}
	}
	if len(rest) == 0 {
		return Invocation{}, &usageError{message: "missing command"}
	}
	if rest[0] == "help" {
		return Invocation{}, &helpRequest{topic: rest[1:]}
	}

	invocation := Invocation{Global: GlobalOptions{Format: *format, Quiet: *quiet}}
	switch rest[0] {
	case "init":
		options, err := parseInit(rest[1:])
		invocation.Command, invocation.Options = CommandInit, options
		return invocation, wrapCommandError(err, "init")
	case "phase1":
		return parsePhase1(invocation, rest[1:])
	case "phase2":
		return parsePhase2(invocation, rest[1:])
	case "finalize":
		return parseFinalize(invocation, rest[1:])
	case "audit":
		options, err := parseAudit(rest[1:])
		invocation.Command, invocation.Options = CommandAudit, options
		return invocation, wrapCommandError(err, "audit")
	case "release":
		return parseRelease(invocation, rest[1:])
	case "ops":
		return parseOps(invocation, rest[1:])
	case "decision":
		return parseDecision(invocation, rest[1:])
	default:
		return Invocation{}, &usageError{
			message: fmt.Sprintf("unknown command %q", rest[0]),
		}
	}
}

func parseDecision(invocation Invocation, args []string) (Invocation, error) {
	if len(args) == 0 {
		return Invocation{}, &usageError{message: "missing decision command", topic: []string{"decision"}}
	}
	if args[0] == "help" {
		return Invocation{}, &helpRequest{topic: append([]string{"decision"}, args[1:]...)}
	}
	switch args[0] {
	case "prepare":
		options, err := parseDecisionPrepare(args[1:])
		invocation.Command, invocation.Options = CommandDecisionPrepare, options
		return invocation, wrapCommandError(err, "decision", "prepare")
	case "sign":
		options, err := parseDecisionSign(args[1:])
		invocation.Command, invocation.Options = CommandDecisionSign, options
		return invocation, wrapCommandError(err, "decision", "sign")
	case "verify":
		options, err := parseDecisionVerify(args[1:])
		invocation.Command, invocation.Options = CommandDecisionVerify, options
		return invocation, wrapCommandError(err, "decision", "verify")
	default:
		return Invocation{}, &usageError{
			message: fmt.Sprintf("unknown decision command %q", args[0]),
			topic:   []string{"decision"},
		}
	}
}

func parseDecisionPrepare(args []string) (DecisionPrepareOptions, error) {
	var options DecisionPrepareOptions
	fs := commandFlagSet("decision prepare")
	addCeremonyTrustFlags(
		fs,
		&options.CeremonyPath,
		&options.CeremonySignaturePath,
		&options.CoordinatorPublicKeyFile,
	)
	fs.StringVar(&options.DraftPath, "draft", "", "canonical production-decision draft JSON")
	fs.StringVar(&options.OutPath, "out", "", "fresh canonical content-addressed decision output")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	return options, requireValues(
		pathValue("--ceremony", options.CeremonyPath),
		pathValue("--ceremony-signature", options.CeremonySignaturePath),
		pathValue("--coordinator-public-key-file", options.CoordinatorPublicKeyFile),
		pathValue("--draft", options.DraftPath),
		pathValue("--out", options.OutPath),
	)
}

func parseDecisionSign(args []string) (DecisionSignOptions, error) {
	var options DecisionSignOptions
	fs := commandFlagSet("decision sign")
	addCeremonyTrustFlags(fs, &options.CeremonyPath, &options.CeremonySignaturePath, &options.CoordinatorPublicKeyFile)
	fs.StringVar(&options.DecisionPath, "decision", "", "canonical production GO/NO-GO decision JSON")
	fs.StringVar(&options.EvidenceRoot, "evidence-root", "", "local root containing every artifact pinned by a GO decision")
	fs.StringVar(&options.Role, "role", "", "signer role: coordinator, auditor, or release_signer")
	fs.StringVar(&options.SignerID, "signer-id", "", "exact signer identity from the ceremony decision")
	fs.StringVar(&options.SigningKey, "signing-key", "", "existing Ed25519 decision signer private key path")
	fs.StringVar(&options.OutPath, "out", "", "fresh canonical detached decision-signature output")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	switch options.Role {
	case string(mpcceremony.DecisionSignerCoordinator),
		string(mpcceremony.DecisionSignerAuditor),
		string(mpcceremony.DecisionSignerRelease):
	default:
		return options, errors.New("--role must be coordinator, auditor, or release_signer")
	}
	if options.EvidenceRoot != "" {
		if err := validatePathValue("--evidence-root", options.EvidenceRoot); err != nil {
			return options, err
		}
	}
	return options, requireValues(
		pathValue("--ceremony", options.CeremonyPath),
		pathValue("--ceremony-signature", options.CeremonySignaturePath),
		pathValue("--coordinator-public-key-file", options.CoordinatorPublicKeyFile),
		pathValue("--decision", options.DecisionPath),
		value("--role", options.Role),
		value("--signer-id", options.SignerID),
		pathValue("--signing-key", options.SigningKey),
		pathValue("--out", options.OutPath),
	)
}

func parseDecisionVerify(args []string) (DecisionVerifyOptions, error) {
	var options DecisionVerifyOptions
	var signatures stringList
	fs := commandFlagSet("decision verify")
	addCeremonyTrustFlags(fs, &options.CeremonyPath, &options.CeremonySignaturePath, &options.CoordinatorPublicKeyFile)
	fs.StringVar(&options.DecisionPath, "decision", "", "canonical production GO/NO-GO decision JSON")
	fs.Var(&signatures, "signature", "canonical decision-signature path; repeat once per signer")
	fs.StringVar(&options.EvidenceRoot, "evidence-root", "", "local root containing every artifact pinned by the decision")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	options.SignaturePaths = append([]string(nil), signatures...)
	if err := requireValues(
		pathValue("--ceremony", options.CeremonyPath),
		pathValue("--ceremony-signature", options.CeremonySignaturePath),
		pathValue("--coordinator-public-key-file", options.CoordinatorPublicKeyFile),
		pathValue("--decision", options.DecisionPath),
		pathValue("--evidence-root", options.EvidenceRoot),
	); err != nil {
		return options, err
	}
	if len(options.SignaturePaths) == 0 {
		return options, errors.New("--signature must be supplied at least once")
	}
	for _, signature := range options.SignaturePaths {
		if err := validatePathValue("--signature", signature); err != nil {
			return options, err
		}
	}
	return options, nil
}

func parseOps(invocation Invocation, args []string) (Invocation, error) {
	if len(args) == 0 {
		return Invocation{}, &usageError{message: "missing ops command", topic: []string{"ops"}}
	}
	if args[0] == "help" {
		return Invocation{}, &helpRequest{topic: append([]string{"ops"}, args[1:]...)}
	}
	switch args[0] {
	case "export-signing":
		options, err := parseOpsExportSigning(args[1:])
		invocation.Command, invocation.Options = CommandOpsExportSigning, options
		return invocation, wrapCommandError(err, "ops", "export-signing")
	case "import-signature":
		options, err := parseOpsImportSignature(args[1:])
		invocation.Command, invocation.Options = CommandOpsImportSig, options
		return invocation, wrapCommandError(err, "ops", "import-signature")
	case "verify":
		options, err := parseOpsVerify(args[1:])
		invocation.Command, invocation.Options = CommandOpsVerify, options
		return invocation, wrapCommandError(err, "ops", "verify")
	default:
		return Invocation{}, &usageError{
			message: fmt.Sprintf("unknown ops command %q", args[0]),
			topic:   []string{"ops"},
		}
	}
}

func parseOpsExportSigning(args []string) (OpsExportSigningOptions, error) {
	var options OpsExportSigningOptions
	fs := commandFlagSet("ops export-signing")
	addOpsRecordFlags(fs, &options.RecordType, &options.RecordPath)
	addCeremonyTrustFlags(fs, &options.CeremonyPath, &options.CeremonySignaturePath, &options.CoordinatorPublicKeyFile)
	fs.StringVar(&options.OutDir, "out-dir", "", "fresh directory for canonical record and signing request")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	return options, requireValues(
		value("--record-type", options.RecordType),
		pathValue("--record", options.RecordPath),
		pathValue("--ceremony", options.CeremonyPath),
		pathValue("--ceremony-signature", options.CeremonySignaturePath),
		pathValue("--coordinator-public-key-file", options.CoordinatorPublicKeyFile),
		pathValue("--out-dir", options.OutDir),
	)
}

func parseOpsImportSignature(args []string) (OpsImportSignatureOptions, error) {
	var options OpsImportSignatureOptions
	fs := commandFlagSet("ops import-signature")
	fs.StringVar(&options.RecordType, "record-type", "", "operational record type")
	fs.StringVar(&options.CanonicalPath, "canonical", "", "exact canonical record bytes exported for offline signing")
	addCeremonyTrustFlags(fs, &options.CeremonyPath, &options.CeremonySignaturePath, &options.CoordinatorPublicKeyFile)
	fs.StringVar(&options.SignerPublicKeyFile, "signer-public-key-file", "", "out-of-band trusted Ed25519 signer public key")
	fs.StringVar(&options.RawSignaturePath, "raw-signature", "", "64 raw bytes or 128 lowercase hex characters from offline signer")
	fs.StringVar(&options.OutPath, "out", "", "fresh detached signature output")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	return options, requireValues(
		value("--record-type", options.RecordType),
		pathValue("--canonical", options.CanonicalPath),
		pathValue("--ceremony", options.CeremonyPath),
		pathValue("--ceremony-signature", options.CeremonySignaturePath),
		pathValue("--coordinator-public-key-file", options.CoordinatorPublicKeyFile),
		pathValue("--signer-public-key-file", options.SignerPublicKeyFile),
		pathValue("--raw-signature", options.RawSignaturePath),
		pathValue("--out", options.OutPath),
	)
}

func parseOpsVerify(args []string) (OpsVerifyOptions, error) {
	var options OpsVerifyOptions
	fs := commandFlagSet("ops verify")
	addOpsRecordFlags(fs, &options.RecordType, &options.RecordPath)
	addCeremonyTrustFlags(fs, &options.CeremonyPath, &options.CeremonySignaturePath, &options.CoordinatorPublicKeyFile)
	fs.StringVar(&options.SignaturePath, "signature", "", "detached operational record signature")
	fs.StringVar(&options.SignerPublicKeyFile, "signer-public-key-file", "", "out-of-band trusted Ed25519 signer public key")
	fs.StringVar(&options.RelatedRecordPath, "related-record", "", "exact related handoff for receipt cross-checking")
	fs.StringVar(&options.EvidenceRoot, "evidence-root", "", "operational evidence root required for evidence-bundle verification")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	return options, requireValues(
		value("--record-type", options.RecordType),
		pathValue("--record", options.RecordPath),
		pathValue("--signature", options.SignaturePath),
		pathValue("--ceremony", options.CeremonyPath),
		pathValue("--ceremony-signature", options.CeremonySignaturePath),
		pathValue("--coordinator-public-key-file", options.CoordinatorPublicKeyFile),
		pathValue("--signer-public-key-file", options.SignerPublicKeyFile),
	)
}

func addOpsRecordFlags(fs *flag.FlagSet, recordType, recordPath *string) {
	fs.StringVar(recordType, "record-type", "", "enrollment, handoff, receipt, mirror-receipt, public-witness, beacon-evidence, evidence-bundle, or governance")
	fs.StringVar(recordPath, "record", "", "canonical operational record JSON")
}

func parsePhase1(invocation Invocation, args []string) (Invocation, error) {
	if len(args) == 0 {
		return Invocation{}, &usageError{message: "missing phase1 command", topic: []string{"phase1"}}
	}
	if args[0] == "help" {
		return Invocation{}, &helpRequest{topic: append([]string{"phase1"}, args[1:]...)}
	}
	switch args[0] {
	case "contribute":
		options, err := parseContribute("phase1 contribute", args[1:], false)
		invocation.Command, invocation.Options = CommandPhase1Contribute, options
		return invocation, wrapCommandError(err, "phase1", "contribute")
	case "attest-erasure":
		options, err := parseErasure("phase1 attest-erasure", args[1:])
		invocation.Command, invocation.Options = CommandPhase1Erasure, options
		return invocation, wrapCommandError(err, "phase1", "attest-erasure")
	case "verify":
		options, err := parseVerifyContribution("phase1 verify", args[1:], false)
		invocation.Command, invocation.Options = CommandPhase1Verify, options
		return invocation, wrapCommandError(err, "phase1", "verify")
	case "close":
		options, err := parseClose("phase1 close", args[1:], false)
		invocation.Command, invocation.Options = CommandPhase1Close, options
		return invocation, wrapCommandError(err, "phase1", "close")
	case "beacon":
		options, err := parseBeacon("phase1 beacon", args[1:])
		invocation.Command, invocation.Options = CommandPhase1Beacon, options
		return invocation, wrapCommandError(err, "phase1", "beacon")
	case "seal":
		options, err := parsePhase1Seal(args[1:])
		invocation.Command, invocation.Options = CommandPhase1Seal, options
		return invocation, wrapCommandError(err, "phase1", "seal")
	default:
		return Invocation{}, &usageError{
			message: fmt.Sprintf("unknown phase1 command %q", args[0]),
			topic:   []string{"phase1"},
		}
	}
}

func parsePhase2(invocation Invocation, args []string) (Invocation, error) {
	if len(args) == 0 {
		return Invocation{}, &usageError{message: "missing phase2 command", topic: []string{"phase2"}}
	}
	if args[0] == "help" {
		return Invocation{}, &helpRequest{topic: append([]string{"phase2"}, args[1:]...)}
	}
	switch args[0] {
	case "init":
		options, err := parsePhase2Init(args[1:])
		invocation.Command, invocation.Options = CommandPhase2Init, options
		return invocation, wrapCommandError(err, "phase2", "init")
	case "contribute":
		options, err := parseContribute("phase2 contribute", args[1:], true)
		invocation.Command, invocation.Options = CommandPhase2Contribute, options
		return invocation, wrapCommandError(err, "phase2", "contribute")
	case "attest-erasure":
		options, err := parseErasure("phase2 attest-erasure", args[1:])
		invocation.Command, invocation.Options = CommandPhase2Erasure, options
		return invocation, wrapCommandError(err, "phase2", "attest-erasure")
	case "verify":
		options, err := parseVerifyContribution("phase2 verify", args[1:], true)
		invocation.Command, invocation.Options = CommandPhase2Verify, options
		return invocation, wrapCommandError(err, "phase2", "verify")
	case "close":
		options, err := parseClose("phase2 close", args[1:], true)
		invocation.Command, invocation.Options = CommandPhase2Close, options
		return invocation, wrapCommandError(err, "phase2", "close")
	case "beacon":
		options, err := parseBeacon("phase2 beacon", args[1:])
		invocation.Command, invocation.Options = CommandPhase2Beacon, options
		return invocation, wrapCommandError(err, "phase2", "beacon")
	default:
		return Invocation{}, &usageError{
			message: fmt.Sprintf("unknown phase2 command %q", args[0]),
			topic:   []string{"phase2"},
		}
	}
}

func parseRelease(invocation Invocation, args []string) (Invocation, error) {
	if len(args) == 0 {
		return Invocation{}, &usageError{message: "missing release command", topic: []string{"release"}}
	}
	if args[0] == "help" {
		return Invocation{}, &helpRequest{topic: append([]string{"release"}, args[1:]...)}
	}
	switch args[0] {
	case "sign":
		options, err := parseReleaseSign(args[1:])
		invocation.Command, invocation.Options = CommandReleaseSign, options
		return invocation, wrapCommandError(err, "release", "sign")
	case "verify":
		options, err := parseReleaseVerify(args[1:])
		invocation.Command, invocation.Options = CommandReleaseVerify, options
		return invocation, wrapCommandError(err, "release", "verify")
	default:
		return Invocation{}, &usageError{
			message: fmt.Sprintf("unknown release command %q", args[0]),
			topic:   []string{"release"},
		}
	}
}

func parseInit(args []string) (InitOptions, error) {
	var options InitOptions
	fs := commandFlagSet("init")
	fs.StringVar(&options.SessionNonceHex, "session-nonce-hex", "", "optional 32-byte session nonce as hex; generated securely when omitted")
	fs.StringVar(&options.CreatedAt, "created-at", "", "ceremony creation timestamp in RFC3339")
	fs.StringVar(&options.KeyVersion, "key-version", "", "repository key version (ownership-destination-v2 only)")
	fs.StringVar(&options.ParticipantsPath, "participants", "", "participant roster JSON path")
	fs.StringVar(&options.PolicyPath, "policy", "", "ceremony policy JSON path")
	fs.StringVar(&options.CoordinatorKeyID, "coordinator-key-id", "", "coordinator signing key identifier")
	fs.StringVar(&options.CoordinatorSigningKey, "coordinator-signing-key", "", "existing Ed25519 coordinator private key path")
	fs.StringVar(&options.OutDir, "out-dir", "", "fresh ceremony directory")
	fs.StringVar(&options.Mode, "mode", "rehearsal", "ceremony mode: rehearsal or production")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	if options.Mode != "rehearsal" && options.Mode != "production" {
		return options, errors.New("--mode must be rehearsal or production")
	}
	if options.KeyVersion != "" && options.KeyVersion != supportedKeyVersion {
		return options, fmt.Errorf("--key-version must be %q", supportedKeyVersion)
	}
	if options.SessionNonceHex != "" {
		raw, err := hex.DecodeString(options.SessionNonceHex)
		if err != nil || len(raw) != 32 {
			return options, errors.New("--session-nonce-hex must encode exactly 32 bytes")
		}
	}
	return options, requireValues(
		value("--created-at", options.CreatedAt),
		value("--key-version", options.KeyVersion),
		pathValue("--participants", options.ParticipantsPath),
		pathValue("--policy", options.PolicyPath),
		value("--coordinator-key-id", options.CoordinatorKeyID),
		pathValue("--coordinator-signing-key", options.CoordinatorSigningKey),
		pathValue("--out-dir", options.OutDir),
	)
}

func parseContribute(name string, args []string, phase2 bool) (ContributeOptions, error) {
	var options ContributeOptions
	fs := commandFlagSet(name)
	addCeremonyTrustFlags(fs, &options.CeremonyPath, &options.CeremonySignaturePath, &options.CoordinatorPublicKeyFile)
	if phase2 {
		fs.StringVar(&options.Phase1SealPath, "phase1-seal", "", "verified phase 1 seal JSON path")
		fs.StringVar(&options.Phase1SealSignaturePath, "phase1-seal-signature", "", "detached phase 1 seal signature path")
	}
	fs.StringVar(&options.TranscriptDir, "transcript-dir", "", "complete ceremony transcript root")
	fs.StringVar(&options.ChainPath, "chain", "", "explicit accepted chain JSON path")
	fs.StringVar(&options.ChainSignaturePath, "chain-signature", "", "detached accepted chain signature path")
	fs.StringVar(&options.ParticipantID, "participant-id", "", "participant identifier from the signed roster")
	fs.StringVar(&options.ParticipantSigningKey, "participant-signing-key", "", "existing Ed25519 participant private key path")
	fs.StringVar(&options.EnvironmentPath, "environment", "", "canonical contribution environment attestation JSON path")
	fs.StringVar(&options.ContributedAt, "contributed-at", "", "contribution timestamp in RFC3339")
	fs.StringVar(&options.OutDir, "out-dir", "", "fresh candidate contribution directory")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	required := []requiredValue{
		pathValue("--ceremony", options.CeremonyPath),
		pathValue("--ceremony-signature", options.CeremonySignaturePath),
		pathValue("--coordinator-public-key-file", options.CoordinatorPublicKeyFile),
		pathValue("--transcript-dir", options.TranscriptDir),
		pathValue("--chain", options.ChainPath),
		pathValue("--chain-signature", options.ChainSignaturePath),
		value("--participant-id", options.ParticipantID),
		pathValue("--participant-signing-key", options.ParticipantSigningKey),
		pathValue("--environment", options.EnvironmentPath),
		value("--contributed-at", options.ContributedAt),
		pathValue("--out-dir", options.OutDir),
	}
	if phase2 {
		required = append(
			required,
			pathValue("--phase1-seal", options.Phase1SealPath),
			pathValue("--phase1-seal-signature", options.Phase1SealSignaturePath),
		)
	}
	return options, requireValues(required...)
}

func parseVerifyContribution(name string, args []string, phase2 bool) (VerifyContributionOptions, error) {
	var options VerifyContributionOptions
	fs := commandFlagSet(name)
	addCeremonyTrustFlags(fs, &options.CeremonyPath, &options.CeremonySignaturePath, &options.CoordinatorPublicKeyFile)
	if phase2 {
		fs.StringVar(&options.Phase1SealPath, "phase1-seal", "", "verified phase 1 seal JSON path")
		fs.StringVar(&options.Phase1SealSignaturePath, "phase1-seal-signature", "", "detached phase 1 seal signature path")
	}
	fs.StringVar(&options.TranscriptDir, "transcript-dir", "", "complete ceremony transcript root")
	fs.StringVar(&options.ChainPath, "chain", "", "explicit accepted chain JSON path")
	fs.StringVar(&options.ChainSignaturePath, "chain-signature", "", "detached accepted chain signature path")
	fs.StringVar(&options.CandidateDir, "candidate-dir", "", "candidate contribution directory")
	fs.StringVar(&options.CoordinatorSigningKey, "coordinator-signing-key", "", "existing Ed25519 coordinator private key path")
	fs.StringVar(&options.AcceptedAt, "accepted-at", "", "coordinator acceptance timestamp in RFC3339")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	required := []requiredValue{
		pathValue("--ceremony", options.CeremonyPath),
		pathValue("--ceremony-signature", options.CeremonySignaturePath),
		pathValue("--coordinator-public-key-file", options.CoordinatorPublicKeyFile),
		pathValue("--transcript-dir", options.TranscriptDir),
		pathValue("--chain", options.ChainPath),
		pathValue("--chain-signature", options.ChainSignaturePath),
		pathValue("--candidate-dir", options.CandidateDir),
		pathValue("--coordinator-signing-key", options.CoordinatorSigningKey),
		value("--accepted-at", options.AcceptedAt),
	}
	if phase2 {
		required = append(
			required,
			pathValue("--phase1-seal", options.Phase1SealPath),
			pathValue("--phase1-seal-signature", options.Phase1SealSignaturePath),
		)
	}
	return options, requireValues(required...)
}

func parseErasure(name string, args []string) (ErasureOptions, error) {
	var options ErasureOptions
	fs := commandFlagSet(name)
	addCeremonyTrustFlags(fs, &options.CeremonyPath, &options.CeremonySignaturePath, &options.CoordinatorPublicKeyFile)
	fs.StringVar(&options.ParticipantID, "participant-id", "", "participant identifier from the signed roster")
	fs.StringVar(&options.ParticipantSigningKey, "participant-signing-key", "", "existing Ed25519 participant private key path")
	fs.StringVar(&options.CandidateDir, "candidate-dir", "", "candidate contribution directory")
	fs.StringVar(&options.DestroyedAt, "destroyed-at", "", "environment destruction timestamp in RFC3339")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	return options, requireValues(
		pathValue("--ceremony", options.CeremonyPath),
		pathValue("--ceremony-signature", options.CeremonySignaturePath),
		pathValue("--coordinator-public-key-file", options.CoordinatorPublicKeyFile),
		value("--participant-id", options.ParticipantID),
		pathValue("--participant-signing-key", options.ParticipantSigningKey),
		pathValue("--candidate-dir", options.CandidateDir),
		value("--destroyed-at", options.DestroyedAt),
	)
}

func parseClose(name string, args []string, phase2 bool) (CloseOptions, error) {
	var options CloseOptions
	fs := commandFlagSet(name)
	addCeremonyTrustFlags(fs, &options.CeremonyPath, &options.CeremonySignaturePath, &options.CoordinatorPublicKeyFile)
	if phase2 {
		fs.StringVar(&options.Phase1SealPath, "phase1-seal", "", "verified phase 1 seal JSON path")
		fs.StringVar(&options.Phase1SealSignaturePath, "phase1-seal-signature", "", "detached phase 1 seal signature path")
	}
	fs.StringVar(&options.TranscriptDir, "transcript-dir", "", "complete ceremony transcript root")
	fs.StringVar(&options.ChainPath, "chain", "", "explicit final accepted chain JSON path")
	fs.StringVar(&options.ChainSignaturePath, "chain-signature", "", "detached final accepted chain signature path")
	fs.StringVar(&options.CoordinatorSigningKey, "coordinator-signing-key", "", "existing Ed25519 coordinator private key path")
	fs.Uint64Var(&options.BeaconRound, "beacon-round", 0, "precommitted future beacon round")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	required := []requiredValue{
		pathValue("--ceremony", options.CeremonyPath),
		pathValue("--ceremony-signature", options.CeremonySignaturePath),
		pathValue("--coordinator-public-key-file", options.CoordinatorPublicKeyFile),
		pathValue("--transcript-dir", options.TranscriptDir),
		pathValue("--chain", options.ChainPath),
		pathValue("--chain-signature", options.ChainSignaturePath),
		pathValue("--coordinator-signing-key", options.CoordinatorSigningKey),
	}
	if options.BeaconRound == 0 {
		required = append(required, requiredValue{name: "--beacon-round"})
	}
	if phase2 {
		required = append(
			required,
			pathValue("--phase1-seal", options.Phase1SealPath),
			pathValue("--phase1-seal-signature", options.Phase1SealSignaturePath),
		)
	}
	return options, requireValues(required...)
}

func parsePhase1Seal(args []string) (Phase1SealOptions, error) {
	var options Phase1SealOptions
	fs := commandFlagSet("phase1 seal")
	addCeremonyTrustFlags(fs, &options.CeremonyPath, &options.CeremonySignaturePath, &options.CoordinatorPublicKeyFile)
	fs.StringVar(&options.TranscriptDir, "transcript-dir", "", "complete ceremony transcript root containing closed phase 1")
	fs.StringVar(&options.ClosurePath, "closure", "", "signed phase 1 closure JSON path")
	fs.StringVar(&options.ClosureSignaturePath, "closure-signature", "", "detached phase 1 closure signature path")
	fs.StringVar(&options.BeaconPath, "beacon", "", "offline public beacon evidence JSON path")
	fs.StringVar(&options.BeaconSignaturePath, "beacon-signature", "", "detached public beacon signature path")
	fs.StringVar(&options.CoordinatorSigningKey, "coordinator-signing-key", "", "existing Ed25519 coordinator private key path")
	fs.StringVar(&options.OutDir, "out-dir", "", "fresh phase 1 seal directory")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	return options, requireValues(
		pathValue("--ceremony", options.CeremonyPath),
		pathValue("--ceremony-signature", options.CeremonySignaturePath),
		pathValue("--coordinator-public-key-file", options.CoordinatorPublicKeyFile),
		pathValue("--transcript-dir", options.TranscriptDir),
		pathValue("--closure", options.ClosurePath),
		pathValue("--closure-signature", options.ClosureSignaturePath),
		pathValue("--beacon", options.BeaconPath),
		pathValue("--beacon-signature", options.BeaconSignaturePath),
		pathValue("--coordinator-signing-key", options.CoordinatorSigningKey),
		pathValue("--out-dir", options.OutDir),
	)
}

func parseBeacon(name string, args []string) (BeaconOptions, error) {
	var options BeaconOptions
	fs := commandFlagSet(name)
	addCeremonyTrustFlags(fs, &options.CeremonyPath, &options.CeremonySignaturePath, &options.CoordinatorPublicKeyFile)
	fs.StringVar(&options.ClosurePath, "closure", "", "signed phase closure JSON path")
	fs.StringVar(&options.ClosureSignaturePath, "closure-signature", "", "detached phase closure signature path")
	fs.StringVar(&options.RawResponsePath, "raw-response", "", "local raw beacon-provider response path")
	fs.StringVar(&options.PublishedAt, "published-at", "", "beacon publication timestamp in RFC3339")
	fs.StringVar(&options.CoordinatorSigningKey, "coordinator-signing-key", "", "existing Ed25519 coordinator private key path")
	fs.StringVar(&options.TranscriptDir, "transcript-dir", "", "ceremony transcript root with a fresh phase beacon directory")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	return options, requireValues(
		pathValue("--ceremony", options.CeremonyPath),
		pathValue("--ceremony-signature", options.CeremonySignaturePath),
		pathValue("--coordinator-public-key-file", options.CoordinatorPublicKeyFile),
		pathValue("--closure", options.ClosurePath),
		pathValue("--closure-signature", options.ClosureSignaturePath),
		pathValue("--raw-response", options.RawResponsePath),
		value("--published-at", options.PublishedAt),
		pathValue("--coordinator-signing-key", options.CoordinatorSigningKey),
		pathValue("--transcript-dir", options.TranscriptDir),
	)
}

func parsePhase2Init(args []string) (Phase2InitOptions, error) {
	var options Phase2InitOptions
	fs := commandFlagSet("phase2 init")
	addCeremonyTrustFlags(fs, &options.CeremonyPath, &options.CeremonySignaturePath, &options.CoordinatorPublicKeyFile)
	fs.StringVar(&options.Phase1TranscriptDir, "phase1-transcript-dir", "", "complete ceremony transcript root containing sealed phase 1")
	fs.StringVar(&options.Phase1SealPath, "phase1-seal", "", "verified phase 1 seal JSON path")
	fs.StringVar(&options.Phase1SealSignaturePath, "phase1-seal-signature", "", "detached phase 1 seal signature path")
	fs.StringVar(&options.CoordinatorSigningKey, "coordinator-signing-key", "", "existing Ed25519 coordinator private key path")
	fs.StringVar(&options.OutDir, "out-dir", "", "fresh phase 2 transcript directory")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	return options, requireValues(
		pathValue("--ceremony", options.CeremonyPath),
		pathValue("--ceremony-signature", options.CeremonySignaturePath),
		pathValue("--coordinator-public-key-file", options.CoordinatorPublicKeyFile),
		pathValue("--phase1-transcript-dir", options.Phase1TranscriptDir),
		pathValue("--phase1-seal", options.Phase1SealPath),
		pathValue("--phase1-seal-signature", options.Phase1SealSignaturePath),
		pathValue("--coordinator-signing-key", options.CoordinatorSigningKey),
		pathValue("--out-dir", options.OutDir),
	)
}

func parseFinalize(invocation Invocation, args []string) (Invocation, error) {
	if len(args) == 0 {
		return Invocation{}, &usageError{message: "missing finalize command", topic: []string{"finalize"}}
	}
	switch args[0] {
	case "prepare":
		options, err := parsePrepareFinalization(args[1:])
		invocation.Command, invocation.Options = CommandFinalizePrepare, options
		return invocation, wrapCommandError(err, "finalize", "prepare")
	case "complete":
		options, err := parseCompleteFinalization(args[1:])
		invocation.Command, invocation.Options = CommandFinalizeComplete, options
		return invocation, wrapCommandError(err, "finalize", "complete")
	default:
		return Invocation{}, &usageError{message: fmt.Sprintf("unknown finalize command %q", args[0]), topic: []string{"finalize"}}
	}
}

func parsePrepareFinalization(args []string) (PrepareFinalizationOptions, error) {
	var options PrepareFinalizationOptions
	fs := commandFlagSet("finalize prepare")
	addCeremonyTrustFlags(fs, &options.CeremonyPath, &options.CeremonySignaturePath, &options.CoordinatorPublicKeyFile)
	addReplayFlags(fs, &options.Replay)
	fs.StringVar(&options.CoordinatorSigningKey, "coordinator-signing-key", "", "existing Ed25519 coordinator private key path")
	fs.StringVar(&options.PreparedAt, "prepared-at", "", "preliminary key timestamp in RFC3339 UTC")
	fs.StringVar(&options.OutDir, "out-dir", "", "fresh preliminary final-key directory")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	if err := requireValues(
		pathValue("--ceremony", options.CeremonyPath),
		pathValue("--ceremony-signature", options.CeremonySignaturePath),
		pathValue("--coordinator-public-key-file", options.CoordinatorPublicKeyFile),
		pathValue("--coordinator-signing-key", options.CoordinatorSigningKey),
		value("--prepared-at", options.PreparedAt),
		pathValue("--out-dir", options.OutDir),
	); err != nil {
		return options, err
	}
	return options, validateReplayOptions(options.Replay)
}

func parseCompleteFinalization(args []string) (FinalizeOptions, error) {
	var options FinalizeOptions
	fs := commandFlagSet("finalize complete")
	addCeremonyTrustFlags(fs, &options.CeremonyPath, &options.CeremonySignaturePath, &options.CoordinatorPublicKeyFile)
	addReplayFlags(fs, &options.Replay)
	fs.StringVar(&options.CoordinatorSigningKey, "coordinator-signing-key", "", "existing Ed25519 coordinator private key path")
	fs.StringVar(&options.PublicEvidencePath, "public-evidence", "", "canonical public finalization evidence JSON from a separate local proof tool")
	fs.StringVar(&options.FinalizedAt, "finalized-at", "", "candidate finalization timestamp in RFC3339 UTC")
	fs.StringVar(&options.OutDir, "out-dir", "", "fresh unsigned release candidate directory")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	if err := requireValues(
		pathValue("--ceremony", options.CeremonyPath),
		pathValue("--ceremony-signature", options.CeremonySignaturePath),
		pathValue("--coordinator-public-key-file", options.CoordinatorPublicKeyFile),
		pathValue("--coordinator-signing-key", options.CoordinatorSigningKey),
		pathValue("--public-evidence", options.PublicEvidencePath),
		value("--finalized-at", options.FinalizedAt),
		pathValue("--out-dir", options.OutDir),
	); err != nil {
		return options, err
	}
	return options, validateReplayOptions(options.Replay)
}

func parseAudit(args []string) (AuditOptions, error) {
	var options AuditOptions
	fs := commandFlagSet("audit")
	addCeremonyTrustFlags(fs, &options.CeremonyPath, &options.CeremonySignaturePath, &options.CoordinatorPublicKeyFile)
	addReplayFlags(fs, &options.Replay)
	fs.StringVar(&options.CandidateBundleDir, "candidate-bundle", "", "finalized candidate key bundle directory")
	fs.StringVar(&options.AuditorID, "auditor-id", "", "auditor identifier from ceremony policy")
	fs.StringVar(&options.AuditorSigningKey, "auditor-signing-key", "", "existing Ed25519 auditor private key path")
	fs.StringVar(&options.AuditedAt, "audited-at", "", "audit timestamp in RFC3339 UTC")
	fs.StringVar(&options.OutPath, "out", "", "fresh audit report JSON path")
	fs.StringVar(&options.SignatureOutPath, "audit-signature", "", "fresh detached audit signature path")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	if err := requireValues(
		pathValue("--ceremony", options.CeremonyPath),
		pathValue("--ceremony-signature", options.CeremonySignaturePath),
		pathValue("--coordinator-public-key-file", options.CoordinatorPublicKeyFile),
		pathValue("--candidate-bundle", options.CandidateBundleDir),
		value("--auditor-id", options.AuditorID),
		pathValue("--auditor-signing-key", options.AuditorSigningKey),
		value("--audited-at", options.AuditedAt),
		pathValue("--out", options.OutPath),
		pathValue("--audit-signature", options.SignatureOutPath),
	); err != nil {
		return options, err
	}
	return options, validateReplayOptions(options.Replay)
}

func parseReleaseSign(args []string) (ReleaseSignOptions, error) {
	var options ReleaseSignOptions
	var auditReports, auditSignatures stringList
	fs := commandFlagSet("release sign")
	addCeremonyTrustFlags(fs, &options.CeremonyPath, &options.CeremonySignaturePath, &options.CoordinatorPublicKeyFile)
	fs.StringVar(&options.CandidateBundleDir, "candidate-bundle", "", "audited candidate key bundle directory")
	fs.Var(&auditReports, "audit-report", "independent audit report path; repeat in auditor order")
	fs.Var(&auditSignatures, "audit-signature", "detached audit signature path; repeat in matching order")
	fs.StringVar(&options.OperationalEvidenceRoot, "operational-evidence-root", "", "local root containing the complete operational evidence tree")
	fs.StringVar(&options.OperationalBundlePath, "operational-bundle", "", "coordinator-signed operational evidence bundle JSON path")
	fs.StringVar(&options.OperationalSignaturePath, "operational-bundle-signature", "", "detached operational evidence bundle signature path")
	fs.StringVar(&options.ReleaseSigningKey, "release-signing-key", "", "existing Ed25519 release private key path")
	fs.StringVar(&options.SignatureKeyID, "signature-key-id", "", "release signing key identifier")
	fs.StringVar(&options.ReleasedAt, "released-at", "", "release publication timestamp in RFC3339 UTC")
	fs.StringVar(&options.ReleaseDir, "release-dir", "", "fresh release bundle directory distinct from the candidate")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	options.AuditReportPaths = append([]string(nil), auditReports...)
	options.AuditSignaturePaths = append([]string(nil), auditSignatures...)
	if err := requireValues(
		pathValue("--ceremony", options.CeremonyPath),
		pathValue("--ceremony-signature", options.CeremonySignaturePath),
		pathValue("--coordinator-public-key-file", options.CoordinatorPublicKeyFile),
		pathValue("--candidate-bundle", options.CandidateBundleDir),
		pathValue("--operational-evidence-root", options.OperationalEvidenceRoot),
		pathValue("--operational-bundle", options.OperationalBundlePath),
		pathValue("--operational-bundle-signature", options.OperationalSignaturePath),
		pathValue("--release-signing-key", options.ReleaseSigningKey),
		value("--signature-key-id", options.SignatureKeyID),
		value("--released-at", options.ReleasedAt),
		pathValue("--release-dir", options.ReleaseDir),
	); err != nil {
		return options, err
	}
	if err := validateAuditArtifacts(options.AuditReportPaths, options.AuditSignaturePaths); err != nil {
		return options, err
	}
	return options, nil
}

func parseReleaseVerify(args []string) (ReleaseVerifyOptions, error) {
	var options ReleaseVerifyOptions
	fs := commandFlagSet("release verify")
	addCeremonyTrustFlags(fs, &options.CeremonyPath, &options.CeremonySignaturePath, &options.CoordinatorPublicKeyFile)
	fs.StringVar(&options.KeysDir, "keys-dir", "", "signed key bundle directory")
	fs.StringVar(&options.ManifestPublicKeyFile, "manifest-public-key-file", "", "out-of-band trusted release public key path")
	fs.StringVar(&options.SignatureKeyID, "signature-key-id", "", "expected release signature key identifier")
	if err := parseFlags(fs, args); err != nil {
		return options, err
	}
	if err := requireValues(
		pathValue("--ceremony", options.CeremonyPath),
		pathValue("--ceremony-signature", options.CeremonySignaturePath),
		pathValue("--coordinator-public-key-file", options.CoordinatorPublicKeyFile),
		pathValue("--keys-dir", options.KeysDir),
		pathValue("--manifest-public-key-file", options.ManifestPublicKeyFile),
		value("--signature-key-id", options.SignatureKeyID),
	); err != nil {
		return options, err
	}
	return options, nil
}

func addReplayFlags(fs *flag.FlagSet, replay *ReplayOptions) {
	fs.StringVar(&replay.TranscriptRoot, "transcript-root", "", "complete immutable ceremony transcript root")
	fs.StringVar(&replay.Phase1ChainPath, "phase1-chain", "", "final signed phase 1 chain JSON path")
	fs.StringVar(&replay.Phase1ChainSignaturePath, "phase1-chain-signature", "", "detached final phase 1 chain signature path")
	fs.StringVar(&replay.Phase1ClosePath, "phase1-close", "", "signed phase 1 closure JSON path")
	fs.StringVar(&replay.Phase1CloseSignaturePath, "phase1-close-signature", "", "detached phase 1 closure signature path")
	fs.StringVar(&replay.Phase1BeaconPath, "phase1-beacon", "", "signed phase 1 beacon record path")
	fs.StringVar(&replay.Phase1BeaconSignaturePath, "phase1-beacon-signature", "", "detached phase 1 beacon signature path")
	fs.StringVar(&replay.Phase1SealPath, "phase1-seal", "", "signed phase 1 seal JSON path")
	fs.StringVar(&replay.Phase1SealSignaturePath, "phase1-seal-signature", "", "detached phase 1 seal signature path")
	fs.StringVar(&replay.Phase2ChainPath, "phase2-chain", "", "final signed phase 2 chain JSON path")
	fs.StringVar(&replay.Phase2ChainSignaturePath, "phase2-chain-signature", "", "detached final phase 2 chain signature path")
	fs.StringVar(&replay.Phase2ClosePath, "phase2-close", "", "signed phase 2 closure JSON path")
	fs.StringVar(&replay.Phase2CloseSignaturePath, "phase2-close-signature", "", "detached phase 2 closure signature path")
	fs.StringVar(&replay.Phase2BeaconPath, "phase2-beacon", "", "signed phase 2 beacon record path")
	fs.StringVar(&replay.Phase2BeaconSignaturePath, "phase2-beacon-signature", "", "detached phase 2 beacon signature path")
}

func validateReplayOptions(replay ReplayOptions) error {
	return requireValues(
		pathValue("--transcript-root", replay.TranscriptRoot),
		pathValue("--phase1-chain", replay.Phase1ChainPath),
		pathValue("--phase1-chain-signature", replay.Phase1ChainSignaturePath),
		pathValue("--phase1-close", replay.Phase1ClosePath),
		pathValue("--phase1-close-signature", replay.Phase1CloseSignaturePath),
		pathValue("--phase1-beacon", replay.Phase1BeaconPath),
		pathValue("--phase1-beacon-signature", replay.Phase1BeaconSignaturePath),
		pathValue("--phase1-seal", replay.Phase1SealPath),
		pathValue("--phase1-seal-signature", replay.Phase1SealSignaturePath),
		pathValue("--phase2-chain", replay.Phase2ChainPath),
		pathValue("--phase2-chain-signature", replay.Phase2ChainSignaturePath),
		pathValue("--phase2-close", replay.Phase2ClosePath),
		pathValue("--phase2-close-signature", replay.Phase2CloseSignaturePath),
		pathValue("--phase2-beacon", replay.Phase2BeaconPath),
		pathValue("--phase2-beacon-signature", replay.Phase2BeaconSignaturePath),
	)
}

func validateAuditArtifacts(reports, signatures []string) error {
	if len(reports) < 2 {
		return errors.New("--audit-report must be supplied at least twice for independent audits")
	}
	if len(reports) != len(signatures) {
		return errors.New("--audit-report and --audit-signature counts must match")
	}
	for _, path := range reports {
		if err := validatePathValue("--audit-report", path); err != nil {
			return err
		}
	}
	for _, path := range signatures {
		if err := validatePathValue("--audit-signature", path); err != nil {
			return err
		}
	}
	return nil
}

func commandFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

func addCeremonyTrustFlags(fs *flag.FlagSet, ceremonyPath, ceremonySignaturePath, coordinatorPublicKeyFile *string) {
	fs.StringVar(ceremonyPath, "ceremony", "", "signed ceremony definition JSON path")
	fs.StringVar(ceremonySignaturePath, "ceremony-signature", "", "detached ceremony definition signature path")
	fs.StringVar(coordinatorPublicKeyFile, "coordinator-public-key-file", "", "out-of-band trusted coordinator public key path")
}

func parseFlags(fs *flag.FlagSet, args []string) error {
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments: %s", strings.Join(fs.Args(), " "))
	}
	return nil
}

func wrapCommandError(err error, topic ...string) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, flag.ErrHelp) {
		return &helpRequest{topic: topic}
	}
	var h *helpRequest
	if errors.As(err, &h) {
		return err
	}
	return &usageError{message: err.Error(), topic: topic}
}

type requiredValue struct {
	name  string
	value string
	path  bool
}

func value(name, content string) requiredValue {
	return requiredValue{name: name, value: strings.TrimSpace(content)}
}

func pathValue(name, content string) requiredValue {
	return requiredValue{name: name, value: strings.TrimSpace(content), path: true}
}

func requireValues(values ...requiredValue) error {
	var missing []string
	for _, item := range values {
		if item.value == "" {
			missing = append(missing, item.name)
			continue
		}
		if item.path {
			if err := validatePathValue(item.name, item.value); err != nil {
				return err
			}
		}
	}
	if len(missing) != 0 {
		return fmt.Errorf("required flag(s) missing: %s", strings.Join(missing, ", "))
	}
	return nil
}

func validatePathValue(name, content string) error {
	if content == "-" {
		return fmt.Errorf("%s must name a filesystem path; standard input/output is not supported", name)
	}
	if strings.Contains(content, "://") {
		return fmt.Errorf("%s must name a local filesystem path; URLs are not supported", name)
	}
	return nil
}

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }

func (s *stringList) Set(value string) error {
	if strings.TrimSpace(value) == "" {
		return errors.New("value must not be empty")
	}
	*s = append(*s, value)
	return nil
}
