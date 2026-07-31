// Copyright 2026 Midgard Labs
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestParseInvocationAcceptsRequiredCommandSurface(t *testing.T) {
	t.Parallel()

	ceremonyTrust := []string{
		"--ceremony", "ceremony/ceremony.json",
		"--ceremony-signature", "ceremony/ceremony.sig",
		"--coordinator-public-key-file", "trust/coordinator.pub",
	}
	contribute := []string{
		"--transcript-dir", "transcript/phase",
		"--chain", "transcript/phase/chain-0000.json",
		"--chain-signature", "transcript/phase/chain-0000.sig",
		"--participant-id", "participant-01",
		"--participant-signing-key", "private/participant.key",
		"--environment", "participant/environment.json",
		"--contributed-at", "2026-07-23T12:00:00Z",
		"--out-dir", "candidate/participant-01",
	}
	verify := []string{
		"--transcript-dir", "transcript/phase",
		"--chain", "transcript/phase/chain-0000.json",
		"--chain-signature", "transcript/phase/chain-0000.sig",
		"--candidate-dir", "candidate/participant-01",
		"--coordinator-signing-key", "private/coordinator.key",
		"--accepted-at", "2026-07-23T12:05:00Z",
	}
	closeFlags := []string{
		"--transcript-dir", "transcript/phase",
		"--chain", "transcript/phase/chain-0001.json",
		"--chain-signature", "transcript/phase/chain-0001.sig",
		"--coordinator-signing-key", "private/coordinator.key",
		"--beacon-round", "12345",
	}
	replayFlags := []string{
		"--transcript-root", "transcript",
		"--phase1-chain", "transcript/phase1/chain.json",
		"--phase1-chain-signature", "transcript/phase1/chain.sig",
		"--phase1-close", "transcript/phase1/close.json",
		"--phase1-close-signature", "transcript/phase1/close.sig",
		"--phase1-beacon", "transcript/phase1/beacon.json",
		"--phase1-beacon-signature", "transcript/phase1/beacon.sig",
		"--phase1-seal", "transcript/phase1/seal.json",
		"--phase1-seal-signature", "transcript/phase1/seal.sig",
		"--phase2-chain", "transcript/phase2/chain.json",
		"--phase2-chain-signature", "transcript/phase2/chain.sig",
		"--phase2-close", "transcript/phase2/close.json",
		"--phase2-close-signature", "transcript/phase2/close.sig",
		"--phase2-beacon", "transcript/phase2/beacon.json",
		"--phase2-beacon-signature", "transcript/phase2/beacon.sig",
	}

	tests := []struct {
		name    string
		args    []string
		command Command
	}{
		{
			name: "init",
			args: []string{
				"init",
				"--created-at", "2026-07-23T11:00:00Z",
				"--key-version", "ownership-destination-v2",
				"--participants", "policy/participants.json",
				"--policy", "policy/ceremony.json",
				"--coordinator-key-id", "coordinator-2026",
				"--coordinator-signing-key", "private/coordinator.key",
				"--out-dir", "transcript",
				"--mode", "production",
			},
			command: CommandInit,
		},
		{
			name:    "phase1 contribute",
			args:    joinArgs([]string{"phase1", "contribute"}, ceremonyTrust, contribute),
			command: CommandPhase1Contribute,
		},
		{
			name: "phase1 attest erasure",
			args: joinArgs(
				[]string{"phase1", "attest-erasure"},
				ceremonyTrust,
				[]string{
					"--participant-id", "participant-01",
					"--participant-signing-key", "private/participant.key",
					"--candidate-dir", "candidate/participant-01",
					"--destroyed-at", "2026-07-23T12:04:00Z",
				},
			),
			command: CommandPhase1Erasure,
		},
		{
			name:    "phase1 verify",
			args:    joinArgs([]string{"phase1", "verify"}, ceremonyTrust, verify),
			command: CommandPhase1Verify,
		},
		{
			name:    "phase1 close",
			args:    joinArgs([]string{"phase1", "close"}, ceremonyTrust, closeFlags),
			command: CommandPhase1Close,
		},
		{
			name: "phase1 beacon",
			args: joinArgs(
				[]string{"phase1", "beacon"},
				ceremonyTrust,
				[]string{
					"--closure", "transcript/phase1/closure/record.json",
					"--closure-signature", "transcript/phase1/closure/record.sig",
					"--raw-response", "beacons/phase1-raw.json",
					"--published-at", "2026-07-24T12:00:00Z",
					"--coordinator-signing-key", "private/coordinator.key",
					"--transcript-dir", "transcript",
				},
			),
			command: CommandPhase1Beacon,
		},
		{
			name: "phase1 seal",
			args: joinArgs(
				[]string{"phase1", "seal"},
				ceremonyTrust,
				[]string{
					"--transcript-dir", "transcript/phase1",
					"--closure", "transcript/phase1/closure/record.json",
					"--closure-signature", "transcript/phase1/closure/record.sig",
					"--beacon", "beacons/phase1.json",
					"--beacon-signature", "beacons/phase1.sig",
					"--coordinator-signing-key", "private/coordinator.key",
					"--out-dir", "transcript/phase1-seal",
				},
			),
			command: CommandPhase1Seal,
		},
		{
			name: "phase2 init",
			args: joinArgs(
				[]string{"phase2", "init"},
				ceremonyTrust,
				[]string{
					"--phase1-transcript-dir", "transcript/phase1",
					"--phase1-seal", "transcript/phase1-seal/seal.json",
					"--phase1-seal-signature", "transcript/phase1-seal/seal.sig",
					"--coordinator-signing-key", "private/coordinator.key",
					"--out-dir", "transcript/phase2",
				},
			),
			command: CommandPhase2Init,
		},
		{
			name: "phase2 contribute",
			args: joinArgs(
				[]string{"phase2", "contribute"},
				ceremonyTrust,
				[]string{"--phase1-seal", "transcript/phase1-seal/seal.json"},
				[]string{"--phase1-seal-signature", "transcript/phase1-seal/seal.sig"},
				contribute,
			),
			command: CommandPhase2Contribute,
		},
		{
			name: "phase2 attest erasure",
			args: joinArgs(
				[]string{"phase2", "attest-erasure"},
				ceremonyTrust,
				[]string{
					"--participant-id", "participant-01",
					"--participant-signing-key", "private/participant.key",
					"--candidate-dir", "candidate/participant-01",
					"--destroyed-at", "2026-07-23T12:04:00Z",
				},
			),
			command: CommandPhase2Erasure,
		},
		{
			name: "phase2 verify",
			args: joinArgs(
				[]string{"phase2", "verify"},
				ceremonyTrust,
				[]string{"--phase1-seal", "transcript/phase1-seal/seal.json"},
				[]string{"--phase1-seal-signature", "transcript/phase1-seal/seal.sig"},
				verify,
			),
			command: CommandPhase2Verify,
		},
		{
			name: "phase2 close",
			args: joinArgs(
				[]string{"phase2", "close"},
				ceremonyTrust,
				[]string{"--phase1-seal", "transcript/phase1-seal/seal.json"},
				[]string{"--phase1-seal-signature", "transcript/phase1-seal/seal.sig"},
				closeFlags,
			),
			command: CommandPhase2Close,
		},
		{
			name: "phase2 beacon",
			args: joinArgs(
				[]string{"phase2", "beacon"},
				ceremonyTrust,
				[]string{
					"--closure", "transcript/phase2/closure/record.json",
					"--closure-signature", "transcript/phase2/closure/record.sig",
					"--raw-response", "beacons/phase2-raw.json",
					"--published-at", "2026-07-25T12:00:00Z",
					"--coordinator-signing-key", "private/coordinator.key",
					"--transcript-dir", "transcript",
				},
			),
			command: CommandPhase2Beacon,
		},
		{
			name: "finalize complete",
			args: joinArgs(
				[]string{"finalize", "complete"},
				ceremonyTrust,
				replayFlags,
				[]string{
					"--coordinator-signing-key", "private/coordinator.key",
					"--public-evidence", "candidate/public-evidence.json",
					"--finalized-at", "2026-07-26T12:00:00Z",
					"--out-dir", "candidate/release",
				},
			),
			command: CommandFinalizeComplete,
		},
		{
			name: "audit",
			args: joinArgs(
				[]string{"audit"},
				ceremonyTrust,
				replayFlags,
				[]string{
					"--candidate-bundle", "candidate/release",
					"--auditor-id", "auditor-01",
					"--auditor-signing-key", "private/auditor.key",
					"--audited-at", "2026-07-27T12:00:00Z",
					"--out", "audits/auditor-01.json",
					"--audit-signature", "audits/auditor-01.sig",
				},
			),
			command: CommandAudit,
		},
		{
			name: "release sign",
			args: joinArgs(
				[]string{"release", "sign"},
				ceremonyTrust,
				[]string{
					"--candidate-bundle", "candidate/release",
					"--audit-report", "audits/auditor-01.json",
					"--audit-signature", "audits/auditor-01.sig",
					"--audit-report", "audits/auditor-02.json",
					"--audit-signature", "audits/auditor-02.sig",
					"--operational-evidence-root", "operational-input",
					"--operational-bundle", "operational-input/operational/evidence-bundle.json",
					"--operational-bundle-signature", "operational-input/operational/evidence-bundle.sig",
					"--release-signing-key", "private/release.key",
					"--signature-key-id", "release-2026",
					"--released-at", "2026-07-28T12:00:00Z",
					"--release-dir", "release",
				},
			),
			command: CommandReleaseSign,
		},
		{
			name: "release verify",
			args: joinArgs(
				[]string{"release", "verify"},
				ceremonyTrust,
				[]string{
					"--keys-dir", "release",
					"--manifest-public-key-file", "trust/release.pub",
					"--signature-key-id", "release-2026",
				},
			),
			command: CommandReleaseVerify,
		},
		{
			name: "decision prepare",
			args: joinArgs(
				[]string{"decision", "prepare"},
				ceremonyTrust,
				[]string{
					"--draft", "governance/decision.draft.json",
					"--out", "governance/decision.json",
				},
			),
			command: CommandDecisionPrepare,
		},
		{
			name: "decision sign",
			args: joinArgs(
				[]string{"decision", "sign"},
				ceremonyTrust,
				[]string{
					"--decision", "governance/decision.json",
					"--role", "auditor",
					"--signer-id", "auditor-01",
					"--signing-key", "private/auditor-01.key",
					"--out", "governance/auditor-01.decision.sig.json",
				},
			),
			command: CommandDecisionSign,
		},
		{
			name: "decision verify",
			args: joinArgs(
				[]string{"decision", "verify"},
				ceremonyTrust,
				[]string{
					"--decision", "governance/decision.json",
					"--signature", "governance/coordinator.sig.json",
					"--signature", "governance/auditor-01.sig.json",
					"--signature", "governance/auditor-02.sig.json",
					"--signature", "governance/release-signer.sig.json",
					"--evidence-root", "governance/evidence",
				},
			),
			command: CommandDecisionVerify,
		},
		{
			name: "ops export signing",
			args: joinArgs(
				[]string{"ops", "export-signing"},
				ceremonyTrust,
				[]string{
					"--record-type", "enrollment",
					"--record", "ops/enrollment.json",
					"--out-dir", "ops/export",
				},
			),
			command: CommandOpsExportSigning,
		},
		{
			name: "ops import signature",
			args: joinArgs(
				[]string{"ops", "import-signature"},
				ceremonyTrust,
				[]string{
					"--record-type", "enrollment",
					"--canonical", "ops/export/canonical.json",
					"--signer-public-key-file", "trust/participant.pub",
					"--raw-signature", "offline/enrollment.sig",
					"--out", "ops/enrollment.sig",
				},
			),
			command: CommandOpsImportSig,
		},
		{
			name: "ops verify",
			args: joinArgs(
				[]string{"ops", "verify"},
				ceremonyTrust,
				[]string{
					"--record-type", "receipt",
					"--record", "ops/receipt.json",
					"--signature", "ops/receipt.sig",
					"--signer-public-key-file", "trust/participant.pub",
					"--related-record", "ops/handoff.json",
				},
			),
			command: CommandOpsVerify,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			invocation, err := parseInvocation(test.args)
			if err != nil {
				t.Fatalf("parseInvocation() error = %v", err)
			}
			if invocation.Command != test.command {
				t.Fatalf("command = %q, want %q", invocation.Command, test.command)
			}
			if invocation.Options == nil {
				t.Fatal("options are nil")
			}
		})
	}
}

