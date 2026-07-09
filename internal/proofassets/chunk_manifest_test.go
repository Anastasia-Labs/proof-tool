package proofassets

import (
	"bytes"
	"crypto/ed25519"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"proof-tool/internal/artifact"
)

func TestGenerateChunkManifestAndTamperGuards(t *testing.T) {
	pkPath := writeTinyPK(t)
	pkDigest, err := DigestFile(pkPath)
	if err != nil {
		t.Fatal(err)
	}
	keyManifest := &artifact.KeyManifest{
		Schema:               artifact.ManifestSchema,
		KeyVersion:           "ownership-destination-v1",
		CircuitID:            "root-ownership-destination-v1/bls12-381/groth16",
		Curve:                "BLS12-381",
		Backend:              "groth16",
		VKHash:               prefixedHash("11"),
		ProvingKeySHA256:     pkDigest.SHA256,
		ProvingKeyBlake2b256: pkDigest.Blake2b256,
		ProvingKeySize:       pkDigest.Size,
		VerifyingKeySHA256:   shaPrefixedHash("22"),
		VerifyingKeySize:     784,
		ConstraintSystemHash: prefixedHash("33"),
		SetupTranscriptHash:  prefixedHash("44"),
		CircuitSourceCommit:  strings.Repeat("a", 40),
		ProofToolVersion:     "0.1.0",
		GnarkVersion:         "v0.15.0",
		SignatureKeyID:       "release-signer",
	}
	keyManifestPath := filepath.Join(t.TempDir(), "manifest.json")
	if err := artifact.WriteJSON(keyManifestPath, keyManifest); err != nil {
		t.Fatal(err)
	}
	keyManifestDigest, err := DigestFile(keyManifestPath)
	if err != nil {
		t.Fatal(err)
	}
	cardanoVKHash := prefixedHash("55")
	deployment := testDeploymentManifest(keyManifest, cardanoVKHash)
	outDir := filepath.Join(t.TempDir(), "assets")

	manifest, err := GenerateChunkManifest(ChunkManifestOptions{
		KeyManifest:         keyManifest,
		KeyManifestDigest:   keyManifestDigest,
		Deployment:          deployment,
		ProvingKeyPath:      pkPath,
		ChunkOutDir:         outDir,
		ChunkSize:           257,
		Release:             "proof-assets-test",
		Profile:             "mainnet-single-destination",
		BaseURL:             "https://assets.example/proof-assets/test",
		SignatureKeyID:      "chunk-signer",
		GeneratedAt:         time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC),
		CardanoVKFormat:     "groth16-bls12-381-bsb22",
		CardanoVKBlake2b256: cardanoVKHash,
		Assets: map[string]AssetPin{
			"ownership.vk": {
				Path:       "ownership.vk",
				Size:       784,
				SHA256:     shaPrefixedHash("66"),
				Blake2b256: prefixedHash("77"),
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	expect := ChunkManifestExpectations{
		KeyManifest:         keyManifest,
		KeyManifestDigest:   keyManifestDigest,
		Deployment:          deployment,
		CardanoVKFormat:     "groth16-bls12-381-bsb22",
		CardanoVKBlake2b256: cardanoVKHash,
	}
	if err := ValidateChunkManifest(manifest, expect); err != nil {
		t.Fatal(err)
	}
	if err := VerifyChunkFiles(manifest, outDir); err != nil {
		t.Fatal(err)
	}
	if len(manifest.ProvingKey.Chunks) < 2 {
		t.Fatalf("expected multiple chunks, got %d", len(manifest.ProvingKey.Chunks))
	}

	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := MarshalChunkManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	signature := SignDetached(raw, privateKey)
	if err := VerifyDetachedSignature(raw, signature, hexKey(publicKey)); err != nil {
		t.Fatal(err)
	}
	tamperedRaw := append([]byte(nil), raw...)
	tamperedRaw[len(tamperedRaw)/2] ^= 1
	if err := VerifyDetachedSignature(tamperedRaw, signature, hexKey(publicKey)); err == nil {
		t.Fatal("tampered signature bytes verified")
	}

	t.Run("chunk digest tamper fails", func(t *testing.T) {
		tampered := cloneChunkManifest(t, manifest)
		tampered.ProvingKey.Chunks[0].Blake2b256 = prefixedHash("88")
		if err := ValidateChunkManifest(tampered, expect); err == nil || !strings.Contains(err.Error(), "chunks_root_blake2b256") {
			t.Fatalf("expected chunk root failure, got %v", err)
		}
	})
	t.Run("section offset tamper fails", func(t *testing.T) {
		tampered := cloneChunkManifest(t, manifest)
		tampered.ProvingKeyIndex.Sections[0].Offset += int64(G1RawBytes)
		if err := ValidateChunkManifest(tampered, expect); err == nil || !strings.Contains(err.Error(), "index") {
			t.Fatalf("expected index failure, got %v", err)
		}
	})
	t.Run("vk hash tamper fails", func(t *testing.T) {
		tampered := cloneChunkManifest(t, manifest)
		tampered.Coherence.VKHash = prefixedHash("99")
		if err := ValidateChunkManifest(tampered, expect); err == nil || !strings.Contains(err.Error(), "vk_hash") {
			t.Fatalf("expected vk_hash failure, got %v", err)
		}
	})
	t.Run("deployment id tamper fails", func(t *testing.T) {
		tampered := cloneChunkManifest(t, manifest)
		tampered.Coherence.DeploymentID = "mainnet:wrong"
		if err := ValidateChunkManifest(tampered, expect); err == nil || !strings.Contains(err.Error(), "deployment id") {
			t.Fatalf("expected deployment id failure, got %v", err)
		}
	})
}

func testDeploymentManifest(keyManifest *artifact.KeyManifest, cardanoVKHash string) *ReclaimDeploymentManifest {
	var deployment ReclaimDeploymentManifest
	deployment.Schema = ReclaimDeploymentSchema
	deployment.DeploymentID = "mainnet:" + strings.Repeat("b", 56) + ":" + strings.Repeat("a", 40)
	deployment.SourceCommit = strings.Repeat("a", 40)
	deployment.ReclaimGlobal.VerifierVKHash = keyManifest.VKHash
	deployment.ReclaimGlobal.ProofProfile = "single-destination"
	deployment.Proof.CircuitID = keyManifest.CircuitID
	deployment.Proof.KeyVersion = keyManifest.KeyVersion
	deployment.Proof.DestinationAddressEncoding = "destination-address-v1"
	deployment.Proof.VKHash = keyManifest.VKHash
	deployment.Proof.CardanoVKBlake2b256 = cardanoVKHash
	return &deployment
}

func cloneChunkManifest(t *testing.T, manifest *ChunkManifest) *ChunkManifest {
	t.Helper()
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	var out ChunkManifest
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return &out
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

func prefixedHash(byteHex string) string {
	return "blake2b256:" + strings.Repeat(byteHex, 32)
}

func shaPrefixedHash(byteHex string) string {
	return "sha256:" + strings.Repeat(byteHex, 32)
}

func hexKey(key ed25519.PublicKey) string {
	const hexDigits = "0123456789abcdef"
	out := make([]byte, len(key)*2)
	for i, b := range key {
		out[i*2] = hexDigits[b>>4]
		out[i*2+1] = hexDigits[b&0x0f]
	}
	return string(out)
}
