//go:build js && wasm

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"syscall/js"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/constraint"
	"golang.org/x/crypto/blake2b"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/circuit/ownershipdest"
	"proof-tool/internal/msmengine"
	"proof-tool/internal/proofassets"
	"proof-tool/internal/prover"
	"proof-tool/internal/streampk"
	"proof-tool/internal/streamprove"
)

type proveRequest struct {
	MasterXPrvHex       string          `json:"master_xprv_hex"`
	TargetCredentialHex string          `json:"target_credential_hex"`
	DestinationHex      string          `json:"destination_address_hex"`
	Search              searchRequest   `json:"search"`
	Artifacts           artifactRequest `json:"artifacts"`
	Tuning              tuningRequest   `json:"tuning,omitempty"`
	IncludeDebugPath    bool            `json:"include_debug_path,omitempty"`
}

type searchRequest struct {
	Account    *int   `json:"account,omitempty"`
	Role       *int   `json:"role,omitempty"`
	Index      *int   `json:"index,omitempty"`
	MaxAccount uint32 `json:"max_account,omitempty"`
	MaxIndex   uint32 `json:"max_index,omitempty"`
}

type artifactRequest struct {
	KeyBundleDir  string `json:"key_bundle_dir,omitempty"`
	ManifestURL   string `json:"manifest_url,omitempty"`
	VKURL         string `json:"vk_url,omitempty"`
	PKURL         string `json:"pk_url,omitempty"`
	PKIndexURL    string `json:"pk_index_url,omitempty"`
	CCSURL        string `json:"ccs_url,omitempty"`
	CCSBlake2b256 string `json:"ccs_blake2b256,omitempty"`

	ManifestSignatureURL      string `json:"manifest_sig_url,omitempty"`
	ManifestPublicKeyHex      string `json:"manifest_public_key_hex,omitempty"`
	ChunkManifestURL          string `json:"chunk_manifest_url,omitempty"`
	ChunkManifestSignatureURL string `json:"chunk_manifest_sig_url,omitempty"`
	ChunkManifestPublicKeyHex string `json:"chunk_manifest_public_key_hex,omitempty"`
	DeploymentManifestURL     string `json:"deployment_manifest_url,omitempty"`
	ProofWASMURL              string `json:"proof_wasm_url,omitempty"`
	WorkerJSURL               string `json:"worker_js_url,omitempty"`
	MSMWorkerWASMURL          string `json:"msm_worker_wasm_url,omitempty"`
}

type tuningRequest struct {
	ForceCPU              bool  `json:"force_cpu,omitempty"`
	WorkerCount           int   `json:"worker_count,omitempty"`
	ShardCount            int   `json:"shard_count,omitempty"`
	ShardMultiplier       int   `json:"shard_multiplier,omitempty"`
	RangeFetchConcurrency int   `json:"range_fetch_concurrency,omitempty"`
	PinnedDecode          *bool `json:"pinned_decode,omitempty"`
	OptW1                 bool  `json:"opt_w1,omitempty"`
	OptW2                 bool  `json:"opt_w2,omitempty"`
	OptW3                 bool  `json:"opt_w3,omitempty"`
	OptW5                 bool  `json:"opt_w5,omitempty"`
	OptW6                 bool  `json:"opt_w6,omitempty"`
	OptW7                 bool  `json:"opt_w7,omitempty"`
}

type proveResult struct {
	Artifact        artifact.ProofArtifact `json:"artifact"`
	Engine          string                 `json:"engine"`
	MS              int64                  `json:"ms"`
	WallSeconds     float64                `json:"wall_seconds"`
	PeakHeapGiB     float64                `json:"peak_heap_gib"`
	VerifiedLocally bool                   `json:"verified_locally"`
	RuntimeOptions  map[string]bool        `json:"runtime_options"`
	Trace           *proofTrace            `json:"trace,omitempty"`
}

type streamingArtifacts struct {
	manifest      *artifact.KeyManifest
	verifyingKey  groth16.VerifyingKey
	keySource     *streampk.KeySource
	chunkManifest *proofassets.ChunkManifest
}

type proofTrace struct {
	Schema               string              `json:"schema"`
	StartedAt            string              `json:"started_at"`
	Engine               string              `json:"engine,omitempty"`
	WorkerCount          int                 `json:"worker_count,omitempty"`
	ShardCount           int                 `json:"shard_count,omitempty"`
	RangeFetchConcurrent int                 `json:"range_fetch_concurrency,omitempty"`
	GOMEMLIMIT           string              `json:"gomemlimit,omitempty"`
	GOGC                 string              `json:"gogc,omitempty"`
	ProgressDenominator  int                 `json:"progress_denominator,omitempty"`
	ProgressScalars      []int               `json:"progress_scalars,omitempty"`
	PKRangeStats         streampk.RangeStats `json:"pk_range_stats"`
	RuntimeOptions       map[string]bool     `json:"runtime_options,omitempty"`
	Events               []traceEvent        `json:"events"`
	started              time.Time
	activeStages         map[string]memSnapshot
}

type traceEvent struct {
	Phase        string              `json:"phase"`
	Stage        string              `json:"stage"`
	AtMS         int64               `json:"at_ms"`
	Mem          memSnapshot         `json:"mem"`
	PKRangeStats streampk.RangeStats `json:"pk_range_stats"`
	Fields       map[string]any      `json:"fields,omitempty"`
}

type memSnapshot struct {
	Alloc        uint64 `json:"alloc"`
	HeapAlloc    uint64 `json:"heap_alloc"`
	HeapSys      uint64 `json:"heap_sys"`
	HeapInuse    uint64 `json:"heap_inuse"`
	HeapReleased uint64 `json:"heap_released"`
	StackInuse   uint64 `json:"stack_inuse"`
	Sys          uint64 `json:"sys"`
	NumGC        uint32 `json:"num_gc"`
	NumForcedGC  uint32 `json:"num_forced_gc"`
	PauseTotalNs uint64 `json:"pause_total_ns"`
}

func main() {
	js.Global().Set("proveDestination", js.FuncOf(proveDestination))
	js.Global().Set("preflightProofAssets", js.FuncOf(preflightProofAssets))
	js.Global().Set("probeMSMEngine", js.FuncOf(probeMSMEngineJS))
	capabilities, err := toJS(map[string]any{
		"optimization_flags": []string{"w1", "w2", "w3", "w5", "w6", "w7"},
		"worker_count":       map[string]any{"explicit": true, "max": 16, "probe": true},
	})
	if err != nil {
		panic(err)
	}
	js.Global().Set("__wasmProverCapabilities", capabilities)
	js.Global().Set("__wasmProverReady", true)
	select {}
}