func TestParseInvocationRejectsMissingExplicitPaths(t *testing.T) {
	t.Parallel()

	_, err := parseInvocation([]string{"phase1", "contribute", "--participant-id", "p1"})
	if err == nil {
		t.Fatal("parseInvocation() accepted missing paths")
	}
	for _, expected := range []string{"--ceremony", "--transcript-dir", "--chain", "--out-dir"} {
		if !strings.Contains(err.Error(), expected) {
			t.Errorf("error %q does not mention %s", err, expected)
		}
	}
}

func TestParseInvocationRejectsStreamsURLsAndForce(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		args []string
		want string
	}{
		{
			name: "standard stream",
			args: []string{
				"init", "--created-at", "2026-07-23T11:00:00Z", "--key-version", supportedKeyVersion,
				"--participants", "-", "--policy", "policy.json",
				"--coordinator-key-id", "key-id",
				"--coordinator-signing-key", "key", "--out-dir", "out",
			},
			want: "standard input/output is not supported",
		},
		{
			name: "URL",
			args: []string{
				"init", "--created-at", "2026-07-23T11:00:00Z", "--key-version", supportedKeyVersion,
				"--participants", "https://example.invalid/roster.json",
				"--policy", "policy.json", "--coordinator-key-id", "key-id",
				"--coordinator-signing-key", "key", "--out-dir", "out",
			},
			want: "URLs are not supported",
		},
		{
			name: "force",
			args: []string{
				"init", "--force", "--created-at", "2026-07-23T11:00:00Z", "--key-version", supportedKeyVersion,
			},
			want: "flag provided but not defined: -force",
		},
		{
			name: "operator beacon randomness",
			args: []string{
				"phase1", "beacon", "--randomness-hex", strings.Repeat("ab", 32),
			},
			want: "flag provided but not defined: -randomness-hex",
		},
		{
			name: "operator beacon challenge",
			args: []string{
				"phase2", "beacon", "--challenge", "chosen-by-operator",
			},
			want: "flag provided but not defined: -challenge",
		},
		{
			name: "unauthenticated replay override",
			args: []string{
				"finalize", "complete", "--phase1-contribution", "substituted.bin",
			},
			want: "flag provided but not defined: -phase1-contribution",
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, err := parseInvocation(test.args)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want substring %q", err, test.want)
			}
		})
	}
}

