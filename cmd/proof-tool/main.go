package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/blake2b"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/circuit/ownershipdest"
	"proof-tool/internal/circuit/ownershipmulti"
	"proof-tool/internal/helper"
	"proof-tool/internal/prover"
	"proof-tool/internal/verifier"
)

func main() {
	if err := run(os.Args); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) < 2 {
		usage()
		return errors.New("missing command")
	}
	switch args[1] {
	case "master-xprv-from-seed-phrase":
		return cmdMasterXPrv(args[2:])
	case "prove":
		return cmdProve(args[2:])
	case "prove-destination":
		return cmdProveDestination(args[2:])
	case "prove-multi":
		return cmdProveMulti(args[2:])
	case "verify":
		return cmdVerify(args[2:])
	case "verify-destination":
		return cmdVerifyDestination(args[2:])
	case "verify-multi":
		return cmdVerifyMulti(args[2:])
	case "export-cardano":
		return cmdExportCardano(args[2:])
	case "export-cardano-vk":
		return cmdExportCardanoVK(args[2:])
	case "generate-destination-benchmark-fixtures":
		return cmdGenerateDestinationBenchmarkFixtures(args[2:])
	case "generate-multi-benchmark-fixtures":
		return cmdGenerateMultiBenchmarkFixtures(args[2:])
	case "setup-ceremony":
		return cmdSetupCeremony(args[2:])
	case "verify-key-bundle":
		return cmdVerifyKeyBundle(args[2:])
	case "generate-chunk-manifest":
		return cmdGenerateChunkManifest(args[2:])
	case "serve-verifier":
		return cmdServeVerifier(args[2:])
	case "serve-helper":
		return cmdServeHelper(args[2:])
	default:
		usage()
		return fmt.Errorf("unknown command %q", args[1])
	}
}

func cmdMasterXPrv(args []string) error {
	fs := flag.NewFlagSet("master-xprv-from-seed-phrase", flag.ContinueOnError)
	seedPhrase := fs.String("seed-phrase", "", "BIP-39 seed phrase")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *seedPhrase == "" {
		return errors.New("--seed-phrase is required")
	}
	master, err := ownership.MasterXPrvFromSeedPhrase(*seedPhrase)
	if err != nil {
		return err
	}
	fmt.Printf("master_xprv: %s\n", hex.EncodeToString(master))
	return nil
}

func cmdProve(args []string) error {
	fs := flag.NewFlagSet("prove", flag.ContinueOnError)
	masterHex := fs.String("master-xprv", "", "96-byte master XPrv as hex")
	targetHex := fs.String("target-credential", "", "28-byte target credential C as hex")
	outPath := fs.String("out", "ownership-proof.json", "proof artifact output path")
	keysDir := fs.String("keys-dir", prover.DefaultKeyDir(), "local proving/verifying key bundle directory")
	account := fs.Int("account", -1, "CIP-1852 account; omit to scan")
	role := fs.Int("role", -1, "CIP-1852 role; omit to scan")
	index := fs.Int("index", -1, "CIP-1852 address index; omit to scan")
	maxAccount := fs.Uint("max-account", 9, "max account scanned when --account is omitted")
	maxIndex := fs.Uint("max-index", 999, "max index scanned when --index is omitted")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *masterHex == "" {
		return errors.New("--master-xprv is required")
	}
	if *targetHex == "" {
		return errors.New("--target-credential is required")
	}

	master, err := ownership.DecodeMasterXPrvHex(*masterHex)
	if err != nil {
		return err
	}
	target, err := ownership.DecodeCredentialHex(*targetHex)
	if err != nil {
		return err
	}
	path, err := ownership.FindPath(master, target, ownership.SearchOptions{
		Account:    *account,
		Role:       *role,
		Index:      *index,
		MaxAccount: uint32(*maxAccount),
		MaxIndex:   uint32(*maxIndex),
	})
	if err != nil {
		return err
	}

	publicInput, err := ownership.PublicInputForCredential(target)
	if err != nil {
		return err
	}
	assignment, err := ownership.Assignment(master, path, publicInput)
	if err != nil {
		return err
	}

	ccs, err := prover.CompileOwnership()
	if err != nil {
		return err
	}
	bundle, err := prover.LoadOrCreateOwnershipBundle(*keysDir, ccs)
	if err != nil {
		return err
	}
	proof, err := prover.Prove(ccs, bundle.ProvingKey, assignment)
	if err != nil {
		return err
	}
	encodedProof, err := prover.MarshalProof(proof)
	if err != nil {
		return err
	}
	cardanoProof, err := prover.CardanoProofArtifact(proof, target)
	if err != nil {
		return err
	}
	artifactOut := artifact.ProofArtifact{
		Schema:           artifact.ProofSchema,
		CircuitID:        ownership.CircuitID,
		VKHash:           bundle.Manifest.VKHash,
		TargetCredential: hex.EncodeToString(target),
		PublicInput:      ownership.PublicInputHex(publicInput),
		Proof:            encodedProof,
		Cardano:          cardanoProof,
		Path: &artifact.PathMetadata{
			Account: path.Account,
			Role:    path.Role,
			Index:   path.Index,
		},
	}
	if err := artifact.WriteJSON(*outPath, artifactOut); err != nil {
		return err
	}
	fmt.Printf("wrote proof: %s\n", *outPath)
	fmt.Printf("path: m/1852'/1815'/%d'/%d/%d\n", path.Account, path.Role, path.Index)
	fmt.Printf("public_input: %s\n", artifactOut.PublicInput)
	fmt.Printf("vk_hash: %s\n", artifactOut.VKHash)
	return nil
}

