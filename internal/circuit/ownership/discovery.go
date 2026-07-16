package ownership

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"time"

	"golang.org/x/crypto/blake2b"

	"proof-tool/internal/circuit/ckd"
)

// ErrCredentialsNotFound deliberately omits target values and paths so
// it is safe to sanitize and surface across a local worker boundary.
var ErrCredentialsNotFound = errors.New("one or more credentials were not found in the configured CIP-1852 search range")

// ErrPaymentCredentialsNotFound is retained for callers compiled against the
// initial discovery API. Reclaim targets may also be stake credentials, so new
// code should use ErrCredentialsNotFound.
var ErrPaymentCredentialsNotFound = ErrCredentialsNotFound

// DiscoveryOptions configures automatic credential-key discovery. Account and
// index limits retain the existing SearchOptions meaning; an unspecified role
// searches the roles supported by the deployed proof circuit: external
// payment (0), internal payment (1), then staking (2). Role 3 is the CIP-105
// DRep chain, but the current circuit and proving-key bundle do not accept it.
type DiscoveryOptions struct {
	Search SearchOptions
	// ProgressEvery bounds callback overhead. Zero selects the production
	// default. Context cancellation is checked for every candidate regardless.
	ProgressEvery uint64
}

// DiscoveryProgress contains only aggregate, non-secret measurements. It must
// never grow account, role, index, credential, or key fields.
type DiscoveryProgress struct {
	Scanned             uint64
	Total               uint64
	Matched             uint64
	Targets             uint64
	Elapsed             time.Duration
	CandidatesPerSecond float64
	ETA                 time.Duration
}

// DiscoveryProgressFunc receives aggregate progress from the local discovery
// engine. Implementations must return quickly and must not persist inferred
// path metadata.
type DiscoveryProgressFunc func(DiscoveryProgress)

type discoveryBranch struct {
	account uint32
	role    uint32
	parent  ckd.XPub
}

type indexBand struct {
	start uint32
	end   uint32
}

// DiscoverCredentialPaths resolves all distinct target credentials in a
// single staged traversal. Shared hardened prefixes are derived once, and the
// soft role/index subtree is traversed from public extended keys. Every match
// is re-derived through DeriveCredential before its path is returned.
func DiscoverCredentialPaths(
	ctx context.Context,
	masterXPrv []byte,
	targetCredentials [][]byte,
	opts DiscoveryOptions,
	onProgress DiscoveryProgressFunc,
) (map[[28]byte]Path, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if len(masterXPrv) != 96 {
		return nil, fmt.Errorf("master xprv is %d bytes, want 96", len(masterXPrv))
	}
	remaining := make(map[[28]byte]struct{}, len(targetCredentials))
	for _, raw := range targetCredentials {
		if len(raw) != 28 {
			return nil, fmt.Errorf("target credential is %d bytes, want 28", len(raw))
		}
		var credential [28]byte
		copy(credential[:], raw)
		remaining[credential] = struct{}{}
	}
	if len(remaining) == 0 {
		return map[[28]byte]Path{}, nil
	}

	accounts, roles, bands, total, err := discoverySchedule(opts.Search)
	if err != nil {
		return nil, err
	}
	branches, err := prepareDiscoveryBranches(masterXPrv, accounts, roles)
	if err != nil {
		return nil, err
	}
	defer clearDiscoveryBranches(branches)

	progressEvery := opts.ProgressEvery
	if progressEvery == 0 {
		progressEvery = 32
	}
	started := time.Now()
	scanned := uint64(0)
	found := make(map[[28]byte]Path, len(remaining))
	emitDiscoveryProgress(onProgress, started, scanned, total, uint64(len(found)), uint64(len(remaining)+len(found)))

	hasher, err := blake2b.New(28, nil)
	if err != nil {
		return nil, fmt.Errorf("create credential hash: %w", err)
	}
	var digestBuffer [28]byte
	for _, band := range bands {
		for index := band.start; index <= band.end; index++ {
			for _, branch := range branches {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				child, err := ckd.DerivePublicChild(branch.parent, index)
				if err != nil {
					return nil, fmt.Errorf("derive credential candidate: %w", err)
				}
				hasher.Reset()
				_, _ = hasher.Write(child.PublicKey[:])
				digest := hasher.Sum(digestBuffer[:0])
				var credential [28]byte
				copy(credential[:], digest)
				scanned++

				if _, wanted := remaining[credential]; wanted {
					path := Path{Account: branch.account, Role: branch.role, Index: index}
					canonical, err := DeriveCredential(masterXPrv, path)
					if err != nil {
						return nil, fmt.Errorf("re-verify discovered path: %w", err)
					}
					if subtle.ConstantTimeCompare(canonical[:], credential[:]) != 1 {
						return nil, errors.New("optimized discovery disagreed with canonical credential derivation")
					}
					found[credential] = path
					delete(remaining, credential)
					if len(remaining) == 0 {
						emitDiscoveryProgress(onProgress, started, scanned, total, uint64(len(found)), uint64(len(found)))
						return found, nil
					}
				}

				if scanned%progressEvery == 0 {
					emitDiscoveryProgress(onProgress, started, scanned, total, uint64(len(found)), uint64(len(remaining)+len(found)))
				}
			}
			if index == ^uint32(0) {
				break
			}
		}
		emitDiscoveryProgress(onProgress, started, scanned, total, uint64(len(found)), uint64(len(remaining)+len(found)))
	}
	return found, ErrCredentialsNotFound
}