func TestReleaseSignRequiresPairedIndependentAudits(t *testing.T) {
	t.Parallel()

	base := []string{
		"release", "sign",
		"--ceremony", "ceremony.json",
		"--ceremony-signature", "ceremony.sig",
		"--coordinator-public-key-file", "coordinator.pub",
		"--candidate-bundle", "candidate",
		"--operational-evidence-root", "operational-input",
		"--operational-bundle", "operational-input/operational/evidence-bundle.json",
		"--operational-bundle-signature", "operational-input/operational/evidence-bundle.sig",
		"--release-signing-key", "release.key",
		"--signature-key-id", "release-2026",
		"--released-at", "2026-07-28T12:00:00Z",
		"--release-dir", "release",
	}
	tests := []struct {
		name string
		args []string
		want string
	}{
		{
			name: "one audit",
			args: append(append([]string(nil), base...),
				"--audit-report", "audit-1.json",
				"--audit-signature", "audit-1.sig",
			),
			want: "at least twice",
		},
		{
			name: "mismatched signatures",
			args: append(append([]string(nil), base...),
				"--audit-report", "audit-1.json",
				"--audit-report", "audit-2.json",
				"--audit-signature", "audit-1.sig",
			),
			want: "counts must match",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, err := parseInvocation(test.args)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want substring %q", err, test.want)
			}
		})
	}
}

