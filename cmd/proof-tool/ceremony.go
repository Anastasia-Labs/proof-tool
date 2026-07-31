package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode"

	"github.com/consensys/gnark/constraint"
	"golang.org/x/crypto/blake2b"

	"proof-tool/internal/artifact"
	"proof-tool/internal/keybundle"
	"proof-tool/internal/keyprofile"
	"proof-tool/internal/prover"
)

const (
	ceremonyTranscriptSchema = "proof-tool-setup-transcript-v1"
	manifestSignatureFile    = keybundle.ManifestSignatureFile
	manifestPublicKeyFile    = keybundle.ManifestPublicKeyFile
	setupTranscriptFile      = "setup-transcript.json"
	toxicWasteNotesFile      = "TOXIC-WASTE-HANDLING.md"
	bundleReadmeFile         = "README.md"
	bundleChecksumsFile      = "checksums.sha256"
)

type setupCeremonyOptions struct {
	OutDir                 string
	KeyVersion             string
	SignatureKeyID         string
	SigningKeyPath         string
	RequireCleanGit        bool
	AcknowledgeSingleActor bool
	Now                    time.Time
	CommandLine            []string
}

type setupCeremonyResult struct {
	OutDir               string
	ManifestPath         string
	ManifestSignature    string
	ManifestPublicKey    string
	ManifestPublicKeyHex string
	SigningKeyPath       string
	SigningKeyGenerated  bool
	TranscriptPath       string
	ToxicWasteNotesPath  string
	ChecksumsPath        string
	Manifest             *artifact.KeyManifest
}

type ceremonyCircuitProfile = keyprofile.Profile

type ceremonyDigest struct {
	SHA256     string `json:"sha256"`
	Blake2b256 string `json:"blake2b256"`
	Size       int64  `json:"size"`
}

type setupTranscript struct {
	Schema                  string              `json:"schema"`
	GeneratedAt             string              `json:"generated_at"`
	CeremonyType            string              `json:"ceremony_type"`
	TrustModel              string              `json:"trust_model"`
	SingleActorAcknowledged bool                `json:"single_actor_acknowledged"`
	KeyVersion              string              `json:"key_version"`
	CircuitID               string              `json:"circuit_id"`
	Curve                   string              `json:"curve"`
	Backend                 string              `json:"backend"`
	Software                ceremonySoftware    `json:"software"`
	Environment             ceremonyEnvironment `json:"environment"`
	Source                  ceremonySource      `json:"source"`
	Circuit                 ceremonyCircuit     `json:"circuit"`
	Artifacts               ceremonyArtifacts   `json:"artifacts"`
	Signing                 ceremonySigning     `json:"signing"`
	ToxicWaste              ceremonyToxicWaste  `json:"toxic_waste"`
	OperatorNotes           map[string]string   `json:"operator_notes,omitempty"`
}

type ceremonySoftware struct {
	ProofToolVersion string `json:"proof_tool_version"`
	GnarkVersion     string `json:"gnark_version"`
	GoVersion        string `json:"go_version"`
}

type ceremonyEnvironment struct {
	OS       string   `json:"os"`
	Arch     string   `json:"arch"`
	Hostname string   `json:"hostname,omitempty"`
	Command  []string `json:"command,omitempty"`
}

type ceremonySource struct {
	GitRoot         string `json:"git_root,omitempty"`
	GitCommit       string `json:"git_commit,omitempty"`
	GitBranch       string `json:"git_branch,omitempty"`
	Dirty           bool   `json:"dirty"`
	StatusPorcelain string `json:"status_porcelain,omitempty"`
	CollectionError string `json:"collection_error,omitempty"`
}

type ceremonyCircuit struct {
	ConstraintSystemHash string `json:"constraint_system_hash"`
	ConstraintSystemSize int64  `json:"constraint_system_size"`
	Constraints          int    `json:"constraints"`
	InternalVariables    int    `json:"internal_variables"`
	SecretVariables      int    `json:"secret_variables"`
	PublicVariables      int    `json:"public_variables"`
}

