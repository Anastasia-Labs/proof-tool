// Copyright 2026 Midgard Labs
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"errors"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func TestParticipantCLIHelpHasExplicitSafeFlagAllowlist(t *testing.T) {
	topics := [][]string{
		nil,
		{"init"},
		{"phase1"},
		{"phase1", "contribute"},
		{"phase1", "attest-erasure"},
		{"phase1", "verify"},
		{"phase1", "close"},
		{"phase1", "beacon"},
		{"phase1", "seal"},
		{"phase2"},
		{"phase2", "init"},
		{"phase2", "contribute"},
		{"phase2", "attest-erasure"},
		{"phase2", "verify"},
		{"phase2", "close"},
		{"phase2", "beacon"},
		{"finalize"},
		{"finalize", "prepare"},
		{"finalize", "complete"},
		{"audit"},
		{"release"},
		{"release", "sign"},
		{"release", "verify"},
		{"decision"},
		{"decision", "prepare"},
		{"decision", "sign"},
		{"decision", "verify"},
		{"ops"},
		{"ops", "export-signing"},
		{"ops", "import-signature"},
		{"ops", "verify"},
	}
	var allHelp bytes.Buffer
	for _, topic := range topics {
		if err := writeUsage(&allHelp, topic); err != nil {
			t.Fatalf("write help for %q: %v", topic, err)
		}
		allHelp.WriteByte('\n')
	}

	lowerHelp := strings.ToLower(allHelp.String())
	for _, forbiddenSecret := range []string{
		"mnemonic",
		"seed phrase",
		"seed-phrase",
		"master-xprv",
		"master xprv",
		"wallet secret",
		"wallet-secret",
		"proving input",
		"private witness",
	} {
		if strings.Contains(lowerHelp, forbiddenSecret) {
			t.Errorf("participant CLI help exposes forbidden secret input %q", forbiddenSecret)
		}
	}
	for _, forbiddenFlag := range []string{
		"--url",
		"--network",
		"--latest",
		"--force",
		"--overwrite",
		"--skip-verification",
		"--skip-verify",
		"--insecure",
		"--deterministic-randomness",
		"--challenge",
		"--randomness-hex",
	} {
		if strings.Contains(lowerHelp, forbiddenFlag) {
			t.Errorf("participant CLI help exposes forbidden flag %q", forbiddenFlag)
		}
	}

	allowed := []string{
		"--audit-report",
		"--audit-signature",
		"--audited-at",
		"--auditor-id",
		"--auditor-signing-key",
		"--beacon",
		"--beacon-signature",
		"--beacon-round",
		"--candidate-bundle",
		"--candidate-dir",
		"--ceremony",
		"--ceremony-signature",
		"--chain",
		"--chain-signature",
		"--closure-signature",
		"--closure",
		"--created-at",
		"--destroyed-at",
		"--decision",
		"--draft",
		"--evidence-root",
		"--coordinator-key-id",
		"--coordinator-public-key-file",
		"--coordinator-signing-key",
		"--environment",
		"--finalized-at",
		"--format",
		"--key-version",
		"--keys-dir",
		"--manifest-public-key-file",
		"--mode",
		"--out",
		"--out-dir",
		"--published-at",
		"--participant-id",
		"--participant-signing-key",
		"--prepared-at",
		"--public-evidence",
		"--participants",
		"--phase1-beacon",
		"--phase1-beacon-signature",
		"--phase1-chain",
		"--phase1-chain-signature",
		"--phase1-close",
		"--phase1-close-signature",
		"--phase1-seal",
		"--phase1-seal-signature",
		"--phase1-transcript-dir",
		"--phase2-beacon",
		"--phase2-beacon-signature",
		"--phase2-chain",
		"--phase2-chain-signature",
		"--phase2-close",
		"--phase2-close-signature",
		"--policy",
		"--quiet",
		"--raw-response",
		"--release-dir",
		"--release-signing-key",
		"--released-at",
		"--record",
		"--record-type",
		"--canonical",
		"--signature",
		"--signer-public-key-file",
		"--raw-signature",
		"--role",
		"--related-record",
		"--operational-evidence-root",
		"--operational-bundle",
		"--operational-bundle-signature",
		"--session-nonce-hex",
		"--signer-id",
		"--signing-key",
		"--signature-key-id",
		"--transcript-dir",
		"--transcript-root",
		"--accepted-at",
		"--contributed-at",
	}
	flagPattern := regexp.MustCompile(`--[a-z0-9-]+`)
	seenSet := make(map[string]struct{})
	for _, flag := range flagPattern.FindAllString(lowerHelp, -1) {
		seenSet[flag] = struct{}{}
	}
	seen := make([]string, 0, len(seenSet))
	for flag := range seenSet {
		seen = append(seen, flag)
	}
	slices.Sort(seen)
	slices.Sort(allowed)
	if !slices.Equal(seen, allowed) {
		t.Fatalf("participant CLI flags changed without allowlist review:\n got %v\nwant %v", seen, allowed)
	}
}

func TestFinalizationAuditAndReleaseCommandsAreWired(t *testing.T) {
	tests := []Invocation{
		{Command: CommandFinalizePrepare, Options: PrepareFinalizationOptions{}},
		{Command: CommandFinalizeComplete, Options: FinalizeOptions{}},
		{Command: CommandAudit, Options: AuditOptions{}},
		{Command: CommandReleaseSign, Options: ReleaseSignOptions{}},
		{Command: CommandReleaseVerify, Options: ReleaseVerifyOptions{}},
		{Command: CommandDecisionPrepare, Options: DecisionPrepareOptions{}},
		{Command: CommandDecisionSign, Options: DecisionSignOptions{}},
		{Command: CommandDecisionVerify, Options: DecisionVerifyOptions{}},
	}
	for _, invocation := range tests {
		t.Run(string(invocation.Command), func(t *testing.T) {
			_, err := (workflowExecutor{}).Execute(context.Background(), invocation)
			if errors.Is(err, errExecutorNotWired) {
				t.Fatalf("%s is exposed by the production CLI but not wired to the ceremony engine", invocation.Command)
			}
		})
	}
}

func TestEveryCommandRejectsWalletAndWitnessSecretInputs(t *testing.T) {
	commands := [][]string{
		{"init"},
		{"phase1", "contribute"},
		{"phase1", "attest-erasure"},
		{"phase1", "verify"},
		{"phase1", "close"},
		{"phase1", "beacon"},
		{"phase1", "seal"},
		{"phase2", "init"},
		{"phase2", "contribute"},
		{"phase2", "attest-erasure"},
		{"phase2", "verify"},
		{"phase2", "close"},
		{"phase2", "beacon"},
		{"finalize"},
		{"audit"},
		{"release", "sign"},
		{"release", "verify"},
		{"decision", "sign"},
		{"decision", "verify"},
		{"ops", "export-signing"},
		{"ops", "import-signature"},
		{"ops", "verify"},
	}
	forbidden := []string{
		"--mnemonic",
		"--seed-phrase",
		"--master-xprv",
		"--wallet-secret",
		"--private-witness",
		"--proving-input",
	}
	for _, command := range commands {
		for _, flag := range forbidden {
			name := strings.Join(command, "_") + "_" + strings.TrimPrefix(flag, "--")
			t.Run(name, func(t *testing.T) {
				args := append(append([]string(nil), command...), flag, "must-not-be-read")
				if _, err := parseInvocation(args); err == nil {
					t.Fatalf("%q unexpectedly accepted secret-bearing flag %q", command, flag)
				}
			})
		}
	}
}
