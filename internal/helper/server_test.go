package helper

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/circuit/ownershipdest"
)

const (
	testOrigin = "http://localhost:3000"
	testToken  = "test-pairing-token"
)

type fakeGenerator struct {
	artifact artifact.ProofArtifact
	err      error
	called   bool
}

func (f *fakeGenerator) GenerateProof(_ context.Context, input ProveInput) (artifact.ProofArtifact, error) {
	f.called = true
	if len(input.MasterXPrv) != 96 {
		return artifact.ProofArtifact{}, errors.New("bad master")
	}
	if len(input.TargetCredential) != 28 {
		return artifact.ProofArtifact{}, errors.New("bad target")
	}
	return f.artifact, f.err
}

type fakeDestinationGenerator struct {
	err    error
	called bool
	input  ProveDestinationInput
}

func (f *fakeDestinationGenerator) GenerateProof(_ context.Context, _ ProveInput) (artifact.ProofArtifact, error) {
	return validArtifact(), nil
}

func (f *fakeDestinationGenerator) GenerateDestinationProofs(_ context.Context, input ProveDestinationInput) ([]DestinationProofArtifactItem, error) {
	f.called = true
	f.input = input
	if f.err != nil {
		return nil, f.err
	}
	results := make([]DestinationProofArtifactItem, 0, len(input.Requests))
	for _, request := range input.Requests {
		results = append(results, DestinationProofArtifactItem{
			OutRef:   request.OutRef,
			Artifact: validDestinationArtifactFor(request),
		})
	}
	return results, nil
}

func TestBuildInputValidatesRequest(t *testing.T) {
	req := validProveRequest()
	input, err := BuildInput(req)
	if err != nil {
		t.Fatal(err)
	}
	if len(input.MasterXPrv) != 96 {
		t.Fatalf("master length = %d", len(input.MasterXPrv))
	}
	if input.Search.Account != -1 || input.Search.MaxAccount != 9 {
		t.Fatalf("search options = %+v", input.Search)
	}

	req.MasterXPrvBase64 = base64.StdEncoding.EncodeToString([]byte("short"))
	if _, err := BuildInput(req); err == nil || !strings.Contains(err.Error(), "96") {
		t.Fatalf("short master error = %v", err)
	}
}

func TestHelperHealthDoesNotRequireToken(t *testing.T) {
	server := NewServer(&fakeGenerator{}, testToken, []string{testOrigin})
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rr := httptest.NewRecorder()
	server.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}
}

func TestHelperStatusReportsCompatibilityFields(t *testing.T) {
	server := NewServer(FixtureGenerator{}, testToken, []string{testOrigin})
	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	rr := httptest.NewRecorder()
	server.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}
	var status StatusResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if !status.Connected || !status.TokenRequired {
		t.Fatalf("status = %+v", status)
	}
	if status.ProtocolVersion != ProtocolVersion || status.SidecarVersion != SidecarVersion {
		t.Fatalf("versions = %+v", status)
	}
	if status.CircuitID != ownership.CircuitID {
		t.Fatalf("circuit id = %q", status.CircuitID)
	}
	if status.Compatibility != "ready" || !status.KeyReady || status.KeyState != "fixture" {
		t.Fatalf("key status = %+v", status)
	}
	if status.DestinationProfile == nil {
		t.Fatal("destination profile status missing")
	}
	if status.DestinationProfile.Profile != DestinationProfileSingle ||
		status.DestinationProfile.CircuitID != ownershipdest.CircuitID ||
		status.DestinationProfile.Compatibility != "ready" ||
		!status.DestinationProfile.KeyReady ||
		status.DestinationProfile.KeyState != "fixture" {
		t.Fatalf("destination profile = %+v", status.DestinationProfile)
	}
	if len(status.SupportedOrigins) != 1 || status.SupportedOrigins[0] != testOrigin {
		t.Fatalf("origins = %+v", status.SupportedOrigins)
	}
}

func TestHelperStatusReportsMissingProductionKeys(t *testing.T) {
	server := NewServer(&OwnershipGenerator{KeysDir: t.TempDir()}, testToken, []string{testOrigin})
	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	rr := httptest.NewRecorder()
	server.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}
	var status StatusResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.KeyReady || status.KeyState != "missing" || status.Compatibility != "key_missing" {
		t.Fatalf("status = %+v", status)
	}
	if status.DestinationProfile == nil {
		t.Fatal("destination profile status missing")
	}
	if status.DestinationProfile.KeyReady || status.DestinationProfile.KeyState != "missing" || status.DestinationProfile.Compatibility != "key_missing" {
		t.Fatalf("destination profile = %+v", status.DestinationProfile)
	}
}

