package mpcceremony

import (
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	gnarkmpc "github.com/consensys/gnark/backend/groth16/bls12-381/mpcsetup"
)

type directAcceptanceFixture struct {
	ceremonyRoot        string
	circuit             *CompiledCircuit
	trusted             *TrustedCeremony
	coordinatorKeyPath  string
	phase1SealPath      string
	phase1SealSignature string
	phase1Chain1        PhaseTranscriptPaths
	phase2Chain0        PhaseTranscriptPaths
	phase2Chain1        PhaseTranscriptPaths
}

func TestCoordinatorDirectTransitionProtocolBoundaries(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping signed two-phase workflow boundary tests in the fast gate")
	}
	fixture := newDirectAcceptanceFixture(t)

	t.Run("Phase1 rejects candidate derived from genesis instead of authenticated head", func(t *testing.T) {
		chain, err := loadVerifiedPhase1Files(
			fixture.trusted,
			fixture.circuit,
			fixture.phase1Chain1,
		)
		if err != nil {
			t.Fatalf("load authenticated Phase 1 prefix: %v", err)
		}
		authenticatedHead, err := phase1FileLoader(
			fixture.ceremonyRoot,
			chain,
			fixture.circuit.Binding.DomainSize,
		)(0)
		if err != nil {
			t.Fatalf("load authenticated Phase 1 head: %v", err)
		}
		wrongPredecessorCandidate, err := ContributePhase1(
			fixture.circuit.Binding.DomainSize,
			nil,
		)
		if err != nil {
			t.Fatalf("make fresh Phase 1 candidate from genesis: %v", err)
		}
		if err := verifyPhase1Transition(
			fixture.circuit.Binding.DomainSize,
			authenticatedHead,
			wrongPredecessorCandidate,
		); err == nil {
			t.Fatal("direct Phase 1 transition accepted a candidate derived from genesis instead of the authenticated head")
		}
		if err := ReplayPhase1(
			fixture.circuit.Binding.DomainSize,
			[]*gnarkmpc.Phase1{authenticatedHead, wrongPredecessorCandidate},
		); err == nil {
			t.Fatal("full Phase 1 replay accepted an invalid second edge")
		}
	})

	t.Run("Phase2 rejects candidate derived from genesis instead of authenticated head", func(t *testing.T) {
		commons, seal, _, err := loadAuthenticatedPhase1CommonsForCoordinator(
			fixture.trusted,
			fixture.circuit,
			fixture.ceremonyRoot,
			fixture.phase1SealPath,
			fixture.phase1SealSignature,
		)
		if err != nil {
			t.Fatalf("load authenticated Phase 1 commons: %v", err)
		}
		chain, err := loadVerifiedPhase2Files(
			fixture.trusted,
			fixture.circuit,
			commons,
			seal,
			fixture.phase2Chain1,
		)
		if err != nil {
			t.Fatalf("load authenticated Phase 2 prefix: %v", err)
		}
		authenticatedHead, err := phase2FileLoader(
			fixture.ceremonyRoot,
			chain,
			contributionPhase2Shape(fixture.circuit.Binding.Phase2Shape),
		)(0)
		if err != nil {
			t.Fatalf("load authenticated Phase 2 head: %v", err)
		}
		wrongPredecessorCandidate, err := ContributePhase2(
			fixture.circuit,
			commons,
			nil,
		)
		if err != nil {
			t.Fatalf("make fresh Phase 2 candidate from genesis: %v", err)
		}
		if err := verifyPhase2Transition(
			authenticatedHead,
			wrongPredecessorCandidate,
		); err == nil {
			t.Fatal("direct Phase 2 transition accepted a candidate derived from genesis instead of the authenticated head")
		}
		if err := ReplayPhase2(
			fixture.circuit,
			commons,
			[]*gnarkmpc.Phase2{authenticatedHead, wrongPredecessorCandidate},
		); err == nil {
			t.Fatal("full Phase 2 replay accepted an invalid second edge")
		}
	})

	t.Run("Phase2 rejects signed forged commons against authentic genesis", func(t *testing.T) {
		forgedSealPath, forgedSealSignaturePath, forgedChain := forgeCommonsAndRebindEmptyPhase2Chain(
			t,
			fixture,
		)
		commons, seal, _, err := loadAuthenticatedPhase1CommonsForCoordinator(
			fixture.trusted,
			fixture.circuit,
			fixture.ceremonyRoot,
			forgedSealPath,
			forgedSealSignaturePath,
		)
		if err != nil {
			t.Fatalf("forged coordinator-signed commons did not reach Phase 2 genesis binding: %v", err)
		}
		_, err = loadVerifiedPhase2Files(
			fixture.trusted,
			fixture.circuit,
			commons,
			seal,
			forgedChain,
		)
		if err == nil || !strings.Contains(err.Error(), "genesis is not the deterministic circuit/commons initialization") {
			t.Fatalf("forged-commons Phase 2 boundary error = %v, want authentic-genesis mismatch", err)
		}
	})
}

