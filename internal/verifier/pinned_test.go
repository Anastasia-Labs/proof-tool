package verifier

import "testing"

func TestLoadPinnedVerifier(t *testing.T) {
	proofVerifier, err := LoadPinnedVerifier()
	if err != nil {
		t.Fatal(err)
	}
	if proofVerifier.VKHash() != PinnedVKHash {
		t.Fatalf("vk hash = %s", proofVerifier.VKHash())
	}
}
