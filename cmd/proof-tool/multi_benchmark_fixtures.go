package main

import (
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/circuit/ownershipmulti"
	"proof-tool/internal/prover"
)

const multiBenchmarkFixturesSchema = "proof-tool-multi-benchmark-fixtures-v1"

type multiBenchmarkFixturesFile struct {
	Schema                     string                  `json:"schema"`
	DestinationAddressEncoding string                  `json:"destination_address_encoding"`
	DestinationAddress         string                  `json:"destination_address"`
	PublicInputEncoding        string                  `json:"public_input_encoding"`
	Fixtures                   []multiBenchmarkFixture `json:"fixtures"`
}

type multiBenchmarkFixture struct {
	CredentialCount      int                     `json:"credential_count"`
	CircuitID            string                  `json:"circuit_id"`
	KeyVersion           string                  `json:"key_version"`
	VKHash               string                  `json:"vk_hash"`
	Format               string                  `json:"format"`
	PublicInput          string                  `json:"public_input"`
	PublicInputDigestHex string                  `json:"public_input_digest_hex"`
	ProofHex             string                  `json:"proof_hex"`
	VKHex                string                  `json:"vk_hex"`
	TargetCredentials    []string                `json:"target_credentials"`
	Paths                []artifact.PathMetadata `json:"paths"`
}

func cmdGenerateMultiBenchmarkFixtures(args []string) error {
	fs := flag.NewFlagSet("generate-multi-benchmark-fixtures", flag.ContinueOnError)
	masterHex := fs.String("master-xprv", "", "96-byte master XPrv as hex")
	destinationHex := fs.String("destination-address-bytes", "", "58-byte destinationAddressV1 value as hex")
	outPath := fs.String("out", "contracts/ownership-verifier/testdata/multi-benchmark-fixtures.json", "benchmark fixture JSON output path")
	workDir := fs.String("work-dir", ".proof-tool/multi-benchmark-fixtures", "work directory for count-specific key bundles")
	countsFlag := fs.String("counts", "1,5", "comma-separated credential counts")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *masterHex == "" {
		return fmt.Errorf("--master-xprv is required")
	}
	if *destinationHex == "" {
		return fmt.Errorf("--destination-address-bytes is required")
	}

	counts, err := parseBenchmarkCounts(*countsFlag)
	if err != nil {
		return err
	}
	master, err := ownership.DecodeMasterXPrvHex(*masterHex)
	if err != nil {
		return err
	}
	destination, err := ownershipmulti.DecodeDestinationAddressV1Hex(*destinationHex)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(*workDir, 0o700); err != nil {
		return fmt.Errorf("create work dir %s: %w", *workDir, err)
	}
	if err := os.MkdirAll(filepath.Dir(*outPath), 0o700); err != nil {
		return fmt.Errorf("create fixture output dir: %w", err)
	}

	out := multiBenchmarkFixturesFile{
		Schema:                     multiBenchmarkFixturesSchema,
		DestinationAddressEncoding: ownershipmulti.DestinationAddressEncoding,
		DestinationAddress:         hex.EncodeToString(destination),
		PublicInputEncoding:        ownershipmulti.PublicInputEncoding,
		Fixtures:                   make([]multiBenchmarkFixture, 0, len(counts)),
	}
	for _, count := range counts {
		fmt.Printf("generating multi benchmark fixture count=%d\n", count)
		fixture, err := generateMultiBenchmarkFixture(master, destination, count, filepath.Join(*workDir, fmt.Sprintf("keys-count%d", count)))
		if err != nil {
			return err
		}
		out.Fixtures = append(out.Fixtures, fixture)
		fmt.Printf("generated count=%d public_input=%s vk_hash=%s\n", count, fixture.PublicInput, fixture.VKHash)
		if err := artifact.WriteJSON(*outPath, out); err != nil {
			return err
		}
		fmt.Printf("updated multi benchmark fixtures: %s\n", *outPath)
	}

	if err := artifact.WriteJSON(*outPath, out); err != nil {
		return err
	}
	fmt.Printf("wrote multi benchmark fixtures: %s\n", *outPath)
	return nil
}

