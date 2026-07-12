package ownershipdest

import (
	"encoding/hex"
	"fmt"
	"math/big"
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
	CircuitID                  = "root-ownership-destination-v1/bls12-381/groth16"
	Domain                     = "ROOT-OWNERSHIP-DESTINATION-v1"
	CredentialLen              = 28
	DestinationAddressV1Len    = 58
	PublicInputEncoding        = "single-credential-destination-v1"
	DestinationAddressEncoding = "destination-address-v1"
)

type Circuit struct {
	MasterKL, MasterKR, MasterCC [32]uints.U8
	Account, Role, Index         frontend.Variable
	Destination                  [DestinationAddressV1Len]uints.U8
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
	_, credential := ownership.Credential(api, uapi, bapi, crv, leaf.KLbits)
	bindCredentialDestination(api, uapi, credential, c.Destination, c.Pub)
	return nil
}

func bindCredentialDestination(
	api frontend.API,
	uapi *uints.BinaryField[uints.U64],
	credential [CredentialLen]uints.U8,
	destination [DestinationAddressV1Len]uints.U8,
	pub frontend.Variable,
) {
	domain := uints.NewU8Array([]byte(Domain))
	preimage := make([]uints.U8, 0, len(domain)+CredentialLen+DestinationAddressV1Len)
	preimage = append(preimage, domain...)
	preimage = append(preimage, credential[:]...)
	preimage = append(preimage, destination[:]...)
	digest := hash.Blake2b(api, uapi, preimage, 32)
	api.AssertIsEqual(bytesToFieldLE(api, digest), pub)
}

func Assignment(masterXPrv []byte, path ownership.Path, destination []byte, publicInput *big.Int) (*Circuit, error) {
	if len(masterXPrv) != 96 {
		return nil, fmt.Errorf("master xprv is %d bytes, want 96", len(masterXPrv))
	}
	if len(destination) != DestinationAddressV1Len {
		return nil, fmt.Errorf("destination address v1 is %d bytes, want %d", len(destination), DestinationAddressV1Len)
	}
	if publicInput == nil {
		return nil, fmt.Errorf("public input is required")
	}
	if _, err := ownership.DeriveCredential(masterXPrv, path); err != nil {
		return nil, err
	}

	var c Circuit
	fillU8(c.MasterKL[:], masterXPrv[0:32])
	fillU8(c.MasterKR[:], masterXPrv[32:64])
	fillU8(c.MasterCC[:], masterXPrv[64:96])
	c.Account = path.Account
	c.Role = path.Role
	c.Index = path.Index
	fillU8(c.Destination[:], destination)
	c.Pub = publicInput
	return &c, nil
}

func PublicInputForCredentialDestination(credential []byte, destination []byte) (*big.Int, error) {
	digest, err := PublicInputDigestForCredentialDestination(credential, destination)
	if err != nil {
		return nil, err
	}
	n := new(big.Int).SetBytes(reverse(digest))
	return n.Mod(n, ecc.BLS12_381.ScalarField()), nil
}

func PublicInputDigestForCredentialDestination(credential []byte, destination []byte) ([]byte, error) {
	if len(credential) != CredentialLen {
		return nil, fmt.Errorf("credential is %d bytes, want %d", len(credential), CredentialLen)
	}
	if len(destination) != DestinationAddressV1Len {
		return nil, fmt.Errorf("destination address v1 is %d bytes, want %d", len(destination), DestinationAddressV1Len)
	}
	preimage := make([]byte, 0, len(Domain)+CredentialLen+DestinationAddressV1Len)
	preimage = append(preimage, []byte(Domain)...)
	preimage = append(preimage, credential...)
	preimage = append(preimage, destination...)
	digest := blake2b.Sum256(preimage)
	return digest[:], nil
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

func reverse(in []byte) []byte {
	out := make([]byte, len(in))
	for i := range in {
		out[len(in)-1-i] = in[i]
	}
	return out
}
