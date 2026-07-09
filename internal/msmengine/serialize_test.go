package msmengine

import (
	"bytes"
	"math/big"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"
)

// TestShardSerializeRoundTripG1 drives the EXACT worker message path natively:
// for each shard, marshal points+scalars to the wire bytes a worker receives,
// run shardG1Bytes (the worker kernel) to get the partial bytes a worker posts
// back, unmarshal the partials on the "main" side, combineG1, and assert the
// result is BIT-EXACT equal to a whole-vector single-thread MultiExp. This
// covers the serialization round-trip (RawBytes/SetBytes) that the native
// partition test does not — the only piece the js transport adds on top of the
// already-proven partition/combine math.
func TestShardSerializeRoundTripG1(t *testing.T) {
	pts, scs := randomG1Vec(t, 8000)

	var whole bls12381.G1Jac
	if _, err := whole.MultiExp(pts, scs, ecc.MultiExpConfig{NbTasks: 1}); err != nil {
		t.Fatal(err)
	}

	ranges := partitionRanges(len(pts), 6)
	var parts []bls12381.G1Jac
	for _, r := range ranges {
		ptsBuf := marshalG1Points(pts[r[0]:r[1]])
		scsBuf := marshalScalars(scs[r[0]:r[1]])
		partialBuf, err := shardG1Bytes(ptsBuf, scsBuf)
		if err != nil {
			t.Fatal(err)
		}
		jac, err := unmarshalG1Jac(partialBuf)
		if err != nil {
			t.Fatal(err)
		}
		parts = append(parts, jac)
	}
	got := combineG1(parts)
	if !got.Equal(&whole) {
		t.Fatal("G1 shard serialize round-trip + combine != whole MSM")
	}
}

// TestShardSerializeRoundTripG2 is the G2 counterpart (the largest, OOM-prone
// vector in the prove).
func TestShardSerializeRoundTripG2(t *testing.T) {
	n := 3000
	pts := make([]bls12381.G2Affine, n)
	scs := make([]fr.Element, n)
	_, g2Gen, _, _ := bls12381.Generators()
	for i := range pts {
		var ptSc fr.Element
		if _, err := ptSc.SetRandom(); err != nil {
			t.Fatal(err)
		}
		var bigPtSc big.Int
		ptSc.BigInt(&bigPtSc)
		var jac bls12381.G2Jac
		jac.ScalarMultiplication(&g2Gen, &bigPtSc)
		pts[i].FromJacobian(&jac)
		if _, err := scs[i].SetRandom(); err != nil {
			t.Fatal(err)
		}
	}

	var whole bls12381.G2Jac
	if _, err := whole.MultiExp(pts, scs, ecc.MultiExpConfig{NbTasks: 1}); err != nil {
		t.Fatal(err)
	}

	ranges := partitionRanges(len(pts), 4)
	var parts []bls12381.G2Jac
	for _, r := range ranges {
		ptsBuf := marshalG2Points(pts[r[0]:r[1]])
		scsBuf := marshalScalars(scs[r[0]:r[1]])
		partialBuf, err := shardG2Bytes(ptsBuf, scsBuf)
		if err != nil {
			t.Fatal(err)
		}
		jac, err := unmarshalG2Jac(partialBuf)
		if err != nil {
			t.Fatal(err)
		}
		parts = append(parts, jac)
	}
	got := combineG2(parts)
	if !got.Equal(&whole) {
		t.Fatal("G2 shard serialize round-trip + combine != whole MSM")
	}
}

// TestScalarRoundTrip checks fr.Element survives marshal/unmarshal exactly.
func TestScalarRoundTrip(t *testing.T) {
	scs := make([]fr.Element, 256)
	for i := range scs {
		if _, err := scs[i].SetRandom(); err != nil {
			t.Fatal(err)
		}
	}
	buf := marshalScalars(scs)
	got, err := unmarshalScalars(buf)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(scs) {
		t.Fatalf("got %d scalars, want %d", len(got), len(scs))
	}
	for i := range scs {
		if !got[i].Equal(&scs[i]) {
			t.Fatalf("scalar %d mismatch after round-trip", i)
		}
	}
}