func proveDestination(_ js.Value, args []js.Value) any {
	requestJSON := ""
	if len(args) > 0 {
		requestJSON = args[0].String()
	}
	var progressCB js.Value
	if len(args) > 1 {
		progressCB = args[1]
	}

	handler := js.FuncOf(func(_ js.Value, promiseArgs []js.Value) any {
		resolve, reject := promiseArgs[0], promiseArgs[1]
		go func() {
			result, err := prove(requestJSON, progressCB)
			if err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
				return
			}
			resolve.Invoke(result)
		}()
		return nil
	})
	return js.Global().Get("Promise").New(handler)
}

func preflightProofAssets(_ js.Value, args []js.Value) any {
	requestJSON := ""
	if len(args) > 0 {
		requestJSON = args[0].String()
	}
	handler := js.FuncOf(func(_ js.Value, promiseArgs []js.Value) any {
		resolve, reject := promiseArgs[0], promiseArgs[1]
		go func() {
			result, err := preflight(requestJSON)
			if err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
				return
			}
			resolve.Invoke(result)
		}()
		return nil
	})
	return js.Global().Get("Promise").New(handler)
}

func probeMSMEngineJS(_ js.Value, args []js.Value) any {
	requestJSON := ""
	if len(args) > 0 {
		requestJSON = args[0].String()
	}
	handler := js.FuncOf(func(_ js.Value, promiseArgs []js.Value) any {
		resolve, reject := promiseArgs[0], promiseArgs[1]
		go func() {
			result, err := probeEngine(requestJSON)
			if err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
				return
			}
			resolve.Invoke(result)
		}()
		return nil
	})
	return js.Global().Get("Promise").New(handler)
}

// probeEngine constructs the exact engine requested by the caller and reports
// its instrumentation. Unlike preflight's requested_tuning echo, this is
// evidence of the selected engine and actual Web Worker pool size. The fault
// harness uses it before cases that may fail before a proof result exists.
func probeEngine(requestJSON string) (js.Value, error) {
	var req proveRequest
	if err := json.Unmarshal([]byte(requestJSON), &req); err != nil {
		return js.Undefined(), fmt.Errorf("parse request json: %w", err)
	}
	requested := msmOptions(req.Tuning, req.Artifacts)
	selected := msmengine.SelectWithOptions(probeCapabilities(), requested)
	defer selected.Close()
	applied := map[string]any{"worker_count": 0}
	if instrumented, ok := selected.(msmengine.InstrumentedEngine); ok {
		applied = instrumented.Instrumentation()
	}
	return toJS(map[string]any{
		"ok":               true,
		"engine":           selected.Name(),
		"requested_tuning": tuningFields(requested),
		"applied_tuning":   applied,
	})
}

func preflight(requestJSON string) (js.Value, error) {
	var req proveRequest
	if err := json.Unmarshal([]byte(requestJSON), &req); err != nil {
		return js.Undefined(), fmt.Errorf("parse request json: %w", err)
	}
	bundle, err := openStreamingArtifacts(req.Artifacts, keyOpenOptions(req.Tuning)...)
	if err != nil {
		return js.Undefined(), fmt.Errorf("load destination streaming artifacts: %w", err)
	}
	defer bundle.Close()
	ccs, err := openConstraintSystem(req.Artifacts, bundle.manifest, bundle.chunkManifest)
	if err != nil {
		return js.Undefined(), err
	}
	out := map[string]any{
		"ok":               true,
		"vk_hash":          bundle.manifest.VKHash,
		"constraints":      ccs.GetNbConstraints(),
		"chunk_manifest":   bundle.chunkManifest != nil,
		"runtime_options":  appliedRuntimeOptions(req.Tuning),
		"requested_tuning": tuningFields(msmOptions(req.Tuning, req.Artifacts)),
	}
	if bundle.chunkManifest != nil {
		out["chunks"] = len(bundle.chunkManifest.ProvingKey.Chunks)
		out["chunk_size"] = bundle.chunkManifest.ProvingKey.ChunkSize
		out["deployment_id"] = bundle.chunkManifest.Coherence.DeploymentID
		out["signature_key_id"] = bundle.chunkManifest.SignatureKeyID
	}
	return toJS(out)
}

