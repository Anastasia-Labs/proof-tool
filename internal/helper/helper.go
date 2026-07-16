package helper

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/consensys/gnark/constraint"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/circuit/ownershipdest"
	"proof-tool/internal/prover"
)

var ErrPathNotFound = errors.New("target credential not found")

const (
	ProtocolVersion = "proof-helper-v1"
	SidecarVersion  = "0.1.0"

	DestinationProfileSingle       = "single-destination"
	DestinationPreflightCapability = "prove-destination-preflight-v1"
)

type ProveRequest struct {
	MasterXPrvBase64 string  `json:"master_xprv_base64"`
	TargetCredential string  `json:"target_credential"`
	Account          *uint32 `json:"account,omitempty"`
	Role             *uint32 `json:"role,omitempty"`
	Index            *uint32 `json:"index,omitempty"`
	MaxAccount       *uint32 `json:"max_account,omitempty"`
	MaxIndex         *uint32 `json:"max_index,omitempty"`
	IncludeDebugPath bool    `json:"include_debug_path,omitempty"`
}

type ProveInput struct {
	MasterXPrv       []byte
	TargetCredential []byte
	Search           ownership.SearchOptions
	IncludeDebugPath bool
	Progress         LocalProofProgressFunc
}

// LocalProofProgress is deliberately aggregate-only. It crosses the local
// helper's loopback boundary and must never grow credential, path, or key
// fields.
type LocalProofProgress struct {
	Stage     string
	Current   uint64
	Total     uint64
	Discovery *ownership.DiscoveryProgress
}

type LocalProofProgressFunc func(LocalProofProgress)

type ProveResponse struct {
	Artifact      artifact.ProofArtifact  `json:"artifact"`
	DebugArtifact *artifact.ProofArtifact `json:"debug_artifact,omitempty"`
}

type ProveDestinationRequest struct {
	PreflightOnly    bool                      `json:"preflight_only,omitempty"`
	MasterXPrvBase64 string                    `json:"master_xprv_base64"`
	Profile          string                    `json:"profile"`
	Requests         []DestinationProofRequest `json:"requests"`
	Search           *DestinationSearchRequest `json:"search,omitempty"`
	IncludeDebugPath bool                      `json:"include_debug_path,omitempty"`
}

type ProveDestinationPreflightResponse struct {
	OK         bool   `json:"ok"`
	Capability string `json:"capability"`
}

type DestinationProofRequest struct {
	OutRef                     string `json:"out_ref"`
	TargetCredential           string `json:"target_credential"`
	DestinationAddressEncoding string `json:"destination_address_encoding"`
	DestinationAddress         string `json:"destination_address"`
}

type DestinationSearchRequest struct {
	MaxAccount *uint32 `json:"max_account,omitempty"`
	MaxIndex   *uint32 `json:"max_index,omitempty"`
}

type ProveDestinationInput struct {
	MasterXPrv       []byte
	Profile          string
	Requests         []DestinationProofInput
	Search           ownership.SearchOptions
	IncludeDebugPath bool
	Progress         LocalProofProgressFunc
}

type DestinationProofInput struct {
	OutRef                     string
	TargetCredential           []byte
	DestinationAddressEncoding string
	DestinationAddress         []byte
}

type ProveDestinationResponse struct {
	Profile   string                         `json:"profile"`
	Artifacts []DestinationProofArtifactItem `json:"artifacts"`
}

type DestinationProofArtifactItem struct {
	OutRef   string                 `json:"out_ref"`
	Artifact artifact.ProofArtifact `json:"artifact"`
}

type Generator interface {
	GenerateProof(ctx context.Context, input ProveInput) (artifact.ProofArtifact, error)
}

type DestinationGenerator interface {
	GenerateDestinationProofs(ctx context.Context, input ProveDestinationInput) ([]DestinationProofArtifactItem, error)
}

type KeyStatusReporter interface {
	KeyStatus() KeyStatus
}

type DestinationKeyStatusReporter interface {
	DestinationKeyStatus() KeyStatus
}

type KeyStatus struct {
	State      string `json:"state"`
	Ready      bool   `json:"ready"`
	KeyVersion string `json:"key_version,omitempty"`
	VKHash     string `json:"vk_hash,omitempty"`
	Error      string `json:"error,omitempty"`
}

