package helper

import (
	"errors"
	"fmt"
	"io/fs"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/consensys/gnark/constraint"

	"proof-tool/internal/artifact"
	"proof-tool/internal/prover"
)

func stubGenerator(t *testing.T, ttl time.Duration) (*OwnershipGenerator, *atomic.Int32, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	bundleLoads := &atomic.Int32{}
	ccsLoads := &atomic.Int32{}
	compiles := &atomic.Int32{}
	g := &OwnershipGenerator{
		DestinationKeysDir:    t.TempDir(),
		DestinationKeyIdleTTL: ttl,
		loadDestinationProver: func(string) (*prover.OwnershipBundle, error) {
			bundleLoads.Add(1)
			return &prover.OwnershipBundle{Manifest: &artifact.KeyManifest{}}, nil
		},
		loadDestinationCCS: func(string, *artifact.KeyManifest) (constraint.ConstraintSystem, error) {
			ccsLoads.Add(1)
			return nil, nil
		},
		compileDestination: func() (constraint.ConstraintSystem, error) {
			compiles.Add(1)
			return nil, nil
		},
	}
	return g, bundleLoads, ccsLoads, compiles
}

func TestAcquireDestinationProverLoadsOnceAcrossConcurrentRequests(t *testing.T) {
	g, bundleLoads, ccsLoads, compiles := stubGenerator(t, time.Hour)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := g.acquireDestinationProver(); err != nil {
				t.Errorf("acquire: %v", err)
			}
		}()
	}
	wg.Wait()
	if got := bundleLoads.Load(); got != 1 {
		t.Fatalf("bundle loaded %d times, want 1", got)
	}
	if got := ccsLoads.Load(); got != 1 {
		t.Fatalf("frozen ccs loaded %d times, want 1", got)
	}
	if got := compiles.Load(); got != 0 {
		t.Fatalf("compile fallback ran %d times, want 0 when frozen ccs loads", got)
	}
}

func TestAcquireDestinationProverEvictsAfterIdleTTLAndReloads(t *testing.T) {
	g, bundleLoads, _, _ := stubGenerator(t, 30*time.Millisecond)
	if _, _, err := g.acquireDestinationProver(); err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		g.mu.Lock()
		evicted := g.destCache == nil
		g.mu.Unlock()
		if evicted {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cache was not evicted after idle TTL")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, _, err := g.acquireDestinationProver(); err != nil {
		t.Fatalf("acquire after evict: %v", err)
	}
	if got := bundleLoads.Load(); got != 2 {
		t.Fatalf("bundle loaded %d times, want 2 (reload after eviction)", got)
	}
}

func TestAcquireDestinationProverFallsBackToCompileWhenCCSAbsent(t *testing.T) {
	g, _, _, compiles := stubGenerator(t, time.Hour)
	g.loadDestinationCCS = func(string, *artifact.KeyManifest) (constraint.ConstraintSystem, error) {
		return nil, fmt.Errorf("frozen constraint system: %w", fs.ErrNotExist)
	}
	if _, _, err := g.acquireDestinationProver(); err != nil {
		t.Fatalf("acquire with absent ccs: %v", err)
	}
	if got := compiles.Load(); got != 1 {
		t.Fatalf("compile fallback ran %d times, want 1", got)
	}
}

func TestAcquireDestinationProverRejectsCorruptFrozenCCS(t *testing.T) {
	g, _, _, compiles := stubGenerator(t, time.Hour)
	hashErr := errors.New("constraint system hash mismatch")
	g.loadDestinationCCS = func(string, *artifact.KeyManifest) (constraint.ConstraintSystem, error) {
		return nil, hashErr
	}
	if _, _, err := g.acquireDestinationProver(); !errors.Is(err, hashErr) {
		t.Fatalf("acquire with corrupt ccs err = %v, want the hash mismatch to surface", err)
	}
	if got := compiles.Load(); got != 0 {
		t.Fatalf("compile fallback ran %d times, want 0: a corrupt frozen ccs must be a hard error", got)
	}
}
