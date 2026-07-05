package helper

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"strings"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/circuit/ownershipdest"
	"proof-tool/internal/prover"
)

var ErrPathNotFound = errors.New("target credential not found")

const (
	ProtocolVersion = "proof-helper-v1"
	SidecarVersion  = "0.1.0"

	DestinationProfileSingle = "single-destination"
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
}

type ProveResponse struct {
	Artifact      artifact.ProofArtifact  `json:"artifact"`
	DebugArtifact *artifact.ProofArtifact `json:"debug_artifact,omitempty"`
}

type ProveDestinationRequest struct {
	MasterXPrvBase64 string                    `json:"master_xprv_base64"`
	Profile          string                    `json:"profile"`
	Requests         []DestinationProofRequest `json:"requests"`
	Search           *DestinationSearchRequest `json:"search,omitempty"`
	IncludeDebugPath bool                      `json:"include_debug_path,omitempty"`
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

type OwnershipGenerator struct {
	KeysDir            string
	DestinationKeysDir string
	AllowCreateKeys    bool
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
	var bundle *prover.OwnershipBundle
	var err error
	if !g.AllowCreateKeys {
		bundle, err = prover.LoadOwnershipProver(g.KeysDir)
		if err != nil {
			return artifact.ProofArtifact{}, err
		}
	}

	path, err := ownership.FindPath(input.MasterXPrv, input.TargetCredential, input.Search)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			return artifact.ProofArtifact{}, ErrPathNotFound
		}
		return artifact.ProofArtifact{}, err
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
	proof, err := prover.Prove(ccs, bundle.ProvingKey, assignment)
	if err != nil {
		return artifact.ProofArtifact{}, err
	}
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
	bundle, err := prover.LoadOwnershipDestinationProver(g.destinationKeysDir())
	if err != nil {
		return nil, err
	}
	ccs, err := prover.CompileOwnershipDestination()
	if err != nil {
		return nil, err
	}

	results := make([]DestinationProofArtifactItem, 0, len(input.Requests))
	for _, request := range input.Requests {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		path, err := ownership.FindPath(input.MasterXPrv, request.TargetCredential, input.Search)
		if err != nil {
			if strings.Contains(err.Error(), "not found") {
				return nil, ErrPathNotFound
			}
			return nil, err
		}
		publicInput, err := ownershipdest.PublicInputForCredentialDestination(request.TargetCredential, request.DestinationAddress)
		if err != nil {
			return nil, err
		}
		assignment, err := ownershipdest.Assignment(input.MasterXPrv, path, request.DestinationAddress, publicInput)
		if err != nil {
			return nil, err
		}
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
	}
	return results, nil
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