func prove(requestJSON string, progressCB js.Value) (js.Value, error) {
	started := time.Now()
	trace := newProofTrace(started)
	restoreTrace := msmengine.SetTraceSink(func(event msmengine.TraceEvent) {
		trace.mark(event.Phase, event.Stage, event.Fields)
	})
	defer restoreTrace()
	defer func() {
		trace.PKRangeStats = streampk.RangeStatsSnapshot()
	}()
	streampk.ResetRangeStats()
	progress(progressCB, "parse", 0.02)
	endParse := trace.span("parse", nil)

	var req proveRequest
	if err := json.Unmarshal([]byte(requestJSON), &req); err != nil {
		return js.Undefined(), fmt.Errorf("parse request json: %w", err)
	}
	endParse(nil)
	runtimeOptions := appliedRuntimeOptions(req.Tuning)
	trace.RuntimeOptions = runtimeOptions

	endInputs := trace.span("decode-inputs", nil)
	master, err := ownership.DecodeMasterXPrvHex(req.MasterXPrvHex)
	if err != nil {
		return js.Undefined(), err
	}
	target, err := ownershipdest.DecodeCredentialHex(req.TargetCredentialHex)
	if err != nil {
		return js.Undefined(), err
	}
	destination, err := ownershipdest.DecodeDestinationAddressV1Hex(req.DestinationHex)
	if err != nil {
		return js.Undefined(), err
	}
	endInputs(nil)

	progress(progressCB, "open-keys", 0.08)
	endOpenKeys := trace.span("open-keys", map[string]any{"source": artifactSource(req.Artifacts)})
	bundle, err := openStreamingArtifacts(req.Artifacts, keyOpenOptions(req.Tuning)...)
	if err != nil {
		return js.Undefined(), fmt.Errorf("load destination streaming artifacts: %w", err)
	}
	defer bundle.Close()
	endOpenKeys(map[string]any{
		"pk_range_requests": streampk.RangeStatsSnapshot().Requests,
		"pk_range_bytes":    streampk.RangeStatsSnapshot().Bytes,
	})

	progress(progressCB, "open-ccs", 0.14)
	endOpenCCS := trace.span("open-ccs", map[string]any{"ccs_url": req.Artifacts.CCSURL != ""})
	ccs, err := openConstraintSystem(req.Artifacts, bundle.manifest, bundle.chunkManifest)
	if err != nil {
		return js.Undefined(), err
	}
	endOpenCCS(map[string]any{"constraints": ccs.GetNbConstraints()})

	progress(progressCB, "find-path", 0.20)
	endFindPath := trace.span("find-path", nil)
	path, err := ownership.FindPath(master, target, searchOptions(req.Search))
	if err != nil {
		return js.Undefined(), err
	}
	endFindPath(map[string]any{"account": path.Account, "role": path.Role, "index": path.Index})

	endWitness := trace.span("witness creation", nil)
	publicInput, err := ownershipdest.PublicInputForCredentialDestination(target, destination)
	if err != nil {
		return js.Undefined(), err
	}
	assignment, err := ownershipdest.Assignment(master, path, destination, publicInput)
	if err != nil {
		return js.Undefined(), err
	}
	endWitness(nil)

	runtime.GC()
	debug.FreeOSMemory()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)

	progress(progressCB, "probe", 0.24)
	endProbe := trace.span("probe", nil)
	probe := probeCapabilities()
	tuning := msmOptions(req.Tuning, req.Artifacts)
	selected := msmengine.SelectWithOptions(probe, tuning)
	defer selected.Close()
	previousEngine := msmengine.Current()
	defer msmengine.SetCurrent(previousEngine)
	msmTotals, err := bundle.keySource.ProveMSMScalarTotals()
	if err != nil {
		return js.Undefined(), fmt.Errorf("compute proof progress weights: %w", err)
	}
	trace.ProgressScalars = append([]int(nil), msmTotals...)
	for _, n := range msmTotals {
		trace.ProgressDenominator += n
	}
	trace.applyEngine(selected)
	endProbe(map[string]any{
		"webgpu":               probe.WebGPU,
		"shared_memory":        probe.SharedMem,
		"hardware_concurrency": probe.Workers,
		"requested_tuning":     tuningFields(tuning),
		"engine":               selected.Name(),
	})
	restoreProgress := installMSMProgress(progressCB, msmTotals)
	defer restoreProgress()

	progress(progressCB, "prove", 0.30)
	endProve := trace.span("prove", map[string]any{"progress_denominator": trace.ProgressDenominator})
	proveStarted := time.Now()
	var proof groth16.Proof
	usedEngine := selected.Name()
	runWithEngine := func(e msmengine.MSMEngine) error {
		usedEngine = e.Name()
		msmengine.SetCurrent(e)
		trace.Engine = "streampk-" + usedEngine + "-groth16"
		trace.applyEngine(e)
		var p groth16.Proof
		var perr error
		streamOptions := streamprove.Options{OptW1: req.Tuning.OptW1, OptW6: req.Tuning.OptW6}
		if req.Tuning.OptW3 {
			p, perr = streamprove.ProveAndReleaseWithOptions(&ccs, bundle.keySource, assignment, streamOptions)
		} else {
			p, perr = streamprove.ProveWithOptions(ccs, bundle.keySource, assignment, streamOptions)
		}
		if perr != nil {
			return perr
		}
		proof = p
		return nil
	}
	var runErr error
	if req.Tuning.OptW3 {
		runErr = msmengine.WithFallbackReload(selected, func() error {
			// W3: never retry from the primary attempt's CCS. A Solve failure still
			// owns it; a post-Solve failure has already consumed it. Drop either
			// state and reopen through the same hash/size-pinned loader.
			ccs = nil
			endReload := trace.span("reload-ccs", map[string]any{"reason": "cpu-fallback"})
			reloaded, reloadErr := reopenPinnedConstraintSystem(req.Artifacts, bundle.manifest, bundle.chunkManifest)
			if reloadErr != nil {
				endReload(map[string]any{"error": reloadErr.Error()})
				return fmt.Errorf("reload hash-pinned constraint system: %w", reloadErr)
			}
			ccs = reloaded
			endReload(map[string]any{"constraints": ccs.GetNbConstraints()})
			return nil
		}, runWithEngine)
	} else {
		runErr = msmengine.WithFallback(selected, runWithEngine)
	}
	if runErr != nil {
		ccs = nil
		return js.Undefined(), runErr
	}
	if proof == nil {
		return js.Undefined(), fmt.Errorf("stream proof returned nil proof")
	}
	proveMS := time.Since(proveStarted).Milliseconds()
	endProve(map[string]any{"ms": proveMS, "engine": usedEngine})

	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	peak := after.HeapSys
	if before.HeapSys > peak {
		peak = before.HeapSys
	}

	progress(progressCB, "verify", 0.92)
	endVerify := trace.span("verify", nil)
	publicOnly := &ownershipdest.Circuit{Pub: publicInput}
	if err := prover.VerifyProof(bundle.verifyingKey, proof, publicOnly); err != nil {
		return js.Undefined(), fmt.Errorf("local verify: %w", err)
	}
	endVerify(nil)

	endSerialize := trace.span("serialize artifact", nil)
	encodedProof, err := prover.MarshalProof(proof)
	if err != nil {
		return js.Undefined(), err
	}
	publicInputDigest, err := ownershipdest.PublicInputDigestForCredentialDestination(target, destination)
	if err != nil {
		return js.Undefined(), err
	}
	cardanoProof, err := prover.CardanoProofArtifactWithDigest(proof, publicInputDigest)
	if err != nil {
		return js.Undefined(), err
	}
	outArtifact := artifact.ProofArtifact{
		Schema:                     artifact.ProofSchema,
		CircuitID:                  ownershipdest.CircuitID,
		VKHash:                     bundle.manifest.VKHash,
		TargetCredential:           hex.EncodeToString(target),
		DestinationAddressEncoding: ownershipdest.DestinationAddressEncoding,
		DestinationAddress:         hex.EncodeToString(destination),
		PublicInputEncoding:        ownershipdest.PublicInputEncoding,
		PublicInput:                ownershipdest.PublicInputHex(publicInput),
		Proof:                      encodedProof,
		Cardano:                    cardanoProof,
	}
	if req.IncludeDebugPath {
		outArtifact.Path = &artifact.PathMetadata{Account: path.Account, Role: path.Role, Index: path.Index}
	}
	endSerialize(map[string]any{
		"proof_bytes": len(encodedProof),
		"cardano":     outArtifact.Cardano != nil,
	})

	trace.PKRangeStats = streampk.RangeStatsSnapshot()
	result := proveResult{
		Artifact:        artifact.BackendProofArtifact(outArtifact),
		Engine:          "streampk-" + usedEngine + "-groth16",
		MS:              proveMS,
		WallSeconds:     time.Since(started).Seconds(),
		PeakHeapGiB:     float64(peak) / (1 << 30),
		VerifiedLocally: true,
		RuntimeOptions:  runtimeOptions,
		Trace:           trace,
	}
	progress(progressCB, "done", 1.0)
	return toJS(result)
}

