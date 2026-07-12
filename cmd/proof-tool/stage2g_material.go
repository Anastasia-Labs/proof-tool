package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/consensys/gnark/constraint"
	"golang.org/x/crypto/blake2b"

	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/circuit/ownershipdest"
	"proof-tool/internal/prover"
)

const (
	stage2gMaterialSchema       = "proof-tool-stage2g-v2-distinct-benchmark-material-v1"
	stage2gNetwork              = "Preprod"
	stage2gEntryCount           = 7
	stage2gParamsTokenName      = "5245434c41494d504152414d53" // RECLAIMPARAMS
	stage2gEntryLovelace        = "3000000"
	stage2gBootstrapLovelace    = "50000000"
	stage2gDestinationByteCount = 58
)

type stage2gMaterialPolicy struct {
	DefaultUTxOCount      int                       `json:"default_utxo_count"`
	OptimizationUTxOCount int                       `json:"optimization_utxo_count"`
	HardMaxUTxOCount      int                       `json:"hard_max_utxo_count"`
	MaxTxCPUPercent       int                       `json:"max_tx_cpu_percent"`
	MaxTxMemPercent       int                       `json:"max_tx_mem_percent"`
	DistinctSevenOptIn    stage2gDistinctSevenOptIn `json:"distinct_7_opt_in"`
}

type stage2gDistinctSevenOptIn struct {
	RequestParameter              string `json:"request_parameter"`
	RequestValue                  int    `json:"request_value"`
	RequireExplicitRequest        bool   `json:"require_explicit_request"`
	RequireMeasuredExecutionUnits bool   `json:"require_measured_execution_units"`
}

type stage2gMaterialParams struct {
	PolicyID    string `json:"policy_id"`
	TokenName   string `json:"token_name"`
	TxHash      string `json:"tx_hash"`
	OutputIndex int    `json:"output_index"`
	Address     string `json:"address"`
	Lovelace    string `json:"lovelace"`
}

type stage2gMaterialBootstrapUTxO struct {
	TxHash      string `json:"tx_hash"`
	OutputIndex int    `json:"output_index"`
	Lovelace    string `json:"lovelace"`
}

type stage2gMaterialBootstrap struct {
	Address string                         `json:"address"`
	UTxOs   []stage2gMaterialBootstrapUTxO `json:"utxos"`
}

type stage2gMaterialEntry struct {
	TxHash               string            `json:"tx_hash"`
	OutputIndex          int               `json:"output_index"`
	Credential           string            `json:"credential"`
	ProofHex             string            `json:"proof_hex"`
	PublicInputDigestHex string            `json:"public_input_digest_hex"`
	DestinationAddress   string            `json:"destination_address"`
	Value                map[string]string `json:"value"`
}

type stage2gMaterial struct {
	Schema              string                   `json:"schema"`
	Network             string                   `json:"network"`
	Policy              stage2gMaterialPolicy    `json:"policy"`
	CardanoVKHex        string                   `json:"cardano_vk_hex"`
	CardanoVKBlake2b256 string                   `json:"cardano_vk_blake2b256"`
	Params              stage2gMaterialParams    `json:"params"`
	Bootstrap           stage2gMaterialBootstrap `json:"bootstrap"`
	Entries             []stage2gMaterialEntry   `json:"entries"`
}

func cmdGenerateStage2gV2Material(args []string) error {
	fs := flag.NewFlagSet("generate-stage2g-v2-material", flag.ContinueOnError)
	walletFile := fs.String("wallet-file", "", "local Preprod test-wallet JSON file")
	keysDir := fs.String("keys-dir", "", "signed destination proving-key bundle directory")
	manifestPublicKeyFile := fs.String("manifest-public-key-file", "", "trusted external Ed25519 key-manifest public-key hex file")
	expectedSignatureKeyID := fs.String("signature-key-id", "", "expected signed destination key-manifest signature key id")
	destinationAddress := fs.String("destination-address", "", "safe Preprod bech32 destination address")
	destinationAddressBytes := fs.String("destination-address-bytes", "", "58-byte destination-address-v1 hexadecimal value")
	outPath := fs.String("out", "output/preprod-e2e/stage2g-v2/material.local.json", "new local Stage 2g material JSON output path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	if strings.TrimSpace(*walletFile) == "" || strings.TrimSpace(*keysDir) == "" {
		return errors.New("--wallet-file and --keys-dir are required")
	}
	if strings.TrimSpace(*manifestPublicKeyFile) == "" || strings.TrimSpace(*expectedSignatureKeyID) == "" {
		return errors.New("--manifest-public-key-file and --signature-key-id are required")
	}
	publicKeyHex, err := stage2gTrustedManifestPublicKey(*keysDir, *manifestPublicKeyFile)
	if err != nil {
		return err
	}
	if _, err := verifyKeyBundle(*keysDir, prover.DefaultDestinationKeyVersion, publicKeyHex, strings.TrimSpace(*expectedSignatureKeyID), true); err != nil {
		return fmt.Errorf("verify signed destination key bundle: %w", err)
	}
	destination, err := parseStage2gDestination(*destinationAddress, *destinationAddressBytes)
	if err != nil {
		return err
	}
	master, err := readStage2gCompromisedMaster(*walletFile)
	if err != nil {
		return err
	}
	defer clear(master)

	ccs, err := prover.CompileOwnershipDestination()
	if err != nil {
		return fmt.Errorf("compile destination circuit: %w", err)
	}
	bundle, err := prover.LoadOwnershipDestinationProver(*keysDir)
	if err != nil {
		return fmt.Errorf("load signed destination key bundle: %w", err)
	}
	material, err := buildStage2gMaterial(ccs, bundle, master, strings.TrimSpace(*destinationAddress), destination)
	if err != nil {
		return err
	}
	if err := writeStage2gMaterial(*outPath, material); err != nil {
		return err
	}
	fmt.Printf("wrote local Stage 2g V2 material: %s (entries=%d, no secrets logged)\n", *outPath, len(material.Entries))
	return nil
}