func TestHelperPnaPreflightForAllowedOrigin(t *testing.T) {
	server := NewServer(&fakeGenerator{}, testToken, []string{testOrigin})
	req := httptest.NewRequest(http.MethodOptions, "/prove", nil)
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Access-Control-Request-Private-Network", "true")
	rr := httptest.NewRecorder()
	server.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}
	if rr.Header().Get("Access-Control-Allow-Private-Network") != "true" {
		t.Fatalf("private network header = %q", rr.Header().Get("Access-Control-Allow-Private-Network"))
	}
}

func TestHelperCorsAllowsSiblingLoopbackDevOrigin(t *testing.T) {
	server := NewServer(&fakeGenerator{}, testToken, []string{"http://127.0.0.1:3002"})
	req := httptest.NewRequest(http.MethodOptions, "/status", nil)
	req.Header.Set("Origin", "http://127.0.0.1:3001")
	req.Header.Set("Access-Control-Request-Headers", TokenHeader)
	req.Header.Set("Access-Control-Request-Private-Network", "true")
	rr := httptest.NewRecorder()

	server.Handler().ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "http://127.0.0.1:3001" {
		t.Fatalf("allow origin = %q", got)
	}
	if rr.Header().Get("Access-Control-Allow-Private-Network") != "true" {
		t.Fatalf("private network header = %q", rr.Header().Get("Access-Control-Allow-Private-Network"))
	}
}

func TestHelperAcceptsSiblingLoopbackDevOriginWithToken(t *testing.T) {
	fake := &fakeGenerator{artifact: validArtifact()}
	rr := postProve(t, NewServer(fake, testToken, []string{"http://127.0.0.1:3002"}), validProveRequest(), "http://127.0.0.1:3001", testToken)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}
	if !fake.called {
		t.Fatal("generator was not called")
	}
}

func TestProductionGeneratorFailsClosedWhenKeysAreMissing(t *testing.T) {
	generator := &OwnershipGenerator{KeysDir: t.TempDir()}
	_, err := generator.GenerateProof(context.Background(), ProveInput{
		MasterXPrv:       make([]byte, 96),
		TargetCredential: make([]byte, 28),
	})
	if err == nil {
		t.Fatal("missing production key bundle did not fail")
	}
	if !strings.Contains(err.Error(), "manifest.json") {
		t.Fatalf("error = %v", err)
	}
}

func TestProductionDestinationGeneratorFailsClosedWhenKeysAreMissing(t *testing.T) {
	input, err := BuildDestinationInput(validProveDestinationRequest())
	if err != nil {
		t.Fatal(err)
	}
	generator := &OwnershipGenerator{DestinationKeysDir: t.TempDir()}
	_, err = generator.GenerateDestinationProofs(context.Background(), input)
	if err == nil {
		t.Fatal("missing production destination key bundle did not fail")
	}
	if !strings.Contains(err.Error(), "manifest.json") {
		t.Fatalf("error = %v", err)
	}
}

func TestHelperRejectsWrongOrigin(t *testing.T) {
	fake := &fakeGenerator{artifact: validArtifact()}
	rr := postProve(t, NewServer(fake, testToken, []string{testOrigin}), validProveRequest(), "http://evil.test", testToken)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}
	if fake.called {
		t.Fatal("generator called for wrong origin")
	}
}

func TestHelperRejectsMissingOrWrongToken(t *testing.T) {
	for _, token := range []string{"", "wrong"} {
		fake := &fakeGenerator{artifact: validArtifact()}
		rr := postProve(t, NewServer(fake, testToken, []string{testOrigin}), validProveRequest(), testOrigin, token)
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("token %q status = %d body = %s", token, rr.Code, rr.Body.String())
		}
		if fake.called {
			t.Fatal("generator called with invalid token")
		}
	}
}

func TestProveDestinationRequiresOriginAndToken(t *testing.T) {
	for _, tc := range []struct {
		name   string
		origin string
		token  string
		status int
	}{
		{name: "wrong origin", origin: "http://evil.test", token: testToken, status: http.StatusForbidden},
		{name: "missing token", origin: testOrigin, token: "", status: http.StatusUnauthorized},
		{name: "wrong token", origin: testOrigin, token: "wrong", status: http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := &fakeDestinationGenerator{}
			rr := postProveDestination(t, NewServer(fake, testToken, []string{testOrigin}), validProveDestinationRequest(), tc.origin, tc.token)
			if rr.Code != tc.status {
				t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
			}
			if fake.called {
				t.Fatal("destination generator called without valid origin/token")
			}
		})
	}
}

