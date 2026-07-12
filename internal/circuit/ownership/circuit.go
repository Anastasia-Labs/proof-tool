package ownership

import (
	"crypto/sha512"
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/uints"
	"github.com/tyler-smith/go-bip39"
	"golang.org/x/crypto/blake2b"
	"golang.org/x/crypto/pbkdf2"

	"proof-tool/internal/circuit/ckd"
	"proof-tool/internal/circuit/ed25519/ed"
	"proof-tool/internal/circuit/hash"
)

const (
	CircuitID = "root-ownership-v1/bls12-381/groth16"
	Domain    = "ROOT-OWNERSHIP-v1"
)

type Path struct {
	Account uint32 `json:"account"`
	Role    uint32 `json:"role"`
	Index   uint32 `json:"index"`
}

type SearchOptions struct {
	Account    int
	Role       int
	Index      int
	MaxAccount uint32
	MaxIndex   uint32
}

type Circuit struct {
	MasterKL, MasterKR, MasterCC [32]uints.U8
	Account, Role, Index         frontend.Variable
	Pub                          frontend.Variable `gnark:",public"`
}

func (c *Circuit) Define(api frontend.API) error {
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

	leaf := ckd.DeriveChain(api, uapi, bapi, crv,
		c.MasterKL, c.MasterKR, c.MasterCC, c.Account, c.Role, c.Index)
	_, credential := Credential(api, uapi, bapi, crv, leaf.KLbits)
	BindCredential(api, uapi, credential, c.Pub)
	return nil
}

func Credential(api frontend.API, uapi *uints.BinaryField[uints.U64], bapi *uints.Bytes, crv *ed.Curve, kLbits [256]frontend.Variable) (A [32]uints.U8, C [28]uints.U8) {
	enc := crv.Compress(crv.ScalarMulBaseBits(kLbits[:]))
	for i := 0; i < 32; i++ {
		A[i] = bapi.ValueOf(enc[i])
	}
	c := hash.Blake2b(api, uapi, A[:], 28)
	copy(C[:], c)
	return
}

func BindCredential(api frontend.API, uapi *uints.BinaryField[uints.U64], credential [28]uints.U8, pub frontend.Variable) {
	domain := uints.NewU8Array([]byte(Domain))
	preimage := make([]uints.U8, 0, len(domain)+len(credential))
	preimage = append(preimage, domain...)
	preimage = append(preimage, credential[:]...)
	digest := hash.Blake2b(api, uapi, preimage, 32)
	api.AssertIsEqual(bytesToFieldLE(api, digest), pub)
}

func bytesToFieldLE(api frontend.API, digest []uints.U8) frontend.Variable {
	acc := frontend.Variable(0)
	for i := len(digest) - 1; i >= 0; i-- {
		acc = api.Add(api.Mul(acc, 256), digest[i].Val)
	}
	return acc
}

func Assignment(masterXPrv []byte, path Path, publicInput *big.Int) (*Circuit, error) {
	if len(masterXPrv) != 96 {
		return nil, fmt.Errorf("master xprv is %d bytes, want 96", len(masterXPrv))
	}
	if err := validatePath(path); err != nil {
		return nil, err
	}
	var c Circuit
	fillU8(c.MasterKL[:], masterXPrv[0:32])
	fillU8(c.MasterKR[:], masterXPrv[32:64])
	fillU8(c.MasterCC[:], masterXPrv[64:96])
	c.Account = path.Account
	c.Role = path.Role
	c.Index = path.Index
	c.Pub = publicInput
	return &c, nil
}

func MasterXPrvFromSeedPhrase(seedPhrase string) ([]byte, error) {
	phrase := strings.Join(strings.Fields(seedPhrase), " ")
	entropy, err := bip39.EntropyFromMnemonic(phrase)
	if err != nil {
		return nil, fmt.Errorf("bip39 entropy: %w", err)
	}
	raw := pbkdf2.Key([]byte{}, entropy, 4096, 96, sha512.New)
	raw[0] &= 0b1111_1000
	raw[31] &= 0b0001_1111
	raw[31] |= 0b0100_0000
	return raw, nil
}

func PublicInputForCredential(credential []byte) (*big.Int, error) {
	digest, err := PublicInputDigestForCredential(credential)
	if err != nil {
		return nil, err
	}
	n := new(big.Int).SetBytes(reverse(digest))
	return n.Mod(n, ecc.BLS12_381.ScalarField()), nil
}

func PublicInputDigestForCredential(credential []byte) ([]byte, error) {
	if len(credential) != 28 {
		return nil, fmt.Errorf("credential is %d bytes, want 28", len(credential))
	}
	preimage := append([]byte(Domain), credential...)
	digest := blake2b.Sum256(preimage)
	return digest[:], nil
}

func PublicInputHex(n *big.Int) string {
	return "0x" + n.Text(16)
}

