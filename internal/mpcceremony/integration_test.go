package mpcceremony

import (
	"bytes"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	groth16bls12381 "github.com/consensys/gnark/backend/groth16/bls12-381"
	gnarkmpc "github.com/consensys/gnark/backend/groth16/bls12-381/mpcsetup"
	"github.com/consensys/gnark/frontend"

	"proof-tool/internal/prover"
)

func TestTinyCommittedCircuitThreeByThreeEndToEnd(t *testing.T) {
	circuit, err := BindDestinationV2R1CS(adversarialCompileCommitted(t))
	if err != nil {
		t.Fatalf("bind tiny committed circuit: %v", err)
	}
	domainN := circuit.Binding.DomainSize
	phase1Shape := Phase1Shape{DomainN: domainN, ChallengeLength: 32}

	phase1Dir := t.TempDir()
	phase1 := make([]*gnarkmpc.Phase1, 0, 3)
	phase1Archive := make([][]byte, 0, 3)
	for index := range 3 {
		contribution, err := ContributePhase1(domainN, phase1)
		if err != nil {
			t.Fatalf("Phase 1 contribution %d: %v", index+1, err)
		}
		path := filepath.Join(phase1Dir, "contribution-"+string(rune('1'+index))+".bin")
		if _, err := WritePhase1FileNoReplace(path, contribution, phase1Shape); err != nil {
			t.Fatalf("write Phase 1 contribution %d: %v", index+1, err)
		}
		reloaded, digest, err := ReadPhase1File(path, phase1Shape)
		if err != nil {
			t.Fatalf("read Phase 1 contribution %d: %v", index+1, err)
		}
		if digest.Size <= 0 || len(digest.Challenge) != 32 {
			t.Fatalf("Phase 1 contribution %d digest = %+v", index+1, digest)
		}
		phase1 = append(phase1, reloaded)
		phase1Archive = append(phase1Archive, adversarialSerialize(t, reloaded))
	}
	if err := ReplayPhase1(domainN, phase1); err != nil {
		t.Fatalf("replay Phase 1: %v", err)
	}

	phase1Beacon := bytes.Repeat([]byte{0xa1}, 32)
	commons, err := SealPhase1(domainN, phase1Beacon, phase1)
	if err != nil {
		t.Fatalf("seal Phase 1: %v", err)
	}
	commonsAgain, err := SealPhase1(domainN, phase1Beacon, phase1)
	if err != nil {
		t.Fatalf("replay and reseal Phase 1: %v", err)
	}
	if left, right := adversarialSerialize(t, commons), adversarialSerialize(t, commonsAgain); !bytes.Equal(left, right) {
		t.Fatal("replaying the same Phase 1 transcript and beacon produced different commons")
	}
	for i := range phase1 {
		if got := adversarialSerialize(t, phase1[i]); !bytes.Equal(got, phase1Archive[i]) {
			t.Fatalf("Phase 1 archive %d mutated during sealing", i+1)
		}
	}

	commonsPath := filepath.Join(t.TempDir(), "commons.bin")
	commonsShape := CommonsShape{DomainN: domainN}
	if _, err := WriteCommonsFileNoReplace(commonsPath, commons, commonsShape); err != nil {
		t.Fatalf("write commons: %v", err)
	}
	reloadedCommons, _, err := ReadCommonsFile(commonsPath, commonsShape)
	if err != nil {
		t.Fatalf("read commons: %v", err)
	}

	initialPhase2, initialShape, err := InitializePhase2(circuit, reloadedCommons)
	if err != nil {
		t.Fatalf("initialize Phase 2: %v", err)
	}
	if initialShape.ChallengeLength != 0 {
		t.Fatalf("initial Phase 2 challenge length = %d, want 0", initialShape.ChallengeLength)
	}
	derivedInitialShape, err := DerivePhase2Shape(initialPhase2)
	if err != nil {
		t.Fatalf("derive initial Phase 2 shape: %v", err)
	}
	if !equalPhase2Shape(initialShape, derivedInitialShape) {
		t.Fatalf("initial Phase 2 shapes differ: %+v != %+v", initialShape, derivedInitialShape)
	}

	phase2Dir := t.TempDir()
	phase2 := make([]*gnarkmpc.Phase2, 0, 3)
	phase2Archive := make([][]byte, 0, 3)
	var contributionShape Phase2Shape
	for index := range 3 {
		contribution, err := ContributePhase2(circuit, reloadedCommons, phase2)
		if err != nil {
			t.Fatalf("Phase 2 contribution %d: %v", index+1, err)
		}
		contributionShape, err = DerivePhase2Shape(contribution)
		if err != nil {
			t.Fatalf("derive Phase 2 contribution %d shape: %v", index+1, err)
		}
		if contributionShape.ChallengeLength != 32 {
			t.Fatalf("Phase 2 contribution challenge length = %d, want 32", contributionShape.ChallengeLength)
		}
		path := filepath.Join(phase2Dir, "contribution-"+string(rune('1'+index))+".bin")
		if _, err := WritePhase2FileNoReplace(path, contribution, contributionShape); err != nil {
			t.Fatalf("write Phase 2 contribution %d: %v", index+1, err)
		}
		reloaded, digest, err := ReadPhase2File(path, contributionShape)
		if err != nil {
			t.Fatalf("read Phase 2 contribution %d: %v", index+1, err)
		}
		if digest.Size <= 0 || len(digest.Challenge) != 32 {
			t.Fatalf("Phase 2 contribution %d digest = %+v", index+1, digest)
		}
		phase2 = append(phase2, reloaded)
		phase2Archive = append(phase2Archive, adversarialSerialize(t, reloaded))
	}
	if err := ReplayPhase2(circuit, reloadedCommons, phase2); err != nil {
		t.Fatalf("replay Phase 2: %v", err)
	}
	reorderedPhase2 := []*gnarkmpc.Phase2{phase2[0], phase2[2], phase2[1]}
	if err := ReplayPhase2(circuit, reloadedCommons, reorderedPhase2); err == nil {
		t.Fatal("reordered Phase 2 transcript unexpectedly replayed")
	}
	for _, size := range []int{0, 31, 33} {
		if _, _, err := SealPhase2(
			circuit,
			reloadedCommons,
			bytes.Repeat([]byte{0xb2}, size),
			phase2,
		); err == nil {
			t.Fatalf("Phase 2 accepted a %d-byte beacon", size)
		}
	}

	phase2Beacon := bytes.Repeat([]byte{0xb2}, 32)
	pk, vk, err := SealPhase2(circuit, reloadedCommons, phase2Beacon, phase2)
	if err != nil {
		t.Fatalf("seal Phase 2: %v", err)
	}
	pkAgain, vkAgain, err := SealPhase2(circuit, reloadedCommons, phase2Beacon, phase2)
	if err != nil {
		t.Fatalf("replay and reseal Phase 2: %v", err)
	}
	if left, right := adversarialSerialize(t, pk), adversarialSerialize(t, pkAgain); !bytes.Equal(left, right) {
		t.Fatal("replaying the same Phase 2 transcript and beacon produced different proving keys")
	}
	if left, right := adversarialSerialize(t, vk), adversarialSerialize(t, vkAgain); !bytes.Equal(left, right) {
		t.Fatal("replaying the same Phase 2 transcript and beacon produced different verifying keys")
	}
	for i := range phase2 {
		if got := adversarialSerialize(t, phase2[i]); !bytes.Equal(got, phase2Archive[i]) {
			t.Fatalf("Phase 2 archive %d mutated during sealing", i+1)
		}
	}

	assignment := &adversarialCommittedCircuit{Public: 7, Secret: 7}
	witness, err := frontend.NewWitness(assignment, ecc.BLS12_381.ScalarField())
	if err != nil {
		t.Fatalf("build witness: %v", err)
	}
	publicWitness, err := witness.Public()
	if err != nil {
		t.Fatalf("extract public witness: %v", err)
	}
	proof, err := groth16.Prove(circuit.R1CS, pk, witness)
	if err != nil {
		t.Fatalf("prove with MPC key: %v", err)
	}
	if err := groth16.Verify(proof, vk, publicWitness); err != nil {
		t.Fatalf("verify MPC proof: %v", err)
	}
	var staleAlphaEncoding bytes.Buffer
	if _, err := vk.WriteTo(&staleAlphaEncoding); err != nil {
		t.Fatal(err)
	}
	staleAlpha := groth16.NewVerifyingKey(ecc.BLS12_381)
	if _, err := staleAlpha.ReadFrom(bytes.NewReader(staleAlphaEncoding.Bytes())); err != nil {
		t.Fatal(err)
	}
	staleAlphaConcrete := staleAlpha.(*groth16bls12381.VerifyingKey)
	staleAlphaConcrete.G1.Alpha.Neg(&staleAlphaConcrete.G1.Alpha)
	originalCardanoVK, _, err := prover.SerializeCardanoVK(vk)
	if err != nil {
		t.Fatal(err)
	}
	staleAlphaCardanoVK, _, err := prover.SerializeCardanoVK(staleAlpha)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(originalCardanoVK, staleAlphaCardanoVK) {
		t.Fatal("stale Alpha mutation did not change serialized Cardano VK")
	}
	// This captures the regression that motivated cloneWrongVerifyingKey's
	// G1.K mutation: gnark verifies with the E pairing precomputed by ReadFrom,
	// so mutating Alpha afterward changes bytes but not verifier behavior.
	if err := groth16.Verify(proof, staleAlpha, publicWitness); err != nil {
		t.Fatalf("pinned gnark no longer exhibits stale-Alpha behavior: %v", err)
	}
	wrongVK, err := cloneWrongVerifyingKey(vk)
	if err != nil {
		t.Fatal(err)
	}
	if err := groth16.Verify(proof, wrongVK, publicWitness); err == nil {
		t.Fatal("verifier-consumed wrong VK unexpectedly accepted the proof")
	}
	wrongCardanoVK, _, err := prover.SerializeCardanoVK(wrongVK)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(originalCardanoVK, wrongCardanoVK) {
		t.Fatal("wrong VK negative did not change Cardano VK semantics")
	}
	originalNativeDigest, err := writerDigest(vk)
	if err != nil {
		t.Fatal(err)
	}
	wrongNativeDigest, err := writerDigest(wrongVK)
	if err != nil {
		t.Fatal(err)
	}
	if originalNativeDigest == wrongNativeDigest {
		t.Fatal("wrong VK negative did not change native VK semantics")
	}
	wrongPublicWitness, err := frontend.NewWitness(
		&adversarialCommittedCircuit{Public: 8},
		ecc.BLS12_381.ScalarField(),
		frontend.PublicOnly(),
	)
	if err != nil {
		t.Fatalf("build wrong public witness: %v", err)
	}
	if err := groth16.Verify(proof, vk, wrongPublicWitness); err == nil {
		t.Fatal("MPC proof unexpectedly verified with the wrong public input")
	}

	cardanoVK, format, err := prover.SerializeCardanoVK(vk)
	if err != nil {
		t.Fatalf("serialize Cardano VK: %v", err)
	}
	if format != "groth16-bls12-381-bsb22" {
		t.Fatalf("Cardano VK format = %q", format)
	}
	if len(cardanoVK) != prover.CardanoVKCommitmentLen {
		t.Fatalf("Cardano VK length = %d, want %d", len(cardanoVK), prover.CardanoVKCommitmentLen)
	}
	var independentlySerialized []byte
	alpha := vk.G1.Alpha.Bytes()
	beta := vk.G2.Beta.Bytes()
	gamma := vk.G2.Gamma.Bytes()
	delta := vk.G2.Delta.Bytes()
	k0 := vk.G1.K[0].Bytes()
	k1 := vk.G1.K[1].Bytes()
	k2 := vk.G1.K[2].Bytes()
	commitmentG := vk.CommitmentKeys[0].G.Bytes()
	commitmentGSigmaNeg := vk.CommitmentKeys[0].GSigmaNeg.Bytes()
	independentlySerialized = append(independentlySerialized, alpha[:]...)
	independentlySerialized = append(independentlySerialized, beta[:]...)
	independentlySerialized = append(independentlySerialized, gamma[:]...)
	independentlySerialized = append(independentlySerialized, delta[:]...)
	independentlySerialized = append(independentlySerialized, k0[:]...)
	independentlySerialized = append(independentlySerialized, k1[:]...)
	independentlySerialized = append(independentlySerialized, k2[:]...)
	independentlySerialized = append(independentlySerialized, commitmentG[:]...)
	independentlySerialized = append(independentlySerialized, commitmentGSigmaNeg[:]...)
	if !bytes.Equal(cardanoVK, independentlySerialized) {
		t.Fatal("Cardano VK bytes do not equal the independently serialized native MPC VK fields")
	}

	keyDir := t.TempDir()
	pkPath := filepath.Join(keyDir, "ownership.pk")
	vkPath := filepath.Join(keyDir, "ownership.vk")
	if err := prover.SavePK(pk, pkPath); err != nil {
		t.Fatalf("save native MPC PK: %v", err)
	}
	if err := prover.SaveVK(vk, vkPath); err != nil {
		t.Fatalf("save native MPC VK: %v", err)
	}
	reloadedPK, err := prover.LoadPK(pkPath)
	if err != nil {
		t.Fatalf("reload native MPC PK: %v", err)
	}
	reloadedVK, err := prover.LoadVK(vkPath)
	if err != nil {
		t.Fatalf("reload native MPC VK: %v", err)
	}
	reloadedCardanoVK, reloadedFormat, err := prover.SerializeCardanoVK(reloadedVK)
	if err != nil {
		t.Fatalf("serialize reloaded Cardano VK: %v", err)
	}
	if reloadedFormat != format || !bytes.Equal(reloadedCardanoVK, cardanoVK) {
		t.Fatal("native PK/VK persistence changed the Cardano VK")
	}
	reloadedProof, err := groth16.Prove(circuit.R1CS, reloadedPK, witness)
	if err != nil {
		t.Fatalf("prove with reloaded MPC key: %v", err)
	}
	if err := groth16.Verify(reloadedProof, reloadedVK, publicWitness); err != nil {
		t.Fatalf("verify with reloaded MPC key: %v", err)
	}
}

