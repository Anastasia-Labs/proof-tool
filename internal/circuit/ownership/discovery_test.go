package ownership

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"testing"

	"proof-tool/internal/circuit/ckd"
)

func TestDiscoverCredentialPathsBreadthFirstAndMultiTarget(t *testing.T) {
	master := mustDecodeHex(t, knownMaster)
	accountThree := credentialAt(t, master, Path{Account: 3, Role: 0, Index: 0})
	internalTwenty := credentialAt(t, master, Path{Account: 1, Role: 1, Index: 20})
	stakeZero := credentialAt(t, master, Path{Account: 2, Role: 2, Index: 0})
	var last DiscoveryProgress

	found, err := DiscoverCredentialPaths(
		context.Background(),
		master,
		[][]byte{accountThree[:], internalTwenty[:], stakeZero[:], accountThree[:]},
		DiscoveryOptions{Search: automaticSearch(9, 999), ProgressEvery: 1},
		func(progress DiscoveryProgress) { last = progress },
	)
	if err != nil {
		t.Fatal(err)
	}
	if got := found[accountThree]; got != (Path{Account: 3, Role: 0, Index: 0}) {
		t.Fatalf("account-three path = %+v", got)
	}
	if got := found[internalTwenty]; got != (Path{Account: 1, Role: 1, Index: 20}) {
		t.Fatalf("internal path = %+v", got)
	}
	if got := found[stakeZero]; got != (Path{Account: 2, Role: 2, Index: 0}) {
		t.Fatalf("stake path = %+v", got)
	}
	// Indexes 0..19 cover 20 indexes * 3 roles * 10 accounts. At index 20,
	// role 0 consumes 10 candidates and account 1 is the second role-1 entry.
	if last.Scanned != 612 {
		t.Fatalf("scanned = %d, want 612", last.Scanned)
	}
	if last.Total != 30_000 || last.Matched != 3 || last.Targets != 3 {
		t.Fatalf("unexpected final progress: %+v", last)
	}
}

func TestDiscoverCredentialPathsRandomizedMultiTarget(t *testing.T) {
	master := mustDecodeHex(t, knownMaster)
	rng := rand.New(rand.NewSource(0x5eed1852))
	for iteration := 0; iteration < 12; iteration++ {
		want := make(map[[28]byte]Path)
		targets := make([][]byte, 0, 7)
		for i := 0; i < 6; i++ {
			path := Path{
				Account: uint32(rng.Intn(10)),
				Role:    uint32(rng.Intn(3)),
				Index:   uint32(rng.Intn(101)),
			}
			credential := credentialAt(t, master, path)
			want[credential] = path
			targets = append(targets, append([]byte(nil), credential[:]...))
		}
		// Duplicate targets must not expand the work or result cardinality.
		targets = append(targets, append([]byte(nil), targets[0]...))
		got, err := DiscoverCredentialPaths(
			context.Background(), master, targets,
			DiscoveryOptions{Search: automaticSearch(9, 100)}, nil,
		)
		if err != nil {
			t.Fatalf("iteration %d: %v", iteration, err)
		}
		if len(got) != len(want) {
			t.Fatalf("iteration %d result size = %d, want %d", iteration, len(got), len(want))
		}
		for credential, path := range want {
			if got[credential] != path {
				t.Fatalf("iteration %d credential path = %+v, want %+v", iteration, got[credential], path)
			}
		}
	}
}

func TestDiscoverPaymentPathsFindsAccountThreeBeforeEarlierAccountHighIndexes(t *testing.T) {
	master := mustDecodeHex(t, knownMaster)
	target := credentialAt(t, master, Path{Account: 3, Role: 0, Index: 0})
	var last DiscoveryProgress

	_, err := DiscoverCredentialPaths(
		context.Background(),
		master,
		[][]byte{target[:]},
		DiscoveryOptions{Search: automaticSearch(9, 999), ProgressEvery: 1},
		func(progress DiscoveryProgress) { last = progress },
	)
	if err != nil {
		t.Fatal(err)
	}
	if last.Scanned != 4 {
		t.Fatalf("account 3 index 0 scanned %d candidates, want 4", last.Scanned)
	}
}