// stage2gTrustedManifestPublicKey accepts only a separately supplied trust
// anchor. In particular, the bundled manifest-public-key.hex cannot be
// relabelled as an external key by passing its path explicitly.
func stage2gTrustedManifestPublicKey(keysDir, publicKeyFile string) (string, error) {
	configured := strings.TrimSpace(publicKeyFile)
	if configured == "" {
		return "", errors.New("--manifest-public-key-file is required")
	}
	keyPath, err := filepath.Abs(configured)
	if err != nil {
		return "", errors.New("resolve trusted Stage 2g manifest public key path")
	}
	keyInfo, err := os.Lstat(keyPath)
	if err != nil {
		return "", errors.New("inspect trusted Stage 2g manifest public key file")
	}
	if keyInfo.Mode()&os.ModeSymlink != 0 || !keyInfo.Mode().IsRegular() {
		return "", errors.New("trusted Stage 2g manifest public key must be a non-symlink regular file")
	}
	bundlePath, err := filepath.Abs(strings.TrimSpace(keysDir))
	if err != nil {
		return "", errors.New("resolve Stage 2g key bundle path")
	}
	resolvedBundlePath, err := filepath.EvalSymlinks(bundlePath)
	if err != nil {
		return "", errors.New("resolve Stage 2g key bundle path")
	}
	resolvedKeyPath, err := filepath.EvalSymlinks(keyPath)
	if err != nil {
		return "", errors.New("resolve trusted Stage 2g manifest public key path")
	}
	insideBundle, err := stage2gPathWithin(resolvedBundlePath, resolvedKeyPath)
	if err != nil {
		return "", errors.New("compare trusted Stage 2g manifest public key path")
	}
	if insideBundle {
		return "", errors.New("trusted Stage 2g manifest public key must be outside --keys-dir")
	}
	publicKeyHex, trusted, err := manifestPublicKeyForVerification(keysDir, "", resolvedKeyPath)
	if err != nil {
		return "", err
	}
	if !trusted {
		return "", errors.New("trusted Stage 2g manifest public key is required")
	}
	return publicKeyHex, nil
}

func stage2gPathWithin(root, target string) (bool, error) {
	relative, err := filepath.Rel(root, target)
	if err != nil {
		return false, err
	}
	return relative == "." || (!filepath.IsAbs(relative) && relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator))), nil
}

func parseStage2gDestination(address, addressHex string) ([]byte, error) {
	if !strings.HasPrefix(strings.TrimSpace(address), "addr_test") {
		return nil, errors.New("--destination-address must be a Preprod addr_test address")
	}
	destination, err := ownershipdest.DecodeDestinationAddressV1Hex(addressHex)
	if err != nil {
		return nil, fmt.Errorf("--destination-address-bytes: %w", err)
	}
	if len(destination) != stage2gDestinationByteCount {
		return nil, fmt.Errorf("destination address is %d bytes, want %d", len(destination), stage2gDestinationByteCount)
	}
	return destination, nil
}

