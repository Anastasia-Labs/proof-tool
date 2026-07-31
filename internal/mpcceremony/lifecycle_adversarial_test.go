// Copyright 2026 Midgard Labs
// SPDX-License-Identifier: Apache-2.0

package mpcceremony

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSignedLifecycleReleaseRejectsCrossArtifactTampering(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping complete signed finalization, operational-evidence, audit, and release lifecycle")
	}
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve lifecycle test source")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(thisFile), "..", ".."))
	binaryDir := t.TempDir()
	workflowHelper := filepath.Join(binaryDir, "workflow-helper")
	operationalHelper := filepath.Join(binaryDir, "operational-helper")
	for output, pkg := range map[string]string{
		workflowHelper:    "./internal/mpcceremony/testdata/workflowhelper",
		operationalHelper: "./scripts/mpc-rehearsal-operational-evidence",
	} {
		command := exec.Command("go", "build", "-o", output, pkg)
		command.Dir = repoRoot
		if combined, err := command.CombinedOutput(); err != nil {
			t.Fatalf("build %s: %v\n%s", pkg, err, combined)
		}
	}

	workflowRoot := filepath.Join(t.TempDir(), "workflow")
	command := exec.Command(workflowHelper, workflowRoot, operationalHelper)
	command.Dir = repoRoot
	if combined, err := command.CombinedOutput(); err != nil {
		t.Fatalf("run complete signed lifecycle: %v\n%s", err, combined)
	}

	ceremonyRoot := filepath.Join(workflowRoot, "ceremony")
	coordinatorPublicKeyPath := filepath.Join(
		workflowRoot,
		"identity-keys",
		"trusted-coordinator.ed25519.public.hex",
	)
	trusted, err := LoadSignedDefinition(TrustPaths{
		DefinitionPath:           filepath.Join(ceremonyRoot, "ceremony.json"),
		DefinitionSignaturePath:  filepath.Join(ceremonyRoot, "ceremony.sig"),
		CoordinatorPublicKeyPath: coordinatorPublicKeyPath,
	})
	if err != nil {
		t.Fatal(err)
	}
	coordinatorPublicKey, err := os.ReadFile(coordinatorPublicKeyPath)
	if err != nil {
		t.Fatal(err)
	}
	releaseDir := filepath.Join(workflowRoot, "release")
	verifyOptions := VerifyReleaseOptions{
		DefinitionPath:          filepath.Join(ceremonyRoot, "ceremony.json"),
		DefinitionSignaturePath: filepath.Join(ceremonyRoot, "ceremony.sig"),
		CoordinatorPublicKeyHex: strings.TrimSpace(string(coordinatorPublicKey)),
		KeysDir:                 releaseDir,
		TrustedPublicKeyHex:     trusted.Definition.ReleaseSigner.Ed25519PublicKeyHex,
		ExpectedSignatureKeyID:  trusted.Definition.ReleaseSigner.KeyID,
		RequireProvingKey:       true,
	}
	verified, err := VerifyRelease(verifyOptions)
	if err != nil {
		t.Fatalf("verify complete signed lifecycle release: %v", err)
	}
	if verified.Candidate.Phase1.Chain.Name != "chain-0002.json" ||
		verified.Candidate.Phase2.Chain.Name != "chain-0002.json" {
		t.Fatalf(
			"candidate does not retain replay-scope accepted-chain names: %q, %q",
			verified.Candidate.Phase1.Chain.Name,
			verified.Candidate.Phase2.Chain.Name,
		)
	}
	var report VerificationReport
	if _, err := readCanonicalFile(
		filepath.Join(releaseDir, verified.Candidate.VerificationReport.Name),
		&report,
	); err != nil {
		t.Fatal(err)
	}
	if !report.NativeProofVerified ||
		!report.WrongCredentialRejected ||
		!report.WrongDestinationRejected ||
		!report.WrongDigestRejected ||
		!report.WrongProofRejected ||
		!report.WrongVKRejected ||
		!report.ProofTruncationRejected ||
		!report.ProofAppendRejected {
		t.Fatalf("finalization report was published without every executed proof check: %+v", report)
	}

	preliminaryClone := filepath.Join(t.TempDir(), "preliminary")
	copyRegularTree(t, filepath.Join(workflowRoot, "preliminary"), preliminaryClone)
	tamperRegularFile(t, filepath.Join(preliminaryClone, NativeVerifyingKeyFile))
	if _, err := VerifyPreliminaryFinalKeys(
		preliminaryClone,
		verifyOptions.CoordinatorPublicKeyHex,
	); err == nil {
		t.Fatal("authenticated preliminary key tree accepted a changed native VK")
	}

	tamperCases := []struct {
		name string
		file string
	}{
		{name: "candidate metadata", file: CandidateMetadataFile},
		{name: "verification report", file: VerificationReportFile},
		{name: "public proof evidence", file: PublicEvidenceFile},
		{name: "native verifying key", file: NativeVerifyingKeyFile},
		{name: "first independent audit", file: "audits/0001.json"},
		{name: "operational bundle", file: OperationalEvidenceBundleFile},
		{name: "authenticated accepted chain", file: "phase1/chain-0002.json"},
		{
			name: "inner returned-custody handoff",
			file: "operational/phase1/heads/0001/return-handoff.json",
		},
		{name: "final transcript", file: FinalTranscriptFile},
		{name: "signed manifest", file: "manifest.json"},
		{name: "release checksums", file: ReleaseChecksumsFile},
	}
	for _, test := range tamperCases {
		t.Run(test.name, func(t *testing.T) {
			clone := filepath.Join(t.TempDir(), "release")
			copyRegularTree(t, releaseDir, clone)
			tamperRegularFile(t, filepath.Join(clone, filepath.FromSlash(test.file)))
			options := verifyOptions
			options.KeysDir = clone
			if _, err := VerifyRelease(options); err == nil {
				t.Fatalf("release verification accepted changed %s", test.file)
			}
		})
	}
}

func copyRegularTree(t *testing.T, source, destination string) {
	t.Helper()
	err := filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, relative)
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("test source tree contains a symlink")
		}
		if entry.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		if !entry.Type().IsRegular() {
			return errors.New("test source tree contains a non-regular file")
		}
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			_ = input.Close()
			return err
		}
		if _, err := io.Copy(output, input); err != nil {
			_ = input.Close()
			_ = output.Close()
			return err
		}
		if err := input.Close(); err != nil {
			_ = output.Close()
			return err
		}
		return output.Close()
	})
	if err != nil {
		t.Fatal(err)
	}
}

func tamperRegularFile(t *testing.T, path string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) == 0 {
		t.Fatalf("cannot tamper empty file %s", path)
	}
	data[len(data)/2] ^= 1
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}
