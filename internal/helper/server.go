package helper

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/circuit/ownershipdest"
)

const TokenHeader = "X-Proof-Tool-Token"

const destinationProgressContentType = "application/x-ndjson"

type Server struct {
	Generator      Generator
	Token          string
	AllowedOrigins map[string]struct{}
	originPatterns []originPattern
	Shutdown       func()
	shutdownCalled atomic.Bool
}

// originPattern matches a browser origin whose host contains a single "*"
// wildcard standing for exactly one DNS label (no dots). It lets the helper
// accept a family of deploy-preview origins (e.g. Vercel branch previews)
// without allowing arbitrary subdomain traversal.
type originPattern struct {
	scheme     string
	hostPrefix string
	hostSuffix string
	port       string
}

type ErrorResponse struct {
	Code  string `json:"code"`
	Error string `json:"error"`
}

// DestinationProgressEvent is the opt-in streaming protocol for a local
// destination proof request. Progress is aggregate-only; result is populated
// only on the terminal result event.
type DestinationProgressEvent struct {
	Type      string                        `json:"type"`
	Stage     string                        `json:"stage,omitempty"`
	Current   uint64                        `json:"current,omitempty"`
	Total     uint64                        `json:"total,omitempty"`
	Discovery *DestinationDiscoveryProgress `json:"discovery,omitempty"`
	Result    *ProveDestinationResponse     `json:"result,omitempty"`
	Code      string                        `json:"code,omitempty"`
	Error     string                        `json:"error,omitempty"`
}

type DestinationDiscoveryProgress struct {
	CandidatesScanned   uint64  `json:"candidates_scanned"`
	CandidatesTotal     uint64  `json:"candidates_total"`
	CandidatesPerSecond float64 `json:"candidates_per_second"`
	ETASeconds          float64 `json:"eta_seconds"`
	Matched             uint64  `json:"matched"`
	Targets             uint64  `json:"targets"`
}

type StatusResponse struct {
	Connected          bool           `json:"connected"`
	TokenRequired      bool           `json:"token_required"`
	Service            string         `json:"service"`
	SidecarVersion     string         `json:"sidecar_version"`
	ProtocolVersion    string         `json:"protocol_version"`
	CircuitID          string         `json:"circuit_id"`
	KeyVersion         string         `json:"key_version,omitempty"`
	KeyHash            string         `json:"key_hash,omitempty"`
	KeyReady           bool           `json:"key_ready"`
	KeyState           string         `json:"key_state"`
	KeyError           string         `json:"key_error,omitempty"`
	Compatibility      string         `json:"compatibility"`
	Capabilities       []string       `json:"capabilities,omitempty"`
	DestinationProfile *ProfileStatus `json:"destination_profile,omitempty"`
	SupportedOrigins   []string       `json:"supported_origins"`
}

type ProfileStatus struct {
	Profile       string `json:"profile"`
	CircuitID     string `json:"circuit_id"`
	KeyVersion    string `json:"key_version,omitempty"`
	KeyHash       string `json:"key_hash,omitempty"`
	KeyReady      bool   `json:"key_ready"`
	KeyState      string `json:"key_state"`
	KeyError      string `json:"key_error,omitempty"`
	Compatibility string `json:"compatibility"`
}

func NewServer(generator Generator, token string, allowedOrigins []string) *Server {
	origins := make(map[string]struct{}, len(allowedOrigins))
	var patterns []originPattern
	for _, origin := range allowedOrigins {
		origin = strings.TrimSpace(origin)
		if origin == "" {
			continue
		}
		if strings.Contains(origin, "*") {
			if pattern, ok := compileOriginPattern(origin); ok {
				patterns = append(patterns, pattern)
			}
			continue
		}
		origins[origin] = struct{}{}
	}
	return &Server{Generator: generator, Token: token, AllowedOrigins: origins, originPatterns: patterns}
}

