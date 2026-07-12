package msmengine

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"

	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"
)

const intermediateDigestSchema = "wasm-prover-intermediate-digests-v1"

var requiredDigestStages = [...]string{"Basis", "BasisExpSigma", "G2B", "A", "B", "Z", "K"}

type IntermediateStageDigests struct {
	ScalarInputs string `json:"scalar_inputs"`
	PointInputs  string `json:"point_inputs"`
	Result       string `json:"result"`
}

type IntermediateDigestReport struct {
	Schema string                              `json:"schema"`
	Stages map[string]IntermediateStageDigests `json:"stages"`
}

type DigestRecorder struct {
	mu     sync.Mutex
	stages map[string]IntermediateStageDigests
}

func NewDigestRecorder() *DigestRecorder {
	return &DigestRecorder{stages: make(map[string]IntermediateStageDigests, len(requiredDigestStages))}
}

func (r *DigestRecorder) Snapshot() (IntermediateDigestReport, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	stages := make(map[string]IntermediateStageDigests, len(requiredDigestStages))
	for _, stage := range requiredDigestStages {
		record, ok := r.stages[stage]
		if !ok {
			return IntermediateDigestReport{}, fmt.Errorf("missing intermediate digest stage %s", stage)
		}
		stages[stage] = record
	}
	return IntermediateDigestReport{Schema: intermediateDigestSchema, Stages: stages}, nil
}

