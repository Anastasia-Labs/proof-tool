package ckd

import (
	"crypto/hmac"
	"crypto/sha512"
	"fmt"

	"filippo.io/edwards25519"
)

// XPub is the public half of a Cardano BIP32-Ed25519 extended key. It is
// sufficient for deriving the soft role/index subtree below a hardened
// CIP-1852 account without retaining or copying account private material.
type XPub struct {
	PublicKey [32]byte
	ChainCode [32]byte
}

// RootExt decodes the raw 96-byte master XPrv representation used throughout
// proof-tool into the private extended-key state used by the CKD reference.
func RootExt(master96 []byte) (Ext, error) {
	if len(master96) != 96 {
		return Ext{}, fmt.Errorf("master xprv is %d bytes, want 96", len(master96))
	}
	var root Ext
	copy(root.KL[:], master96[0:32])
	copy(root.KR[:], master96[32:64])
	copy(root.CC[:], master96[64:96])
	return root, nil
}

// DerivePrivateChild exposes one canonical CKDpriv hop so callers can cache
// shared hardened prefixes instead of restarting from the master for every
// candidate path.
func DerivePrivateChild(parent Ext, index uint32, hardened bool) Ext {
	return deriveChild(parent, index, hardened)
}

// XPubFromPrivate computes the public extended key corresponding to a private
// extended key. The optimized curve implementation is differentially tested
// against the circuit-oriented reference implementation.
func XPubFromPrivate(private Ext) (XPub, error) {
	scalar, err := scalarFromLittleEndian(private.KL[:])
	if err != nil {
		return XPub{}, fmt.Errorf("decode private scalar: %w", err)
	}
	encoded := new(edwards25519.Point).ScalarBaseMult(scalar).Bytes()
	var public XPub
	copy(public.PublicKey[:], encoded)
	public.ChainCode = private.CC
	return public, nil
}

// DerivePublicChild derives one soft BIP32-Ed25519 child. Hardened account
// nodes are intentionally derived with CKDpriv before entering this API.
func DerivePublicChild(parent XPub, index uint32) (XPub, error) {
	if index >= 1<<31 {
		return XPub{}, fmt.Errorf("public child index must be < 2^31")
	}
	indexBytes := le32(index)
	z := hmacSHA512(parent.ChainCode[:], 0x02, parent.PublicKey[:], indexBytes)
	cc := hmacSHA512(parent.ChainCode[:], 0x03, parent.PublicKey[:], indexBytes)

	tweakBytes := multiplyLittleEndianByEight(z[0:28])
	tweak, err := new(edwards25519.Scalar).SetCanonicalBytes(tweakBytes[:])
	if err != nil {
		return XPub{}, fmt.Errorf("decode public child tweak: %w", err)
	}
	parentPoint, err := new(edwards25519.Point).SetBytes(parent.PublicKey[:])
	if err != nil {
		return XPub{}, fmt.Errorf("decode parent public key: %w", err)
	}
	tweakPoint := new(edwards25519.Point).ScalarBaseMult(tweak)
	encoded := new(edwards25519.Point).Add(parentPoint, tweakPoint).Bytes()

	var child XPub
	copy(child.PublicKey[:], encoded)
	copy(child.ChainCode[:], cc[32:64])
	return child, nil
}

func scalarFromLittleEndian(raw []byte) (*edwards25519.Scalar, error) {
	if len(raw) != 32 {
		return nil, fmt.Errorf("scalar is %d bytes, want 32", len(raw))
	}
	// SetUniformBytes interprets a 64-byte little-endian integer and reduces it
	// modulo the Ed25519 subgroup order. Cardano's kL is already clamped but is
	// not necessarily a canonical scalar encoding.
	wide := make([]byte, 64)
	copy(wide, raw)
	return new(edwards25519.Scalar).SetUniformBytes(wide)
}

func hmacSHA512(key []byte, tag byte, publicKey, index []byte) [64]byte {
	mac := hmac.New(sha512.New, key)
	_, _ = mac.Write([]byte{tag})
	_, _ = mac.Write(publicKey)
	_, _ = mac.Write(index)
	var out [64]byte
	copy(out[:], mac.Sum(nil))
	return out
}

func multiplyLittleEndianByEight(raw []byte) [32]byte {
	var out [32]byte
	var carry uint16
	for i, value := range raw {
		shifted := uint16(value)<<3 | carry
		out[i] = byte(shifted)
		carry = shifted >> 8
	}
	if len(raw) < len(out) {
		out[len(raw)] = byte(carry)
	}
	return out
}
