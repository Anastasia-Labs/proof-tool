package strictjson

import (
	"strings"
	"testing"
)

func TestUnmarshalRejectsAmbiguousOrTrailingJSON(t *testing.T) {
	type record struct {
		Name string `json:"name"`
	}
	for name, input := range map[string]string{
		"duplicate": `{"name":"first","name":"second"}`,
		"unknown":   `{"name":"first","extra":true}`,
		"trailing":  `{"name":"first"}{"name":"second"}`,
	} {
		t.Run(name, func(t *testing.T) {
			var got record
			if err := Unmarshal([]byte(input), &got); err == nil {
				t.Fatalf("accepted %s JSON", name)
			}
		})
	}
	var got record
	if err := Unmarshal([]byte(" \n{\"name\":\"ok\"}\n"), &got); err != nil {
		t.Fatalf("valid strict JSON failed: %v", err)
	}
	if got.Name != "ok" {
		t.Fatalf("decoded name %q", got.Name)
	}
}

func TestUnmarshalProjectionAllowsUnknownButRejectsDuplicate(t *testing.T) {
	type projection struct {
		Name string `json:"name"`
	}
	var got projection
	if err := UnmarshalProjection([]byte(`{"name":"ok","documented_elsewhere":true}`), &got); err != nil {
		t.Fatalf("projection decode failed: %v", err)
	}
	if got.Name != "ok" {
		t.Fatalf("decoded name %q", got.Name)
	}
	if err := UnmarshalProjection([]byte(`{"name":"first","name":"second"}`), &got); err == nil {
		t.Fatal("projection accepted duplicate key")
	}
}

func TestUnmarshalRejectsExcessiveDepth(t *testing.T) {
	type record struct {
		Value any `json:"value"`
	}
	input := `{"value":` + strings.Repeat(`[`, maxDepth+1) + `null` + strings.Repeat(`]`, maxDepth+1) + `}`
	var got record
	if err := Unmarshal([]byte(input), &got); err == nil || !strings.Contains(err.Error(), "maximum depth") {
		t.Fatalf("expected depth rejection, got %v", err)
	}
}
