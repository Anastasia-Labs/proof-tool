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
	"proof-tool/internal/prover"
)

var ErrPathNotFound = errors.New("target credential not found")

const (
	ProtocolVersion = "proof-helper-v1"
	SidecarVersion  = "0.1.0"
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

type Generator interface {
	GenerateProof(ctx context.Context, input ProveInput) (artifact.ProofArtifact, error)
}

type KeyStatusReporter interface {
	KeyStatus() KeyStatus
}

type KeyStatus struct {
	State      string `json:"state"`
	Ready      bool   `json:"ready"`
	KeyVersion string `json:"key_version,omitempty"`
	VKHash     string `json:"vk_hash,omitempty"`
	Error      string `json:"error,omitempty"`
}

type OwnershipGenerator struct {
	KeysDir         string
	AllowCreateKeys bool
}

func BuildInput(req ProveRequest) (ProveInput, error) {
	master, err := base64.StdEncoding.DecodeString(strings.TrimSpace(req.MasterXPrvBase64))
	if err != nil {
		return ProveInput{}, errors.New("master xprv is invalid")
	}
	if len(master) != 96 {
		return ProveInput{}, fmt.Errorf("master xprv is %d bytes, want 96", len(master))
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

func optionalInt(value *uint32, name string) (int, error) {
	if value == nil {
		return -1, nil
	}
	if *value > math.MaxInt32 {
		return 0, fmt.Errorf("%s must be <= %d", name, math.MaxInt32)
	}
	return int(*value), nil
}
