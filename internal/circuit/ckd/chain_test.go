package ckd

import (
	"encoding/hex"
	"fmt"
	"math/rand"
	"runtime"
	"sync"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/constraint"
	csolver "github.com/consensys/gnark/constraint/solver"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/std/math/uints"

	"proof-tool/internal/circuit/ed25519/ed"
	"proof-tool/internal/circuit/sha512/sha"
)

const goldenMasterXPrvHex = "c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620"

const leafRandomCases = 1_000

const leafSolveWorkers = 8

type derivationMatrixCircuit struct {
	MasterKL, MasterKR, MasterCC [32]uints.U8
	Account, Role, Index         frontend.Variable
	ExpectedKL, ExpectedKR       [32]uints.U8
	ExpectedCC                   [32]uints.U8
}

func (c *derivationMatrixCircuit) Define(api frontend.API) error {
	uapi, err := uints.New[uints.U64](api)
	if err != nil {
		return err
	}
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	crv, err := ed.NewCurve(api)
	if err != nil {
		return err
	}
	leaf := DeriveChain(api, uapi, bapi, crv, c.MasterKL, c.MasterKR, c.MasterCC, c.Account, c.Role, c.Index)
	full := deriveChainFull(api, uapi, bapi, crv, c.MasterKL, c.MasterKR, c.MasterCC, c.Account, c.Role, c.Index)
	for i := range leaf.KL {
		// The optimized leaf must preserve exactly the KL bytes and canonical bit
		// vector produced by the pre-C2 full-state chain. The old full path is
		// also pinned to the independent Go reference's KR/CC outputs.
		bapi.AssertIsEqual(leaf.KL[i], full.KL[i])
		bapi.AssertIsEqual(leaf.KL[i], c.ExpectedKL[i])
		bapi.AssertIsEqual(full.KR[i], c.ExpectedKR[i])
		bapi.AssertIsEqual(full.CC[i], c.ExpectedCC[i])
	}
	for i := range leaf.KLbits {
		api.AssertIsEqual(leaf.KLbits[i], full.KLbits[i])
	}
	return nil
}

func TestDeriveChainOldAndNewGoldenMatrixAndBoundaries(t *testing.T) {
	master, err := hex.DecodeString(goldenMasterXPrvHex)
	if err != nil {
		t.Fatal(err)
	}
	ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &derivationMatrixCircuit{})
	if err != nil {
		t.Fatalf("compile derivation matrix circuit: %v", err)
	}

	pathCorpus := []struct {
		name           string
		account, index uint32
	}{
		{"zero", 0, 0},
		{"nonzero-account", 7, 0},
		{"nonzero-index", 0, 11},
		{"combined-nonzero", 7, 11},
		{"account-2^31-minus-1", 1<<31 - 1, 0},
		{"index-2^31-minus-1", 0, 1<<31 - 1},
	}
	accepted := make([]struct {
		name                 string
		account, role, index uint32
	}, 0, 3*len(pathCorpus))
	for role := uint32(0); role <= 2; role++ {
		for _, path := range pathCorpus {
			accepted = append(accepted, struct {
				name                 string
				account, role, index uint32
			}{
				name:    fmt.Sprintf("role-%d/%s", role, path.name),
				account: path.account,
				role:    role,
				index:   path.index,
			})
		}
	}
	for _, tc := range accepted {
		t.Run("accept/"+tc.name, func(t *testing.T) {
			assignment := derivationAssignment(master, tc.account, tc.role, tc.index)
			if err := solveDerivation(ccs, assignment); err != nil {
				t.Fatalf("valid path %d/%d/%d rejected: %v", tc.account, tc.role, tc.index, err)
			}
		})
	}

	rejected := []struct {
		name                 string
		account, role, index uint32
	}{
		{"role-3", 0, 3, 0},
		{"account-2^31", 1 << 31, 0, 0},
		{"account-2^31-plus-1", 1<<31 + 1, 0, 0},
		{"index-2^31", 0, 0, 1 << 31},
		{"index-2^31-plus-1", 0, 0, 1<<31 + 1},
	}
	for _, tc := range rejected {
		t.Run("reject/"+tc.name, func(t *testing.T) {
			assignment := derivationAssignment(master, tc.account, tc.role, tc.index)
			if err := solveDerivation(ccs, assignment); err == nil {
				t.Fatalf("invalid path %d/%d/%d satisfied the circuit", tc.account, tc.role, tc.index)
			}
		})
	}

	t.Run("reject/corrupt-master-chain-code", func(t *testing.T) {
		assignment := derivationAssignment(master, 0, 0, 0)
		assignment.MasterCC[0] = uints.NewU8(master[64] ^ 1)
		if err := solveDerivation(ccs, assignment); err == nil {
			t.Fatal("corrupt master chain-code byte unexpectedly preserved the golden leaf")
		}
	})
}