type ceremonyArtifacts struct {
	ProvingKey   ceremonyDigest `json:"proving_key"`
	VerifyingKey ceremonyDigest `json:"verifying_key"`
	ToxicNotes   ceremonyDigest `json:"toxic_waste_notes"`
}

type ceremonySigning struct {
	SignatureKeyID       string `json:"signature_key_id"`
	ManifestPublicKeyHex string `json:"manifest_public_key_hex"`
	SigningKeyPath       string `json:"signing_key_path,omitempty"`
	SigningKeyGenerated  bool   `json:"signing_key_generated"`
}

type ceremonyToxicWaste struct {
	Statement string `json:"statement"`
}

func cmdSetupCeremony(args []string) error {
	now := time.Now().UTC()
	fs := flag.NewFlagSet("setup-ceremony", flag.ContinueOnError)
	outDir := fs.String("out-dir", "", "fresh output directory for ownership.pk, ownership.vk, manifest.json, manifest.sig, and provenance files")
	keyVersion := fs.String("key-version", prover.DefaultKeyVersion, "key version written into the manifest")
	signatureKeyID := fs.String("signature-key-id", "", "Ed25519 release signing key id written into the manifest")
	signingKeyPath := fs.String("signing-key", "", "hex-encoded Ed25519 private key path; generated under output/signing-keys when omitted")
	requireCleanGit := fs.Bool("require-clean-git", false, "fail if the git working tree is dirty")
	ackSingleActor := fs.Bool("acknowledge-single-actor", false, "acknowledge that this is a documented single-actor local setup, not a public MPC ceremony")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments: %s", strings.Join(fs.Args(), " "))
	}
	if *signatureKeyID == "" {
		*signatureKeyID = "proof-helper-local-" + now.Format("20060102")
	}
	if *outDir == "" {
		*outDir = filepath.Join("output", "ceremony", safeFileToken(*keyVersion)+"-local-"+now.Format("20060102T150405Z"))
	}
	if *signingKeyPath == "" {
		*signingKeyPath = defaultSigningKeyPath(*signatureKeyID)
	}

	result, err := runSetupCeremony(setupCeremonyOptions{
		OutDir:                 *outDir,
		KeyVersion:             *keyVersion,
		SignatureKeyID:         *signatureKeyID,
		SigningKeyPath:         *signingKeyPath,
		RequireCleanGit:        *requireCleanGit,
		AcknowledgeSingleActor: *ackSingleActor,
		Now:                    now,
		CommandLine:            append([]string(nil), os.Args...),
	})
	if err != nil {
		return err
	}
	fmt.Printf("wrote setup ceremony bundle: %s\n", result.OutDir)
	fmt.Printf("manifest: %s\n", result.ManifestPath)
	fmt.Printf("manifest_signature: %s\n", result.ManifestSignature)
	fmt.Printf("manifest_public_key: %s\n", result.ManifestPublicKey)
	fmt.Printf("manifest_public_key_hex: %s\n", result.ManifestPublicKeyHex)
	fmt.Printf("signature_key_id: %s\n", result.Manifest.SignatureKeyID)
	fmt.Printf("vk_hash: %s\n", result.Manifest.VKHash)
	fmt.Printf("setup_transcript_hash: %s\n", result.Manifest.SetupTranscriptHash)
	if result.SigningKeyGenerated {
		fmt.Printf("generated_signing_key: %s\n", result.SigningKeyPath)
	} else {
		fmt.Printf("signing_key: %s\n", result.SigningKeyPath)
	}
	return nil
}

