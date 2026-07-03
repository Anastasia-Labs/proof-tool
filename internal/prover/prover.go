package prover

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fr"
	"github.com/consensys/gnark/backend/groth16"
	groth16_bls12381 "github.com/consensys/gnark/backend/groth16/bls12-381"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"golang.org/x/crypto/blake2b"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownership"
)

var curve = ecc.BLS12_381

const (
	DefaultKeyVersion = "ownership-v1"
	ProofToolVersion  = "0.1.0"
	GnarkVersion      = "v0.15.0"
)

const (
	g1Len = 48
	g2Len = 96

	CardanoProofLen = 2*g1Len + g2Len           // A(G1) | B(G2) | C(G1)
	CardanoVKLen    = g1Len + 3*g2Len + 2*g1Len // alpha | beta | gamma | delta | IC0 | IC1

	CardanoVKCommitmentLen    = CardanoVKLen + g1Len + 2*g2Len    // vanilla VK + K2 + CK.G + CK.GSigmaNeg
	CardanoProofCommitmentLen = CardanoProofLen + 2*g1Len + g1Len // vanilla proof + commitment(X|Y) + PoK

	K2Off    = CardanoVKLen
	CKGOff   = K2Off + g1Len
	CKGSNOff = CKGOff + g2Len

	CmtOff = CardanoProofLen
	PokOff = CmtOff + 2*g1Len
)

type OwnershipBundle struct {
	Dir          string
	Manifest     *artifact.KeyManifest
	ProvingKey   groth16.ProvingKey
	VerifyingKey groth16.VerifyingKey
}

type BundleStatus struct {
	Dir        string
	State      string
	Ready      bool
	KeyVersion string
	VKHash     string
	Error      string
	Manifest   *artifact.KeyManifest
}

type FileDigest struct {
	SHA256     string
	Blake2b256 string
	Size       int64
}

func DefaultKeyDir() string {
	if dir, err := os.UserCacheDir(); err == nil && dir != "" {
		return filepath.Join(dir, "proof-tool", "ownership-v1")
	}
	return filepath.Join(".", ".proof-tool", "ownership-v1")
}

func Compile(circuit frontend.Circuit) (constraint.ConstraintSystem, error) {
	ccs, err := frontend.Compile(curve.ScalarField(), r1cs.NewBuilder, circuit)
	if err != nil {
		return nil, fmt.Errorf("compile: %w", err)
	}
	return ccs, nil
}

func CompileOwnership() (constraint.ConstraintSystem, error) {
	return Compile(&ownership.Circuit{})
}

func LoadOrCreateOwnershipBundle(dir string, ccs constraint.ConstraintSystem) (*OwnershipBundle, error) {
	if dir == "" {
		dir = DefaultKeyDir()
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create key dir %s: %w", dir, err)
	}
	manifestPath, pkPath, vkPath := ownershipBundlePaths(dir)

	if filesExist(manifestPath, pkPath, vkPath) {
		return LoadOwnershipProver(dir)
	}

	pk, vk, err := Setup(ccs)
	if err != nil {
		return nil, err
	}
	if err := SavePK(pk, pkPath); err != nil {
		return nil, err
	}
	if err := SaveVK(vk, vkPath); err != nil {
		return nil, err
	}
	pkDigest, err := digestFile(pkPath)
	if err != nil {
		return nil, err
	}
	vkDigest, err := digestFile(vkPath)
	if err != nil {
		return nil, err
	}
	manifest := &artifact.KeyManifest{
		Schema:               artifact.ManifestSchema,
		KeyVersion:           DefaultKeyVersion,
		CircuitID:            ownership.CircuitID,
		Curve:                "BLS12-381",
		Backend:              "groth16",
		VKHash:               vkDigest.Blake2b256,
		ProvingKeySHA256:     pkDigest.SHA256,
		ProvingKeyBlake2b256: pkDigest.Blake2b256,
		ProvingKeySize:       pkDigest.Size,
		VerifyingKeySHA256:   vkDigest.SHA256,
		VerifyingKeySize:     vkDigest.Size,
		ProofToolVersion:     ProofToolVersion,
		GnarkVersion:         GnarkVersion,
		PublishedAt:          time.Now().UTC().Format(time.RFC3339),
		SignatureKeyID:       "local-dev-unsigned",
	}
	if err := artifact.WriteJSON(manifestPath, manifest); err != nil {
		return nil, err
	}
	return &OwnershipBundle{Dir: dir, Manifest: manifest, ProvingKey: pk, VerifyingKey: vk}, nil
}