// deriveChainFull is the pre-C2 full-state path retained only as a differential
// oracle. Production must call DeriveChain, whose final result cannot expose KR
// or CC and whose fixed hardened intermediates skip unused KL decompositions.
func deriveChainFull(
	api frontend.API,
	uapi *uints.BinaryField[uints.U64],
	bapi *uints.Bytes,
	crv *ed.Curve,
	masterKL, masterKR, masterCC [32]uints.U8,
	account, role, index frontend.Variable,
) CircExt {
	mbits := BytesToCanonBits(api, masterKL)
	AssertClampBits(api, mbits)
	x := CircExt{KL: masterKL, KR: masterKR, CC: masterCC, KLbits: mbits}
	x = HardenedStep(api, uapi, bapi, x, constBytes(le32(1852|0x8000_0000)))
	x = HardenedStep(api, uapi, bapi, x, constBytes(le32(1815|0x8000_0000)))
	acc := le32Var(api, account, true)
	x = HardenedStep(api, uapi, bapi, x, acc[:])
	api.AssertIsEqual(api.Mul(role, api.Sub(role, 1), api.Sub(role, 2)), 0)
	roleLE := le32Var(api, role, false)
	indexLE := le32Var(api, index, false)
	x = SoftStep(api, uapi, bapi, crv, x, roleLE[:])
	return SoftStep(api, uapi, bapi, crv, x, indexLE[:])
}

type fixedHardenedDifferentialCircuit struct {
	MasterKL, MasterKR, MasterCC                   [32]uints.U8
	Expected1852KL, Expected1852KR, Expected1852CC [32]uints.U8
	Expected1815KL, Expected1815KR, Expected1815CC [32]uints.U8
}

func (c *fixedHardenedDifferentialCircuit) Define(api frontend.API) error {
	uapi, err := uints.New[uints.U64](api)
	if err != nil {
		return err
	}
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	master := CircExt{KL: c.MasterKL, KR: c.MasterKR, CC: c.MasterCC}
	old1852 := HardenedStep(api, uapi, bapi, master, constBytes(le32(1852|0x8000_0000)))
	new1852 := hardenedStepBytes(api, uapi, bapi, master, constBytes(le32(1852|0x8000_0000)))
	assertExtBytesEqual(api, bapi, old1852, new1852)
	assertExtBytesExpected(bapi, new1852, c.Expected1852KL, c.Expected1852KR, c.Expected1852CC)

	old1815 := HardenedStep(api, uapi, bapi, old1852, constBytes(le32(1815|0x8000_0000)))
	new1815 := hardenedStepBytes(api, uapi, bapi, new1852, constBytes(le32(1815|0x8000_0000)))
	assertExtBytesEqual(api, bapi, old1815, new1815)
	assertExtBytesExpected(bapi, new1815, c.Expected1815KL, c.Expected1815KR, c.Expected1815CC)
	return nil
}

func assertExtBytesEqual(api frontend.API, bapi *uints.Bytes, left, right CircExt) {
	for i := range left.KL {
		bapi.AssertIsEqual(left.KL[i], right.KL[i])
		bapi.AssertIsEqual(left.KR[i], right.KR[i])
		bapi.AssertIsEqual(left.CC[i], right.CC[i])
	}
	// The old path's extra KLbits must be exactly the canonical decomposition of
	// the same bytes; the optimized fixed states intentionally do not carry it.
	canonical := BytesToCanonBits(api, right.KL)
	for i := range canonical {
		api.AssertIsEqual(left.KLbits[i], canonical[i])
	}
}

func assertExtBytesExpected(bapi *uints.Bytes, got CircExt, wantKL, wantKR, wantCC [32]uints.U8) {
	for i := range got.KL {
		bapi.AssertIsEqual(got.KL[i], wantKL[i])
		bapi.AssertIsEqual(got.KR[i], wantKR[i])
		bapi.AssertIsEqual(got.CC[i], wantCC[i])
	}
}