func cmdVerifyKeyBundle(args []string) error {
	fs := flag.NewFlagSet("verify-key-bundle", flag.ContinueOnError)
	keysDir := fs.String("keys-dir", prover.DefaultKeyDir(), "key bundle directory")
	keyVersion := fs.String("key-version", "", "expected key version; inferred from manifest.json when omitted")
	publicKeyHex := fs.String("manifest-public-key", "", "trusted Ed25519 manifest public key as hex")
	publicKeyFile := fs.String("manifest-public-key-file", "", "trusted Ed25519 manifest public key hex file")
	expectedSignatureKeyID := fs.String("signature-key-id", "", "optional expected manifest signature key id")
	requireProvingKey := fs.Bool("require-proving-key", true, "require and hash ownership.pk")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments: %s", strings.Join(fs.Args(), " "))
	}
	keysDirWasSet := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "keys-dir" {
			keysDirWasSet = true
		}
	})
	if !keysDirWasSet && *keyVersion == prover.DefaultDestinationKeyVersion {
		*keysDir = prover.DefaultDestinationKeyDir()
	}
	pubHex, trusted, err := manifestPublicKeyForVerification(*keysDir, *publicKeyHex, *publicKeyFile)
	if err != nil {
		return err
	}
	if !trusted {
		fmt.Fprintln(os.Stderr, "warning: using bundled manifest-public-key.hex; this checks integrity but does not establish signer trust")
	}
	manifest, err := verifyKeyBundle(*keysDir, *keyVersion, pubHex, *expectedSignatureKeyID, *requireProvingKey)
	if err != nil {
		return err
	}
	fmt.Printf("verified key bundle: %s\n", *keysDir)
	fmt.Printf("signature_key_id: %s\n", manifest.SignatureKeyID)
	fmt.Printf("vk_hash: %s\n", manifest.VKHash)
	return nil
}

