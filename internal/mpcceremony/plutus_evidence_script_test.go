package mpcceremony

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"proof-tool/internal/prover"
)

func TestPublicFinalizationEvidenceScriptWithDynamicPlutusVerifier(t *testing.T) {
	verifier := os.Getenv("MPC_TEST_PLUTUS_VERIFIER_BIN")
	if verifier == "" {
		t.Skip("set MPC_TEST_PLUTUS_VERIFIER_BIN to exercise the dynamic Plutus executable")
	}

	root := filepath.Clean(filepath.Join("..", ".."))
	testdata := filepath.Join(root, "contracts", "ownership-verifier", "testdata")
	readHex := func(name string) []byte {
		t.Helper()
		data, err := os.ReadFile(filepath.Join(testdata, name))
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := hex.DecodeString(strings.TrimSpace(string(data)))
		if err != nil {
			t.Fatal(err)
		}
		return decoded
	}
	cardanoVK := readHex("ownership-destination-vk.hex")
	cardanoProof := readHex("ownership-destination-proof.hex")
	publicInputDigest := readHex("ownership-destination-pub.hex")
	credential, err := hex.DecodeString("19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4")
	if err != nil {
		t.Fatal(err)
	}
	destination, err := hex.DecodeString(
		"010038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da111" +
			"0000000000000000000000000000000000000000000000000000000000",
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(cardanoVK) != prover.CardanoVKCommitmentLen ||
		len(cardanoProof) != prover.CardanoProofCommitmentLen {
		t.Fatal("repository Cardano fixture has unexpected length")
	}

	ceremonyID := NewDigest([]byte("dynamic Plutus verifier integration")).SHA256
	cardanoVKRef := ArtifactRef{Name: CardanoVKBytesFile, Digest: NewDigest(cardanoVK)}
	evidence := PublicFinalizationEvidence{
		Schema:                PublicEvidenceSchema,
		CeremonyID:            ceremonyID,
		Fixture:               PublicEvidenceFixture,
		CredentialHex:         hex.EncodeToString(credential),
		DestinationHex:        hex.EncodeToString(destination),
		PublicInputDigestHex:  hex.EncodeToString(publicInputDigest),
		CardanoProofHex:       hex.EncodeToString(cardanoProof),
		CardanoProofFormat:    expectedCardanoBSB22,
		CardanoProofRawDigest: NewDigest(cardanoProof),
		CardanoVerifyingKey:   cardanoVKRef,
	}
	evidenceBytes, err := MarshalCanonical(evidence)
	if err != nil {
		t.Fatal(err)
	}
	evidenceRef := ArtifactRef{Name: PublicEvidenceFile, Digest: NewDigest(evidenceBytes)}
	report := VerificationReport{
		Schema:                   VerificationReportSchema,
		CeremonyID:               ceremonyID,
		Fixture:                  PublicEvidenceFixture,
		NativeProofVerified:      true,
		WrongCredentialRejected:  true,
		WrongDestinationRejected: true,
		WrongDigestRejected:      true,
		WrongProofRejected:       true,
		WrongVKRejected:          true,
		ProofTruncationRejected:  true,
		ProofAppendRejected:      true,
		CardanoProofFormat:       expectedCardanoBSB22,
		CardanoProofBytes:        len(cardanoProof),
		CardanoProofRawDigest:    NewDigest(cardanoProof),
		CardanoVKFormat:          expectedCardanoBSB22,
		CardanoVKBytes:           len(cardanoVK),
		CardanoVKRawDigest:       NewDigest(cardanoVK),
		PublicEvidence:           evidenceRef,
		CheckedAt:                time.Date(2026, time.July, 23, 0, 0, 0, 0, time.UTC).Format(time.RFC3339Nano),
	}
	reportBytes, err := MarshalCanonical(report)
	if err != nil {
		t.Fatal(err)
	}
	candidateBytes, err := json.Marshal(struct {
		Schema              string      `json:"schema"`
		CeremonyID          string      `json:"ceremony_id"`
		CardanoVerifyingKey ArtifactRef `json:"cardano_verifying_key"`
		VerificationReport  ArtifactRef `json:"verification_report"`
		PublicEvidence      ArtifactRef `json:"public_finalization_evidence"`
	}{
		Schema:              CandidateMetadataSchema,
		CeremonyID:          ceremonyID,
		CardanoVerifyingKey: cardanoVKRef,
		VerificationReport:  ArtifactRef{Name: VerificationReportFile, Digest: NewDigest(reportBytes)},
		PublicEvidence:      evidenceRef,
	})
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	write := func(name string, data []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(CandidateMetadataFile, candidateBytes)
	write(VerificationReportFile, reportBytes)
	write(PublicEvidenceFile, evidenceBytes)
	write(CardanoVKBytesFile, cardanoVK)
	write(CardanoVKHexFile, []byte(hex.EncodeToString(cardanoVK)+"\n"))

	script := filepath.Join(root, "scripts", "verify-mpc-final-plutus-evidence.sh")
	command := exec.Command(script, dir, verifier)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("public Plutus evidence script failed: %v\n%s", err, output)
	}
	var result struct {
		PositiveVerified  bool     `json:"positive_verified"`
		RejectedNegatives []string `json:"rejected_negatives"`
	}
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatalf("parse script output: %v\n%s", err, output)
	}
	if !result.PositiveVerified || len(result.RejectedNegatives) != 9 {
		t.Fatalf("incomplete dynamic Plutus evidence: %+v", result)
	}
}
