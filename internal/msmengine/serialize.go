package msmengine

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"
)

// serialize.go is the build-tag-free worker message format and shard compute
// kernel shared by the js transport (sharded_js.go) and the native round-trip
// test (serialize_test.go). Keeping it off the js && wasm tag means the exact
// bytes a worker sees — and the partial it returns — are validated on native Go
// with the real gnark MultiExp, not merely compiled.
//
// Byte layout (the worker message format):
//   - G1 point: SizeOfG1AffineUncompressed (96) bytes, RawBytes()
//   - G2 point: SizeOfG2AffineUncompressed (192) bytes, RawBytes()
//   - scalar  : 32 bytes, fr.Element.Bytes() (big-endian canonical)
// A partial result is the uncompressed affine encoding of the partial Jacobian.
// Uncompressed avoids per-point decompression sqrt; inputs come from the
// trusted proving key.

const scalarSize = fr.Bytes // 32

type shardTimings struct {
	PointDecodeMS  float64
	ScalarDecodeMS float64
	DecodeMS       float64
	MultiExpMS     float64
	KernelMS       float64
	NonzeroScalars int
	PinnedDecode   bool
}

//nolint:unused // used by sharded_js.go under the js && wasm build tags, which golangci-lint does not analyze
func (t shardTimings) fields() map[string]float64 {
	return map[string]float64{
		"point_decode_ms":  t.PointDecodeMS,
		"scalar_decode_ms": t.ScalarDecodeMS,
		"decode_ms":        t.DecodeMS,
		"multiexp_ms":      t.MultiExpMS,
		"kernel_ms":        t.KernelMS,
	}
}

func elapsedKernelMS(start time.Time) float64 {
	return float64(time.Since(start).Microseconds()) / 1000
}

func marshalG1Points(points []bls12381.G1Affine) []byte {
	const sz = bls12381.SizeOfG1AffineUncompressed
	out := make([]byte, len(points)*sz)
	for i := range points {
		b := points[i].RawBytes()
		copy(out[i*sz:], b[:])
	}
	return out
}

func marshalG2Points(points []bls12381.G2Affine) []byte {
	const sz = bls12381.SizeOfG2AffineUncompressed
	out := make([]byte, len(points)*sz)
	for i := range points {
		b := points[i].RawBytes()
		copy(out[i*sz:], b[:])
	}
	return out
}

func marshalScalars(scalars []fr.Element) []byte {
	out := make([]byte, len(scalars)*scalarSize)
	for i := range scalars {
		b := scalars[i].Bytes()
		copy(out[i*scalarSize:], b[:])
	}
	return out
}

func unmarshalG1Points(buf []byte) ([]bls12381.G1Affine, error) {
	const sz = bls12381.SizeOfG1AffineUncompressed
	if len(buf)%sz != 0 {
		return nil, fmt.Errorf("g1 point buffer len %d not a multiple of %d", len(buf), sz)
	}
	n := len(buf) / sz
	pts := make([]bls12381.G1Affine, n)
	for i := 0; i < n; i++ {
		if _, err := pts[i].SetBytes(buf[i*sz : (i+1)*sz]); err != nil {
			return nil, err
		}
	}
	return pts, nil
}

// unmarshalG1PointsPinned decodes digest-authenticated proving-key points. It
// matches the main streaming key source by skipping the redundant subgroup
// check, then explicitly preserves the cheaper on-curve validation.
func unmarshalG1PointsPinned(buf []byte) ([]bls12381.G1Affine, error) {
	const sz = bls12381.SizeOfG1AffineUncompressed
	if len(buf)%sz != 0 {
		return nil, fmt.Errorf("g1 point buffer len %d not a multiple of %d", len(buf), sz)
	}
	n := len(buf) / sz
	pts := make([]bls12381.G1Affine, n)
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], uint32(n))
	decoder := bls12381.NewDecoder(io.MultiReader(bytes.NewReader(prefix[:]), bytes.NewReader(buf)), bls12381.NoSubgroupChecks())
	if err := decoder.Decode(&pts); err != nil {
		return nil, err
	}
	for i := range pts {
		if !pts[i].IsOnCurve() {
			return nil, fmt.Errorf("g1 point %d is not on curve", i)
		}
	}
	return pts, nil
}