// defaultDestinationKeyIdleTTL is how long the loaded destination proving
// bundle and frozen constraint system stay cached in memory after the last
// request. Within the window repeat proofs skip the ~10 s proving-key load;
// after it the ~2-3 GiB of key material is released back to the OS.
const defaultDestinationKeyIdleTTL = 10 * time.Minute

type OwnershipGenerator struct {
	KeysDir            string
	DestinationKeysDir string
	AllowCreateKeys    bool

	// DestinationKeyIdleTTL overrides defaultDestinationKeyIdleTTL when > 0.
	DestinationKeyIdleTTL time.Duration

	mu        sync.Mutex
	destCache *destinationProverCache

	// Test seams; nil means the production implementations.
	loadDestinationProver func(dir string) (*prover.OwnershipBundle, error)
	loadDestinationCCS    func(dir string, manifest *artifact.KeyManifest) (constraint.ConstraintSystem, error)
	compileDestination    func() (constraint.ConstraintSystem, error)
}

// destinationProverCache holds the request-independent proving material: the
// deserialized proving key bundle and the constraint system. Both are public
// data; only memory footprint motivates eviction.
type destinationProverCache struct {
	bundle *prover.OwnershipBundle
	ccs    constraint.ConstraintSystem
	evict  *time.Timer
}

func (g *OwnershipGenerator) destinationIdleTTL() time.Duration {
	if g.DestinationKeyIdleTTL > 0 {
		return g.DestinationKeyIdleTTL
	}
	return defaultDestinationKeyIdleTTL
}

// acquireDestinationProver returns the cached proving bundle and constraint
// system, loading them on first use. The frozen ceremony constraint system
// (ownership-destination.ccs, digest-pinned by the key manifest) is preferred;
// bundles without one fall back to compiling the circuit in-process so local
// dev key directories keep working.
func (g *OwnershipGenerator) acquireDestinationProver() (*prover.OwnershipBundle, constraint.ConstraintSystem, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.destCache != nil {
		g.destCache.evict.Reset(g.destinationIdleTTL())
		return g.destCache.bundle, g.destCache.ccs, nil
	}

	loadBundle := g.loadDestinationProver
	if loadBundle == nil {
		loadBundle = prover.LoadOwnershipDestinationProver
	}
	loadCCS := g.loadDestinationCCS
	if loadCCS == nil {
		loadCCS = prover.LoadOwnershipDestinationCCS
	}
	compile := g.compileDestination
	if compile == nil {
		compile = prover.CompileOwnershipDestination
	}

	bundle, err := loadBundle(g.destinationKeysDir())
	if err != nil {
		return nil, nil, err
	}
	ccs, err := loadCCS(g.destinationKeysDir(), bundle.Manifest)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			// A present-but-unverifiable frozen constraint system is a hard
			// error: falling back to a compile would silently mask a corrupt
			// or tampered bundle.
			return nil, nil, err
		}
		ccs, err = compile()
		if err != nil {
			return nil, nil, err
		}
	}

	g.destCache = &destinationProverCache{
		bundle: bundle,
		ccs:    ccs,
		evict:  time.AfterFunc(g.destinationIdleTTL(), g.evictDestinationProver),
	}
	return bundle, ccs, nil
}

func (g *OwnershipGenerator) evictDestinationProver() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.destCache != nil {
		g.destCache.evict.Stop()
		g.destCache = nil
	}
}

// WarmDestinationProver loads the destination proving bundle and constraint
// system into the idle-TTL cache in the background, so the first prove
// request does not pay the multi-second proving-key load (~16 s for the
// 1.3 GiB v2 key). Best-effort: on failure the first real request reloads
// and surfaces the error to its caller.
func (g *OwnershipGenerator) WarmDestinationProver() <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		start := time.Now()
		if _, _, err := g.acquireDestinationProver(); err != nil {
			fmt.Fprintf(os.Stderr, "destination prover warm-up skipped: %v\n", err)
			return
		}
		fmt.Fprintf(os.Stderr, "destination prover warmed in %.1fs\n", time.Since(start).Seconds())
	}()
	return done
}

