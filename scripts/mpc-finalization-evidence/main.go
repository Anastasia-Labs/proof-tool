// Command mpc-finalization-evidence is the coordinator-local public golden
// evidence generator for rehearsal and production. It is deliberately
// separate from cmd/mpc-ceremony and accepts no wallet, seed, master-XPrv, or
// derivation-path input.
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/circuit/ownershipdest"
	"proof-tool/internal/mpcceremony"
	"proof-tool/internal/prover"
)

const resultSchema = "proof-tool-mpc-public-evidence-generation-result-v1"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run() error {
	fs := flag.NewFlagSet("mpc-finalization-evidence", flag.ContinueOnError)
	keysDir := fs.String("keys-dir", "", "preliminary final-key directory from mpc-ceremony finalize prepare")
	coordinatorPublicKeyFile := fs.String("coordinator-public-key-file", "", "out-of-band trusted coordinator Ed25519 public key file")
	ceremonyID := fs.String("ceremony-id", "", "exact ceremony id from ceremony.json")
	out := fs.String("out", "", "canonical public evidence JSON path (fresh or exact completed retry)")
	if err := fs.Parse(os.Args[1:]); err != nil {
		return err
	}
	if *keysDir == "" || *coordinatorPublicKeyFile == "" || *ceremonyID == "" || *out == "" {
		return errors.New("--keys-dir, --coordinator-public-key-file, --ceremony-id, and --out are required")
	}
	info, err := os.Lstat(*keysDir)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("keys-dir must be a real directory, not a symlink")
	}
	keyInfo, err := os.Lstat(*coordinatorPublicKeyFile)
	if err != nil {
		return err
	}
	if !keyInfo.Mode().IsRegular() || keyInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("coordinator public key must be a regular file, not a symlink")
	}
	publicKeyHex, err := os.ReadFile(*coordinatorPublicKeyFile)
	if err != nil {
		return err
	}
	preliminary, err := mpcceremony.VerifyPreliminaryFinalKeys(*keysDir, string(publicKeyHex))
	if err != nil {
		return err
	}
	if preliminary.CeremonyID != *ceremonyID {
		return errors.New("preliminary key ceremony id differs from --ceremony-id")
	}

	// This is the repository's public golden test witness, not user wallet
	// material. Keeping it in this separate rehearsal helper proves that the
	// participant/coordinator ceremony binary never handles a wallet secret.
	master, err := ownership.DecodeMasterXPrvHex(
		"c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245" +
			"d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a" +
			"23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620",
	)
	if err != nil {
		return err
	}
	destination, err := ownershipdest.DecodeDestinationAddressV1Hex(
		"010038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da111000000" +
			"0000000000000000000000000000000000000000000000000000",
	)
	if err != nil {
		return err
	}
	path := ownership.Path{Account: 3, Role: 2, Index: 0}
	credential, err := ownership.DeriveCredential(master, path)
	if err != nil {
		return err
	}
	publicInputDigest, err := ownershipdest.PublicInputDigestForCredentialDestination(credential[:], destination)
	if err != nil {
		return err
	}
	publicInput, err := ownershipdest.PublicInputForCredentialDestination(credential[:], destination)
	if err != nil {
		return err
	}
	assignment, err := ownershipdest.Assignment(master, path, destination, publicInput)
	if err != nil {
		return err
	}
	ccs, err := mpcceremony.ReadR1CSFile(
		filepath.Join(*keysDir, preliminary.ConstraintSystem.Name),
		preliminary.Circuit,
	)
	if err != nil {
		return err
	}
	pk, err := prover.LoadPK(filepath.Join(*keysDir, mpcceremony.NativeProvingKeyFile))
	if err != nil {
		return err
	}
	vk, err := prover.LoadVK(filepath.Join(*keysDir, mpcceremony.NativeVerifyingKeyFile))
	if err != nil {
		return err
	}
	cardanoVK, formatVK, err := prover.SerializeCardanoVK(vk)
	if err != nil {
		return err
	}
	if formatVK != "groth16-bls12-381-bsb22" ||
		mpcceremony.NewDigest(cardanoVK) != preliminary.CardanoVerifyingKey.Digest {
		return errors.New("native preliminary VK differs from signed Cardano VK")
	}
	proof, err := prover.Prove(ccs.R1CS, pk, assignment)
	if err != nil {
		return err
	}
	if err := prover.VerifyProof(vk, proof, &ownershipdest.Circuit{Pub: publicInput}); err != nil {
		return fmt.Errorf("preliminary PK/VK proof coherence: %w", err)
	}
	cardanoProof, format, err := prover.SerializeCardanoProof(proof)
	if err != nil {
		return err
	}
	if format != "groth16-bls12-381-bsb22" || len(cardanoProof) != prover.CardanoProofCommitmentLen {
		return errors.New("generated proof is not the exact Cardano BSB22 encoding")
	}
	storedCardanoVK, err := os.ReadFile(filepath.Join(*keysDir, mpcceremony.CardanoVKBytesFile))
	if err != nil {
		return err
	}
	if len(storedCardanoVK) != prover.CardanoVKCommitmentLen ||
		!bytes.Equal(storedCardanoVK, cardanoVK) {
		return errors.New("preliminary Cardano VK has unexpected length")
	}
	evidence := mpcceremony.PublicFinalizationEvidence{
		Schema:                mpcceremony.PublicEvidenceSchema,
		CeremonyID:            *ceremonyID,
		Fixture:               mpcceremony.PublicEvidenceFixture,
		CredentialHex:         hex.EncodeToString(credential[:]),
		DestinationHex:        hex.EncodeToString(destination),
		PublicInputDigestHex:  hex.EncodeToString(publicInputDigest),
		CardanoProofHex:       hex.EncodeToString(cardanoProof),
		CardanoProofFormat:    format,
		CardanoProofRawDigest: mpcceremony.NewDigest(cardanoProof),
		CardanoVerifyingKey: mpcceremony.ArtifactRef{
			Name:   mpcceremony.CardanoVKBytesFile,
			Digest: mpcceremony.NewDigest(storedCardanoVK),
		},
	}
	data, err := mpcceremony.MarshalCanonical(evidence)
	if err != nil {
		return err
	}
	if err := publishCompletedFile(*out, data, 0o600); err != nil {
		return err
	}
	result := struct {
		Schema         string             `json:"schema"`
		CeremonyID     string             `json:"ceremony_id"`
		PublicEvidence mpcceremony.Digest `json:"public_evidence_digest"`
	}{
		Schema:         resultSchema,
		CeremonyID:     *ceremonyID,
		PublicEvidence: mpcceremony.NewDigest(data),
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}
