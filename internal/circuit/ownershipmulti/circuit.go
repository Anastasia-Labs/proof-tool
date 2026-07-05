package ownershipmulti

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"strconv"
	"strings"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/uints"
	"golang.org/x/crypto/blake2b"

	"proof-tool/internal/circuit/ckd"
	"proof-tool/internal/circuit/ed25519/ed"
	"proof-tool/internal/circuit/hash"
	"proof-tool/internal/circuit/ownership"
)

const (
	CircuitID                  = "root-ownership-multi-destination-v1-count2/bls12-381/groth16"
	Domain                     = "ROOT-OWNERSHIP-MULTI-v1"
	DefaultCredentialCount     = 2
	CredentialCount            = DefaultCredentialCount
	CredentialLen              = 28
	DestinationAddressV1Len    = 58
	PublicInputEncoding        = "multi-credential-fixed-v1"
	DestinationAddressEncoding = "destination-address-v1"
	MaxCredentialCount         = 65535
)

type PathWitness struct {
	Account frontend.Variable
	Role    frontend.Variable
	Index   frontend.Variable
}

type Circuit struct {
	MasterKL, MasterKR, MasterCC [32]uints.U8
	Paths                        []PathWitness
	Destination                  [DestinationAddressV1Len]uints.U8
	Pub                          frontend.Variable `gnark:",public"`
}

func NewCircuit(count int) (*Circuit, error) {
	if err := ValidateCredentialCount(count); err != nil {
		return nil, err
	}
	return &Circuit{Paths: make([]PathWitness, count)}, nil
}

func PublicAssignment(count int, publicInput *big.Int) (*Circuit, error) {
	circuit, err := NewCircuit(count)
	if err != nil {
		return nil, err
	}
	circuit.Pub = publicInput
	return circuit, nil
}

func (c *Circuit) Define(api frontend.API) error {
	if err := ValidateCredentialCount(len(c.Paths)); err != nil {
		return err
	}
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

	credentials := make([][CredentialLen]uints.U8, len(c.Paths))
	for i, path := range c.Paths {
		credentials[i] = deriveCredential(api, uapi, bapi, crv, c.MasterKL, c.MasterKR, c.MasterCC, path.Account, path.Role, path.Index)
	}
	bindCredentialsDestination(api, uapi, credentials, c.Destination, c.Pub)
	return nil
}

func deriveCredential(
	api frontend.API,
	uapi *uints.BinaryField[uints.U64],
	bapi *uints.Bytes,
	crv *ed.Curve,
	masterKL, masterKR, masterCC [32]uints.U8,
	account, role, index frontend.Variable,
) [CredentialLen]uints.U8 {
	leaf := ckd.DeriveChain(api, uapi, bapi, crv, masterKL, masterKR, masterCC, account, role, index)
	_, credential := ownership.Credential(api, uapi, bapi, crv, leaf.KLbits)
	return credential
}

func bindCredentialsDestination(
	api frontend.API,
	uapi *uints.BinaryField[uints.U64],
	credentials [][CredentialLen]uints.U8,
	destination [DestinationAddressV1Len]uints.U8,
	pub frontend.Variable,
) {
	domain := uints.NewU8Array([]byte(Domain))
	count := uints.NewU8Array(credentialCountU16BE(len(credentials)))
	preimage := make([]uints.U8, 0, len(domain)+len(count)+len(credentials)*CredentialLen+DestinationAddressV1Len)
	preimage = append(preimage, domain...)
	preimage = append(preimage, count...)
	for _, credential := range credentials {
		preimage = append(preimage, credential[:]...)
	}
	preimage = append(preimage, destination[:]...)
	digest := hash.Blake2b(uapi, preimage, 32)
	api.AssertIsEqual(bytesToFieldLE(api, digest), pub)
}

func Assignment(masterXPrv []byte, paths []ownership.Path, destination []byte, publicInput *big.Int) (*Circuit, error) {
	if len(masterXPrv) != 96 {
		return nil, fmt.Errorf("master xprv is %d bytes, want 96", len(masterXPrv))
	}
	if err := ValidateCredentialCount(len(paths)); err != nil {
		return nil, err
	}
	if len(destination) != DestinationAddressV1Len {
		return nil, fmt.Errorf("destination address v1 is %d bytes, want %d", len(destination), DestinationAddressV1Len)
	}
	if publicInput == nil {
		return nil, fmt.Errorf("public input is required")
	}
	for i, path := range paths {
		if _, err := ownership.DeriveCredential(masterXPrv, path); err != nil {
			return nil, fmt.Errorf("path %d: %w", i, err)
		}
	}

	c, err := NewCircuit(len(paths))
	if err != nil {
		return nil, err
	}
	fillU8(c.MasterKL[:], masterXPrv[0:32])
	fillU8(c.MasterKR[:], masterXPrv[32:64])
	fillU8(c.MasterCC[:], masterXPrv[64:96])
	for i, path := range paths {
		c.Paths[i] = PathWitness{Account: path.Account, Role: path.Role, Index: path.Index}
	}
	fillU8(c.Destination[:], destination)
	c.Pub = publicInput
	return c, nil
}

