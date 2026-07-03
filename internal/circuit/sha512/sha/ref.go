package sha

import (
	"crypto/hmac"
	"crypto/sha512"
)

// RefSHA512 is the out-of-circuit reference (Go standard library, FIPS 180-4)
// used to cross-check the gadget and to derive expected digests for tests.
func RefSHA512(msg []byte) []byte {
	h := sha512.Sum512(msg)
	return h[:]
}

// RefHMACSHA512 is the out-of-circuit reference HMAC-SHA512 (RFC 2104 / RFC 4231).
func RefHMACSHA512(key, msg []byte) []byte {
	m := hmac.New(sha512.New, key)
	m.Write(msg)
	return m.Sum(nil)
}
