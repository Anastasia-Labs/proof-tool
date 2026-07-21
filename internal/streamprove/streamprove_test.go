package streamprove

import (
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	curve "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"
	"github.com/consensys/gnark/backend/groth16"
	groth16_bls12381 "github.com/consensys/gnark/backend/groth16/bls12-381"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	"proof-tool/internal/msmengine"
	"proof-tool/internal/prover"
	"proof-tool/internal/streampk"
)

type committedCircuit struct {
	P frontend.Variable `gnark:",public"`
	S frontend.Variable
}

func (c *committedCircuit) Define(api frontend.API) error {
	committer, ok := api.(frontend.Committer)
	if !ok {
		return fmt.Errorf("compiler does not commit")
	}
	cm, err := committer.Commit(c.S)
	if err != nil {
		return err
	}
	api.AssertIsDifferent(cm, 0)
	api.AssertIsEqual(c.P, c.S)
	return nil
}

func TestProveStreamCommitmentSectionsVerifyWithIndexedKey(t *testing.T) {
	ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &committedCircuit{})
	if err != nil {
		t.Fatal(err)
	}
	pk, vk, err := groth16.Setup(ccs)
	if err != nil {
		t.Fatal(err)
	}

	pkPath := filepath.Join(t.TempDir(), "ownership.pk")
	f, err := os.Create(pkPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pk.WriteRawTo(f); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	source, err := streampk.OpenKeyFile(pkPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = source.Close() }()

	typedPK := pk.(*groth16_bls12381.ProvingKey)
	basis, err := source.G1("Basis", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(basis) != len(typedPK.CommitmentKeys[0].Basis) {
		t.Fatalf("Basis len = %d, want %d", len(basis), len(typedPK.CommitmentKeys[0].Basis))
	}
	for i := range basis {
		if !basis[i].Equal(&typedPK.CommitmentKeys[0].Basis[i]) {
			t.Fatalf("Basis point %d mismatch", i)
		}
	}
	sigma, err := source.G1("BasisExpSigma", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(sigma) != len(typedPK.CommitmentKeys[0].BasisExpSigma) {
		t.Fatalf("BasisExpSigma len = %d, want %d", len(sigma), len(typedPK.CommitmentKeys[0].BasisExpSigma))
	}
	for i := range sigma {
		if !sigma[i].Equal(&typedPK.CommitmentKeys[0].BasisExpSigma[i]) {
			t.Fatalf("BasisExpSigma point %d mismatch", i)
		}
	}

	assignment := &committedCircuit{P: 7, S: 7}
	witness, err := frontend.NewWitness(assignment, ecc.BLS12_381.ScalarField())
	if err != nil {
		t.Fatal(err)
	}
	streamProofGeneric, err := Prove(ccs, source, assignment)
	if err != nil {
		t.Fatal(err)
	}
	publicWitness, err := witness.Public()
	if err != nil {
		t.Fatal(err)
	}
	if err := groth16.Verify(streamProofGeneric, vk, publicWitness); err != nil {
		t.Fatalf("stream proof verify: %v", err)
	}

	streamProof := streamProofGeneric.(*groth16_bls12381.Proof)
	if len(streamProof.Commitments) != len(typedPK.CommitmentKeys) {
		t.Fatalf("commitments len = %d, want %d", len(streamProof.Commitments), len(typedPK.CommitmentKeys))
	}
	streamChallenge, streamDST, err := prover.CommitmentChallenge(streamProofGeneric)
	if err != nil {
		t.Fatal(err)
	}
	if streamDST != "bsb22-commitment" {
		t.Fatalf("challenge DST = %q", streamDST)
	}
	if len(streamChallenge) != 32 {
		t.Fatalf("challenge len = %d, want 32", len(streamChallenge))
	}
}

func TestProveStreamWithoutDomainPrecomputeVerifies(t *testing.T) {
	ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &committedCircuit{})
	if err != nil {
		t.Fatal(err)
	}
	pk, vk, err := groth16.Setup(ccs)
	if err != nil {
		t.Fatal(err)
	}

	pkPath := filepath.Join(t.TempDir(), "ownership.pk")
	f, err := os.Create(pkPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pk.WriteRawTo(f); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	source, err := streampk.OpenKeyFile(pkPath, streampk.WithDomainPrecompute(false))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = source.Close() }()
	domain := source.Domain()
	if _, err := domain.Twiddles(); err == nil {
		t.Fatal("no-precompute source unexpectedly retained domain twiddles")
	}

	assignment := &committedCircuit{P: 7, S: 7}
	streamProof, err := Prove(ccs, source, assignment)
	if err != nil {
		t.Fatal(err)
	}
	witness, err := frontend.NewWitness(assignment, ecc.BLS12_381.ScalarField())
	if err != nil {
		t.Fatal(err)
	}
	publicWitness, err := witness.Public()
	if err != nil {
		t.Fatal(err)
	}
	if err := groth16.Verify(streamProof, vk, publicWitness); err != nil {
		t.Fatalf("no-precompute stream proof verify: %v", err)
	}
}

func TestProveAndReleaseSuccessConsumesCCSAndEmitsTrace(t *testing.T) {
	ccs, source, vk := newCommittedStreamFixture(t)
	owner := ccs
	var released atomic.Bool
	restoreTrace := msmengine.SetTraceSink(func(event msmengine.TraceEvent) {
		if event.Phase == "end" && event.Stage == "release-ccs" && event.Fields["released"] == true {
			released.Store(true)
		}
	})
	defer restoreTrace()

	assignment := &committedCircuit{P: 7, S: 7}
	proof, err := ProveAndRelease(&owner, source, assignment)
	if err != nil {
		t.Fatal(err)
	}
	if owner != nil {
		t.Fatal("successful prove retained the consumed CCS owner")
	}
	if !released.Load() {
		t.Fatal("successful prove did not emit release-ccs trace")
	}
	verifyCommittedProof(t, proof, vk, assignment)
}

func TestProveAndReleaseSolveFailureRetainsCCS(t *testing.T) {
	ccs, source, _ := newCommittedStreamFixture(t)
	owner := ccs
	var released atomic.Bool
	restoreTrace := msmengine.SetTraceSink(func(event msmengine.TraceEvent) {
		if event.Stage == "release-ccs" {
			released.Store(true)
		}
	})
	defer restoreTrace()

	if _, err := ProveAndRelease(&owner, source, &committedCircuit{P: 7, S: 8}); err == nil {
		t.Fatal("invalid witness unexpectedly solved")
	}
	if owner == nil {
		t.Fatal("Solve failure consumed the CCS owner")
	}
	if released.Load() {
		t.Fatal("Solve failure emitted release-ccs trace")
	}
}

func TestPostSolveFailureReloadsCCSBeforeCPUFallback(t *testing.T) {
	ccs, source, vk := newCommittedStreamFixture(t)
	owner := ccs
	assignment := &committedCircuit{P: 7, S: 7}
	primary := &failSecondG1Engine{delegate: &sourceSectionEngine{source: source}}
	reloads := 0
	var proof groth16.Proof

	err := msmengine.WithFallbackReload(primary, func() error {
		if owner != nil {
			return fmt.Errorf("post-Solve primary failure retained CCS owner")
		}
		reloads++
		reloaded, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &committedCircuit{})
		if err != nil {
			return err
		}
		owner = reloaded
		return nil
	}, func(engine msmengine.MSMEngine) error {
		previous := msmengine.Current()
		msmengine.SetCurrent(engine)
		defer msmengine.SetCurrent(previous)
		candidate, err := ProveAndRelease(&owner, source, assignment)
		if err == nil {
			proof = candidate
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if reloads != 1 {
		t.Fatalf("CCS reloads = %d, want 1", reloads)
	}
	if owner != nil {
		t.Fatal("successful CPU retry retained reloaded CCS owner")
	}
	verifyCommittedProof(t, proof, vk, assignment)
}

func TestIntermediateDigestsFixedWitnessMatchAcrossW2AndBindWitness(t *testing.T) {
	ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &committedCircuit{})
	if err != nil {
		t.Fatal(err)
	}
	pk, vk, err := groth16.Setup(ccs)
	if err != nil {
		t.Fatal(err)
	}
	pkPath := filepath.Join(t.TempDir(), "ownership.pk")
	f, err := os.Create(pkPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pk.WriteRawTo(f); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	prove := func(precompute bool, value int) (msmengine.IntermediateDigestReport, groth16.Proof) {
		t.Helper()
		source, err := streampk.OpenKeyFile(pkPath, streampk.WithDomainPrecompute(precompute))
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = source.Close() }()
		source.SetPKSectionPlan(testSectionPlan(t, pkPath))
		recorder := msmengine.NewDigestRecorder()
		engine := msmengine.WrapWithDigestRecorder(&sourceSectionEngine{source: source}, recorder)
		previous := msmengine.Current()
		msmengine.SetCurrent(engine)
		defer msmengine.SetCurrent(previous)
		assignment := &committedCircuit{P: value, S: value}
		previousRandom := cryptorand.Reader
		cryptorand.Reader = constantReader(0x42)
		proof, err := func() (groth16.Proof, error) {
			defer func() { cryptorand.Reader = previousRandom }()
			return Prove(ccs, source, assignment)
		}()
		if err != nil {
			t.Fatal(err)
		}
		report, err := recorder.Snapshot()
		if err != nil {
			t.Fatal(err)
		}
		return report, proof
	}

	legacy, legacyProof := prove(true, 7)
	optimized, optimizedProof := prove(false, 7)
	if !reflect.DeepEqual(legacy, optimized) {
		t.Fatalf("W2 changed fixed-witness intermediate digests\nlegacy=%#v\noptimized=%#v", legacy, optimized)
	}
	changed, _ := prove(false, 8)
	if legacy.Stages["A"].ScalarInputs == changed.Stages["A"].ScalarInputs {
		t.Fatal("A scalar-input digest did not bind the changed witness")
	}
	for _, proof := range []groth16.Proof{legacyProof, optimizedProof} {
		witness, err := frontend.NewWitness(&committedCircuit{P: 7, S: 7}, ecc.BLS12_381.ScalarField())
		if err != nil {
			t.Fatal(err)
		}
		publicWitness, err := witness.Public()
		if err != nil {
			t.Fatal(err)
		}
		if err := groth16.Verify(proof, vk, publicWitness); err != nil {
			t.Fatalf("fixed-witness digest proof verify: %v", err)
		}
	}
}

type constantReader byte

func (r constantReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = byte(r)
	}
	return len(p), nil
}

type sourceSectionEngine struct {
	source *streampk.KeySource
}

func (e *sourceSectionEngine) Name() string { return "test-source-section" }
func (e *sourceSectionEngine) Close() error { return nil }

func (e *sourceSectionEngine) MSMG1(dst *curve.G1Jac, points []curve.G1Affine, scalars []fr.Element, progress msmengine.ProgressFn) error {
	_, err := dst.MultiExp(points, scalars, ecc.MultiExpConfig{NbTasks: 1})
	if err == nil && progress != nil {
		progress(len(scalars), len(scalars))
	}
	return err
}

func (e *sourceSectionEngine) MSMG2(dst *curve.G2Jac, points []curve.G2Affine, scalars []fr.Element, progress msmengine.ProgressFn) error {
	_, err := dst.MultiExp(points, scalars, ecc.MultiExpConfig{NbTasks: 1})
	if err == nil && progress != nil {
		progress(len(scalars), len(scalars))
	}
	return err
}

func (e *sourceSectionEngine) MSMG1Ranged(dst *curve.G1Jac, n int, fetch msmengine.FetchG1, scalars []fr.Element, progress msmengine.ProgressFn) error {
	points, err := fetch(0, n)
	if err != nil {
		return err
	}
	return e.MSMG1(dst, points, scalars, progress)
}

func (e *sourceSectionEngine) MSMG2Ranged(dst *curve.G2Jac, n int, fetch msmengine.FetchG2, scalars []fr.Element, progress msmengine.ProgressFn) error {
	points, err := fetch(0, n)
	if err != nil {
		return err
	}
	return e.MSMG2(dst, points, scalars, progress)
}

func (e *sourceSectionEngine) MSMG1Section(dst *curve.G1Jac, _ *msmengine.PKSectionPlan, section string, n int, scalars []fr.Element, progress msmengine.ProgressFn) error {
	return e.MSMG1Ranged(dst, n, func(lo, hi int) ([]curve.G1Affine, error) {
		return e.source.G1Range(section, lo, hi, nil)
	}, scalars, progress)
}

func (e *sourceSectionEngine) MSMG2Section(dst *curve.G2Jac, _ *msmengine.PKSectionPlan, section string, n int, scalars []fr.Element, progress msmengine.ProgressFn) error {
	return e.MSMG2Ranged(dst, n, func(lo, hi int) ([]curve.G2Affine, error) {
		return e.source.G2Range(section, lo, hi, nil)
	}, scalars, progress)
}

func testSectionPlan(t *testing.T, pkPath string) *msmengine.PKSectionPlan {
	t.Helper()
	index, err := streampk.BuildIndex(pkPath)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(pkPath)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	digestHex := hex.EncodeToString(digest[:])
	sections := make(map[string]msmengine.PKSection, len(index.Sections))
	for name, section := range index.Sections {
		sections[name] = msmengine.PKSection{Name: name, Offset: section.Offset, Len: section.Len, ElemSize: section.ElemSize}
	}
	return &msmengine.PKSectionPlan{
		AssetID:  "sha256:" + digestHex,
		FileSize: int64(len(raw)),
		Sections: sections,
		Chunks: []msmengine.PKChunkPin{{
			Index: 0, Offset: 0, Size: int64(len(raw)),
			SHA256: "sha256:" + digestHex, Blake2b256: "fixture:" + digestHex,
		}},
	}
}

func newCommittedStreamFixture(t *testing.T) (constraint.ConstraintSystem, *streampk.KeySource, groth16.VerifyingKey) {
	t.Helper()
	ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &committedCircuit{})
	if err != nil {
		t.Fatal(err)
	}
	pk, vk, err := groth16.Setup(ccs)
	if err != nil {
		t.Fatal(err)
	}
	pkPath := filepath.Join(t.TempDir(), "ownership.pk")
	f, err := os.Create(pkPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pk.WriteRawTo(f); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	source, err := streampk.OpenKeyFile(pkPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = source.Close() })
	return ccs, source, vk
}