func unmarshalG2Points(buf []byte) ([]bls12381.G2Affine, error) {
	const sz = bls12381.SizeOfG2AffineUncompressed
	if len(buf)%sz != 0 {
		return nil, fmt.Errorf("g2 point buffer len %d not a multiple of %d", len(buf), sz)
	}
	n := len(buf) / sz
	pts := make([]bls12381.G2Affine, n)
	for i := 0; i < n; i++ {
		if _, err := pts[i].SetBytes(buf[i*sz : (i+1)*sz]); err != nil {
			return nil, err
		}
	}
	return pts, nil
}

func unmarshalG2PointsPinned(buf []byte) ([]bls12381.G2Affine, error) {
	const sz = bls12381.SizeOfG2AffineUncompressed
	if len(buf)%sz != 0 {
		return nil, fmt.Errorf("g2 point buffer len %d not a multiple of %d", len(buf), sz)
	}
	n := len(buf) / sz
	pts := make([]bls12381.G2Affine, n)
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], uint32(n))
	decoder := bls12381.NewDecoder(io.MultiReader(bytes.NewReader(prefix[:]), bytes.NewReader(buf)), bls12381.NoSubgroupChecks())
	if err := decoder.Decode(&pts); err != nil {
		return nil, err
	}
	for i := range pts {
		if !pts[i].IsOnCurve() {
			return nil, fmt.Errorf("g2 point %d is not on curve", i)
		}
	}
	return pts, nil
}

func unmarshalScalars(buf []byte) ([]fr.Element, error) {
	scs, _, err := unmarshalScalarsWithStats(buf)
	return scs, err
}

func unmarshalScalarsWithStats(buf []byte) ([]fr.Element, int, error) {
	if len(buf)%scalarSize != 0 {
		return nil, 0, fmt.Errorf("scalar buffer len %d not a multiple of %d", len(buf), scalarSize)
	}
	n := len(buf) / scalarSize
	scs := make([]fr.Element, n)
	nonzero := 0
	for i := 0; i < n; i++ {
		scs[i].SetBytes(buf[i*scalarSize : (i+1)*scalarSize])
		if !scs[i].IsZero() {
			nonzero++
		}
	}
	return scs, nonzero, nil
}

func marshalG1Jac(p *bls12381.G1Jac) []byte {
	var aff bls12381.G1Affine
	aff.FromJacobian(p)
	b := aff.RawBytes()
	return b[:]
}

func marshalG2Jac(p *bls12381.G2Jac) []byte {
	var aff bls12381.G2Affine
	aff.FromJacobian(p)
	b := aff.RawBytes()
	return b[:]
}

func unmarshalG1Jac(buf []byte) (bls12381.G1Jac, error) {
	var aff bls12381.G1Affine
	if _, err := aff.SetBytes(buf); err != nil {
		return bls12381.G1Jac{}, err
	}
	var jac bls12381.G1Jac
	jac.FromAffine(&aff)
	return jac, nil
}

func unmarshalG2Jac(buf []byte) (bls12381.G2Jac, error) {
	var aff bls12381.G2Affine
	if _, err := aff.SetBytes(buf); err != nil {
		return bls12381.G2Jac{}, err
	}
	var jac bls12381.G2Jac
	jac.FromAffine(&aff)
	return jac, nil
}

// shardG1Bytes is the pure compute kernel each worker runs: deserialise a
// shard's points and scalars, run the single-thread MultiExp, and serialise the
// partial Jacobian. JS-free so the native round-trip test exercises it directly.
func shardG1Bytes(ptsBuf, scsBuf []byte) ([]byte, error) {
	out, _, err := shardG1BytesTimed(ptsBuf, scsBuf, false)
	return out, err
}