func ParsePublicInputHex(s string) (*big.Int, error) {
	raw := strings.TrimPrefix(strings.TrimSpace(s), "0x")
	if raw == "" {
		return nil, fmt.Errorf("empty public input")
	}
	n, ok := new(big.Int).SetString(raw, 16)
	if !ok {
		return nil, fmt.Errorf("invalid public input %q", s)
	}
	if n.Sign() < 0 || n.Cmp(ecc.BLS12_381.ScalarField()) >= 0 {
		return nil, fmt.Errorf("public input is outside BLS12-381 scalar field")
	}
	return n, nil
}

func DecodeMasterXPrvHex(s string) ([]byte, error) {
	b, err := hex.DecodeString(strings.TrimPrefix(strings.TrimSpace(s), "0x"))
	if err != nil {
		return nil, fmt.Errorf("master xprv hex: %w", err)
	}
	if len(b) != 96 {
		return nil, fmt.Errorf("master xprv is %d bytes, want 96", len(b))
	}
	return b, nil
}

func DecodeCredentialHex(s string) ([]byte, error) {
	b, err := hex.DecodeString(strings.TrimPrefix(strings.TrimSpace(s), "0x"))
	if err != nil {
		return nil, fmt.Errorf("target credential hex: %w", err)
	}
	if len(b) != 28 {
		return nil, fmt.Errorf("target credential is %d bytes, want 28", len(b))
	}
	return b, nil
}

func DeriveCredential(masterXPrv []byte, path Path) ([28]byte, error) {
	if len(masterXPrv) != 96 {
		return [28]byte{}, fmt.Errorf("master xprv is %d bytes, want 96", len(masterXPrv))
	}
	if err := validatePath(path); err != nil {
		return [28]byte{}, err
	}
	leaf := ckd.DeriveRef(masterXPrv, path.Account, path.Role, path.Index)
	return RefCredential(leaf.KL), nil
}

func FindPath(masterXPrv, targetCredential []byte, opts SearchOptions) (Path, error) {
	if len(targetCredential) != 28 {
		return Path{}, fmt.Errorf("target credential is %d bytes, want 28", len(targetCredential))
	}
	accounts, err := scanValues(opts.Account, 0, opts.MaxAccount, "account", 1<<31-1)
	if err != nil {
		return Path{}, err
	}
	roles, err := scanValues(opts.Role, 0, 2, "role", 2)
	if err != nil {
		return Path{}, err
	}
	indexes, err := scanValues(opts.Index, 0, opts.MaxIndex, "index", 1<<31-1)
	if err != nil {
		return Path{}, err
	}

	for _, account := range accounts {
		for _, role := range roles {
			for _, index := range indexes {
				path := Path{Account: account, Role: role, Index: index}
				credential, err := DeriveCredential(masterXPrv, path)
				if err != nil {
					return Path{}, err
				}
				if string(credential[:]) == string(targetCredential) {
					return path, nil
				}
			}
		}
	}
	return Path{}, fmt.Errorf("target credential not found in searched CIP-1852 path range")
}

func RefCredential(leafKL [32]byte) [28]byte {
	s := new(big.Int).SetBytes(reverse(leafKL[:]))
	A := ed.RefCompress(ed.RefScalarMulBase(s))
	h, err := blake2b.New(28, nil)
	if err != nil {
		panic(err)
	}
	_, _ = h.Write(A[:])
	var C [28]byte
	copy(C[:], h.Sum(nil))
	return C
}

func fillU8(dst []uints.U8, src []byte) {
	if len(dst) != len(src) {
		panic(fmt.Sprintf("fillU8: dst %d != src %d", len(dst), len(src)))
	}
	for i := range src {
		dst[i] = uints.NewU8(src[i])
	}
}

func validatePath(path Path) error {
	if path.Account >= 1<<31 {
		return fmt.Errorf("account must be < 2^31")
	}
	if path.Role > 2 {
		return fmt.Errorf("role must be 0, 1, or 2")
	}
	if path.Index >= 1<<31 {
		return fmt.Errorf("index must be < 2^31")
	}
	return nil
}

func scanValues(explicit int, min, scanMax uint32, name string, explicitMax uint32) ([]uint32, error) {
	if explicit >= 0 {
		v := uint32(explicit)
		if explicit > int(explicitMax) || v < min {
			return nil, fmt.Errorf("%s %d outside allowed range %d..%d", name, explicit, min, explicitMax)
		}
		return []uint32{v}, nil
	}
	values := make([]uint32, 0, scanMax-min+1)
	for v := min; v <= scanMax; v++ {
		values = append(values, v)
	}
	return values, nil
}

func reverse(b []byte) []byte {
	out := make([]byte, len(b))
	for i := range b {
		out[len(b)-1-i] = b[i]
	}
	return out
}
