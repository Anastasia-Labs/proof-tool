package helper

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"sync/atomic"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/circuit/ownershipdest"
)

const TokenHeader = "X-Proof-Tool-Token"

type Server struct {
	Generator      Generator
	Token          string
	AllowedOrigins map[string]struct{}
	Shutdown       func()
	shutdownCalled atomic.Bool
}

type ErrorResponse struct {
	Code  string `json:"code"`
	Error string `json:"error"`
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
	for _, origin := range allowedOrigins {
		origin = strings.TrimSpace(origin)
		if origin != "" {
			origins[origin] = struct{}{}
		}
	}
	return &Server{Generator: generator, Token: token, AllowedOrigins: origins}
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
	input, err := BuildDestinationInput(req)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	results, err := generator.GenerateDestinationProofs(r.Context(), input)
	if err != nil {
		status, code, message := errorMapping(err)
		writeError(w, status, code, message)
		return
	}
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
	writeJSON(w, http.StatusOK, response)
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
	_, ok := s.AllowedOrigins[origin]
	return ok
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
		if _, ok := s.AllowedOrigins[origin]; ok {
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
	origins := make([]string, 0, len(s.AllowedOrigins))
	for origin := range s.AllowedOrigins {
		origins = append(origins, origin)
	}
	sort.Strings(origins)
	return origins
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
