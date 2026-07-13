// Command bench-native-prove measures native (non-WASM) Groth16 proving time
// for the frozen root-ownership-destination-v2 circuit using the ceremony
// artifacts hosted on R2 (ownership.pk, ownership-destination.ccs) and the
// repository golden witness. It deliberately deserializes the frozen CCS
// instead of recompiling, so the measurement binds to the exact ceremony
// constraint system regardless of local compile drift.
//
// Usage:
//
//	bench-native-prove \
//	  --ccs ~/.cache/proof-tool-bench/ownership-destination.ccs \
//	  --pk  ~/.cache/proof-tool-bench/ownership.pk \
//	  --vk  apps/ownership-proof-web/public/proof-assets/ownership.vk \
//	  --runs 4
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"runtime"
	"runtime/pprof"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/frontend"

	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/circuit/ownershipdest"
	"proof-tool/internal/prover"
)

// Repository golden fixture (internal/circuit/ownershipdest/gate_test.go).
const (
	goldenMasterHex      = "c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620"
	goldenDestinationHex = "010038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da1110000000000000000000000000000000000000000000000000000000000"
	wantPKSHA256         = "sha256:3e8a88b48ce1604697f705480196e54e1b87728637ccc6806e1888b7c8a114d6"
	wantVKSHA256         = "sha256:6484b03a5aafa96859be256484d84bebab0d6051f04373e416d2d2189e7fdec4"
	wantCCSBlake2b256    = "blake2b256:bf2243b3f4885357bbad0b6728582f56f0e00cd361e1e8af8a2d0dbe10a9f352"
)

type runTiming struct {
	WitnessMS float64 `json:"witness_ms"`
	ProveMS   float64 `json:"prove_ms"`
	VerifyMS  float64 `json:"verify_ms"`
}

