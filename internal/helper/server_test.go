package helper

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
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
	testMaster = "c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620"
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

type contextDestinationGenerator struct {
	started chan struct{}
}

func (g *contextDestinationGenerator) GenerateProof(_ context.Context, _ ProveInput) (artifact.ProofArtifact, error) {
	return validArtifact(), nil
}

func (g *contextDestinationGenerator) GenerateDestinationProofs(ctx context.Context, _ ProveDestinationInput) ([]DestinationProofArtifactItem, error) {
	close(g.started)
	<-ctx.Done()
	return nil, ctx.Err()
}

func (f *fakeDestinationGenerator) GenerateProof(_ context.Context, _ ProveInput) (artifact.ProofArtifact, error) {
	return validArtifact(), nil
}

func (f *fakeDestinationGenerator) GenerateDestinationProofs(_ context.Context, input ProveDestinationInput) ([]DestinationProofArtifactItem, error) {
	f.called = true
	f.input = input
	if input.Progress != nil {
		input.Progress(LocalProofProgress{
			Stage: "locating-keys",
			Discovery: &ownership.DiscoveryProgress{
				Scanned:             64,
				Total:               30_000,
				Matched:             1,
				Targets:             1,
				CandidatesPerSecond: 1_250,
				ETA:                 23 * time.Second,
			},
		})
		input.Progress(LocalProofProgress{Stage: "prove", Current: 1, Total: 1})
	}
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
	if len(status.Capabilities) != 1 || status.Capabilities[0] != DestinationPreflightCapability {
		t.Fatalf("capabilities = %+v", status.Capabilities)
	}
}

func TestProveDestinationPreflightIsExactAndDoesNotCallGenerator(t *testing.T) {
	fake := &fakeDestinationGenerator{}
	server := NewServer(fake, testToken, []string{testOrigin})
	rr := postProveDestination(t, server, ProveDestinationRequest{PreflightOnly: true}, testOrigin, testToken)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}
	var response ProveDestinationPreflightResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if !response.OK || response.Capability != DestinationPreflightCapability {
		t.Fatalf("response = %+v", response)
	}
	if fake.called {
		t.Fatal("destination generator was called during preflight")
	}

	rr = postProveDestination(t, server, ProveDestinationRequest{
		PreflightOnly:    true,
		MasterXPrvBase64: "secret-must-not-be-accepted",
	}, testOrigin, testToken)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("preflight with secret status = %d body = %s", rr.Code, rr.Body.String())
	}
	if fake.called {
		t.Fatal("destination generator was called for invalid preflight")
	}
}

func TestProveDestinationPreflightRequiresOriginAndToken(t *testing.T) {
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
			rr := postProveDestination(t, NewServer(fake, testToken, []string{testOrigin}), ProveDestinationRequest{PreflightOnly: true}, tc.origin, tc.token)
			if rr.Code != tc.status {
				t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
			}
			if fake.called {
				t.Fatal("destination generator called for unauthorized preflight")
			}
		})
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

func TestHelperAcceptsWildcardPreviewOrigin(t *testing.T) {
	fake := &fakeGenerator{artifact: validArtifact()}
	server := NewServer(fake, testToken, []string{"https://proof-tool.example.app", "https://proof-tool-git-*.example.app"})
	rr := postProve(t, server, validProveRequest(), "https://proof-tool-git-main-team.example.app", testToken)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}
	if !fake.called {
		t.Fatal("generator was not called for allowed preview origin")
	}
}

func TestHelperWildcardOriginDoesNotSpanLabels(t *testing.T) {
	cases := []struct {
		name   string
		origin string
	}{
		{"extra label in wildcard", "https://proof-tool-git-main.attacker.example.app"},
		{"empty wildcard", "https://proof-tool-git-.example.app"},
		{"scheme mismatch", "http://proof-tool-git-main.example.app"},
		{"suffix mismatch", "https://proof-tool-git-main.evil.app"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fake := &fakeGenerator{artifact: validArtifact()}
			server := NewServer(fake, testToken, []string{"https://proof-tool.example.app", "https://proof-tool-git-*.example.app"})
			rr := postProve(t, server, validProveRequest(), tc.origin, testToken)
			if rr.Code != http.StatusForbidden {
				t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
			}
			if fake.called {
				t.Fatalf("generator called for disallowed origin %q", tc.origin)
			}
		})
	}
}

func TestHelperStatusListsWildcardOrigins(t *testing.T) {
	server := NewServer(FixtureGenerator{}, testToken, []string{"https://proof-tool.example.app", "https://proof-tool-git-*.example.app"})
	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	rr := httptest.NewRecorder()
	server.Handler().ServeHTTP(rr, req)
	var status StatusResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"https://proof-tool.example.app":       false,
		"https://proof-tool-git-*.example.app": false,
	}
	for _, origin := range status.SupportedOrigins {
		if _, ok := want[origin]; ok {
			want[origin] = true
		}
	}
	for origin, seen := range want {
		if !seen {
			t.Fatalf("supported origins %+v missing %q", status.SupportedOrigins, origin)
		}
	}
}

