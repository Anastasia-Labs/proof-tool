// Copyright 2026 Midgard Labs
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadPublicKeyHexRequiresBoundedRegularStableFile(t *testing.T) {
	dir := t.TempDir()
	publicKey := make([]byte, ed25519.PublicKeySize)
	for index := range publicKey {
		publicKey[index] = byte(index + 1)
	}
	path := filepath.Join(dir, "coordinator.hex")
	if err := os.WriteFile(path, []byte(hex.EncodeToString(publicKey)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	value, err := readPublicKeyHex(path)
	if err != nil {
		t.Fatalf("read regular public key: %v", err)
	}
	if value != hex.EncodeToString(publicKey) {
		t.Fatal("public key changed during bounded read")
	}

	symlink := filepath.Join(dir, "coordinator-link.hex")
	if err := os.Symlink(path, symlink); err != nil {
		t.Fatal(err)
	}
	if _, err := readPublicKeyHex(symlink); err == nil {
		t.Fatal("accepted a symbolic-link trust anchor")
	}

	oversized := filepath.Join(dir, "oversized.hex")
	if err := os.WriteFile(oversized, []byte(strings.Repeat("0", 4097)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readPublicKeyHex(oversized); err == nil {
		t.Fatal("accepted an oversized trust anchor")
	}
}