func BuildInput(req ProveRequest) (ProveInput, error) {
	master, err := decodeMasterXPrvBase64(req.MasterXPrvBase64)
	if err != nil {
		return ProveInput{}, err
	}
	target, err := ownership.DecodeCredentialHex(req.TargetCredential)
	if err != nil {
		return ProveInput{}, err
	}
	search, err := buildSearchOptions(req)
	if err != nil {
		return ProveInput{}, err
	}
	return ProveInput{
		MasterXPrv:       master,
		TargetCredential: target,
		Search:           search,
		IncludeDebugPath: req.IncludeDebugPath,
	}, nil
}

func BuildDestinationInput(req ProveDestinationRequest) (ProveDestinationInput, error) {
	master, err := decodeMasterXPrvBase64(req.MasterXPrvBase64)
	if err != nil {
		return ProveDestinationInput{}, err
	}
	if req.Profile != DestinationProfileSingle {
		return ProveDestinationInput{}, fmt.Errorf("profile %q, want %q", req.Profile, DestinationProfileSingle)
	}
	if len(req.Requests) == 0 {
		return ProveDestinationInput{}, errors.New("requests must contain at least one proof request")
	}
	requests := make([]DestinationProofInput, 0, len(req.Requests))
	for i, item := range req.Requests {
		outRef := strings.TrimSpace(item.OutRef)
		if outRef == "" {
			return ProveDestinationInput{}, fmt.Errorf("requests[%d].out_ref is required", i)
		}
		target, err := ownershipdest.DecodeCredentialHex(item.TargetCredential)
		if err != nil {
			return ProveDestinationInput{}, fmt.Errorf("requests[%d].target_credential: %w", i, err)
		}
		if item.DestinationAddressEncoding != ownershipdest.DestinationAddressEncoding {
			return ProveDestinationInput{}, fmt.Errorf("requests[%d].destination_address_encoding %q, want %q", i, item.DestinationAddressEncoding, ownershipdest.DestinationAddressEncoding)
		}
		destination, err := ownershipdest.DecodeDestinationAddressV1Hex(item.DestinationAddress)
		if err != nil {
			return ProveDestinationInput{}, fmt.Errorf("requests[%d].destination_address: %w", i, err)
		}
		requests = append(requests, DestinationProofInput{
			OutRef:                     outRef,
			TargetCredential:           target,
			DestinationAddressEncoding: item.DestinationAddressEncoding,
			DestinationAddress:         destination,
		})
	}
	search := buildDestinationSearchOptions(req.Search)
	return ProveDestinationInput{
		MasterXPrv:       master,
		Profile:          req.Profile,
		Requests:         requests,
		Search:           search,
		IncludeDebugPath: req.IncludeDebugPath,
	}, nil
}

func (g *OwnershipGenerator) GenerateProof(ctx context.Context, input ProveInput) (artifact.ProofArtifact, error) {
	if err := ctx.Err(); err != nil {
		return artifact.ProofArtifact{}, err
	}
	paths, err := ownership.DiscoverCredentialPaths(
		ctx,
		input.MasterXPrv,
		[][]byte{input.TargetCredential},
		ownership.DiscoveryOptions{Search: input.Search},
		discoveryProgressAdapter(input.Progress),
	)
	if err != nil {
		if errors.Is(err, ownership.ErrCredentialsNotFound) {
			return artifact.ProofArtifact{}, ErrPathNotFound
		}
		return artifact.ProofArtifact{}, err
	}
	credentialKey, err := paymentCredentialKey(input.TargetCredential)
	if err != nil {
		return artifact.ProofArtifact{}, err
	}
	path := paths[credentialKey]
	emitLocalProofProgress(input.Progress, LocalProofProgress{Stage: "open-keys", Total: 1})

	var bundle *prover.OwnershipBundle
	if !g.AllowCreateKeys {
		bundle, err = prover.LoadOwnershipProver(g.KeysDir)
		if err != nil {
			return artifact.ProofArtifact{}, err
		}
	}

	publicInput, err := ownership.PublicInputForCredential(input.TargetCredential)
	if err != nil {
		return artifact.ProofArtifact{}, err
	}
	assignment, err := ownership.Assignment(input.MasterXPrv, path, publicInput)
	if err != nil {
		return artifact.ProofArtifact{}, err
	}
	ccs, err := prover.CompileOwnership()
	if err != nil {
		return artifact.ProofArtifact{}, err
	}
	if g.AllowCreateKeys {
		bundle, err = prover.LoadOrCreateOwnershipBundle(g.KeysDir, ccs)
	}
	if err != nil {
		return artifact.ProofArtifact{}, err
	}
	emitLocalProofProgress(input.Progress, LocalProofProgress{Stage: "prove", Total: 1})
	proof, err := prover.Prove(ccs, bundle.ProvingKey, assignment)
	if err != nil {
		return artifact.ProofArtifact{}, err
	}
	emitLocalProofProgress(input.Progress, LocalProofProgress{Stage: "prove", Current: 1, Total: 1})
	encodedProof, err := prover.MarshalProof(proof)
	if err != nil {
		return artifact.ProofArtifact{}, err
	}
	cardanoProof, err := prover.CardanoProofArtifact(proof, input.TargetCredential)
	if err != nil {
		return artifact.ProofArtifact{}, err
	}
	return artifact.ProofArtifact{
		Schema:           artifact.ProofSchema,
		CircuitID:        ownership.CircuitID,
		VKHash:           bundle.Manifest.VKHash,
		TargetCredential: hex.EncodeToString(input.TargetCredential),
		PublicInput:      ownership.PublicInputHex(publicInput),
		Proof:            encodedProof,
		Cardano:          cardanoProof,
		Path: &artifact.PathMetadata{
			Account: path.Account,
			Role:    path.Role,
			Index:   path.Index,
		},
	}, nil
}