func TestDiscoverPaymentPathsBoundariesAndMiss(t *testing.T) {
	master := mustDecodeHex(t, knownMaster)
	for _, path := range []Path{
		{Account: 9, Role: 0, Index: 19},
		{Account: 0, Role: 1, Index: 20},
		{Account: 3, Role: 2, Index: 19},
		{Account: 4, Role: 0, Index: 99},
		{Account: 2, Role: 1, Index: 100},
	} {
		t.Run(pathString(path), func(t *testing.T) {
			target := credentialAt(t, master, path)
			found, err := DiscoverCredentialPaths(
				context.Background(), master, [][]byte{target[:]},
				DiscoveryOptions{Search: automaticSearch(9, 100)}, nil,
			)
			if err != nil {
				t.Fatal(err)
			}
			if got := found[target]; got != path {
				t.Fatalf("path = %+v, want %+v", got, path)
			}
		})
	}

	missing := make([]byte, 28)
	for i := range missing {
		missing[i] = 0xff
	}
	_, err := DiscoverCredentialPaths(
		context.Background(), master, [][]byte{missing},
		DiscoveryOptions{Search: automaticSearch(3, 20)}, nil,
	)
	if !errors.Is(err, ErrCredentialsNotFound) {
		t.Fatalf("miss error = %v", err)
	}
}

func TestDiscoverCredentialPathsInclusiveConfiguredMaximum(t *testing.T) {
	master := mustDecodeHex(t, knownMaster)
	path := Path{Account: 9, Role: 2, Index: 999}
	target := credentialAt(t, master, path)
	var last DiscoveryProgress
	found, err := DiscoverCredentialPaths(
		context.Background(), master, [][]byte{target[:]},
		DiscoveryOptions{Search: automaticSearch(9, 999)},
		func(progress DiscoveryProgress) { last = progress },
	)
	if err != nil {
		t.Fatal(err)
	}
	if got := found[target]; got != path {
		t.Fatalf("maximum path = %+v, want %+v", got, path)
	}
	if last.Scanned != 30_000 || last.Total != 30_000 || last.Matched != 1 || last.Targets != 1 {
		t.Fatalf("maximum progress = %+v", last)
	}
}

func TestDiscoverCredentialPathsProgressIsMonotonicAndBounded(t *testing.T) {
	master := mustDecodeHex(t, knownMaster)
	target := credentialAt(t, master, Path{Account: 4, Role: 2, Index: 20})
	var updates []DiscoveryProgress
	_, err := DiscoverCredentialPaths(
		context.Background(), master, [][]byte{target[:]},
		DiscoveryOptions{Search: automaticSearch(9, 100), ProgressEvery: 7},
		func(progress DiscoveryProgress) { updates = append(updates, progress) },
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(updates) < 2 {
		t.Fatalf("progress updates = %d", len(updates))
	}
	for i, update := range updates {
		if update.Scanned > update.Total || update.Matched > update.Targets || update.Targets != 1 {
			t.Fatalf("progress[%d] out of bounds: %+v", i, update)
		}
		if math.IsNaN(update.CandidatesPerSecond) || math.IsInf(update.CandidatesPerSecond, 0) || update.CandidatesPerSecond < 0 || update.ETA < 0 {
			t.Fatalf("progress[%d] has invalid rate/ETA: %+v", i, update)
		}
		if i > 0 && update.Scanned < updates[i-1].Scanned {
			t.Fatalf("progress regressed from %d to %d", updates[i-1].Scanned, update.Scanned)
		}
	}
	last := updates[len(updates)-1]
	if last.Matched != 1 || last.Scanned != 625 {
		t.Fatalf("final progress = %+v, want scanned=625 matched=1", last)
	}
}

func TestDiscoverPaymentPathsCancellation(t *testing.T) {
	master := mustDecodeHex(t, knownMaster)
	missing := make([]byte, 28)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var last DiscoveryProgress

	_, err := DiscoverCredentialPaths(
		ctx, master, [][]byte{missing},
		DiscoveryOptions{Search: automaticSearch(9, 999), ProgressEvery: 8},
		func(progress DiscoveryProgress) {
			last = progress
			if progress.Scanned >= 32 {
				cancel()
			}
		},
	)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation error = %v", err)
	}
	if last.Scanned != 32 {
		t.Fatalf("last scanned = %d, want 32", last.Scanned)
	}
}

