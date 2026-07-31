// Command sign-ed25519-file creates a deterministic detached Ed25519 signature
// for an exact regular file using an existing private key. It never creates a
// key and rejects permissive secret-key modes.
package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"runtime"
	"strings"
)

func main() {
	input := flag.String("input", "", "exact file to sign")
	privateKeyPath := flag.String("private-key", "", "existing Ed25519 seed or private key in hex")
	signatureOut := flag.String("signature-out", "", "fresh detached signature output")
	publicKeyOut := flag.String("public-key-out", "", "fresh public-key output")
	flag.Parse()
	if flag.NArg() != 0 || *input == "" || *privateKeyPath == "" ||
		*signatureOut == "" || *publicKeyOut == "" || *signatureOut == *publicKeyOut {
		fatal(errors.New("usage: sign-ed25519-file --input FILE --private-key KEY --signature-out FILE --public-key-out FILE"))
	}
	data, err := readRegular(*input, false)
	if err != nil {
		fatal(err)
	}
	keyHex, err := readRegular(*privateKeyPath, true)
	if err != nil {
		fatal(err)
	}
	defer clear(keyHex)
	raw, err := hex.DecodeString(strings.TrimSpace(string(keyHex)))
	if err != nil {
		fatal(err)
	}
	defer clear(raw)
	var privateKey ed25519.PrivateKey
	switch len(raw) {
	case ed25519.SeedSize:
		privateKey = ed25519.NewKeyFromSeed(raw)
	case ed25519.PrivateKeySize:
		privateKey = ed25519.NewKeyFromSeed(raw[:ed25519.SeedSize])
		if !bytes.Equal(raw, privateKey) {
			fatal(errors.New("Ed25519 private-key public half does not match its seed"))
		}
	default:
		fatal(fmt.Errorf("Ed25519 key is %d bytes, want %d-byte seed or %d-byte private key", len(raw), ed25519.SeedSize, ed25519.PrivateKeySize))
	}
	defer clear(privateKey)
	publicKey := privateKey.Public().(ed25519.PublicKey)
	signature := ed25519.Sign(privateKey, data)
	writeFresh(*signatureOut, []byte(hex.EncodeToString(signature)+"\n"))
	writeFresh(*publicKeyOut, []byte(hex.EncodeToString(publicKey)+"\n"))
}

func readRegular(path string, secret bool) ([]byte, error) {
	linkInfo, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !linkInfo.Mode().IsRegular() || linkInfo.Size() <= 0 || linkInfo.Size() > 64<<20 {
		return nil, errors.New("input must be a bounded non-empty regular file")
	}
	if secret && runtime.GOOS != "windows" && linkInfo.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("private key has group/world permission bits")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || !os.SameFile(linkInfo, info) {
		return nil, errors.New("input changed while being opened")
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != info.Size() {
		return nil, errors.New("input changed while being read")
	}
	return data, nil
}

func writeFresh(path string, data []byte) {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, fs.FileMode(0o600))
	if err != nil {
		fatal(err)
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		fatal(err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		fatal(err)
	}
	if err := file.Close(); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