func generateMultiBenchmarkFixture(master, destination []byte, count int, keysDir string) (multiBenchmarkFixture, error) {
	if err := ownershipmulti.ValidateCredentialCount(count); err != nil {
		return multiBenchmarkFixture{}, err
	}
	paths := make([]ownership.Path, count)
	for i := range paths {
		paths[i] = ownership.Path{Account: 0, Role: 0, Index: uint32(i)}
	}
	credentials, err := ownershipmulti.DeriveCredentials(master, paths)
	if err != nil {
		return multiBenchmarkFixture{}, err
	}
	publicInput, err := ownershipmulti.PublicInputForCredentialsDestination(credentials, destination)
	if err != nil {
		return multiBenchmarkFixture{}, err
	}
	publicInputDigest, err := ownershipmulti.PublicInputDigestForCredentialsDestination(credentials, destination)
	if err != nil {
		return multiBenchmarkFixture{}, err
	}
	assignment, err := ownershipmulti.Assignment(master, paths, destination, publicInput)
	if err != nil {
		return multiBenchmarkFixture{}, err
	}
	ccs, err := prover.CompileOwnershipMultiCount(count)
	if err != nil {
		return multiBenchmarkFixture{}, err
	}
	bundle, err := prover.LoadOrCreateOwnershipMultiBundleForCount(keysDir, ccs, count)
	if err != nil {
		return multiBenchmarkFixture{}, err
	}
	proof, err := prover.Prove(ccs, bundle.ProvingKey, assignment)
	if err != nil {
		return multiBenchmarkFixture{}, err
	}
	publicAssignment, err := ownershipmulti.PublicAssignment(count, publicInput)
	if err != nil {
		return multiBenchmarkFixture{}, err
	}
	if err := prover.VerifyProof(bundle.VerifyingKey, proof, publicAssignment); err != nil {
		return multiBenchmarkFixture{}, err
	}

	proofBytes, proofFormat, err := prover.SerializeCardanoProof(proof)
	if err != nil {
		return multiBenchmarkFixture{}, err
	}
	vkBytes, vkFormat, err := prover.SerializeCardanoVK(bundle.VerifyingKey)
	if err != nil {
		return multiBenchmarkFixture{}, err
	}
	if proofFormat != vkFormat {
		return multiBenchmarkFixture{}, fmt.Errorf("cardano proof format %q does not match vk format %q", proofFormat, vkFormat)
	}

	return multiBenchmarkFixture{
		CredentialCount:      count,
		CircuitID:            ownershipmulti.CircuitIDForCount(count),
		KeyVersion:           prover.DefaultMultiKeyVersionForCount(count),
		VKHash:               bundle.Manifest.VKHash,
		Format:               proofFormat,
		PublicInput:          ownershipmulti.PublicInputHex(publicInput),
		PublicInputDigestHex: hex.EncodeToString(publicInputDigest),
		ProofHex:             hex.EncodeToString(proofBytes),
		VKHex:                hex.EncodeToString(vkBytes),
		TargetCredentials:    encodeHexList(credentials),
		Paths:                encodePathMetadata(paths),
	}, nil
}

func parseBenchmarkCounts(value string) ([]int, error) {
	parts := strings.Split(value, ",")
	counts := make([]int, 0, len(parts))
	seen := make(map[int]bool, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		count, err := strconv.Atoi(part)
		if err != nil {
			return nil, fmt.Errorf("fixture count %q is invalid: %w", part, err)
		}
		if err := ownershipmulti.ValidateCredentialCount(count); err != nil {
			return nil, err
		}
		if seen[count] {
			return nil, fmt.Errorf("duplicate fixture count %d", count)
		}
		seen[count] = true
		counts = append(counts, count)
	}
	if len(counts) == 0 {
		return nil, fmt.Errorf("--counts must include at least one count")
	}
	return counts, nil
}
