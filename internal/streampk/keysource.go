package streampk

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"os"

	curve "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr/fft"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr/pedersen"

	"proof-tool/internal/msmengine"
)

type KeySource struct {
	idx    *Index
	ra     io.ReaderAt
	closer io.Closer

	domain         fft.Domain
	alpha          curve.G1Affine
	beta           curve.G1Affine
	delta          curve.G1Affine
	g2beta         curve.G2Affine
	g2delta        curve.G2Affine
	infinityA      []bool
	infinityB      []bool
	commitmentKeys []pedersen.ProvingKey
	pkSectionPlan  *msmengine.PKSectionPlan
}

type openConfig struct {
	precomputeDomain bool
}

// OpenOption controls how a proving key is opened. Callers can keep the
// legacy precomputed domain for A/B measurements or explicitly disable it.
type OpenOption func(*openConfig)

// WithDomainPrecompute controls whether the serialized FFT domain rebuilds
// its twiddle and coset tables while the proving key is opened.
func WithDomainPrecompute(enabled bool) OpenOption {
	return func(config *openConfig) {
		config.precomputeDomain = enabled
	}
}

func resolveOpenConfig(opts []OpenOption) openConfig {
	config := openConfig{precomputeDomain: true}
	for _, opt := range opts {
		opt(&config)
	}
	return config
}

func OpenKeyFile(path string, opts ...OpenOption) (*KeySource, error) {
	config := resolveOpenConfig(opts)
	idx, err := BuildIndex(path)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open proving key %s: %w", path, err)
	}
	ks := &KeySource{idx: idx, ra: f, closer: f}
	if err := ks.loadSmallFields(config); err != nil {
		f.Close()
		return nil, err
	}
	return ks, nil
}

func OpenKeyURL(idx *Index, url string, opts ...OpenOption) (*KeySource, error) {
	config := resolveOpenConfig(opts)
	if err := ValidateIndex(idx); err != nil {
		return nil, err
	}
	ks := &KeySource{idx: idx, ra: &httpRangeAt{client: httpDefaultClient(), url: url}, closer: io.NopCloser(bytes.NewReader(nil))}
	if err := ks.loadSmallFields(config); err != nil {
		return nil, fmt.Errorf("open proving key URL %s: %w", url, err)
	}
	return ks, nil
}

func (ks *KeySource) Close() error {
	if ks == nil || ks.closer == nil {
		return nil
	}
	return ks.closer.Close()
}