func cmdProveDestination(args []string) error {
	fs := flag.NewFlagSet("prove-destination", flag.ContinueOnError)
	masterHex := fs.String("master-xprv", "", "96-byte master XPrv as hex")
	targetHex := fs.String("target-credential", "", "28-byte target credential C as hex")
	outPath := fs.String("out", "ownership-destination-proof.json", "destination-bound proof artifact output path")
	keysDir := fs.String("keys-dir", prover.DefaultDestinationKeyDir(), "local destination proving/verifying key bundle directory")
	destinationHex := fs.String("destination-address-bytes", "", "58-byte destinationAddressV1 value as hex")
	account := fs.Int("account", -1, "CIP-1852 account; omit to scan")
	role := fs.Int("role", -1, "CIP-1852 role; omit to scan")
	index := fs.Int("index", -1, "CIP-1852 address index; omit to scan")
	maxAccount := fs.Uint("max-account", 9, "max account scanned when --account is omitted")
	maxIndex := fs.Uint("max-index", 999, "max index scanned when --index is omitted")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *masterHex == "" {
		return errors.New("--master-xprv is required")
	}
	if *targetHex == "" {
		return errors.New("--target-credential is required")
	}
	if *destinationHex == "" {
		return errors.New("--destination-address-bytes is required")
	}

	master, err := ownership.DecodeMasterXPrvHex(*masterHex)
	if err != nil {
		return err
	}
	target, err := ownershipdest.DecodeCredentialHex(*targetHex)
	if err != nil {
		return err
	}
	destination, err := ownershipdest.DecodeDestinationAddressV1Hex(*destinationHex)
	if err != nil {
		return err
	}
	path, err := ownership.FindPath(master, target, ownership.SearchOptions{
		Account:    *account,
		Role:       *role,
		Index:      *index,
		MaxAccount: uint32(*maxAccount),
		MaxIndex:   uint32(*maxIndex),
	})
	if err != nil {
		return err
	}

	publicInput, err := ownershipdest.PublicInputForCredentialDestination(target, destination)
	if err != nil {
		return err
	}
	assignment, err := ownershipdest.Assignment(master, path, destination, publicInput)
	if err != nil {
		return err
	}

	ccs, err := prover.CompileOwnershipDestination()
	if err != nil {
		return err
	}
	bundle, err := prover.LoadOrCreateOwnershipDestinationBundle(*keysDir, ccs)
	if err != nil {
		return err
	}
	proof, err := prover.Prove(ccs, bundle.ProvingKey, assignment)
	if err != nil {
		return err
	}
	encodedProof, err := prover.MarshalProof(proof)
	if err != nil {
		return err
	}
	publicInputDigest, err := ownershipdest.PublicInputDigestForCredentialDestination(target, destination)
	if err != nil {
		return err
	}
	cardanoProof, err := prover.CardanoProofArtifactWithDigest(proof, publicInputDigest)
	if err != nil {
		return err
	}
	artifactOut := artifact.ProofArtifact{
		Schema:                     artifact.ProofSchema,
		CircuitID:                  ownershipdest.CircuitID,
		VKHash:                     bundle.Manifest.VKHash,
		TargetCredential:           hex.EncodeToString(target),
		DestinationAddressEncoding: ownershipdest.DestinationAddressEncoding,
		DestinationAddress:         hex.EncodeToString(destination),
		PublicInputEncoding:        ownershipdest.PublicInputEncoding,
		PublicInput:                ownershipdest.PublicInputHex(publicInput),
		Proof:                      encodedProof,
		Cardano:                    cardanoProof,
		Path: &artifact.PathMetadata{
			Account: path.Account,
			Role:    path.Role,
			Index:   path.Index,
		},
	}
	if err := artifact.WriteJSON(*outPath, artifactOut); err != nil {
		return err
	}
	fmt.Printf("wrote proof: %s\n", *outPath)
	fmt.Printf("path: m/1852'/1815'/%d'/%d/%d\n", path.Account, path.Role, path.Index)
	fmt.Printf("public_input: %s\n", artifactOut.PublicInput)
	fmt.Printf("vk_hash: %s\n", artifactOut.VKHash)
	return nil
}

