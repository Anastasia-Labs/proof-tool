package streampk

import (
	"bytes"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileAndHTTPRangeSectionsMatch(t *testing.T) {
	path := writeTinyPK(t)
	fileSource, err := OpenFile(path)
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	defer func() { _ = fileSource.Close() }()

	server := httptest.NewServer(http.FileServer(http.Dir(filepath.Dir(path))))
	defer server.Close()

	httpSource, err := OpenURL(fileSource.Index(), server.URL+"/"+filepath.Base(path))
	if err != nil {
		t.Fatalf("OpenURL: %v", err)
	}
	defer func() { _ = httpSource.Close() }()

	for _, name := range []string{"A", "B", "Z", "K", "G2B", "Basis", "BasisExpSigma"} {
		want, err := fileSource.SectionBytes(name, -1)
		if err != nil {
			t.Fatalf("file SectionBytes(%s): %v", name, err)
		}
		got, err := httpSource.SectionBytes(name, -1)
		if err != nil {
			t.Fatalf("http SectionBytes(%s): %v", name, err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("section %s mismatch", name)
		}
	}
}

func TestSectionRange(t *testing.T) {
	source, err := OpenFile(writeTinyPK(t))
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	defer func() { _ = source.Close() }()

	all, err := source.SectionBytes("A", -1)
	if err != nil {
		t.Fatalf("SectionBytes: %v", err)
	}
	part, err := source.SectionRange("A", 1, 2)
	if err != nil {
		t.Fatalf("SectionRange: %v", err)
	}
	if !bytes.Equal(part, all[G1RawBytes:2*G1RawBytes]) {
		t.Fatalf("range bytes mismatch")
	}
}

func TestTruncatedRangeFails(t *testing.T) {
	path := writeTinyPK(t)
	source, err := OpenFile(path)
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	defer func() { _ = source.Close() }()
	idx := source.Index()

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Range", "bytes 0-0/1")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(raw[:1])
	}))
	defer server.Close()

	httpSource, err := OpenURL(idx, server.URL)
	if err != nil {
		t.Fatalf("OpenURL: %v", err)
	}
	_, err = httpSource.SectionBytes("A", -1)
	if err == nil || !strings.Contains(err.Error(), "unexpected EOF") {
		t.Fatalf("expected truncated range failure, got %v", err)
	}
}

func TestWrongIndexFails(t *testing.T) {
	source, err := OpenFile(writeTinyPK(t))
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	defer func() { _ = source.Close() }()
	idx := *source.Index()
	idx.Sections = map[string]Section{}
	for k, v := range source.Index().Sections {
		idx.Sections[k] = v
	}
	sec := idx.Sections["A"]
	sec.Len++
	idx.Sections["A"] = sec
	if err := ValidateIndex(&idx); err == nil {
		t.Fatalf("expected invalid index")
	}
}

func TestMissingSectionFails(t *testing.T) {
	source, err := OpenFile(writeTinyPK(t))
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	defer func() { _ = source.Close() }()
	_, err = source.SectionBytes("missing", -1)
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("expected missing section failure, got %v", err)
	}
}

func writeTinyPK(t *testing.T) string {
	t.Helper()
	var buf bytes.Buffer
	buf.Write(make([]byte, DomainHeaderBytes))
	binary.BigEndian.PutUint64(buf.Bytes()[:8], 16)
	buf.Write(bytes.Repeat([]byte{0xa1}, 3*G1RawBytes))
	for _, marker := range []byte{0x01, 0x02, 0x03, 0x04} {
		writeVector(&buf, 3, G1RawBytes, marker)
	}
	buf.Write(bytes.Repeat([]byte{0xb1}, 2*G2RawBytes))
	writeVector(&buf, 2, G2RawBytes, 0x05)
	writeUint64(&buf, 4)
	writeUint64(&buf, 0)
	writeUint64(&buf, 0)
	buf.Write([]byte{0, 1, 0, 1})
	buf.Write([]byte{1, 0, 1, 0})
	writeUint32(&buf, 1)
	writeVector(&buf, 2, G1RawBytes, 0x06)
	writeVector(&buf, 2, G1RawBytes, 0x07)

	path := filepath.Join(t.TempDir(), "ownership.pk")
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeVector(buf *bytes.Buffer, count int, elemSize int, marker byte) {
	writeUint32(buf, uint32(count))
	for i := 0; i < count; i++ {
		buf.Write(bytes.Repeat([]byte{marker + byte(i)}, elemSize))
	}
}

func writeUint32(buf *bytes.Buffer, value uint32) {
	var tmp [4]byte
	binary.BigEndian.PutUint32(tmp[:], value)
	buf.Write(tmp[:])
}

func writeUint64(buf *bytes.Buffer, value uint64) {
	var tmp [8]byte
	binary.BigEndian.PutUint64(tmp[:], value)
	buf.Write(tmp[:])
}
