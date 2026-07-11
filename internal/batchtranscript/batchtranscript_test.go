package batchtranscript

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"golang.org/x/crypto/blake2b"
)

type goldenVectors struct {
	Domain string       `json:"domain"`
	Cases  []goldenCase `json:"cases"`
}

type goldenCase struct {
	Name               string      `json:"name"`
	VKFile             string      `json:"vk_file"`
	ProofSource        proofSource `json:"proof_source"`
	PublicInputDigests []string    `json:"public_input_digests"`
	VKHash             string      `json:"vk_hash"`
	TranscriptHash     string      `json:"transcript_blake2b256"`
	R                  string      `json:"r"`
	S                  string      `json:"s"`
}

type proofSource struct {
	File   string `json:"file"`
	Rows   []int  `json:"rows"`
	Repeat int    `json:"repeat"`
}

func TestV2GoldenVectors(t *testing.T) {
	vectors, fixtureDir := loadGoldenVectors(t)
	if vectors.Domain != DomainV2 {
		t.Fatalf("domain = %q, want %q", vectors.Domain, DomainV2)
	}
	for _, vector := range vectors.Cases {
		t.Run(vector.Name, func(t *testing.T) {
			verifierKey := readHex(t, filepath.Join(fixtureDir, vector.VKFile))
			proofs := loadProofs(t, fixtureDir, vector.ProofSource)
			digests := decodeAll(t, vector.PublicInputDigests)
			gotVKHash := VKHash(verifierKey)
			if got := hex.EncodeToString(gotVKHash[:]); got != vector.VKHash {
				t.Fatalf("vk hash = %s, want %s", got, vector.VKHash)
			}
			transcript, err := BuildV2(gotVKHash[:], proofs, digests)
			if err != nil {
				t.Fatal(err)
			}
			transcriptHash := blake2b.Sum256(transcript)
			if got := hex.EncodeToString(transcriptHash[:]); got != vector.TranscriptHash {
				t.Fatalf("transcript BLAKE2b-256 = %s, want %s", got, vector.TranscriptHash)
			}
			if got := ChallengeV2(transcript).String(); got != vector.R {
				t.Fatalf("r = %s, want %s", got, vector.R)
			}
			if got := MergeChallengeV2(transcript).String(); got != vector.S {
				t.Fatalf("s = %s, want %s", got, vector.S)
			}
		})
	}
}

func TestV2TranscriptRejectsAmbiguousSlots(t *testing.T) {
	validProof := make([]byte, ProofLen)
	validDigest := make([]byte, DigestLen)
	validVKHash := make([]byte, VKHashLen)

	for _, test := range []struct {
		name    string
		vkHash  []byte
		proofs  [][]byte
		digests [][]byte
	}{
		{"short key hash width", validVKHash[:31], [][]byte{validProof}, [][]byte{validDigest}},
		{"long key hash width", append(validVKHash, 0), [][]byte{validProof}, [][]byte{validDigest}},
		{"unequal parallel lists", validVKHash, [][]byte{validProof}, nil},
		{"short proof", validVKHash, [][]byte{validProof[:ProofLen-1]}, [][]byte{validDigest}},
		{"long proof", validVKHash, [][]byte{append(validProof, 0)}, [][]byte{validDigest}},
		{"short digest", validVKHash, [][]byte{validProof}, [][]byte{validDigest[:DigestLen-1]}},
		{"long digest", validVKHash, [][]byte{validProof}, [][]byte{append(validDigest, 0)}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := BuildV2(test.vkHash, test.proofs, test.digests); err == nil {
				t.Fatal("BuildV2 accepted malformed slots")
			}
		})
	}
	if _, err := BuildV2(validVKHash, make([][]byte, MaxSlots+1), make([][]byte, MaxSlots+1)); err == nil {
		t.Fatal("BuildV2 accepted a u16-overflow slot count")
	}
}