func cmdProveMulti(args []string) error {
	fs := flag.NewFlagSet("prove-multi", flag.ContinueOnError)
	masterHex := fs.String("master-xprv", "", "96-byte master XPrv as hex")
	outPath := fs.String("out", "ownership-multi-proof.json", "multi-proof artifact output path")
	keysDir := fs.String("keys-dir", "", "local multi proving/verifying key bundle directory; defaults from credential count")
	destinationHex := fs.String("destination-address-bytes", "", "58-byte destinationAddressV1 value as hex")
	var targetFlags stringListFlag
	var pathFlags pathListFlag
	fs.Var(&targetFlags, "target-credential", "28-byte target credential C as hex; repeat in ledger order")
	fs.Var(&pathFlags, "path", "CIP-1852 path account/role/index; repeat in credential order")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *masterHex == "" {
		return errors.New("--master-xprv is required")
	}
	if *destinationHex == "" {
		return errors.New("--destination-address-bytes is required")
	}

	master, err := ownership.DecodeMasterXPrvHex(*masterHex)
	if err != nil {
		return err
	}
	targets, err := decodeCredentialList(targetFlags)
	if err != nil {
		return err
	}
	paths, err := decodeMultiPaths(pathFlags, len(targets))
	if err != nil {
		return err
	}
	count := len(targets)
	if *keysDir == "" {
		*keysDir = prover.DefaultMultiKeyDirForCount(count)
	}
	destination, err := ownershipmulti.DecodeDestinationAddressV1Hex(*destinationHex)
	if err != nil {
		return err
	}
	derived, err := ownershipmulti.DeriveCredentials(master, paths)
	if err != nil {
		return err
	}
	for i := range targets {
		if !bytes.Equal(targets[i], derived[i]) {
			return fmt.Errorf("target credential %d does not match path %d/%d/%d", i, paths[i].Account, paths[i].Role, paths[i].Index)
		}
	}

	publicInput, err := ownershipmulti.PublicInputForCredentialsDestination(targets, destination)
	if err != nil {
		return err
	}
	assignment, err := ownershipmulti.Assignment(master, paths, destination, publicInput)
	if err != nil {
		return err
	}
	ccs, err := prover.CompileOwnershipMultiCount(count)
	if err != nil {
		return err
	}
	bundle, err := prover.LoadOrCreateOwnershipMultiBundleForCount(*keysDir, ccs, count)
	if err != nil {
		return err
	}
	proof, err := prover.Prove(ccs, bundle.ProvingKey, assignment)
	if err != nil {
		return err
	}
	encodedProof, err := prover.MarshalProof(proof)
	if err != nil {
		return err
	}
	publicInputDigest, err := ownershipmulti.PublicInputDigestForCredentialsDestination(targets, destination)
	if err != nil {
		return err
	}
	cardanoProof, err := prover.CardanoProofArtifactWithDigest(proof, publicInputDigest)
	if err != nil {
		return err
	}
	artifactOut := artifact.ProofArtifact{
		Schema:                     artifact.ProofSchema,
		CircuitID:                  ownershipmulti.CircuitIDForCount(count),
		VKHash:                     bundle.Manifest.VKHash,
		TargetCredentials:          encodeHexList(targets),
		DestinationAddressEncoding: ownershipmulti.DestinationAddressEncoding,
		DestinationAddress:         hex.EncodeToString(destination),
		CredentialCount:            count,
		PublicInputEncoding:        ownershipmulti.PublicInputEncoding,
		PublicInput:                ownershipmulti.PublicInputHex(publicInput),
		Proof:                      encodedProof,
		Cardano:                    cardanoProof,
		Paths:                      encodePathMetadata(paths),
	}
	if err := artifact.WriteJSON(*outPath, artifactOut); err != nil {
		return err
	}
	fmt.Printf("wrote proof: %s\n", *outPath)
	for i, path := range paths {
		fmt.Printf("path_%d: m/1852'/1815'/%d'/%d/%d\n", i, path.Account, path.Role, path.Index)
	}
	fmt.Printf("public_input: %s\n", artifactOut.PublicInput)
	fmt.Printf("vk_hash: %s\n", artifactOut.VKHash)
	return nil
}

func cmdVerify(args []string) error {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	proofPath := fs.String("master-xprv-proof", "", "proof artifact JSON path")
	keysDir := fs.String("keys-dir", prover.DefaultKeyDir(), "local verifying key bundle directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *proofPath == "" && fs.NArg() == 1 {
		*proofPath = fs.Arg(0)
	}
	if *proofPath == "" {
		return errors.New("--master-xprv-proof is required")
	}

	proofArtifact, err := artifact.ReadProof(*proofPath)
	if err != nil {
		return err
	}
	if proofArtifact.CircuitID != ownership.CircuitID {
		return fmt.Errorf("artifact circuit id %q, want %q", proofArtifact.CircuitID, ownership.CircuitID)
	}
	target, err := ownership.DecodeCredentialHex(proofArtifact.TargetCredential)
	if err != nil {
		return err
	}
	publicInput, err := ownership.PublicInputForCredential(target)
	if err != nil {
		return err
	}
	if got := ownership.PublicInputHex(publicInput); got != proofArtifact.PublicInput {
		return fmt.Errorf("artifact public input %s does not match recomputed %s", proofArtifact.PublicInput, got)
	}

	bundle, err := prover.LoadOwnershipVerifier(*keysDir)
	if err != nil {
		return err
	}
	if proofArtifact.VKHash != bundle.Manifest.VKHash {
		return fmt.Errorf("artifact vk hash %s does not match bundled %s", proofArtifact.VKHash, bundle.Manifest.VKHash)
	}
	proof, err := prover.UnmarshalProof(proofArtifact.Proof)
	if err != nil {
		return err
	}
	publicAssignment := &ownership.Circuit{Pub: publicInput}
	if err := prover.VerifyProof(bundle.VerifyingKey, proof, publicAssignment); err != nil {
		return err
	}
	fmt.Println("verified")
	return nil
}

func cmdVerifyDestination(args []string) error {
	fs := flag.NewFlagSet("verify-destination", flag.ContinueOnError)
	proofPath := fs.String("destination-proof", "", "destination-bound proof artifact JSON path")
	keysDir := fs.String("keys-dir", prover.DefaultDestinationKeyDir(), "local destination verifying key bundle directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *proofPath == "" && fs.NArg() == 1 {
		*proofPath = fs.Arg(0)
	}
	if *proofPath == "" {
		return errors.New("--destination-proof is required")
	}

	proofArtifact, err := artifact.ReadProof(*proofPath)
	if err != nil {
		return err
	}
	publicInput, _, err := validateDestinationProofArtifact(proofArtifact)
	if err != nil {
		return err
	}
	bundle, err := prover.LoadOwnershipDestinationVerifier(*keysDir)
	if err != nil {
		return err
	}
	if proofArtifact.VKHash != bundle.Manifest.VKHash {
		return fmt.Errorf("artifact vk hash %s does not match bundled %s", proofArtifact.VKHash, bundle.Manifest.VKHash)
	}
	proof, err := prover.UnmarshalProof(proofArtifact.Proof)
	if err != nil {
		return err
	}
	if err := prover.VerifyProof(bundle.VerifyingKey, proof, &ownershipdest.Circuit{Pub: publicInput}); err != nil {
		return err
	}
	fmt.Println("verified")
	return nil
}