func (ks *KeySource) loadSmallFields(config openConfig) error {
	if err := ValidateIndex(ks.idx); err != nil {
		return err
	}

	domainBuf := make([]byte, DomainHeaderBytes)
	if _, err := ks.ra.ReadAt(domainBuf, 0); err != nil {
		return fmt.Errorf("read domain header: %w", err)
	}
	domain, err := decodeDomainHeader(domainBuf, config.precomputeDomain)
	if err != nil {
		return err
	}
	ks.domain = domain

	g1Singletons := make([]byte, 3*G1RawBytes)
	if _, err := ks.ra.ReadAt(g1Singletons, DomainHeaderBytes); err != nil {
		return fmt.Errorf("read G1 singletons: %w", err)
	}
	g1Decoder := curve.NewDecoder(bytes.NewReader(g1Singletons), curve.NoSubgroupChecks())
	if err := g1Decoder.Decode(&ks.alpha); err != nil {
		return fmt.Errorf("decode Alpha: %w", err)
	}
	if err := g1Decoder.Decode(&ks.beta); err != nil {
		return fmt.Errorf("decode Beta: %w", err)
	}
	if err := g1Decoder.Decode(&ks.delta); err != nil {
		return fmt.Errorf("decode Delta: %w", err)
	}

	kSec := ks.idx.Sections["K"]
	g2Off := kSec.Offset + kSec.Len
	g2Singletons := make([]byte, 2*G2RawBytes)
	if _, err := ks.ra.ReadAt(g2Singletons, g2Off); err != nil {
		return fmt.Errorf("read G2 singletons: %w", err)
	}
	g2Decoder := curve.NewDecoder(bytes.NewReader(g2Singletons), curve.NoSubgroupChecks())
	if err := g2Decoder.Decode(&ks.g2beta); err != nil {
		return fmt.Errorf("decode G2.Beta: %w", err)
	}
	if err := g2Decoder.Decode(&ks.g2delta); err != nil {
		return fmt.Errorf("decode G2.Delta: %w", err)
	}

	g2bSec := ks.idx.Sections["G2B"]
	infOff := g2bSec.Offset + g2bSec.Len
	if ks.idx.NbWires > math.MaxInt32/2 {
		return fmt.Errorf("nbWires %d overflows int on wasm32", ks.idx.NbWires)
	}
	const infHeaderLen = 3 * 8
	nbWires := int(ks.idx.NbWires)
	infBuf := make([]byte, infHeaderLen+2*nbWires)
	if _, err := ks.ra.ReadAt(infBuf, infOff); err != nil {
		return fmt.Errorf("read infinity bitmaps: %w", err)
	}
	ks.infinityA = make([]bool, nbWires)
	ks.infinityB = make([]bool, nbWires)
	for i := 0; i < nbWires; i++ {
		ks.infinityA[i] = infBuf[infHeaderLen+i] != 0
		ks.infinityB[i] = infBuf[infHeaderLen+nbWires+i] != 0
	}

	ks.commitmentKeys = make([]pedersen.ProvingKey, ks.idx.NbCommitmentKeys)
	return nil
}

func decodeDomainHeader(header []byte, precompute bool) (fft.Domain, error) {
	if len(header) != DomainHeaderBytes {
		return fft.Domain{}, fmt.Errorf("decode domain: header size %d, want %d", len(header), DomainHeaderBytes)
	}
	if flag := header[DomainHeaderBytes-1]; flag > 1 {
		return fft.Domain{}, fmt.Errorf("decode domain: precompute flag byte %d is not canonical", flag)
	}
	var domain fft.Domain
	reader := bytes.NewReader(header)
	var err error
	if precompute {
		_, err = domain.ReadFrom(reader)
	} else {
		_, err = domain.ReadFromWithoutPrecompute(reader)
	}
	if err != nil {
		return fft.Domain{}, fmt.Errorf("decode domain: %w", err)
	}
	if reader.Len() != 0 {
		return fft.Domain{}, fmt.Errorf("decode domain: %d trailing bytes", reader.Len())
	}
	if err := validateCanonicalDomain(&domain); err != nil {
		return fft.Domain{}, fmt.Errorf("decode domain: %w", err)
	}
	return domain, nil
}

func validateCanonicalDomain(domain *fft.Domain) error {
	if domain.Cardinality == 0 || domain.Cardinality&(domain.Cardinality-1) != 0 {
		return fmt.Errorf("canonical field cardinality mismatch: %d is not a power of two", domain.Cardinality)
	}
	if _, err := fft.Generator(domain.Cardinality); err != nil {
		return fmt.Errorf("canonical field cardinality mismatch: %w", err)
	}
	expected := fft.NewDomain(domain.Cardinality, fft.WithoutPrecompute())
	if domain.Cardinality != expected.Cardinality {
		return fmt.Errorf("canonical field cardinality mismatch")
	}
	if domain.CardinalityInv != expected.CardinalityInv {
		return fmt.Errorf("canonical field cardinalityInv mismatch")
	}
	if domain.Generator != expected.Generator {
		return fmt.Errorf("canonical field generator mismatch")
	}
	if domain.GeneratorInv != expected.GeneratorInv {
		return fmt.Errorf("canonical field generatorInv mismatch")
	}
	if domain.FrMultiplicativeGen != expected.FrMultiplicativeGen {
		return fmt.Errorf("canonical field shift mismatch")
	}
	if domain.FrMultiplicativeGenInv != expected.FrMultiplicativeGenInv {
		return fmt.Errorf("canonical field shiftInv mismatch")
	}
	return nil
}

