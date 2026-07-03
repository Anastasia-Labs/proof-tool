package verifier

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/frontend"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/prover"
)

const (
	goldenTarget = "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4"
	testVKHash   = "blake2b256:test-pinned-vk"
)

type squareCircuit struct {
	X frontend.Variable
	Y frontend.Variable `gnark:",public"`
}

func (s *squareCircuit) Define(api frontend.API) error {
	api.AssertIsEqual(api.Mul(s.X, s.X), s.Y)
	return nil
}

type stubProofVerifier struct {
	vkHash string
	err    error
	called bool
}

func (s *stubProofVerifier) VKHash() string {
	return s.vkHash
}

func (s *stubProofVerifier) VerifyProof(_ context.Context, _ groth16.Proof, _ *big.Int) error {
	s.called = true
	return s.err
}

func TestVerifyArtifactValidSucceeds(t *testing.T) {
	stub := &stubProofVerifier{vkHash: testVKHash}
	resp := VerifyArtifact(context.Background(), VerifyRequest{Artifact: validArtifact(t)}, stub)
	if !resp.Verified {
		t.Fatalf("verified = false, reason = %q", resp.Reason)
	}
	if !stub.called {
		t.Fatal("proof verifier was not called")
	}
	if resp.TargetCredential != goldenTarget {
		t.Fatalf("target = %s, want %s", resp.TargetCredential, goldenTarget)
	}
}

func TestVerifyArtifactRejectsBadSchema(t *testing.T) {
	a := validArtifact(t)
	a.Schema = "wrong"
	resp := VerifyArtifact(context.Background(), VerifyRequest{Artifact: a}, &stubProofVerifier{vkHash: testVKHash})
	if resp.Verified || !strings.Contains(resp.Reason, "schema") {
		t.Fatalf("response = %+v", resp)
	}
}

func TestVerifyArtifactRejectsWrongCircuitID(t *testing.T) {
	a := validArtifact(t)
	a.CircuitID = "wrong"
	resp := VerifyArtifact(context.Background(), VerifyRequest{Artifact: a}, &stubProofVerifier{vkHash: testVKHash})
	if resp.Verified || !strings.Contains(resp.Reason, "circuit id") {
		t.Fatalf("response = %+v", resp)
	}
}

func TestVerifyArtifactRejectsMismatchedTargetCredential(t *testing.T) {
	a := validArtifact(t)
	expected := "29e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4"
	resp := VerifyArtifact(context.Background(), VerifyRequest{
		Artifact:                 a,
		ExpectedTargetCredential: expected,
	}, &stubProofVerifier{vkHash: testVKHash})
	if resp.Verified || !strings.Contains(resp.Reason, "expected target") {
		t.Fatalf("response = %+v", resp)
	}
}

func TestVerifyArtifactRejectsMismatchedPublicInput(t *testing.T) {
	a := validArtifact(t)
	a.PublicInput = "0x1"
	resp := VerifyArtifact(context.Background(), VerifyRequest{Artifact: a}, &stubProofVerifier{vkHash: testVKHash})
	if resp.Verified || !strings.Contains(resp.Reason, "public input") {
		t.Fatalf("response = %+v", resp)
	}
}

func TestVerifyArtifactRejectsMismatchedVerifyingKeyHash(t *testing.T) {
	a := validArtifact(t)
	a.VKHash = "blake2b256:wrong"
	resp := VerifyArtifact(context.Background(), VerifyRequest{Artifact: a}, &stubProofVerifier{vkHash: testVKHash})
	if resp.Verified || !strings.Contains(resp.Reason, "verifying key hash") {
		t.Fatalf("response = %+v", resp)
	}
}

func TestVerifyArtifactRejectsMalformedProof(t *testing.T) {
	a := validArtifact(t)
	a.Proof = "not base64"
	resp := VerifyArtifact(context.Background(), VerifyRequest{Artifact: a}, &stubProofVerifier{vkHash: testVKHash})
	if resp.Verified || !strings.Contains(resp.Reason, "malformed") {
		t.Fatalf("response = %+v", resp)
	}
}

func TestVerifyArtifactRejectsProofVerificationFailure(t *testing.T) {
	resp := VerifyArtifact(context.Background(), VerifyRequest{Artifact: validArtifact(t)}, &stubProofVerifier{
		vkHash: testVKHash,
		err:    errors.New("bad proof"),
	})
	if resp.Verified || !strings.Contains(resp.Reason, "did not verify") {
		t.Fatalf("response = %+v", resp)
	}
}

func TestBackendProofArtifactStripsPath(t *testing.T) {
	a := validArtifact(t)
	a.Path = &artifact.PathMetadata{Account: 0, Role: 0, Index: 0}
	if got := artifact.BackendProofArtifact(a); got.Path != nil {
		t.Fatalf("path was not stripped: %+v", got.Path)
	}
}

func TestVerifyHandler(t *testing.T) {
	srv := NewServer(&stubProofVerifier{vkHash: testVKHash}, []string{"http://localhost:3000"})
	body, err := json.Marshal(VerifyRequest{Artifact: validArtifact(t)})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/verify", bytes.NewReader(body))
	req.Header.Set("Origin", "http://localhost:3000")
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:3000" {
		t.Fatalf("CORS origin = %q", got)
	}
	var resp VerifyResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.Verified {
		t.Fatalf("verified = false: %+v", resp)
	}
}

func validArtifact(t *testing.T) artifact.ProofArtifact {
	t.Helper()
	target, err := ownership.DecodeCredentialHex(goldenTarget)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := ownership.PublicInputForCredential(target)
	if err != nil {
		t.Fatal(err)
	}
	return artifact.ProofArtifact{
		Schema:           artifact.ProofSchema,
		CircuitID:        ownership.CircuitID,
		VKHash:           testVKHash,
		TargetCredential: goldenTarget,
		PublicInput:      ownership.PublicInputHex(pub),
		Proof:            validEncodedProof(t),
	}
}

func validEncodedProof(t *testing.T) string {
	t.Helper()
	ccs, err := prover.Compile(&squareCircuit{})
	if err != nil {
		t.Fatal(err)
	}
	pk, _, err := prover.Setup(ccs)
	if err != nil {
		t.Fatal(err)
	}
	proof, err := prover.Prove(ccs, pk, &squareCircuit{X: 3, Y: 9})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := prover.MarshalProof(proof)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := base64.StdEncoding.DecodeString(encoded); err != nil {
		t.Fatal(err)
	}
	return encoded
}
