package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"strings"
	"testing"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownershipdest"
	"proof-tool/internal/circuit/ownershipmulti"
)

func TestPairedSiteURLUsesFragment(t *testing.T) {
	got, err := pairedSiteURL("https://proof.example/prove", "http://127.0.0.1:49152", "secret")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(got)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.RawQuery != "" {
		t.Fatalf("pairing data leaked into query: %s", parsed.RawQuery)
	}
	if parsed.String() != got {
		t.Fatalf("paired URL is not stable after parse: %q -> %q", got, parsed.String())
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	if fragment.Get("helper") != "http://127.0.0.1:49152" {
		t.Fatalf("helper fragment = %q", fragment.Get("helper"))
	}
	if fragment.Get("pair") != "secret" {
		t.Fatalf("pair fragment = %q", fragment.Get("pair"))
	}
	if fragment.Get("verifier") != "" {
		t.Fatalf("unexpected verifier fragment = %q", fragment.Get("verifier"))
	}
}

func TestOriginForURL(t *testing.T) {
	got, err := originForURL("https://proof.example/path#helper=nope")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://proof.example" {
		t.Fatalf("origin = %q", got)
	}
}

func TestWriteStartupJSON(t *testing.T) {
	var buf bytes.Buffer
	err := writeStartupJSON(&buf, helperStartupEvent{
		Type:             "proof_tool_helper_ready",
		HelperURL:        "http://127.0.0.1:49152",
		SiteURL:          "https://proof.example/prove",
		PairingURL:       "https://proof.example/prove#helper=http://127.0.0.1:49152&pair=secret",
		Token:            "secret",
		AllowedOrigins:   []string{"https://proof.example"},
		SidecarVersion:   "0.1.0",
		ProtocolVersion:  "proof-helper-v1",
		CircuitID:        "root-ownership-v1/bls12-381/groth16",
		KeyState:         "ready",
		KeyReady:         true,
		KeyVersion:       "ownership-v1",
		KeyHash:          "blake2b256:test",
		KeyCompatibility: "ready",
	})
	if err != nil {
		t.Fatal(err)
	}
	var decoded helperStartupEvent
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.HelperURL != "http://127.0.0.1:49152" || decoded.Token != "secret" {
		t.Fatalf("decoded startup = %+v", decoded)
	}
	if decoded.KeyCompatibility != "ready" || !decoded.KeyReady {
		t.Fatalf("decoded key status = %+v", decoded)
	}
	assertStartupPairingContract(t, decoded)
}

func TestServeHelperRejectsMissingSiteURL(t *testing.T) {
	err := cmdServeHelper([]string{"--addr", "127.0.0.1:0", "--fixture", "--no-open"})
	if err == nil || !strings.Contains(err.Error(), "--site-url is required") {
		t.Fatalf("err = %v", err)
	}
}

func TestServeHelperRejectsNonLoopbackBind(t *testing.T) {
	err := cmdServeHelper([]string{
		"--addr", "0.0.0.0:0",
		"--site-url", "https://proof.example/prove",
		"--fixture",
		"--no-open",
	})
	if err == nil || !strings.Contains(err.Error(), "must bind to loopback") {
		t.Fatalf("err = %v", err)
	}
}

func TestPathListFlagParsesRepeatedMultiPaths(t *testing.T) {
	var paths pathListFlag
	if err := paths.Set("0/0/0"); err != nil {
		t.Fatal(err)
	}
	if err := paths.Set("0,0,1"); err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeMultiPaths(paths, 2)
	if err != nil {
		t.Fatal(err)
	}
	if decoded[0].Account != 0 || decoded[0].Role != 0 || decoded[0].Index != 0 {
		t.Fatalf("path0 = %+v", decoded[0])
	}
	if decoded[1].Account != 0 || decoded[1].Role != 0 || decoded[1].Index != 1 {
		t.Fatalf("path1 = %+v", decoded[1])
	}
}