func probeCapabilities() msmengine.Probe {
	g := js.Global()
	probe := msmengine.Probe{}
	if nav := g.Get("navigator"); !nav.IsUndefined() && !nav.IsNull() {
		if gpu := nav.Get("gpu"); !gpu.IsUndefined() && !gpu.IsNull() {
			probe.WebGPU = true
		}
		if hc := nav.Get("hardwareConcurrency"); !hc.IsUndefined() && !hc.IsNull() {
			probe.Workers = hc.Int()
		}
	}
	if ci := g.Get("crossOriginIsolated"); !ci.IsUndefined() && ci.Truthy() {
		probe.SharedMem = true
	}
	return probe
}

func newProofTrace(started time.Time) *proofTrace {
	return &proofTrace{
		Schema:       "browser-wasm-proof-trace-v1",
		StartedAt:    started.UTC().Format(time.RFC3339Nano),
		GOMEMLIMIT:   os.Getenv("GOMEMLIMIT"),
		GOGC:         os.Getenv("GOGC"),
		started:      started,
		activeStages: make(map[string]memSnapshot),
	}
}

func (t *proofTrace) span(stage string, fields map[string]any) func(map[string]any) {
	t.mark("start", stage, fields)
	return func(endFields map[string]any) {
		t.mark("end", stage, endFields)
	}
}

func (t *proofTrace) mark(phase, stage string, fields map[string]any) {
	if t == nil {
		return
	}
	mem := snapshotMem()
	fields = cloneFields(fields)
	switch phase {
	case "start":
		t.activeStages[stage] = mem
	case "end":
		if start, ok := t.activeStages[stage]; ok {
			fields = addGCDeltaFields(fields, start, mem)
			delete(t.activeStages, stage)
		}
	}
	t.Events = append(t.Events, traceEvent{
		Phase:        phase,
		Stage:        stage,
		AtMS:         time.Since(t.started).Milliseconds(),
		Mem:          mem,
		PKRangeStats: streampk.RangeStatsSnapshot(),
		Fields:       fields,
	})
}

func (t *proofTrace) applyEngine(e msmengine.MSMEngine) {
	if t == nil || e == nil {
		return
	}
	t.Engine = "streampk-" + e.Name() + "-groth16"
	if inst, ok := e.(msmengine.InstrumentedEngine); ok {
		fields := inst.Instrumentation()
		t.WorkerCount = intField(fields, "worker_count")
		t.ShardCount = intField(fields, "shard_count")
		t.RangeFetchConcurrent = intField(fields, "range_fetch_concurrency")
	}
}

func snapshotMem() memSnapshot {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return memSnapshot{
		Alloc:        m.Alloc,
		HeapAlloc:    m.HeapAlloc,
		HeapSys:      m.HeapSys,
		HeapInuse:    m.HeapInuse,
		HeapReleased: m.HeapReleased,
		StackInuse:   m.StackInuse,
		Sys:          m.Sys,
		NumGC:        m.NumGC,
		NumForcedGC:  m.NumForcedGC,
		PauseTotalNs: m.PauseTotalNs,
	}
}

func addGCDeltaFields(fields map[string]any, start, end memSnapshot) map[string]any {
	if fields == nil {
		fields = make(map[string]any, 3)
	}
	fields["gc_num_delta"] = deltaUint32(start.NumGC, end.NumGC)
	fields["gc_forced_delta"] = deltaUint32(start.NumForcedGC, end.NumForcedGC)
	fields["gc_pause_delta_ns"] = deltaUint64(start.PauseTotalNs, end.PauseTotalNs)
	return fields
}

func deltaUint32(start, end uint32) uint32 {
	if end < start {
		return 0
	}
	return end - start
}

func deltaUint64(start, end uint64) uint64 {
	if end < start {
		return 0
	}
	return end - start
}

func cloneFields(fields map[string]any) map[string]any {
	if len(fields) == 0 {
		return nil
	}
	out := make(map[string]any, len(fields))
	for k, v := range fields {
		out[k] = v
	}
	return out
}

func intField(fields map[string]any, key string) int {
	switch v := fields[key].(type) {
	case int:
		return v
	case int64:
		return int(v)
	case uint64:
		return int(v)
	default:
		return 0
	}
}

func artifactSource(req artifactRequest) string {
	if req.KeyBundleDir != "" {
		return "dir"
	}
	return "url"
}

func msmOptions(req tuningRequest, artifacts artifactRequest) msmengine.Options {
	shards := req.ShardCount
	if shards <= 0 && req.WorkerCount > 0 && req.ShardMultiplier > 0 {
		shards = req.WorkerCount * req.ShardMultiplier
	}
	workerURL := ""
	if artifacts.ChunkManifestURL != "" {
		workerURL = strings.TrimSpace(artifacts.WorkerJSURL)
	}
	pinnedDecode := true
	if req.PinnedDecode != nil {
		pinnedDecode = *req.PinnedDecode
	}
	return msmengine.Options{
		ForceCPU:              req.ForceCPU,
		WorkerCount:           req.WorkerCount,
		ShardCount:            shards,
		RangeFetchConcurrency: req.RangeFetchConcurrency,
		WorkerURL:             workerURL,
		PinnedDecode:          pinnedDecode,
		OptW7:                 req.OptW7,
	}
}

func tuningFields(opts msmengine.Options) map[string]any {
	return map[string]any{
		"force_cpu":               opts.ForceCPU,
		"worker_count":            opts.WorkerCount,
		"shard_count":             opts.ShardCount,
		"range_fetch_concurrency": opts.RangeFetchConcurrency,
		"worker_url":              opts.WorkerURL,
		"pinned_decode":           opts.PinnedDecode,
		"opt_w7":                  opts.OptW7,
	}
}

func keyOpenOptions(req tuningRequest) []streampk.OpenOption {
	return []streampk.OpenOption{streampk.WithDomainPrecompute(!req.OptW2)}
}

func appliedRuntimeOptions(req tuningRequest) map[string]bool {
	return map[string]bool{"w1": req.OptW1, "w2": req.OptW2, "w3": req.OptW3, "w5": req.OptW5, "w6": req.OptW6, "w7": req.OptW7}
}