func DeriveCredentials(masterXPrv []byte, paths []ownership.Path) ([][]byte, error) {
	if err := ValidateCredentialCount(len(paths)); err != nil {
		return nil, err
	}
	credentials := make([][]byte, len(paths))
	for i, path := range paths {
		credential, err := ownership.DeriveCredential(masterXPrv, path)
		if err != nil {
			return nil, fmt.Errorf("path %d: %w", i, err)
		}
		credentials[i] = credential[:]
	}
	return credentials, nil
}

func PublicInputForCredentialsDestination(credentials [][]byte, destination []byte) (*big.Int, error) {
	digest, err := PublicInputDigestForCredentialsDestination(credentials, destination)
	if err != nil {
		return nil, err
	}
	n := new(big.Int).SetBytes(reverse(digest))
	return n.Mod(n, ecc.BLS12_381.ScalarField()), nil
}

func PublicInputDigestForCredentialsDestination(credentials [][]byte, destination []byte) ([]byte, error) {
	if err := ValidateCredentialCount(len(credentials)); err != nil {
		return nil, err
	}
	if len(destination) != DestinationAddressV1Len {
		return nil, fmt.Errorf("destination address v1 is %d bytes, want %d", len(destination), DestinationAddressV1Len)
	}
	preimage := make([]byte, 0, len(Domain)+2+len(credentials)*CredentialLen+DestinationAddressV1Len)
	preimage = append(preimage, []byte(Domain)...)
	preimage = append(preimage, credentialCountU16BE(len(credentials))...)
	for i, credential := range credentials {
		if len(credential) != CredentialLen {
			return nil, fmt.Errorf("credential %d is %d bytes, want %d", i, len(credential), CredentialLen)
		}
		preimage = append(preimage, credential...)
	}
	preimage = append(preimage, destination...)
	digest := blake2b.Sum256(preimage)
	return digest[:], nil
}

func ValidateCredentialCount(count int) error {
	if count < 1 || count > MaxCredentialCount {
		return fmt.Errorf("credential count is %d, want 1..%d", count, MaxCredentialCount)
	}
	return nil
}

func CircuitIDForCount(count int) string {
	return fmt.Sprintf("root-ownership-multi-destination-v1-count%d/bls12-381/groth16", count)
}

func KeyVersionForCount(count int) string {
	return fmt.Sprintf("ownership-multi-destination-v1-count%d", count)
}

func CircuitCountFromID(circuitID string) (int, bool) {
	const prefix = "root-ownership-multi-destination-v1-count"
	const suffix = "/bls12-381/groth16"
	if !strings.HasPrefix(circuitID, prefix) || !strings.HasSuffix(circuitID, suffix) {
		return 0, false
	}
	rawCount := strings.TrimSuffix(strings.TrimPrefix(circuitID, prefix), suffix)
	count, err := strconv.Atoi(rawCount)
	if err != nil || ValidateCredentialCount(count) != nil {
		return 0, false
	}
	return count, true
}

func IsCircuitID(circuitID string) bool {
	_, ok := CircuitCountFromID(circuitID)
	return ok
}

func PublicInputHex(n *big.Int) string {
	return ownership.PublicInputHex(n)
}

func DecodeCredentialHex(s string) ([]byte, error) {
	return ownership.DecodeCredentialHex(s)
}

func DecodeDestinationAddressV1Hex(s string) ([]byte, error) {
	b, err := hex.DecodeString(strings.TrimPrefix(strings.TrimSpace(s), "0x"))
	if err != nil {
		return nil, fmt.Errorf("destination address v1 hex: %w", err)
	}
	if len(b) != DestinationAddressV1Len {
		return nil, fmt.Errorf("destination address v1 is %d bytes, want %d", len(b), DestinationAddressV1Len)
	}
	return b, nil
}

func bytesToFieldLE(api frontend.API, digest []uints.U8) frontend.Variable {
	acc := frontend.Variable(0)
	for i := len(digest) - 1; i >= 0; i-- {
		acc = api.Add(api.Mul(acc, 256), digest[i].Val)
	}
	return acc
}

func fillU8(dst []uints.U8, src []byte) {
	if len(dst) != len(src) {
		panic(fmt.Sprintf("fillU8: dst %d != src %d", len(dst), len(src)))
	}
	for i := range src {
		dst[i] = uints.NewU8(src[i])
	}
}

func credentialCountU16BE(count int) []byte {
	if err := ValidateCredentialCount(count); err != nil {
		panic(err)
	}
	return []byte{byte(count >> 8), byte(count)}
}

func reverse(in []byte) []byte {
	out := make([]byte, len(in))
	for i := range in {
		out[len(in)-1-i] = in[i]
	}
	return out
}
