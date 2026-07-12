package streampk

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"

	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr/fft"
)

func TestDomainHeaderPrecomputeModesAreCanonicallyEqual(t *testing.T) {
	header := canonicalDomainHeader(t, 16)

	legacy, err := decodeDomainHeader(header, true)
	if err != nil {
		t.Fatalf("decode legacy domain: %v", err)
	}
	withoutPrecompute, err := decodeDomainHeader(header, false)
	if err != nil {
		t.Fatalf("decode domain without precompute: %v", err)
	}

	if legacy.Cardinality != withoutPrecompute.Cardinality ||
		legacy.CardinalityInv != withoutPrecompute.CardinalityInv ||
		legacy.Generator != withoutPrecompute.Generator ||
		legacy.GeneratorInv != withoutPrecompute.GeneratorInv ||
		legacy.FrMultiplicativeGen != withoutPrecompute.FrMultiplicativeGen ||
		legacy.FrMultiplicativeGenInv != withoutPrecompute.FrMultiplicativeGenInv {
		t.Fatal("legacy and no-precompute canonical domain fields differ")
	}
	if _, err := legacy.Twiddles(); err != nil {
		t.Fatalf("legacy domain did not precompute twiddles: %v", err)
	}
	if _, err := withoutPrecompute.Twiddles(); err == nil {
		t.Fatal("no-precompute domain unexpectedly has twiddles")
	}
	if _, err := withoutPrecompute.CosetTable(); err == nil {
		t.Fatal("no-precompute domain unexpectedly has a coset table")
	}
}

func TestDomainHeaderRejectsEveryDoctoredCanonicalField(t *testing.T) {
	canonical := canonicalDomainHeader(t, 16)
	tests := []struct {
		name   string
		field  string
		doctor func([]byte)
	}{
		{
			name:  "cardinality",
			field: "cardinality",
			doctor: func(header []byte) {
				binary.BigEndian.PutUint64(header[:8], 15)
			},
		},
		{name: "cardinalityInv", field: "cardinalityInv", doctor: flipDomainElement(0)},
		{name: "generator", field: "generator", doctor: flipDomainElement(1)},
		{name: "generatorInv", field: "generatorInv", doctor: flipDomainElement(2)},
		{name: "shift", field: "shift", doctor: flipDomainElement(3)},
		{name: "shiftInv", field: "shiftInv", doctor: flipDomainElement(4)},
	}

	for _, test := range tests {
		for _, precompute := range []bool{true, false} {
			mode := "without-precompute"
			if precompute {
				mode = "legacy"
			}
			t.Run(test.name+"/"+mode, func(t *testing.T) {
				header := append([]byte(nil), canonical...)
				test.doctor(header)
				_, err := decodeDomainHeader(header, precompute)
				if err == nil {
					t.Fatalf("doctored %s was accepted", test.field)
				}
				if !strings.Contains(err.Error(), test.field) {
					t.Fatalf("error %q does not identify %s", err, test.field)
				}
			})
		}
	}
}

func TestDomainHeaderRejectsNonCanonicalShapeAndFlag(t *testing.T) {
	canonical := canonicalDomainHeader(t, 16)
	tests := []struct {
		name   string
		header []byte
		field  string
	}{
		{name: "truncated", header: canonical[:len(canonical)-1], field: "header size"},
		{name: "trailing", header: append(append([]byte(nil), canonical...), 0), field: "header size"},
		{name: "invalid-precompute-flag", header: doctoredPrecomputeFlag(canonical, 2), field: "precompute flag"},
	}
	for _, test := range tests {
		for _, precompute := range []bool{true, false} {
			t.Run(test.name+"/"+modeName(precompute), func(t *testing.T) {
				_, err := decodeDomainHeader(test.header, precompute)
				if err == nil || !strings.Contains(err.Error(), test.field) {
					t.Fatalf("error = %v, want field %q", err, test.field)
				}
			})
		}
	}
}

func TestOpenConfigKeepsLegacyDefaultAndAllowsABSelection(t *testing.T) {
	if config := resolveOpenConfig(nil); !config.precomputeDomain {
		t.Fatal("default open config must retain legacy domain precompute")
	}
	if config := resolveOpenConfig([]OpenOption{WithDomainPrecompute(false)}); config.precomputeDomain {
		t.Fatal("explicit no-precompute open config was ignored")
	}
	if config := resolveOpenConfig([]OpenOption{WithDomainPrecompute(false), WithDomainPrecompute(true)}); !config.precomputeDomain {
		t.Fatal("last explicit open option should win")
	}
}

func canonicalDomainHeader(t *testing.T, cardinality uint64) []byte {
	t.Helper()
	domain := fft.NewDomain(cardinality)
	var encoded bytes.Buffer
	written, err := domain.WriteTo(&encoded)
	if err != nil {
		t.Fatalf("encode domain: %v", err)
	}
	if written != DomainHeaderBytes || encoded.Len() != DomainHeaderBytes {
		t.Fatalf("encoded domain header size = %d/%d, want %d", written, encoded.Len(), DomainHeaderBytes)
	}
	return encoded.Bytes()
}

func flipDomainElement(index int) func([]byte) {
	return func(header []byte) {
		offset := 8 + index*fr.Bytes
		header[offset+fr.Bytes-1] ^= 1
	}
}

func doctoredPrecomputeFlag(header []byte, flag byte) []byte {
	out := append([]byte(nil), header...)
	out[len(out)-1] = flag
	return out
}

func modeName(precompute bool) string {
	if precompute {
		return "legacy"
	}
	return "without-precompute"
}
