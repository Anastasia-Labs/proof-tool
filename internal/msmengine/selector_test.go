package msmengine

import (
	"errors"
	"testing"

	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"
)

func TestW7WorkerAcknowledgementRejectsLegacyWorkerFalsePass(t *testing.T) {
	// The signed production Worker predates W7 and returns ordinary kernel
	// timings without w7_applied. Request echoing must not qualify that Worker.
	legacyTimings := map[string]any{"kernel_ms": float64(12)}
	err := validateW7WorkerAcknowledgement(true, legacyTimings)
	var failClosedErr *FailClosedError
	if !errors.As(err, &failClosedErr) || failClosedErr.Class != "w7-worker-capability" {
		t.Fatalf("legacy Worker acknowledgement = %v, want w7-worker-capability", err)
	}

	if err := validateW7WorkerAcknowledgement(false, legacyTimings); err != nil {
		t.Fatalf("default-false W7 rejected a legacy Worker: %v", err)
	}
	if err := validateW7WorkerAcknowledgement(true, map[string]any{"w7_applied": float64(1)}); err != nil {
		t.Fatalf("candidate Worker acknowledgement rejected: %v", err)
	}
}

// failingEngine is an MSMEngine whose MSM methods always return an error.
// Used to exercise WithFallback's demotion path without doing real math.
type failingEngine struct{}

func (failingEngine) Name() string { return "failing" }
func (failingEngine) MSMG1(_ *bls12381.G1Jac, _ []bls12381.G1Affine, _ []fr.Element, _ ProgressFn) error {
	return errors.New("failingEngine: MSMG1 always fails")
}
func (failingEngine) MSMG2(_ *bls12381.G2Jac, _ []bls12381.G2Affine, _ []fr.Element, _ ProgressFn) error {
	return errors.New("failingEngine: MSMG2 always fails")
}
func (failingEngine) MSMG1Ranged(_ *bls12381.G1Jac, _ int, _ FetchG1, _ []fr.Element, _ ProgressFn) error {
	return errors.New("failingEngine: MSMG1Ranged always fails")
}
func (failingEngine) MSMG2Ranged(_ *bls12381.G2Jac, _ int, _ FetchG2, _ []fr.Element, _ ProgressFn) error {
	return errors.New("failingEngine: MSMG2Ranged always fails")
}
func (failingEngine) Close() error { return nil }

// TestWithFallbackDemotesOnError verifies that when the primary engine returns
// an error the fallback retries with cpuMSM{} and the retry's nil error is
// returned (not the original error). The final value of used must be "cpu".
func TestWithFallbackDemotesOnError(t *testing.T) {
	used := ""
	err := WithFallback(failingEngine{}, func(e MSMEngine) error {
		used = e.Name()
		if _, ok := e.(failingEngine); ok {
			return errors.New("boom")
		}
		return nil
	})
	if err != nil || used != "cpu" {
		t.Fatalf("want demote to cpu with nil err, got used=%s err=%v", used, err)
	}
}

func TestWithFallbackDoesNotDemoteAuthenticatedTransportFailure(t *testing.T) {
	runs := 0
	err := WithFallback(failingEngine{}, func(MSMEngine) error {
		runs++
		return failClosed("chunk-digest-mismatch", errors.New("tampered chunk"))
	})
	if runs != 1 {
		t.Fatalf("fail-closed error ran %d attempts, want 1", runs)
	}
	var failClosedErr *FailClosedError
	if !errors.As(err, &failClosedErr) || failClosedErr.Class != "chunk-digest-mismatch" {
		t.Fatalf("got %v, want chunk-digest-mismatch FailClosedError", err)
	}
}

func TestWithFallbackReloadPreparesCPUAttempt(t *testing.T) {
	reloads := 0
	runs := 0
	err := WithFallbackReload(failingEngine{}, func() error {
		reloads++
		return nil
	}, func(e MSMEngine) error {
		runs++
		if e.Name() == "failing" {
			return errors.New("primary failed after solve")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if reloads != 1 || runs != 2 {
		t.Fatalf("reloads=%d runs=%d, want 1 and 2", reloads, runs)
	}
}

func TestWithFallbackReloadFailurePreservesPrimaryAndReloadErrors(t *testing.T) {
	primaryErr := errors.New("primary post-solve failure")
	reloadErr := errors.New("hash-pinned CCS reload failure")
	runs := 0
	err := WithFallbackReload(failingEngine{}, func() error {
		return reloadErr
	}, func(MSMEngine) error {
		runs++
		return primaryErr
	})
	if runs != 1 {
		t.Fatalf("run called %d times, want primary only", runs)
	}
	if !errors.Is(err, primaryErr) || !errors.Is(err, reloadErr) {
		t.Fatalf("error chain %v does not preserve primary=%v and reload=%v", err, primaryErr, reloadErr)
	}
}

func TestWithFallbackRetryFailurePreservesBothAttemptErrors(t *testing.T) {
	primaryErr := errors.New("primary failure")
	retryErr := errors.New("retry failure")
	runs := 0
	err := WithFallbackReload(failingEngine{}, nil, func(MSMEngine) error {
		runs++
		if runs == 1 {
			return primaryErr
		}
		return retryErr
	})
	if !errors.Is(err, primaryErr) || !errors.Is(err, retryErr) {
		t.Fatalf("error chain %v does not preserve primary=%v and retry=%v", err, primaryErr, retryErr)
	}
}

func TestClassifySectionWorkerError(t *testing.T) {
	for _, tc := range []struct {
		message string
		class   string
	}{
		{"chunk 7 sha256 mismatch", "chunk-digest-mismatch"},
		{"TypeError: Failed to fetch", "range-fetch-aborted"},
		{"worker terminated", "worker-terminated"},
		{"unexpected decode failure", "sharded-worker-error"},
	} {
		var got *FailClosedError
		if err := classifySectionWorkerError(errors.New(tc.message)); !errors.As(err, &got) || got.Class != tc.class {
			t.Fatalf("classify %q = %v, want %s", tc.message, err, tc.class)
		}
	}
}

func TestWorkerResultIntegrityErrorsDoNotDemote(t *testing.T) {
	for _, primaryErr := range []error{
		workerReplyIntegrityError(7, 3),
		workerPartialIntegrityError(errors.New("invalid compressed point")),
		validateW7WorkerAcknowledgement(true, map[string]any{}),
	} {
		runs := 0
		err := WithFallback(failingEngine{}, func(MSMEngine) error {
			runs++
			return primaryErr
		})
		if runs != 1 {
			t.Fatalf("%v ran %d attempts, want 1", primaryErr, runs)
		}
		var failClosedErr *FailClosedError
		if !errors.As(err, &failClosedErr) {
			t.Fatalf("%v is not fail-closed", err)
		}
	}
}
