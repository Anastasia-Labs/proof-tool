package streampk

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync/atomic"
)

type Source struct {
	idx    *Index
	ra     io.ReaderAt
	closer io.Closer
}

func OpenFile(path string) (*Source, error) {
	idx, err := BuildIndex(path)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open proving key %s: %w", path, err)
	}
	if err := ValidateIndex(idx); err != nil {
		f.Close()
		return nil, err
	}
	return &Source{idx: idx, ra: f, closer: f}, nil
}

func OpenURL(idx *Index, url string) (*Source, error) {
	if err := ValidateIndex(idx); err != nil {
		return nil, err
	}
	return &Source{idx: idx, ra: &httpRangeAt{client: httpDefaultClient(), url: url}, closer: io.NopCloser(bytes.NewReader(nil))}, nil
}

func (s *Source) Close() error {
	if s == nil || s.closer == nil {
		return nil
	}
	return s.closer.Close()
}

func (s *Source) Index() *Index {
	return s.idx
}

func (s *Source) SectionBytes(name string, maxBytes int64) ([]byte, error) {
	if s == nil {
		return nil, fmt.Errorf("source is nil")
	}
	sec, ok := s.idx.Sections[name]
	if !ok {
		return nil, fmt.Errorf("section %q not found", name)
	}
	if maxBytes >= 0 && sec.Len > maxBytes {
		return nil, fmt.Errorf("section %q is %d bytes, max is %d", name, sec.Len, maxBytes)
	}
	out := make([]byte, sec.Len)
	if _, err := s.ra.ReadAt(out, sec.Offset); err != nil {
		return nil, fmt.Errorf("read section %q: %w", name, err)
	}
	return out, nil
}

func (s *Source) SectionRange(name string, lo, hi int) ([]byte, error) {
	if s == nil {
		return nil, fmt.Errorf("source is nil")
	}
	sec, ok := s.idx.Sections[name]
	if !ok {
		return nil, fmt.Errorf("section %q not found", name)
	}
	total := int(sec.Len) / sec.ElemSize
	if lo < 0 || hi < lo || hi > total {
		return nil, fmt.Errorf("section range %q [%d,%d) out of bounds (len=%d)", name, lo, hi, total)
	}
	out := make([]byte, (hi-lo)*sec.ElemSize)
	if len(out) == 0 {
		return out, nil
	}
	off := sec.Offset + int64(lo*sec.ElemSize)
	if _, err := s.ra.ReadAt(out, off); err != nil {
		return nil, fmt.Errorf("read section range %q: %w", name, err)
	}
	return out, nil
}

func WriteIndex(path string, idx *Index) error {
	if err := ValidateIndex(idx); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal index: %w", err)
	}
	raw = append(raw, '\n')
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return fmt.Errorf("write index %s: %w", path, err)
	}
	return nil
}

func ReadIndex(path string) (*Index, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read index %s: %w", path, err)
	}
	var idx Index
	if err := json.Unmarshal(raw, &idx); err != nil {
		return nil, fmt.Errorf("parse index %s: %w", path, err)
	}
	if err := ValidateIndex(&idx); err != nil {
		return nil, err
	}
	return &idx, nil
}

type httpRangeAt struct {
	client *http.Client
	url    string
}

type RangeStats struct {
	Requests uint64 `json:"requests"`
	Bytes    uint64 `json:"bytes"`
	StatusOK uint64 `json:"status_200"`
	StatusPC uint64 `json:"status_206"`
	Errors   uint64 `json:"errors"`
}

var rangeStats atomicStats

type atomicStats struct {
	requests atomic.Uint64
	bytes    atomic.Uint64
	statusOK atomic.Uint64
	statusPC atomic.Uint64
	errors   atomic.Uint64
}

func ResetRangeStats() {
	rangeStats.requests.Store(0)
	rangeStats.bytes.Store(0)
	rangeStats.statusOK.Store(0)
	rangeStats.statusPC.Store(0)
	rangeStats.errors.Store(0)
}

func RangeStatsSnapshot() RangeStats {
	return RangeStats{
		Requests: rangeStats.requests.Load(),
		Bytes:    rangeStats.bytes.Load(),
		StatusOK: rangeStats.statusOK.Load(),
		StatusPC: rangeStats.statusPC.Load(),
		Errors:   rangeStats.errors.Load(),
	}
}

func httpDefaultClient() *http.Client {
	return http.DefaultClient
}

func (h *httpRangeAt) ReadAt(p []byte, off int64) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	rangeStats.requests.Add(1)
	rangeStats.bytes.Add(uint64(len(p)))
	end := off + int64(len(p)) - 1
	req, err := http.NewRequest("GET", h.url, nil)
	if err != nil {
		rangeStats.errors.Add(1)
		return 0, fmt.Errorf("new range request: %w", err)
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", off, end))
	resp, err := h.client.Do(req)
	if err != nil {
		rangeStats.errors.Add(1)
		return 0, fmt.Errorf("range request: %w", err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusPartialContent:
		rangeStats.statusPC.Add(1)
		return io.ReadFull(resp.Body, p)
	case http.StatusOK:
		rangeStats.statusOK.Add(1)
		if _, err := io.CopyN(io.Discard, resp.Body, off); err != nil {
			rangeStats.errors.Add(1)
			return 0, fmt.Errorf("discard prefix from 200 response: %w", err)
		}
		return io.ReadFull(resp.Body, p)
	default:
		rangeStats.errors.Add(1)
		return 0, fmt.Errorf("range request status %d", resp.StatusCode)
	}
}

func PrefixLength(n int) []byte {
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], uint32(n))
	return prefix[:]
}