func LoadOwnershipProver(dir string) (*OwnershipBundle, error) {
	if dir == "" {
		dir = DefaultKeyDir()
	}
	manifestPath, pkPath, vkPath := ownershipBundlePaths(dir)
	manifest, err := artifact.ReadKeyManifest(manifestPath)
	if err != nil {
		return nil, err
	}
	if err := validateManifest(manifest); err != nil {
		return nil, err
	}
	if err := validateProvingKeyFile(manifest, pkPath); err != nil {
		return nil, err
	}
	if err := validateVerifyingKeyFile(manifest, vkPath); err != nil {
		return nil, err
	}
	pk, err := LoadPK(pkPath)
	if err != nil {
		return nil, err
	}
	vk, err := LoadVK(vkPath)
	if err != nil {
		return nil, err
	}
	return &OwnershipBundle{Dir: dir, Manifest: manifest, ProvingKey: pk, VerifyingKey: vk}, nil
}

func LoadOwnershipVerifier(dir string) (*OwnershipBundle, error) {
	if dir == "" {
		dir = DefaultKeyDir()
	}
	manifestPath, _, vkPath := ownershipBundlePaths(dir)
	manifest, err := artifact.ReadKeyManifest(manifestPath)
	if err != nil {
		return nil, err
	}
	if err := validateManifest(manifest); err != nil {
		return nil, err
	}
	if err := validateVerifyingKeyFile(manifest, vkPath); err != nil {
		return nil, err
	}
	vk, err := LoadVK(vkPath)
	if err != nil {
		return nil, err
	}
	return &OwnershipBundle{Dir: dir, Manifest: manifest, VerifyingKey: vk}, nil
}

func InspectOwnershipBundle(dir string, requireProvingKey bool) BundleStatus {
	if dir == "" {
		dir = DefaultKeyDir()
	}
	manifestPath, pkPath, vkPath := ownershipBundlePaths(dir)
	if !filesExist(manifestPath, vkPath) || (requireProvingKey && !filesExist(pkPath)) {
		return BundleStatus{Dir: dir, State: "missing", Ready: false, Error: "key bundle is missing"}
	}
	manifest, err := artifact.ReadKeyManifest(manifestPath)
	if err != nil {
		return BundleStatus{Dir: dir, State: "invalid", Ready: false, Error: err.Error()}
	}
	if err := validateManifest(manifest); err != nil {
		return BundleStatus{Dir: dir, State: "invalid", Ready: false, Manifest: manifest, Error: err.Error()}
	}
	if requireProvingKey {
		if err := validateProvingKeyFile(manifest, pkPath); err != nil {
			return BundleStatus{Dir: dir, State: "invalid", Ready: false, Manifest: manifest, Error: err.Error()}
		}
	}
	if err := validateVerifyingKeyFile(manifest, vkPath); err != nil {
		return BundleStatus{Dir: dir, State: "invalid", Ready: false, Manifest: manifest, Error: err.Error()}
	}
	return BundleStatus{
		Dir:        dir,
		State:      "ready",
		Ready:      true,
		KeyVersion: manifest.KeyVersion,
		VKHash:     manifest.VKHash,
		Manifest:   manifest,
	}
}

