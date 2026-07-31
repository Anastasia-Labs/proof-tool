package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	cs "github.com/consensys/gnark/constraint/bls12-381"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"golang.org/x/crypto/blake2b"

	"proof-tool/internal/mpcceremony"
	"proof-tool/internal/prover"
)

const (
	quicknetRound42 = `{"round":42,"randomness":"8ada64bae5c6c0f5540a6a13af56e663240edfbd2c76ac6a8f27671eb7259ce3","signature":"95a9f9f5b231b7714de1553105d8ffdf3dcda24cfdb1e689319bccf79a9c8ce430a91b811fbfaf763900bc998b5d686a"}`
	quicknetRound43 = `{"round":43,"randomness":"c8f7c61c7024f8b45ffbf5be58b1f112a26be93c26f5461af9f8522233705dbb","signature":"a96a579010b3d2261959104b29b5b46685b3a6b6f6aae7304ef72d44fe7d44e667bcdd500935d7deb58a2b4d89419ea6"}`
)

type tinyCommittedCircuit struct {
	Public frontend.Variable `gnark:",public"`
	Secret frontend.Variable
}

func (c *tinyCommittedCircuit) Define(api frontend.API) error {
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

func main() {
	if len(os.Args) != 2 && len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: workflowhelper OUTPUT_ROOT [OPERATIONAL_EVIDENCE_HELPER]")
		os.Exit(2)
	}
	operationalEvidenceHelper := ""
	if len(os.Args) == 3 {
		operationalEvidenceHelper = os.Args[2]
	}
	if err := run(os.Args[1], operationalEvidenceHelper); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(outputRoot, operationalEvidenceHelper string) error {
	compiled, err := frontend.Compile(
		ecc.BLS12_381.ScalarField(),
		r1cs.NewBuilder,
		&tinyCommittedCircuit{},
	)
	if err != nil {
		return fmt.Errorf("compile tiny circuit: %w", err)
	}
	native, ok := compiled.(*cs.R1CS)
	if !ok {
		return fmt.Errorf("compiled circuit type %T, want *bls12-381.R1CS", compiled)
	}
	circuit, err := mpcceremony.BindDestinationV2R1CS(native)
	if err != nil {
		return fmt.Errorf("bind tiny circuit: %w", err)
	}
	software, err := mpcceremony.RunningSoftwareBindingForMode(
		prover.ProofToolVersion,
		mpcceremony.ModeRehearsal,
	)
	if err != nil {
		return fmt.Errorf("bind helper executable: %w", err)
	}

	if err := os.Mkdir(outputRoot, 0o700); err != nil {
		return err
	}
	keyDir := filepath.Join(outputRoot, "identity-keys")
	candidateRoot := filepath.Join(outputRoot, "candidates")
	for _, dir := range []string{keyDir, candidateRoot} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			return err
		}
	}

	privateKey := func(fill byte) ed25519.PrivateKey {
		return ed25519.NewKeyFromSeed(bytes.Repeat([]byte{fill}, ed25519.SeedSize))
	}
	coordinatorPrivate := privateKey(0x81)
	releasePrivate := privateKey(0x82)
	auditor1Private := privateKey(0x83)
	auditor2Private := privateKey(0x84)
	participant1Private := privateKey(0x91)
	participant2Private := privateKey(0x92)
	identity := func(id string, key ed25519.PrivateKey) (mpcceremony.Identity, error) {
		return mpcceremony.NewIdentity(
			id,
			"Integration "+id,
			id+"-key",
			key.Public().(ed25519.PublicKey),
		)
	}
	coordinator, err := identity("coordinator", coordinatorPrivate)
	if err != nil {
		return err
	}
	releaseSigner, err := identity("release-signer", releasePrivate)
	if err != nil {
		return err
	}
	auditor1, err := identity("auditor-01", auditor1Private)
	if err != nil {
		return err
	}
	auditor2, err := identity("auditor-02", auditor2Private)
	if err != nil {
		return err
	}
	participant1, err := identity("participant-01", participant1Private)
	if err != nil {
		return err
	}
	participant2, err := identity("participant-02", participant2Private)
	if err != nil {
		return err
	}
	writePrivateKey := func(name string, key ed25519.PrivateKey) (string, error) {
		path := filepath.Join(keyDir, name+".ed25519.private.hex")
		err := os.WriteFile(path, []byte(hex.EncodeToString(key.Seed())+"\n"), 0o600)
		return path, err
	}
	coordinatorKeyPath, err := writePrivateKey("coordinator", coordinatorPrivate)
	if err != nil {
		return err
	}
	participant1KeyPath, err := writePrivateKey("participant-01", participant1Private)
	if err != nil {
		return err
	}
	participant2KeyPath, err := writePrivateKey("participant-02", participant2Private)
	if err != nil {
		return err
	}
	releaseKeyPath, err := writePrivateKey("release-signer", releasePrivate)
	if err != nil {
		return err
	}
	auditor1KeyPath, err := writePrivateKey("auditor-01", auditor1Private)
	if err != nil {
		return err
	}
	auditor2KeyPath, err := writePrivateKey("auditor-02", auditor2Private)
	if err != nil {
		return err
	}
	for _, external := range []struct {
		name string
		fill byte
	}{
		{name: "witness-01", fill: 0xa1},
		{name: "witness-02", fill: 0xa2},
		{name: "mirror-01", fill: 0xb1},
		{name: "mirror-02", fill: 0xb2},
	} {
		if _, err := writePrivateKey(external.name, privateKey(external.fill)); err != nil {
			return err
		}
	}
	trustedCoordinatorPath := filepath.Join(keyDir, "trusted-coordinator.ed25519.public.hex")
	if err := os.WriteFile(
		trustedCoordinatorPath,
		[]byte(hex.EncodeToString(coordinatorPrivate.Public().(ed25519.PublicKey))+"\n"),
		0o600,
	); err != nil {
		return err
	}

	ceremonyRoot := filepath.Join(outputRoot, "ceremony")
	initialized, err := mpcceremony.InitializeCeremonyFiles(mpcceremony.InitFilesOptions{
		RootDir: ceremonyRoot,
		Circuit: circuit,
		Definition: mpcceremony.DefinitionOptions{
			Mode:            mpcceremony.ModeRehearsal,
			CreatedAt:       "2023-08-23T15:00:00Z",
			SessionNonceHex: "abababababababababababababababababababababababababababababababab",
			Software:        software,
			Coordinator:     coordinator,
			ReleaseSigner:   releaseSigner,
			Auditors:        []mpcceremony.Identity{auditor1, auditor2},
			Roster: []mpcceremony.Participant{
				{Identity: participant1},
				{Identity: participant2},
			},
			Phase1Policy: mpcceremony.PhasePolicy{
				Participants: []string{"participant-01", "participant-02"},
				Minimum:      2,
			},
			Phase2Policy: mpcceremony.PhasePolicy{
				Participants: []string{"participant-01", "participant-02"},
				Minimum:      2,
			},
			BeaconPolicy: mpcceremony.BeaconPolicy{
				Provider:                  mpcceremony.BeaconProviderDrand,
				Network:                   mpcceremony.BeaconNetworkQuicknet,
				ChainHashHex:              mpcceremony.BeaconQuicknetChainHash,
				PublicKeyHex:              mpcceremony.BeaconQuicknetPublicKey,
				Scheme:                    mpcceremony.BeaconQuicknetScheme,
				GenesisTimeUnix:           mpcceremony.BeaconQuicknetGenesis,
				PeriodSeconds:             mpcceremony.BeaconQuicknetPeriod,
				Extraction:                mpcceremony.BeaconExtractionV1,
				MinimumChallengeBytes:     32,
				MinimumWitnessLeadSeconds: 1,
				FutureRoundRequired:       true,
			},
		},
		CoordinatorPrivateKeyPath: coordinatorKeyPath,
	})
	if err != nil {
		return fmt.Errorf("initialize ceremony: %w", err)
	}
	trust := mpcceremony.TrustPaths{
		DefinitionPath:           initialized.DefinitionPath,
		DefinitionSignaturePath:  initialized.DefinitionSignaturePath,
		CoordinatorPublicKeyPath: trustedCoordinatorPath,
	}
	trusted, err := mpcceremony.LoadSignedDefinition(trust)
	if err != nil {
		return err
	}
	writeHistoricalClose := func(
		phase mpcceremony.Phase,
		chain mpcceremony.Chain,
		round uint64,
		closedAt string,
	) (mpcceremony.ClosePhaseFilesResult, error) {
		roundTime, err := mpcceremony.QuicknetRoundTime(round)
		if err != nil {
			return mpcceremony.ClosePhaseFilesResult{}, err
		}
		headID, _ := chain.HeadRecordID()
		headPayload, _ := chain.HeadPayload()
		participants, _ := chain.ParticipantIDs()
		closeRecord, err := mpcceremony.NewCloseRecord(mpcceremony.CloseRecord{
			CeremonyID:           trusted.Definition.CeremonyID,
			Phase:                phase,
			PhaseID:              chain.PhaseID,
			FinalIndex:           uint8(len(chain.Records)),
			FinalPayload:         headPayload,
			ChainHeadID:          headID,
			AcceptedParticipants: participants,
			BeaconProvider:       trusted.Definition.BeaconPolicy.Provider,
			BeaconNetwork:        trusted.Definition.BeaconPolicy.Network,
			BeaconRound:          round,
			BeaconNotBefore:      roundTime.Format(time.RFC3339Nano),
			ClosedAt:             closedAt,
			CoordinatorID:        trusted.Definition.Coordinator.ID,
			CoordinatorKeyID:     trusted.Definition.Coordinator.KeyID,
		})
		if err != nil {
			return mpcceremony.ClosePhaseFilesResult{}, err
		}
		if err := mpcceremony.ValidateClose(trusted.Definition, chain, closeRecord); err != nil {
			return mpcceremony.ClosePhaseFilesResult{}, err
		}
		recordBytes, signatureBytes, err := mpcceremony.SignRecord(
			closeRecord,
			trusted.Definition.Coordinator.KeyID,
			coordinatorPrivate,
		)
		if err != nil {
			return mpcceremony.ClosePhaseFilesResult{}, err
		}
		closeDir := filepath.Join(ceremonyRoot, string(phase), "closure")
		if err := os.Mkdir(closeDir, 0o700); err != nil {
			return mpcceremony.ClosePhaseFilesResult{}, err
		}
		recordPath := filepath.Join(closeDir, "record.json")
		signaturePath := filepath.Join(closeDir, "record.sig")
		if err := os.WriteFile(signaturePath, signatureBytes, 0o600); err != nil {
			return mpcceremony.ClosePhaseFilesResult{}, err
		}
		if err := os.WriteFile(recordPath, recordBytes, 0o600); err != nil {
			return mpcceremony.ClosePhaseFilesResult{}, err
		}
		return mpcceremony.ClosePhaseFilesResult{
			Close:         closeRecord,
			ClosePath:     recordPath,
			SignaturePath: signaturePath,
		}, nil
	}
	environment := mpcceremony.ContributionEnvironment{
		OS:                           "linux",
		Architecture:                 "amd64",
		EntropySource:                "operating-system-csprng",
		SwapDisabled:                 true,
		CrashDumpsDisabled:           true,
		TelemetryDisabled:            true,
		EphemeralEnvironment:         true,
		EphemeralDestructionRequired: true,
	}
	participantKeyPaths := []string{participant1KeyPath, participant2KeyPath}
	contributeAndAccept := func(
		phase mpcceremony.Phase,
		index int,
		chainPaths mpcceremony.PhaseTranscriptPaths,
		phase1SealPath string,
		phase1SealSignaturePath string,
		contributedAt string,
		destroyedAt string,
		acceptedAt string,
	) (mpcceremony.PhaseTranscriptPaths, error) {
		participantID := fmt.Sprintf("participant-%02d", index)
		candidateDir := filepath.Join(
			candidateRoot,
			fmt.Sprintf("%s-%s", phase, participantID),
		)
		if _, err := mpcceremony.CreateContributionCandidate(
			mpcceremony.ContributionFilesOptions{
				Trust:                     trust,
				Circuit:                   circuit,
				Phase:                     phase,
				Transcript:                chainPaths,
				Phase1SealPath:            phase1SealPath,
				Phase1SealSignaturePath:   phase1SealSignaturePath,
				ParticipantID:             participantID,
				ParticipantPrivateKeyPath: participantKeyPaths[index-1],
				Environment:               environment,
				ContributedAt:             contributedAt,
				CandidateDir:              candidateDir,
			},
		); err != nil {
			return mpcceremony.PhaseTranscriptPaths{}, err
		}
		if _, err := mpcceremony.CreateErasureAttestationFiles(
			mpcceremony.CreateErasureAttestationFilesOptions{
				Trust:                     trust,
				ParticipantID:             participantID,
				ParticipantPrivateKeyPath: participantKeyPaths[index-1],
				CandidateDir:              candidateDir,
				DestroyedAt:               destroyedAt,
			},
		); err != nil {
			return mpcceremony.PhaseTranscriptPaths{}, err
		}
		accepted, err := mpcceremony.VerifyAndAcceptContribution(
			mpcceremony.AcceptContributionFilesOptions{
				Trust:                     trust,
				Circuit:                   circuit,
				Phase:                     phase,
				Transcript:                chainPaths,
				Phase1SealPath:            phase1SealPath,
				Phase1SealSignaturePath:   phase1SealSignaturePath,
				CandidateDir:              candidateDir,
				CoordinatorPrivateKeyPath: coordinatorKeyPath,
				AcceptedAt:                acceptedAt,
			},
		)
		if err != nil {
			return mpcceremony.PhaseTranscriptPaths{}, err
		}
		return mpcceremony.PhaseTranscriptPaths{
			RootDir:            ceremonyRoot,
			ChainPath:          accepted.ChainPath,
			ChainSignaturePath: accepted.ChainSignaturePath,
		}, nil
	}

	phase1Paths := mpcceremony.PhaseTranscriptPaths{
		RootDir:            ceremonyRoot,
		ChainPath:          initialized.Phase1ChainPath,
		ChainSignaturePath: initialized.Phase1ChainSignaturePath,
	}
	phase1Paths, err = contributeAndAccept(
		mpcceremony.Phase1,
		1,
		phase1Paths,
		"",
		"",
		"2023-08-23T15:01:00Z",
		"2023-08-23T15:01:01Z",
		"2023-08-23T15:02:00Z",
	)
	if err != nil {
		return fmt.Errorf("Phase 1 participant 1: %w", err)
	}
	phase1Paths, err = contributeAndAccept(
		mpcceremony.Phase1,
		2,
		phase1Paths,
		"",
		"",
		"2023-08-23T15:03:00Z",
		"2023-08-23T15:03:01Z",
		"2023-08-23T15:04:00Z",
	)
	if err != nil {
		return fmt.Errorf("Phase 1 participant 2: %w", err)
	}
	phase1Chain, err := mpcceremony.LoadReplayPhase1Files(trusted, circuit, phase1Paths)
	if err != nil {
		return fmt.Errorf("replay Phase 1 before historical test closure: %w", err)
	}
	// Historical drand fixtures exercise downstream replay and beacon binding.
	// Production closure timing is tested inside package mpcceremony and is
	// never bypassed by the participant-facing CLI.
	phase1Close, err := writeHistoricalClose(
		mpcceremony.Phase1,
		phase1Chain,
		42,
		"2023-08-23T15:05:00Z",
	)
	if err != nil {
		return fmt.Errorf("close Phase 1: %w", err)
	}
	round42Path := filepath.Join(outputRoot, "quicknet-round-42.json")
	if err := os.WriteFile(round42Path, []byte(quicknetRound42), 0o600); err != nil {
		return err
	}
	phase1Beacon, err := mpcceremony.RecordBeaconFiles(mpcceremony.RecordBeaconFilesOptions{
		Trust:                     trust,
		TranscriptRoot:            ceremonyRoot,
		Phase:                     mpcceremony.Phase1,
		ClosePath:                 phase1Close.ClosePath,
		CloseSignaturePath:        phase1Close.SignaturePath,
		RawResponsePath:           round42Path,
		PublishedAt:               "2023-08-23T15:11:30Z",
		CoordinatorPrivateKeyPath: coordinatorKeyPath,
	})
	if err != nil {
		return fmt.Errorf("record Phase 1 beacon: %w", err)
	}
	phase1Seal, err := mpcceremony.SealPhase1Files(mpcceremony.SealPhase1FilesOptions{
		Trust:                     trust,
		Circuit:                   circuit,
		TranscriptRoot:            ceremonyRoot,
		ClosePath:                 phase1Close.ClosePath,
		CloseSignaturePath:        phase1Close.SignaturePath,
		BeaconPath:                phase1Beacon.BeaconPath,
		BeaconSignaturePath:       phase1Beacon.SignaturePath,
		CoordinatorPrivateKeyPath: coordinatorKeyPath,
		OutputDir:                 filepath.Join(ceremonyRoot, "phase1", "sealed"),
	})
	if err != nil {
		return fmt.Errorf("seal Phase 1: %w", err)
	}

	phase2Initialized, err := mpcceremony.InitializePhase2Files(mpcceremony.InitPhase2FilesOptions{
		Trust:                     trust,
		Circuit:                   circuit,
		TranscriptRoot:            ceremonyRoot,
		Phase1SealPath:            phase1Seal.SealPath,
		Phase1SealSignaturePath:   phase1Seal.SignaturePath,
		CoordinatorPrivateKeyPath: coordinatorKeyPath,
		OutputDir:                 filepath.Join(ceremonyRoot, "phase2"),
	})
	if err != nil {
		return fmt.Errorf("initialize Phase 2: %w", err)
	}
	phase2Paths := mpcceremony.PhaseTranscriptPaths{
		RootDir:            ceremonyRoot,
		ChainPath:          phase2Initialized.ChainPath,
		ChainSignaturePath: phase2Initialized.ChainSignaturePath,
	}
	phase2Paths, err = contributeAndAccept(
		mpcceremony.Phase2,
		1,
		phase2Paths,
		phase1Seal.SealPath,
		phase1Seal.SignaturePath,
		"2023-08-23T15:11:30.1Z",
		"2023-08-23T15:11:30.2Z",
		"2023-08-23T15:11:30.3Z",
	)
	if err != nil {
		return fmt.Errorf("Phase 2 participant 1: %w", err)
	}
	phase2Paths, err = contributeAndAccept(
		mpcceremony.Phase2,
		2,
		phase2Paths,
		phase1Seal.SealPath,
		phase1Seal.SignaturePath,
		"2023-08-23T15:11:30.4Z",
		"2023-08-23T15:11:30.5Z",
		"2023-08-23T15:11:30.6Z",
	)
	if err != nil {
		return fmt.Errorf("Phase 2 participant 2: %w", err)
	}
	_, err = mpcceremony.ClosePhaseFiles(mpcceremony.ClosePhaseFilesOptions{
		Trust:                     trust,
		Circuit:                   circuit,
		Phase:                     mpcceremony.Phase2,
		Transcript:                phase2Paths,
		Phase1SealPath:            phase1Seal.SealPath,
		Phase1SealSignaturePath:   phase1Seal.SignaturePath,
		CoordinatorPrivateKeyPath: coordinatorKeyPath,
		BeaconRound:               42,
	})
	if err == nil || !strings.Contains(err.Error(), "reuses the authenticated phase1 beacon round") {
		return fmt.Errorf("reused Phase 1 beacon round error = %v, want distinct-round rejection", err)
	}
	for _, path := range []string{
		filepath.Join(ceremonyRoot, "phase2", "closure"),
	} {
		if _, statErr := os.Lstat(path); !errors.Is(statErr, os.ErrNotExist) {
			return fmt.Errorf("rejected reused-round close published %q: %v", path, statErr)
		}
	}
	commons, _, err := mpcceremony.ReadCommonsFile(
		phase1Seal.CommonsPath,
		mpcceremony.CommonsShape{DomainN: circuit.Binding.DomainSize},
	)
	if err != nil {
		return fmt.Errorf("read sealed commons for historical Phase 2 closure: %w", err)
	}
	phase2Chain, err := mpcceremony.LoadReplayPhase2Files(
		trusted,
		circuit,
		commons,
		phase1Seal.Seal,
		phase2Paths,
	)
	if err != nil {
		return fmt.Errorf("replay Phase 2 before historical test closure: %w", err)
	}
	phase2Close, err := writeHistoricalClose(
		mpcceremony.Phase2,
		phase2Chain,
		43,
		"2023-08-23T15:11:30.7Z",
	)
	if err != nil {
		return fmt.Errorf("close Phase 2: %w", err)
	}
	round43Path := filepath.Join(outputRoot, "quicknet-round-43.json")
	if err := os.WriteFile(round43Path, []byte(quicknetRound43), 0o600); err != nil {
		return err
	}
	phase2Beacon, err := mpcceremony.RecordBeaconFiles(mpcceremony.RecordBeaconFilesOptions{
		Trust:                     trust,
		TranscriptRoot:            ceremonyRoot,
		Phase:                     mpcceremony.Phase2,
		ClosePath:                 phase2Close.ClosePath,
		CloseSignaturePath:        phase2Close.SignaturePath,
		RawResponsePath:           round43Path,
		PublishedAt:               "2023-08-23T15:11:33Z",
		CoordinatorPrivateKeyPath: coordinatorKeyPath,
	})
	if err != nil {
		return fmt.Errorf("record Phase 2 beacon: %w", err)
	}
	if operationalEvidenceHelper == "" {
		return nil
	}

	replay := mpcceremony.ReplayPaths{
		TranscriptRoot:            ceremonyRoot,
		CoordinatorPublicKeyHex:   hex.EncodeToString(coordinatorPrivate.Public().(ed25519.PublicKey)),
		DefinitionPath:            initialized.DefinitionPath,
		DefinitionSignaturePath:   initialized.DefinitionSignaturePath,
		Phase1ChainPath:           phase1Paths.ChainPath,
		Phase1ChainSignaturePath:  phase1Paths.ChainSignaturePath,
		Phase1ClosePath:           phase1Close.ClosePath,
		Phase1CloseSignaturePath:  phase1Close.SignaturePath,
		Phase1BeaconPath:          phase1Beacon.BeaconPath,
		Phase1BeaconSignaturePath: phase1Beacon.SignaturePath,
		Phase1SealPath:            phase1Seal.SealPath,
		Phase1SealSignaturePath:   phase1Seal.SignaturePath,
		Phase2ChainPath:           phase2Paths.ChainPath,
		Phase2ChainSignaturePath:  phase2Paths.ChainSignaturePath,
		Phase2ClosePath:           phase2Close.ClosePath,
		Phase2CloseSignaturePath:  phase2Close.SignaturePath,
		Phase2BeaconPath:          phase2Beacon.BeaconPath,
		Phase2BeaconSignaturePath: phase2Beacon.SignaturePath,
	}
	preliminaryDir := filepath.Join(outputRoot, "preliminary")
	if _, err := mpcceremony.PrepareFinalization(mpcceremony.PrepareFinalizationOptions{
		Replay:                replay,
		Circuit:               circuit,
		OutDir:                preliminaryDir,
		CoordinatorSigningKey: coordinatorKeyPath,
		PreparedAt:            mustUTC("2023-08-23T15:11:34Z"),
	}); err != nil {
		return fmt.Errorf("prepare finalization: %w", err)
	}
	if _, err := mpcceremony.VerifyPreliminaryFinalKeys(
		preliminaryDir,
		replay.CoordinatorPublicKeyHex,
	); err != nil {
		return fmt.Errorf("verify preliminary final keys: %w", err)
	}
	publicEvidencePath := filepath.Join(outputRoot, "public-finalization-evidence.json")
	if err := writeTinyPublicEvidence(
		publicEvidencePath,
		initialized.Definition.CeremonyID,
		circuit,
		preliminaryDir,
	); err != nil {
		return fmt.Errorf("generate separate public evidence: %w", err)
	}
	candidateDir := filepath.Join(outputRoot, "candidate")
	if _, err := mpcceremony.Finalize(mpcceremony.FinalizeOptions{
		Replay:                replay,
		Circuit:               circuit,
		OutDir:                candidateDir,
		CoordinatorSigningKey: coordinatorKeyPath,
		PublicEvidencePath:    publicEvidencePath,
		FinalizedAt:           mustUTC("2023-08-23T15:11:35Z"),
	}); err != nil {
		return fmt.Errorf("complete finalization: %w", err)
	}

	auditDir := filepath.Join(outputRoot, "audits")
	if err := os.Mkdir(auditDir, 0o700); err != nil {
		return err
	}
	audits := make([]mpcceremony.AuditArtifact, 0, 2)
	for index, input := range []struct {
		id      string
		keyPath string
		at      string
	}{
		{id: auditor1.ID, keyPath: auditor1KeyPath, at: "2023-08-23T15:11:36Z"},
		{id: auditor2.ID, keyPath: auditor2KeyPath, at: "2023-08-23T15:11:37Z"},
	} {
		recordPath := filepath.Join(auditDir, fmt.Sprintf("audit-%02d.json", index+1))
		signaturePath := filepath.Join(auditDir, fmt.Sprintf("audit-%02d.sig", index+1))
		if _, err := mpcceremony.Audit(mpcceremony.AuditOptions{
			Replay:            replay,
			Circuit:           circuit,
			CandidateDir:      candidateDir,
			AuditorID:         input.id,
			AuditorSigningKey: input.keyPath,
			OutPath:           recordPath,
			SignatureOutPath:  signaturePath,
			AuditedAt:         mustUTC(input.at),
		}); err != nil {
			return fmt.Errorf("audit %s: %w", input.id, err)
		}
		audits = append(audits, mpcceremony.AuditArtifact{
			RecordPath:    recordPath,
			SignaturePath: signaturePath,
			LogicalName:   fmt.Sprintf("audit-%02d", index+1),
		})
	}

	phase1Relays, err := writeRelayFixture(
		outputRoot,
		"phase1-relays",
		[]byte(quicknetRound42),
		"2023-08-23T15:11:30Z",
	)
	if err != nil {
		return err
	}
	phase2Relays, err := writeRelayFixture(
		outputRoot,
		"phase2-relays",
		[]byte(quicknetRound43),
		"2023-08-23T15:11:33Z",
	)
	if err != nil {
		return err
	}
	operationalCommand := exec.Command(
		operationalEvidenceHelper,
		"--transcript-root", ceremonyRoot,
		"--keys-dir", keyDir,
		"--coordinator-public-key-file", trustedCoordinatorPath,
		"--phase1-relays", phase1Relays,
		"--phase2-relays", phase2Relays,
		"--assembled-at", "2023-08-23T15:11:35Z",
		"--out-dir", filepath.Join(ceremonyRoot, "operational"),
	)
	if output, err := operationalCommand.CombinedOutput(); err != nil {
		return fmt.Errorf("generate operational evidence: %w\n%s", err, output)
	}

	releaseDir := filepath.Join(outputRoot, "release")
	if _, err := mpcceremony.SignRelease(mpcceremony.SignReleaseOptions{
		DefinitionPath:           initialized.DefinitionPath,
		DefinitionSignaturePath:  initialized.DefinitionSignaturePath,
		CoordinatorPublicKeyHex:  replay.CoordinatorPublicKeyHex,
		CandidateDir:             candidateDir,
		ReleaseDir:               releaseDir,
		Audits:                   audits,
		OperationalEvidenceRoot:  ceremonyRoot,
		OperationalBundlePath:    filepath.Join(ceremonyRoot, mpcceremony.OperationalEvidenceBundleFile),
		OperationalSignaturePath: filepath.Join(ceremonyRoot, mpcceremony.OperationalEvidenceSignatureFile),
		ReleaseSigningKey:        releaseKeyPath,
		SignatureKeyID:           releaseSigner.KeyID,
		ReleasedAt:               mustUTC("2023-08-23T15:11:38Z"),
	}); err != nil {
		return fmt.Errorf("sign release: %w", err)
	}
	if _, err := mpcceremony.VerifyRelease(mpcceremony.VerifyReleaseOptions{
		DefinitionPath:          initialized.DefinitionPath,
		DefinitionSignaturePath: initialized.DefinitionSignaturePath,
		CoordinatorPublicKeyHex: replay.CoordinatorPublicKeyHex,
		KeysDir:                 releaseDir,
		TrustedPublicKeyHex:     releaseSigner.Ed25519PublicKeyHex,
		ExpectedSignatureKeyID:  releaseSigner.KeyID,
		RequireProvingKey:       true,
	}); err != nil {
		return fmt.Errorf("verify signed release: %w", err)
	}
	return nil
}

