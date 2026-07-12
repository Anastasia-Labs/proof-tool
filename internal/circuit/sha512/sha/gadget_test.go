package sha

import (
	"encoding/hex"
	"math/rand"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/std/math/uints"
)

const chMajRandomCases = 1_000

type chMajDifferentialCircuit struct {
	E, F, G     [chMajRandomCases]uints.U64
	A, B, C     [chMajRandomCases]uints.U64
	ExpectedCh  [chMajRandomCases]uints.U64
	ExpectedMaj [chMajRandomCases]uints.U64
}

func (c *chMajDifferentialCircuit) Define(api frontend.API) error {
	uapi, err := uints.New[uints.U64](api)
	if err != nil {
		return err
	}
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	for i := 0; i < chMajRandomCases; i++ {
		gotCh := choose(uapi, c.E[i], c.F[i], c.G[i])
		oldCh := uapi.Xor(uapi.And(c.E[i], c.F[i]), uapi.And(uapi.Not(c.E[i]), c.G[i]))
		gotMaj := majority(uapi, c.A[i], c.B[i], c.C[i])
		oldMaj := uapi.Xor(uapi.And(c.A[i], c.B[i]), uapi.And(c.A[i], c.C[i]), uapi.And(c.B[i], c.C[i]))
		assertU64Equal(bapi, gotCh, oldCh)
		assertU64Equal(bapi, gotCh, c.ExpectedCh[i])
		assertU64Equal(bapi, gotMaj, oldMaj)
		assertU64Equal(bapi, gotMaj, c.ExpectedMaj[i])
	}
	return nil
}

func TestChMajIdentitiesDifferential(t *testing.T) {
	assignment := randomizedChMajAssignment()
	ccs := compileCircuit(t, &chMajDifferentialCircuit{})
	if err := solveCircuit(ccs, assignment); err != nil {
		t.Fatalf("solve 1,000 randomized Ch/Maj identity cases: %v", err)
	}

	// The first case is chosen so this input-bit corruption necessarily changes
	// Ch. Keeping the original expected output must make the solver reject it.
	assignment.E[0] = uints.NewU64(1)
	if err := solveCircuit(ccs, assignment); err == nil {
		t.Fatal("corrupt Ch input bit unexpectedly satisfied the differential circuit")
	}

	// Keep Ch valid and corrupt a Maj input in a case selected so the changed bit
	// necessarily changes Maj. This independently covers the optimized Maj path.
	assignment = randomizedChMajAssignment()
	assignment.A[0] = uints.NewU64(1)
	if err := solveCircuit(ccs, assignment); err == nil {
		t.Fatal("corrupt Maj input bit unexpectedly satisfied the differential circuit")
	}
}

type sha512VectorCircuit struct {
	ABC         [3]uints.U8
	Multi       [112]uints.U8
	EmptyDigest [64]uints.U8
	ABCDigest   [64]uints.U8
	MultiDigest [64]uints.U8
}

func (c *sha512VectorCircuit) Define(api frontend.API) error {
	uapi, err := uints.New[uints.U64](api)
	if err != nil {
		return err
	}
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	emptyDigest := Sum512(api, uapi, nil)
	abcDigest := Sum512(api, uapi, c.ABC[:])
	multiDigest := Sum512(api, uapi, c.Multi[:])
	assertBytesEqual(bapi, emptyDigest[:], c.EmptyDigest[:])
	assertBytesEqual(bapi, abcDigest[:], c.ABCDigest[:])
	assertBytesEqual(bapi, multiDigest[:], c.MultiDigest[:])
	return nil
}

func TestSHA512ExistingVectors(t *testing.T) {
	abc := []byte("abc")
	multi := []byte("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu")
	vectors := []struct {
		name   string
		msg    []byte
		digest string
	}{
		{"empty", nil, "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"},
		{"abc", abc, "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"},
		{"FIPS multi-block", multi, "8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909"},
	}
	var assignment sha512VectorCircuit
	setU8s(assignment.ABC[:], abc)
	setU8s(assignment.Multi[:], multi)
	for i, vector := range vectors {
		want := mustDecodeHex(t, vector.digest)
		if got := RefSHA512(vector.msg); hex.EncodeToString(got) != vector.digest {
			t.Fatalf("%s Go reference = %x, want %s", vector.name, got, vector.digest)
		}
		switch i {
		case 0:
			setU8s(assignment.EmptyDigest[:], want)
		case 1:
			setU8s(assignment.ABCDigest[:], want)
		case 2:
			setU8s(assignment.MultiDigest[:], want)
		}
	}

	ccs := compileCircuit(t, &sha512VectorCircuit{})
	if err := solveCircuit(ccs, &assignment); err != nil {
		t.Fatalf("solve existing SHA-512 vectors: %v", err)
	}

	assignment.ABC[0] = uints.NewU8(abc[0] ^ 1)
	if err := solveCircuit(ccs, &assignment); err == nil {
		t.Fatal("corrupt SHA-512 input bit unexpectedly matched the published digest")
	}
}

type hmacVectorCircuit struct {
	RFCKey     [20]uints.U8
	RFCMessage [8]uints.U8
	RFCDigest  [64]uints.U8
	CKDKey     [32]uints.U8
	CKDMessage [69]uints.U8
	CKDDigest  [64]uints.U8
}