func TestValidateMultiProofArtifactRecomputesOrderedPublicInput(t *testing.T) {
	credentials := [][]byte{
		mustDecodeHex(t, "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4"),
		mustDecodeHex(t, "155a68f5db6e170a0f0c7d211c24dce882b23e18244f1f142a5fa377"),
	}
	destination := mustDecodeHex(t, "010038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da1110000000000000000000000000000000000000000000000000000000000")
	publicInput, err := ownershipmulti.PublicInputForCredentialsDestination(credentials, destination)
	if err != nil {
		t.Fatal(err)
	}
	valid := artifact.ProofArtifact{
		Schema:                     artifact.ProofSchema,
		CircuitID:                  ownershipmulti.CircuitID,
		VKHash:                     "blake2b256:test",
		TargetCredentials:          encodeHexList(credentials),
		DestinationAddressEncoding: ownershipmulti.DestinationAddressEncoding,
		DestinationAddress:         hex.EncodeToString(destination),
		CredentialCount:            ownershipmulti.CredentialCount,
		PublicInputEncoding:        ownershipmulti.PublicInputEncoding,
		PublicInput:                ownershipmulti.PublicInputHex(publicInput),
		Proof:                      "not-used-by-shape-validation",
	}
	if _, _, _, err := validateMultiProofArtifact(&valid); err != nil {
		t.Fatal(err)
	}

	reordered := valid
	reordered.TargetCredentials = []string{valid.TargetCredentials[1], valid.TargetCredentials[0]}
	if _, _, _, err := validateMultiProofArtifact(&reordered); err == nil || !strings.Contains(err.Error(), "public input") {
		t.Fatalf("reordered artifact error = %v", err)
	}

	changedDestination := valid
	changedDestination.DestinationAddress = "01" + strings.Repeat("00", 57)
	if _, _, _, err := validateMultiProofArtifact(&changedDestination); err == nil || !strings.Contains(err.Error(), "public input") {
		t.Fatalf("changed destination error = %v", err)
	}

	countOne := valid
	countOne.CircuitID = ownershipmulti.CircuitIDForCount(1)
	countOne.TargetCredentials = valid.TargetCredentials[:1]
	countOne.CredentialCount = 1
	countOnePub, err := ownershipmulti.PublicInputForCredentialsDestination(credentials[:1], destination)
	if err != nil {
		t.Fatal(err)
	}
	countOne.PublicInput = ownershipmulti.PublicInputHex(countOnePub)
	if _, _, gotCount, err := validateMultiProofArtifact(&countOne); err != nil {
		t.Fatal(err)
	} else if gotCount != 1 {
		t.Fatalf("validated count = %d, want 1", gotCount)
	}
}

func TestValidateDestinationProofArtifactRecomputesPublicInput(t *testing.T) {
	credential := mustDecodeHex(t, "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4")
	destination := mustDecodeHex(t, "010038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da1110000000000000000000000000000000000000000000000000000000000")
	publicInput, err := ownershipdest.PublicInputForCredentialDestination(credential, destination)
	if err != nil {
		t.Fatal(err)
	}
	valid := artifact.ProofArtifact{
		Schema:                     artifact.ProofSchema,
		CircuitID:                  ownershipdest.CircuitID,
		VKHash:                     "blake2b256:test",
		TargetCredential:           hex.EncodeToString(credential),
		DestinationAddressEncoding: ownershipdest.DestinationAddressEncoding,
		DestinationAddress:         hex.EncodeToString(destination),
		PublicInputEncoding:        ownershipdest.PublicInputEncoding,
		PublicInput:                ownershipdest.PublicInputHex(publicInput),
		Proof:                      "not-used-by-shape-validation",
	}
	if _, _, err := validateDestinationProofArtifact(&valid); err != nil {
		t.Fatal(err)
	}

	changedDestination := valid
	changedDestination.DestinationAddress = "01" + strings.Repeat("00", 57)
	if _, _, err := validateDestinationProofArtifact(&changedDestination); err == nil || !strings.Contains(err.Error(), "public input") {
		t.Fatalf("changed destination error = %v", err)
	}

	wrongEncoding := valid
	wrongEncoding.PublicInputEncoding = ownershipmulti.PublicInputEncoding
	if _, _, err := validateDestinationProofArtifact(&wrongEncoding); err == nil || !strings.Contains(err.Error(), "public input encoding") {
		t.Fatalf("wrong encoding error = %v", err)
	}
}

func assertStartupPairingContract(t *testing.T, event helperStartupEvent) {
	t.Helper()
	if event.Type != "proof_tool_helper_ready" {
		t.Fatalf("startup event type = %q", event.Type)
	}
	if event.Token == "" {
		t.Fatal("startup token is empty")
	}
	helperURL, err := url.Parse(event.HelperURL)
	if err != nil {
		t.Fatalf("helper URL: %v", err)
	}
	if helperURL.Scheme != "http" || helperURL.Hostname() != "127.0.0.1" {
		t.Fatalf("helper URL is not loopback http: %s", event.HelperURL)
	}

	siteOrigin, err := originForURL(event.SiteURL)
	if err != nil {
		t.Fatalf("site origin: %v", err)
	}
	if len(event.AllowedOrigins) != 1 || event.AllowedOrigins[0] != siteOrigin {
		t.Fatalf("allowed origins = %+v, want %q", event.AllowedOrigins, siteOrigin)
	}

	pairedURL, err := url.Parse(event.PairingURL)
	if err != nil {
		t.Fatalf("pairing URL: %v", err)
	}
	if pairedURL.RawQuery != "" {
		t.Fatalf("pairing data leaked into query: %s", pairedURL.RawQuery)
	}
	fragment, err := url.ParseQuery(pairedURL.Fragment)
	if err != nil {
		t.Fatalf("pairing fragment: %v", err)
	}
	if got := fragment.Get("helper"); got != event.HelperURL {
		t.Fatalf("fragment helper = %q, want %q", got, event.HelperURL)
	}
	if got := fragment.Get("pair"); got != event.Token {
		t.Fatalf("fragment pair = %q, want token", got)
	}
}

func mustDecodeHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