func (g *OwnershipGenerator) GenerateDestinationProofs(ctx context.Context, input ProveDestinationInput) ([]DestinationProofArtifactItem, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	targets := make([][]byte, 0, len(input.Requests))
	for _, request := range input.Requests {
		targets = append(targets, request.TargetCredential)
	}
	paths, err := ownership.DiscoverCredentialPaths(
		ctx,
		input.MasterXPrv,
		targets,
		ownership.DiscoveryOptions{Search: input.Search},
		discoveryProgressAdapter(input.Progress),
	)
	if err != nil {
		if errors.Is(err, ownership.ErrCredentialsNotFound) {
			return nil, ErrPathNotFound
		}
		return nil, err
	}

	total := uint64(len(input.Requests))
	emitLocalProofProgress(input.Progress, LocalProofProgress{Stage: "open-keys", Total: total})
	bundle, ccs, err := g.acquireDestinationProver()
	if err != nil {
		return nil, err
	}

	results := make([]DestinationProofArtifactItem, 0, len(input.Requests))
	for i, request := range input.Requests {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		credentialKey, err := paymentCredentialKey(request.TargetCredential)
		if err != nil {
			return nil, err
		}
		path, ok := paths[credentialKey]
		if !ok {
			return nil, ErrPathNotFound
		}
		publicInput, err := ownershipdest.PublicInputForCredentialDestination(request.TargetCredential, request.DestinationAddress)
		if err != nil {
			return nil, err
		}
		assignment, err := ownershipdest.Assignment(input.MasterXPrv, path, request.DestinationAddress, publicInput)
		if err != nil {
			return nil, err
		}
		emitLocalProofProgress(input.Progress, LocalProofProgress{Stage: "prove", Current: uint64(i), Total: total})
		proof, err := prover.Prove(ccs, bundle.ProvingKey, assignment)
		if err != nil {
			return nil, err
		}
		encodedProof, err := prover.MarshalProof(proof)
		if err != nil {
			return nil, err
		}
		publicInputDigest, err := ownershipdest.PublicInputDigestForCredentialDestination(request.TargetCredential, request.DestinationAddress)
		if err != nil {
			return nil, err
		}
		cardanoProof, err := prover.CardanoProofArtifactWithDigest(proof, publicInputDigest)
		if err != nil {
			return nil, err
		}
		results = append(results, DestinationProofArtifactItem{
			OutRef: request.OutRef,
			Artifact: artifact.ProofArtifact{
				Schema:                     artifact.ProofSchema,
				CircuitID:                  ownershipdest.CircuitID,
				VKHash:                     bundle.Manifest.VKHash,
				TargetCredential:           hex.EncodeToString(request.TargetCredential),
				DestinationAddressEncoding: request.DestinationAddressEncoding,
				DestinationAddress:         hex.EncodeToString(request.DestinationAddress),
				PublicInputEncoding:        ownershipdest.PublicInputEncoding,
				PublicInput:                ownershipdest.PublicInputHex(publicInput),
				Proof:                      encodedProof,
				Cardano:                    cardanoProof,
				Path: &artifact.PathMetadata{
					Account: path.Account,
					Role:    path.Role,
					Index:   path.Index,
				},
			},
		})
		emitLocalProofProgress(input.Progress, LocalProofProgress{Stage: "prove", Current: uint64(i + 1), Total: total})
	}
	emitLocalProofProgress(input.Progress, LocalProofProgress{Stage: "done", Current: total, Total: total})
	return results, nil
}