func TestInitUsesContentAddressedIdentityInputs(t *testing.T) {
	t.Parallel()

	base := []string{
		"init", "--created-at", "2026-07-23T11:00:00Z", "--key-version", supportedKeyVersion,
		"--participants", "participants.json", "--policy", "policy.json",
		"--coordinator-key-id", "coordinator",
		"--coordinator-signing-key", "coordinator.key", "--out-dir", "out",
	}
	invocation, err := parseInvocation(base)
	if err != nil {
		t.Fatalf("parseInvocation() error = %v", err)
	}
	options := invocation.Options.(InitOptions)
	if options.SessionNonceHex != "" {
		t.Fatalf("session nonce = %q, want executor-generated empty input", options.SessionNonceHex)
	}

	withNonce := append(append([]string(nil), base...), "--session-nonce-hex", strings.Repeat("ab", 32))
	invocation, err = parseInvocation(withNonce)
	if err != nil {
		t.Fatalf("parseInvocation() with nonce error = %v", err)
	}
	options = invocation.Options.(InitOptions)
	if options.SessionNonceHex != strings.Repeat("ab", 32) {
		t.Fatalf("session nonce = %q", options.SessionNonceHex)
	}

	for name, args := range map[string][]string{
		"user ceremony id": append(append([]string(nil), base...), "--ceremony-id", "operator-label"),
		"short nonce":      append(append([]string(nil), base...), "--session-nonce-hex", "abcd"),
		"wrong key version": {
			"init", "--created-at", "2026-07-23T11:00:00Z", "--key-version", "ownership-v1",
			"--participants", "participants.json", "--policy", "policy.json",
			"--coordinator-key-id", "coordinator",
			"--coordinator-signing-key", "coordinator.key", "--out-dir", "out",
		},
	} {
		name, args := name, args
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := parseInvocation(args); err == nil {
				t.Fatal("parseInvocation() accepted invalid identity input")
			}
		})
	}
}