func runSetupCeremony(opts setupCeremonyOptions) (*setupCeremonyResult, error) {
	if !opts.AcknowledgeSingleActor {
		return nil, errors.New("--acknowledge-single-actor is required: this tool performs a documented single-actor local setup, not a public MPC ceremony")
	}
	if strings.TrimSpace(opts.SignatureKeyID) == "" {
		return nil, errors.New("--signature-key-id is required")
	}
	if strings.TrimSpace(opts.KeyVersion) == "" {
		return nil, errors.New("--key-version is required")
	}
	profile, err := ceremonyProfileForKeyVersion(opts.KeyVersion)
	if err != nil {
		return nil, err
	}
	opts.KeyVersion = profile.KeyVersion
	if opts.Now.IsZero() {
		opts.Now = time.Now().UTC()
	}
	opts.Now = opts.Now.UTC()

	source := collectCeremonySource()
	if opts.RequireCleanGit {
		if source.CollectionError != "" {
			return nil, fmt.Errorf("cannot require clean git: %s", source.CollectionError)
		}
		if source.Dirty {
			return nil, errors.New("git working tree is dirty; commit, stash, or omit --require-clean-git for a local rehearsal")
		}
	}
	if err := ensureFreshDirectory(opts.OutDir); err != nil {
		return nil, err
	}

	privateKey, publicKey, generatedSigningKey, err := readOrCreateEd25519SigningKey(opts.SigningKeyPath)
	if err != nil {
		return nil, err
	}
	publicKeyHex := hex.EncodeToString(publicKey)
	if err := writeTextFile(filepath.Join(opts.OutDir, manifestPublicKeyFile), publicKeyHex+"\n"); err != nil {
		return nil, err
	}

	fmt.Fprintf(os.Stderr, "compiling %s circuit\n", profile.Label)
	ccs, err := profile.Compile()
	if err != nil {
		return nil, err
	}
	ccsDigest, err := digestConstraintSystem(ccs)
	if err != nil {
		return nil, err
	}

	fmt.Fprintln(os.Stderr, "running Groth16 setup")
	pk, vk, err := prover.Setup(ccs)
	if err != nil {
		return nil, err
	}
	pkPath := filepath.Join(opts.OutDir, "ownership.pk")
	vkPath := filepath.Join(opts.OutDir, "ownership.vk")
	if err := prover.SavePK(pk, pkPath); err != nil {
		return nil, err
	}
	if err := prover.SaveVK(vk, vkPath); err != nil {
		return nil, err
	}

	pkDigest, err := prover.DigestFile(pkPath)
	if err != nil {
		return nil, err
	}
	vkDigest, err := prover.DigestFile(vkPath)
	if err != nil {
		return nil, err
	}

	toxicNotesPath := filepath.Join(opts.OutDir, toxicWasteNotesFile)
	if err := writeTextFile(toxicNotesPath, toxicWasteNotes(opts.Now, source)); err != nil {
		return nil, err
	}
	toxicNotesDigest, err := prover.DigestFile(toxicNotesPath)
	if err != nil {
		return nil, err
	}

	transcript := setupTranscript{
		Schema:                  ceremonyTranscriptSchema,
		GeneratedAt:             opts.Now.Format(time.RFC3339),
		CeremonyType:            "single-actor-local-gnark-groth16-setup",
		TrustModel:              "The operator of this machine is trusted to have run the setup honestly and not retained trapdoor material.",
		SingleActorAcknowledged: opts.AcknowledgeSingleActor,
		KeyVersion:              opts.KeyVersion,
		CircuitID:               profile.CircuitID,
		Curve:                   "BLS12-381",
		Backend:                 "groth16",
		Software: ceremonySoftware{
			ProofToolVersion: prover.ProofToolVersion,
			GnarkVersion:     prover.GnarkVersion,
			GoVersion:        runtime.Version(),
		},
		Environment: ceremonyEnvironment{
			OS:       runtime.GOOS,
			Arch:     runtime.GOARCH,
			Hostname: hostname(),
			Command:  opts.CommandLine,
		},
		Source: source,
		Circuit: ceremonyCircuit{
			ConstraintSystemHash: ccsDigest.Blake2b256,
			ConstraintSystemSize: ccsDigest.Size,
			Constraints:          ccs.GetNbConstraints(),
			InternalVariables:    ccs.GetNbInternalVariables(),
			SecretVariables:      ccs.GetNbSecretVariables(),
			PublicVariables:      ccs.GetNbPublicVariables(),
		},
		Artifacts: ceremonyArtifacts{
			ProvingKey:   digestFromProver(pkDigest),
			VerifyingKey: digestFromProver(vkDigest),
			ToxicNotes:   digestFromProver(toxicNotesDigest),
		},
		Signing: ceremonySigning{
			SignatureKeyID:       opts.SignatureKeyID,
			ManifestPublicKeyHex: publicKeyHex,
			SigningKeyPath:       opts.SigningKeyPath,
			SigningKeyGenerated:  generatedSigningKey,
		},
		ToxicWaste: ceremonyToxicWaste{
			Statement: "gnark groth16.Setup samples toxic waste in process memory and does not emit toxic-waste files; this run writes no ptau/zkey/transcript containing trapdoor material, but Go does not provide a ceremony-grade zeroization proof.",
		},
	}
	transcriptPath := filepath.Join(opts.OutDir, setupTranscriptFile)
	if err := artifact.WriteJSON(transcriptPath, transcript); err != nil {
		return nil, err
	}
	transcriptDigest, err := prover.DigestFile(transcriptPath)
	if err != nil {
		return nil, err
	}

	manifest := &artifact.KeyManifest{
		Schema:               artifact.ManifestSchema,
		KeyVersion:           opts.KeyVersion,
		CircuitID:            profile.CircuitID,
		Curve:                "BLS12-381",
		Backend:              "groth16",
		VKHash:               vkDigest.Blake2b256,
		ProvingKeySHA256:     pkDigest.SHA256,
		ProvingKeyBlake2b256: pkDigest.Blake2b256,
		ProvingKeySize:       pkDigest.Size,
		VerifyingKeySHA256:   vkDigest.SHA256,
		VerifyingKeySize:     vkDigest.Size,
		ConstraintSystemHash: ccsDigest.Blake2b256,
		CircuitSourceCommit:  sourceCommitForManifest(source),
		ProofToolVersion:     prover.ProofToolVersion,
		GnarkVersion:         prover.GnarkVersion,
		SetupTranscriptHash:  transcriptDigest.Blake2b256,
		PublishedAt:          opts.Now.Format(time.RFC3339),
		SignatureKeyID:       opts.SignatureKeyID,
	}
	manifestPath := filepath.Join(opts.OutDir, "manifest.json")
	if err := artifact.WriteJSON(manifestPath, manifest); err != nil {
		return nil, err
	}

	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("read manifest for signing: %w", err)
	}
	signatureHex := hex.EncodeToString(ed25519.Sign(privateKey, manifestBytes))
	signaturePath := filepath.Join(opts.OutDir, manifestSignatureFile)
	if err := writeTextFile(signaturePath, signatureHex+"\n"); err != nil {
		return nil, err
	}
	if err := writeBundleReadme(opts.OutDir, manifest, publicKeyHex, generatedSigningKey); err != nil {
		return nil, err
	}
	checksumsPath := filepath.Join(opts.OutDir, bundleChecksumsFile)
	if err := writeBundleChecksums(opts.OutDir, checksumsPath); err != nil {
		return nil, err
	}
	if _, err := verifyKeyBundle(opts.OutDir, opts.KeyVersion, publicKeyHex, opts.SignatureKeyID, true); err != nil {
		return nil, err
	}

	return &setupCeremonyResult{
		OutDir:               opts.OutDir,
		ManifestPath:         manifestPath,
		ManifestSignature:    signaturePath,
		ManifestPublicKey:    filepath.Join(opts.OutDir, manifestPublicKeyFile),
		ManifestPublicKeyHex: publicKeyHex,
		SigningKeyPath:       opts.SigningKeyPath,
		SigningKeyGenerated:  generatedSigningKey,
		TranscriptPath:       transcriptPath,
		ToxicWasteNotesPath:  toxicNotesPath,
		ChecksumsPath:        checksumsPath,
		Manifest:             manifest,
	}, nil
}