func TestSignedFileWorkflowRejectsReusedPhase1RoundBeforePublicationAndReplays(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping full signed two-phase ceremony lifecycle in the fast gate")
	}
	// Go test binaries omit dependency modules from debug.ReadBuildInfo. Build
	// the helper as an ordinary main binary so the real workflow software gate
	// verifies its exact executable, VCS, Go, gnark, gnark-crypto, and drand
	// identity without adding a production bypass or test seam.
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve integration test source path")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(thisFile), "..", ".."))
	helperPath := filepath.Join(t.TempDir(), "mpc-workflow-helper")
	build := exec.Command(
		"go",
		"build",
		"-o",
		helperPath,
		"./internal/mpcceremony/testdata/workflowhelper",
	)
	build.Dir = repoRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build ordinary workflow helper: %v\n%s", err, output)
	}
	workflowRoot := filepath.Join(t.TempDir(), "workflow")
	run := exec.Command(helperPath, workflowRoot)
	run.Dir = repoRoot
	if output, err := run.CombinedOutput(); err != nil {
		t.Fatalf("run signed workflow helper: %v\n%s", err, output)
	}

	circuit, err := BindDestinationV2R1CS(adversarialCompileCommitted(t))
	if err != nil {
		t.Fatalf("bind replay circuit: %v", err)
	}
	ceremonyRoot := filepath.Join(workflowRoot, "ceremony")
	coordinatorPublicKey, err := os.ReadFile(filepath.Join(
		workflowRoot,
		"identity-keys",
		"trusted-coordinator.ed25519.public.hex",
	))
	if err != nil {
		t.Fatal(err)
	}
	replayPaths := ReplayPaths{
		TranscriptRoot:            ceremonyRoot,
		CoordinatorPublicKeyHex:   strings.TrimSpace(string(coordinatorPublicKey)),
		DefinitionPath:            filepath.Join(ceremonyRoot, "ceremony.json"),
		DefinitionSignaturePath:   filepath.Join(ceremonyRoot, "ceremony.sig"),
		Phase1ChainPath:           filepath.Join(ceremonyRoot, "phase1", "chain-0002.json"),
		Phase1ChainSignaturePath:  filepath.Join(ceremonyRoot, "phase1", "chain-0002.sig"),
		Phase1ClosePath:           filepath.Join(ceremonyRoot, "phase1", "closure", "record.json"),
		Phase1CloseSignaturePath:  filepath.Join(ceremonyRoot, "phase1", "closure", "record.sig"),
		Phase1BeaconPath:          filepath.Join(ceremonyRoot, "phase1", "beacon", "record.json"),
		Phase1BeaconSignaturePath: filepath.Join(ceremonyRoot, "phase1", "beacon", "record.sig"),
		Phase1SealPath:            filepath.Join(ceremonyRoot, "phase1", "sealed", "seal.json"),
		Phase1SealSignaturePath:   filepath.Join(ceremonyRoot, "phase1", "sealed", "seal.sig"),
		Phase2ChainPath:           filepath.Join(ceremonyRoot, "phase2", "chain-0002.json"),
		Phase2ChainSignaturePath:  filepath.Join(ceremonyRoot, "phase2", "chain-0002.sig"),
		Phase2ClosePath:           filepath.Join(ceremonyRoot, "phase2", "closure", "record.json"),
		Phase2CloseSignaturePath:  filepath.Join(ceremonyRoot, "phase2", "closure", "record.sig"),
		Phase2BeaconPath:          filepath.Join(ceremonyRoot, "phase2", "beacon", "record.json"),
		Phase2BeaconSignaturePath: filepath.Join(ceremonyRoot, "phase2", "beacon", "record.sig"),
	}
	loaded, err := loadReplay(replayPaths)
	if err != nil {
		t.Fatalf("load reduced signed replay paths: %v", err)
	}
	replayed, err := replayAll(circuit, loaded, replayPaths)
	if err != nil {
		t.Fatalf("replay complete signed file workflow: %v", err)
	}
	witness, err := frontend.NewWitness(
		&adversarialCommittedCircuit{Public: 9, Secret: 9},
		ecc.BLS12_381.ScalarField(),
	)
	if err != nil {
		t.Fatal(err)
	}
	publicWitness, err := witness.Public()
	if err != nil {
		t.Fatal(err)
	}
	proof, err := groth16.Prove(circuit.R1CS, replayed.pk, witness)
	if err != nil {
		t.Fatalf("prove with fully replayed file-workflow key: %v", err)
	}
	if err := groth16.Verify(proof, replayed.vk, publicWitness); err != nil {
		t.Fatalf("verify with fully replayed file-workflow key: %v", err)
	}

	trusted, err := LoadSignedDefinition(TrustPaths{
		DefinitionPath:           replayPaths.DefinitionPath,
		DefinitionSignaturePath:  replayPaths.DefinitionSignaturePath,
		CoordinatorPublicKeyPath: filepath.Join(workflowRoot, "identity-keys", "trusted-coordinator.ed25519.public.hex"),
	})
	if err != nil {
		t.Fatalf("load trust for Phase 2 boundary check: %v", err)
	}
	if _, _, _, err := loadPhase1CommonsForPhase2(
		trusted,
		circuit,
		ceremonyRoot,
		replayPaths.Phase1SealPath,
		replayPaths.Phase1SealSignaturePath,
	); err != nil {
		t.Fatalf("Phase 2 boundary rejected complete Phase 1 evidence: %v", err)
	}

	var phase1Beacon BeaconRecord
	if err := loadCoordinatorSignedRecord(
		trusted,
		replayPaths.Phase1BeaconPath,
		replayPaths.Phase1BeaconSignaturePath,
		&phase1Beacon,
	); err != nil {
		t.Fatal(err)
	}
	challenge, err := hex.DecodeString(phase1Beacon.ChallengeHex)
	if err != nil {
		t.Fatal(err)
	}
	wrongHead := gnarkmpc.NewPhase1(circuit.Binding.DomainSize)
	wrongCommons := wrongHead.Seal(challenge)
	forgedDir := filepath.Join(ceremonyRoot, "phase1", "forged-sealed")
	if err := os.Mkdir(forgedDir, 0o700); err != nil {
		t.Fatal(err)
	}
	forgedCommonsPath := filepath.Join(forgedDir, "commons.bin")
	forgedDigest, err := WriteCommonsFileNoReplace(
		forgedCommonsPath,
		&wrongCommons,
		CommonsShape{DomainN: circuit.Binding.DomainSize},
	)
	if err != nil {
		t.Fatal(err)
	}
	var originalSeal SealRecord
	if err := loadCoordinatorSignedRecord(
		trusted,
		replayPaths.Phase1SealPath,
		replayPaths.Phase1SealSignaturePath,
		&originalSeal,
	); err != nil {
		t.Fatal(err)
	}
	forgedName, err := logicalPathWithin(ceremonyRoot, forgedCommonsPath)
	if err != nil {
		t.Fatal(err)
	}
	forgedSeal := originalSeal
	forgedSeal.SealID = ""
	forgedSeal.Outputs = append([]ArtifactRef(nil), originalSeal.Outputs...)
	foundCommons := false
	for index := range forgedSeal.Outputs {
		if strings.HasSuffix(forgedSeal.Outputs[index].Name, "/commons.bin") {
			forgedSeal.Outputs[index] = ArtifactRef{
				Name:   forgedName,
				Digest: modelDigest(forgedDigest),
			}
			foundCommons = true
		}
	}
	if !foundCommons {
		t.Fatal("fixture Phase 1 seal has no commons output")
	}
	forgedSeal, err = NewSealRecord(forgedSeal)
	if err != nil {
		t.Fatal(err)
	}
	coordinatorPrivate, _, err := loadMatchingPrivateKey(
		filepath.Join(workflowRoot, "identity-keys", "coordinator.ed25519.private.hex"),
		trusted.Definition.Coordinator,
	)
	if err != nil {
		t.Fatal(err)
	}
	forgedSealPath := filepath.Join(forgedDir, "seal.json")
	forgedSignaturePath := filepath.Join(forgedDir, "seal.sig")
	if err := writeSignedRecordNoReplace(
		forgedSealPath,
		forgedSignaturePath,
		forgedSeal,
		trusted.Definition.Coordinator.KeyID,
		coordinatorPrivate,
	); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := loadPhase1CommonsForPhase2(
		trusted,
		circuit,
		ceremonyRoot,
		forgedSealPath,
		forgedSignaturePath,
	); err == nil || !strings.Contains(err.Error(), "not derived") {
		t.Fatalf(
			"Phase 2 boundary accepted coordinator-signed commons from deterministic genesis: %v",
			err,
		)
	}

	hiddenClosePath := replayPaths.Phase1ClosePath + ".hidden"
	if err := os.Rename(replayPaths.Phase1ClosePath, hiddenClosePath); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := loadPhase1CommonsForPhase2(
		trusted,
		circuit,
		ceremonyRoot,
		replayPaths.Phase1SealPath,
		replayPaths.Phase1SealSignaturePath,
	); err == nil {
		t.Fatal("Phase 2 boundary accepted a seal without independently replayable Phase 1 closure evidence")
	}
	if err := os.Rename(hiddenClosePath, replayPaths.Phase1ClosePath); err != nil {
		t.Fatal(err)
	}

	originalClosureDir := filepath.Dir(replayPaths.Phase1ClosePath)
	preservedClosureDir := originalClosureDir + ".historical"
	if err := os.Rename(originalClosureDir, preservedClosureDir); err != nil {
		t.Fatal(err)
	}
	roundTime, err := QuicknetRoundTime(42)
	if err != nil {
		t.Fatal(err)
	}
	closeOptions := ClosePhaseFilesOptions{
		Trust: TrustPaths{
			DefinitionPath:           replayPaths.DefinitionPath,
			DefinitionSignaturePath:  replayPaths.DefinitionSignaturePath,
			CoordinatorPublicKeyPath: filepath.Join(workflowRoot, "identity-keys", "trusted-coordinator.ed25519.public.hex"),
		},
		Circuit:                   circuit,
		Phase:                     Phase1,
		Transcript:                PhaseTranscriptPaths{RootDir: ceremonyRoot, ChainPath: replayPaths.Phase1ChainPath, ChainSignaturePath: replayPaths.Phase1ChainSignaturePath},
		CoordinatorPrivateKeyPath: filepath.Join(workflowRoot, "identity-keys", "coordinator.ed25519.private.hex"),
		BeaconRound:               42,
	}
	expiredTimes := []time.Time{
		roundTime.Add(-4 * time.Second),
		roundTime.Add(-closePublicationSafetyMargin - time.Second + time.Nanosecond),
	}
	expiredClock := func() time.Time {
		value := expiredTimes[0]
		expiredTimes = expiredTimes[1:]
		return value
	}
	if _, err := closePhaseFilesAuthenticated(
		closeOptions,
		trusted,
		expiredClock,
	); err == nil ||
		!strings.Contains(err.Error(), "below required") {
		t.Fatalf("post-replay expired close error = %v, want publication-time rejection", err)
	}
	if _, err := os.Lstat(originalClosureDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expired close published an atomic closure directory: %v", err)
	}

	validTimes := []time.Time{
		roundTime.Add(-4 * time.Second),
		roundTime.Add(-closePublicationSafetyMargin - time.Second),
	}
	validClock := func() time.Time {
		value := validTimes[0]
		validTimes = validTimes[1:]
		return value
	}
	publishedClose, err := closePhaseFilesAuthenticated(
		closeOptions,
		trusted,
		validClock,
	)
	if err != nil {
		t.Fatalf("publish boundary-valid atomic closure: %v", err)
	}
	for _, path := range []string{
		publishedClose.ClosePath,
		publishedClose.SignaturePath,
	} {
		if info, err := os.Lstat(path); err != nil || !info.Mode().IsRegular() {
			t.Fatalf("atomic closure member %q is absent or unsafe: %v", path, err)
		}
	}
	retriedClose, err := publishReplayedPhaseClose(closeOptions, trusted, loaded.phase1Chain, func() time.Time {
		panic("completed closure retry must not consult the clock")
	})
	if err != nil {
		t.Fatalf("retry complete atomic closure after publication: %v", err)
	}
	if retriedClose.Close.CloseID != publishedClose.Close.CloseID {
		t.Fatal("complete closure retry did not return the exact committed record")
	}
	if err := os.RemoveAll(originalClosureDir); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(preservedClosureDir, originalClosureDir); err != nil {
		t.Fatal(err)
	}

	// The public close entry point must complete authentication and native
	// replay before consulting its clock. Corrupting an accepted payload must
	// therefore reject without ever reaching the injected clock.
	phase1PayloadPath := filepath.Join(
		ceremonyRoot,
		filepath.FromSlash(loaded.phase1Chain.Records[0].OutputPayload.Name),
	)
	phase1PayloadBytes, err := os.ReadFile(phase1PayloadPath)
	if err != nil {
		t.Fatal(err)
	}
	tamperedPhase1Payload := append([]byte(nil), phase1PayloadBytes...)
	tamperedPhase1Payload[len(tamperedPhase1Payload)-1] ^= 0x01
	if err := os.WriteFile(phase1PayloadPath, tamperedPhase1Payload, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := closePhaseFilesAuthenticated(closeOptions, trusted, func() time.Time {
		panic("close clock consulted before failed replay")
	}); err == nil {
		t.Fatal("top-level close accepted a corrupted replay prefix")
	}
	if err := os.WriteFile(phase1PayloadPath, phase1PayloadBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	// ReplayPaths intentionally carries no participant evidence paths. Those
	// are resolved from authenticated chain refs, so derived-file tampering
	// must still fail the replay loader.
	erasurePath := filepath.Join(
		ceremonyRoot,
		"phase2",
		"contributions",
		"0002",
		"erasure.json",
	)
	if err := os.WriteFile(erasurePath, []byte("tampered derived erasure evidence"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadReplay(replayPaths); err == nil {
		t.Fatal("reduced replay accepted tampering in chain-referenced erasure evidence")
	}
}
