// Command mpc-rehearsal-operational-evidence builds complete, signed
// operational evidence for the same-host K=21 rehearsal. It is not a
// production enrollment or witnessing tool.
package main

import (
	"crypto/ed25519"
	"encoding/csv"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"proof-tool/internal/keybundle"
	"proof-tool/internal/mpcceremony"
)

const resultSchema = "proof-tool-mpc-rehearsal-operational-evidence-result-v1"

type signer struct {
	identity mpcceremony.Identity
	key      ed25519.PrivateKey
	role     mpcceremony.EnrollmentRole
	index    uint16
}

type relayInput struct {
	relayID        string
	operatorID     string
	endpointSHA256 string
	retrievedAt    string
	filename       string
	raw            []byte
}

type phaseResult struct {
	evidence mpcceremony.PhaseOperationalEvidence
	close    mpcceremony.AuthenticatedCloseEvidence
}

func main() {
	transcriptRoot := flag.String("transcript-root", "", "exact rehearsal transcript/evidence root")
	keysDir := flag.String("keys-dir", "", "rehearsal-only identity key directory")
	coordinatorPublicKey := flag.String(
		"coordinator-public-key-file",
		"",
		"out-of-band coordinator public key",
	)
	phase1Relays := flag.String("phase1-relays", "", "Phase 1 explicit relay input directory")
	phase2Relays := flag.String("phase2-relays", "", "Phase 2 explicit relay input directory")
	assembledAt := flag.String("assembled-at", "", "bundle assembly time in RFC3339 UTC")
	outDir := flag.String(
		"out-dir",
		"",
		"transcript-root/operational directory (fresh or exact completed retry)",
	)
	flag.Parse()
	if flag.NArg() != 0 || *transcriptRoot == "" || *keysDir == "" ||
		*coordinatorPublicKey == "" || *phase1Relays == "" || *phase2Relays == "" ||
		*assembledAt == "" || *outDir == "" {
		fmt.Fprintln(
			os.Stderr,
			"usage: mpc-rehearsal-operational-evidence --transcript-root DIR --keys-dir DIR "+
				"--coordinator-public-key-file FILE --phase1-relays DIR --phase2-relays DIR "+
				"--assembled-at RFC3339_UTC --out-dir OPERATIONAL_DIR",
		)
		os.Exit(2)
	}
	result, err := build(
		*transcriptRoot,
		*keysDir,
		*coordinatorPublicKey,
		*phase1Relays,
		*phase2Relays,
		*assembledAt,
		*outDir,
	)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func build(
	transcriptRoot,
	keysDir,
	coordinatorPublicKey,
	phase1RelayDir,
	phase2RelayDir,
	assembledAt,
	outDir string,
) (map[string]any, error) {
	transcriptRoot, err := realDirectory(transcriptRoot)
	if err != nil {
		return nil, fmt.Errorf("transcript root: %w", err)
	}
	keysDir, err = realDirectory(keysDir)
	if err != nil {
		return nil, fmt.Errorf("keys directory: %w", err)
	}
	outParent, err := realDirectory(filepath.Dir(outDir))
	if err != nil {
		return nil, fmt.Errorf("output parent: %w", err)
	}
	outDir = filepath.Join(outParent, filepath.Base(outDir))
	if outParent != transcriptRoot || filepath.Base(outDir) != "operational" {
		return nil, errors.New("output must be the fresh transcript-root/operational directory")
	}
	if _, err := time.Parse(time.RFC3339, assembledAt); err != nil {
		return nil, fmt.Errorf("assembled-at: %w", err)
	}

	trusted, err := mpcceremony.LoadSignedDefinition(mpcceremony.TrustPaths{
		DefinitionPath:           filepath.Join(transcriptRoot, "ceremony.json"),
		DefinitionSignaturePath:  filepath.Join(transcriptRoot, "ceremony.sig"),
		CoordinatorPublicKeyPath: coordinatorPublicKey,
	})
	if err != nil {
		return nil, err
	}
	definition := trusted.Definition
	definitionBytes, err := readRegular(filepath.Join(transcriptRoot, "ceremony.json"), 16<<20)
	if err != nil {
		return nil, err
	}
	signers, err := loadSigners(definition, keysDir)
	if err != nil {
		return nil, err
	}
	coordinator := signers[definition.Coordinator.ID]

	stagingDir, err := createCompletedOutputStaging(outDir)
	if err != nil {
		return nil, fmt.Errorf("create operational evidence staging root: %w", err)
	}
	defer func() {
		_ = os.RemoveAll(stagingDir)
	}()

	enrollments := make([]mpcceremony.SignedArtifactRefs, 0, len(signers))
	signerIDs := make([]string, 0, len(signers))
	for id := range signers {
		signerIDs = append(signerIDs, id)
	}
	slices.Sort(signerIDs)
	createdAt, err := parseTimestamp("definition created_at", definition.CreatedAt)
	if err != nil {
		return nil, err
	}
	for _, id := range signerIDs {
		item := signers[id]
		disclosureName := "operational/disclosures/" + id + ".json"
		disclosureBytes := []byte(
			fmt.Sprintf(
				"{\"schema\":\"proof-tool-mpc-rehearsal-independence-disclosure-v1\",\"identity_id\":%q,\"same_host\":true}\n",
				id,
			),
		)
		if err := writeRelative(stagingDir, disclosureName, disclosureBytes); err != nil {
			return nil, err
		}
		record, err := mpcceremony.NewEnrollmentRecord(
			definition,
			definitionBytes,
			item.identity,
			item.role,
			item.index,
			mpcceremony.ArtifactRef{
				Name:   disclosureName,
				Digest: mpcceremony.NewDigest(disclosureBytes),
			},
			createdAt.Add(time.Second).Format(time.RFC3339Nano),
		)
		if err != nil {
			return nil, err
		}
		pair, err := writeSignedPair(
			stagingDir,
			"operational/enrollments/"+id,
			record,
			item.identity.KeyID,
			item.key,
		)
		if err != nil {
			return nil, err
		}
		enrollments = append(enrollments, pair)
	}

	phase1, err := buildPhase(
		transcriptRoot,
		stagingDir,
		definition,
		signers,
		mpcceremony.Phase1,
		phase1RelayDir,
	)
	if err != nil {
		return nil, fmt.Errorf("phase1: %w", err)
	}
	phase2, err := buildPhase(
		transcriptRoot,
		stagingDir,
		definition,
		signers,
		mpcceremony.Phase2,
		phase2RelayDir,
	)
	if err != nil {
		return nil, fmt.Errorf("phase2: %w", err)
	}
	bundle := mpcceremony.OperationalEvidenceBundle{
		Schema:           mpcceremony.OperationalEvidenceBundleSchema,
		CeremonyID:       definition.CeremonyID,
		Enrollments:      enrollments,
		Phase1:           phase1.evidence,
		Phase2:           phase2.evidence,
		CoordinatorID:    definition.Coordinator.ID,
		CoordinatorKeyID: definition.Coordinator.KeyID,
		AssembledAt:      assembledAt,
	}
	bundleBytes, bundleSignature, err := mpcceremony.SignRecord(
		bundle,
		definition.Coordinator.KeyID,
		coordinator.key,
	)
	if err != nil {
		return nil, err
	}
	if err := writeRelative(
		stagingDir,
		"operational/evidence-bundle.json",
		bundleBytes,
	); err != nil {
		return nil, err
	}
	if err := writeRelative(
		stagingDir,
		"operational/evidence-bundle.sig",
		bundleSignature,
	); err != nil {
		return nil, err
	}
	verificationRoot, err := createOperationalVerificationRoot(transcriptRoot, stagingDir)
	if err != nil {
		return nil, fmt.Errorf("create operational evidence verification root: %w", err)
	}
	defer func() {
		_ = os.RemoveAll(verificationRoot)
	}()
	var verified mpcceremony.VerifiedOperationalEvidence
	if err := verifyThenPublishCompletedDirectory(stagingDir, outDir, func() error {
		var verifyErr error
		verified, verifyErr = mpcceremony.VerifyOperationalEvidenceBundle(
			mpcceremony.VerifyOperationalEvidenceOptions{
				Definition:           definition,
				CoordinatorPublicKey: trusted.CoordinatorPublicKey,
				EvidenceRoot:         verificationRoot,
				BundleBytes:          bundleBytes,
				BundleSignatureBytes: bundleSignature,
				Phase1Close:          phase1.close,
				Phase2Close:          phase2.close,
			},
		)
		return verifyErr
	}); err != nil {
		return nil, fmt.Errorf("complete operational evidence: %w", err)
	}
	return map[string]any{
		"schema":               resultSchema,
		"ok":                   true,
		"ceremony_id":          definition.CeremonyID,
		"bundle_sha256":        verified.BundleDigest.SHA256,
		"referenced_artifacts": len(verified.ReferencedArtifacts),
		"out":                  outDir,
	}, nil
}

func buildPhase(
	root,
	stagingDir string,
	definition mpcceremony.CeremonyDefinition,
	signers map[string]signer,
	phase mpcceremony.Phase,
	relayDir string,
) (phaseResult, error) {
	policy, err := definition.PolicyForPhase(phase)
	if err != nil {
		return phaseResult{}, err
	}
	sequence := fmt.Sprintf("%04d", len(policy.Participants))
	phaseName := string(phase)
	chainName := phaseName + "/chain-" + sequence + ".json"
	chainSignatureName := phaseName + "/chain-" + sequence + ".sig"
	closeName := phaseName + "/closure/record.json"
	closeSignatureName := phaseName + "/closure/record.sig"
	chainBytes, err := readRegular(filepath.Join(root, filepath.FromSlash(chainName)), 16<<20)
	if err != nil {
		return phaseResult{}, err
	}
	chainSignatureBytes, err := readRegular(
		filepath.Join(root, filepath.FromSlash(chainSignatureName)),
		16<<20,
	)
	if err != nil {
		return phaseResult{}, err
	}
	closeBytes, err := readRegular(filepath.Join(root, filepath.FromSlash(closeName)), 16<<20)
	if err != nil {
		return phaseResult{}, err
	}
	closeSignatureBytes, err := readRegular(
		filepath.Join(root, filepath.FromSlash(closeSignatureName)),
		16<<20,
	)
	if err != nil {
		return phaseResult{}, err
	}
	var chain mpcceremony.Chain
	if err := mpcceremony.UnmarshalCanonical(chainBytes, &chain); err != nil {
		return phaseResult{}, err
	}
	var closeRecord mpcceremony.CloseRecord
	if err := mpcceremony.UnmarshalCanonical(closeBytes, &closeRecord); err != nil {
		return phaseResult{}, err
	}
	coordinator := signers[definition.Coordinator.ID]
	heads := make([]mpcceremony.AcceptedHeadOperationalEvidence, len(chain.Records))
	for index, chainRecord := range chain.Records {
		participant := signers[chainRecord.ParticipantID]
		prefixSequence := fmt.Sprintf("%04d", index+1)
		prefixName := phaseName + "/chain-" + prefixSequence + ".json"
		prefixSignatureName := phaseName + "/chain-" + prefixSequence + ".sig"
		prefixBytes, err := readRegular(
			filepath.Join(root, filepath.FromSlash(prefixName)),
			16<<20,
		)
		if err != nil {
			return phaseResult{}, err
		}
		prefixSignatureBytes, err := readRegular(
			filepath.Join(root, filepath.FromSlash(prefixSignatureName)),
			16<<20,
		)
		if err != nil {
			return phaseResult{}, err
		}
		prefixPair := mpcceremony.SignedArtifactRefs{
			Record: mpcceremony.ArtifactRef{
				Name:   prefixName,
				Digest: mpcceremony.NewDigest(prefixBytes),
			},
			Signature: mpcceremony.ArtifactRef{
				Name:   prefixSignatureName,
				Digest: mpcceremony.NewDigest(prefixSignatureBytes),
			},
		}
		attestationBytes, err := readRegular(
			filepath.Join(root, filepath.FromSlash(chainRecord.Attestation.Name)),
			16<<20,
		)
		if err != nil {
			return phaseResult{}, err
		}
		var attestation mpcceremony.ContributionAttestation
		if err := mpcceremony.UnmarshalCanonical(attestationBytes, &attestation); err != nil {
			return phaseResult{}, err
		}
		erasureBytes, err := readRegular(
			filepath.Join(root, filepath.FromSlash(chainRecord.Erasure.Name)),
			16<<20,
		)
		if err != nil {
			return phaseResult{}, err
		}
		var erasure mpcceremony.ErasureAttestation
		if err := mpcceremony.UnmarshalCanonical(erasureBytes, &erasure); err != nil {
			return phaseResult{}, err
		}
		contributedAt, err := parseTimestamp("contributed_at", attestation.ContributedAt)
		if err != nil {
			return phaseResult{}, err
		}
		destroyedAt, err := parseTimestamp("destroyed_at", erasure.DestroyedAt)
		if err != nil {
			return phaseResult{}, err
		}
		acceptedAt, err := parseTimestamp("accepted_at", chainRecord.AcceptedAt)
		if err != nil {
			return phaseResult{}, err
		}
		predecessorAcceptedAt, err := parseTimestamp("definition created_at", definition.CreatedAt)
		if err != nil {
			return phaseResult{}, err
		}
		if index > 0 {
			predecessorAcceptedAt, err = parseTimestamp(
				"predecessor accepted_at",
				chain.Records[index-1].AcceptedAt,
			)
			if err != nil {
				return phaseResult{}, err
			}
		}
		outboundCreatedAt, outboundReceivedAt, err := twoInteriorTimestamps(
			predecessorAcceptedAt,
			contributedAt,
		)
		if err != nil {
			return phaseResult{}, fmt.Errorf("accepted head %d outbound custody: %w", index+1, err)
		}
		returnLowerBound := contributedAt
		if destroyedAt.After(returnLowerBound) {
			returnLowerBound = destroyedAt
		}
		returnCreatedAt, returnReceivedAt, err := twoInteriorTimestamps(
			returnLowerBound,
			acceptedAt,
		)
		if err != nil {
			return phaseResult{}, fmt.Errorf("accepted head %d returned custody: %w", index+1, err)
		}

		outboundFiles := []mpcceremony.ArtifactRef{chainRecord.PreviousPayload}
		outbound, err := mpcceremony.NewTransferHandoff(
			definition,
			phase,
			uint8(index+1),
			chainRecord.PreviousRecordID,
			outboundFiles,
			coordinator.identity,
			participant.identity,
			outboundCreatedAt,
			contributedAt.Format(time.RFC3339Nano),
		)
		if err != nil {
			return phaseResult{}, err
		}
		outboundBytes, err := mpcceremony.MarshalCanonical(outbound)
		if err != nil {
			return phaseResult{}, err
		}
		stem := fmt.Sprintf("operational/%s/heads/%04d", phaseName, index+1)
		outboundPair, err := writeSignedPair(
			stagingDir,
			stem+"/outbound-handoff",
			outbound,
			coordinator.identity.KeyID,
			coordinator.key,
		)
		if err != nil {
			return phaseResult{}, err
		}
		outboundReceipt, err := mpcceremony.NewTransferReceipt(
			outbound,
			outboundBytes,
			mpcceremony.ReceiptReceiver,
			outboundReceivedAt,
		)
		if err != nil {
			return phaseResult{}, err
		}
		outboundReceiptPair, err := writeSignedPair(
			stagingDir,
			stem+"/outbound-receipt",
			outboundReceipt,
			participant.identity.KeyID,
			participant.key,
		)
		if err != nil {
			return phaseResult{}, err
		}

		returnFiles := []mpcceremony.ArtifactRef{
			chainRecord.OutputPayload,
			chainRecord.Attestation,
			chainRecord.AttestationSignature,
			chainRecord.Erasure,
			chainRecord.ErasureSignature,
		}
		slices.SortFunc(returnFiles, func(a, b mpcceremony.ArtifactRef) int {
			return strings.Compare(a.Name, b.Name)
		})
		returnHandoff, err := mpcceremony.NewTransferHandoff(
			definition,
			phase,
			uint8(index+1),
			chainRecord.PreviousRecordID,
			returnFiles,
			participant.identity,
			coordinator.identity,
			returnCreatedAt,
			acceptedAt.Format(time.RFC3339Nano),
		)
		if err != nil {
			return phaseResult{}, err
		}
		returnHandoffBytes, err := mpcceremony.MarshalCanonical(returnHandoff)
		if err != nil {
			return phaseResult{}, err
		}
		returnHandoffPair, err := writeSignedPair(
			stagingDir,
			stem+"/return-handoff",
			returnHandoff,
			participant.identity.KeyID,
			participant.key,
		)
		if err != nil {
			return phaseResult{}, err
		}
		returnReceipt, err := mpcceremony.NewTransferReceipt(
			returnHandoff,
			returnHandoffBytes,
			mpcceremony.ReceiptReceiver,
			returnReceivedAt,
		)
		if err != nil {
			return phaseResult{}, err
		}
		returnReceiptPair, err := writeSignedPair(
			stagingDir,
			stem+"/return-receipt",
			returnReceipt,
			coordinator.identity.KeyID,
			coordinator.key,
		)
		if err != nil {
			return phaseResult{}, err
		}
		mirrorFiles := append([]mpcceremony.ArtifactRef(nil), returnFiles...)
		mirrorFiles = append(
			mirrorFiles,
			chainRecord.Verification,
			prefixPair.Record,
			prefixPair.Signature,
		)
		slices.SortFunc(mirrorFiles, func(a, b mpcceremony.ArtifactRef) int {
			return strings.Compare(a.Name, b.Name)
		})
		mirrorPairs := make([]mpcceremony.SignedArtifactRefs, 0, 2)
		for _, mirrorID := range []string{"mirror-01", "mirror-02"} {
			mirror := signers[mirrorID]
			record, err := mpcceremony.NewImmutableMirrorReceipt(
				definition.CeremonyID,
				phase,
				uint8(index+1),
				chainRecord.RecordID,
				mirrorFiles,
				mirror.identity,
				mpcceremony.NewDigest(
					[]byte("same-host-rehearsal-mirror:"+phaseName+":"+sequence+":"+mirrorID),
				).SHA256,
				acceptedAt.Add(time.Second).Format(time.RFC3339Nano),
			)
			if err != nil {
				return phaseResult{}, err
			}
			pair, err := writeSignedPair(
				stagingDir,
				stem+"/mirrors/"+mirrorID,
				record,
				mirror.identity.KeyID,
				mirror.key,
			)
			if err != nil {
				return phaseResult{}, err
			}
			mirrorPairs = append(mirrorPairs, pair)
		}
		heads[index] = mpcceremony.AcceptedHeadOperationalEvidence{
			Index:               uint8(index + 1),
			PredecessorHeadID:   chainRecord.PreviousRecordID,
			AcceptedHeadID:      chainRecord.RecordID,
			OutboundHandoff:     outboundPair,
			OutboundReceipt:     outboundReceiptPair,
			ReturnHandoff:       returnHandoffPair,
			ReturnReceipt:       returnReceiptPair,
			AcceptedChainPrefix: prefixPair,
			MirrorReceipts:      mirrorPairs,
		}
	}

	witnessPairs := make([]mpcceremony.SignedArtifactRefs, 0, 2)
	closedAt, err := parseTimestamp("closed_at", closeRecord.ClosedAt)
	if err != nil {
		return phaseResult{}, err
	}
	for _, witnessID := range []string{"witness-01", "witness-02"} {
		witness := signers[witnessID]
		record, err := mpcceremony.NewPublicWitnessReceipt(
			definition,
			closeRecord,
			closeBytes,
			witness.identity,
			closeName,
			mpcceremony.NewDigest(
				[]byte("same-host-rehearsal-witness:"+phaseName+":"+witnessID),
			).SHA256,
			closedAt.Add(time.Second).Format(time.RFC3339Nano),
		)
		if err != nil {
			return phaseResult{}, err
		}
		pair, err := writeSignedPair(
			stagingDir,
			"operational/"+phaseName+"/witnesses/"+witnessID,
			record,
			witness.identity.KeyID,
			witness.key,
		)
		if err != nil {
			return phaseResult{}, err
		}
		witnessPairs = append(witnessPairs, pair)
	}

	relays, err := loadRelayInputs(relayDir)
	if err != nil {
		return phaseResult{}, err
	}
	rawResponses := make(map[string][]byte, len(relays))
	rawRefs := make([]mpcceremony.ArtifactRef, len(relays))
	observations := make([]mpcceremony.RelayObservation, len(relays))
	var latestRetrieved time.Time
	for index, relay := range relays {
		name := "operational/" + phaseName + "/beacon/raw/" + relay.relayID + ".json"
		if err := writeRelative(stagingDir, name, relay.raw); err != nil {
			return phaseResult{}, err
		}
		randomness, err := mpcceremony.VerifyDrandBeaconResponse(
			definition.BeaconPolicy,
			closeRecord.BeaconRound,
			relay.raw,
		)
		if err != nil {
			return phaseResult{}, err
		}
		rawRefs[index] = mpcceremony.ArtifactRef{Name: name, Digest: mpcceremony.NewDigest(relay.raw)}
		observations[index] = mpcceremony.RelayObservation{
			RelayID:            relay.relayID,
			OperatorID:         relay.operatorID,
			EndpointSHA256:     relay.endpointSHA256,
			RawResponse:        rawRefs[index],
			RetrievedAt:        relay.retrievedAt,
			VerifiedRandomness: randomness,
		}
		retrieved, _ := time.Parse(time.RFC3339, relay.retrievedAt)
		if retrieved.After(latestRetrieved) {
			latestRetrieved = retrieved
		}
		rawResponses[relay.relayID] = relay.raw
	}
	beaconEvidence, err := mpcceremony.NewMultiRelayBeaconEvidence(
		definition,
		closeRecord,
		observations,
		rawResponses,
		latestRetrieved.Add(time.Second).Format(time.RFC3339Nano),
	)
	if err != nil {
		return phaseResult{}, err
	}
	beaconPair, err := writeSignedPair(
		stagingDir,
		"operational/"+phaseName+"/beacon/evidence",
		beaconEvidence,
		coordinator.identity.KeyID,
		coordinator.key,
	)
	if err != nil {
		return phaseResult{}, err
	}
	return phaseResult{
		evidence: mpcceremony.PhaseOperationalEvidence{
			Phase: phase,
			AcceptedChain: mpcceremony.SignedArtifactRefs{
				Record:    mpcceremony.ArtifactRef{Name: chainName, Digest: mpcceremony.NewDigest(chainBytes)},
				Signature: mpcceremony.ArtifactRef{Name: chainSignatureName, Digest: mpcceremony.NewDigest(chainSignatureBytes)},
			},
			Close: mpcceremony.SignedArtifactRefs{
				Record:    mpcceremony.ArtifactRef{Name: closeName, Digest: mpcceremony.NewDigest(closeBytes)},
				Signature: mpcceremony.ArtifactRef{Name: closeSignatureName, Digest: mpcceremony.NewDigest(closeSignatureBytes)},
			},
			AcceptedHeads:            heads,
			PublicWitnessQuorum:      2,
			PublicWitnessReceipts:    witnessPairs,
			MultiRelayBeaconEvidence: beaconPair,
			RawBeaconResponses:       rawRefs,
		},
		close: mpcceremony.AuthenticatedCloseEvidence{
			Record:         closeRecord,
			RecordBytes:    closeBytes,
			SignatureBytes: closeSignatureBytes,
		},
	}, nil
}

func loadSigners(
	definition mpcceremony.CeremonyDefinition,
	keysDir string,
) (map[string]signer, error) {
	result := make(map[string]signer)
	add := func(identity mpcceremony.Identity, role mpcceremony.EnrollmentRole, index uint16) error {
		key, publicKey, err := keybundle.LoadExistingPrivateKey(
			filepath.Join(keysDir, identity.ID+".ed25519.private.hex"),
		)
		if err != nil {
			return err
		}
		if identity.Ed25519PublicKeyHex != fmt.Sprintf("%x", publicKey) {
			return fmt.Errorf("private key does not match identity %q", identity.ID)
		}
		result[identity.ID] = signer{identity: identity, key: key, role: role, index: index}
		return nil
	}
	if err := add(definition.Coordinator, mpcceremony.EnrollmentCoordinator, 1); err != nil {
		return nil, err
	}
	if err := add(definition.ReleaseSigner, mpcceremony.EnrollmentReleaseSigner, 1); err != nil {
		return nil, err
	}
	for index, identity := range definition.Auditors {
		if err := add(identity, mpcceremony.EnrollmentAuditor, uint16(index+1)); err != nil {
			return nil, err
		}
	}
	for index, participant := range definition.Roster {
		if err := add(participant.Identity, mpcceremony.EnrollmentParticipant, uint16(index+1)); err != nil {
			return nil, err
		}
	}
	for index, external := range []struct {
		id, display string
		role        mpcceremony.EnrollmentRole
	}{
		{"witness-01", "Local Rehearsal Public Witness 01", mpcceremony.EnrollmentPublicWitness},
		{"witness-02", "Local Rehearsal Public Witness 02", mpcceremony.EnrollmentPublicWitness},
		{"mirror-01", "Local Rehearsal Mirror Operator 01", mpcceremony.EnrollmentMirrorOperator},
		{"mirror-02", "Local Rehearsal Mirror Operator 02", mpcceremony.EnrollmentMirrorOperator},
	} {
		key, publicKey, err := keybundle.LoadExistingPrivateKey(
			filepath.Join(keysDir, external.id+".ed25519.private.hex"),
		)
		if err != nil {
			return nil, err
		}
		identity, err := mpcceremony.NewIdentity(
			external.id,
			external.display,
			external.id+"-key",
			publicKey,
		)
		if err != nil {
			return nil, err
		}
		roleIndex := uint16(index%2 + 1)
		result[external.id] = signer{
			identity: identity,
			key:      key,
			role:     external.role,
			index:    roleIndex,
		}
	}
	return result, nil
}

func loadRelayInputs(directory string) ([]relayInput, error) {
	directory, err := realDirectory(directory)
	if err != nil {
		return nil, err
	}
	manifest, err := readRegular(filepath.Join(directory, "relays.tsv"), 64<<10)
	if err != nil {
		return nil, err
	}
	reader := csv.NewReader(strings.NewReader(string(manifest)))
	reader.Comma = '\t'
	reader.FieldsPerRecord = 5
	reader.ReuseRecord = false
	rows, err := reader.ReadAll()
	if err != nil {
		return nil, err
	}
	if len(rows) < 4 || len(rows) > 17 ||
		!slices.Equal(rows[0], []string{
			"relay_id",
			"operator_id",
			"endpoint_sha256",
			"retrieved_at",
			"filename",
		}) {
		return nil, errors.New("relays.tsv must have the exact header and 3-16 observations")
	}
	safeName := regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*\.json$`)
	safeID := regexp.MustCompile(`^[a-z0-9][a-z0-9._:-]{0,127}$`)
	result := make([]relayInput, 0, len(rows)-1)
	for _, row := range rows[1:] {
		if !safeID.MatchString(row[0]) || strings.Contains(row[0], "..") ||
			!safeName.MatchString(row[4]) {
			return nil, fmt.Errorf("unsafe relay identifier or filename %q/%q", row[0], row[4])
		}
		if _, err := time.Parse(time.RFC3339, row[3]); err != nil {
			return nil, fmt.Errorf("relay retrieved_at: %w", err)
		}
		raw, err := readRegular(filepath.Join(directory, row[4]), 64<<10)
		if err != nil {
			return nil, err
		}
		result = append(result, relayInput{
			relayID:        row[0],
			operatorID:     row[1],
			endpointSHA256: row[2],
			retrievedAt:    row[3],
			filename:       row[4],
			raw:            raw,
		})
	}
	slices.SortFunc(result, func(a, b relayInput) int {
		return strings.Compare(a.relayID, b.relayID)
	})
	return result, nil
}

func twoInteriorTimestamps(lower, upper time.Time) (string, string, error) {
	if !upper.After(lower) {
		return "", "", errors.New("authenticated interval is empty")
	}
	span := upper.Sub(lower)
	if span < 3*time.Nanosecond {
		return "", "", errors.New("authenticated interval has fewer than two distinct interior instants")
	}
	first := lower.Add(span / 3)
	second := lower.Add((2 * span) / 3)
	if !first.After(lower) || !second.After(first) || !upper.After(second) {
		return "", "", errors.New("authenticated interval cannot represent strict custody ordering")
	}
	return first.Format(time.RFC3339Nano), second.Format(time.RFC3339Nano), nil
}

func parseTimestamp(label, value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("%s: %w", label, err)
	}
	return parsed, nil
}

func writeSignedPair(
	stagingRoot,
	stem string,
	record any,
	keyID string,
	key ed25519.PrivateKey,
) (mpcceremony.SignedArtifactRefs, error) {
	recordBytes, signatureBytes, err := mpcceremony.SignRecord(record, keyID, key)
	if err != nil {
		return mpcceremony.SignedArtifactRefs{}, err
	}
	recordName := stem + ".json"
	signatureName := stem + ".sig"
	if err := writeRelative(stagingRoot, recordName, recordBytes); err != nil {
		return mpcceremony.SignedArtifactRefs{}, err
	}
	if err := writeRelative(stagingRoot, signatureName, signatureBytes); err != nil {
		return mpcceremony.SignedArtifactRefs{}, err
	}
	return mpcceremony.SignedArtifactRefs{
		Record: mpcceremony.ArtifactRef{
			Name:   recordName,
			Digest: mpcceremony.NewDigest(recordBytes),
		},
		Signature: mpcceremony.ArtifactRef{
			Name:   signatureName,
			Digest: mpcceremony.NewDigest(signatureBytes),
		},
	}, nil
}

func writeRelative(stagingRoot, name string, data []byte) error {
	if name == "" || strings.Contains(name, `\`) || filepath.IsAbs(name) {
		return errors.New("unsafe evidence artifact name")
	}
	clean := filepath.Clean(filepath.FromSlash(name))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return errors.New("unsafe evidence artifact traversal")
	}
	operationalPrefix := "operational" + string(filepath.Separator)
	if !strings.HasPrefix(clean, operationalPrefix) ||
		strings.TrimPrefix(clean, operationalPrefix) == "" {
		return errors.New("evidence artifact must be beneath operational/")
	}
	path := filepath.Join(stagingRoot, strings.TrimPrefix(clean, operationalPrefix))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	remove := true
	defer func() {
		_ = file.Close()
		if remove {
			_ = os.Remove(path)
		}
	}()
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	remove = false
	return nil
}

func readRegular(path string, maximum int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maximum {
		return nil, fmt.Errorf("unsafe or out-of-bounds regular file: %s", path)
	}
	return os.ReadFile(path)
}

func realDirectory(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("path is not a real directory")
	}
	return filepath.Abs(path)
}