func mustUTC(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		panic(err)
	}
	return parsed.UTC()
}

func writeTinyPublicEvidence(
	path string,
	ceremonyID string,
	circuit *mpcceremony.CompiledCircuit,
	preliminaryDir string,
) error {
	credential, err := hex.DecodeString(mpcceremony.GoldenPublicCredentialHex)
	if err != nil {
		return err
	}
	destination, err := hex.DecodeString(mpcceremony.GoldenPublicDestinationHex)
	if err != nil {
		return err
	}
	preimage := append([]byte(mpcceremony.DestinationPublicDomain), credential...)
	preimage = append(preimage, destination...)
	digest := blake2b.Sum256(preimage)
	reversed := bytes.Clone(digest[:])
	for left, right := 0, len(reversed)-1; left < right; left, right = left+1, right-1 {
		reversed[left], reversed[right] = reversed[right], reversed[left]
	}
	scalar := new(big.Int).SetBytes(reversed)
	scalar.Mod(scalar, ecc.BLS12_381.ScalarField())
	assignment := &tinyCommittedCircuit{Public: scalar, Secret: scalar}
	fullWitness, err := frontend.NewWitness(assignment, ecc.BLS12_381.ScalarField())
	if err != nil {
		return err
	}
	pk, err := prover.LoadPK(filepath.Join(preliminaryDir, mpcceremony.NativeProvingKeyFile))
	if err != nil {
		return err
	}
	proof, err := groth16.Prove(circuit.R1CS, pk, fullWitness)
	if err != nil {
		return err
	}
	cardanoProof, format, err := prover.SerializeCardanoProof(proof)
	if err != nil {
		return err
	}
	cardanoVK, err := os.ReadFile(filepath.Join(preliminaryDir, mpcceremony.CardanoVKBytesFile))
	if err != nil {
		return err
	}
	evidence := mpcceremony.PublicFinalizationEvidence{
		Schema:                mpcceremony.PublicEvidenceSchema,
		CeremonyID:            ceremonyID,
		Fixture:               mpcceremony.PublicEvidenceFixture,
		CredentialHex:         hex.EncodeToString(credential),
		DestinationHex:        hex.EncodeToString(destination),
		PublicInputDigestHex:  hex.EncodeToString(digest[:]),
		CardanoProofHex:       hex.EncodeToString(cardanoProof),
		CardanoProofFormat:    format,
		CardanoProofRawDigest: mpcceremony.NewDigest(cardanoProof),
		CardanoVerifyingKey: mpcceremony.ArtifactRef{
			Name:   mpcceremony.CardanoVKBytesFile,
			Digest: mpcceremony.NewDigest(cardanoVK),
		},
	}
	canonical, err := mpcceremony.MarshalCanonical(evidence)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(canonical); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func writeRelayFixture(root, name string, raw []byte, retrievedAt string) (string, error) {
	dir := filepath.Join(root, name)
	if err := os.Mkdir(dir, 0o700); err != nil {
		return "", err
	}
	rows := []string{
		"relay_id\toperator_id\tendpoint_sha256\tretrieved_at\tfilename",
	}
	for index := 1; index <= 3; index++ {
		filename := fmt.Sprintf("relay-%02d.json", index)
		if err := os.WriteFile(filepath.Join(dir, filename), raw, 0o600); err != nil {
			return "", err
		}
		endpoint := "sha256:" + strings.Repeat(fmt.Sprintf("%x", index), 64)
		rows = append(rows, fmt.Sprintf(
			"relay-%02d\toperator-%02d\t%s\t%s\t%s",
			index,
			index,
			endpoint,
			retrievedAt,
			filename,
		))
	}
	if err := os.WriteFile(
		filepath.Join(dir, "relays.tsv"),
		[]byte(strings.Join(rows, "\n")+"\n"),
		0o600,
	); err != nil {
		return "", err
	}
	return dir, nil
}