const pkBufSize = 64 * 1024 * 1024

func (ks *KeySource) G1(name string, buf []curve.G1Affine) ([]curve.G1Affine, error) {
	sec, ok := ks.idx.Sections[name]
	if !ok {
		return nil, fmt.Errorf("G1 section %q not found", name)
	}
	nPoints := int(sec.Len) / G1RawBytes
	sr := io.NewSectionReader(ks.ra, sec.Offset, sec.Len)
	return decodeG1Section(bufio.NewReaderSize(sr, pkBufSize), nPoints, buf)
}

func (ks *KeySource) G2(name string, buf []curve.G2Affine) ([]curve.G2Affine, error) {
	sec, ok := ks.idx.Sections[name]
	if !ok {
		return nil, fmt.Errorf("G2 section %q not found", name)
	}
	nPoints := int(sec.Len) / G2RawBytes
	sr := io.NewSectionReader(ks.ra, sec.Offset, sec.Len)
	return decodeG2Section(bufio.NewReaderSize(sr, pkBufSize), nPoints, buf)
}

func (ks *KeySource) G1Range(name string, lo, hi int, buf []curve.G1Affine) ([]curve.G1Affine, error) {
	sec, ok := ks.idx.Sections[name]
	if !ok {
		return nil, fmt.Errorf("G1 section %q not found", name)
	}
	nTotal := int(sec.Len) / sec.ElemSize
	if lo < 0 || lo > hi || hi > nTotal {
		return nil, fmt.Errorf("G1Range %s [%d,%d) out of bounds (len=%d)", name, lo, hi, nTotal)
	}
	nPoints := hi - lo
	if nPoints == 0 {
		return buf[:0], nil
	}
	off := sec.Offset + int64(lo)*int64(sec.ElemSize)
	length := int64(nPoints) * int64(sec.ElemSize)
	sr := io.NewSectionReader(ks.ra, off, length)
	bufSize := int(length)
	if bufSize > pkBufSize {
		bufSize = pkBufSize
	}
	return decodeG1Section(bufio.NewReaderSize(sr, bufSize), nPoints, buf)
}

func (ks *KeySource) G2Range(name string, lo, hi int, buf []curve.G2Affine) ([]curve.G2Affine, error) {
	sec, ok := ks.idx.Sections[name]
	if !ok {
		return nil, fmt.Errorf("G2 section %q not found", name)
	}
	nTotal := int(sec.Len) / sec.ElemSize
	if lo < 0 || lo > hi || hi > nTotal {
		return nil, fmt.Errorf("G2Range %s [%d,%d) out of bounds (len=%d)", name, lo, hi, nTotal)
	}
	nPoints := hi - lo
	if nPoints == 0 {
		return buf[:0], nil
	}
	off := sec.Offset + int64(lo)*int64(sec.ElemSize)
	length := int64(nPoints) * int64(sec.ElemSize)
	sr := io.NewSectionReader(ks.ra, off, length)
	bufSize := int(length)
	if bufSize > pkBufSize {
		bufSize = pkBufSize
	}
	return decodeG2Section(bufio.NewReaderSize(sr, bufSize), nPoints, buf)
}

func (ks *KeySource) SectionPointCount(name string) (int, error) {
	sec, ok := ks.idx.Sections[name]
	if !ok {
		return 0, fmt.Errorf("section %q not found", name)
	}
	return int(sec.Len) / sec.ElemSize, nil
}

func (ks *KeySource) SetPKSectionPlan(plan *msmengine.PKSectionPlan) {
	ks.pkSectionPlan = plan
}

func (ks *KeySource) PKSectionPlan() *msmengine.PKSectionPlan {
	if ks == nil {
		return nil
	}
	return ks.pkSectionPlan
}