func openConstraintSystem(req artifactRequest, manifest *artifact.KeyManifest, chunkManifest *proofassets.ChunkManifest) (constraint.ConstraintSystem, error) {
	if req.CCSURL == "" {
		if chunkManifest != nil {
			return nil, fmt.Errorf("ccs_url is required when chunk_manifest_url is supplied")
		}
		msmengine.EmitTrace("measure", "open-ccs", map[string]any{"source": "compile-fallback"})
		return prover.CompileOwnershipDestination()
	}
	ccsURL, err := resolveAssetURL(req.CCSURL)
	if err != nil {
		return nil, fmt.Errorf("ccs_url: %w", err)
	}
	expectedHash := strings.TrimSpace(req.CCSBlake2b256)
	if expectedHash == "" && manifest != nil {
		expectedHash = strings.TrimSpace(manifest.ConstraintSystemHash)
	}
	var expectedCCSAsset *proofassets.AssetPin
	if chunkManifest != nil {
		asset, ok := chunkManifest.Assets["ownership-destination.ccs"]
		if !ok {
			return nil, fmt.Errorf("chunk manifest is missing ownership-destination.ccs asset pin")
		}
		expectedCCSAsset = &asset
		expectedHash = asset.Blake2b256
	}
	if expectedHash == "" {
		return nil, fmt.Errorf("ccs_blake2b256 or manifest constraint_system_hash is required for ccs_url")
	}

	ccs, digest, err := fetchCCS(ccsURL)
	if err != nil {
		return nil, err
	}
	msmengine.EmitTrace("measure", "open-ccs", map[string]any{
		"source":        "url",
		"bytes_fetched": digest.Size,
		"sha256":        digest.SHA256,
		"blake2b256":    digest.Blake2b256,
	})
	if digest.Blake2b256 != expectedHash {
		return nil, fmt.Errorf("constraint system hash mismatch: expected %s, file %s", expectedHash, digest.Blake2b256)
	}
	if expectedCCSAsset != nil {
		if digest.SHA256 != expectedCCSAsset.SHA256 {
			return nil, fmt.Errorf("constraint system sha256 mismatch: expected %s, file %s", expectedCCSAsset.SHA256, digest.SHA256)
		}
		if digest.Size != expectedCCSAsset.Size {
			return nil, fmt.Errorf("constraint system size mismatch: expected %d, file %d", expectedCCSAsset.Size, digest.Size)
		}
	}
	if ccs.GetNbConstraints() == 0 {
		return nil, fmt.Errorf("constraint system has no constraints")
	}
	return ccs, nil
}

func reopenPinnedConstraintSystem(req artifactRequest, manifest *artifact.KeyManifest, chunkManifest *proofassets.ChunkManifest) (constraint.ConstraintSystem, error) {
	if strings.TrimSpace(req.CCSURL) == "" {
		return nil, fmt.Errorf("ccs_url is required for W3 fallback reload; refusing unpinned compile fallback")
	}
	return openConstraintSystem(req, manifest, chunkManifest)
}

func fetchCCS(rawURL string) (constraint.ConstraintSystem, prover.FileDigest, error) {
	resp, err := http.Get(rawURL)
	if err != nil {
		return nil, prover.FileDigest{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, prover.FileDigest{}, fmt.Errorf("GET %s returned %d", rawURL, resp.StatusCode)
	}

	sha := sha256.New()
	blake, err := blake2b.New256(nil)
	if err != nil {
		return nil, prover.FileDigest{}, fmt.Errorf("create blake2b digest: %w", err)
	}
	reader := &countingReader{r: io.TeeReader(resp.Body, io.MultiWriter(sha, blake))}
	ccs := groth16.NewCS(ecc.BLS12_381)
	if _, err := ccs.ReadFrom(reader); err != nil {
		return nil, prover.FileDigest{}, fmt.Errorf("read constraint system: %w", err)
	}
	if _, err := io.Copy(io.Discard, reader); err != nil {
		return nil, prover.FileDigest{}, fmt.Errorf("read constraint system trailer: %w", err)
	}
	return ccs, prover.FileDigest{
		SHA256:     "sha256:" + hex.EncodeToString(sha.Sum(nil)),
		Blake2b256: "blake2b256:" + hex.EncodeToString(blake.Sum(nil)),
		Size:       reader.n,
	}, nil
}

type countingReader struct {
	r io.Reader
	n int64
}

func (r *countingReader) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	r.n += int64(n)
	return n, err
}

func installMSMProgress(progressCB js.Value, expectedTotals []int) func() {
	overallTotal := 0
	for _, n := range expectedTotals {
		if n > 0 {
			overallTotal += n
		}
	}
	if overallTotal <= 0 {
		overallTotal = 1
	}
	doneByCall := make(map[uint64]int, len(expectedTotals))
	var lastFrac float64
	return msmengine.SetProgressSink(func(event msmengine.ProgressEvent) {
		if event.Total <= 0 {
			return
		}
		call := int(event.Call)
		if call < 1 {
			call = 1
		}
		done := event.Done
		if done < 0 {
			done = 0
		}
		callTotal := event.Total
		if call <= len(expectedTotals) && expectedTotals[call-1] > 0 {
			callTotal = expectedTotals[call-1]
		}
		if done > callTotal {
			done = callTotal
		}
		doneByCall[event.Call] = done

		overallDone := 0
		for _, n := range doneByCall {
			overallDone += n
		}
		if overallDone > overallTotal {
			overallDone = overallTotal
		}
		provePart := float64(overallDone) / float64(overallTotal)
		if provePart > 1 {
			provePart = 1
		}
		frac := 0.30 + 0.58*provePart
		if frac < lastFrac {
			frac = lastFrac
		} else {
			lastFrac = frac
		}
		displayPercent := provePart * 100
		if displayPercent > 99.9 && provePart < 1 {
			displayPercent = 99.9
		}
		progress(progressCB, fmt.Sprintf("prove %.1f%%", displayPercent), frac)
	})
}

func (b *streamingArtifacts) Close() error {
	if b == nil || b.keySource == nil {
		return nil
	}
	return b.keySource.Close()
}

func openStreamingArtifacts(req artifactRequest, opts ...streampk.OpenOption) (*streamingArtifacts, error) {
	if req.KeyBundleDir != "" {
		return openStreamingArtifactsFromDir(req.KeyBundleDir, opts...)
	}
	return openStreamingArtifactsFromURLs(req, opts...)
}