type report struct {
	CircuitID     string      `json:"circuit_id"`
	Constraints   int         `json:"constraints"`
	NumCPU        int         `json:"num_cpu"`
	GOMAXPROCS    int         `json:"gomaxprocs"`
	CCSLoadMS     float64     `json:"ccs_load_ms"`
	PKLoadMS      float64     `json:"pk_load_ms"`
	Runs          []runTiming `json:"runs"`
	MedianProveMS float64     `json:"median_prove_ms"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run() error {
	ccsPath := flag.String("ccs", "", "path to frozen ownership-destination.ccs")
	pkPath := flag.String("pk", "", "path to ceremony ownership.pk")
	vkPath := flag.String("vk", "", "path to ownership.vk")
	runs := flag.Int("runs", 4, "number of timed prove runs")
	skipDigests := flag.Bool("skip-digests", false, "skip artifact digest verification (not recommended)")
	cpuProfile := flag.String("cpuprofile", "", "write a CPU profile covering the prove runs to this path")
	flag.Parse()
	if *ccsPath == "" || *pkPath == "" || *vkPath == "" {
		return fmt.Errorf("--ccs, --pk, and --vk are required")
	}

	if !*skipDigests {
		for _, check := range []struct{ path, wantSHA256, wantBlake string }{
			{*pkPath, wantPKSHA256, ""},
			{*vkPath, wantVKSHA256, ""},
			{*ccsPath, "", wantCCSBlake2b256},
		} {
			digest, err := prover.DigestFile(check.path)
			if err != nil {
				return fmt.Errorf("digest %s: %w", check.path, err)
			}
			if check.wantSHA256 != "" && digest.SHA256 != check.wantSHA256 {
				return fmt.Errorf("%s sha256 = %s, want %s", check.path, digest.SHA256, check.wantSHA256)
			}
			if check.wantBlake != "" && digest.Blake2b256 != check.wantBlake {
				return fmt.Errorf("%s blake2b256 = %s, want %s", check.path, digest.Blake2b256, check.wantBlake)
			}
			fmt.Fprintf(os.Stderr, "verified %s\n", check.path)
		}
	}

	ccsFile, err := os.Open(*ccsPath)
	if err != nil {
		return err
	}
	defer ccsFile.Close()
	ccs := groth16.NewCS(ecc.BLS12_381)
	ccsStart := time.Now()
	if _, err := ccs.ReadFrom(ccsFile); err != nil {
		return fmt.Errorf("read ccs: %w", err)
	}
	ccsLoadMS := msSince(ccsStart)

	pkFile, err := os.Open(*pkPath)
	if err != nil {
		return err
	}
	defer pkFile.Close()
	pk := groth16.NewProvingKey(ecc.BLS12_381)
	pkStart := time.Now()
	if _, err := pk.UnsafeReadFrom(pkFile); err != nil {
		return fmt.Errorf("read pk: %w", err)
	}
	pkLoadMS := msSince(pkStart)

	vk, err := prover.LoadVK(*vkPath)
	if err != nil {
		return fmt.Errorf("read vk: %w", err)
	}

	master, err := ownership.DecodeMasterXPrvHex(goldenMasterHex)
	if err != nil {
		return err
	}
	destination, err := ownershipdest.DecodeDestinationAddressV1Hex(goldenDestinationHex)
	if err != nil {
		return err
	}
	path := ownership.Path{Account: 0, Role: 0, Index: 0}
	credential, err := ownership.DeriveCredential(master, path)
	if err != nil {
		return err
	}
	pub, err := ownershipdest.PublicInputForCredentialDestination(credential[:], destination)
	if err != nil {
		return err
	}
	assignment, err := ownershipdest.Assignment(master, path, destination, pub)
	if err != nil {
		return err
	}

	rep := report{
		CircuitID:   ownershipdest.CircuitID,
		Constraints: ccs.GetNbConstraints(),
		NumCPU:      runtime.NumCPU(),
		GOMAXPROCS:  runtime.GOMAXPROCS(0),
		CCSLoadMS:   ccsLoadMS,
		PKLoadMS:    pkLoadMS,
	}

	if *cpuProfile != "" {
		f, err := os.Create(*cpuProfile)
		if err != nil {
			return err
		}
		defer f.Close()
		if err := pprof.StartCPUProfile(f); err != nil {
			return err
		}
		defer pprof.StopCPUProfile()
	}

	for i := 0; i < *runs; i++ {
		witStart := time.Now()
		w, err := frontend.NewWitness(assignment, ecc.BLS12_381.ScalarField())
		if err != nil {
			return fmt.Errorf("run %d witness: %w", i, err)
		}
		witMS := msSince(witStart)

		proveStart := time.Now()
		proof, err := groth16.Prove(ccs, pk, w)
		if err != nil {
			return fmt.Errorf("run %d prove: %w", i, err)
		}
		proveMS := msSince(proveStart)

		pubW, err := w.Public()
		if err != nil {
			return fmt.Errorf("run %d public witness: %w", i, err)
		}
		verifyStart := time.Now()
		if err := groth16.Verify(proof, vk, pubW); err != nil {
			return fmt.Errorf("run %d verify: %w", i, err)
		}
		verifyMS := msSince(verifyStart)

		rep.Runs = append(rep.Runs, runTiming{WitnessMS: witMS, ProveMS: proveMS, VerifyMS: verifyMS})
		fmt.Fprintf(os.Stderr, "run %d: witness %.0fms prove %.0fms verify %.0fms\n", i, witMS, proveMS, verifyMS)
	}

	proveTimes := make([]float64, 0, len(rep.Runs))
	for _, r := range rep.Runs {
		proveTimes = append(proveTimes, r.ProveMS)
	}
	rep.MedianProveMS = median(proveTimes)

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(rep)
}

func msSince(t time.Time) float64 {
	return float64(time.Since(t)) / float64(time.Millisecond)
}

func median(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]float64(nil), values...)
	for i := range sorted {
		for j := i + 1; j < len(sorted); j++ {
			if sorted[j] < sorted[i] {
				sorted[i], sorted[j] = sorted[j], sorted[i]
			}
		}
	}
	if len(sorted)%2 == 1 {
		return sorted[len(sorted)/2]
	}
	return (sorted[len(sorted)/2-1] + sorted[len(sorted)/2]) / 2
}
