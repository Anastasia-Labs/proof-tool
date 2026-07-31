package mpcceremony

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	gnarkmpc "github.com/consensys/gnark/backend/groth16/bls12-381/mpcsetup"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	"proof-tool/internal/prover"
)

type engineCommittedCircuit struct {
	Public frontend.Variable `gnark:",public"`
	Secret frontend.Variable
}

func (c *engineCommittedCircuit) Define(api frontend.API) error {
	committer, ok := api.(frontend.Committer)
	if !ok {
		return errors.New("compiler does not implement frontend.Committer")
	}
	commitment, err := committer.Commit(c.Secret)
	if err != nil {
		return err
	}
	api.AssertIsDifferent(commitment, 0)
	api.AssertIsEqual(api.Mul(c.Secret, c.Secret), c.Public)
	return nil
}

func compileEngineCircuit(t *testing.T) *CompiledCircuit {
	t.Helper()
	compiled, err := frontend.Compile(
		ecc.BLS12_381.ScalarField(),
		r1cs.NewBuilder,
		&engineCommittedCircuit{},
	)
	if err != nil {
		t.Fatalf("compile tiny committed circuit: %v", err)
	}
	circuit, err := BindDestinationV2R1CS(compiled)
	if err != nil {
		t.Fatalf("bind tiny committed circuit: %v", err)
	}
	return circuit
}

func serializeEngineArtifact(t *testing.T, value io.WriterTo) []byte {
	t.Helper()
	var encoded bytes.Buffer
	if _, err := value.WriteTo(&encoded); err != nil {
		t.Fatalf("serialize %T: %v", value, err)
	}
	return encoded.Bytes()
}

func assertEngineArchiveUnchanged(t *testing.T, before [][]byte, values []io.WriterTo) {
	t.Helper()
	if len(before) != len(values) {
		t.Fatalf("archive snapshot length %d != value length %d", len(before), len(values))
	}
	for i := range values {
		if got := serializeEngineArtifact(t, values[i]); !bytes.Equal(got, before[i]) {
			t.Fatalf("archived contribution %d was mutated", i+1)
		}
	}
}

func TestRunGnarkVerificationContainsPanics(t *testing.T) {
	err := runGnarkVerification("adversarial verifier", func() error {
		panic("upstream failure")
	})
	if err == nil || err.Error() != "adversarial verifier panic: upstream failure" {
		t.Fatalf("contained panic error = %v", err)
	}

	sentinel := errors.New("invalid update")
	if err := runGnarkVerification("ordinary verifier", func() error {
		return sentinel
	}); !errors.Is(err, sentinel) {
		t.Fatalf("ordinary verifier error = %v, want sentinel", err)
	}
}

func TestStreamCloneContainsDecoderPanic(t *testing.T) {
	err := streamClone(bytes.NewBufferString("canonical bytes"), panicReaderFrom{})
	if err == nil || !strings.Contains(err.Error(), "deserialize transcript panic: decoder failure") {
		t.Fatalf("contained stream decoder panic error = %v", err)
	}
}