// DiscoverCredentialPath is the single-target convenience form used by local
// CLI flows. Batch callers should use DiscoverCredentialPaths so all targets
// share one traversal.
func DiscoverCredentialPath(
	ctx context.Context,
	masterXPrv, targetCredential []byte,
	opts DiscoveryOptions,
	onProgress DiscoveryProgressFunc,
) (Path, error) {
	paths, err := DiscoverCredentialPaths(
		ctx, masterXPrv, [][]byte{targetCredential}, opts, onProgress,
	)
	if err != nil {
		return Path{}, err
	}
	var key [28]byte
	copy(key[:], targetCredential)
	path, ok := paths[key]
	if !ok {
		return Path{}, ErrCredentialsNotFound
	}
	return path, nil
}

// DiscoverPaymentPaths is a compatibility wrapper. The proof statement is a
// 28-byte key credential and the deployed circuit also supports CIP-1852 role
// 2, so the more accurate name is DiscoverCredentialPaths.
func DiscoverPaymentPaths(
	ctx context.Context,
	masterXPrv []byte,
	targetCredentials [][]byte,
	opts DiscoveryOptions,
	onProgress DiscoveryProgressFunc,
) (map[[28]byte]Path, error) {
	return DiscoverCredentialPaths(ctx, masterXPrv, targetCredentials, opts, onProgress)
}

func discoverySchedule(search SearchOptions) ([]uint32, []uint32, []indexBand, uint64, error) {
	accounts, err := scanValues(search.Account, 0, search.MaxAccount, "account", 1<<31-1)
	if err != nil {
		return nil, nil, nil, 0, err
	}
	var roles []uint32
	switch search.Role {
	case -1:
		roles = []uint32{0, 1, 2}
	case 0, 1, 2:
		roles = []uint32{uint32(search.Role)}
	case 3:
		return nil, nil, nil, 0, errors.New("role 3 is the DRep role but is not supported by the deployed proof circuit")
	default:
		return nil, nil, nil, 0, fmt.Errorf("role %d outside deployed proof-circuit role range 0..2", search.Role)
	}
	bands, indexCount, err := discoveryIndexBands(search)
	if err != nil {
		return nil, nil, nil, 0, err
	}
	total := uint64(len(accounts)) * uint64(len(roles)) * indexCount
	return accounts, roles, bands, total, nil
}