func openStreamingArtifactsFromDir(dir string, opts ...streampk.OpenOption) (*streamingArtifacts, error) {
	bundle, err := prover.LoadOwnershipDestinationVerifier(dir)
	if err != nil {
		return nil, err
	}

	pkPath := filepath.Join(dir, "ownership.pk")
	digest, err := prover.DigestFile(pkPath)
	if err != nil {
		return nil, err
	}
	if digest.SHA256 != bundle.Manifest.ProvingKeySHA256 {
		return nil, fmt.Errorf("proving key sha256 mismatch: manifest %s, file %s", bundle.Manifest.ProvingKeySHA256, digest.SHA256)
	}
	if digest.Blake2b256 != bundle.Manifest.ProvingKeyBlake2b256 {
		return nil, fmt.Errorf("proving key blake2b256 mismatch: manifest %s, file %s", bundle.Manifest.ProvingKeyBlake2b256, digest.Blake2b256)
	}
	if digest.Size != bundle.Manifest.ProvingKeySize {
		return nil, fmt.Errorf("proving key size mismatch: manifest %d, file %d", bundle.Manifest.ProvingKeySize, digest.Size)
	}

	source, err := streampk.OpenKeyFile(pkPath, opts...)
	if err != nil {
		return nil, err
	}
	return &streamingArtifacts{manifest: bundle.Manifest, verifyingKey: bundle.VerifyingKey, keySource: source}, nil
}

func openStreamingArtifactsFromURLs(req artifactRequest, opts ...streampk.OpenOption) (*streamingArtifacts, error) {
	manifestURL, err := resolveAssetURL(req.ManifestURL)
	if err != nil {
		return nil, fmt.Errorf("manifest_url: %w", err)
	}
	vkURL, err := resolveAssetURL(req.VKURL)
	if err != nil {
		return nil, fmt.Errorf("vk_url: %w", err)
	}
	pkURL, err := resolveAssetURL(req.PKURL)
	if err != nil {
		return nil, fmt.Errorf("pk_url: %w", err)
	}
	indexURL, err := resolveAssetURL(req.PKIndexURL)
	if err != nil {
		return nil, fmt.Errorf("pk_index_url: %w", err)
	}

	manifestRaw, err := fetchBytes(manifestURL, 1<<20)
	if err != nil {
		return nil, fmt.Errorf("fetch manifest: %w", err)
	}
	var manifest artifact.KeyManifest
	if err := json.Unmarshal(manifestRaw, &manifest); err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}
	if err := validateDestinationManifest(&manifest); err != nil {
		return nil, err
	}
	if err := verifyOptionalKeyManifestSignature(req, manifestRaw); err != nil {
		return nil, err
	}

	vkRaw, err := fetchBytes(vkURL, 16<<20)
	if err != nil {
		return nil, fmt.Errorf("fetch verifying key: %w", err)
	}
	vkDigest, err := digestBytes(vkRaw)
	if err != nil {
		return nil, err
	}
	if manifest.VKHash != vkDigest.Blake2b256 {
		return nil, fmt.Errorf("verifying key hash mismatch: manifest %s, file %s", manifest.VKHash, vkDigest.Blake2b256)
	}
	if manifest.VerifyingKeySHA256 != "" && manifest.VerifyingKeySHA256 != vkDigest.SHA256 {
		return nil, fmt.Errorf("verifying key sha256 mismatch: manifest %s, file %s", manifest.VerifyingKeySHA256, vkDigest.SHA256)
	}
	if manifest.VerifyingKeySize > 0 && manifest.VerifyingKeySize != vkDigest.Size {
		return nil, fmt.Errorf("verifying key size mismatch: manifest %d, file %d", manifest.VerifyingKeySize, vkDigest.Size)
	}
	vk, err := prover.ReadVK(bytes.NewReader(vkRaw))
	if err != nil {
		return nil, fmt.Errorf("read verifying key: %w", err)
	}

	indexRaw, err := fetchBytes(indexURL, 1<<20)
	if err != nil {
		return nil, fmt.Errorf("fetch proving key index: %w", err)
	}
	var index streampk.Index
	if err := json.Unmarshal(indexRaw, &index); err != nil {
		return nil, fmt.Errorf("parse proving key index: %w", err)
	}
	if err := streampk.ValidateIndex(&index); err != nil {
		return nil, err
	}
	if manifest.ProvingKeySize > 0 && index.FileSize != manifest.ProvingKeySize {
		return nil, fmt.Errorf("proving key index file_size mismatch: manifest %d, index %d", manifest.ProvingKeySize, index.FileSize)
	}
	chunkManifest, err := openChunkManifestPreflight(req, manifestRaw, &manifest, vkDigest, vk, &index)
	if err != nil {
		return nil, err
	}

	source, err := streampk.OpenKeyURL(&index, pkURL, opts...)
	if err != nil {
		return nil, err
	}
	if chunkManifest != nil {
		source.SetPKSectionPlan(pkSectionPlanFromChunkManifest(chunkManifest))
	}
	return &streamingArtifacts{manifest: &manifest, verifyingKey: vk, keySource: source, chunkManifest: chunkManifest}, nil
}

func verifyOptionalKeyManifestSignature(req artifactRequest, manifestRaw []byte) error {
	if req.ManifestSignatureURL == "" && req.ManifestPublicKeyHex == "" {
		return nil
	}
	if req.ManifestSignatureURL == "" || req.ManifestPublicKeyHex == "" {
		return fmt.Errorf("manifest_sig_url and manifest_public_key_hex must be supplied together")
	}
	sigURL, err := resolveAssetURL(req.ManifestSignatureURL)
	if err != nil {
		return fmt.Errorf("manifest_sig_url: %w", err)
	}
	sigRaw, err := fetchBytes(sigURL, 4096)
	if err != nil {
		return fmt.Errorf("fetch manifest signature: %w", err)
	}
	if err := proofassets.VerifyDetachedSignature(manifestRaw, string(sigRaw), req.ManifestPublicKeyHex); err != nil {
		return fmt.Errorf("key manifest signature verification failed: %w", err)
	}
	return nil
}

