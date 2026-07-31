// Copyright 2026 Midgard Labs
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/consensys/gnark/logger"
)

func main() {
	// gnark defaults its global logger to stdout. Keep stdout exclusively for
	// the CLI result contract, especially the single JSON object promised by
	// --format json.
	logger.SetOutput(os.Stderr)
	os.Exit(runCLI(context.Background(), os.Args[1:], os.Stdout, os.Stderr, workflowExecutor{}))
}

func runCLI(ctx context.Context, args []string, stdout, stderr io.Writer, executor Executor) int {
	invocation, err := parseInvocation(args)
	if err != nil {
		var help *helpRequest
		if errors.As(err, &help) {
			if err := writeUsage(stdout, help.topic); err != nil {
				writeDiagnostic(stderr, "error: write help: %v\n", err)
				return 6
			}
			return 0
		}
		var usage *usageError
		if errors.As(err, &usage) {
			message := redactCLIError(usage.message, args)
			if requestsJSON(args) {
				return writeParseError(message, stdout, stderr)
			}
			if _, err := fmt.Fprintf(stderr, "error: %s\n\n", message); err != nil {
				return 6
			}
			if err := writeUsage(stderr, usage.topic); err != nil {
				return 6
			}
			return 2
		}
		writeDiagnostic(stderr, "error: %s\n", redactCLIError(err.Error(), args))
		return 6
	}

	if executor == nil {
		executor = unwiredExecutor{}
	}
	result, err := executor.Execute(ctx, invocation)
	if err != nil {
		return writeExecutionError(invocation, err, args, stdout, stderr)
	}
	result.Schema = commandResultSchema
	result.OK = true
	result.Command = invocation.Command
	if invocation.Global.Format == "json" {
		if err := json.NewEncoder(stdout).Encode(result); err != nil {
			writeDiagnostic(stderr, "error: encode command result: %v\n", err)
			return 6
		}
		return 0
	}
	if result.Summary != "" {
		if _, err := fmt.Fprintln(stdout, result.Summary); err != nil {
			writeDiagnostic(stderr, "error: write command result: %v\n", err)
			return 6
		}
	} else {
		if _, err := fmt.Fprintf(stdout, "%s completed\n", invocation.Command); err != nil {
			writeDiagnostic(stderr, "error: write command result: %v\n", err)
			return 6
		}
	}
	names := make([]string, 0, len(result.Outputs))
	for name := range result.Outputs {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		path := result.Outputs[name]
		if _, err := fmt.Fprintf(stdout, "%s: %s\n", name, path); err != nil {
			writeDiagnostic(stderr, "error: write command result: %v\n", err)
			return 6
		}
	}
	return 0
}

func writeExecutionError(invocation Invocation, err error, args []string, stdout, stderr io.Writer) int {
	exitCode := 6
	code := "internal_error"
	if errors.Is(err, errExecutorNotWired) {
		code = "engine_not_wired"
	}
	message := redactCLIError(err.Error(), args)
	if invocation.Global.Format == "json" {
		payload := struct {
			Schema  string  `json:"schema"`
			OK      bool    `json:"ok"`
			Command Command `json:"command"`
			Error   struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}{
			Schema:  commandResultSchema,
			OK:      false,
			Command: invocation.Command,
		}
		payload.Error.Code = code
		payload.Error.Message = message
		if encodeErr := json.NewEncoder(stdout).Encode(payload); encodeErr != nil {
			writeDiagnostic(stderr, "error: encode command error: %v\n", encodeErr)
		}
		return exitCode
	}
	writeDiagnostic(stderr, "error: %s\n", message)
	return exitCode
}

const redactedCLIValue = "<redacted>"