func (c *hmacVectorCircuit) Define(api frontend.API) error {
	uapi, err := uints.New[uints.U64](api)
	if err != nil {
		return err
	}
	bapi, err := uints.NewBytes(api)
	if err != nil {
		return err
	}
	rfc := HMACSHA512(api, uapi, bapi, c.RFCKey[:], c.RFCMessage[:])
	ckd := HMACSHA512(api, uapi, bapi, c.CKDKey[:], c.CKDMessage[:])
	rfcPair1, rfcPair2 := HMACSHA512Pair(api, uapi, bapi, c.RFCKey[:], c.RFCMessage[:], c.RFCMessage[:])
	ckdPair1, ckdPair2 := HMACSHA512Pair(api, uapi, bapi, c.CKDKey[:], c.CKDMessage[:], c.CKDMessage[:])
	assertBytesEqual(bapi, rfc[:], c.RFCDigest[:])
	assertBytesEqual(bapi, ckd[:], c.CKDDigest[:])
	assertBytesEqual(bapi, rfcPair1[:], rfc[:])
	assertBytesEqual(bapi, rfcPair2[:], rfc[:])
	assertBytesEqual(bapi, ckdPair1[:], ckd[:])
	assertBytesEqual(bapi, ckdPair2[:], ckd[:])
	return nil
}

func TestHMACSHA512RFC4231AndCKDReferenceVectors(t *testing.T) {
	// RFC 4231 test case 1 is a published, implementation-independent HMAC
	// vector. The CKD vector uses the repo's existing golden master and exact
	// hardened 1852' preimage shape, with the Go standard-library reference as
	// the expected-output oracle.
	rfcKey := make([]byte, 20)
	for i := range rfcKey {
		rfcKey[i] = 0x0b
	}
	rfcMessage := []byte("Hi There")
	rfcDigest := mustDecodeHex(t, "87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cde"+
		"daa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854")
	if got := RefHMACSHA512(rfcKey, rfcMessage); hex.EncodeToString(got) != hex.EncodeToString(rfcDigest) {
		t.Fatalf("RFC 4231 reference mismatch: got %x want %x", got, rfcDigest)
	}

	master := mustDecodeHex(t, "c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245"+
		"d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a"+
		"23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620")
	ckdKey := master[64:96]
	ckdMessage := make([]byte, 0, 69)
	ckdMessage = append(ckdMessage, 0x00)
	ckdMessage = append(ckdMessage, master[:64]...)
	ckdMessage = append(ckdMessage, 0x3c, 0x07, 0x00, 0x80) // le32(1852')
	ckdDigest := RefHMACSHA512(ckdKey, ckdMessage)

	assignment := &hmacVectorCircuit{}
	setU8s(assignment.RFCKey[:], rfcKey)
	setU8s(assignment.RFCMessage[:], rfcMessage)
	setU8s(assignment.RFCDigest[:], rfcDigest)
	setU8s(assignment.CKDKey[:], ckdKey)
	setU8s(assignment.CKDMessage[:], ckdMessage)
	setU8s(assignment.CKDDigest[:], ckdDigest)
	ccs := compileCircuit(t, &hmacVectorCircuit{})
	if err := solveCircuit(ccs, assignment); err != nil {
		t.Fatalf("solve RFC 4231 and CKD HMAC vectors: %v", err)
	}

	assignment.CKDMessage[1] = uints.NewU8(master[0] ^ 1)
	if err := solveCircuit(ccs, assignment); err == nil {
		t.Fatal("corrupt CKD HMAC input byte unexpectedly matched the reference digest")
	}
}

func randomizedChMajAssignment() *chMajDifferentialCircuit {
	rng := rand.New(rand.NewSource(0xC4))
	assignment := &chMajDifferentialCircuit{}
	for i := 0; i < chMajRandomCases; i++ {
		e, f, g := rng.Uint64(), rng.Uint64(), rng.Uint64()
		a, b, c := rng.Uint64(), rng.Uint64(), rng.Uint64()
		if i == 0 {
			e, f, g = 0, 1, 0
			a, b, c = 0, 1, 0
		}
		assignment.E[i], assignment.F[i], assignment.G[i] = uints.NewU64(e), uints.NewU64(f), uints.NewU64(g)
		assignment.A[i], assignment.B[i], assignment.C[i] = uints.NewU64(a), uints.NewU64(b), uints.NewU64(c)
		assignment.ExpectedCh[i] = uints.NewU64((e & f) ^ (^e & g))
		assignment.ExpectedMaj[i] = uints.NewU64((a & b) ^ (a & c) ^ (b & c))
	}
	return assignment
}

func assertU64Equal(bapi *uints.Bytes, got, want uints.U64) {
	for i := range got {
		bapi.AssertIsEqual(got[i], want[i])
	}
}

func assertBytesEqual(bapi *uints.Bytes, got, want []uints.U8) {
	for i := range got {
		bapi.AssertIsEqual(got[i], want[i])
	}
}

func compileCircuit(t *testing.T, circuit frontend.Circuit) constraint.ConstraintSystem {
	t.Helper()
	ccs, err := frontend.Compile(ecc.BLS12_381.ScalarField(), r1cs.NewBuilder, circuit)
	if err != nil {
		t.Fatalf("compile circuit: %v", err)
	}
	return ccs
}

func solveCircuit(ccs constraint.ConstraintSystem, assignment frontend.Circuit) error {
	w, err := frontend.NewWitness(assignment, ecc.BLS12_381.ScalarField())
	if err != nil {
		return err
	}
	return ccs.IsSolved(w)
}

func setU8s(dst []uints.U8, src []byte) {
	for i := range src {
		dst[i] = uints.NewU8(src[i])
	}
}

func mustDecodeHex(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := hex.DecodeString(value)
	if err != nil {
		t.Fatalf("decode test vector: %v", err)
	}
	return decoded
}