func shardG1BytesTimed(ptsBuf, scsBuf []byte, pinnedDecode bool) ([]byte, shardTimings, error) {
	kernelStart := time.Now()
	pointStart := time.Now()
	var pts []bls12381.G1Affine
	var err error
	if pinnedDecode {
		pts, err = unmarshalG1PointsPinned(ptsBuf)
	} else {
		pts, err = unmarshalG1Points(ptsBuf)
	}
	pointDecodeMS := elapsedKernelMS(pointStart)
	if err != nil {
		return nil, shardTimings{PointDecodeMS: pointDecodeMS, DecodeMS: pointDecodeMS, KernelMS: elapsedKernelMS(kernelStart), PinnedDecode: pinnedDecode}, err
	}
	scalarStart := time.Now()
	scs, nonzero, err := unmarshalScalarsWithStats(scsBuf)
	scalarDecodeMS := elapsedKernelMS(scalarStart)
	timings := shardTimings{
		PointDecodeMS:  pointDecodeMS,
		ScalarDecodeMS: scalarDecodeMS,
		DecodeMS:       pointDecodeMS + scalarDecodeMS,
		NonzeroScalars: nonzero,
		PinnedDecode:   pinnedDecode,
	}
	if err != nil {
		timings.KernelMS = elapsedKernelMS(kernelStart)
		return nil, timings, err
	}
	if len(pts) != len(scs) {
		timings.KernelMS = elapsedKernelMS(kernelStart)
		return nil, timings, fmt.Errorf("shardG1: %d points vs %d scalars", len(pts), len(scs))
	}
	var partial bls12381.G1Jac
	if len(pts) > 0 {
		multiExpStart := time.Now()
		if _, err := partial.MultiExp(pts, scs, ecc.MultiExpConfig{NbTasks: 1}); err != nil {
			timings.MultiExpMS = elapsedKernelMS(multiExpStart)
			timings.KernelMS = elapsedKernelMS(kernelStart)
			return nil, timings, err
		}
		timings.MultiExpMS = elapsedKernelMS(multiExpStart)
	}
	timings.KernelMS = elapsedKernelMS(kernelStart)
	return marshalG1Jac(&partial), timings, nil
}

func shardG2Bytes(ptsBuf, scsBuf []byte) ([]byte, error) {
	out, _, err := shardG2BytesTimed(ptsBuf, scsBuf, false)
	return out, err
}

func shardG2BytesTimed(ptsBuf, scsBuf []byte, pinnedDecode bool) ([]byte, shardTimings, error) {
	kernelStart := time.Now()
	pointStart := time.Now()
	var pts []bls12381.G2Affine
	var err error
	if pinnedDecode {
		pts, err = unmarshalG2PointsPinned(ptsBuf)
	} else {
		pts, err = unmarshalG2Points(ptsBuf)
	}
	pointDecodeMS := elapsedKernelMS(pointStart)
	if err != nil {
		return nil, shardTimings{PointDecodeMS: pointDecodeMS, DecodeMS: pointDecodeMS, KernelMS: elapsedKernelMS(kernelStart), PinnedDecode: pinnedDecode}, err
	}
	scalarStart := time.Now()
	scs, nonzero, err := unmarshalScalarsWithStats(scsBuf)
	scalarDecodeMS := elapsedKernelMS(scalarStart)
	timings := shardTimings{
		PointDecodeMS:  pointDecodeMS,
		ScalarDecodeMS: scalarDecodeMS,
		DecodeMS:       pointDecodeMS + scalarDecodeMS,
		NonzeroScalars: nonzero,
		PinnedDecode:   pinnedDecode,
	}
	if err != nil {
		timings.KernelMS = elapsedKernelMS(kernelStart)
		return nil, timings, err
	}
	if len(pts) != len(scs) {
		timings.KernelMS = elapsedKernelMS(kernelStart)
		return nil, timings, fmt.Errorf("shardG2: %d points vs %d scalars", len(pts), len(scs))
	}
	var partial bls12381.G2Jac
	if len(pts) > 0 {
		multiExpStart := time.Now()
		if _, err := partial.MultiExp(pts, scs, ecc.MultiExpConfig{NbTasks: 1}); err != nil {
			timings.MultiExpMS = elapsedKernelMS(multiExpStart)
			timings.KernelMS = elapsedKernelMS(kernelStart)
			return nil, timings, err
		}
		timings.MultiExpMS = elapsedKernelMS(multiExpStart)
	}
	timings.KernelMS = elapsedKernelMS(kernelStart)
	return marshalG2Jac(&partial), timings, nil
}