// TestG1PointRoundTrip checks the uncompressed point encoding is byte-stable.
func TestG1PointRoundTrip(t *testing.T) {
	pts, _ := randomG1Vec(t, 64)
	buf := marshalG1Points(pts)
	got, err := unmarshalG1Points(buf)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(buf, marshalG1Points(got)) {
		t.Fatal("G1 point encoding not byte-stable across round-trip")
	}
	for i := range pts {
		if !got[i].Equal(&pts[i]) {
			t.Fatalf("G1 point %d mismatch after round-trip", i)
		}
	}
}

func TestPinnedG1DecodeMatchesCheckedAndRejectsOffCurve(t *testing.T) {
	pts, _ := randomG1Vec(t, 64)
	buf := marshalG1Points(pts)
	checked, err := unmarshalG1Points(buf)
	if err != nil {
		t.Fatal(err)
	}
	pinned, err := unmarshalG1PointsPinned(buf)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(marshalG1Points(checked), marshalG1Points(pinned)) {
		t.Fatal("pinned G1 decode differs from checked decode")
	}

	corrupt := corruptUntilPinnedG1Rejects(t, buf)
	if _, err := unmarshalG1PointsPinned(corrupt); err == nil {
		t.Fatal("pinned G1 decode accepted corrupted off-curve bytes")
	}
}

func TestPinnedG2DecodeMatchesCheckedAndRejectsOffCurve(t *testing.T) {
	pts, _ := randomG2Vec(t, 32)
	buf := marshalG2Points(pts)
	checked, err := unmarshalG2Points(buf)
	if err != nil {
		t.Fatal(err)
	}
	pinned, err := unmarshalG2PointsPinned(buf)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(marshalG2Points(checked), marshalG2Points(pinned)) {
		t.Fatal("pinned G2 decode differs from checked decode")
	}

	corrupt := corruptUntilPinnedG2Rejects(t, buf)
	if _, err := unmarshalG2PointsPinned(corrupt); err == nil {
		t.Fatal("pinned G2 decode accepted corrupted off-curve bytes")
	}
}

func TestShardTimedReportsDecodeAndMultiExp(t *testing.T) {
	pts, scs := randomG1Vec(t, 128)
	partial, timings, err := shardG1BytesTimed(marshalG1Points(pts), marshalScalars(scs), true)
	if err != nil {
		t.Fatal(err)
	}
	if len(partial) != bls12381.SizeOfG1AffineUncompressed {
		t.Fatalf("partial len %d", len(partial))
	}
	if timings.DecodeMS < 0 || timings.MultiExpMS < 0 || timings.KernelMS < 0 {
		t.Fatalf("negative timings: %+v", timings)
	}
	if timings.NonzeroScalars == 0 {
		t.Fatal("nonzero scalar telemetry was not populated")
	}
	if !timings.PinnedDecode {
		t.Fatal("timings did not record pinned decode")
	}
}

func corruptUntilPinnedG1Rejects(t *testing.T, buf []byte) []byte {
	t.Helper()
	for i := len(buf) - 1; i >= 0; i-- {
		corrupt := append([]byte(nil), buf...)
		corrupt[i] ^= 0x01
		if _, err := unmarshalG1PointsPinned(corrupt); err != nil {
			return corrupt
		}
	}
	t.Fatal("could not produce a G1 corruption rejected by pinned decode")
	return nil
}

func corruptUntilPinnedG2Rejects(t *testing.T, buf []byte) []byte {
	t.Helper()
	for i := len(buf) - 1; i >= 0; i-- {
		corrupt := append([]byte(nil), buf...)
		corrupt[i] ^= 0x01
		if _, err := unmarshalG2PointsPinned(corrupt); err != nil {
			return corrupt
		}
	}
	t.Fatal("could not produce a G2 corruption rejected by pinned decode")
	return nil
}
