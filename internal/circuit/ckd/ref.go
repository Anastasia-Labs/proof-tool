// Package ckd is the out-of-circuit Go reference mirror of the BIP32-Ed25519 V2
// child-key derivation (CKD) chain used by Cardano (CIP-1852 / Icarus). It
// reuses the audited pure-Go references for HMAC-SHA512 and Ed25519 fixed-base
// scalar multiplication, and reproduces the derivation relation exactly so it
// can serve as the fast in-process oracle for the circuit's differential tests.
//
// It must agree byte-for-byte with the `refgen` binary (which routes through
// the ed25519-bip32 crate). The relation below is frozen against that oracle.
package ckd

import (
	"math/big"

	"proof-tool/internal/circuit/ed25519/ed"
	"proof-tool/internal/circuit/sha512/sha"
)

// Ext is an extended secret-key state: little-endian left/right scalar halves
// kL, kR and the 32-byte chain code cc.
type Ext struct {
	KL, KR, CC [32]byte
}

// twoTo256 = 2^256, the modulus applied to the right scalar half kR.
var twoTo256 = new(big.Int).Lsh(big.NewInt(1), 256)

// DeriveRef derives the leaf extended secret key at CIP-1852 path
// m/1852'/1815'/{account}'/{role}/{index} from a 96-byte master XPrv
// (kL ‖ kR ‖ cc, all little-endian / raw).
func DeriveRef(master96 []byte, account, role, index uint32) Ext {
	rows := DeriveLevels(master96, account, role, index)
	return rows[len(rows)-1]
}

// DeriveLevels returns the extended secret-key state after each hop of the
// CIP-1852 path, in order: 1852', 1815', account', role, index. This mirrors
// refgen's `levels` command so every intermediate level can be cross-checked.
func DeriveLevels(master96 []byte, account, role, index uint32) []Ext {
	const hardenedBit = uint32(0x8000_0000)

	parent := Ext{}
	copy(parent.KL[:], master96[0:32])
	copy(parent.KR[:], master96[32:64])
	copy(parent.CC[:], master96[64:96])

	type hop struct {
		idx      uint32
		hardened bool
	}
	path := []hop{
		{hardenedBit | 1852, true},
		{hardenedBit | 1815, true},
		{hardenedBit | account, true},
		{role, false},
		{index, false},
	}

	rows := make([]Ext, 0, len(path))
	for _, h := range path {
		parent = deriveChild(parent, h.idx, h.hardened)
		rows = append(rows, parent)
	}
	return rows
}

// deriveChild performs one BIP32-Ed25519 V2 derivation step.
//
//	msg = tagZ ‖ data ‖ le32(idx)
//	ccm = tagCC ‖ data ‖ le32(idx)
//	Z   = HMAC-SHA512(cc_par, msg)
//	CC  = HMAC-SHA512(cc_par, ccm)
//	kL_child = kL_par + 8 * le_int(Z[0:28])          (no mod L)
//	kR_child = (kR_par + le_int(Z[32:64])) mod 2^256
//	cc_child = CC[32:64]
//
// Hardened: tagZ=0x00, tagCC=0x01, data = kL_par ‖ kR_par.
// Soft:     tagZ=0x02, tagCC=0x03, data = A_par (compressed kL_par·B).
func deriveChild(par Ext, idx uint32, hardened bool) Ext {
	var tagZ, tagCC byte
	var data []byte
	if hardened {
		tagZ, tagCC = 0x00, 0x01
		data = make([]byte, 0, 64)
		data = append(data, par.KL[:]...)
		data = append(data, par.KR[:]...)
	} else {
		tagZ, tagCC = 0x02, 0x03
		a := leafPubkey(par.KL) // compressed A_par = kL_par · B
		data = make([]byte, 0, 32)
		data = append(data, a...)
	}

	idxLE := le32(idx)

	msg := make([]byte, 0, 1+len(data)+4)
	msg = append(msg, tagZ)
	msg = append(msg, data...)
	msg = append(msg, idxLE...)

	ccm := make([]byte, 0, 1+len(data)+4)
	ccm = append(ccm, tagCC)
	ccm = append(ccm, data...)
	ccm = append(ccm, idxLE...)

	z := sha.RefHMACSHA512(par.CC[:], msg)
	cc := sha.RefHMACSHA512(par.CC[:], ccm)

	// kL_child = kL_par + 8 * le_int(Z[0:28])
	zl := leToInt(z[0:28])
	zl.Lsh(zl, 3) // * 8
	klChild := new(big.Int).Add(leToInt(par.KL[:]), zl)

	// Real V2 derivations never overflow 32 bytes and keep bit 255 clear.
	// Assert rather than silently mask, so a broken relation is caught.
	if klChild.BitLen() > 255 {
		panic("ckd: kL child overflowed 256 bits (bit255 set or wider)")
	}

	// kR_child = (kR_par + le_int(Z[32:64])) mod 2^256
	krChild := new(big.Int).Add(leToInt(par.KR[:]), leToInt(z[32:64]))
	krChild.Mod(krChild, twoTo256)

	var out Ext
	out.KL = intToLE32(klChild)
	out.KR = intToLE32(krChild)
	copy(out.CC[:], cc[32:64])
	return out
}

// leafPubkey returns the 32-byte RFC-8032 compressed encoding of kL·B, where kL
// is consumed AS-IS as a little-endian integer (no reduction mod L), matching
// the BIP32-Ed25519 V2 leaf-scalar convention.
func leafPubkey(kL [32]byte) []byte {
	s := leToInt(kL[:])
	p := ed.RefScalarMulBase(s)
	c := ed.RefCompress(p)
	return c[:]
}

// le32 serializes idx as 4 little-endian bytes.
func le32(idx uint32) []byte {
	return []byte{byte(idx), byte(idx >> 8), byte(idx >> 16), byte(idx >> 24)}
}

// leToInt interprets b as a little-endian unsigned integer.
func leToInt(b []byte) *big.Int {
	be := make([]byte, len(b))
	for i := 0; i < len(b); i++ {
		be[len(b)-1-i] = b[i]
	}
	return new(big.Int).SetBytes(be)
}

// intToLE32 encodes v as a fixed 32-byte little-endian array. Panics if v does
// not fit in 32 bytes (caller is responsible for range invariants).
func intToLE32(v *big.Int) [32]byte {
	be := v.Bytes() // big-endian, minimal
	if len(be) > 32 {
		panic("ckd: value does not fit in 32 bytes")
	}
	var out [32]byte
	for i := 0; i < len(be); i++ {
		out[i] = be[len(be)-1-i]
	}
	return out
}