func openChunkManifestPreflight(req artifactRequest, manifestRaw []byte, manifest *artifact.KeyManifest, vkDigest prover.FileDigest, vk groth16.VerifyingKey, index *streampk.Index) (*proofassets.ChunkManifest, error) {
	if req.ChunkManifestURL == "" && req.ChunkManifestSignatureURL == "" && req.ChunkManifestPublicKeyHex == "" && req.DeploymentManifestURL == "" {
		return nil, nil
	}
	if req.ChunkManifestURL == "" || req.ChunkManifestSignatureURL == "" || req.ChunkManifestPublicKeyHex == "" || req.DeploymentManifestURL == "" {
		return nil, fmt.Errorf("chunk_manifest_url, chunk_manifest_sig_url, chunk_manifest_public_key_hex, and deployment_manifest_url are required together")
	}
	if req.ManifestSignatureURL == "" || req.ManifestPublicKeyHex == "" {
		return nil, fmt.Errorf("manifest_sig_url and manifest_public_key_hex are required when chunk_manifest_url is supplied")
	}
	if req.ProofWASMURL == "" || req.WorkerJSURL == "" || req.MSMWorkerWASMURL == "" {
		return nil, fmt.Errorf("proof_wasm_url, worker_js_url, and msm_worker_wasm_url are required when chunk_manifest_url is supplied")
	}

	chunkManifestURL, err := resolveAssetURL(req.ChunkManifestURL)
	if err != nil {
		return nil, fmt.Errorf("chunk_manifest_url: %w", err)
	}
	chunkManifestRaw, err := fetchBytes(chunkManifestURL, 8<<20)
	if err != nil {
		return nil, fmt.Errorf("fetch chunk manifest: %w", err)
	}
	chunkManifestSigURL, err := resolveAssetURL(req.ChunkManifestSignatureURL)
	if err != nil {
		return nil, fmt.Errorf("chunk_manifest_sig_url: %w", err)
	}
	chunkManifestSigRaw, err := fetchBytes(chunkManifestSigURL, 4096)
	if err != nil {
		return nil, fmt.Errorf("fetch chunk manifest signature: %w", err)
	}
	if err := proofassets.VerifyDetachedSignature(chunkManifestRaw, string(chunkManifestSigRaw), req.ChunkManifestPublicKeyHex); err != nil {
		return nil, fmt.Errorf("chunk manifest signature verification failed: %w", err)
	}
	var chunkManifest proofassets.ChunkManifest
	if err := json.Unmarshal(chunkManifestRaw, &chunkManifest); err != nil {
		return nil, fmt.Errorf("parse chunk manifest: %w", err)
	}

	deploymentURL, err := resolveAssetURL(req.DeploymentManifestURL)
	if err != nil {
		return nil, fmt.Errorf("deployment_manifest_url: %w", err)
	}
	deploymentRaw, err := fetchBytes(deploymentURL, 1<<20)
	if err != nil {
		return nil, fmt.Errorf("fetch deployment manifest: %w", err)
	}
	var deployment proofassets.ReclaimDeploymentManifest
	if err := json.Unmarshal(deploymentRaw, &deployment); err != nil {
		return nil, fmt.Errorf("parse deployment manifest: %w", err)
	}

	keyManifestDigest, err := proofassets.DigestBytes(manifestRaw)
	if err != nil {
		return nil, err
	}
	cardanoVKBytes, cardanoVKFormat, err := prover.SerializeCardanoVK(vk)
	if err != nil {
		return nil, err
	}
	cardanoVKDigest := blake2b.Sum256(cardanoVKBytes)
	cardanoVKHash := "blake2b256:" + hex.EncodeToString(cardanoVKDigest[:])
	if err := proofassets.ValidateReclaimDeployment(&deployment, manifest, cardanoVKHash); err != nil {
		return nil, err
	}
	if err := proofassets.ValidateChunkManifest(&chunkManifest, proofassets.ChunkManifestExpectations{
		KeyManifest:         manifest,
		KeyManifestDigest:   keyManifestDigest,
		Deployment:          &deployment,
		CardanoVKFormat:     cardanoVKFormat,
		CardanoVKBlake2b256: cardanoVKHash,
	}); err != nil {
		return nil, err
	}
	if err := validatePinnedVKAsset(&chunkManifest, vkDigest); err != nil {
		return nil, err
	}
	if err := validatePinnedPKIndex(&chunkManifest, index); err != nil {
		return nil, err
	}
	if err := validatePinnedAssetURL(&chunkManifest, "proof-destination.wasm", req.ProofWASMURL, 64<<20); err != nil {
		return nil, err
	}
	if err := validatePinnedAssetURL(&chunkManifest, "worker.js", req.WorkerJSURL, 1<<20); err != nil {
		return nil, err
	}
	if err := validatePinnedAssetURL(&chunkManifest, "msmworker.wasm", req.MSMWorkerWASMURL, 64<<20); err != nil {
		return nil, err
	}
	msmengine.EmitTrace("measure", "chunk-manifest-preflight", map[string]any{
		"chunks":           len(chunkManifest.ProvingKey.Chunks),
		"chunk_size":       chunkManifest.ProvingKey.ChunkSize,
		"deployment_id":    chunkManifest.Coherence.DeploymentID,
		"signature_key_id": chunkManifest.SignatureKeyID,
	})
	return &chunkManifest, nil
}

func validatePinnedVKAsset(chunkManifest *proofassets.ChunkManifest, vkDigest prover.FileDigest) error {
	asset, ok := chunkManifest.Assets["ownership.vk"]
	if !ok {
		return fmt.Errorf("chunk manifest is missing ownership.vk asset pin")
	}
	if asset.SHA256 != vkDigest.SHA256 {
		return fmt.Errorf("verifying key sha256 mismatch against chunk manifest: manifest %s, file %s", asset.SHA256, vkDigest.SHA256)
	}
	if asset.Blake2b256 != vkDigest.Blake2b256 {
		return fmt.Errorf("verifying key blake2b256 mismatch against chunk manifest: manifest %s, file %s", asset.Blake2b256, vkDigest.Blake2b256)
	}
	if asset.Size != vkDigest.Size {
		return fmt.Errorf("verifying key size mismatch against chunk manifest: manifest %d, file %d", asset.Size, vkDigest.Size)
	}
	return nil
}

func validatePinnedAssetURL(chunkManifest *proofassets.ChunkManifest, name, rawURL string, maxBytes int64) error {
	asset, ok := chunkManifest.Assets[name]
	if !ok {
		return fmt.Errorf("chunk manifest is missing %s asset pin", name)
	}
	resolved, err := resolveAssetURL(rawURL)
	if err != nil {
		return fmt.Errorf("%s url: %w", name, err)
	}
	raw, err := fetchBytes(resolved, maxBytes)
	if err != nil {
		return fmt.Errorf("fetch %s: %w", name, err)
	}
	digest, err := digestBytes(raw)
	if err != nil {
		return err
	}
	if asset.SHA256 != digest.SHA256 {
		return fmt.Errorf("%s sha256 mismatch against chunk manifest: manifest %s, file %s", name, asset.SHA256, digest.SHA256)
	}
	if asset.Blake2b256 != digest.Blake2b256 {
		return fmt.Errorf("%s blake2b256 mismatch against chunk manifest: manifest %s, file %s", name, asset.Blake2b256, digest.Blake2b256)
	}
	if asset.Size != digest.Size {
		return fmt.Errorf("%s size mismatch against chunk manifest: manifest %d, file %d", name, asset.Size, digest.Size)
	}
	return nil
}