func TestTinyCommittedCircuitMPCEngineRoundTrip(t *testing.T) {
	circuit := compileEngineCircuit(t)
	domainN := circuit.Binding.DomainSize
	if domainN >= 1<<10 {
		t.Fatalf("tiny test circuit unexpectedly selected domain %d", domainN)
	}
	if circuit.Binding.Phase2Shape.Commitments != 1 {
		t.Fatalf("commitments = %d, want 1", circuit.Binding.Phase2Shape.Commitments)
	}
	phase1Genesis, phase1GenesisShape, err := InitializePhase1(domainN)
	if err != nil {
		t.Fatalf("initialize Phase 1: %v", err)
	}
	if phase1GenesisShape.ChallengeLength != 0 || len(phase1Genesis.Challenge) != 0 {
		t.Fatalf(
			"Phase 1 genesis challenge lengths = shape:%d object:%d, want 0",
			phase1GenesisShape.ChallengeLength,
			len(phase1Genesis.Challenge),
		)
	}

	var phase1 []*gnarkmpc.Phase1
	for range 2 {
		before := make([][]byte, len(phase1))
		values := make([]io.WriterTo, len(phase1))
		for i := range phase1 {
			before[i] = serializeEngineArtifact(t, phase1[i])
			values[i] = phase1[i]
		}
		next, err := ContributePhase1(domainN, phase1)
		if err != nil {
			t.Fatalf("contribute Phase 1: %v", err)
		}
		assertEngineArchiveUnchanged(t, before, values)
		phase1 = append(phase1, next)
	}
	if err := ReplayPhase1(domainN, phase1); err != nil {
		t.Fatalf("replay Phase 1: %v", err)
	}
	phase1BeforeSeal := make([][]byte, len(phase1))
	phase1Values := make([]io.WriterTo, len(phase1))
	for i := range phase1 {
		phase1BeforeSeal[i] = serializeEngineArtifact(t, phase1[i])
		phase1Values[i] = phase1[i]
	}
	commons, err := SealPhase1(domainN, bytes.Repeat([]byte{0x31}, contributionChallengeSize), phase1)
	if err != nil {
		t.Fatalf("seal Phase 1: %v", err)
	}
	assertEngineArchiveUnchanged(t, phase1BeforeSeal, phase1Values)

	initialPhase2, initializedShape, err := InitializePhase2(circuit, commons)
	if err != nil {
		t.Fatalf("initialize Phase 2: %v", err)
	}
	if !equalPhase2Shape(initializedShape, circuit.Binding.Phase2Shape) {
		t.Fatalf("initialized Phase 2 shape = %+v, analytical binding = %+v", initializedShape, circuit.Binding.Phase2Shape)
	}
	if len(initialPhase2.Challenge) != 0 {
		t.Fatalf("initial Phase 2 challenge length = %d, want 0", len(initialPhase2.Challenge))
	}

	var phase2 []*gnarkmpc.Phase2
	for range 2 {
		before := make([][]byte, len(phase2))
		values := make([]io.WriterTo, len(phase2))
		for i := range phase2 {
			before[i] = serializeEngineArtifact(t, phase2[i])
			values[i] = phase2[i]
		}
		next, err := ContributePhase2(circuit, commons, phase2)
		if err != nil {
			t.Fatalf("contribute Phase 2: %v", err)
		}
		assertEngineArchiveUnchanged(t, before, values)
		phase2 = append(phase2, next)
	}
	if err := ReplayPhase2(circuit, commons, phase2); err != nil {
		t.Fatalf("replay Phase 2: %v", err)
	}
	phase2BeforeSeal := make([][]byte, len(phase2))
	phase2Values := make([]io.WriterTo, len(phase2))
	for i := range phase2 {
		phase2BeforeSeal[i] = serializeEngineArtifact(t, phase2[i])
		phase2Values[i] = phase2[i]
	}
	pk, vk, err := SealPhase2(
		circuit,
		commons,
		bytes.Repeat([]byte{0x32}, contributionChallengeSize),
		phase2,
	)
	if err != nil {
		t.Fatalf("seal Phase 2: %v", err)
	}
	assertEngineArchiveUnchanged(t, phase2BeforeSeal, phase2Values)

	assignment := &engineCommittedCircuit{Secret: 3, Public: 9}
	witness, err := frontend.NewWitness(assignment, ecc.BLS12_381.ScalarField())
	if err != nil {
		t.Fatalf("build witness: %v", err)
	}
	publicWitness, err := witness.Public()
	if err != nil {
		t.Fatalf("build public witness: %v", err)
	}
	proof, err := groth16.Prove(circuit.R1CS, pk, witness)
	if err != nil {
		t.Fatalf("prove with MPC key: %v", err)
	}
	if err := groth16.Verify(proof, vk, publicWitness); err != nil {
		t.Fatalf("verify with MPC key: %v", err)
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
}

func TestEngineRejectsWrongCurveAndInvalidChallenges(t *testing.T) {
	wrongCurve, err := frontend.Compile(
		ecc.BN254.ScalarField(),
		r1cs.NewBuilder,
		&engineCommittedCircuit{},
	)
	if err != nil {
		t.Fatalf("compile wrong-curve circuit: %v", err)
	}
	if _, err := BindDestinationV2R1CS(wrongCurve); err == nil {
		t.Fatal("BN254 R1CS unexpectedly accepted as BLS12-381")
	}

	circuit := compileEngineCircuit(t)
	domainN := circuit.Binding.DomainSize
	phase1, err := ContributePhase1(domainN, nil)
	if err != nil {
		t.Fatalf("contribute Phase 1: %v", err)
	}
	if _, err := SealPhase1(domainN, make([]byte, contributionChallengeSize-1), []*gnarkmpc.Phase1{phase1}); err == nil {
		t.Fatal("short Phase 1 beacon unexpectedly accepted")
	}

	badPhase1 := new(gnarkmpc.Phase1)
	if err := streamClone(phase1, badPhase1); err != nil {
		t.Fatal(err)
	}
	badPhase1.Challenge = badPhase1.Challenge[:contributionChallengeSize-1]
	if err := ReplayPhase1(domainN, []*gnarkmpc.Phase1{badPhase1}); err == nil {
		t.Fatal("short Phase 1 contribution challenge unexpectedly accepted")
	}

	commons, err := SealPhase1(
		domainN,
		bytes.Repeat([]byte{0x41}, contributionChallengeSize),
		[]*gnarkmpc.Phase1{phase1},
	)
	if err != nil {
		t.Fatalf("seal Phase 1: %v", err)
	}
	phase2, err := ContributePhase2(circuit, commons, nil)
	if err != nil {
		t.Fatalf("contribute Phase 2: %v", err)
	}
	if _, _, err := SealPhase2(
		circuit,
		commons,
		make([]byte, contributionChallengeSize+1),
		[]*gnarkmpc.Phase2{phase2},
	); err == nil {
		t.Fatal("long Phase 2 beacon unexpectedly accepted")
	}
	badPhase2 := new(gnarkmpc.Phase2)
	if err := streamClone(phase2, badPhase2); err != nil {
		t.Fatal(err)
	}
	badPhase2.Challenge = nil
	if err := ReplayPhase2(circuit, commons, []*gnarkmpc.Phase2{badPhase2}); err == nil {
		t.Fatal("empty Phase 2 contribution challenge unexpectedly accepted")
	}
}

func TestFrozenR1CSNoReplaceRoundTrip(t *testing.T) {
	circuit := compileEngineCircuit(t)
	dir := t.TempDir()
	path := filepath.Join(dir, prover.DestinationConstraintSystemFile)

	digest, err := WriteR1CSFileNoReplace(path, circuit)
	if err != nil {
		t.Fatalf("write frozen R1CS: %v", err)
	}
	if digest != circuit.Binding.R1CS.Digest {
		t.Fatalf("written digest = %+v, want %+v", digest, circuit.Binding.R1CS.Digest)
	}
	loaded, err := ReadR1CSFile(path, circuit.Binding)
	if err != nil {
		t.Fatalf("read frozen R1CS: %v", err)
	}
	if err := ValidateCircuitBinding(loaded, circuit.Binding); err != nil {
		t.Fatalf("validate loaded binding: %v", err)
	}
	if _, err := WriteR1CSFileNoReplace(path, circuit); err == nil {
		t.Fatal("second frozen R1CS write unexpectedly replaced destination")
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	raw[len(raw)/2] ^= 1
	tamperedPath := filepath.Join(dir, "tampered.ccs")
	if err := os.WriteFile(tamperedPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadR1CSFile(tamperedPath, circuit.Binding); err == nil {
		t.Fatal("tampered frozen R1CS unexpectedly accepted")
	}
}

func TestLoadedReplayReadsCompleteChain(t *testing.T) {
	const count = 3
	circuit := compileEngineCircuit(t)
	domainN := circuit.Binding.DomainSize
	phase1 := make([]*gnarkmpc.Phase1, 0, count)
	for range count {
		next, err := ContributePhase1(domainN, phase1)
		if err != nil {
			t.Fatal(err)
		}
		phase1 = append(phase1, next)
	}

	loads := 0
	err := ReplayPhase1Loaded(domainN, len(phase1), func(index int) (*gnarkmpc.Phase1, error) {
		loads++
		decoded := new(gnarkmpc.Phase1)
		if err := streamClone(phase1[index], decoded); err != nil {
			return nil, err
		}
		return decoded, nil
	})
	if err != nil {
		t.Fatalf("loaded Phase 1 replay: %v", err)
	}
	if loads != count {
		t.Fatalf("loader calls = %d, want %d", loads, count)
	}
}