func discoveryIndexBands(search SearchOptions) ([]indexBand, uint64, error) {
	if search.Index >= 0 {
		if search.Index >= 1<<31 {
			return nil, 0, fmt.Errorf("index %d outside allowed range 0..%d", search.Index, uint32(1<<31-1))
		}
		value := uint32(search.Index)
		return []indexBand{{start: value, end: value}}, 1, nil
	}
	ends := []uint32{19, 99, search.MaxIndex}
	bands := make([]indexBand, 0, len(ends))
	start := uint32(0)
	for _, candidateEnd := range ends {
		end := candidateEnd
		if end > search.MaxIndex {
			end = search.MaxIndex
		}
		if end < start {
			continue
		}
		bands = append(bands, indexBand{start: start, end: end})
		if end == search.MaxIndex || end == ^uint32(0) {
			break
		}
		start = end + 1
	}
	return bands, uint64(search.MaxIndex) + 1, nil
}

func prepareDiscoveryBranches(masterXPrv []byte, accounts, roles []uint32) ([]discoveryBranch, error) {
	root, err := ckd.RootExt(masterXPrv)
	if err != nil {
		return nil, err
	}
	purpose := ckd.DerivePrivateChild(root, 1<<31|1852, true)
	coin := ckd.DerivePrivateChild(purpose, 1<<31|1815, true)
	clearExt(&root)
	clearExt(&purpose)
	defer clearExt(&coin)

	byAccount := make(map[uint32]ckd.XPub, len(accounts))
	defer func() {
		for account, public := range byAccount {
			clear(public.PublicKey[:])
			clear(public.ChainCode[:])
			byAccount[account] = ckd.XPub{}
			delete(byAccount, account)
		}
	}()
	for _, account := range accounts {
		accountPrivate := ckd.DerivePrivateChild(coin, 1<<31|account, true)
		accountPublic, err := ckd.XPubFromPrivate(accountPrivate)
		clearExt(&accountPrivate)
		if err != nil {
			return nil, fmt.Errorf("derive account public key: %w", err)
		}
		byAccount[account] = accountPublic
	}

	// Role-major order searches external payment keys for every account, then
	// internal/change keys, then staking keys at the same index.
	branches := make([]discoveryBranch, 0, len(accounts)*len(roles))
	completed := false
	defer func() {
		if !completed {
			clearDiscoveryBranches(branches)
		}
	}()
	for _, role := range roles {
		for _, account := range accounts {
			rolePublic, err := ckd.DerivePublicChild(byAccount[account], role)
			if err != nil {
				return nil, fmt.Errorf("derive credential role public key: %w", err)
			}
			branches = append(branches, discoveryBranch{account: account, role: role, parent: rolePublic})
		}
	}
	completed = true
	return branches, nil
}

func emitDiscoveryProgress(
	callback DiscoveryProgressFunc,
	started time.Time,
	scanned, total, matched, targets uint64,
) {
	if callback == nil {
		return
	}
	elapsed := time.Since(started)
	rate := float64(0)
	eta := time.Duration(0)
	if scanned > 0 && elapsed > 0 {
		rate = float64(scanned) / elapsed.Seconds()
		if scanned < total && rate > 0 {
			eta = time.Duration(float64(total-scanned) / rate * float64(time.Second))
		}
	}
	callback(DiscoveryProgress{
		Scanned:             scanned,
		Total:               total,
		Matched:             matched,
		Targets:             targets,
		Elapsed:             elapsed,
		CandidatesPerSecond: rate,
		ETA:                 eta,
	})
}

func clearExt(value *ckd.Ext) {
	clear(value.KL[:])
	clear(value.KR[:])
	clear(value.CC[:])
}

func clearDiscoveryBranches(branches []discoveryBranch) {
	for i := range branches {
		clear(branches[i].parent.PublicKey[:])
		clear(branches[i].parent.ChainCode[:])
		branches[i].account = 0
		branches[i].role = 0
	}
}