func TestV2TranscriptChangesForEveryBoundComponent(t *testing.T) {
	vectors, fixtureDir := loadGoldenVectors(t)
	vector := vectors.Cases[1] // all-distinct-two
	verifierKey := readHex(t, filepath.Join(fixtureDir, vector.VKFile))
	vkHash := VKHash(verifierKey)
	proofs := loadProofs(t, fixtureDir, vector.ProofSource)
	digests := decodeAll(t, vector.PublicInputDigests)
	baseline, err := BuildV2(vkHash[:], proofs, digests)
	if err != nil {
		t.Fatal(err)
	}
	baselineChallenge := ChallengeV2(baseline)
	assertChanged := func(name string, candidate []byte, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if ChallengeV2(candidate).Cmp(baselineChallenge) == 0 {
			t.Fatalf("%s did not change the challenge", name)
		}
	}

	changedVKHash := append([]byte(nil), vkHash[:]...)
	changedVKHash[0] ^= 1
	transcript, err := BuildV2(changedVKHash, proofs, digests)
	assertChanged("vk hash", transcript, err)

	changedProofs := cloneBytes(proofs)
	changedProofs[0][0] ^= 1
	transcript, err = BuildV2(vkHash[:], changedProofs, digests)
	assertChanged("proof bytes", transcript, err)

	changedDigests := cloneBytes(digests)
	changedDigests[0][0] ^= 1
	transcript, err = BuildV2(vkHash[:], proofs, changedDigests)
	assertChanged("public input digest", transcript, err)

	transcript, err = BuildV2(vkHash[:], [][]byte{proofs[0]}, [][]byte{digests[0]})
	assertChanged("count", transcript, err)

	transcript, err = BuildV2(vkHash[:], [][]byte{proofs[1], proofs[0]}, [][]byte{digests[1], digests[0]})
	assertChanged("slot order", transcript, err)

	transcript, err = BuildV2(vkHash[:], proofs, [][]byte{digests[1], digests[0]})
	assertChanged("digest-only slot order", transcript, err)

	transcript, err = BuildV2(vkHash[:], [][]byte{proofs[1], proofs[0]}, digests)
	assertChanged("proof-only slot order", transcript, err)
}

func TestV2ZeroSlotFraming(t *testing.T) {
	vkHash := make([]byte, VKHashLen)
	for index := range vkHash {
		vkHash[index] = byte(index)
	}
	got, err := BuildV2(vkHash, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := make([]byte, 0, len(DomainV2)+VKHashLen+2)
	want = append(want, []byte(DomainV2)...)
	want = append(want, vkHash...)
	want = append(want, 0, 0)
	if !bytes.Equal(got, want) {
		t.Fatalf("zero-slot transcript = %x, want %x", got, want)
	}
}

func loadGoldenVectors(t *testing.T) (goldenVectors, string) {
	t.Helper()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate test source")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", ".."))
	fixtureDir := filepath.Join(root, "contracts", "ownership-verifier", "testdata")
	encoded, err := os.ReadFile(filepath.Join(fixtureDir, "zk-02-batch-transcript-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors goldenVectors
	if err := json.Unmarshal(encoded, &vectors); err != nil {
		t.Fatal(err)
	}
	return vectors, fixtureDir
}

func loadProofs(t *testing.T, fixtureDir string, source proofSource) [][]byte {
	t.Helper()
	encoded, err := os.ReadFile(filepath.Join(fixtureDir, source.File))
	if err != nil {
		t.Fatal(err)
	}
	if len(source.Rows) > 0 {
		lines := strings.Fields(string(encoded))
		proofs := make([][]byte, 0, len(source.Rows))
		for _, row := range source.Rows {
			index := row * 3
			if index+2 >= len(lines) {
				t.Fatalf("fixture row %d missing from %s", row, source.File)
			}
			proofs = append(proofs, decodeHex(t, lines[index+2]))
		}
		return proofs
	}
	proof := decodeHex(t, string(encoded))
	repeat := source.Repeat
	if repeat == 0 {
		repeat = 1
	}
	proofs := make([][]byte, repeat)
	for index := range proofs {
		proofs[index] = append([]byte(nil), proof...)
	}
	return proofs
}

func readHex(t *testing.T, path string) []byte {
	t.Helper()
	encoded, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return decodeHex(t, string(encoded))
}

func decodeAll(t *testing.T, encoded []string) [][]byte {
	t.Helper()
	decoded := make([][]byte, len(encoded))
	for index := range encoded {
		decoded[index] = decodeHex(t, encoded[index])
	}
	return decoded
}

func decodeHex(t *testing.T, encoded string) []byte {
	t.Helper()
	decoded, err := hex.DecodeString(strings.Join(strings.Fields(encoded), ""))
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}

func cloneBytes(input [][]byte) [][]byte {
	output := make([][]byte, len(input))
	for index := range input {
		output[index] = append([]byte(nil), input[index]...)
	}
	return output
}