func verifyKeyBundle(keysDir, keyVersion, publicKeyHex, expectedSignatureKeyID string, requireProvingKey bool) (*artifact.KeyManifest, error) {
	return keybundle.Verify(keybundle.VerifyOptions{
		KeysDir:                keysDir,
		KeyVersion:             keyVersion,
		PublicKeyHex:           publicKeyHex,
		ExpectedSignatureKeyID: expectedSignatureKeyID,
		RequireProvingKey:      requireProvingKey,
	})
}

func ceremonyProfileForKeyVersion(keyVersion string) (ceremonyCircuitProfile, error) {
	return keyprofile.ForKeyVersion(keyVersion)
}

func verifyManifestSignature(manifestPath, signaturePath, publicKeyHex string) error {
	return keybundle.VerifyManifestSignature(manifestPath, signaturePath, publicKeyHex)
}

func manifestPublicKeyForVerification(keysDir, publicKeyHex, publicKeyFile string) (string, bool, error) {
	return keybundle.ManifestPublicKeyForVerification(keysDir, publicKeyHex, publicKeyFile)
}

func ensureFreshDirectory(dir string) error {
	if strings.TrimSpace(dir) == "" {
		return errors.New("output directory is required")
	}
	entries, err := os.ReadDir(dir)
	if err == nil {
		if len(entries) > 0 {
			return fmt.Errorf("output directory %s already exists and is not empty", dir)
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect output directory %s: %w", dir, err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create output directory %s: %w", dir, err)
	}
	return nil
}