func validatePinnedPKIndex(chunkManifest *proofassets.ChunkManifest, index *streampk.Index) error {
	got, err := proofassets.ManifestIndexFromPKIndex(index)
	if err != nil {
		return err
	}
	if got.SHA256 != chunkManifest.ProvingKeyIndex.SHA256 {
		return fmt.Errorf("proving key index sha256 mismatch against chunk manifest: manifest %s, index %s", chunkManifest.ProvingKeyIndex.SHA256, got.SHA256)
	}
	if got.Blake2b256 != chunkManifest.ProvingKeyIndex.Blake2b256 {
		return fmt.Errorf("proving key index blake2b256 mismatch against chunk manifest: manifest %s, index %s", chunkManifest.ProvingKeyIndex.Blake2b256, got.Blake2b256)
	}
	return nil
}

func pkSectionPlanFromChunkManifest(chunkManifest *proofassets.ChunkManifest) *msmengine.PKSectionPlan {
	if chunkManifest == nil {
		return nil
	}
	sections := make(map[string]msmengine.PKSection, len(chunkManifest.ProvingKeyIndex.Sections))
	for _, sec := range chunkManifest.ProvingKeyIndex.Sections {
		sections[sec.Name] = msmengine.PKSection{
			Name:     sec.Name,
			Offset:   sec.Offset,
			Len:      sec.Len,
			ElemSize: sec.ElemSize,
		}
	}
	chunks := make([]msmengine.PKChunkPin, len(chunkManifest.ProvingKey.Chunks))
	for i, chunk := range chunkManifest.ProvingKey.Chunks {
		chunks[i] = msmengine.PKChunkPin{
			Index:      chunk.Index,
			Offset:     chunk.Offset,
			Size:       chunk.Size,
			Path:       chunk.Path,
			SHA256:     chunk.SHA256,
			Blake2b256: chunk.Blake2b256,
		}
	}
	return &msmengine.PKSectionPlan{
		AssetID:   chunkManifest.ProvingKey.ChunksRootBlake2b256,
		BaseURL:   chunkManifest.Transport.BaseURL,
		FileSize:  chunkManifest.Coherence.ProvingKeySize,
		ChunkSize: chunkManifest.ProvingKey.ChunkSize,
		Sections:  sections,
		Chunks:    chunks,
		VKHash:    chunkManifest.Coherence.VKHash,
	}
}

func validateDestinationManifest(manifest *artifact.KeyManifest) error {
	if manifest == nil {
		return fmt.Errorf("manifest is required")
	}
	if manifest.Schema != artifact.ManifestSchema {
		return fmt.Errorf("manifest schema %q, want %q", manifest.Schema, artifact.ManifestSchema)
	}
	if manifest.KeyVersion != prover.DefaultDestinationKeyVersion {
		return fmt.Errorf("manifest key version %q, want %q", manifest.KeyVersion, prover.DefaultDestinationKeyVersion)
	}
	if manifest.CircuitID != ownershipdest.CircuitID {
		return fmt.Errorf("manifest circuit id %q, want %q", manifest.CircuitID, ownershipdest.CircuitID)
	}
	if manifest.Curve != "BLS12-381" {
		return fmt.Errorf("manifest curve %q, want BLS12-381", manifest.Curve)
	}
	if manifest.Backend != "groth16" {
		return fmt.Errorf("manifest backend %q, want groth16", manifest.Backend)
	}
	if manifest.VKHash == "" {
		return fmt.Errorf("manifest vk_hash is required")
	}
	return nil
}

func resolveAssetURL(raw string) (string, error) {
	if raw == "" {
		return "", fmt.Errorf("is required")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if parsed.IsAbs() {
		return parsed.String(), nil
	}
	location := js.Global().Get("location")
	if location.IsUndefined() || location.IsNull() {
		return "", fmt.Errorf("relative URL %q requires browser location", raw)
	}
	base, err := url.Parse(location.Get("href").String())
	if err != nil {
		return "", fmt.Errorf("parse browser location: %w", err)
	}
	return base.ResolveReference(parsed).String(), nil
}

func fetchBytes(rawURL string, maxBytes int64) ([]byte, error) {
	resp, err := http.Get(rawURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s returned %d", rawURL, resp.StatusCode)
	}
	limited := io.LimitReader(resp.Body, maxBytes+1)
	raw, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > maxBytes {
		return nil, fmt.Errorf("GET %s exceeded %d bytes", rawURL, maxBytes)
	}
	msmengine.EmitTrace("measure", "fetch", map[string]any{
		"url":   rawURL,
		"bytes": len(raw),
	})
	return raw, nil
}

func digestBytes(raw []byte) (prover.FileDigest, error) {
	sha := sha256.Sum256(raw)
	blake, err := blake2b.New256(nil)
	if err != nil {
		return prover.FileDigest{}, fmt.Errorf("create blake2b digest: %w", err)
	}
	if _, err := blake.Write(raw); err != nil {
		return prover.FileDigest{}, err
	}
	return prover.FileDigest{
		SHA256:     "sha256:" + hex.EncodeToString(sha[:]),
		Blake2b256: "blake2b256:" + hex.EncodeToString(blake.Sum(nil)),
		Size:       int64(len(raw)),
	}, nil
}

func searchOptions(req searchRequest) ownership.SearchOptions {
	opts := ownership.SearchOptions{
		Account:    -1,
		Role:       -1,
		Index:      -1,
		MaxAccount: req.MaxAccount,
		MaxIndex:   req.MaxIndex,
	}
	if opts.MaxAccount == 0 {
		opts.MaxAccount = 9
	}
	if opts.MaxIndex == 0 {
		opts.MaxIndex = 999
	}
	if req.Account != nil {
		opts.Account = *req.Account
	}
	if req.Role != nil {
		opts.Role = *req.Role
	}
	if req.Index != nil {
		opts.Index = *req.Index
	}
	return opts
}

func progress(cb js.Value, stage string, frac float64) {
	if cb.IsUndefined() || cb.IsNull() {
		return
	}
	event := js.Global().Get("Object").New()
	event.Set("stage", stage)
	event.Set("frac", frac)
	cb.Invoke(event)
}

func toJS(value any) (js.Value, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return js.Undefined(), err
	}
	return js.Global().Get("JSON").Call("parse", string(raw)), nil
}