func cmdVerifyMulti(args []string) error {
	fs := flag.NewFlagSet("verify-multi", flag.ContinueOnError)
	proofPath := fs.String("multi-proof", "", "multi-proof artifact JSON path")
	keysDir := fs.String("keys-dir", "", "local multi verifying key bundle directory; defaults from artifact credential count")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *proofPath == "" && fs.NArg() == 1 {
		*proofPath = fs.Arg(0)
	}
	if *proofPath == "" {
		return errors.New("--multi-proof is required")
	}

	proofArtifact, err := artifact.ReadProof(*proofPath)
	if err != nil {
		return err
	}
	publicInput, _, count, err := validateMultiProofArtifact(proofArtifact)
	if err != nil {
		return err
	}
	if *keysDir == "" {
		*keysDir = prover.DefaultMultiKeyDirForCount(count)
	}
	bundle, err := prover.LoadOwnershipMultiVerifierForCount(*keysDir, count)
	if err != nil {
		return err
	}
	if proofArtifact.VKHash != bundle.Manifest.VKHash {
		return fmt.Errorf("artifact vk hash %s does not match bundled %s", proofArtifact.VKHash, bundle.Manifest.VKHash)
	}
	proof, err := prover.UnmarshalProof(proofArtifact.Proof)
	if err != nil {
		return err
	}
	publicAssignment, err := ownershipmulti.PublicAssignment(count, publicInput)
	if err != nil {
		return err
	}
	if err := prover.VerifyProof(bundle.VerifyingKey, proof, publicAssignment); err != nil {
		return err
	}
	fmt.Println("verified")
	return nil
}

func cmdExportCardano(args []string) error {
	fs := flag.NewFlagSet("export-cardano", flag.ContinueOnError)
	proofPath := fs.String("master-xprv-proof", "", "proof artifact JSON path")
	keysDir := fs.String("keys-dir", "", "local verifying key bundle directory; defaults from artifact circuit id")
	outDir := fs.String("out-dir", "cardano-proof", "directory for proof.hex, vk.hex, pub.hex, and format.txt")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *proofPath == "" && fs.NArg() == 1 {
		*proofPath = fs.Arg(0)
	}
	if *proofPath == "" {
		return errors.New("--master-xprv-proof is required")
	}

	proofArtifact, err := artifact.ReadProof(*proofPath)
	if err != nil {
		return err
	}
	switch {
	case proofArtifact.CircuitID == ownership.CircuitID:
		return exportCardanoSingle(proofArtifact, *keysDir, *outDir)
	case proofArtifact.CircuitID == ownershipdest.CircuitID:
		return exportCardanoDestination(proofArtifact, *keysDir, *outDir)
	case ownershipmulti.IsCircuitID(proofArtifact.CircuitID):
		return exportCardanoMulti(proofArtifact, *keysDir, *outDir)
	default:
		return fmt.Errorf("artifact circuit id %q is not supported", proofArtifact.CircuitID)
	}
}

func cmdExportCardanoVK(args []string) error {
	fs := flag.NewFlagSet("export-cardano-vk", flag.ContinueOnError)
	keyVersion := fs.String("key-version", prover.DefaultDestinationKeyVersion, "key version to export")
	keysDir := fs.String("keys-dir", "", "verifying key bundle directory; defaults from key version")
	outPath := fs.String("out", "cardano-vk/vk.hex", "Cardano verifier key hex output path")
	formatPath := fs.String("format-out", "cardano-vk/format.txt", "Cardano verifier key format output path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments: %s", strings.Join(fs.Args(), " "))
	}
	profile, err := ceremonyProfileForKeyVersion(*keyVersion)
	if err != nil {
		return err
	}
	resolvedKeysDir := *keysDir
	if strings.TrimSpace(resolvedKeysDir) == "" {
		resolvedKeysDir = profile.DefaultKeysDir
	}
	bundle, err := profile.LoadVerifier(resolvedKeysDir)
	if err != nil {
		return err
	}
	vkBytes, vkFormat, err := prover.SerializeCardanoVK(bundle.VerifyingKey)
	if err != nil {
		return err
	}
	if err := mkdirParent(*outPath); err != nil {
		return err
	}
	if err := mkdirParent(*formatPath); err != nil {
		return err
	}
	if err := os.WriteFile(*outPath, []byte(hex.EncodeToString(vkBytes)+"\n"), 0o600); err != nil {
		return fmt.Errorf("write %s: %w", *outPath, err)
	}
	if err := writeTextFile(*formatPath, vkFormat+"\n"); err != nil {
		return err
	}
	vkDigest := blake2b.Sum256(vkBytes)
	fmt.Printf("wrote cardano vk: %s\n", *outPath)
	fmt.Printf("format: %s\n", vkFormat)
	fmt.Printf("vk_bytes: %d\n", len(vkBytes))
	fmt.Printf("vk_hash: %s\n", bundle.Manifest.VKHash)
	fmt.Printf("cardano_vk_blake2b256: blake2b256:%s\n", hex.EncodeToString(vkDigest[:]))
	return nil
}