func TestHelperReturnsBackendArtifactWithoutPathByDefault(t *testing.T) {
	fake := &fakeGenerator{artifact: validArtifact()}
	rr := postProve(t, NewServer(fake, testToken, []string{testOrigin}), validProveRequest(), testOrigin, testToken)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}
	var resp ProveResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Artifact.Path != nil {
		t.Fatalf("backend artifact leaked path: %+v", resp.Artifact.Path)
	}
	if resp.DebugArtifact != nil {
		t.Fatal("debug artifact returned without explicit request")
	}
}

func TestProveDestinationValidationRejectsBadCredentialDestinationAndProfile(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*ProveDestinationRequest)
	}{
		{
			name: "bad profile",
			mutate: func(req *ProveDestinationRequest) {
				req.Profile = "ownership"
			},
		},
		{
			name: "bad credential",
			mutate: func(req *ProveDestinationRequest) {
				req.Requests[0].TargetCredential = "abcd"
			},
		},
		{
			name: "bad destination encoding",
			mutate: func(req *ProveDestinationRequest) {
				req.Requests[0].DestinationAddressEncoding = "addr-bech32"
			},
		},
		{
			name: "bad destination",
			mutate: func(req *ProveDestinationRequest) {
				req.Requests[0].DestinationAddress = "abcd"
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := validProveDestinationRequest()
			tc.mutate(&req)
			fake := &fakeDestinationGenerator{}
			rr := postProveDestination(t, NewServer(fake, testToken, []string{testOrigin}), req, testOrigin, testToken)
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
			}
			if fake.called {
				t.Fatal("destination generator called for invalid request")
			}
		})
	}
}

func TestProveDestinationResponseStripsPathAndPreservesOrder(t *testing.T) {
	req := validProveDestinationRequest()
	req.Requests = append(req.Requests, DestinationProofRequest{
		OutRef:                     "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#1",
		TargetCredential:           req.Requests[0].TargetCredential,
		DestinationAddressEncoding: req.Requests[0].DestinationAddressEncoding,
		DestinationAddress:         req.Requests[0].DestinationAddress,
	})
	fake := &fakeDestinationGenerator{}
	rr := postProveDestination(t, NewServer(fake, testToken, []string{testOrigin}), req, testOrigin, testToken)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}
	var resp ProveDestinationResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Profile != DestinationProfileSingle {
		t.Fatalf("profile = %q", resp.Profile)
	}
	if len(resp.Artifacts) != len(req.Requests) {
		t.Fatalf("artifacts = %d, want %d", len(resp.Artifacts), len(req.Requests))
	}
	for i, item := range resp.Artifacts {
		if item.OutRef != req.Requests[i].OutRef {
			t.Fatalf("artifact[%d].out_ref = %q, want %q", i, item.OutRef, req.Requests[i].OutRef)
		}
		if item.Artifact.Path != nil || len(item.Artifact.Paths) != 0 {
			t.Fatalf("artifact[%d] leaked path metadata: %+v", i, item.Artifact)
		}
	}
}

func TestProveDestinationIncludesPathOnlyWhenRequested(t *testing.T) {
	req := validProveDestinationRequest()
	req.IncludeDebugPath = true
	rr := postProveDestination(t, NewServer(&fakeDestinationGenerator{}, testToken, []string{testOrigin}), req, testOrigin, testToken)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}
	var resp ProveDestinationResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Artifacts) != 1 || resp.Artifacts[0].Artifact.Path == nil {
		t.Fatalf("debug path missing: %+v", resp.Artifacts)
	}
}

func TestHelperReturnsDebugArtifactOnlyWhenRequested(t *testing.T) {
	req := validProveRequest()
	req.IncludeDebugPath = true
	rr := postProve(t, NewServer(&fakeGenerator{artifact: validArtifact()}, testToken, []string{testOrigin}), req, testOrigin, testToken)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}
	var resp ProveResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Artifact.Path != nil {
		t.Fatal("backend artifact includes path")
	}
	if resp.DebugArtifact == nil || resp.DebugArtifact.Path == nil {
		t.Fatalf("debug artifact missing path: %+v", resp.DebugArtifact)
	}
}

func TestHelperMapsPathNotFound(t *testing.T) {
	rr := postProve(t, NewServer(&fakeGenerator{err: ErrPathNotFound}, testToken, []string{testOrigin}), validProveRequest(), testOrigin, testToken)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "path_not_found") {
		t.Fatalf("body = %s", rr.Body.String())
	}
}

func TestShutdownRequiresOriginAndToken(t *testing.T) {
	called := make(chan struct{}, 1)
	server := NewServer(&fakeGenerator{}, testToken, []string{testOrigin})
	server.Shutdown = func() {
		called <- struct{}{}
	}

	wrongOrigin := postShutdown(server, "http://evil.test", testToken)
	if wrongOrigin.Code != http.StatusForbidden {
		t.Fatalf("wrong origin status = %d body = %s", wrongOrigin.Code, wrongOrigin.Body.String())
	}

	wrongToken := postShutdown(server, testOrigin, "wrong")
	if wrongToken.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token status = %d body = %s", wrongToken.Code, wrongToken.Body.String())
	}

	ok := postShutdown(server, testOrigin, testToken)
	if ok.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", ok.Code, ok.Body.String())
	}
	select {
	case <-called:
	case <-time.After(time.Second):
		t.Fatal("shutdown callback was not called")
	}
}

