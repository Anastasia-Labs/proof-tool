package mpcceremony

import (
	"strings"
	"testing"
	"time"
)

func TestValidateCloseCommitTimeBoundaries(t *testing.T) {
	t.Parallel()

	roundTime := time.Date(2026, 7, 24, 12, 0, 0, 0, time.UTC)
	const minimumLead uint32 = 300
	requiredLead := time.Duration(minimumLead)*time.Second + closePublicationSafetyMargin
	closedAt := roundTime.Add(-requiredLead - time.Second)

	if err := validateCloseCommitTime(
		closedAt,
		roundTime.Add(-requiredLead),
		roundTime,
		minimumLead,
	); err != nil {
		t.Fatalf("exact publication boundary rejected: %v", err)
	}
	if err := validateCloseCommitTime(
		closedAt,
		roundTime.Add(-requiredLead+time.Nanosecond),
		roundTime,
		minimumLead,
	); err == nil || !strings.Contains(err.Error(), "below required") {
		t.Fatalf("publication below boundary error = %v, want lead rejection", err)
	}
}

func TestValidateCloseCommitTimeRejectsClockRollbackAndZeroTimes(t *testing.T) {
	t.Parallel()

	roundTime := time.Date(2026, 7, 24, 12, 0, 0, 0, time.UTC)
	closedAt := roundTime.Add(-time.Hour)
	if err := validateCloseCommitTime(
		closedAt,
		closedAt.Add(-time.Nanosecond),
		roundTime,
		300,
	); err == nil || !strings.Contains(err.Error(), "moved backwards") {
		t.Fatalf("clock rollback error = %v, want rollback rejection", err)
	}
	if err := validateCloseCommitTime(
		time.Time{},
		closedAt,
		roundTime,
		300,
	); err == nil || !strings.Contains(err.Error(), "zero time") {
		t.Fatalf("zero closed_at error = %v, want zero-time rejection", err)
	}
	if err := validateCloseCommitTime(
		closedAt,
		time.Time{},
		roundTime,
		300,
	); err == nil || !strings.Contains(err.Error(), "zero time") {
		t.Fatalf("zero commit time error = %v, want zero-time rejection", err)
	}
}