func TestRunCLIHelpDoesNotExecute(t *testing.T) {
	t.Parallel()

	var stdout, stderr bytes.Buffer
	executor := executorFunc(func(context.Context, Invocation) (CommandResult, error) {
		t.Fatal("executor called for help")
		return CommandResult{}, nil
	})
	exitCode := runCLI(context.Background(), []string{"help", "phase1", "contribute"}, &stdout, &stderr, executor)
	if exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	if !strings.Contains(stdout.String(), "phase1 contribute") {
		t.Fatalf("help output = %q", stdout.String())
	}
}

func TestRunCLIJSONSuccessIsOneMachineReadableObject(t *testing.T) {
	t.Parallel()

	args := []string{
		"--format", "json",
		"init", "--created-at", "2026-07-23T11:00:00Z", "--key-version", supportedKeyVersion,
		"--participants", "participants.json", "--policy", "policy.json",
		"--coordinator-key-id", "coordinator",
		"--coordinator-signing-key", "coordinator.key", "--out-dir", "out",
	}
	executor := executorFunc(func(_ context.Context, invocation Invocation) (CommandResult, error) {
		return CommandResult{
			CeremonyID: "id",
			Outputs:    map[string]string{"ceremony": "out/ceremony.json"},
			Summary:    "initialized",
		}, nil
	})
	var stdout, stderr bytes.Buffer
	exitCode := runCLI(context.Background(), args, &stdout, &stderr, executor)
	if exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	var result CommandResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("stdout is not one JSON object: %v; stdout = %q", err, stdout.String())
	}
	if result.Schema != commandResultSchema || !result.OK || result.Command != CommandInit {
		t.Fatalf("unexpected result: %+v", result)
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
	}
}