// ProveMSMScalarTotals returns the expected scalar counts for the MSM calls
// ProveStream makes, in call order. Progress can sum current done counts over
// this fixed denominator for an approximate proof-generation percentage.
func (ks *KeySource) ProveMSMScalarTotals() ([]int, error) {
	var totals []int
	for i := 0; i < int(ks.idx.NbCommitmentKeys); i++ {
		name := commitmentSectionName("Basis", i)
		n, err := ks.SectionPointCount(name)
		if err != nil {
			return nil, err
		}
		totals = append(totals, n)
	}
	for i := 0; i < int(ks.idx.NbCommitmentKeys); i++ {
		name := commitmentSectionName("BasisExpSigma", i)
		n, err := ks.SectionPointCount(name)
		if err != nil {
			return nil, err
		}
		totals = append(totals, n)
	}
	for _, name := range []string{"G2B", "A", "B"} {
		n, err := ks.SectionPointCount(name)
		if err != nil {
			return nil, err
		}
		totals = append(totals, n)
	}
	zCount, err := ks.SectionPointCount("Z")
	if err != nil {
		return nil, err
	}
	sizeH := int(ks.domain.Cardinality - 1)
	if sizeH < 0 || sizeH > zCount {
		return nil, fmt.Errorf("section H size %d outside section Z length %d", sizeH, zCount)
	}
	totals = append(totals, sizeH)
	kCount, err := ks.SectionPointCount("K")
	if err != nil {
		return nil, err
	}
	totals = append(totals, kCount)
	return totals, nil
}

func commitmentSectionName(base string, i int) string {
	if i == 0 {
		return base
	}
	return fmt.Sprintf("%s_%d", base, i)
}

func (ks *KeySource) Alpha() curve.G1Affine                 { return ks.alpha }
func (ks *KeySource) Beta() curve.G1Affine                  { return ks.beta }
func (ks *KeySource) Delta() curve.G1Affine                 { return ks.delta }
func (ks *KeySource) G2Beta() curve.G2Affine                { return ks.g2beta }
func (ks *KeySource) G2Delta() curve.G2Affine               { return ks.g2delta }
func (ks *KeySource) Domain() fft.Domain                    { return ks.domain }
func (ks *KeySource) InfinityA() []bool                     { return ks.infinityA }
func (ks *KeySource) InfinityB() []bool                     { return ks.infinityB }
func (ks *KeySource) NbInfinityA() uint64                   { return ks.idx.NbInfinityA }
func (ks *KeySource) NbInfinityB() uint64                   { return ks.idx.NbInfinityB }
func (ks *KeySource) CommitmentKeys() []pedersen.ProvingKey { return ks.commitmentKeys }

func decodeG1Section(r io.Reader, nPoints int, buf []curve.G1Affine) ([]curve.G1Affine, error) {
	if cap(buf) < nPoints {
		buf = make([]curve.G1Affine, nPoints)
	} else {
		buf = buf[:nPoints]
	}
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], uint32(nPoints))
	decoder := curve.NewDecoder(io.MultiReader(bytes.NewReader(prefix[:]), r), curve.NoSubgroupChecks())
	if err := decoder.Decode(&buf); err != nil {
		return nil, fmt.Errorf("decode G1 section: %w", err)
	}
	return buf, nil
}

func decodeG2Section(r io.Reader, nPoints int, buf []curve.G2Affine) ([]curve.G2Affine, error) {
	if cap(buf) < nPoints {
		buf = make([]curve.G2Affine, nPoints)
	} else {
		buf = buf[:nPoints]
	}
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], uint32(nPoints))
	decoder := curve.NewDecoder(io.MultiReader(bytes.NewReader(prefix[:]), r), curve.NoSubgroupChecks())
	if err := decoder.Decode(&buf); err != nil {
		return nil, fmt.Errorf("decode G2 section: %w", err)
	}
	return buf, nil
}
