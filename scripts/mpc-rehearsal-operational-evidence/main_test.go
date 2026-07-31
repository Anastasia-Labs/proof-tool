package main

import (
	"testing"
	"time"
)

func TestTwoInteriorTimestampsSupportsSubsecondAuthenticatedGap(t *testing.T) {
	lower := time.Date(2026, time.July, 23, 12, 0, 0, 0, time.UTC)
	upper := lower.Add(100 * time.Millisecond)
	firstText, secondText, err := twoInteriorTimestamps(lower, upper)
	if err != nil {
		t.Fatal(err)
	}
	first, err := time.Parse(time.RFC3339Nano, firstText)
	if err != nil {
		t.Fatal(err)
	}
	second, err := time.Parse(time.RFC3339Nano, secondText)
	if err != nil {
		t.Fatal(err)
	}
	if !first.After(lower) || !second.After(first) || !upper.After(second) {
		t.Fatalf("timestamps are not strictly interior: %s, %s", firstText, secondText)
	}
}

func TestTwoInteriorTimestampsRejectsUnrepresentableGap(t *testing.T) {
	lower := time.Date(2026, time.July, 23, 12, 0, 0, 0, time.UTC)
	if _, _, err := twoInteriorTimestamps(lower, lower.Add(2*time.Nanosecond)); err == nil {
		t.Fatal("two-nanosecond interval unexpectedly represented two strict interior instants")
	}
}