func TestRunCLIReportsUnwiredEngineExplicitly(t *testing.T) {
	t.Parallel()

	args := []string{
		"--format", "json",
		"init", "--created-at", "2026-07-23T11:00:00Z", "--key-version", supportedKeyVersion,
		"--participants", "participants.json", "--policy", "policy.json",
		"--coordinator-key-id", "coordinator",
		"--coordinator-signing-key", "coordinator.key", "--out-dir", "out",
	}
	var stdout, stderr bytes.Buffer
	exitCode := runCLI(context.Background(), args, &stdout, &stderr, nil)
	if exitCode != 6 {
		t.Fatalf("exit code = %d, want 6", exitCode)
	}
	if !strings.Contains(stdout.String(), `"code":"engine_not_wired"`) {
		t.Fatalf("stdout = %q", stdout.String())
	}
	if !errors.Is(errExecutorNotWired, errExecutorNotWired) {
		t.Fatal("sentinel error is not stable")
	}
}

func TestRunCLIJSONUsageErrorIsMachineReadable(t *testing.T) {
	t.Parallel()

	var stdout, stderr bytes.Buffer
	exitCode := runCLI(
		context.Background(),
		[]string{"--format=json", "phase1", "contribute"},
		&stdout,
		&stderr,
		executorFunc(func(context.Context, Invocation) (CommandResult, error) {
			t.Fatal("executor called for invalid invocation")
			return CommandResult{}, nil
		}),
	)
	if exitCode != 2 {
		t.Fatalf("exit code = %d, want 2", exitCode)
	}
	var result struct {
		Schema string `json:"schema"`
		OK     bool   `json:"ok"`
		Error  struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("stdout is not JSON: %v; stdout = %q", err, stdout.String())
	}
	if result.Schema != commandResultSchema || result.OK || result.Error.Code != "usage_error" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
	}
}