func exportCardanoSingle(proofArtifact *artifact.ProofArtifact, keysDir, outDir string) error {
	if keysDir == "" {
		keysDir = prover.DefaultKeyDir()
	}
	if proofArtifact.CircuitID != ownership.CircuitID {
		return fmt.Errorf("artifact circuit id %q, want %q", proofArtifact.CircuitID, ownership.CircuitID)
	}
	target, err := ownership.DecodeCredentialHex(proofArtifact.TargetCredential)
	if err != nil {
		return err
	}
	publicInput, err := ownership.PublicInputForCredential(target)
	if err != nil {
		return err
	}
	if got := ownership.PublicInputHex(publicInput); got != proofArtifact.PublicInput {
		return fmt.Errorf("artifact public input %s does not match recomputed %s", proofArtifact.PublicInput, got)
	}
	publicInputDigest, err := ownership.PublicInputDigestForCredential(target)
	if err != nil {
		return err
	}

	vkPath := filepath.Join(keysDir, "ownership.vk")
	vkDigest, err := prover.DigestFile(vkPath)
	if err != nil {
		return err
	}
	if proofArtifact.VKHash != vkDigest.Blake2b256 {
		return fmt.Errorf("artifact vk hash %s does not match %s hash %s", proofArtifact.VKHash, vkPath, vkDigest.Blake2b256)
	}
	verifyingKey, err := prover.LoadVK(vkPath)
	if err != nil {
		return err
	}
	proof, err := prover.UnmarshalProof(proofArtifact.Proof)
	if err != nil {
		return err
	}
	if err := prover.VerifyProof(verifyingKey, proof, &ownership.Circuit{Pub: publicInput}); err != nil {
		return err
	}

	proofBytes, proofFormat, err := prover.SerializeCardanoProof(proof)
	if err != nil {
		return err
	}
	vkBytes, vkFormat, err := prover.SerializeCardanoVK(verifyingKey)
	if err != nil {
		return err
	}
	if proofFormat != vkFormat {
		return fmt.Errorf("cardano proof format %q does not match vk format %q", proofFormat, vkFormat)
	}

	if err := os.MkdirAll(outDir, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", outDir, err)
	}
	if err := writeHexFile(filepath.Join(outDir, "proof.hex"), proofBytes); err != nil {
		return err
	}
	if err := writeHexFile(filepath.Join(outDir, "vk.hex"), vkBytes); err != nil {
		return err
	}
	if err := writeHexFile(filepath.Join(outDir, "pub.hex"), publicInputDigest); err != nil {
		return err
	}
	if err := writeTextFile(filepath.Join(outDir, "format.txt"), proofFormat+"\n"); err != nil {
		return err
	}

	fmt.Printf("wrote cardano proof: %s\n", filepath.Join(outDir, "proof.hex"))
	fmt.Printf("wrote cardano vk: %s\n", filepath.Join(outDir, "vk.hex"))
	fmt.Printf("wrote public input digest: %s\n", filepath.Join(outDir, "pub.hex"))
	fmt.Printf("format: %s\n", proofFormat)
	fmt.Printf("proof_bytes: %d\n", len(proofBytes))
	fmt.Printf("vk_bytes: %d\n", len(vkBytes))
	return nil
}

func exportCardanoDestination(proofArtifact *artifact.ProofArtifact, keysDir, outDir string) error {
	if keysDir == "" {
		keysDir = prover.DefaultDestinationKeyDir()
	}
	publicInput, publicInputDigest, err := validateDestinationProofArtifact(proofArtifact)
	if err != nil {
		return err
	}
	bundle, err := prover.LoadOwnershipDestinationVerifier(keysDir)
	if err != nil {
		return err
	}
	if proofArtifact.VKHash != bundle.Manifest.VKHash {
		return fmt.Errorf("artifact vk hash %s does not match bundled %s", proofArtifact.VKHash, bundle.Manifest.VKHash)
	}
	proof, err := prover.UnmarshalProof(proofArtifact.Proof)
	if err != nil {
		return err
	}
	if err := prover.VerifyProof(bundle.VerifyingKey, proof, &ownershipdest.Circuit{Pub: publicInput}); err != nil {
		return err
	}

	proofBytes, proofFormat, err := prover.SerializeCardanoProof(proof)
	if err != nil {
		return err
	}
	vkBytes, vkFormat, err := prover.SerializeCardanoVK(bundle.VerifyingKey)
	if err != nil {
		return err
	}
	if proofFormat != vkFormat {
		return fmt.Errorf("cardano proof format %q does not match vk format %q", proofFormat, vkFormat)
	}

	if err := os.MkdirAll(outDir, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", outDir, err)
	}
	if err := writeHexFile(filepath.Join(outDir, "proof.hex"), proofBytes); err != nil {
		return err
	}
	if err := writeHexFile(filepath.Join(outDir, "vk.hex"), vkBytes); err != nil {
		return err
	}
	if err := writeHexFile(filepath.Join(outDir, "pub.hex"), publicInputDigest); err != nil {
		return err
	}
	if err := writeTextFile(filepath.Join(outDir, "format.txt"), proofFormat+"\n"); err != nil {
		return err
	}

	fmt.Printf("wrote cardano proof: %s\n", filepath.Join(outDir, "proof.hex"))
	fmt.Printf("wrote cardano vk: %s\n", filepath.Join(outDir, "vk.hex"))
	fmt.Printf("wrote public input digest: %s\n", filepath.Join(outDir, "pub.hex"))
	fmt.Printf("format: %s\n", proofFormat)
	fmt.Printf("proof_bytes: %d\n", len(proofBytes))
	fmt.Printf("vk_bytes: %d\n", len(vkBytes))
	return nil
}

