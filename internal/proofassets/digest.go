package proofassets

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash"
	"io"
	"os"

	"golang.org/x/crypto/blake2b"
)

type FileDigest struct {
	SHA256     string `json:"sha256"`
	Blake2b256 string `json:"blake2b256"`
	Size       int64  `json:"size"`
}

func DigestFile(path string) (FileDigest, error) {
	f, err := os.Open(path)
	if err != nil {
		return FileDigest{}, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	digest, err := DigestReader(f)
	if err != nil {
		return FileDigest{}, fmt.Errorf("digest %s: %w", path, err)
	}
	return digest, nil
}

func DigestBytes(raw []byte) (FileDigest, error) {
	return digestFromReader(bytes.NewReader(raw))
}

func DigestReader(r io.Reader) (FileDigest, error) {
	return digestFromReader(r)
}

func digestFromReader(r io.Reader) (FileDigest, error) {
	sha := sha256.New()
	blake, err := blake2b.New256(nil)
	if err != nil {
		return FileDigest{}, fmt.Errorf("create blake2b digest: %w", err)
	}
	size, err := copyToHashes(r, sha, blake)
	if err != nil {
		return FileDigest{}, err
	}
	return FileDigest{
		SHA256:     "sha256:" + hex.EncodeToString(sha.Sum(nil)),
		Blake2b256: "blake2b256:" + hex.EncodeToString(blake.Sum(nil)),
		Size:       size,
	}, nil
}

func copyToHashes(r io.Reader, hashes ...hash.Hash) (int64, error) {
	writers := make([]io.Writer, 0, len(hashes))
	for _, h := range hashes {
		writers = append(writers, h)
	}
	return io.Copy(io.MultiWriter(writers...), r)
}