// compileOriginPattern parses an origin like "https://app-*.example.com" into a
// matcher. It accepts exactly one "*" in the host, requires an http/https
// scheme, and rejects any path/query/fragment. Invalid patterns are dropped
// (ok=false) so a misconfigured entry can never widen the allow-list.
func compileOriginPattern(raw string) (originPattern, bool) {
	idx := strings.Index(raw, "://")
	if idx <= 0 {
		return originPattern{}, false
	}
	scheme := raw[:idx]
	if scheme != "http" && scheme != "https" {
		return originPattern{}, false
	}
	rest := raw[idx+3:]
	if rest == "" || strings.ContainsAny(rest, "/?#") {
		return originPattern{}, false
	}
	host := rest
	port := ""
	if colon := strings.LastIndex(rest, ":"); colon >= 0 {
		host = rest[:colon]
		port = rest[colon+1:]
	}
	if strings.Count(host, "*") != 1 {
		return originPattern{}, false
	}
	star := strings.IndexByte(host, '*')
	return originPattern{
		scheme:     scheme,
		hostPrefix: host[:star],
		hostSuffix: host[star+1:],
		port:       port,
	}, true
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/status", s.handleStatus)
	mux.HandleFunc("/prove", s.handleProve)
	mux.HandleFunc("/prove-destination", s.handleProveDestination)
	mux.HandleFunc("/shutdown", s.handleShutdown)
	return s.withCORS(mux)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"service":    "proof-tool-helper",
		"circuit_id": ownership.CircuitID,
	})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	key := KeyStatus{State: "unknown"}
	if reporter, ok := s.Generator.(KeyStatusReporter); ok {
		key = reporter.KeyStatus()
	}
	var destinationProfile *ProfileStatus
	var capabilities []string
	if reporter, ok := s.Generator.(DestinationKeyStatusReporter); ok {
		status := reporter.DestinationKeyStatus()
		destinationProfile = &ProfileStatus{
			Profile:       DestinationProfileSingle,
			CircuitID:     ownershipdest.CircuitID,
			KeyVersion:    status.KeyVersion,
			KeyHash:       status.VKHash,
			KeyReady:      status.Ready,
			KeyState:      status.State,
			KeyError:      status.Error,
			Compatibility: compatibilityForKey(status),
		}
	}
	if _, ok := s.Generator.(DestinationGenerator); ok {
		capabilities = append(capabilities, DestinationPreflightCapability)
	}
	writeJSON(w, http.StatusOK, StatusResponse{
		Connected:          true,
		TokenRequired:      true,
		Service:            "proof-tool-helper",
		SidecarVersion:     SidecarVersion,
		ProtocolVersion:    ProtocolVersion,
		CircuitID:          ownership.CircuitID,
		KeyVersion:         key.KeyVersion,
		KeyHash:            key.VKHash,
		KeyReady:           key.Ready,
		KeyState:           key.State,
		KeyError:           key.Error,
		Compatibility:      compatibilityForKey(key),
		Capabilities:       capabilities,
		DestinationProfile: destinationProfile,
		SupportedOrigins:   s.allowedOrigins(),
	})
}

func (s *Server) handleProve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.originAllowed(r.Header.Get("Origin")) {
		writeError(w, http.StatusForbidden, "origin_not_allowed", "This website is not allowed to use the local helper.")
		return
	}
	if !s.tokenAllowed(r.Header.Get(TokenHeader)) {
		writeError(w, http.StatusUnauthorized, "token_required", "Open Proof Helper again so this browser can connect automatically.")
		return
	}

	var req ProveRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "The proof request was not valid JSON.")
		return
	}
	input, err := BuildInput(req)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	defer clear(input.MasterXPrv)
	proofArtifact, err := s.Generator.GenerateProof(r.Context(), input)
	if err != nil {
		status, code, message := errorMapping(err)
		writeError(w, status, code, message)
		return
	}

	debugArtifact := proofArtifact
	response := ProveResponse{
		Artifact: artifact.BackendProofArtifact(proofArtifact),
	}
	if input.IncludeDebugPath {
		response.DebugArtifact = &debugArtifact
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) handleProveDestination(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.originAllowed(r.Header.Get("Origin")) {
		writeError(w, http.StatusForbidden, "origin_not_allowed", "This website is not allowed to use the local helper.")
		return
	}
	if !s.tokenAllowed(r.Header.Get(TokenHeader)) {
		writeError(w, http.StatusUnauthorized, "token_required", "Open Proof Helper again so this browser can connect automatically.")
		return
	}
	generator, ok := s.Generator.(DestinationGenerator)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "profile_unavailable", "The local helper does not support destination-bound proofs.")
		return
	}

	var req ProveDestinationRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "The destination proof request was not valid JSON.")
		return
	}
	if req.PreflightOnly {
		if req.MasterXPrvBase64 != "" || req.Profile != "" || len(req.Requests) != 0 || req.Search != nil || req.IncludeDebugPath {
			writeError(w, http.StatusBadRequest, "invalid_request", "A destination preflight must not include proof inputs or recovery secrets.")
			return
		}
		writeJSON(w, http.StatusOK, ProveDestinationPreflightResponse{
			OK:         true,
			Capability: DestinationPreflightCapability,
		})
		return
	}
	input, err := BuildDestinationInput(req)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	defer clear(input.MasterXPrv)
	if acceptsDestinationProgress(r) {
		s.streamDestinationProofs(w, r, generator, input)
		return
	}
	results, err := generator.GenerateDestinationProofs(r.Context(), input)
	if err != nil {
		status, code, message := errorMapping(err)
		writeError(w, status, code, message)
		return
	}
	writeJSON(w, http.StatusOK, destinationProofResponse(input, results))
}