func exportCardanoMulti(proofArtifact *artifact.ProofArtifact, keysDir, outDir string) error {
	publicInput, publicInputDigest, count, err := validateMultiProofArtifact(proofArtifact)
	if err != nil {
		return err
	}
	if keysDir == "" {
		keysDir = prover.DefaultMultiKeyDirForCount(count)
	}
	bundle, err := prover.LoadOwnershipMultiVerifierForCount(keysDir, count)
	if err != nil {
		return err
	}
	if proofArtifact.VKHash != bundle.Manifest.VKHash {
		return fmt.Errorf("artifact vk hash %s does not match bundled %s", proofArtifact.VKHash, bundle.Manifest.VKHash)
	}
	proof, err := prover.UnmarshalProof(proofArtifact.Proof)
	if err != nil {
		return err
	}
	publicAssignment, err := ownershipmulti.PublicAssignment(count, publicInput)
	if err != nil {
		return err
	}
	if err := prover.VerifyProof(bundle.VerifyingKey, proof, publicAssignment); err != nil {
		return err
	}

	proofBytes, proofFormat, err := prover.SerializeCardanoProof(proof)
	if err != nil {
		return err
	}
	vkBytes, vkFormat, err := prover.SerializeCardanoVK(bundle.VerifyingKey)
	if err != nil {
		return err
	}
	if proofFormat != vkFormat {
		return fmt.Errorf("cardano proof format %q does not match vk format %q", proofFormat, vkFormat)
	}

	if err := os.MkdirAll(outDir, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", outDir, err)
	}
	if err := writeHexFile(filepath.Join(outDir, "proof.hex"), proofBytes); err != nil {
		return err
	}
	if err := writeHexFile(filepath.Join(outDir, "vk.hex"), vkBytes); err != nil {
		return err
	}
	if err := writeHexFile(filepath.Join(outDir, "pub.hex"), publicInputDigest); err != nil {
		return err
	}
	if err := writeTextFile(filepath.Join(outDir, "format.txt"), proofFormat+"\n"); err != nil {
		return err
	}

	fmt.Printf("wrote cardano proof: %s\n", filepath.Join(outDir, "proof.hex"))
	fmt.Printf("wrote cardano vk: %s\n", filepath.Join(outDir, "vk.hex"))
	fmt.Printf("wrote public input digest: %s\n", filepath.Join(outDir, "pub.hex"))
	fmt.Printf("format: %s\n", proofFormat)
	fmt.Printf("proof_bytes: %d\n", len(proofBytes))
	fmt.Printf("vk_bytes: %d\n", len(vkBytes))
	return nil
}

type stringListFlag []string

func (f *stringListFlag) String() string {
	return strings.Join(*f, ",")
}

func (f *stringListFlag) Set(value string) error {
	*f = append(*f, value)
	return nil
}

type pathListFlag []ownership.Path

func (f *pathListFlag) String() string {
	parts := make([]string, 0, len(*f))
	for _, path := range *f {
		parts = append(parts, fmt.Sprintf("%d/%d/%d", path.Account, path.Role, path.Index))
	}
	return strings.Join(parts, ",")
}

func (f *pathListFlag) Set(value string) error {
	parts := strings.FieldsFunc(strings.TrimSpace(value), func(r rune) bool {
		return r == '/' || r == ','
	})
	if len(parts) != 3 {
		return fmt.Errorf("path %q must be account/role/index", value)
	}
	account, err := parsePathPart(parts[0], "account")
	if err != nil {
		return err
	}
	role, err := parsePathPart(parts[1], "role")
	if err != nil {
		return err
	}
	index, err := parsePathPart(parts[2], "index")
	if err != nil {
		return err
	}
	*f = append(*f, ownership.Path{Account: account, Role: role, Index: index})
	return nil
}

func parsePathPart(value, name string) (uint32, error) {
	parsed, err := strconv.ParseUint(strings.TrimSpace(value), 10, 32)
	if err != nil {
		return 0, fmt.Errorf("%s path component %q is invalid", name, value)
	}
	return uint32(parsed), nil
}

func decodeCredentialList(values []string) ([][]byte, error) {
	if err := ownershipmulti.ValidateCredentialCount(len(values)); err != nil {
		return nil, fmt.Errorf("--target-credential: %w", err)
	}
	out := make([][]byte, len(values))
	for i, value := range values {
		credential, err := ownershipmulti.DecodeCredentialHex(value)
		if err != nil {
			return nil, fmt.Errorf("target credential %d: %w", i, err)
		}
		out[i] = credential
	}
	return out, nil
}

func decodeMultiPaths(values []ownership.Path, wantCount int) ([]ownership.Path, error) {
	if err := ownershipmulti.ValidateCredentialCount(wantCount); err != nil {
		return nil, err
	}
	if len(values) != wantCount {
		return nil, fmt.Errorf("--path must be repeated exactly %d times", wantCount)
	}
	out := make([]ownership.Path, len(values))
	copy(out, values)
	return out, nil
}

func encodePathMetadata(paths []ownership.Path) []artifact.PathMetadata {
	out := make([]artifact.PathMetadata, len(paths))
	for i, path := range paths {
		out[i] = artifact.PathMetadata{Account: path.Account, Role: path.Role, Index: path.Index}
	}
	return out
}

func encodeHexList(values [][]byte) []string {
	out := make([]string, len(values))
	for i, value := range values {
		out[i] = hex.EncodeToString(value)
	}
	return out
}

func validateDestinationProofArtifact(proofArtifact *artifact.ProofArtifact) (*big.Int, []byte, error) {
	if proofArtifact.CircuitID != ownershipdest.CircuitID {
		return nil, nil, fmt.Errorf("artifact circuit id %q, want %q", proofArtifact.CircuitID, ownershipdest.CircuitID)
	}
	if proofArtifact.PublicInputEncoding != ownershipdest.PublicInputEncoding {
		return nil, nil, fmt.Errorf("artifact public input encoding %q, want %q", proofArtifact.PublicInputEncoding, ownershipdest.PublicInputEncoding)
	}
	if proofArtifact.DestinationAddressEncoding != ownershipdest.DestinationAddressEncoding {
		return nil, nil, fmt.Errorf("artifact destination address encoding %q, want %q", proofArtifact.DestinationAddressEncoding, ownershipdest.DestinationAddressEncoding)
	}
	credential, err := ownershipdest.DecodeCredentialHex(proofArtifact.TargetCredential)
	if err != nil {
		return nil, nil, err
	}
	destination, err := ownershipdest.DecodeDestinationAddressV1Hex(proofArtifact.DestinationAddress)
	if err != nil {
		return nil, nil, err
	}
	publicInput, err := ownershipdest.PublicInputForCredentialDestination(credential, destination)
	if err != nil {
		return nil, nil, err
	}
	if got := ownershipdest.PublicInputHex(publicInput); got != proofArtifact.PublicInput {
		return nil, nil, fmt.Errorf("artifact public input %s does not match recomputed %s", proofArtifact.PublicInput, got)
	}
	publicInputDigest, err := ownershipdest.PublicInputDigestForCredentialDestination(credential, destination)
	if err != nil {
		return nil, nil, err
	}
	return publicInput, publicInputDigest, nil
}

