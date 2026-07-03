package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/verifier"
)

func TestAPIHealth(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rr := httptest.NewRecorder()

	newHandler(verifier.FixtureVerifier{}).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["ok"] != true {
		t.Fatalf("ok = %v", body["ok"])
	}
	if body["vk_hash"] != verifier.FixtureVKHash {
		t.Fatalf("vk_hash = %v", body["vk_hash"])
	}
}

func TestAPIVerify(t *testing.T) {
	target := "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4"
	targetBytes, err := ownership.DecodeCredentialHex(target)
	if err != nil {
		t.Fatal(err)
	}
	publicInput, err := ownership.PublicInputForCredential(targetBytes)
	if err != nil {
		t.Fatal(err)
	}
	requestBody, err := json.Marshal(verifier.VerifyRequest{
		Artifact: artifact.ProofArtifact{
			Schema:           artifact.ProofSchema,
			CircuitID:        ownership.CircuitID,
			VKHash:           verifier.FixtureVKHash,
			TargetCredential: target,
			PublicInput:      ownership.PublicInputHex(publicInput),
			Proof:            "fixture-proof",
		},
		ExpectedTargetCredential: target,
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/verify", bytes.NewReader(requestBody))
	rr := httptest.NewRecorder()

	newHandler(verifier.FixtureVerifier{}).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}
	var body verifier.VerifyResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.Verified {
		t.Fatalf("verified = false: %+v", body)
	}
}
