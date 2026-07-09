package proofassets

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
)

const (
	DomainHeaderBytes = 169
	G1RawBytes        = 96
	G2RawBytes        = 192
)

type PKSection struct {
	Name     string `json:"name"`
	Offset   int64  `json:"offset"`
	Len      int64  `json:"len"`
	ElemSize int    `json:"elem_size"`
}

type PKIndex struct {
	Sections          map[string]PKSection `json:"sections"`
	DomainCardinality uint64               `json:"domain_cardinality"`
	NbWires           uint64               `json:"nb_wires"`
	NbInfinityA       uint64               `json:"nb_infinity_a"`
	NbInfinityB       uint64               `json:"nb_infinity_b"`
	NbCommitmentKeys  uint32               `json:"nb_commitment_keys"`
	FileSize          int64                `json:"file_size"`
}

func BuildPKIndex(path string) (*PKIndex, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open proving key %s: %w", path, err)
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat proving key %s: %w", path, err)
	}

	idx := &PKIndex{
		Sections: make(map[string]PKSection),
		FileSize: stat.Size(),
	}

	var domain [DomainHeaderBytes]byte
	if _, err := io.ReadFull(f, domain[:]); err != nil {
		return nil, fmt.Errorf("read domain header: %w", err)
	}
	idx.DomainCardinality = binary.BigEndian.Uint64(domain[:8])

	if _, err := f.Seek(3*G1RawBytes, io.SeekCurrent); err != nil {
		return nil, fmt.Errorf("seek past G1 singletons: %w", err)
	}

	for _, name := range []string{"A", "B", "Z", "K"} {
		sec, err := readSection(f, name, G1RawBytes)
		if err != nil {
			return nil, fmt.Errorf("G1.%s: %w", name, err)
		}
		idx.Sections[name] = sec
	}

	if _, err := f.Seek(2*G2RawBytes, io.SeekCurrent); err != nil {
		return nil, fmt.Errorf("seek past G2 singletons: %w", err)
	}

	sec, err := readSection(f, "G2B", G2RawBytes)
	if err != nil {
		return nil, fmt.Errorf("G2.B: %w", err)
	}
	idx.Sections["G2B"] = sec

	idx.NbWires, err = readBEUint64(f)
	if err != nil {
		return nil, fmt.Errorf("read nbWires: %w", err)
	}
	idx.NbInfinityA, err = readBEUint64(f)
	if err != nil {
		return nil, fmt.Errorf("read NbInfinityA: %w", err)
	}
	idx.NbInfinityB, err = readBEUint64(f)
	if err != nil {
		return nil, fmt.Errorf("read NbInfinityB: %w", err)
	}
	if idx.NbWires > math.MaxInt64/2 {
		return nil, fmt.Errorf("nbWires %d would overflow int64", idx.NbWires)
	}
	if _, err := f.Seek(int64(idx.NbWires)*2, io.SeekCurrent); err != nil {
		return nil, fmt.Errorf("seek past infinity bitmaps: %w", err)
	}

	idx.NbCommitmentKeys, err = readBEUint32(f)
	if err != nil {
		return nil, fmt.Errorf("read nbCommitmentKeys: %w", err)
	}
	for i := 0; i < int(idx.NbCommitmentKeys); i++ {
		basisName := "Basis"
		sigmaName := "BasisExpSigma"
		if i > 0 {
			basisName = fmt.Sprintf("Basis_%d", i)
			sigmaName = fmt.Sprintf("BasisExpSigma_%d", i)
		}
		basis, err := readSection(f, basisName, G1RawBytes)
		if err != nil {
			return nil, fmt.Errorf("commitment key %d Basis: %w", i, err)
		}
		idx.Sections[basisName] = basis
		sigma, err := readSection(f, sigmaName, G1RawBytes)
		if err != nil {
			return nil, fmt.Errorf("commitment key %d BasisExpSigma: %w", i, err)
		}
		idx.Sections[sigmaName] = sigma
	}

	if off, err := f.Seek(0, io.SeekCurrent); err != nil {
		return nil, fmt.Errorf("read final offset: %w", err)
	} else if off != stat.Size() {
		return nil, fmt.Errorf("index ended at byte %d, file size is %d", off, stat.Size())
	}
	return idx, nil
}

func ValidatePKIndex(idx *PKIndex) error {
	if idx == nil {
		return fmt.Errorf("index is required")
	}
	if idx.FileSize <= 0 {
		return fmt.Errorf("index file_size is required")
	}
	required := []string{"A", "B", "Z", "K", "G2B"}
	for _, name := range required {
		if _, ok := idx.Sections[name]; !ok {
			return fmt.Errorf("index missing section %q", name)
		}
	}
	for name, sec := range idx.Sections {
		if sec.Name == "" {
			return fmt.Errorf("section %q has empty name", name)
		}
		if sec.Name != name {
			return fmt.Errorf("section map key %q does not match name %q", name, sec.Name)
		}
		if sec.Offset < 0 || sec.Len < 0 {
			return fmt.Errorf("section %q has negative offset or length", name)
		}
		if sec.ElemSize != G1RawBytes && sec.ElemSize != G2RawBytes {
			return fmt.Errorf("section %q has elem_size %d", name, sec.ElemSize)
		}
		if sec.Len%int64(sec.ElemSize) != 0 {
			return fmt.Errorf("section %q length %d is not divisible by elem_size %d", name, sec.Len, sec.ElemSize)
		}
		if sec.Offset+sec.Len > idx.FileSize {
			return fmt.Errorf("section %q exceeds file size", name)
		}
	}
	return nil
}

func WritePKIndex(path string, idx *PKIndex) error {
	if err := ValidatePKIndex(idx); err != nil {
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

func ReadPKIndex(path string) (*PKIndex, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read index %s: %w", path, err)
	}
	var idx PKIndex
	if err := json.Unmarshal(raw, &idx); err != nil {
		return nil, fmt.Errorf("parse index %s: %w", path, err)
	}
	if err := ValidatePKIndex(&idx); err != nil {
		return nil, err
	}
	return &idx, nil
}

func readSection(rs io.ReadSeeker, name string, elemSize int) (PKSection, error) {
	count, err := readBEUint32(rs)
	if err != nil {
		return PKSection{}, err
	}
	off, err := rs.Seek(0, io.SeekCurrent)
	if err != nil {
		return PKSection{}, err
	}
	payloadLen := int64(count) * int64(elemSize)
	if _, err := rs.Seek(payloadLen, io.SeekCurrent); err != nil {
		return PKSection{}, err
	}
	return PKSection{Name: name, Offset: off, Len: payloadLen, ElemSize: elemSize}, nil
}

func readBEUint32(r io.Reader) (uint32, error) {
	var buf [4]byte
	if _, err := io.ReadFull(r, buf[:]); err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint32(buf[:]), nil
}

func readBEUint64(r io.Reader) (uint64, error) {
	var buf [8]byte
	if _, err := io.ReadFull(r, buf[:]); err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint64(buf[:]), nil
}
