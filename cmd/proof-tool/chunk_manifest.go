package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/blake2b"

	"proof-tool/internal/proofassets"
	"proof-tool/internal/prover"
)

const (
	chunkManifestFile          = "chunk-manifest.json"
	chunkManifestSignatureFile = "chunk-manifest.sig"
	chunkManifestPublicKeyFile = "chunk-manifest-public-key.hex"
)

func cmdGenerateChunkManifest(args []string) error {
	now := time.Now().UTC()
	fs := flag.NewFlagSet("generate-chunk-manifest", flag.ContinueOnError)
	keysDir := fs.String("keys-dir", prover.DefaultDestinationKeyDir(), "signed destination key bundle directory")
	deploymentManifestPath := fs.String("deployment-manifest", "", "reclaim deployment manifest JSON path")
	outDir := fs.String("out-dir", "", "fresh output directory for chunk assets and chunk manifest")
	signingKeyPath := fs.String("signing-key", "", "hex-encoded Ed25519 private key path for the chunk manifest")
	chunkSignatureKeyID := fs.String("chunk-signature-key-id", "", "signature key id written into the chunk manifest; defaults to the key manifest signature_key_id")
	keyVersion := fs.String("key-version", prover.DefaultDestinationKeyVersion, "expected key version")
	keyManifestPublicKeyHex := fs.String("manifest-public-key", "", "trusted key-manifest Ed25519 public key as hex")
	keyManifestPublicKeyFile := fs.String("manifest-public-key-file", "", "trusted key-manifest Ed25519 public key hex file")
	allowBundledKeyManifestPublicKey := fs.Bool("allow-bundled-manifest-public-key", false, "allow the bundled manifest-public-key.hex for local rehearsal only")
	expectedKeyManifestSignatureKeyID := fs.String("manifest-signature-key-id", "", "optional expected key-manifest signature key id")
	chunkSize := fs.Int64("chunk-size", 16*1024*1024, "raw proving-key chunk size in bytes")
	baseURL := fs.String("base-url", "", "base URL where chunk assets will be hosted")
	release := fs.String("release", "", "release identifier written into the chunk manifest")
	profile := fs.String("profile", "mainnet-single-destination", "proof asset profile written into the chunk manifest")
	ccsPath := fs.String("ccs-path", "", "serialized ownership-destination CCS path to copy and pin")
	proofWASMPath := fs.String("proof-wasm-path", "", "proof-destination.wasm path to copy and pin")
	workerJSPath := fs.String("worker-js-path", "", "worker.js path to copy and pin")
	msmWorkerWASMPath := fs.String("msm-worker-wasm-path", "", "msmworker.wasm path to copy and pin")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments: %s", strings.Join(fs.Args(), " "))
	}
	if strings.TrimSpace(*deploymentManifestPath) == "" {
		return errors.New("--deployment-manifest is required")
	}
	if strings.TrimSpace(*outDir) == "" {
		return errors.New("--out-dir is required")
	}
	if strings.TrimSpace(*signingKeyPath) == "" {
		return errors.New("--signing-key is required; chunk manifests must not silently create release signing keys")
	}
	if strings.TrimSpace(*ccsPath) == "" {
		return errors.New("--ccs-path is required so the chunk manifest pins the CCS used by browser proving")
	}
	if strings.TrimSpace(*proofWASMPath) == "" {
		return errors.New("--proof-wasm-path is required so the chunk manifest pins the browser proof WASM")
	}
	if strings.TrimSpace(*workerJSPath) == "" {
		return errors.New("--worker-js-path is required so the chunk manifest pins the MSM worker bootstrap")
	}
	if strings.TrimSpace(*msmWorkerWASMPath) == "" {
		return errors.New("--msm-worker-wasm-path is required so the chunk manifest pins the MSM worker WASM")
	}
	if *chunkSize <= 0 {
		return errors.New("--chunk-size must be positive")
	}
	if *keyVersion != prover.DefaultDestinationKeyVersion {
		return fmt.Errorf("generate-chunk-manifest currently supports %q only, got %q", prover.DefaultDestinationKeyVersion, *keyVersion)
	}

	pubHex, trusted, err := manifestPublicKeyForVerification(*keysDir, *keyManifestPublicKeyHex, *keyManifestPublicKeyFile)
	if err != nil {
		return err
	}
	if !trusted {
		if !*allowBundledKeyManifestPublicKey {
			return errors.New("trusted key-manifest public key is required; pass --manifest-public-key or --manifest-public-key-file, or use --allow-bundled-manifest-public-key for a local rehearsal")
		}
		fmt.Fprintln(os.Stderr, "warning: using bundled manifest-public-key.hex for a local rehearsal; this checks integrity but does not establish signer trust")
	}
	keyManifest, err := verifyKeyBundle(*keysDir, *keyVersion, pubHex, *expectedKeyManifestSignatureKeyID, true)
	if err != nil {
		return err
	}
	deploymentManifest, err := proofassets.ReadReclaimDeployment(*deploymentManifestPath)
	if err != nil {
		return err
	}

	vkPath := filepath.Join(*keysDir, "ownership.vk")
	vk, err := prover.LoadVK(vkPath)
	if err != nil {
		return err
	}
	cardanoVKBytes, cardanoVKFormat, err := prover.SerializeCardanoVK(vk)
	if err != nil {
		return err
	}
	cardanoVKDigest := blake2b.Sum256(cardanoVKBytes)
	cardanoVKHash := "blake2b256:" + hex.EncodeToString(cardanoVKDigest[:])
	if err := proofassets.ValidateReclaimDeployment(deploymentManifest, keyManifest, cardanoVKHash); err != nil {
		return err
	}

	if err := ensureFreshDirectory(*outDir); err != nil {
		return err
	}
	if err := copyFile(filepath.Join(*keysDir, "manifest.json"), filepath.Join(*outDir, "manifest.json")); err != nil {
		return err
	}
	if err := copyFile(filepath.Join(*keysDir, manifestSignatureFile), filepath.Join(*outDir, manifestSignatureFile)); err != nil {
		return err
	}
	if err := copyFile(filepath.Join(*keysDir, manifestPublicKeyFile), filepath.Join(*outDir, manifestPublicKeyFile)); err != nil {
		return err
	}
	if err := copyFile(vkPath, filepath.Join(*outDir, "ownership.vk")); err != nil {
		return err
	}
	if err := copyFile(*ccsPath, filepath.Join(*outDir, "ownership-destination.ccs")); err != nil {
		return err
	}
	if err := copyFile(*deploymentManifestPath, filepath.Join(*outDir, "reclaim-deployment.json")); err != nil {
		return err
	}
	if err := copyFile(*proofWASMPath, filepath.Join(*outDir, "proof-destination.wasm")); err != nil {
		return err
	}
	if err := copyFile(*workerJSPath, filepath.Join(*outDir, "worker.js")); err != nil {
		return err
	}
	if err := copyFile(*msmWorkerWASMPath, filepath.Join(*outDir, "msmworker.wasm")); err != nil {
		return err
	}

	privateKey, chunkPublicKey, err := readRequiredEd25519SigningKey(*signingKeyPath)
	if err != nil {
		return err
	}
	signatureKeyID := strings.TrimSpace(*chunkSignatureKeyID)
	if signatureKeyID == "" {
		signatureKeyID = keyManifest.SignatureKeyID
	}
	keyManifestDigest, err := proofassets.DigestFile(filepath.Join(*outDir, "manifest.json"))
	if err != nil {
		return err
	}
	vkDigest, err := proofassets.DigestFile(filepath.Join(*outDir, "ownership.vk"))
	if err != nil {
		return err
	}
	ccsDigest, err := proofassets.DigestFile(filepath.Join(*outDir, "ownership-destination.ccs"))
	if err != nil {
		return err
	}
	proofWASMDigest, err := proofassets.DigestFile(filepath.Join(*outDir, "proof-destination.wasm"))
	if err != nil {
		return err
	}
	workerJSDigest, err := proofassets.DigestFile(filepath.Join(*outDir, "worker.js"))
	if err != nil {
		return err
	}
	msmWorkerWASMDigest, err := proofassets.DigestFile(filepath.Join(*outDir, "msmworker.wasm"))
	if err != nil {
		return err
	}
	manifest, err := proofassets.GenerateChunkManifest(proofassets.ChunkManifestOptions{
		KeyManifest:         keyManifest,
		KeyManifestDigest:   keyManifestDigest,
		Deployment:          deploymentManifest,
		ProvingKeyPath:      filepath.Join(*keysDir, "ownership.pk"),
		ProvingKeyName:      "ownership.pk",
		ChunkOutDir:         *outDir,
		ChunkSize:           *chunkSize,
		Release:             *release,
		Profile:             *profile,
		BaseURL:             *baseURL,
		SignatureKeyID:      signatureKeyID,
		GeneratedAt:         now,
		CardanoVKFormat:     cardanoVKFormat,
		CardanoVKBlake2b256: cardanoVKHash,
		Assets: map[string]proofassets.AssetPin{
			"ownership.vk": {
				Path:       "ownership.vk",
				Size:       vkDigest.Size,
				SHA256:     vkDigest.SHA256,
				Blake2b256: vkDigest.Blake2b256,
			},
			"ownership-destination.ccs": {
				Path:       "ownership-destination.ccs",
				Size:       ccsDigest.Size,
				SHA256:     ccsDigest.SHA256,
				Blake2b256: ccsDigest.Blake2b256,
			},
			"proof-destination.wasm": {
				Path:       "proof-destination.wasm",
				Size:       proofWASMDigest.Size,
				SHA256:     proofWASMDigest.SHA256,
				Blake2b256: proofWASMDigest.Blake2b256,
			},
			"worker.js": {
				Path:       "worker.js",
				Size:       workerJSDigest.Size,
				SHA256:     workerJSDigest.SHA256,
				Blake2b256: workerJSDigest.Blake2b256,
			},
			"msmworker.wasm": {
				Path:       "msmworker.wasm",
				Size:       msmWorkerWASMDigest.Size,
				SHA256:     msmWorkerWASMDigest.SHA256,
				Blake2b256: msmWorkerWASMDigest.Blake2b256,
			},
		},
	})
	if err != nil {
		return err
	}
	chunkManifestPath := filepath.Join(*outDir, chunkManifestFile)
	if err := proofassets.WriteChunkManifest(chunkManifestPath, manifest); err != nil {
		return err
	}
	rawManifest, err := os.ReadFile(chunkManifestPath)
	if err != nil {
		return fmt.Errorf("read chunk manifest for signing: %w", err)
	}
	signatureHex := proofassets.SignDetached(rawManifest, privateKey)
	chunkSignaturePath := filepath.Join(*outDir, chunkManifestSignatureFile)
	if err := writeTextFile(chunkSignaturePath, signatureHex+"\n"); err != nil {
		return err
	}
	chunkPublicKeyHex := hex.EncodeToString(chunkPublicKey)
	if err := writeTextFile(filepath.Join(*outDir, chunkManifestPublicKeyFile), chunkPublicKeyHex+"\n"); err != nil {
		return err
	}
	if err := proofassets.VerifyDetachedSignature(rawManifest, signatureHex, chunkPublicKeyHex); err != nil {
		return fmt.Errorf("verify generated chunk manifest signature: %w", err)
	}
	if err := proofassets.ValidateChunkManifest(manifest, proofassets.ChunkManifestExpectations{
		KeyManifest:         keyManifest,
		KeyManifestDigest:   keyManifestDigest,
		Deployment:          deploymentManifest,
		CardanoVKFormat:     cardanoVKFormat,
		CardanoVKBlake2b256: cardanoVKHash,
	}); err != nil {
		return err
	}
	if err := proofassets.VerifyChunkFiles(manifest, *outDir); err != nil {
		return err
	}
	idx, err := proofassets.BuildPKIndex(filepath.Join(*keysDir, "ownership.pk"))
	if err != nil {
		return err
	}
	if err := proofassets.WritePKIndex(filepath.Join(*outDir, "ownership.pk.idx.json"), idx); err != nil {
		return err
	}

	fmt.Printf("wrote chunk manifest: %s\n", chunkManifestPath)
	fmt.Printf("chunk_manifest_signature: %s\n", chunkSignaturePath)
	fmt.Printf("chunk_manifest_public_key: %s\n", filepath.Join(*outDir, chunkManifestPublicKeyFile))
	fmt.Printf("signature_key_id: %s\n", signatureKeyID)
	fmt.Printf("chunks: %d\n", len(manifest.ProvingKey.Chunks))
	fmt.Printf("chunk_size: %d\n", manifest.ProvingKey.ChunkSize)
	fmt.Printf("proving_key_size: %d\n", manifest.Coherence.ProvingKeySize)
	fmt.Printf("vk_hash: %s\n", manifest.Coherence.VKHash)
	fmt.Printf("deployment_id: %s\n", manifest.Coherence.DeploymentID)
	fmt.Printf("cardano_vk_blake2b256: %s\n", manifest.Coherence.CardanoVKBlake2b256)
	return nil
}

func readRequiredEd25519SigningKey(path string) (ed25519.PrivateKey, ed25519.PublicKey, error) {
	rawHex, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("read signing key %s: %w", path, err)
	}
	privateKey, err := decodeEd25519PrivateKeyHex(strings.TrimSpace(string(rawHex)))
	if err != nil {
		return nil, nil, fmt.Errorf("read signing key %s: %w", path, err)
	}
	publicKey := privateKey.Public().(ed25519.PublicKey)
	return privateKey, publicKey, nil
}

func copyFile(src, dst string) (err error) {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open %s: %w", src, err)
	}
	defer in.Close()
	if err := mkdirParent(dst); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create %s: %w", dst, err)
	}
	defer func() {
		if cerr := out.Close(); cerr != nil && err == nil {
			err = fmt.Errorf("close %s: %w", dst, cerr)
		}
	}()
	if _, err := io.Copy(out, in); err != nil {
		return fmt.Errorf("copy %s to %s: %w", src, dst, err)
	}
	return nil
}
