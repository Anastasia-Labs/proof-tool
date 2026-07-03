package prover

import (
	"fmt"
	"testing"

	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
	groth16_bls12381 "github.com/consensys/gnark/backend/groth16/bls12-381"
	"github.com/consensys/gnark/frontend"
)

type committed struct {
	P frontend.Variable `gnark:",public"`
	S frontend.Variable
}

func (c *committed) Define(api frontend.API) error {
	committer, ok := api.(frontend.Committer)
	if !ok {
		return fmt.Errorf("compiler does not commit")
	}
	cm, err := committer.Commit(c.S)
	if err != nil {
		return err
	}
	api.AssertIsDifferent(cm, 0)
	api.AssertIsEqual(c.P, c.S)
	return nil
}

func TestSerializeCardanoCommittedProofAndVK(t *testing.T) {
	ccs, err := Compile(&committed{})
	if err != nil {
		t.Fatal(err)
	}
	pk, vk, err := Setup(ccs)
	if err != nil {
		t.Fatal(err)
	}
	proof, err := Prove(ccs, pk, &committed{P: 7, S: 7})
	if err != nil {
		t.Fatal(err)
	}

	vkBytes, publicAndCommitted, err := SerializeVKCommitment(vk)
	if err != nil {
		t.Fatal(err)
	}
	if len(vkBytes) != CardanoVKCommitmentLen {
		t.Fatalf("committed vk bytes = %d, want %d", len(vkBytes), CardanoVKCommitmentLen)
	}
	if len(publicAndCommitted) != 1 || len(publicAndCommitted[0]) != 0 {
		t.Fatalf("PublicAndCommitmentCommitted = %v, want [[]]", publicAndCommitted)
	}

	proofBytes, err := SerializeProofCommitment(proof)
	if err != nil {
		t.Fatal(err)
	}
	if len(proofBytes) != CardanoProofCommitmentLen {
		t.Fatalf("committed proof bytes = %d, want %d", len(proofBytes), CardanoProofCommitmentLen)
	}

	autoProofBytes, proofFormat, err := SerializeCardanoProof(proof)
	if err != nil {
		t.Fatal(err)
	}
	if proofFormat != "groth16-bls12-381-bsb22" {
		t.Fatalf("proof format = %q", proofFormat)
	}
	if string(autoProofBytes) != string(proofBytes) {
		t.Fatal("auto cardano proof bytes differ from committed serializer")
	}

	autoVKBytes, vkFormat, err := SerializeCardanoVK(vk)
	if err != nil {
		t.Fatal(err)
	}
	if vkFormat != proofFormat {
		t.Fatalf("vk format = %q, want %q", vkFormat, proofFormat)
	}
	if string(autoVKBytes) != string(vkBytes) {
		t.Fatal("auto cardano vk bytes differ from committed serializer")
	}

	cp := proof.(*groth16_bls12381.Proof)
	cvk := vk.(*groth16_bls12381.VerifyingKey)
	var g1 bls12381.G1Affine
	var g2 bls12381.G2Affine

	if _, err := g1.SetBytes(vkBytes[K2Off:CKGOff]); err != nil {
		t.Fatalf("parse K2: %v", err)
	}
	if !g1.Equal(&cvk.G1.K[2]) {
		t.Fatal("K2 round-trip mismatch")
	}
	if _, err := g2.SetBytes(vkBytes[CKGOff:CKGSNOff]); err != nil {
		t.Fatalf("parse CK.G: %v", err)
	}
	if !g2.Equal(&cvk.CommitmentKeys[0].G) {
		t.Fatal("CK.G round-trip mismatch")
	}
	if _, err := g2.SetBytes(vkBytes[CKGSNOff:CardanoVKCommitmentLen]); err != nil {
		t.Fatalf("parse CK.GSigmaNeg: %v", err)
	}
	if !g2.Equal(&cvk.CommitmentKeys[0].GSigmaNeg) {
		t.Fatal("CK.GSigmaNeg round-trip mismatch")
	}

	if _, err := g1.SetBytes(proofBytes[CmtOff:PokOff]); err != nil {
		t.Fatalf("parse commitment: %v", err)
	}
	if !g1.Equal(&cp.Commitments[0]) {
		t.Fatal("commitment round-trip mismatch")
	}
	if proofBytes[CmtOff]&0xe0 != 0 {
		t.Fatalf("commitment[0]=0x%02x: uncompressed commitment flag bits must be 000", proofBytes[CmtOff])
	}
	if _, err := g1.SetBytes(proofBytes[PokOff:CardanoProofCommitmentLen]); err != nil {
		t.Fatalf("parse commitment PoK: %v", err)
	}
	if !g1.Equal(&cp.CommitmentPok) {
		t.Fatal("commitment PoK round-trip mismatch")
	}

	challenge, dst, err := CommitmentChallenge(proof)
	if err != nil {
		t.Fatal(err)
	}
	if len(challenge) != 32 {
		t.Fatalf("commitment challenge = %d bytes, want 32", len(challenge))
	}
	if dst != "bsb22-commitment" {
		t.Fatalf("commitment DST = %q", dst)
	}
}

func TestSerializeCardanoVanillaProofAndVK(t *testing.T) {
	ccs, err := Compile(&sq{})
	if err != nil {
		t.Fatal(err)
	}
	pk, vk, err := Setup(ccs)
	if err != nil {
		t.Fatal(err)
	}
	proof, err := Prove(ccs, pk, &sq{X: 3, Y: 9})
	if err != nil {
		t.Fatal(err)
	}

	proofBytes, proofFormat, err := SerializeCardanoProof(proof)
	if err != nil {
		t.Fatal(err)
	}
	if proofFormat != "groth16-bls12-381" {
		t.Fatalf("proof format = %q", proofFormat)
	}
	if len(proofBytes) != CardanoProofLen {
		t.Fatalf("proof bytes = %d, want %d", len(proofBytes), CardanoProofLen)
	}
	if proofBytes[0]&0x80 == 0 {
		t.Fatalf("proof[0]=0x%02x: compressed point flag not set", proofBytes[0])
	}

	vkBytes, vkFormat, err := SerializeCardanoVK(vk)
	if err != nil {
		t.Fatal(err)
	}
	if vkFormat != proofFormat {
		t.Fatalf("vk format = %q, want %q", vkFormat, proofFormat)
	}
	if len(vkBytes) != CardanoVKLen {
		t.Fatalf("vk bytes = %d, want %d", len(vkBytes), CardanoVKLen)
	}
	if vkBytes[0]&0x80 == 0 {
		t.Fatalf("vk[0]=0x%02x: compressed point flag not set", vkBytes[0])
	}
}