func destinationProofResponse(input ProveDestinationInput, results []DestinationProofArtifactItem) ProveDestinationResponse {
	response := ProveDestinationResponse{
		Profile:   input.Profile,
		Artifacts: make([]DestinationProofArtifactItem, 0, len(results)),
	}
	for _, result := range results {
		proofArtifact := result.Artifact
		if !input.IncludeDebugPath {
			proofArtifact = artifact.BackendProofArtifact(proofArtifact)
		}
		response.Artifacts = append(response.Artifacts, DestinationProofArtifactItem{
			OutRef:   result.OutRef,
			Artifact: proofArtifact,
		})
	}
	return response
}

func acceptsDestinationProgress(r *http.Request) bool {
	for _, value := range strings.Split(r.Header.Get("Accept"), ",") {
		mediaType := strings.TrimSpace(strings.SplitN(value, ";", 2)[0])
		if mediaType == destinationProgressContentType {
			return true
		}
	}
	return false
}

func (s *Server) streamDestinationProofs(
	w http.ResponseWriter,
	r *http.Request,
	generator DestinationGenerator,
	input ProveDestinationInput,
) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusNotImplemented, "streaming_unavailable", "The local helper cannot stream proof progress on this connection.")
		return
	}
	w.Header().Set("Content-Type", destinationProgressContentType)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	stream := &destinationProgressWriter{encoder: json.NewEncoder(w), flusher: flusher}
	input.Progress = func(progress LocalProofProgress) {
		if err := stream.write(localProofProgressEvent(progress)); err != nil {
			cancel()
		}
	}
	results, err := generator.GenerateDestinationProofs(ctx, input)
	if err != nil {
		if stream.failed() {
			return
		}
		_, code, message := errorMapping(err)
		_ = stream.write(DestinationProgressEvent{Type: "error", Code: code, Error: message})
		return
	}
	response := destinationProofResponse(input, results)
	_ = stream.write(DestinationProgressEvent{Type: "result", Result: &response})
}

type destinationProgressWriter struct {
	mu      sync.Mutex
	encoder *json.Encoder
	flusher http.Flusher
	err     error
}

func (w *destinationProgressWriter) failed() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.err != nil
}

func (w *destinationProgressWriter) write(event DestinationProgressEvent) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.err != nil {
		return w.err
	}
	w.err = w.encoder.Encode(event)
	if w.err == nil {
		w.flusher.Flush()
	}
	return w.err
}

func localProofProgressEvent(progress LocalProofProgress) DestinationProgressEvent {
	event := DestinationProgressEvent{
		Type:    "progress",
		Stage:   progress.Stage,
		Current: progress.Current,
		Total:   progress.Total,
	}
	if progress.Discovery != nil {
		event.Discovery = &DestinationDiscoveryProgress{
			CandidatesScanned:   progress.Discovery.Scanned,
			CandidatesTotal:     progress.Discovery.Total,
			CandidatesPerSecond: progress.Discovery.CandidatesPerSecond,
			ETASeconds:          progress.Discovery.ETA.Seconds(),
			Matched:             progress.Discovery.Matched,
			Targets:             progress.Discovery.Targets,
		}
	}
	return event
}