// redactCLIError keeps command-line values out of diagnostics. In particular,
// unexpected positionals can be seed phrases, while participant identifiers
// and private-key paths can expose operator-specific ceremony details. Error
// messages remain useful, but values supplied by the caller are never echoed.
func redactCLIError(message string, args []string) string {
	safeCommandArguments := identifyCLICommandArguments(args)
	candidates := make(map[string]struct{})
	for index, arg := range args {
		if _, safe := safeCommandArguments[index]; safe {
			continue
		}
		if name, value, found := strings.Cut(arg, "="); found && strings.HasPrefix(name, "-") {
			addCLIErrorCandidate(candidates, value)
			addCLIErrorCandidate(candidates, name)
			addCLIErrorCandidate(candidates, "-"+strings.TrimLeft(name, "-"))
			continue
		}
		addCLIErrorCandidate(candidates, arg)
		if strings.HasPrefix(arg, "-") {
			addCLIErrorCandidate(candidates, "-"+strings.TrimLeft(arg, "-"))
		}
	}

	ordered := make([]string, 0, len(candidates))
	for candidate := range candidates {
		ordered = append(ordered, candidate)
	}
	sort.Slice(ordered, func(i, j int) bool {
		return len(ordered[i]) > len(ordered[j])
	})
	for _, candidate := range ordered {
		message = strings.ReplaceAll(message, candidate, redactedCLIValue)
	}
	return message
}

func identifyCLICommandArguments(args []string) map[int]struct{} {
	safe := make(map[int]struct{})
	index := 0
	for index < len(args) {
		switch {
		case args[index] == "--format":
			index += 2
		case strings.HasPrefix(args[index], "--format="):
			index++
		case args[index] == "--quiet" || args[index] == "--help":
			index++
		case strings.HasPrefix(args[index], "-"):
			index++
		default:
			goto command
		}
	}
	return safe

command:
	topLevel := map[string]struct{}{
		"audit": {}, "decision": {}, "finalize": {}, "help": {}, "init": {},
		"ops": {}, "phase1": {}, "phase2": {}, "release": {},
	}
	if _, ok := topLevel[args[index]]; !ok {
		return safe
	}
	safe[index] = struct{}{}

	subcommands := map[string]map[string]struct{}{
		"phase1": {
			"attest-erasure": {}, "beacon": {}, "close": {},
			"contribute": {}, "help": {}, "seal": {}, "verify": {},
		},
		"phase2": {
			"attest-erasure": {}, "beacon": {}, "close": {},
			"contribute": {}, "help": {}, "init": {}, "verify": {},
		},
		"decision": {"help": {}, "prepare": {}, "sign": {}, "verify": {}},
		"ops":      {"export-signing": {}, "help": {}, "import-signature": {}, "verify": {}},
		"release":  {"help": {}, "sign": {}, "verify": {}},
	}
	allowed, hasSubcommands := subcommands[args[index]]
	if hasSubcommands && index+1 < len(args) {
		if _, ok := allowed[args[index+1]]; ok {
			safe[index+1] = struct{}{}
		}
	}
	return safe
}

func addCLIErrorCandidate(candidates map[string]struct{}, value string) {
	if value == "" || value == "-" || value == "--" {
		return
	}
	candidates[value] = struct{}{}
}

func writeDiagnostic(w io.Writer, format string, args ...any) {
	_, _ = fmt.Fprintf(w, format, args...)
}

func requestsJSON(args []string) bool {
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--format" && i+1 < len(args):
			return args[i+1] == "json"
		case args[i] == "--format=json":
			return true
		case len(args[i]) == 0 || args[i][0] != '-':
			return false
		}
	}
	return false
}

func writeParseError(message string, stdout, stderr io.Writer) int {
	payload := struct {
		Schema string `json:"schema"`
		OK     bool   `json:"ok"`
		Error  struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}{
		Schema: commandResultSchema,
		OK:     false,
	}
	payload.Error.Code = "usage_error"
	payload.Error.Message = message
	if err := json.NewEncoder(stdout).Encode(payload); err != nil {
		writeDiagnostic(stderr, "error: encode usage error: %v\n", err)
		return 6
	}
	return 2
}