func (r *DigestRecorder) record(stage string, value IntermediateStageDigests) error {
	stage = normalizeDigestStage(stage)
	if !isRequiredDigestStage(stage) {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.stages[stage]; exists {
		return fmt.Errorf("duplicate intermediate digest stage %s", stage)
	}
	r.stages[stage] = value
	return nil
}

func WrapWithDigestRecorder(engine MSMEngine, recorder *DigestRecorder) MSMEngine {
	base := &digestingEngine{engine: engine, recorder: recorder}
	if sectionEngine, ok := engine.(PKSectionEngine); ok {
		section := &digestingSectionEngine{digestingEngine: base, sectionEngine: sectionEngine}
		if async, ok := engine.(AsyncPKSectionEngine); ok {
			return &digestingAsyncSectionEngine{digestingSectionEngine: section, async: async}
		}
		return section
	}
	return base
}

type digestSectionHandle struct {
	inner   SectionHandle
	plan    *PKSectionPlan
	section string
	n       int
	scalars []fr.Element
	g2      bool
}

func (*digestSectionHandle) SectionHandle() {}

type digestingAsyncSectionEngine struct {
	*digestingSectionEngine
	async AsyncPKSectionEngine
}

func (e *digestingAsyncSectionEngine) DispatchG1Section(plan *PKSectionPlan, section string, n int, scalars []fr.Element, prog ProgressFn) (SectionHandle, error) {
	inner, err := e.async.DispatchG1Section(plan, section, n, scalars, prog)
	if err != nil {
		return nil, err
	}
	return &digestSectionHandle{inner: inner, plan: plan, section: section, n: n, scalars: scalars}, nil
}

func (e *digestingAsyncSectionEngine) DispatchG2Section(plan *PKSectionPlan, section string, n int, scalars []fr.Element, prog ProgressFn) (SectionHandle, error) {
	inner, err := e.async.DispatchG2Section(plan, section, n, scalars, prog)
	if err != nil {
		return nil, err
	}
	return &digestSectionHandle{inner: inner, plan: plan, section: section, n: n, scalars: scalars, g2: true}, nil
}

func (e *digestingAsyncSectionEngine) CollectG1Section(dst *bls12381.G1Jac, handle SectionHandle) error {
	h, ok := handle.(*digestSectionHandle)
	if !ok || h.g2 {
		return failClosed("async-msm-handle-group", fmt.Errorf("digest G1 collect received incompatible handle"))
	}
	if err := e.async.CollectG1Section(dst, h.inner); err != nil {
		return err
	}
	var affine bls12381.G1Affine
	affine.FromJacobian(dst)
	return e.recordSection(h.plan, h.section, h.n, h.scalars, affine.Marshal())
}

func (e *digestingAsyncSectionEngine) CollectG2Section(dst *bls12381.G2Jac, handle SectionHandle) error {
	h, ok := handle.(*digestSectionHandle)
	if !ok || !h.g2 {
		return failClosed("async-msm-handle-group", fmt.Errorf("digest G2 collect received incompatible handle"))
	}
	if err := e.async.CollectG2Section(dst, h.inner); err != nil {
		return err
	}
	var affine bls12381.G2Affine
	affine.FromJacobian(dst)
	return e.recordSection(h.plan, h.section, h.n, h.scalars, affine.Marshal())
}

func (e *digestingAsyncSectionEngine) CancelOutstanding(cause error) {
	e.async.CancelOutstanding(cause)
}

type digestingEngine struct {
	engine   MSMEngine
	recorder *DigestRecorder
}

func (e *digestingEngine) Name() string { return e.engine.Name() }
func (e *digestingEngine) Close() error { return nil }

func (e *digestingEngine) MSMG1(dst *bls12381.G1Jac, points []bls12381.G1Affine, scalars []fr.Element, prog ProgressFn) error {
	return e.engine.MSMG1(dst, points, scalars, prog)
}

func (e *digestingEngine) MSMG2(dst *bls12381.G2Jac, points []bls12381.G2Affine, scalars []fr.Element, prog ProgressFn) error {
	return e.engine.MSMG2(dst, points, scalars, prog)
}

func (e *digestingEngine) MSMG1Ranged(dst *bls12381.G1Jac, n int, fetch FetchG1, scalars []fr.Element, prog ProgressFn) error {
	return e.engine.MSMG1Ranged(dst, n, fetch, scalars, prog)
}

func (e *digestingEngine) MSMG2Ranged(dst *bls12381.G2Jac, n int, fetch FetchG2, scalars []fr.Element, prog ProgressFn) error {
	return e.engine.MSMG2Ranged(dst, n, fetch, scalars, prog)
}

type digestingSectionEngine struct {
	*digestingEngine
	sectionEngine PKSectionEngine
}

func (e *digestingSectionEngine) MSMG1Section(dst *bls12381.G1Jac, plan *PKSectionPlan, section string, n int, scalars []fr.Element, prog ProgressFn) error {
	if err := e.sectionEngine.MSMG1Section(dst, plan, section, n, scalars, prog); err != nil {
		return err
	}
	var affine bls12381.G1Affine
	affine.FromJacobian(dst)
	return e.recordSection(plan, section, n, scalars, affine.Marshal())
}

func (e *digestingSectionEngine) MSMG2Section(dst *bls12381.G2Jac, plan *PKSectionPlan, section string, n int, scalars []fr.Element, prog ProgressFn) error {
	if err := e.sectionEngine.MSMG2Section(dst, plan, section, n, scalars, prog); err != nil {
		return err
	}
	var affine bls12381.G2Affine
	affine.FromJacobian(dst)
	return e.recordSection(plan, section, n, scalars, affine.Marshal())
}

func (e *digestingSectionEngine) recordSection(plan *PKSectionPlan, section string, n int, scalars []fr.Element, result []byte) error {
	points, err := sectionPointCommitment(plan, section, n)
	if err != nil {
		return err
	}
	stage := normalizeDigestStage(section)
	return e.recorder.record(stage, IntermediateStageDigests{
		ScalarInputs: digestIntermediate(stage, "scalar_inputs", marshalDigestScalars(scalars)),
		PointInputs:  digestIntermediate(stage, "point_inputs", points),
		Result:       digestIntermediate(stage, "result", result),
	})
}

func sectionPointCommitment(plan *PKSectionPlan, section string, n int) ([]byte, error) {
	if plan == nil {
		return nil, fmt.Errorf("intermediate point digest requires a PK section plan")
	}
	entry, ok := plan.Sections[section]
	if !ok {
		return nil, fmt.Errorf("intermediate point digest section %q is missing", section)
	}
	if n < 0 || int64(n)*int64(entry.ElemSize) > entry.Len {
		return nil, fmt.Errorf("intermediate point digest section %q length %d is invalid", section, n)
	}
	start := entry.Offset
	end := start + int64(n)*int64(entry.ElemSize)
	chunks := append([]PKChunkPin(nil), plan.Chunks...)
	sort.Slice(chunks, func(i, j int) bool { return chunks[i].Index < chunks[j].Index })
	buf := make([]byte, 0, 512)
	buf = appendDigestString(buf, plan.AssetID)
	buf = appendDigestString(buf, section)
	buf = binary.BigEndian.AppendUint64(buf, uint64(entry.Offset))
	buf = binary.BigEndian.AppendUint64(buf, uint64(entry.ElemSize))
	buf = binary.BigEndian.AppendUint64(buf, uint64(n))
	for _, chunk := range chunks {
		chunkStart, chunkEnd := chunk.Offset, chunk.Offset+chunk.Size
		if chunkEnd <= start || chunkStart >= end {
			continue
		}
		buf = binary.BigEndian.AppendUint64(buf, uint64(chunk.Index))
		useStart := start
		if chunkStart > useStart {
			useStart = chunkStart
		}
		useEnd := end
		if chunkEnd < useEnd {
			useEnd = chunkEnd
		}
		buf = binary.BigEndian.AppendUint64(buf, uint64(useStart-chunkStart))
		buf = binary.BigEndian.AppendUint64(buf, uint64(useEnd-chunkStart))
		buf = appendDigestString(buf, chunk.SHA256)
		buf = appendDigestString(buf, chunk.Blake2b256)
	}
	return buf, nil
}

func marshalDigestScalars(scalars []fr.Element) []byte {
	out := make([]byte, 0, len(scalars)*fr.Bytes)
	for i := range scalars {
		out = append(out, scalars[i].Marshal()...)
	}
	return out
}

func digestIntermediate(stage, field string, value []byte) string {
	h := sha256.New()
	h.Write([]byte(intermediateDigestSchema))
	h.Write([]byte{0})
	h.Write([]byte(stage))
	h.Write([]byte{0})
	h.Write([]byte(field))
	h.Write([]byte{0})
	var length [8]byte
	binary.BigEndian.PutUint64(length[:], uint64(len(value)))
	h.Write(length[:])
	h.Write(value)
	return "sha256:" + hex.EncodeToString(h.Sum(nil))
}

func appendDigestString(dst []byte, value string) []byte {
	dst = binary.BigEndian.AppendUint64(dst, uint64(len(value)))
	return append(dst, value...)
}

func normalizeDigestStage(stage string) string {
	if before, _, ok := strings.Cut(stage, "_"); ok {
		return before
	}
	return stage
}

func isRequiredDigestStage(stage string) bool {
	for _, required := range requiredDigestStages {
		if stage == required {
			return true
		}
	}
	return false
}