func validateMultiProofArtifact(proofArtifact *artifact.ProofArtifact) (*big.Int, []byte, int, error) {
	count, ok := ownershipmulti.CircuitCountFromID(proofArtifact.CircuitID)
	if !ok {
		return nil, nil, 0, fmt.Errorf("artifact circuit id %q is not a supported multi circuit id", proofArtifact.CircuitID)
	}
	if proofArtifact.CredentialCount != count {
		return nil, nil, 0, fmt.Errorf("artifact credential count %d, want %d", proofArtifact.CredentialCount, count)
	}
	if proofArtifact.PublicInputEncoding != ownershipmulti.PublicInputEncoding {
		return nil, nil, 0, fmt.Errorf("artifact public input encoding %q, want %q", proofArtifact.PublicInputEncoding, ownershipmulti.PublicInputEncoding)
	}
	if proofArtifact.DestinationAddressEncoding != ownershipmulti.DestinationAddressEncoding {
		return nil, nil, 0, fmt.Errorf("artifact destination address encoding %q, want %q", proofArtifact.DestinationAddressEncoding, ownershipmulti.DestinationAddressEncoding)
	}
	credentials, err := decodeCredentialList(proofArtifact.TargetCredentials)
	if err != nil {
		return nil, nil, 0, err
	}
	if len(credentials) != count {
		return nil, nil, 0, fmt.Errorf("artifact target credential count %d, want %d", len(credentials), count)
	}
	destination, err := ownershipmulti.DecodeDestinationAddressV1Hex(proofArtifact.DestinationAddress)
	if err != nil {
		return nil, nil, 0, err
	}
	publicInput, err := ownershipmulti.PublicInputForCredentialsDestination(credentials, destination)
	if err != nil {
		return nil, nil, 0, err
	}
	if got := ownershipmulti.PublicInputHex(publicInput); got != proofArtifact.PublicInput {
		return nil, nil, 0, fmt.Errorf("artifact public input %s does not match recomputed %s", proofArtifact.PublicInput, got)
	}
	publicInputDigest, err := ownershipmulti.PublicInputDigestForCredentialsDestination(credentials, destination)
	if err != nil {
		return nil, nil, 0, err
	}
	return publicInput, publicInputDigest, count, nil
}

func cmdServeVerifier(args []string) error {
	fs := flag.NewFlagSet("serve-verifier", flag.ContinueOnError)
	addr := fs.String("addr", "127.0.0.1:8081", "verifier listen address")
	keysDir := fs.String("keys-dir", prover.DefaultKeyDir(), "local verifying key bundle directory")
	allowedOrigins := fs.String("allowed-origin", "http://localhost:3000,http://127.0.0.1:3000", "comma-separated browser origins allowed by CORS")
	devCreateKeys := fs.Bool("dev-create-keys", false, "development only: create the key bundle if it is missing")
	fixtureMode := fs.Bool("fixture", false, "development only: accept fixture proofs for UI/control-flow testing")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if !strings.HasPrefix(*addr, "127.0.0.1:") && !strings.HasPrefix(*addr, "localhost:") {
		return fmt.Errorf("serve-verifier must bind to loopback, got %q", *addr)
	}
	var proofVerifier verifier.ProofVerifier
	var err error
	if *fixtureMode {
		proofVerifier = verifier.FixtureVerifier{}
	} else if *devCreateKeys {
		ccs, compileErr := prover.CompileOwnership()
		if compileErr != nil {
			return compileErr
		}
		if _, err = prover.LoadOrCreateOwnershipBundle(*keysDir, ccs); err != nil {
			return err
		}
		proofVerifier, err = verifier.LoadBundleVerifier(*keysDir)
		if err != nil {
			return err
		}
	} else {
		proofVerifier, err = verifier.LoadBundleVerifier(*keysDir)
		if err != nil {
			return err
		}
	}
	server := &http.Server{
		Addr:              *addr,
		Handler:           verifier.NewServer(proofVerifier, splitCSV(*allowedOrigins)).Handler(),
		ReadHeaderTimeout: 5_000_000_000,
	}
	fmt.Fprintf(os.Stderr, "proof verifier listening on http://%s\n", *addr)
	fmt.Fprintf(os.Stderr, "circuit_id: %s\n", ownership.CircuitID)
	fmt.Fprintf(os.Stderr, "vk_hash: %s\n", proofVerifier.VKHash())
	if *fixtureMode {
		fmt.Fprintln(os.Stderr, "mode: fixture")
	}
	return server.ListenAndServe()
}

