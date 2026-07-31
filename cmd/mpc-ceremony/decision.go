// Copyright 2026 Midgard Labs
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"

	"proof-tool/internal/keybundle"
	"proof-tool/internal/mpcceremony"
)

func executeDecisionPrepare(options DecisionPrepareOptions) (CommandResult, error) {
	trusted, err := mpcceremony.LoadSignedDefinition(mpcceremony.TrustPaths{
		DefinitionPath:           options.CeremonyPath,
		DefinitionSignaturePath:  options.CeremonySignaturePath,
		CoordinatorPublicKeyPath: options.CoordinatorPublicKeyFile,
	})
	if err != nil {
		return CommandResult{}, err
	}
	draftBytes, err := readRegularOperationalFile(options.DraftPath, maxOperationalRecordBytes)
	if err != nil {
		return CommandResult{}, err
	}
	decision, decisionBytes, err := mpcceremony.PrepareProductionDecision(
		trusted.Definition,
		draftBytes,
	)
	if err != nil {
		return CommandResult{}, err
	}
	if err := writeFreshOperationalFile(options.OutPath, decisionBytes, 0o600); err != nil {
		return CommandResult{}, err
	}
	return decisionCommandResult(
		decision,
		fmt.Sprintf(
			"prepared exact canonical %s production decision for independent signing",
			decision.Decision,
		),
		map[string]string{
			"draft":    options.DraftPath,
			"decision": options.OutPath,
		},
	), nil
}

func executeDecisionSign(options DecisionSignOptions) (CommandResult, error) {
	trusted, err := mpcceremony.LoadSignedDefinition(mpcceremony.TrustPaths{
		DefinitionPath:           options.CeremonyPath,
		DefinitionSignaturePath:  options.CeremonySignaturePath,
		CoordinatorPublicKeyPath: options.CoordinatorPublicKeyFile,
	})
	if err != nil {
		return CommandResult{}, err
	}
	decisionBytes, err := readRegularOperationalFile(options.DecisionPath, maxOperationalRecordBytes)
	if err != nil {
		return CommandResult{}, err
	}
	var decision mpcceremony.ProductionDecision
	if err := mpcceremony.UnmarshalCanonical(decisionBytes, &decision); err != nil {
		return CommandResult{}, err
	}
	if decision.Decision == mpcceremony.DecisionGO && options.EvidenceRoot == "" {
		return CommandResult{}, fmt.Errorf("--evidence-root is required before signing a GO decision")
	}
	if options.EvidenceRoot != "" {
		if _, err := mpcceremony.VerifyProductionDecisionEvidence(
			mpcceremony.VerifyProductionDecisionEvidenceOptions{
				Definition:    trusted.Definition,
				DecisionBytes: decisionBytes,
				EvidenceRoot:  options.EvidenceRoot,
			},
		); err != nil {
			return CommandResult{}, fmt.Errorf("refuse to sign unverified decision evidence: %w", err)
		}
	}
	privateKey, _, err := keybundle.LoadExistingPrivateKey(options.SigningKey)
	if err != nil {
		return CommandResult{}, err
	}
	signatureBytes, err := mpcceremony.SignProductionDecision(
		trusted.Definition,
		decisionBytes,
		mpcceremony.DecisionSignerRole(options.Role),
		options.SignerID,
		privateKey,
	)
	if err != nil {
		return CommandResult{}, err
	}
	if err := writeFreshOperationalFile(options.OutPath, signatureBytes, 0o600); err != nil {
		return CommandResult{}, err
	}
	return decisionCommandResult(
		decision,
		fmt.Sprintf(
			"signed exact canonical %s production decision as %s",
			decision.Decision,
			options.Role,
		),
		map[string]string{
			"decision":  options.DecisionPath,
			"signature": options.OutPath,
		},
	), nil
}

func decisionCommandResult(
	decision mpcceremony.ProductionDecision,
	summary string,
	outputs map[string]string,
) CommandResult {
	return CommandResult{
		CeremonyID:                 decision.CeremonyID,
		Decision:                   string(decision.Decision),
		DecisionID:                 decision.DecisionID,
		ReleaseID:                  decision.Release.ReleaseID,
		CandidateID:                decision.Release.CandidateID,
		SourceCommit:               decision.SourceRelease.SourceCommit,
		SourceSignedTag:            decision.SourceRelease.SignedTag,
		SourceTagSignerFingerprint: decision.SourceRelease.SignerFingerprintHex,
		SourceTagObjectSHA256:      decision.SourceRelease.SignedTagObject.Artifact.Digest.SHA256,
		Summary:                    summary,
		Outputs:                    outputs,
	}
}

func executeDecisionVerify(options DecisionVerifyOptions) (CommandResult, error) {
	trusted, err := mpcceremony.LoadSignedDefinition(mpcceremony.TrustPaths{
		DefinitionPath:           options.CeremonyPath,
		DefinitionSignaturePath:  options.CeremonySignaturePath,
		CoordinatorPublicKeyPath: options.CoordinatorPublicKeyFile,
	})
	if err != nil {
		return CommandResult{}, err
	}
	decisionBytes, err := readRegularOperationalFile(options.DecisionPath, maxOperationalRecordBytes)
	if err != nil {
		return CommandResult{}, err
	}
	signatures := make([][]byte, len(options.SignaturePaths))
	for index, path := range options.SignaturePaths {
		signatures[index], err = readRegularOperationalFile(path, maxOperationalRecordBytes)
		if err != nil {
			return CommandResult{}, fmt.Errorf("decision signature %d: %w", index, err)
		}
	}
	verified, err := mpcceremony.VerifyProductionDecision(mpcceremony.VerifyProductionDecisionOptions{
		Definition:     trusted.Definition,
		DecisionBytes:  decisionBytes,
		SignatureBytes: signatures,
		EvidenceRoot:   options.EvidenceRoot,
	})
	if err != nil {
		return CommandResult{}, err
	}
	return decisionCommandResult(
		verified.Decision,
		fmt.Sprintf(
			"verified %s production decision, %d exact role signatures, and %d pinned evidence artifacts",
			verified.Decision.Decision,
			len(verified.VerifiedSigners),
			len(verified.VerifiedArtifacts),
		),
		map[string]string{
			"decision":      options.DecisionPath,
			"evidence_root": options.EvidenceRoot,
		},
	), nil
}