func newDirectAcceptanceFixture(t *testing.T) directAcceptanceFixture {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve boundary test source path")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(thisFile), "..", ".."))
	root := t.TempDir()
	helperPath := filepath.Join(root, "mpc-workflow-helper")
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
	workflowRoot := filepath.Join(root, "workflow")
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
	keyRoot := filepath.Join(workflowRoot, "identity-keys")
	trust := TrustPaths{
		DefinitionPath:           filepath.Join(ceremonyRoot, "ceremony.json"),
		DefinitionSignaturePath:  filepath.Join(ceremonyRoot, "ceremony.sig"),
		CoordinatorPublicKeyPath: filepath.Join(keyRoot, "trusted-coordinator.ed25519.public.hex"),
	}
	trusted, err := LoadSignedDefinition(trust)
	if err != nil {
		t.Fatalf("load signed workflow fixture: %v", err)
	}
	phasePaths := func(phase Phase, index int) PhaseTranscriptPaths {
		chainPath := filepath.Join(
			ceremonyRoot,
			string(phase),
			fmt.Sprintf("chain-%04d.json", index),
		)
		return PhaseTranscriptPaths{
			RootDir:            ceremonyRoot,
			ChainPath:          chainPath,
			ChainSignaturePath: DefaultSignaturePath(chainPath),
		}
	}
	sealPath := filepath.Join(ceremonyRoot, "phase1", "sealed", "seal.json")
	return directAcceptanceFixture{
		ceremonyRoot:        ceremonyRoot,
		circuit:             circuit,
		trusted:             trusted,
		coordinatorKeyPath:  filepath.Join(keyRoot, "coordinator.ed25519.private.hex"),
		phase1SealPath:      sealPath,
		phase1SealSignature: DefaultSignaturePath(sealPath),
		phase1Chain1:        phasePaths(Phase1, 1),
		phase2Chain0:        phasePaths(Phase2, 0),
		phase2Chain1:        phasePaths(Phase2, 1),
	}
}

func forgeCommonsAndRebindEmptyPhase2Chain(
	t *testing.T,
	fixture directAcceptanceFixture,
) (string, string, PhaseTranscriptPaths) {
	t.Helper()
	var beacon BeaconRecord
	if err := loadCoordinatorSignedRecord(
		fixture.trusted,
		filepath.Join(fixture.ceremonyRoot, "phase1", "beacon", "record.json"),
		filepath.Join(fixture.ceremonyRoot, "phase1", "beacon", "record.sig"),
		&beacon,
	); err != nil {
		t.Fatalf("load authentic Phase 1 beacon: %v", err)
	}
	challenge, err := hex.DecodeString(beacon.ChallengeHex)
	if err != nil {
		t.Fatal(err)
	}
	wrongHead := gnarkmpc.NewPhase1(fixture.circuit.Binding.DomainSize)
	wrongCommons := wrongHead.Seal(challenge)
	forgedDir := filepath.Join(fixture.ceremonyRoot, "phase1", "coordinator-forged-sealed")
	if err := os.Mkdir(forgedDir, 0o700); err != nil {
		t.Fatal(err)
	}
	commonsPath := filepath.Join(forgedDir, "commons.bin")
	commonsDigest, err := WriteCommonsFileNoReplace(
		commonsPath,
		&wrongCommons,
		CommonsShape{DomainN: fixture.circuit.Binding.DomainSize},
	)
	if err != nil {
		t.Fatalf("write forged commons: %v", err)
	}

	var seal SealRecord
	if err := loadCoordinatorSignedRecord(
		fixture.trusted,
		fixture.phase1SealPath,
		fixture.phase1SealSignature,
		&seal,
	); err != nil {
		t.Fatalf("load authentic Phase 1 seal: %v", err)
	}
	commonsName, err := logicalPathWithin(fixture.ceremonyRoot, commonsPath)
	if err != nil {
		t.Fatal(err)
	}
	commonsOutputFound := false
	for index := range seal.Outputs {
		if strings.HasSuffix(seal.Outputs[index].Name, "/commons.bin") {
			seal.Outputs[index] = ArtifactRef{
				Name:   commonsName,
				Digest: modelDigest(commonsDigest),
			}
			commonsOutputFound = true
		}
	}
	if !commonsOutputFound {
		t.Fatal("authentic Phase 1 seal has no commons output")
	}
	seal, err = NewSealRecord(seal)
	if err != nil {
		t.Fatalf("rebuild signed forged seal: %v", err)
	}
	coordinatorPrivate, _, err := loadMatchingPrivateKey(
		fixture.coordinatorKeyPath,
		fixture.trusted.Definition.Coordinator,
	)
	if err != nil {
		t.Fatal(err)
	}
	sealPath := filepath.Join(forgedDir, "seal.json")
	sealSignaturePath := filepath.Join(forgedDir, "seal.sig")
	if err := writeSignedRecordNoReplace(
		sealPath,
		sealSignaturePath,
		seal,
		fixture.trusted.Definition.Coordinator.KeyID,
		coordinatorPrivate,
	); err != nil {
		t.Fatalf("write signed forged seal: %v", err)
	}

	authenticChain, err := LoadSignedChain(fixture.trusted, fixture.phase2Chain0)
	if err != nil {
		t.Fatalf("load authentic empty Phase 2 chain: %v", err)
	}
	forgedPhaseID, err := ComputePhaseID(
		fixture.trusted.Definition.CeremonyID,
		Phase2,
		authenticChain.Genesis,
		seal.SealID,
	)
	if err != nil {
		t.Fatal(err)
	}
	forgedChain, err := NewChain(
		fixture.trusted.Definition.CeremonyID,
		Phase2,
		forgedPhaseID,
		authenticChain.Genesis,
	)
	if err != nil {
		t.Fatal(err)
	}
	chainPath := filepath.Join(fixture.ceremonyRoot, "phase2", "forged-chain-0000.json")
	chainSignaturePath := DefaultSignaturePath(chainPath)
	if err := writeSignedRecordNoReplace(
		chainPath,
		chainSignaturePath,
		forgedChain,
		fixture.trusted.Definition.Coordinator.KeyID,
		coordinatorPrivate,
	); err != nil {
		t.Fatalf("write signed forged Phase 2 chain: %v", err)
	}
	return sealPath, sealSignaturePath, PhaseTranscriptPaths{
		RootDir:            fixture.ceremonyRoot,
		ChainPath:          chainPath,
		ChainSignaturePath: chainSignaturePath,
	}
}