func discoveryProgressAdapter(callback LocalProofProgressFunc) ownership.DiscoveryProgressFunc {
	if callback == nil {
		return nil
	}
	return func(progress ownership.DiscoveryProgress) {
		copy := progress
		callback(LocalProofProgress{Stage: "locating-keys", Discovery: &copy})
	}
}

func emitLocalProofProgress(callback LocalProofProgressFunc, progress LocalProofProgress) {
	if callback != nil {
		callback(progress)
	}
}

func paymentCredentialKey(raw []byte) ([28]byte, error) {
	if len(raw) != 28 {
		return [28]byte{}, fmt.Errorf("target credential is %d bytes, want 28", len(raw))
	}
	var key [28]byte
	copy(key[:], raw)
	return key, nil
}

func (g *OwnershipGenerator) KeyStatus() KeyStatus {
	status := prover.InspectOwnershipBundle(g.KeysDir, true)
	return KeyStatus{
		State:      status.State,
		Ready:      status.Ready,
		KeyVersion: status.KeyVersion,
		VKHash:     status.VKHash,
		Error:      status.Error,
	}
}

func (g *OwnershipGenerator) DestinationKeyStatus() KeyStatus {
	status := prover.InspectOwnershipDestinationBundle(g.destinationKeysDir(), true)
	return KeyStatus{
		State:      status.State,
		Ready:      status.Ready,
		KeyVersion: status.KeyVersion,
		VKHash:     status.VKHash,
		Error:      status.Error,
	}
}

func (g *OwnershipGenerator) destinationKeysDir() string {
	if strings.TrimSpace(g.DestinationKeysDir) != "" {
		return g.DestinationKeysDir
	}
	return g.KeysDir
}

func buildSearchOptions(req ProveRequest) (ownership.SearchOptions, error) {
	account, err := optionalInt(req.Account, "account")
	if err != nil {
		return ownership.SearchOptions{}, err
	}
	role, err := optionalInt(req.Role, "role")
	if err != nil {
		return ownership.SearchOptions{}, err
	}
	index, err := optionalInt(req.Index, "index")
	if err != nil {
		return ownership.SearchOptions{}, err
	}
	maxAccount := uint32(9)
	if req.MaxAccount != nil {
		maxAccount = *req.MaxAccount
	}
	maxIndex := uint32(999)
	if req.MaxIndex != nil {
		maxIndex = *req.MaxIndex
	}
	return ownership.SearchOptions{
		Account:    account,
		Role:       role,
		Index:      index,
		MaxAccount: maxAccount,
		MaxIndex:   maxIndex,
	}, nil
}

func buildDestinationSearchOptions(req *DestinationSearchRequest) ownership.SearchOptions {
	maxAccount := uint32(9)
	maxIndex := uint32(999)
	if req != nil {
		if req.MaxAccount != nil {
			maxAccount = *req.MaxAccount
		}
		if req.MaxIndex != nil {
			maxIndex = *req.MaxIndex
		}
	}
	return ownership.SearchOptions{
		Account:    -1,
		Role:       -1,
		Index:      -1,
		MaxAccount: maxAccount,
		MaxIndex:   maxIndex,
	}
}

func decodeMasterXPrvBase64(value string) ([]byte, error) {
	master, err := base64.StdEncoding.DecodeString(strings.TrimSpace(value))
	if err != nil {
		return nil, errors.New("master xprv is invalid")
	}
	if len(master) != 96 {
		return nil, fmt.Errorf("master xprv is %d bytes, want 96", len(master))
	}
	return master, nil
}

func optionalInt(value *uint32, name string) (int, error) {
	if value == nil {
		return -1, nil
	}
	if *value > math.MaxInt32 {
		return 0, fmt.Errorf("%s must be <= %d", name, math.MaxInt32)
	}
	return int(*value), nil
}
