package main

import (
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/consensys/gnark/constraint"

	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/circuit/ownershipdest"
	"proof-tool/internal/prover"
)

func cmdGenerateDestinationBenchmarkFixtures(args []string) error {
	fs := flag.NewFlagSet("generate-destination-benchmark-fixtures", flag.ContinueOnError)
	masterHex := fs.String("master-xprv", "", "96-byte master XPrv as hex")
	destinationHex := fs.String("destination-address-bytes", "", "58-byte destinationAddressV1 value as hex")
	outPath := fs.String("out", "contracts/ownership-verifier/testdata/ownership-destination-distinct-proofs.txt", "destination benchmark fixture output path")
	keysDir := fs.String("keys-dir", ".proof-tool/destination-benchmark-fixtures/keys", "destination key bundle directory")
	count := fs.Int("count", 20, "number of sequential m/1852'/1815'/account'/role/index proofs to generate")
	account := fs.Uint("account", 0, "CIP-1852 account")
	role := fs.Uint("role", 0, "CIP-1852 role")
	proofHexPath := fs.String("proof-hex-out", "contracts/ownership-verifier/testdata/ownership-destination-proof.hex", "first Cardano proof hex output path")
	vkHexPath := fs.String("vk-hex-out", "contracts/ownership-verifier/testdata/ownership-destination-vk.hex", "Cardano verifier key hex output path")
	pubHexPath := fs.String("pub-hex-out", "contracts/ownership-verifier/testdata/ownership-destination-pub.hex", "first public input digest hex output path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *masterHex == "" {
		return fmt.Errorf("--master-xprv is required")
	}
	if *destinationHex == "" {
		return fmt.Errorf("--destination-address-bytes is required")
	}
	if *count <= 0 {
		return fmt.Errorf("--count must be positive")
	}
	if *account >= 1<<31 {
		return fmt.Errorf("--account must be < 2^31")
	}
	if *role > 2 {
		return fmt.Errorf("--role must be 0, 1, or 2")
	}

	master, err := ownership.DecodeMasterXPrvHex(*masterHex)
	if err != nil {
		return err
	}
	destination, err := ownershipdest.DecodeDestinationAddressV1Hex(*destinationHex)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(*keysDir, 0o700); err != nil {
		return fmt.Errorf("create keys dir %s: %w", *keysDir, err)
	}
	if err := mkdirParent(*outPath); err != nil {
		return err
	}
	if err := mkdirParent(*proofHexPath); err != nil {
		return err
	}
	if err := mkdirParent(*vkHexPath); err != nil {
		return err
	}
	if err := mkdirParent(*pubHexPath); err != nil {
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
	vkBytes, vkFormat, err := prover.SerializeCardanoVK(bundle.VerifyingKey)
	if err != nil {
		return err
	}
	if vkFormat != "groth16-bls12-381-bsb22" {
		return fmt.Errorf("unexpected destination VK format: %s", vkFormat)
	}

	var rows strings.Builder
	for i := 0; i < *count; i++ {
		path := ownership.Path{Account: uint32(*account), Role: uint32(*role), Index: uint32(i)}
		credential, proofBytes, publicInputDigest, proofFormat, err := generateDestinationBenchmarkProof(ccs, bundle, master, path, destination)
		if err != nil {
			return err
		}
		if proofFormat != vkFormat {
			return fmt.Errorf("destination proof format %q does not match vk format %q", proofFormat, vkFormat)
		}
		if i == 0 {
			if err := os.WriteFile(*proofHexPath, []byte(hex.EncodeToString(proofBytes)+"\n"), 0o600); err != nil {
				return fmt.Errorf("write %s: %w", *proofHexPath, err)
			}
			if err := os.WriteFile(*pubHexPath, []byte(hex.EncodeToString(publicInputDigest)+"\n"), 0o600); err != nil {
				return fmt.Errorf("write %s: %w", *pubHexPath, err)
			}
		}
		fmt.Fprintf(&rows, "%02d %s %s\n", i, hex.EncodeToString(credential[:]), hex.EncodeToString(proofBytes))
		fmt.Printf("generated destination benchmark fixture index=%d credential=%s\n", i, hex.EncodeToString(credential[:]))
	}

	if err := os.WriteFile(*vkHexPath, []byte(hex.EncodeToString(vkBytes)+"\n"), 0o600); err != nil {
		return fmt.Errorf("write %s: %w", *vkHexPath, err)
	}
	if err := os.WriteFile(*outPath, []byte(rows.String()), 0o600); err != nil {
		return fmt.Errorf("write %s: %w", *outPath, err)
	}
	fmt.Printf("wrote destination benchmark fixtures: %s\n", *outPath)
	fmt.Printf("wrote destination proof fixture: %s\n", *proofHexPath)
	fmt.Printf("wrote destination vk fixture: %s\n", *vkHexPath)
	fmt.Printf("wrote destination public input fixture: %s\n", *pubHexPath)
	fmt.Printf("vk_hash: %s\n", bundle.Manifest.VKHash)
	return nil
}

func generateDestinationBenchmarkProof(ccs constraint.ConstraintSystem, bundle *prover.OwnershipBundle, master []byte, path ownership.Path, destination []byte) ([28]byte, []byte, []byte, string, error) {
	credential, err := ownership.DeriveCredential(master, path)
	if err != nil {
		return [28]byte{}, nil, nil, "", err
	}
	publicInput, err := ownershipdest.PublicInputForCredentialDestination(credential[:], destination)
	if err != nil {
		return [28]byte{}, nil, nil, "", err
	}
	publicInputDigest, err := ownershipdest.PublicInputDigestForCredentialDestination(credential[:], destination)
	if err != nil {
		return [28]byte{}, nil, nil, "", err
	}
	assignment, err := ownershipdest.Assignment(master, path, destination, publicInput)
	if err != nil {
		return [28]byte{}, nil, nil, "", err
	}
	proof, err := prover.Prove(ccs, bundle.ProvingKey, assignment)
	if err != nil {
		return [28]byte{}, nil, nil, "", err
	}
	if err := prover.VerifyProof(bundle.VerifyingKey, proof, assignment); err != nil {
		return [28]byte{}, nil, nil, "", err
	}
	proofBytes, proofFormat, err := prover.SerializeCardanoProof(proof)
	if err != nil {
		return [28]byte{}, nil, nil, "", err
	}
	return credential, proofBytes, publicInputDigest, proofFormat, nil
}

func mkdirParent(path string) error {
	dir := filepath.Dir(path)
	if dir == "." || dir == "" {
		return nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create parent dir %s: %w", dir, err)
	}
	return nil
}