func digestConstraintSystem(ccs constraint.ConstraintSystem) (ceremonyDigest, error) {
	sha := sha256.New()
	blake, err := blake2b.New256(nil)
	if err != nil {
		return ceremonyDigest{}, fmt.Errorf("create blake2b digest: %w", err)
	}
	size, err := ccs.WriteTo(io.MultiWriter(sha, blake))
	if err != nil {
		return ceremonyDigest{}, fmt.Errorf("hash constraint system: %w", err)
	}
	return ceremonyDigest{
		SHA256:     "sha256:" + hex.EncodeToString(sha.Sum(nil)),
		Blake2b256: "blake2b256:" + hex.EncodeToString(blake.Sum(nil)),
		Size:       size,
	}, nil
}

func digestFromProver(d prover.FileDigest) ceremonyDigest {
	return ceremonyDigest{SHA256: d.SHA256, Blake2b256: d.Blake2b256, Size: d.Size}
}

func readOrCreateEd25519SigningKey(path string) (ed25519.PrivateKey, ed25519.PublicKey, bool, error) {
	if strings.TrimSpace(path) == "" {
		return nil, nil, false, errors.New("signing key path is required")
	}
	privateKey, publicKey, err := keybundle.LoadExistingPrivateKey(path)
	if err == nil {
		if err := writePublicSigningKey(path, publicKey); err != nil {
			return nil, nil, false, err
		}
		return privateKey, publicKey, false, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, nil, false, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, nil, false, fmt.Errorf("create signing key directory: %w", err)
	}
	publicKey, privateKey, err = ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, false, fmt.Errorf("generate signing key: %w", err)
	}
	if err := os.WriteFile(path, []byte(hex.EncodeToString(privateKey)+"\n"), 0o600); err != nil {
		return nil, nil, false, fmt.Errorf("write signing key %s: %w", path, err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return nil, nil, false, fmt.Errorf("chmod signing key %s: %w", path, err)
	}
	if err := writePublicSigningKey(path, publicKey); err != nil {
		return nil, nil, false, err
	}
	return privateKey, publicKey, true, nil
}

func decodeEd25519PrivateKeyHex(value string) (ed25519.PrivateKey, error) {
	return keybundle.DecodePrivateKeyHex(value)
}

func writePublicSigningKey(privateKeyPath string, publicKey ed25519.PublicKey) error {
	return writeTextFile(publicSigningKeyPath(privateKeyPath), hex.EncodeToString(publicKey)+"\n")
}

func publicSigningKeyPath(privateKeyPath string) string {
	if strings.HasSuffix(privateKeyPath, ".private.hex") {
		return strings.TrimSuffix(privateKeyPath, ".private.hex") + ".public.hex"
	}
	return privateKeyPath + ".pub"
}

func defaultSigningKeyPath(signatureKeyID string) string {
	return filepath.Join("output", "signing-keys", safeFileToken(signatureKeyID)+".ed25519.private.hex")
}

func safeFileToken(value string) string {
	var out strings.Builder
	for _, r := range value {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' || r == '.' {
			out.WriteRune(r)
		} else {
			out.WriteByte('-')
		}
	}
	token := strings.Trim(out.String(), "-.")
	if token == "" {
		return "manifest-signer"
	}
	return token
}

func collectCeremonySource() ceremonySource {
	var source ceremonySource
	root, err := gitOutput("rev-parse", "--show-toplevel")
	if err != nil {
		source.CollectionError = err.Error()
		return source
	}
	source.GitRoot = root
	if commit, err := gitOutput("rev-parse", "HEAD"); err == nil {
		source.GitCommit = commit
	} else {
		source.CollectionError = err.Error()
	}
	if branch, err := gitOutput("rev-parse", "--abbrev-ref", "HEAD"); err == nil {
		source.GitBranch = branch
	}
	status, err := gitOutput("status", "--porcelain=v1")
	if err != nil {
		source.CollectionError = err.Error()
		return source
	}
	source.StatusPorcelain = status
	source.Dirty = strings.TrimSpace(status) != ""
	return source
}

func gitOutput(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return strings.TrimSpace(string(out)), nil
}