func TestFixedHardenedByteStatesMatchFullNonLeafSteps(t *testing.T) {
	master, err := hex.DecodeString(goldenMasterXPrvHex)
	if err != nil {
		t.Fatal(err)
	}
	levels := DeriveLevels(master, 0, 0, 0)
	assignment := &fixedHardenedDifferentialCircuit{}
	setCircuitBytes(assignment.MasterKL[:], master[:32])
	setCircuitBytes(assignment.MasterKR[:], master[32:64])
	setCircuitBytes(assignment.MasterCC[:], master[64:96])
	setCircuitBytes(assignment.Expected1852KL[:], levels[0].KL[:])
	setCircuitBytes(assignment.Expected1852KR[:], levels[0].KR[:])
	setCircuitBytes(assignment.Expected1852CC[:], levels[0].CC[:])
	setCircuitBytes(assignment.Expected1815KL[:], levels[1].KL[:])
	setCircuitBytes(assignment.Expected1815KR[:], levels[1].KR[:])
	setCircuitBytes(assignment.Expected1815CC[:], levels[1].CC[:])

	ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &fixedHardenedDifferentialCircuit{})
	if err != nil {
		t.Fatalf("compile fixed hardened differential: %v", err)
	}
	if err := solveDerivation(ccs, assignment); err != nil {
		t.Fatalf("fixed hardened byte states diverged: %v", err)
	}
	assignment.Expected1815CC[0] = uints.NewU8(levels[1].CC[0] ^ 1)
	if err := solveDerivation(ccs, assignment); err == nil {
		t.Fatal("corrupt non-leaf chain code unexpectedly satisfied the differential")
	}
}

type leafProjectionCircuit struct {
	ParentKL, ParentKR, ParentCC [32]uints.U8
	Index                        frontend.Variable
	ExpectedKL                   [32]uints.U8
}

func (c *leafProjectionCircuit) Define(api frontend.API) error {
	uapi, err := uints.New[uints.U64](api)
	if err != nil {
		return err
	}
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	crv, err := ed.NewCurve(api)
	if err != nil {
		return err
	}
	p := CircExt{KL: c.ParentKL, KR: c.ParentKR, CC: c.ParentCC}
	p.KLbits = BytesToCanonBits(api, p.KL)
	indexLE := le32Var(api, c.Index, false)
	leaf := softStepLeaf(api, uapi, bapi, crv, p, indexLE[:])
	for i := range leaf.KL {
		bapi.AssertIsEqual(leaf.KL[i], c.ExpectedKL[i])
	}
	return nil
}

type fullLeafStepCircuit leafProjectionCircuit

func (c *fullLeafStepCircuit) Define(api frontend.API) error {
	uapi, err := uints.New[uints.U64](api)
	if err != nil {
		return err
	}
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	crv, err := ed.NewCurve(api)
	if err != nil {
		return err
	}
	p := CircExt{KL: c.ParentKL, KR: c.ParentKR, CC: c.ParentCC}
	p.KLbits = BytesToCanonBits(api, p.KL)
	indexLE := le32Var(api, c.Index, false)
	leaf := SoftStep(api, uapi, bapi, crv, p, indexLE[:])
	for i := range leaf.KL {
		bapi.AssertIsEqual(leaf.KL[i], c.ExpectedKL[i])
	}
	return nil
}