func cmdServeHelper(args []string) error {
	fs := flag.NewFlagSet("serve-helper", flag.ContinueOnError)
	addr := fs.String("addr", "127.0.0.1:0", "helper listen address")
	keysDir := fs.String("keys-dir", prover.DefaultKeyDir(), "local proving/verifying key bundle directory")
	destinationKeysDir := fs.String("destination-keys-dir", prover.DefaultDestinationKeyDir(), "local destination proving/verifying key bundle directory")
	siteURL := fs.String("site-url", "", "website URL to open with an automatic pairing fragment")
	devCreateKeys := fs.Bool("dev-create-keys", false, "development only: create the key bundle if it is missing")
	fixtureMode := fs.Bool("fixture", false, "development only: return fixture artifacts for UI/control-flow testing")
	noOpen := fs.Bool("no-open", false, "do not open the paired website automatically")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*siteURL) == "" {
		return errors.New("--site-url is required so the helper can pair the browser automatically")
	}
	if !strings.HasPrefix(*addr, "127.0.0.1:") && !strings.HasPrefix(*addr, "localhost:") {
		return fmt.Errorf("serve-helper must bind to loopback, got %q", *addr)
	}
	token, err := randomToken()
	if err != nil {
		return err
	}
	var generator helper.Generator = &helper.OwnershipGenerator{KeysDir: *keysDir, DestinationKeysDir: *destinationKeysDir, AllowCreateKeys: *devCreateKeys}
	if *fixtureMode {
		generator = helper.FixtureGenerator{}
	}
	siteOrigin, err := originForURL(*siteURL)
	if err != nil {
		return err
	}
	origins := []string{siteOrigin}
	companion := helper.NewServer(generator, token, origins)
	server := &http.Server{
		Handler:           companion.Handler(),
		ReadHeaderTimeout: 5_000_000_000,
	}
	companion.Shutdown = func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}
	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		return err
	}
	actualAddr := listener.Addr().String()
	helperURL := "http://" + actualAddr
	fmt.Fprintf(os.Stderr, "proof helper listening on %s\n", helperURL)
	fmt.Fprintf(os.Stderr, "allowed_origins: %s\n", strings.Join(origins, ","))
	if *fixtureMode {
		fmt.Fprintln(os.Stderr, "mode: fixture")
	}
	pairedURL, err := pairedSiteURL(*siteURL, helperURL, token)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "opening_site: %s\n", pairedURL)
	key := helper.KeyStatus{State: "unknown"}
	if reporter, ok := generator.(helper.KeyStatusReporter); ok {
		key = reporter.KeyStatus()
	}
	var destinationProfile *helper.ProfileStatus
	if reporter, ok := generator.(helper.DestinationKeyStatusReporter); ok {
		destinationKey := reporter.DestinationKeyStatus()
		destinationProfile = &helper.ProfileStatus{
			Profile:       helper.DestinationProfileSingle,
			CircuitID:     ownershipdest.CircuitID,
			KeyVersion:    destinationKey.KeyVersion,
			KeyHash:       destinationKey.VKHash,
			KeyReady:      destinationKey.Ready,
			KeyState:      destinationKey.State,
			KeyError:      destinationKey.Error,
			Compatibility: helperCompatibilityForKey(destinationKey),
		}
	}
	if err := writeStartupJSON(os.Stdout, helperStartupEvent{
		Type:               "proof_tool_helper_ready",
		HelperURL:          helperURL,
		SiteURL:            *siteURL,
		PairingURL:         pairedURL,
		Token:              token,
		AllowedOrigins:     origins,
		SidecarVersion:     helper.SidecarVersion,
		ProtocolVersion:    helper.ProtocolVersion,
		CircuitID:          ownership.CircuitID,
		KeyState:           key.State,
		KeyReady:           key.Ready,
		KeyVersion:         key.KeyVersion,
		KeyHash:            key.VKHash,
		KeyCompatibility:   helperCompatibilityForKey(key),
		DestinationProfile: destinationProfile,
	}); err != nil {
		return err
	}
	if !*noOpen {
		if err := openBrowser(pairedURL); err != nil {
			fmt.Fprintf(os.Stderr, "open_site_error: %v\n", err)
		}
	}
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

type helperStartupEvent struct {
	Type               string                `json:"type"`
	HelperURL          string                `json:"helper_url"`
	SiteURL            string                `json:"site_url"`
	PairingURL         string                `json:"pairing_url"`
	Token              string                `json:"token"`
	AllowedOrigins     []string              `json:"allowed_origins"`
	SidecarVersion     string                `json:"sidecar_version"`
	ProtocolVersion    string                `json:"protocol_version"`
	CircuitID          string                `json:"circuit_id"`
	KeyState           string                `json:"key_state"`
	KeyReady           bool                  `json:"key_ready"`
	KeyVersion         string                `json:"key_version,omitempty"`
	KeyHash            string                `json:"key_hash,omitempty"`
	KeyCompatibility   string                `json:"key_compatibility"`
	DestinationProfile *helper.ProfileStatus `json:"destination_profile,omitempty"`
}

func writeStartupJSON(w io.Writer, event helperStartupEvent) error {
	b, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal startup JSON: %w", err)
	}
	if _, err := fmt.Fprintln(w, string(b)); err != nil {
		return fmt.Errorf("write startup JSON: %w", err)
	}
	return nil
}

func helperCompatibilityForKey(key helper.KeyStatus) string {
	if key.Ready {
		return "ready"
	}
	switch key.State {
	case "missing":
		return "key_missing"
	case "downloading":
		return "key_downloading"
	case "invalid":
		return "update_required"
	default:
		return "not_ready"
	}
}

func randomToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func originForURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("site URL must use http or https, got %q", parsed.Scheme)
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("site URL must include a host")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

func pairedSiteURL(raw, helperURL, token string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	fragment := url.Values{}
	fragment.Set("helper", helperURL)
	fragment.Set("pair", token)
	decodedFragment, err := url.QueryUnescape(fragment.Encode())
	if err != nil {
		return "", err
	}
	parsed.Fragment = decodedFragment
	return parsed.String(), nil
}

func openBrowser(raw string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", raw)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", raw)
	default:
		cmd = exec.Command("xdg-open", raw)
	}
	return cmd.Start()
}

func writeHexFile(path string, b []byte) error {
	return writeTextFile(path, hex.EncodeToString(b)+"\n")
}

func writeTextFile(path, text string) error {
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: proof-tool <master-xprv-from-seed-phrase|prove|prove-destination|prove-multi|verify|verify-destination|verify-multi|export-cardano|export-cardano-vk|generate-destination-benchmark-fixtures|generate-multi-benchmark-fixtures|setup-ceremony|verify-key-bundle|generate-chunk-manifest|serve-verifier|serve-helper> [flags]")
}
