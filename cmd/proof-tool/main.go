package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"proof-tool/internal/artifact"
	"proof-tool/internal/circuit/ownership"
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
	case "verify":
		return cmdVerify(args[2:])
	case "export-cardano":
		return cmdExportCardano(args[2:])
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

func cmdExportCardano(args []string) error {
	fs := flag.NewFlagSet("export-cardano", flag.ContinueOnError)
	proofPath := fs.String("master-xprv-proof", "", "proof artifact JSON path")
	keysDir := fs.String("keys-dir", prover.DefaultKeyDir(), "local verifying key bundle directory")
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

	vkPath := filepath.Join(*keysDir, "ownership.vk")
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

	if err := os.MkdirAll(*outDir, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", *outDir, err)
	}
	if err := writeHexFile(filepath.Join(*outDir, "proof.hex"), proofBytes); err != nil {
		return err
	}
	if err := writeHexFile(filepath.Join(*outDir, "vk.hex"), vkBytes); err != nil {
		return err
	}
	if err := writeHexFile(filepath.Join(*outDir, "pub.hex"), publicInputDigest); err != nil {
		return err
	}
	if err := writeTextFile(filepath.Join(*outDir, "format.txt"), proofFormat+"\n"); err != nil {
		return err
	}

	fmt.Printf("wrote cardano proof: %s\n", filepath.Join(*outDir, "proof.hex"))
	fmt.Printf("wrote cardano vk: %s\n", filepath.Join(*outDir, "vk.hex"))
	fmt.Printf("wrote public input digest: %s\n", filepath.Join(*outDir, "pub.hex"))
	fmt.Printf("format: %s\n", proofFormat)
	fmt.Printf("proof_bytes: %d\n", len(proofBytes))
	fmt.Printf("vk_bytes: %d\n", len(vkBytes))
	return nil
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
	var generator helper.Generator = &helper.OwnershipGenerator{KeysDir: *keysDir, AllowCreateKeys: *devCreateKeys}
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
	if err := writeStartupJSON(os.Stdout, helperStartupEvent{
		Type:             "proof_tool_helper_ready",
		HelperURL:        helperURL,
		SiteURL:          *siteURL,
		PairingURL:       pairedURL,
		Token:            token,
		AllowedOrigins:   origins,
		SidecarVersion:   helper.SidecarVersion,
		ProtocolVersion:  helper.ProtocolVersion,
		CircuitID:        ownership.CircuitID,
		KeyState:         key.State,
		KeyReady:         key.Ready,
		KeyVersion:       key.KeyVersion,
		KeyHash:          key.VKHash,
		KeyCompatibility: helperCompatibilityForKey(key),
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
	Type             string   `json:"type"`
	HelperURL        string   `json:"helper_url"`
	SiteURL          string   `json:"site_url"`
	PairingURL       string   `json:"pairing_url"`
	Token            string   `json:"token"`
	AllowedOrigins   []string `json:"allowed_origins"`
	SidecarVersion   string   `json:"sidecar_version"`
	ProtocolVersion  string   `json:"protocol_version"`
	CircuitID        string   `json:"circuit_id"`
	KeyState         string   `json:"key_state"`
	KeyReady         bool     `json:"key_ready"`
	KeyVersion       string   `json:"key_version,omitempty"`
	KeyHash          string   `json:"key_hash,omitempty"`
	KeyCompatibility string   `json:"key_compatibility"`
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
	fmt.Fprintln(os.Stderr, "usage: proof-tool <master-xprv-from-seed-phrase|prove|verify|export-cardano|serve-verifier|serve-helper> [flags]")
}
