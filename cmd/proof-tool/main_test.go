package main

import (
	"bytes"
	"encoding/json"
	"net/url"
	"testing"
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
}