func verifyCommittedProof(t *testing.T, proof groth16.Proof, vk groth16.VerifyingKey, assignment frontend.Circuit) {
	t.Helper()
	witness, err := frontend.NewWitness(assignment, ecc.BLS12_381.ScalarField())
	if err != nil {
		t.Fatal(err)
	}
	publicWitness, err := witness.Public()
	if err != nil {
		t.Fatal(err)
	}
	if err := groth16.Verify(proof, vk, publicWitness); err != nil {
		t.Fatalf("verify proof: %v", err)
	}
}

type failSecondG1Engine struct {
	delegate *sourceSectionEngine
	calls    int
}

func (e *failSecondG1Engine) Name() string { return "fail-after-solve" }
func (e *failSecondG1Engine) Close() error { return nil }

func (e *failSecondG1Engine) MSMG1(dst *curve.G1Jac, points []curve.G1Affine, scalars []fr.Element, progress msmengine.ProgressFn) error {
	e.calls++
	if e.calls == 2 {
		return fmt.Errorf("injected post-Solve BasisExpSigma failure")
	}
	return e.delegate.MSMG1(dst, points, scalars, progress)
}

func (e *failSecondG1Engine) MSMG2(dst *curve.G2Jac, points []curve.G2Affine, scalars []fr.Element, progress msmengine.ProgressFn) error {
	return e.delegate.MSMG2(dst, points, scalars, progress)
}

func (e *failSecondG1Engine) MSMG1Ranged(dst *curve.G1Jac, n int, fetch msmengine.FetchG1, scalars []fr.Element, progress msmengine.ProgressFn) error {
	e.calls++
	if e.calls == 2 {
		return fmt.Errorf("injected post-Solve BasisExpSigma failure")
	}
	return e.delegate.MSMG1Ranged(dst, n, fetch, scalars, progress)
}

func (e *failSecondG1Engine) MSMG2Ranged(dst *curve.G2Jac, n int, fetch msmengine.FetchG2, scalars []fr.Element, progress msmengine.ProgressFn) error {
	return e.delegate.MSMG2Ranged(dst, n, fetch, scalars, progress)
}