func TestProductionGeneratorFailsClosedWhenKeysAreMissing(t *testing.T) {
	master, err := hex.DecodeString(testMaster)
	if err != nil {
		t.Fatal(err)
	}
	target, err := ownership.DecodeCredentialHex("19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4")
	if err != nil {
		t.Fatal(err)
	}
	generator := &OwnershipGenerator{KeysDir: t.TempDir()}
	_, err = generator.GenerateProof(context.Background(), ProveInput{
		MasterXPrv:       master,
		TargetCredential: target,
		Search:           ownership.SearchOptions{Account: -1, Role: -1, Index: -1, MaxAccount: 9, MaxIndex: 999},
	})
	if err == nil {
		t.Fatal("missing production key bundle did not fail")
	}
	if !strings.Contains(err.Error(), "manifest.json") {
		t.Fatalf("error = %v", err)
	}
}

func TestProductionDestinationGeneratorFailsClosedWhenKeysAreMissing(t *testing.T) {
	req := validProveDestinationRequest()
	master, err := hex.DecodeString(testMaster)
	if err != nil {
		t.Fatal(err)
	}
	req.MasterXPrvBase64 = base64.StdEncoding.EncodeToString(master)
	input, err := BuildDestinationInput(req)
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

func TestProveDestinationStreamsAggregateProgressAndTerminalResult(t *testing.T) {
	req := validProveDestinationRequest()
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	httpReq := httptest.NewRequest(http.MethodPost, "/prove-destination", bytes.NewReader(body))
	httpReq.Header.Set("Origin", testOrigin)
	httpReq.Header.Set(TokenHeader, testToken)
	httpReq.Header.Set("Accept", destinationProgressContentType)
	rr := httptest.NewRecorder()
	NewServer(&fakeDestinationGenerator{}, testToken, []string{testOrigin}).Handler().ServeHTTP(rr, httpReq)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Content-Type"); got != destinationProgressContentType {
		t.Fatalf("content type = %q", got)
	}
	lines := strings.Split(strings.TrimSpace(rr.Body.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("events = %d body = %s", len(lines), rr.Body.String())
	}
	var events []DestinationProgressEvent
	for _, line := range lines {
		var event DestinationProgressEvent
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	discovery := events[0]
	if discovery.Type != "progress" || discovery.Stage != "locating-keys" || discovery.Discovery == nil {
		t.Fatalf("discovery event = %+v", discovery)
	}
	if discovery.Discovery.CandidatesScanned != 64 || discovery.Discovery.CandidatesTotal != 30_000 || discovery.Discovery.ETASeconds != 23 {
		t.Fatalf("discovery progress = %+v", discovery.Discovery)
	}
	if strings.Contains(lines[0], req.MasterXPrvBase64) || strings.Contains(lines[0], req.Requests[0].TargetCredential) || strings.Contains(lines[0], "account") || strings.Contains(lines[0], "role") || strings.Contains(lines[0], "index") {
		t.Fatalf("progress leaked secret or path metadata: %s", lines[0])
	}
	terminal := events[len(events)-1]
	if terminal.Type != "result" || terminal.Result == nil || len(terminal.Result.Artifacts) != 1 {
		t.Fatalf("terminal event = %+v", terminal)
	}
	if terminal.Result.Artifacts[0].Artifact.Path != nil {
		t.Fatalf("terminal result leaked path: %+v", terminal.Result.Artifacts[0].Artifact.Path)
	}
}

func TestProveDestinationStreamEndsWithSanitizedError(t *testing.T) {
	req := validProveDestinationRequest()
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	httpReq := httptest.NewRequest(http.MethodPost, "/prove-destination", bytes.NewReader(body))
	httpReq.Header.Set("Origin", testOrigin)
	httpReq.Header.Set(TokenHeader, testToken)
	httpReq.Header.Set("Accept", destinationProgressContentType)
	rr := httptest.NewRecorder()
	NewServer(&fakeDestinationGenerator{err: ErrPathNotFound}, testToken, []string{testOrigin}).Handler().ServeHTTP(rr, httpReq)
	lines := strings.Split(strings.TrimSpace(rr.Body.String()), "\n")
	var terminal DestinationProgressEvent
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &terminal); err != nil {
		t.Fatal(err)
	}
	if terminal.Type != "error" || terminal.Code != "path_not_found" || terminal.Error == "" {
		t.Fatalf("terminal error = %+v", terminal)
	}
	if strings.Contains(lines[len(lines)-1], req.Requests[0].TargetCredential) || strings.Contains(lines[len(lines)-1], req.MasterXPrvBase64) {
		t.Fatalf("terminal error leaked request material: %s", lines[len(lines)-1])
	}
}

func TestProveDestinationStreamPropagatesRequestCancellation(t *testing.T) {
	req := validProveDestinationRequest()
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	httpReq := httptest.NewRequest(http.MethodPost, "/prove-destination", bytes.NewReader(body)).WithContext(ctx)
	httpReq.Header.Set("Origin", testOrigin)
	httpReq.Header.Set(TokenHeader, testToken)
	httpReq.Header.Set("Accept", destinationProgressContentType)
	rr := httptest.NewRecorder()
	generator := &contextDestinationGenerator{started: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		NewServer(generator, testToken, []string{testOrigin}).Handler().ServeHTTP(rr, httpReq)
		close(done)
	}()
	select {
	case <-generator.started:
	case <-time.After(time.Second):
		t.Fatal("generator did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("handler did not stop after cancellation")
	}
	lines := strings.Split(strings.TrimSpace(rr.Body.String()), "\n")
	var terminal DestinationProgressEvent
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &terminal); err != nil {
		t.Fatal(err)
	}
	if terminal.Type != "error" || terminal.Code != "request_cancelled" {
		t.Fatalf("terminal cancellation = %+v", terminal)
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