func TestDiscoverCredentialPathsSupportsExplicitStakeRole(t *testing.T) {
	master := mustDecodeHex(t, knownMaster)
	target := credentialAt(t, master, Path{Account: 0, Role: 2, Index: 0})
	search := automaticSearch(9, 999)
	search.Role = 2
	found, err := DiscoverCredentialPaths(
		context.Background(), master, [][]byte{target[:]},
		DiscoveryOptions{Search: search}, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if got := found[target]; got != (Path{Account: 0, Role: 2, Index: 0}) {
		t.Fatalf("stake path = %+v", got)
	}
}

func TestDiscoverCredentialPathsRejectsDRepUntilCircuitUpgrade(t *testing.T) {
	master := mustDecodeHex(t, knownMaster)
	search := automaticSearch(9, 999)
	search.Role = 3
	_, err := DiscoverCredentialPaths(
		context.Background(), master, [][]byte{make([]byte, 28)},
		DiscoveryOptions{Search: search}, nil,
	)
	if err == nil || err.Error() != "role 3 is the DRep role but is not supported by the deployed proof circuit" {
		t.Fatalf("DRep role error = %v", err)
	}
}

func TestClearDiscoveryBranches(t *testing.T) {
	branches := []discoveryBranch{{account: 3, role: 1, parent: ckd.XPub{}}}
	for i := range branches[0].parent.PublicKey {
		branches[0].parent.PublicKey[i] = 0xaa
		branches[0].parent.ChainCode[i] = 0xbb
	}
	clearDiscoveryBranches(branches)
	if branches[0].account != 0 || branches[0].role != 0 {
		t.Fatalf("path metadata was not cleared: %+v", branches[0])
	}
	if branches[0].parent != (ckd.XPub{}) {
		t.Fatal("extended public key was not cleared")
	}
}

func BenchmarkDiscoverPaymentPathsAccountThreeIndexZero(b *testing.B) {
	master, _ := hex.DecodeString(knownMaster)
	target, _ := DeriveCredential(master, Path{Account: 3, Role: 0, Index: 0})
	opts := DiscoveryOptions{Search: automaticSearch(9, 999)}
	b.ResetTimer()
	b.ReportMetric(4, "candidates/op")
	for i := 0; i < b.N; i++ {
		if _, err := DiscoverCredentialPaths(context.Background(), master, [][]byte{target[:]}, opts, nil); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkDiscoverPaymentPathsFullMiss(b *testing.B) {
	master, _ := hex.DecodeString(knownMaster)
	missing := make([]byte, 28)
	opts := DiscoveryOptions{Search: automaticSearch(9, 999)}
	b.ResetTimer()
	b.ReportMetric(30_000, "candidates/op")
	for i := 0; i < b.N; i++ {
		_, err := DiscoverCredentialPaths(context.Background(), master, [][]byte{missing}, opts, nil)
		if !errors.Is(err, ErrCredentialsNotFound) {
			b.Fatal(err)
		}
	}
}

func BenchmarkLegacyDeriveCredentialRootToLeaf(b *testing.B) {
	master, _ := hex.DecodeString(knownMaster)
	path := Path{Account: 3, Role: 0, Index: 0}
	b.ResetTimer()
	b.ReportMetric(1, "candidates/op")
	for i := 0; i < b.N; i++ {
		if _, err := DeriveCredential(master, path); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkLegacyFindPathAccountThreeIndexZero(b *testing.B) {
	master, _ := hex.DecodeString(knownMaster)
	target, _ := DeriveCredential(master, Path{Account: 3, Role: 0, Index: 0})
	opts := automaticSearch(9, 999)
	b.ResetTimer()
	b.ReportMetric(9_001, "candidates/op")
	for i := 0; i < b.N; i++ {
		if _, err := FindPath(master, target[:], opts); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkLegacyFindPathFullMiss(b *testing.B) {
	master, _ := hex.DecodeString(knownMaster)
	missing := make([]byte, 28)
	opts := automaticSearch(9, 999)
	b.ResetTimer()
	b.ReportMetric(30_000, "candidates/op")
	for i := 0; i < b.N; i++ {
		if _, err := FindPath(master, missing, opts); err == nil {
			b.Fatal("legacy full miss unexpectedly found a path")
		}
	}
}

func automaticSearch(maxAccount, maxIndex uint32) SearchOptions {
	return SearchOptions{Account: -1, Role: -1, Index: -1, MaxAccount: maxAccount, MaxIndex: maxIndex}
}

func credentialAt(t testing.TB, master []byte, path Path) [28]byte {
	t.Helper()
	credential, err := DeriveCredential(master, path)
	if err != nil {
		t.Fatal(err)
	}
	return credential
}

func pathString(path Path) string {
	return fmt.Sprintf("account-%d-role-%d-index-%d", path.Account, path.Role, path.Index)
}