func readStage2gCompromisedMaster(path string) ([]byte, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("read local Stage 2g wallet file")
	}
	var root struct {
		Roles   map[string]stage2gWalletRole `json:"roles"`
		Wallets map[string]stage2gWalletRole `json:"wallets"`
	}
	if err := json.Unmarshal(contents, &root); err != nil {
		return nil, errors.New("parse local Stage 2g wallet file")
	}
	roles := root.Roles
	if len(roles) == 0 {
		roles = root.Wallets
	}
	role, ok := roles["compromised_user"]
	if !ok {
		return nil, errors.New("local Stage 2g wallet file lacks compromised_user")
	}
	mnemonic := firstNonEmpty(role.Mnemonic, role.SeedPhrase, role.RecoveryPhrase, role.MnemonicWords)
	if mnemonic == "" {
		return nil, errors.New("local Stage 2g compromised_user mnemonic is unavailable")
	}
	master, err := ownership.MasterXPrvFromSeedPhrase(mnemonic)
	if err != nil {
		return nil, errors.New("derive local Stage 2g compromised_user master key")
	}
	return master, nil
}

type stage2gWalletRole struct {
	Mnemonic       string `json:"mnemonic"`
	SeedPhrase     string `json:"seed_phrase"`
	RecoveryPhrase string `json:"recovery_phrase"`
	MnemonicWords  string `json:"mnemonic_words"`
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.Join(strings.Fields(value), " "); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func buildStage2gMaterial(ccs constraint.ConstraintSystem, bundle *prover.OwnershipBundle, master []byte, destinationAddress string, destination []byte) (stage2gMaterial, error) {
	if bundle == nil || bundle.ProvingKey == nil || bundle.VerifyingKey == nil {
		return stage2gMaterial{}, errors.New("signed destination key bundle is incomplete")
	}
	if len(master) != 96 || len(destination) != stage2gDestinationByteCount {
		return stage2gMaterial{}, errors.New("invalid local Stage 2g proving inputs")
	}
	cardanoVK, format, err := prover.SerializeCardanoVK(bundle.VerifyingKey)
	if err != nil {
		return stage2gMaterial{}, fmt.Errorf("serialize Stage 2g Cardano verification key: %w", err)
	}
	if format != "groth16-bls12-381-bsb22" || len(cardanoVK) != prover.CardanoVKLen {
		return stage2gMaterial{}, errors.New("Stage 2g destination verification key is not the exact 672-byte Cardano format")
	}
	vkHash, err := stage2gBlake2b256(cardanoVK)
	if err != nil {
		return stage2gMaterial{}, err
	}
	entries := make([]stage2gMaterialEntry, 0, stage2gEntryCount)
	credentials := make(map[string]struct{}, stage2gEntryCount)
	proofs := make(map[string]struct{}, stage2gEntryCount)
	digests := make(map[string]struct{}, stage2gEntryCount)
	for index := 0; index < stage2gEntryCount; index++ {
		entry, err := generateStage2gEntry(ccs, bundle, master, destinationAddress, destination, index)
		if err != nil {
			return stage2gMaterial{}, err
		}
		if _, exists := credentials[entry.Credential]; exists {
			return stage2gMaterial{}, errors.New("Stage 2g derived duplicate payment credentials")
		}
		if _, exists := proofs[entry.ProofHex]; exists {
			return stage2gMaterial{}, errors.New("Stage 2g generated duplicate proof bytes")
		}
		if _, exists := digests[entry.PublicInputDigestHex]; exists {
			return stage2gMaterial{}, errors.New("Stage 2g generated duplicate public-input digests")
		}
		credentials[entry.Credential] = struct{}{}
		proofs[entry.ProofHex] = struct{}{}
		digests[entry.PublicInputDigestHex] = struct{}{}
		entries = append(entries, entry)
	}
	return stage2gMaterial{
		Schema:              stage2gMaterialSchema,
		Network:             stage2gNetwork,
		Policy:              stage2gFixedPolicy(),
		CardanoVKHex:        hex.EncodeToString(cardanoVK),
		CardanoVKBlake2b256: "blake2b256:" + vkHash,
		Params: stage2gMaterialParams{
			PolicyID:    stage2gSyntheticHash("params-policy")[:56],
			TokenName:   stage2gParamsTokenName,
			TxHash:      stage2gSyntheticHash("params-utxo"),
			OutputIndex: 0,
			Address:     destinationAddress,
			Lovelace:    stage2gEntryLovelace,
		},
		Bootstrap: stage2gMaterialBootstrap{
			Address: destinationAddress,
			UTxOs: []stage2gMaterialBootstrapUTxO{
				{TxHash: stage2gSyntheticHash("bootstrap-0"), OutputIndex: 0, Lovelace: stage2gBootstrapLovelace},
				{TxHash: stage2gSyntheticHash("bootstrap-1"), OutputIndex: 0, Lovelace: stage2gBootstrapLovelace},
			},
		},
		Entries: entries,
	}, nil
}

func generateStage2gEntry(ccs constraint.ConstraintSystem, bundle *prover.OwnershipBundle, master []byte, destinationAddress string, destination []byte, index int) (stage2gMaterialEntry, error) {
	path := ownership.Path{Account: 0, Role: 0, Index: uint32(index)}
	credential, err := ownership.DeriveCredential(master, path)
	if err != nil {
		return stage2gMaterialEntry{}, fmt.Errorf("derive Stage 2g credential %d: %w", index, err)
	}
	publicInput, err := ownershipdest.PublicInputForCredentialDestination(credential[:], destination)
	if err != nil {
		return stage2gMaterialEntry{}, fmt.Errorf("build Stage 2g public input %d: %w", index, err)
	}
	digest, err := ownershipdest.PublicInputDigestForCredentialDestination(credential[:], destination)
	if err != nil {
		return stage2gMaterialEntry{}, fmt.Errorf("build Stage 2g public-input digest %d: %w", index, err)
	}
	assignment, err := ownershipdest.Assignment(master, path, destination, publicInput)
	if err != nil {
		return stage2gMaterialEntry{}, fmt.Errorf("build Stage 2g assignment %d: %w", index, err)
	}
	proof, err := prover.Prove(ccs, bundle.ProvingKey, assignment)
	if err != nil {
		return stage2gMaterialEntry{}, fmt.Errorf("prove Stage 2g slot %d: %w", index, err)
	}
	if err := prover.VerifyProof(bundle.VerifyingKey, proof, assignment); err != nil {
		return stage2gMaterialEntry{}, fmt.Errorf("verify Stage 2g slot %d: %w", index, err)
	}
	cardanoProof, err := prover.CardanoProofArtifactWithDigest(proof, digest)
	if err != nil {
		return stage2gMaterialEntry{}, fmt.Errorf("serialize Stage 2g proof %d: %w", index, err)
	}
	if cardanoProof.Format != "groth16-bls12-381-bsb22" || len(cardanoProof.ProofHex) != prover.CardanoProofLen*2 || len(cardanoProof.PublicInputDigestHex) != 64 {
		return stage2gMaterialEntry{}, errors.New("Stage 2g proof serialization is not the exact Cardano wire format")
	}
	return stage2gMaterialEntry{
		TxHash:               stage2gSyntheticHash(fmt.Sprintf("base-utxo-%d", index)),
		OutputIndex:          0,
		Credential:           hex.EncodeToString(credential[:]),
		ProofHex:             cardanoProof.ProofHex,
		PublicInputDigestHex: cardanoProof.PublicInputDigestHex,
		DestinationAddress:   destinationAddress,
		Value:                map[string]string{"lovelace": stage2gEntryLovelace},
	}, nil
}

func stage2gFixedPolicy() stage2gMaterialPolicy {
	return stage2gMaterialPolicy{
		DefaultUTxOCount:      6,
		OptimizationUTxOCount: 6,
		HardMaxUTxOCount:      7,
		MaxTxCPUPercent:       90,
		MaxTxMemPercent:       80,
		DistinctSevenOptIn: stage2gDistinctSevenOptIn{
			RequestParameter:              "maxUtxos",
			RequestValue:                  7,
			RequireExplicitRequest:        true,
			RequireMeasuredExecutionUnits: true,
		},
	}
}

func stage2gSyntheticHash(label string) string {
	sum := sha256.Sum256([]byte("proof-tool-stage2g-v2-synthetic:" + label))
	return hex.EncodeToString(sum[:])
}

func stage2gBlake2b256(data []byte) (string, error) {
	h, err := blake2b.New256(nil)
	if err != nil {
		return "", err
	}
	if _, err := h.Write(data); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func writeStage2gMaterial(outPath string, material stage2gMaterial) error {
	if strings.TrimSpace(outPath) == "" {
		return errors.New("Stage 2g material output path is required")
	}
	if err := assertStage2gMaterialOutputPath(outPath); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(material, "", "  ")
	if err != nil {
		return fmt.Errorf("encode Stage 2g material: %w", err)
	}
	if err := writeStage2gMaterialExclusive(outPath, append(encoded, '\n')); err != nil {
		return err
	}
	return nil
}

func assertStage2gMaterialOutputPath(outPath string) error {
	if filepath.IsAbs(outPath) {
		return errors.New("Stage 2g material output must be a relative path under output/preprod-e2e/stage2g-v2")
	}
	target := filepath.Clean(outPath)
	root := filepath.Join("output", "preprod-e2e", "stage2g-v2")
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) || filepath.IsAbs(relative) {
		return errors.New("Stage 2g material output must be under output/preprod-e2e/stage2g-v2")
	}
	current := "."
	for _, part := range strings.Split(target, string(os.PathSeparator)) {
		if part == "" || part == "." {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return errors.New("inspect Stage 2g material output path")
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errors.New("Stage 2g material output path traverses a symbolic link")
		}
	}
	return nil
}
