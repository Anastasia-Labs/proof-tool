package verifier

import (
	"strings"
	"testing"
)

func TestLoadPinnedVerifierRejectsRetiredUnsafeKey(t *testing.T) {
	proofVerifier, err := LoadPinnedVerifier()
	if err == nil || !strings.Contains(err.Error(), "GHSA-3mvx-pp85-pm65") {
		t.Fatalf("retired verifier error = %v", err)
	}
	if proofVerifier != nil {
		t.Fatal("retired verifier unexpectedly loaded")
	}
}