func TestFinishStepLeafOmitsUnconsumedState(t *testing.T) {
	master, err := hex.DecodeString(goldenMasterXPrvHex)
	if err != nil {
		t.Fatal(err)
	}
	levels := DeriveLevels(master, 0, 0, 11)
	parent, expected := levels[3], levels[4]
	assignment := &leafProjectionCircuit{}
	setCircuitBytes(assignment.ParentKL[:], parent.KL[:])
	setCircuitBytes(assignment.ParentKR[:], parent.KR[:])
	setCircuitBytes(assignment.ParentCC[:], parent.CC[:])
	setCircuitBytes(assignment.ExpectedKL[:], expected.KL[:])
	assignment.Index = 11

	leafCCS, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &leafProjectionCircuit{})
	if err != nil {
		t.Fatalf("compile leaf projection: %v", err)
	}
	fullCCS, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &fullLeafStepCircuit{})
	if err != nil {
		t.Fatalf("compile full leaf step: %v", err)
	}
	// C0 must not manufacture a duplicate paired HMAC at the C2 leaf: doing so
	// would resurrect the removed CC branch. C1 legitimately reduces the sole
	// retained Z HMAC, so pin both the new exact count and the prior ceiling.
	const (
		acceptedC2PreC1LeafConstraints = 417_544
		acceptedC1LeafConstraints      = 400_273
	)
	if got := leafCCS.GetNbConstraints(); got != acceptedC1LeafConstraints {
		t.Fatalf("C2/C1 leaf constraints = %d, want %d; fused sigmas must optimize only the retained Z HMAC without restoring dead leaf work", got, acceptedC1LeafConstraints)
	} else if got > acceptedC2PreC1LeafConstraints {
		t.Fatalf("C2/C1 leaf constraints = %d, exceed pre-C1 C2 ceiling %d", got, acceptedC2PreC1LeafConstraints)
	}
	if leafCCS.GetNbConstraints() >= fullCCS.GetNbConstraints() {
		t.Fatalf("leaf constraints = %d, full step = %d; CC-HMAC/AddKR were not omitted", leafCCS.GetNbConstraints(), fullCCS.GetNbConstraints())
	}
	if err := solveDerivation(leafCCS, assignment); err != nil {
		t.Fatalf("solve projected leaf: %v", err)
	}

	// Parent KR only feeds the full step's omitted AddKR. Changing it must not
	// affect the projected leaf relation.
	assignment.ParentKR[0] = uints.NewU8(parent.KR[0] ^ 1)
	if err := solveDerivation(leafCCS, assignment); err != nil {
		t.Fatalf("unconsumed parent KR changed projected leaf: %v", err)
	}

	// Parent CC still keys the retained Z HMAC and therefore remains load-bearing.
	assignment.ParentCC[0] = uints.NewU8(parent.CC[0] ^ 1)
	if err := solveDerivation(leafCCS, assignment); err == nil {
		t.Fatal("corrupt retained Z-HMAC key unexpectedly preserved projected leaf")
	}
}

type randomizedLeafDifferentialCircuit struct {
	ParentKL, ParentKR, ParentCC [32]uints.U8
	Index                        frontend.Variable
	ExpectedKL                   [32]uints.U8
}

func (c *randomizedLeafDifferentialCircuit) Define(api frontend.API) error {
	uapi, err := uints.New[uints.U64](api)
	if err != nil {
		return err
	}
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	crv, err := ed.NewCurve(api)
	if err != nil {
		return err
	}
	p := CircExt{KL: c.ParentKL, KR: c.ParentKR, CC: c.ParentCC}
	p.KLbits = BytesToCanonBits(api, p.KL)
	indexLE := le32Var(api, c.Index, false)
	projected := softStepLeaf(api, uapi, bapi, crv, p, indexLE[:])
	full := SoftStep(api, uapi, bapi, crv, p, indexLE[:])
	for i := range projected.KL {
		bapi.AssertIsEqual(projected.KL[i], full.KL[i])
		bapi.AssertIsEqual(projected.KL[i], c.ExpectedKL[i])
	}
	for i := range projected.KLbits {
		api.AssertIsEqual(projected.KLbits[i], full.KLbits[i])
	}
	return nil
}

func TestFinishStepLeafReferenceProjectionMatchesFullStepRandomized(t *testing.T) {
	rng := rand.New(rand.NewSource(0xC2))
	assignments := make([]*randomizedLeafDifferentialCircuit, leafRandomCases)
	for i := range assignments {
		parent := randomizedLeafParent(rng)
		index := rng.Uint32() & 0x7fff_ffff
		full := deriveChild(parent, index, false)
		projected := deriveLeafKLProjectionRef(parent, index)
		if projected != full.KL {
			t.Fatalf("case %d reference leaf mismatch: projected=%x full=%x", i, projected, full.KL)
		}
		assignment := &randomizedLeafDifferentialCircuit{Index: index}
		setCircuitBytes(assignment.ParentKL[:], parent.KL[:])
		setCircuitBytes(assignment.ParentKR[:], parent.KR[:])
		setCircuitBytes(assignment.ParentCC[:], parent.CC[:])
		setCircuitBytes(assignment.ExpectedKL[:], full.KL[:])
		assignments[i] = assignment
	}
	// Compile one optimized/full differential relation, then solve the 1,000
	// deterministic witnesses against it with bounded parallelism. This exercises
	// the real R1CS without compiling a 1,000-copy circuit or allowing an
	// unbounded solve fan-out on smaller review hosts.
	ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, &randomizedLeafDifferentialCircuit{})
	if err != nil {
		t.Fatalf("compile randomized optimized/full leaf differential: %v", err)
	}
	if err := solveRandomizedLeafBatch(ccs, assignments, leafSolveWorkers); err != nil {
		t.Fatalf("solve %d randomized optimized/full/reference leaf cases: %v", leafRandomCases, err)
	}

	// Use another deterministic random witness for a negative through the same
	// compiled optimized/full relation. Keep its expected output fixed while
	// corrupting the CC that keys the retained Z HMAC; the solver must reject it.
	negativeParent := randomizedLeafParent(rng)
	negativeIndex := rng.Uint32() & 0x7fff_ffff
	negativeExpected := deriveChild(negativeParent, negativeIndex, false).KL
	negative := &randomizedLeafDifferentialCircuit{Index: negativeIndex}
	setCircuitBytes(negative.ParentKL[:], negativeParent.KL[:])
	setCircuitBytes(negative.ParentKR[:], negativeParent.KR[:])
	setCircuitBytes(negative.ParentCC[:], negativeParent.CC[:])
	setCircuitBytes(negative.ExpectedKL[:], negativeExpected[:])
	negative.ParentCC[17] = uints.NewU8(negativeParent.CC[17] ^ 1)
	if err := solveDerivation(ccs, negative); err == nil {
		t.Fatal("randomized corrupt retained HMAC key unexpectedly satisfied optimized leaf circuit")
	}
}