func Prove(ccs constraint.ConstraintSystem, pk groth16.ProvingKey, assignment frontend.Circuit) (groth16.Proof, error) {
	w, err := frontend.NewWitness(assignment, curve.ScalarField())
	if err != nil {
		return nil, fmt.Errorf("new witness: %w", err)
	}
	proof, err := groth16.Prove(ccs, pk, w)
	if err != nil {
		return nil, fmt.Errorf("groth16 prove: %w", err)
	}
	return proof, nil
}

func VerifyProof(vk groth16.VerifyingKey, proof groth16.Proof, assignment frontend.Circuit) error {
	pub, err := frontend.NewWitness(assignment, curve.ScalarField(), frontend.PublicOnly())
	if err != nil {
		return fmt.Errorf("public witness: %w", err)
	}
	if err := groth16.Verify(proof, vk, pub); err != nil {
		return fmt.Errorf("groth16 verify: %w", err)
	}
	return nil
}

func MarshalProof(proof groth16.Proof) (string, error) {
	var buf bytes.Buffer
	if _, err := proof.WriteTo(&buf); err != nil {
		return "", fmt.Errorf("write proof: %w", err)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

func UnmarshalProof(encoded string) (groth16.Proof, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("decode proof: %w", err)
	}
	proof := groth16.NewProof(curve)
	if _, err := proof.ReadFrom(bytes.NewReader(raw)); err != nil {
		return nil, fmt.Errorf("read proof: %w", err)
	}
	return proof, nil
}

func SerializeProof(proof groth16.Proof) ([]byte, error) {
	cp, ok := proof.(*groth16_bls12381.Proof)
	if !ok {
		return nil, fmt.Errorf("serialize proof: want *groth16_bls12381.Proof, got %T", proof)
	}

	ar := cp.Ar.Bytes()
	bs := cp.Bs.Bytes()
	krs := cp.Krs.Bytes()

	out := make([]byte, 0, CardanoProofLen)
	out = append(out, ar[:]...)
	out = append(out, bs[:]...)
	out = append(out, krs[:]...)
	if len(out) != CardanoProofLen {
		return nil, fmt.Errorf("serialize proof: got %d bytes, want %d", len(out), CardanoProofLen)
	}
	return out, nil
}

func SerializeVK(vk groth16.VerifyingKey) ([]byte, error) {
	cvk, ok := vk.(*groth16_bls12381.VerifyingKey)
	if !ok {
		return nil, fmt.Errorf("serialize vk: want *groth16_bls12381.VerifyingKey, got %T", vk)
	}
	if len(cvk.G1.K) < 2 {
		return nil, fmt.Errorf("serialize vk: need K[0],K[1] for one public input, got %d IC points", len(cvk.G1.K))
	}

	alpha := cvk.G1.Alpha.Bytes()
	beta := cvk.G2.Beta.Bytes()
	gamma := cvk.G2.Gamma.Bytes()
	delta := cvk.G2.Delta.Bytes()
	ic0 := cvk.G1.K[0].Bytes()
	ic1 := cvk.G1.K[1].Bytes()

	out := make([]byte, 0, CardanoVKLen)
	out = append(out, alpha[:]...)
	out = append(out, beta[:]...)
	out = append(out, gamma[:]...)
	out = append(out, delta[:]...)
	out = append(out, ic0[:]...)
	out = append(out, ic1[:]...)
	if len(out) != CardanoVKLen {
		return nil, fmt.Errorf("serialize vk: got %d bytes, want %d", len(out), CardanoVKLen)
	}
	return out, nil
}

func SerializeVKCommitment(vk groth16.VerifyingKey) ([]byte, [][]int, error) {
	cvk, ok := vk.(*groth16_bls12381.VerifyingKey)
	if !ok {
		return nil, nil, fmt.Errorf("serialize vk(c): want *groth16_bls12381.VerifyingKey, got %T", vk)
	}
	if len(cvk.G1.K) < 3 {
		return nil, nil, fmt.Errorf("serialize vk(c): need K[0..2] for one public input plus one commitment, got %d IC points", len(cvk.G1.K))
	}
	if len(cvk.CommitmentKeys) != 1 {
		return nil, nil, fmt.Errorf("serialize vk(c): need exactly 1 CommitmentKey, got %d", len(cvk.CommitmentKeys))
	}

	vanilla, err := SerializeVK(vk)
	if err != nil {
		return nil, nil, err
	}
	k2 := cvk.G1.K[2].Bytes()
	ckG := cvk.CommitmentKeys[0].G.Bytes()
	ckGSN := cvk.CommitmentKeys[0].GSigmaNeg.Bytes()

	out := make([]byte, 0, CardanoVKCommitmentLen)
	out = append(out, vanilla...)
	out = append(out, k2[:]...)
	out = append(out, ckG[:]...)
	out = append(out, ckGSN[:]...)
	if len(out) != CardanoVKCommitmentLen {
		return nil, nil, fmt.Errorf("serialize vk(c): got %d bytes, want %d", len(out), CardanoVKCommitmentLen)
	}
	return out, cvk.PublicAndCommitmentCommitted, nil
}

func SerializeProofCommitment(proof groth16.Proof) ([]byte, error) {
	cp, ok := proof.(*groth16_bls12381.Proof)
	if !ok {
		return nil, fmt.Errorf("serialize proof(c): want *groth16_bls12381.Proof, got %T", proof)
	}
	if len(cp.Commitments) != 1 {
		return nil, fmt.Errorf("serialize proof(c): need exactly 1 commitment, got %d", len(cp.Commitments))
	}

	vanilla, err := SerializeProof(proof)
	if err != nil {
		return nil, err
	}
	cmt := cp.Commitments[0].Marshal()
	if len(cmt) != 2*g1Len {
		return nil, fmt.Errorf("serialize proof(c): commitment Marshal = %d bytes, want %d", len(cmt), 2*g1Len)
	}
	pok := cp.CommitmentPok.Bytes()

	out := make([]byte, 0, CardanoProofCommitmentLen)
	out = append(out, vanilla...)
	out = append(out, cmt...)
	out = append(out, pok[:]...)
	if len(out) != CardanoProofCommitmentLen {
		return nil, fmt.Errorf("serialize proof(c): got %d bytes, want %d", len(out), CardanoProofCommitmentLen)
	}
	return out, nil
}

func SerializeCardanoProof(proof groth16.Proof) ([]byte, string, error) {
	cp, ok := proof.(*groth16_bls12381.Proof)
	if !ok {
		return nil, "", fmt.Errorf("serialize cardano proof: want *groth16_bls12381.Proof, got %T", proof)
	}
	if len(cp.Commitments) == 0 {
		out, err := SerializeProof(proof)
		return out, "groth16-bls12-381", err
	}
	out, err := SerializeProofCommitment(proof)
	return out, "groth16-bls12-381-bsb22", err
}

func CardanoProofArtifact(proof groth16.Proof, credential []byte) (*artifact.CardanoProof, error) {
	proofBytes, format, err := SerializeCardanoProof(proof)
	if err != nil {
		return nil, err
	}
	digest, err := ownership.PublicInputDigestForCredential(credential)
	if err != nil {
		return nil, err
	}
	return &artifact.CardanoProof{
		Format:               format,
		ProofHex:             hex.EncodeToString(proofBytes),
		PublicInputDigestHex: hex.EncodeToString(digest),
	}, nil
}

func SerializeCardanoVK(vk groth16.VerifyingKey) ([]byte, string, error) {
	cvk, ok := vk.(*groth16_bls12381.VerifyingKey)
	if !ok {
		return nil, "", fmt.Errorf("serialize cardano vk: want *groth16_bls12381.VerifyingKey, got %T", vk)
	}
	if len(cvk.CommitmentKeys) == 0 {
		out, err := SerializeVK(vk)
		return out, "groth16-bls12-381", err
	}
	out, _, err := SerializeVKCommitment(vk)
	return out, "groth16-bls12-381-bsb22", err
}

func CommitmentChallenge(proof groth16.Proof) ([]byte, string, error) {
	cp, ok := proof.(*groth16_bls12381.Proof)
	if !ok {
		return nil, "", fmt.Errorf("commitment challenge: want *groth16_bls12381.Proof, got %T", proof)
	}
	if len(cp.Commitments) != 1 {
		return nil, "", fmt.Errorf("commitment challenge: need exactly 1 commitment, got %d", len(cp.Commitments))
	}
	es, err := fr.Hash(cp.Commitments[0].Marshal(), []byte(constraint.CommitmentDst), 1)
	if err != nil {
		return nil, "", fmt.Errorf("commitment challenge: fr.Hash: %w", err)
	}
	be := es[0].Bytes()
	return be[:], constraint.CommitmentDst, nil
}

func Setup(ccs constraint.ConstraintSystem) (groth16.ProvingKey, groth16.VerifyingKey, error) {
	pk, vk, err := groth16.Setup(ccs)
	if err != nil {
		return nil, nil, fmt.Errorf("groth16 setup: %w", err)
	}
	return pk, vk, nil
}

func SaveVK(vk groth16.VerifyingKey, path string) (err error) {
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	defer func() {
		if cerr := f.Close(); cerr != nil && err == nil {
			err = fmt.Errorf("close %s: %w", path, cerr)
		}
	}()
	if _, err := vk.WriteTo(f); err != nil {
		return fmt.Errorf("write vk %s: %w", path, err)
	}
	return nil
}

func LoadVK(path string) (groth16.VerifyingKey, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	vk, err := ReadVK(f)
	if err != nil {
		return nil, fmt.Errorf("read vk %s: %w", path, err)
	}
	return vk, nil
}

func ReadVK(r io.Reader) (groth16.VerifyingKey, error) {
	vk := groth16.NewVerifyingKey(curve)
	if _, err := vk.ReadFrom(r); err != nil {
		return nil, err
	}
	return vk, nil
}

func SavePK(pk groth16.ProvingKey, path string) (err error) {
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	defer func() {
		if cerr := f.Close(); cerr != nil && err == nil {
			err = fmt.Errorf("close %s: %w", path, cerr)
		}
	}()
	if _, err := pk.WriteRawTo(f); err != nil {
		return fmt.Errorf("write pk %s: %w", path, err)
	}
	return nil
}

func LoadPK(path string) (groth16.ProvingKey, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	pk := groth16.NewProvingKey(curve)
	if _, err := pk.UnsafeReadFrom(f); err != nil {
		return nil, fmt.Errorf("read pk %s: %w", path, err)
	}
	return pk, nil
}

func validateManifest(manifest *artifact.KeyManifest) error {
	if strings.TrimSpace(manifest.KeyVersion) == "" {
		return fmt.Errorf("manifest key_version is required")
	}
	if manifest.CircuitID != ownership.CircuitID {
		return fmt.Errorf("manifest circuit id %q, want %q", manifest.CircuitID, ownership.CircuitID)
	}
	if manifest.Curve != "BLS12-381" {
		return fmt.Errorf("manifest curve %q, want BLS12-381", manifest.Curve)
	}
	if manifest.Backend != "groth16" {
		return fmt.Errorf("manifest backend %q, want groth16", manifest.Backend)
	}
	return nil
}

func validateProvingKeyFile(manifest *artifact.KeyManifest, path string) error {
	if strings.TrimSpace(manifest.ProvingKeySHA256) == "" {
		return fmt.Errorf("manifest proving_key_sha256 is required")
	}
	if strings.TrimSpace(manifest.ProvingKeyBlake2b256) == "" {
		return fmt.Errorf("manifest proving_key_blake2b256 is required")
	}
	if manifest.ProvingKeySize <= 0 {
		return fmt.Errorf("manifest proving_key_size is required")
	}
	digest, err := digestFile(path)
	if err != nil {
		return err
	}
	if digest.SHA256 != manifest.ProvingKeySHA256 {
		return fmt.Errorf("proving key sha256 mismatch: manifest %s, file %s", manifest.ProvingKeySHA256, digest.SHA256)
	}
	if digest.Blake2b256 != manifest.ProvingKeyBlake2b256 {
		return fmt.Errorf("proving key blake2b256 mismatch: manifest %s, file %s", manifest.ProvingKeyBlake2b256, digest.Blake2b256)
	}
	if digest.Size != manifest.ProvingKeySize {
		return fmt.Errorf("proving key size mismatch: manifest %d, file %d", manifest.ProvingKeySize, digest.Size)
	}
	return nil
}

func validateVerifyingKeyFile(manifest *artifact.KeyManifest, path string) error {
	if strings.TrimSpace(manifest.VKHash) == "" {
		return fmt.Errorf("manifest vk_hash is required")
	}
	if strings.TrimSpace(manifest.VerifyingKeySHA256) == "" {
		return fmt.Errorf("manifest verifying_key_sha256 is required")
	}
	if manifest.VerifyingKeySize <= 0 {
		return fmt.Errorf("manifest verifying_key_size is required")
	}
	digest, err := digestFile(path)
	if err != nil {
		return err
	}
	if digest.Blake2b256 != manifest.VKHash {
		return fmt.Errorf("verifying key hash mismatch: manifest %s, file %s", manifest.VKHash, digest.Blake2b256)
	}
	if digest.SHA256 != manifest.VerifyingKeySHA256 {
		return fmt.Errorf("verifying key sha256 mismatch: manifest %s, file %s", manifest.VerifyingKeySHA256, digest.SHA256)
	}
	if digest.Size != manifest.VerifyingKeySize {
		return fmt.Errorf("verifying key size mismatch: manifest %d, file %d", manifest.VerifyingKeySize, digest.Size)
	}
	return nil
}

func ownershipBundlePaths(dir string) (manifestPath, pkPath, vkPath string) {
	return filepath.Join(dir, "manifest.json"), filepath.Join(dir, "ownership.pk"), filepath.Join(dir, "ownership.vk")
}

func filesExist(paths ...string) bool {
	for _, path := range paths {
		if _, err := os.Stat(path); err != nil {
			return false
		}
	}
	return true
}

func hashFile(path string) (string, error) {
	digest, err := digestFile(path)
	if err != nil {
		return "", err
	}
	return digest.Blake2b256, nil
}

func DigestFile(path string) (FileDigest, error) {
	return digestFile(path)
}

func digestFile(path string) (FileDigest, error) {
	f, err := os.Open(path)
	if err != nil {
		return FileDigest{}, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	sha := sha256.New()
	blake, err := blake2b.New256(nil)
	if err != nil {
		return FileDigest{}, fmt.Errorf("create blake2b digest: %w", err)
	}
	size, err := copyToHashes(f, sha, blake)
	if err != nil {
		return FileDigest{}, fmt.Errorf("digest %s: %w", path, err)
	}
	return FileDigest{
		SHA256:     "sha256:" + hex.EncodeToString(sha.Sum(nil)),
		Blake2b256: "blake2b256:" + hex.EncodeToString(blake.Sum(nil)),
		Size:       size,
	}, nil
}

func copyToHashes(r io.Reader, hashes ...hash.Hash) (int64, error) {
	writers := make([]io.Writer, 0, len(hashes))
	for _, h := range hashes {
		writers = append(writers, h)
	}
	return io.Copy(io.MultiWriter(writers...), r)
}
