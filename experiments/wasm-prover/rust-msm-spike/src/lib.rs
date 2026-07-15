//! rust-msm-spike — Workstream C phase 0 go/no-go kernel.
//!
//! A minimal BLS12-381 G1 MSM kernel over arkworks, speaking the SAME wire
//! format as the Go worker kernel (internal/msmengine/serialize.go):
//!   - point : 96 bytes, gnark `G1Affine.RawBytes()` = ZCash uncompressed
//!             big-endian X||Y; top 3 bits of byte 0 are flags
//!             (0b000 = uncompressed, 0b010 = uncompressed infinity)
//!   - scalar: 32 bytes big-endian canonical (non-Montgomery)
//!   - result: 96 bytes, same uncompressed encoding of the MSM sum
//!
//! Because an MSM is an exact group sum, a correct kernel + correct
//! (de)serialization must produce output BYTES identical to the Go kernel's
//! partial — the harness asserts that on every run.
//!
//! This is a benchmark spike, NOT production code: no side-channel hygiene,
//! panics abort the instance, and validation is on-curve only (matching the
//! pinned-decode contract: digest-authenticated inputs skip subgroup checks).

use ark_bls12_381::{Fq, Fr, G1Affine, G1Projective};
use ark_ec::{AffineRepr, CurveGroup, VariableBaseMSM};
#[allow(unused_imports)]
use ark_ff::{BigInteger, PrimeField, Zero};

const POINT_SIZE: usize = 96;
const COORD_SIZE: usize = 48;
const SCALAR_SIZE: usize = 32;

const FLAG_MASK: u8 = 0b111 << 5;
const FLAG_UNCOMPRESSED: u8 = 0b000 << 5;
const FLAG_UNCOMPRESSED_INFINITY: u8 = 0b010 << 5;

/// Bump-free allocation for the host: hand out a boxed slice and leak it; the
/// harness owns the wasm instance's lifetime, so "free" is instance teardown.
#[no_mangle]
pub extern "C" fn rmsm_alloc(len: usize) -> *mut u8 {
    let mut buf = vec![0u8; len].into_boxed_slice();
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

fn parse_fq(be: &[u8]) -> Option<Fq> {
    // Canonical big-endian; from_be_bytes_mod_order would silently accept
    // non-canonical values, so compare against the modulus via round-trip.
    let fq = Fq::from_be_bytes_mod_order(be);
    if fq.into_bigint().to_bytes_be() == be {
        Some(fq)
    } else {
        None
    }
}

fn parse_point(raw: &[u8]) -> Option<G1Affine> {
    let flags = raw[0] & FLAG_MASK;
    if flags == FLAG_UNCOMPRESSED_INFINITY {
        if raw[1..].iter().any(|&b| b != 0) || raw[0] != FLAG_UNCOMPRESSED_INFINITY {
            return None;
        }
        return Some(G1Affine::zero());
    }
    if flags != FLAG_UNCOMPRESSED {
        return None;
    }
    let x = parse_fq(&raw[..COORD_SIZE])?;
    let y = parse_fq(&raw[COORD_SIZE..POINT_SIZE])?;
    let p = G1Affine::new_unchecked(x, y);
    // On-curve check only, matching the Go pinned-decode contract.
    if !p.is_on_curve() {
        return None;
    }
    Some(p)
}

fn write_point(p: &G1Affine, out: &mut [u8]) {
    if p.is_zero() {
        out.fill(0);
        out[0] = FLAG_UNCOMPRESSED_INFINITY;
        return;
    }
    // x < p fits 381 bits, so the top 3 flag bits of byte 0 are naturally 0.
    out[..COORD_SIZE].copy_from_slice(&p.x.into_bigint().to_bytes_be());
    out[COORD_SIZE..POINT_SIZE].copy_from_slice(&p.y.into_bigint().to_bytes_be());
}

fn decode_inputs(
    pts_ptr: *const u8,
    scs_ptr: *const u8,
    n: usize,
) -> Result<(Vec<G1Affine>, Vec<Fr>), i32> {
    let pts_raw = unsafe { core::slice::from_raw_parts(pts_ptr, n * POINT_SIZE) };
    let scs_raw = unsafe { core::slice::from_raw_parts(scs_ptr, n * SCALAR_SIZE) };
    let mut points = Vec::with_capacity(n);
    for chunk in pts_raw.chunks_exact(POINT_SIZE) {
        points.push(parse_point(chunk).ok_or(2)?);
    }
    let mut scalars = Vec::with_capacity(n);
    for chunk in scs_raw.chunks_exact(SCALAR_SIZE) {
        // Canonical big-endian scalars; the Go side always emits reduced values.
        scalars.push(Fr::from_be_bytes_mod_order(chunk));
    }
    Ok((points, scalars))
}

/// Full kernel: decode + MSM + encode (the same boundary as Go shardG1Bytes).
/// Returns 0 on success.
#[no_mangle]
pub extern "C" fn rmsm_msm_g1(
    pts_ptr: *const u8,
    scs_ptr: *const u8,
    n: usize,
    out_ptr: *mut u8,
) -> i32 {
    let (points, scalars) = match decode_inputs(pts_ptr, scs_ptr, n) {
        Ok(v) => v,
        Err(code) => return code,
    };
    let sum: G1Projective = match G1Projective::msm(&points, &scalars) {
        Ok(s) => s,
        Err(_) => return 3,
    };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, POINT_SIZE) };
    write_point(&sum.into_affine(), out);
    0
}

/// Decode-only entrypoint so the harness can split decode vs multiexp time
/// (mirrors the Go kernel's point_decode_ms/multiexp_ms telemetry).
#[no_mangle]
pub extern "C" fn rmsm_decode_g1(pts_ptr: *const u8, scs_ptr: *const u8, n: usize) -> i32 {
    match decode_inputs(pts_ptr, scs_ptr, n) {
        Ok((points, scalars)) => (points.len() + scalars.len()) as i32,
        Err(code) => -code,
    }
}