func solveRandomizedLeafBatch(ccs constraint.ConstraintSystem, assignments []*randomizedLeafDifferentialCircuit, workers int) error {
	if workers < 1 {
		workers = 1
	}
	if available := runtime.GOMAXPROCS(0); workers > available {
		workers = available
	}
	jobs := make(chan int)
	errs := make(chan error, len(assignments))
	var wg sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				witness, err := frontend.NewWitness(assignments[index], ecc.BLS12_381.ScalarField())
				if err == nil {
					// Outer workers provide the bounded parallelism; prevent gnark from
					// creating a second runtime.NumCPU-sized pool inside every solve.
					err = ccs.IsSolved(witness, csolver.WithNbTasks(1))
				}
				if err != nil {
					errs <- fmt.Errorf("case %d: %w", index, err)
				}
			}
		}()
	}
	for index := range assignments {
		jobs <- index
	}
	close(jobs)
	wg.Wait()
	close(errs)
	for err := range errs {
		return err
	}
	return nil
}

func randomizedLeafParent(rng *rand.Rand) Ext {
	var parent Ext
	for j := 0; j < 32; j++ {
		parent.KL[j] = byte(rng.Uint32())
		parent.KR[j] = byte(rng.Uint32())
		parent.CC[j] = byte(rng.Uint32())
	}
	// Match the real extended-scalar domain and leave the same ample headroom
	// as Cardano's clamped/derived states.
	parent.KL[0] &= 0xf8
	parent.KL[31] = (parent.KL[31] & 0x1f) | 0x40
	return parent
}

func deriveLeafKLProjectionRef(parent Ext, index uint32) [32]byte {
	a := leafPubkey(parent.KL)
	msg := make([]byte, 0, 37)
	msg = append(msg, 0x02)
	msg = append(msg, a...)
	msg = append(msg, le32(index)...)
	z := sha.RefHMACSHA512(parent.CC[:], msg)
	zL := leToInt(z[:28])
	zL.Lsh(zL, 3)
	return intToLE32(zL.Add(zL, leToInt(parent.KL[:])))
}

func derivationAssignment(master []byte, account, role, index uint32) *derivationMatrixCircuit {
	leaf := DeriveRef(master, account, role, index)
	assignment := &derivationMatrixCircuit{Account: account, Role: role, Index: index}
	setCircuitBytes(assignment.MasterKL[:], master[:32])
	setCircuitBytes(assignment.MasterKR[:], master[32:64])
	setCircuitBytes(assignment.MasterCC[:], master[64:96])
	setCircuitBytes(assignment.ExpectedKL[:], leaf.KL[:])
	setCircuitBytes(assignment.ExpectedKR[:], leaf.KR[:])
	setCircuitBytes(assignment.ExpectedCC[:], leaf.CC[:])
	return assignment
}

func solveDerivation(ccs constraint.ConstraintSystem, assignment frontend.Circuit) error {
	witness, err := frontend.NewWitness(assignment, ecc.BLS12_381.ScalarField())
	if err != nil {
		return fmt.Errorf("new witness: %w", err)
	}
	return ccs.IsSolved(witness)
}

func setCircuitBytes(dst []uints.U8, src []byte) {
	for i := range src {
		dst[i] = uints.NewU8(src[i])
	}
}