func postProve(t *testing.T, server *Server, req ProveRequest, origin, token string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	httpReq := httptest.NewRequest(http.MethodPost, "/prove", bytes.NewReader(body))
	httpReq.Header.Set("Origin", origin)
	if token != "" {
		httpReq.Header.Set(TokenHeader, token)
	}
	rr := httptest.NewRecorder()
	server.Handler().ServeHTTP(rr, httpReq)
	return rr
}

func postProveDestination(t *testing.T, server *Server, req ProveDestinationRequest, origin, token string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	httpReq := httptest.NewRequest(http.MethodPost, "/prove-destination", bytes.NewReader(body))
	httpReq.Header.Set("Origin", origin)
	if token != "" {
		httpReq.Header.Set(TokenHeader, token)
	}
	rr := httptest.NewRecorder()
	server.Handler().ServeHTTP(rr, httpReq)
	return rr
}

func postShutdown(server *Server, origin, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/shutdown", nil)
	req.Header.Set("Origin", origin)
	if token != "" {
		req.Header.Set(TokenHeader, token)
	}
	rr := httptest.NewRecorder()
	server.Handler().ServeHTTP(rr, req)
	return rr
}

func validProveRequest() ProveRequest {
	master := make([]byte, 96)
	return ProveRequest{
		MasterXPrvBase64: base64.StdEncoding.EncodeToString(master),
		TargetCredential: "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4",
	}
}

func validProveDestinationRequest() ProveDestinationRequest {
	master := make([]byte, 96)
	maxAccount := uint32(9)
	maxIndex := uint32(999)
	return ProveDestinationRequest{
		MasterXPrvBase64: base64.StdEncoding.EncodeToString(master),
		Profile:          DestinationProfileSingle,
		Requests: []DestinationProofRequest{
			{
				OutRef:                     "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#0",
				TargetCredential:           "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4",
				DestinationAddressEncoding: ownershipdest.DestinationAddressEncoding,
				DestinationAddress:         "010038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da1110000000000000000000000000000000000000000000000000000000000",
			},
		},
		Search: &DestinationSearchRequest{
			MaxAccount: &maxAccount,
			MaxIndex:   &maxIndex,
		},
	}
}

func validArtifact() artifact.ProofArtifact {
	target, err := ownership.DecodeCredentialHex("19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4")
	if err != nil {
		panic(err)
	}
	pub, err := ownership.PublicInputForCredential(target)
	if err != nil {
		panic(err)
	}
	return artifact.ProofArtifact{
		Schema:           artifact.ProofSchema,
		CircuitID:        ownership.CircuitID,
		VKHash:           "blake2b256:test",
		TargetCredential: "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4",
		PublicInput:      ownership.PublicInputHex(pub),
		Proof:            "proof",
		Path:             &artifact.PathMetadata{Account: 0, Role: 0, Index: 0},
	}
}

func validDestinationArtifactFor(input DestinationProofInput) artifact.ProofArtifact {
	pub, err := ownershipdest.PublicInputForCredentialDestination(input.TargetCredential, input.DestinationAddress)
	if err != nil {
		panic(err)
	}
	digest, err := ownershipdest.PublicInputDigestForCredentialDestination(input.TargetCredential, input.DestinationAddress)
	if err != nil {
		panic(err)
	}
	return artifact.ProofArtifact{
		Schema:                     artifact.ProofSchema,
		CircuitID:                  ownershipdest.CircuitID,
		VKHash:                     "blake2b256:destination-test",
		TargetCredential:           "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4",
		DestinationAddressEncoding: input.DestinationAddressEncoding,
		DestinationAddress:         "010038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da1110000000000000000000000000000000000000000000000000000000000",
		PublicInputEncoding:        ownershipdest.PublicInputEncoding,
		PublicInput:                ownershipdest.PublicInputHex(pub),
		Proof:                      "proof",
		Cardano: &artifact.CardanoProof{
			Format:               "fixture",
			ProofHex:             "70726f6f66",
			PublicInputDigestHex: strings.ToLower(hexString(digest)),
		},
		Path: &artifact.PathMetadata{Account: 0, Role: 0, Index: 0},
	}
}

func hexString(value []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, len(value)*2)
	for i, b := range value {
		out[i*2] = digits[b>>4]
		out[i*2+1] = digits[b&0x0f]
	}
	return string(out)
}