func sourceCommitForManifest(source ceremonySource) string {
	if source.GitCommit == "" {
		return ""
	}
	if source.Dirty {
		return source.GitCommit + "+dirty"
	}
	return source.GitCommit
}

func hostname() string {
	name, err := os.Hostname()
	if err != nil {
		return ""
	}
	return name
}

func toxicWasteNotes(generatedAt time.Time, source ceremonySource) string {
	sourceLine := "git commit: unavailable"
	if source.GitCommit != "" {
		sourceLine = "git commit: " + sourceCommitForManifest(source)
	}
	return fmt.Sprintf(`# Toxic Waste Handling

Generated at: %s
%s

This bundle was produced with gnark Groth16 setup for the configured proof circuit.
During setup, gnark samples Groth16 trapdoor values in process memory and uses
them to derive `+"`ownership.pk`"+` and `+"`ownership.vk`"+`. This repository did not write any toxic-waste
file, ptau file, zkey file, or trapdoor transcript for this run.

The setup process exited after writing the release artifacts. That releases the
process memory back to the operating system, but it is not a cryptographic proof
of zeroization. For public reliance, run this command from a clean tagged source
tree on an ephemeral, controlled host with encrypted swap disabled or destroyed,
publish this file and `+"`setup-transcript.json`"+`, and retain only the signing key needed
to authenticate future manifests.

This is a single-actor local setup. Verifiers who do not trust the named setup
operator should require a public multi-party ceremony or a different proof
system with no trusted setup.
`, generatedAt.UTC().Format(time.RFC3339), sourceLine)
}

func writeBundleReadme(outDir string, manifest *artifact.KeyManifest, publicKeyHex string, generatedSigningKey bool) error {
	signingKeyLine := "The private signing key was supplied by the operator."
	if generatedSigningKey {
		signingKeyLine = "A local Ed25519 signing key was generated under output/signing-keys; do not publish the private key."
	}
	text := fmt.Sprintf(`# Proof Tool Key Bundle

This directory contains a signed key bundle for the configured proof circuit.

Files:

- `+"`ownership.pk`"+`: Groth16 proving key.
- `+"`ownership.vk`"+`: Groth16 verifying key.
- `+"`manifest.json`"+`: key metadata, hashes, source, software, and setup transcript hash.
- `+"`manifest.sig`"+`: Ed25519 signature over the exact bytes of `+"`manifest.json`"+`.
- `+"`manifest-public-key.hex`"+`: public half of the manifest signing key.
- `+"`setup-transcript.json`"+`: machine-readable setup provenance.
- `+"`TOXIC-WASTE-HANDLING.md`"+`: trust and toxic-waste handling notes.
- `+"`checksums.sha256`"+`: SHA-256 checksums for the release files.

Key version: %s
Circuit id: %s
Verifying key hash: %s
Signature key id: %s
Manifest public key: %s

%s

The bundled public key is useful for local integrity checks, but production
installers should pin the expected public key and signature key id through a
separate trusted channel.
`, manifest.KeyVersion, manifest.CircuitID, manifest.VKHash, manifest.SignatureKeyID, publicKeyHex, signingKeyLine)
	return writeTextFile(filepath.Join(outDir, bundleReadmeFile), text)
}

func writeBundleChecksums(outDir, checksumsPath string) error {
	files := []string{
		"ownership.pk",
		"ownership.vk",
		"manifest.json",
		manifestSignatureFile,
		manifestPublicKeyFile,
		setupTranscriptFile,
		toxicWasteNotesFile,
		bundleReadmeFile,
	}
	var lines strings.Builder
	for _, name := range files {
		digest, err := prover.DigestFile(filepath.Join(outDir, name))
		if err != nil {
			return err
		}
		lines.WriteString(strings.TrimPrefix(digest.SHA256, "sha256:"))
		lines.WriteString("  ")
		lines.WriteString(name)
		lines.WriteByte('\n')
	}
	return writeTextFile(checksumsPath, lines.String())
}