func (s *Server) handleShutdown(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.originAllowed(r.Header.Get("Origin")) {
		writeError(w, http.StatusForbidden, "origin_not_allowed", "This website is not allowed to use the local helper.")
		return
	}
	if !s.tokenAllowed(r.Header.Get(TokenHeader)) {
		writeError(w, http.StatusUnauthorized, "token_required", "The local helper is not paired with this browser.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"message": "Proof Helper is shutting down.",
	})
	if s.Shutdown != nil && s.shutdownCalled.CompareAndSwap(false, true) {
		go s.Shutdown()
	}
}

func (s *Server) originAllowed(origin string) bool {
	if _, ok := s.AllowedOrigins[origin]; ok {
		return true
	}
	if s.patternOriginAllowed(origin) {
		return true
	}
	return s.loopbackDevOriginAllowed(origin)
}

func (s *Server) patternOriginAllowed(origin string) bool {
	if len(s.originPatterns) == 0 {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := parsed.Hostname()
	port := parsed.Port()
	for _, pattern := range s.originPatterns {
		if pattern.scheme != parsed.Scheme || pattern.port != port {
			continue
		}
		if len(host) <= len(pattern.hostPrefix)+len(pattern.hostSuffix) {
			continue
		}
		if !strings.HasPrefix(host, pattern.hostPrefix) || !strings.HasSuffix(host, pattern.hostSuffix) {
			continue
		}
		wildcard := host[len(pattern.hostPrefix) : len(host)-len(pattern.hostSuffix)]
		// The wildcard stands for exactly one DNS label: non-empty and no dot,
		// so "app-*.example.com" can never match "app-x.evil.example.com".
		if wildcard == "" || strings.Contains(wildcard, ".") {
			continue
		}
		return true
	}
	return false
}

func (s *Server) loopbackDevOriginAllowed(origin string) bool {
	requestOrigin, err := url.Parse(origin)
	if err != nil || !isLoopbackOrigin(requestOrigin) {
		return false
	}
	for allowed := range s.AllowedOrigins {
		allowedOrigin, err := url.Parse(allowed)
		if err == nil && allowedOrigin.Scheme == requestOrigin.Scheme && isLoopbackOrigin(allowedOrigin) {
			return true
		}
	}
	return false
}

func isLoopbackOrigin(origin *url.URL) bool {
	if origin.Scheme != "http" && origin.Scheme != "https" {
		return false
	}
	switch origin.Hostname() {
	case "127.0.0.1", "localhost", "::1":
		return true
	default:
		return false
	}
}

func (s *Server) tokenAllowed(token string) bool {
	if s.Token == "" || token == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(s.Token)) == 1
}

func (s *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if s.originAllowed(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin, Access-Control-Request-Private-Network")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, "+TokenHeader)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
				w.Header().Set("Access-Control-Allow-Private-Network", "true")
			}
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) allowedOrigins() []string {
	origins := make([]string, 0, len(s.AllowedOrigins)+len(s.originPatterns))
	for origin := range s.AllowedOrigins {
		origins = append(origins, origin)
	}
	for _, pattern := range s.originPatterns {
		origins = append(origins, pattern.String())
	}
	sort.Strings(origins)
	return origins
}

func (p originPattern) String() string {
	host := p.hostPrefix + "*" + p.hostSuffix
	if p.port != "" {
		host += ":" + p.port
	}
	return p.scheme + "://" + host
}

func compatibilityForKey(key KeyStatus) string {
	if key.Ready {
		return "ready"
	}
	switch key.State {
	case "missing":
		return "key_missing"
	case "downloading":
		return "key_downloading"
	case "invalid":
		return "update_required"
	default:
		return "not_ready"
	}
}

func errorMapping(err error) (int, string, string) {
	if errors.Is(err, ErrPathNotFound) {
		return http.StatusNotFound, "path_not_found", "No matching credential was found in the searched account range."
	}
	if errors.Is(err, context.Canceled) {
		return http.StatusRequestTimeout, "request_cancelled", "The proof request was cancelled."
	}
	return http.StatusInternalServerError, "proof_failed", "The local helper could not generate the proof."
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, ErrorResponse{Code: code, Error: message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