func TestRunCLIErrorOutputRedactsCallerControlledValues(t *testing.T) {
	t.Parallel()

	validErasureArgs := func(participantID, signingKey string) []string {
		return []string{
			"phase1", "attest-erasure",
			"--ceremony", "ceremony.json",
			"--ceremony-signature", "ceremony.sig",
			"--coordinator-public-key-file", "coordinator.pub",
			"--participant-id", participantID,
			"--participant-signing-key", signingKey,
			"--candidate-dir", "candidate",
			"--destroyed-at", "2026-07-23T12:00:00Z",
		}
	}
	tests := []struct {
		name     string
		sentinel string
		args     []string
		executor Executor
	}{
		{
			name:     "unexpected positional",
			sentinel: "position-SENSITIVE-SENTINEL",
			args:     []string{"phase1", "attest-erasure", "position-SENSITIVE-SENTINEL"},
			executor: executorFunc(func(context.Context, Invocation) (CommandResult, error) {
				t.Fatal("executor called for invalid positionals")
				return CommandResult{}, nil
			}),
		},
		{
			name:     "unknown command",
			sentinel: "unknown-SENSITIVE-SENTINEL",
			args:     []string{"unknown-SENSITIVE-SENTINEL"},
			executor: executorFunc(func(context.Context, Invocation) (CommandResult, error) {
				t.Fatal("executor called for unknown command")
				return CommandResult{}, nil
			}),
		},
		{
			name:     "participant lookup",
			sentinel: "participant-SENSITIVE-SENTINEL",
			args:     validErasureArgs("participant-SENSITIVE-SENTINEL", "participant.key"),
			executor: executorFunc(func(_ context.Context, invocation Invocation) (CommandResult, error) {
				options := invocation.Options.(ErasureOptions)
				return CommandResult{}, errors.New("participant lookup failed: " + options.ParticipantID)
			}),
		},
		{
			name:     "participant value matching command word",
			sentinel: "close",
			args:     validErasureArgs("close", "participant.key"),
			executor: executorFunc(func(_ context.Context, invocation Invocation) (CommandResult, error) {
				options := invocation.Options.(ErasureOptions)
				return CommandResult{}, errors.New("participant lookup failed: " + options.ParticipantID)
			}),
		},
		{
			name:     "participant signing key",
			sentinel: "key-SENSITIVE-SENTINEL",
			args:     validErasureArgs("participant-01", "key-SENSITIVE-SENTINEL"),
			executor: executorFunc(func(_ context.Context, invocation Invocation) (CommandResult, error) {
				options := invocation.Options.(ErasureOptions)
				return CommandResult{}, errors.New("participant signing key failed: " + options.ParticipantSigningKey)
			}),
		},
	}
	for _, format := range []string{"human", "json"} {
		format := format
		for _, tc := range tests {
			tc := tc
			t.Run(format+"/"+tc.name, func(t *testing.T) {
				t.Parallel()
				args := append([]string(nil), tc.args...)
				if format == "json" {
					args = append([]string{"--format=json"}, args...)
				}
				var stdout, stderr bytes.Buffer
				exitCode := runCLI(context.Background(), args, &stdout, &stderr, tc.executor)
				if exitCode != 2 && exitCode != 6 {
					t.Fatalf("exit code = %d, stdout = %q, stderr = %q", exitCode, stdout.String(), stderr.String())
				}
				combined := stdout.String() + stderr.String()
				if strings.Contains(combined, tc.sentinel) {
					t.Fatalf("caller-controlled value leaked in output: %q", combined)
				}
				if !strings.Contains(combined, "redacted") {
					t.Fatalf("output did not mark the redaction: %q", combined)
				}
				if format == "json" {
					var payload any
					if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
						t.Fatalf("stdout is not JSON: %v; stdout = %q", err, stdout.String())
					}
					if stderr.Len() != 0 {
						t.Fatalf("stderr = %q, want empty", stderr.String())
					}
				}
			})
		}
	}
}

func TestRunCLIRejectsHelpOutputFailure(t *testing.T) {
	t.Parallel()

	var stderr bytes.Buffer
	exitCode := runCLI(
		context.Background(),
		[]string{"help"},
		failingWriter{},
		&stderr,
		executorFunc(func(context.Context, Invocation) (CommandResult, error) {
			t.Fatal("executor called for help")
			return CommandResult{}, nil
		}),
	)
	if exitCode != 6 {
		t.Fatalf("exit code = %d, want 6", exitCode)
	}
	if !strings.Contains(stderr.String(), "write help") {
		t.Fatalf("stderr = %q, want write failure", stderr.String())
	}
}

func TestRunCLIRejectsResultOutputFailure(t *testing.T) {
	t.Parallel()

	args := []string{
		"init", "--created-at", "2026-07-23T11:00:00Z", "--key-version", supportedKeyVersion,
		"--participants", "participants.json", "--policy", "policy.json",
		"--coordinator-key-id", "coordinator",
		"--coordinator-signing-key", "coordinator.key", "--out-dir", "out",
	}
	var stderr bytes.Buffer
	exitCode := runCLI(
		context.Background(),
		args,
		failingWriter{},
		&stderr,
		executorFunc(func(context.Context, Invocation) (CommandResult, error) {
			return CommandResult{Summary: "initialized"}, nil
		}),
	)
	if exitCode != 6 {
		t.Fatalf("exit code = %d, want 6", exitCode)
	}
	if !strings.Contains(stderr.String(), "write command result") {
		t.Fatalf("stderr = %q, want write failure", stderr.String())
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) {
	return 0, io.ErrClosedPipe
}

func joinArgs(parts ...[]string) []string {
	var result []string
	for _, part := range parts {
		result = append(result, part...)
	}
	return result
}
