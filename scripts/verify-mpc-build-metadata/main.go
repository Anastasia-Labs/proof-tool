// Command verify-mpc-build-metadata semantically verifies one reproducible MPC
// build package. It is intentionally stricter than a directory diff: every
// build-profile, tag, SBOM, and root-manifest field must agree with caller
// supplied production identity.
package main

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"debug/buildinfo"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"slices"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/crypto/blake2b"
)

const (
	productionGoVersion = "go1.26.5"
	expectedBuildFlags  = "-mod=vendor\x00-trimpath\x00-buildvcs=true\x00-ldflags=-buildid="
)

var (
	lowerCommitPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
	fingerprintPattern = regexp.MustCompile(`^([0-9A-F]{40}|[0-9A-F]{64})$`)
	lowerSHA256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	rootFileNames      = []string{
		"binary-manifest.json",
		"build-mode.txt",
		"checksums.blake2b256",
		"checksums.sha256",
		"go-build-info.txt",
		"finalization-evidence-binary-manifest.json",
		"finalization-evidence-go-build-info.txt",
		"finalization-evidence-sbom.cdx.json",
		"mpc-finalization-evidence",
		"mpc-ceremony",
		"sbom.cdx.json",
		"signed-tag-object.txt",
		"signed-tag-signer-fingerprint.txt",
		"signed-tag-status.txt",
		"signed-tag.txt",
		"source-checksums.sha256",
		"source-commit.txt",
		"source-date-epoch.txt",
		"toolchain-checksums.sha256",
		"vendor-checksums.sha256",
	}
	gnarkPatchNames = []string{
		"prove-stream.patch",
		"domain-read-no-precompute.patch",
		"release-ccs-after-solve.patch",
		"dispatch-before-fft.patch",
		"computeh-scoped-coset-tables.patch",
		"uints-constant-fold.patch",
		"computeh-parallel-transforms.patch",
		"mpc-phase1-parallel-update.patch",
		"mpc-phase1-parallel-codec.patch",
		"mpc-phase2-parallel-initialize.patch",
	}
)

type digestEntry struct {
	Filename   string `json:"filename"`
	SizeBytes  int64  `json:"size_bytes"`
	SHA256     string `json:"sha256"`
	Blake2b256 string `json:"blake2b256"`
}

type digestManifest struct {
	GoVersion  string        `json:"go_version"`
	BuildFlags []string      `json:"build_flags"`
	Files      []digestEntry `json:"files"`
}

type property struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type componentHash struct {
	Algorithm string `json:"alg"`
	Content   string `json:"content"`
}

type component struct {
	Type       string          `json:"type"`
	Group      string          `json:"group,omitempty"`
	Name       string          `json:"name"`
	Version    string          `json:"version"`
	BOMRef     string          `json:"bom-ref,omitempty"`
	PURL       string          `json:"purl,omitempty"`
	Hashes     []componentHash `json:"hashes"`
	Properties []property      `json:"properties"`
}

type sbom struct {
	BOMFormat   string `json:"bomFormat"`
	SpecVersion string `json:"specVersion"`
	Version     int    `json:"version"`
	Metadata    struct {
		Tools struct {
			Components []component `json:"components"`
		} `json:"tools"`
		Component  component  `json:"component"`
		Properties []property `json:"properties"`
	} `json:"metadata"`
	Components []component `json:"components"`
}

func main() {
	dir := flag.String("dir", "", "build package directory")
	mode := flag.String("mode", "", "expected build mode")
	commit := flag.String("commit", "", "expected lowercase 40-character source commit")
	tag := flag.String("tag", "", "expected signed production tag or none")
	fingerprint := flag.String("tag-signer-fingerprint", "", "expected uppercase tag signer fingerprint or none")
	sourceRoot := flag.String("source-root", "", "exact clean source checkout used to independently verify source and SBOM identities")
	trustedBuildPublicKey := flag.String("trusted-build-public-key-file", "", "out-of-band trusted Ed25519 build public key or none")
	flag.Parse()
	if flag.NArg() != 0 || *dir == "" || (*mode != "production" && *mode != "rehearsal") ||
		!lowerCommitPattern.MatchString(*commit) || *tag == "" || *fingerprint == "" ||
		*sourceRoot == "" || *trustedBuildPublicKey == "" {
		fatal(errors.New("usage: verify-mpc-build-metadata --dir DIR --mode production|rehearsal --commit COMMIT --tag TAG|none --tag-signer-fingerprint HEX|none --source-root DIR --trusted-build-public-key-file FILE|none"))
	}
	if (*mode == "production" && *trustedBuildPublicKey == "none") ||
		(*mode == "rehearsal" && *trustedBuildPublicKey != "none") {
		fatal(errors.New("production requires an out-of-band trusted build public key; rehearsal requires none"))
	}
	if err := verifyPlainIdentity(*dir, *mode, *commit, *tag, *fingerprint); err != nil {
		fatal(err)
	}
	if err := verifySourceCheckout(*sourceRoot, *dir, *commit); err != nil {
		fatal(err)
	}
	ceremonyManifest, err := readDigestManifest(filepath.Join(*dir, "binary-manifest.json"))
	if err != nil {
		fatal(err)
	}
	if err := verifyBinaryManifest(*dir, ceremonyManifest, "mpc-ceremony"); err != nil {
		fatal(err)
	}
	evidenceManifest, err := readDigestManifest(
		filepath.Join(*dir, "finalization-evidence-binary-manifest.json"),
	)
	if err != nil {
		fatal(err)
	}
	if err := verifyBinaryManifest(*dir, evidenceManifest, "mpc-finalization-evidence"); err != nil {
		fatal(err)
	}
	if err := verifyBinaryChecksums(*dir, ceremonyManifest.Files[0], evidenceManifest.Files[0]); err != nil {
		fatal(err)
	}
	if err := verifyBuildInfo(filepath.Join(*dir, "mpc-ceremony"), *commit); err != nil {
		fatal(err)
	}
	if err := verifyBuildInfo(filepath.Join(*dir, "mpc-finalization-evidence"), *commit); err != nil {
		fatal(err)
	}
	if err := verifySBOM(
		filepath.Join(*dir, "sbom.cdx.json"),
		*sourceRoot,
		*commit,
		"mpc-ceremony",
	); err != nil {
		fatal(err)
	}
	if err := verifySBOM(
		filepath.Join(*dir, "finalization-evidence-sbom.cdx.json"),
		*sourceRoot,
		*commit,
		"mpc-finalization-evidence",
	); err != nil {
		fatal(err)
	}
	root, err := readDigestManifest(filepath.Join(*dir, "build-package-manifest.json"))
	if err != nil {
		fatal(err)
	}
	if err := verifyRootManifest(*dir, root); err != nil {
		fatal(err)
	}
	if err := verifyBuildSignature(*dir, *mode, *trustedBuildPublicKey); err != nil {
		fatal(err)
	}
}

func verifyPlainIdentity(dir, mode, commit, tag, fingerprint string) error {
	values := map[string]string{
		"build-mode.txt":                    mode,
		"source-commit.txt":                 commit,
		"signed-tag.txt":                    tag,
		"signed-tag-signer-fingerprint.txt": fingerprint,
	}
	for name, expected := range values {
		actual, err := readOneLine(filepath.Join(dir, name))
		if err != nil {
			return err
		}
		if actual != expected {
			return fmt.Errorf("%s is %q, want %q", name, actual, expected)
		}
	}
	status, err := readOneLine(filepath.Join(dir, "signed-tag-status.txt"))
	if err != nil {
		return err
	}
	tagObject, err := readOneLine(filepath.Join(dir, "signed-tag-object.txt"))
	if err != nil {
		return err
	}
	if mode == "production" {
		if tag == "none" || !fingerprintPattern.MatchString(fingerprint) ||
			status != "verified" || !lowerCommitPattern.MatchString(tagObject) {
			return errors.New("production package does not contain an exact verified signed-tag identity")
		}
	} else if tag != "none" || fingerprint != "none" ||
		status != "not-required-for-rehearsal" || tagObject != "none" {
		return errors.New("untagged rehearsal package contains inconsistent signed-tag identity")
	}
	epoch, err := readOneLine(filepath.Join(dir, "source-date-epoch.txt"))
	if err != nil {
		return err
	}
	parsedEpoch, err := strconv.ParseInt(epoch, 10, 64)
	if err != nil || parsedEpoch <= 0 {
		return errors.New("source-date-epoch.txt is not a positive Unix timestamp")
	}
	return verifyToolchainChecksums(filepath.Join(dir, "toolchain-checksums.sha256"))
}

func verifyToolchainChecksums(path string) error {
	const expected = "" +
		"8da5fd321795754b994c64e3eb8a5a14ff47bd285559a7e876f3c79abafc67f9  go\n" +
		"10c67b9de41c1e546b9bf416ceef410e5e3dd87a76d129b08b74a9570db9c463  compile\n" +
		"e58a36e6550a32ed7175cd6e2a1824dc66c034d1e3539ebeac8af719a9150d5d  link\n" +
		"0c9a07447aba3ed1df7a0a3e85f6e003d9bf312d2936dfc4b79e3d81e8ca7636  asm\n"
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if string(data) != expected {
		return errors.New("toolchain-checksums.sha256 does not identify the approved Go 1.26.5 linux/amd64 toolchain")
	}
	return nil
}

func verifyBinaryManifest(dir string, manifest digestManifest, binaryName string) error {
	if manifest.GoVersion != productionGoVersion ||
		strings.Join(manifest.BuildFlags, "\x00") != expectedBuildFlags ||
		len(manifest.Files) != 1 ||
		manifest.Files[0].Filename != binaryName {
		return fmt.Errorf("binary manifest for %s does not describe the exact production build profile", binaryName)
	}
	return verifyDigestEntry(dir, manifest.Files[0])
}

func verifyBinaryChecksums(dir string, entries ...digestEntry) error {
	var shaLines []string
	var blakeLines []string
	for _, entry := range entries {
		shaLines = append(shaLines, entry.SHA256+"  "+entry.Filename)
		blakeLines = append(blakeLines, entry.Blake2b256+"  "+entry.Filename)
	}
	expectedSHA := strings.Join(shaLines, "\n") + "\n"
	expectedBlake := strings.Join(blakeLines, "\n") + "\n"
	actualSHA, err := os.ReadFile(filepath.Join(dir, "checksums.sha256"))
	if err != nil {
		return err
	}
	actualBlake, err := os.ReadFile(filepath.Join(dir, "checksums.blake2b256"))
	if err != nil {
		return err
	}
	if string(actualSHA) != expectedSHA || string(actualBlake) != expectedBlake {
		return errors.New("binary checksum files do not exactly match both binary manifests")
	}
	return nil
}

func verifyBuildInfo(path, commit string) error {
	info, err := buildinfo.ReadFile(path)
	if err != nil {
		return err
	}
	if info.GoVersion != productionGoVersion {
		return fmt.Errorf("binary Go version is %q, want %q", info.GoVersion, productionGoVersion)
	}
	expected := map[string]string{
		"-buildmode":   "exe",
		"-compiler":    "gc",
		"-trimpath":    "true",
		"CGO_ENABLED":  "0",
		"GOARCH":       "amd64",
		"GOOS":         "linux",
		"GOAMD64":      "v1",
		"vcs":          "git",
		"vcs.modified": "false",
		"vcs.revision": commit,
	}
	for key, value := range expected {
		actual, err := uniqueSetting(info, key)
		if err != nil {
			return err
		}
		if actual != value {
			return fmt.Errorf("binary build setting %s is %q, want %q", key, actual, value)
		}
	}
	return nil
}

func verifySBOM(path, sourceRoot, commit, binaryName string) error {
	var value sbom
	if err := readStrictJSON(path, &value); err != nil {
		return err
	}
	if value.BOMFormat != "CycloneDX" || value.SpecVersion != "1.5" || value.Version != 1 {
		return errors.New("SBOM is not exact CycloneDX 1.5")
	}
	if len(value.Metadata.Tools.Components) != 1 ||
		!exactSBOMComponent(
			value.Metadata.Tools.Components[0],
			"application",
			"proof-tool/scripts/generate-go-sbom",
			commit,
			"",
		) {
		return errors.New("SBOM generator identity is not exact")
	}
	if !exactSBOMComponent(
		value.Metadata.Component,
		"application",
		binaryName,
		commit,
		"pkg:golang/proof-tool/"+binaryName+"@"+commit,
	) {
		return errors.New("SBOM application identity is not exact")
	}
	requiredMetadata := map[string]string{
		"proof-tool:go-version":    productionGoVersion,
		"proof-tool:source-commit": commit,
		"proof-tool:vcs-modified":  "false",
	}
	if len(value.Metadata.Properties) != len(requiredMetadata) {
		return errors.New("SBOM contains an unexpected metadata property set")
	}
	for name, expected := range requiredMetadata {
		actual, err := uniqueProperty(value.Metadata.Properties, name)
		if err != nil || actual != expected {
			return fmt.Errorf("SBOM metadata property %s does not equal %q", name, expected)
		}
	}
	info, err := buildinfo.ReadFile(filepath.Join(filepath.Dir(path), binaryName))
	if err != nil {
		return err
	}
	linked := make(map[string]string, len(info.Deps))
	for _, dependency := range info.Deps {
		if dependency == nil || dependency.Replace != nil {
			return errors.New("binary contains an invalid or replaced dependency")
		}
		linked[dependency.Path] = dependency.Version
	}
	if len(value.Components) != len(linked) {
		return errors.New("SBOM component set does not equal linked module set")
	}
	moduleSums, err := readModuleSums(filepath.Join(sourceRoot, "go.sum"))
	if err != nil {
		return err
	}
	patchDigests, err := gnarkPatchDigests(sourceRoot)
	if err != nil {
		return err
	}
	seen := make(map[string]struct{}, len(value.Components))
	for _, component := range value.Components {
		expectedVersion, linkedComponent := linked[component.Name]
		expectedPURL := "pkg:golang/" + component.Name + "@" + component.Version
		if !linkedComponent || component.Type != "library" || component.Group != "" ||
			expectedVersion != component.Version || component.BOMRef != expectedPURL ||
			component.PURL != expectedPURL {
			return fmt.Errorf("SBOM component %s@%s is not an exact linked module", component.Name, component.Version)
		}
		if _, duplicate := seen[component.Name]; duplicate {
			return fmt.Errorf("SBOM component %q is duplicated", component.Name)
		}
		seen[component.Name] = struct{}{}
		moduleSum, err := uniqueProperty(component.Properties, "proof-tool:golang:module-sum")
		if err != nil {
			return err
		}
		expectedModuleSum, ok := moduleSums[component.Name+"@"+component.Version]
		if !ok || moduleSum != expectedModuleSum {
			return fmt.Errorf("SBOM component %q module sum does not equal go.sum", component.Name)
		}
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(moduleSum, "h1:"))
		if !strings.HasPrefix(moduleSum, "h1:") || err != nil || len(decoded) != sha256.Size {
			return fmt.Errorf("SBOM component %q has invalid module sum", component.Name)
		}
		if len(component.Hashes) != 1 ||
			component.Hashes[0].Algorithm != "SHA-256" ||
			component.Hashes[0].Content != hex.EncodeToString(decoded) {
			return fmt.Errorf("SBOM component %q hash does not equal module sum", component.Name)
		}
		vendored, err := uniqueProperty(component.Properties, "proof-tool:golang:vendored-tree-sha256")
		if err != nil {
			return err
		}
		expectedVendored, err := vendoredTreeDigest(sourceRoot, component.Name)
		if err != nil || vendored != expectedVendored {
			return fmt.Errorf("SBOM component %q vendored-tree digest does not match the exact source checkout", component.Name)
		}
		expectedPropertyCount := 2
		if component.Name == "github.com/consensys/gnark" {
			expectedPropertyCount += len(gnarkPatchNames)
			for _, patch := range gnarkPatchNames {
				name := "proof-tool:vendored-patch:" + patch + ":sha256"
				digest, err := uniqueProperty(component.Properties, name)
				if err != nil || digest != patchDigests[patch] {
					return fmt.Errorf("SBOM gnark patch digest %q does not match the exact source checkout", patch)
				}
			}
		}
		if len(component.Properties) != expectedPropertyCount {
			return fmt.Errorf("SBOM component %q contains an unexpected property set", component.Name)
		}
	}
	return nil
}

func exactSBOMComponent(component component, componentType, name, version, purl string) bool {
	return component.Type == componentType &&
		component.Group == "" &&
		component.Name == name &&
		component.Version == version &&
		component.BOMRef == purl &&
		component.PURL == purl &&
		len(component.Hashes) == 0 &&
		len(component.Properties) == 0
}

func verifyRootManifest(dir string, manifest digestManifest) error {
	if manifest.GoVersion != productionGoVersion ||
		strings.Join(manifest.BuildFlags, "\x00") != expectedBuildFlags ||
		len(manifest.Files) != len(rootFileNames) {
		return errors.New("build-package-manifest.json has invalid build identity or entry count")
	}
	names := make([]string, 0, len(manifest.Files))
	for _, entry := range manifest.Files {
		names = append(names, entry.Filename)
		if err := verifyDigestEntry(dir, entry); err != nil {
			return err
		}
	}
	if !slices.Equal(names, rootFileNames) {
		return errors.New("build-package-manifest.json has an unexpected or reordered entry set")
	}
	data, err := os.ReadFile(filepath.Join(dir, "build-package-manifest.json"))
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	checksum, err := readOneLine(filepath.Join(dir, "build-package-manifest.sha256"))
	if err != nil {
		return err
	}
	expected := hex.EncodeToString(sum[:]) + "  build-package-manifest.json"
	if checksum != expected {
		return errors.New("build-package-manifest.sha256 does not match exact root manifest bytes")
	}
	return nil
}

func verifyBuildSignature(dir, mode, trustedPublicKeyPath string) error {
	signaturePath := filepath.Join(dir, "build-package-manifest.sig")
	bundledKeyPath := filepath.Join(dir, "build-package-manifest-public-key.hex")
	if mode == "rehearsal" {
		for _, path := range []string{signaturePath, bundledKeyPath} {
			if _, err := os.Lstat(path); err == nil {
				return fmt.Errorf("rehearsal package unexpectedly contains %s", filepath.Base(path))
			} else if !errors.Is(err, fs.ErrNotExist) {
				return err
			}
		}
		return nil
	}
	trusted, err := readHexLine(trustedPublicKeyPath, ed25519.PublicKeySize)
	if err != nil {
		return fmt.Errorf("trusted build public key: %w", err)
	}
	bundled, err := readHexLine(bundledKeyPath, ed25519.PublicKeySize)
	if err != nil {
		return fmt.Errorf("bundled build public key: %w", err)
	}
	if !bytes.Equal(trusted, bundled) {
		return errors.New("bundled build public key does not equal the out-of-band trusted build public key")
	}
	signature, err := readHexLine(signaturePath, ed25519.SignatureSize)
	if err != nil {
		return fmt.Errorf("build-package signature: %w", err)
	}
	manifest, err := os.ReadFile(filepath.Join(dir, "build-package-manifest.json"))
	if err != nil {
		return err
	}
	if !ed25519.Verify(ed25519.PublicKey(trusted), manifest, signature) {
		return errors.New("build-package manifest signature is invalid")
	}
	return nil
}

func verifySourceCheckout(sourceRoot, packageDir, commit string) error {
	rootInfo, err := os.Lstat(sourceRoot)
	if err != nil {
		return err
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("source root must be a real directory")
	}
	head, err := gitOutput(sourceRoot, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return err
	}
	if string(head) != commit+"\n" {
		return errors.New("source root HEAD does not equal the expected release commit")
	}
	for _, args := range [][]string{
		{"diff", "--quiet", "--ignore-submodules", "--"},
		{"diff", "--cached", "--quiet", "--ignore-submodules", "--"},
	} {
		command := exec.Command("git", append([]string{"-C", sourceRoot}, args...)...)
		if output, err := command.CombinedOutput(); err != nil {
			return fmt.Errorf("source checkout has tracked modifications: %w: %s", err, output)
		}
	}
	untracked, err := gitOutput(sourceRoot, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return err
	}
	if len(untracked) != 0 {
		return errors.New("source checkout contains non-ignored untracked files")
	}
	trackedRaw, err := gitOutput(sourceRoot, "ls-files", "-z")
	if err != nil {
		return err
	}
	tracked := splitNULPaths(trackedRaw)
	sort.Strings(tracked)
	if err := verifyChecksumInventory(
		filepath.Join(packageDir, "source-checksums.sha256"),
		sourceRoot,
		tracked,
	); err != nil {
		return fmt.Errorf("source checksum inventory: %w", err)
	}
	vendorFiles, err := regularTreeFiles(filepath.Join(sourceRoot, "vendor"), sourceRoot)
	if err != nil {
		return err
	}
	if err := verifyChecksumInventory(
		filepath.Join(packageDir, "vendor-checksums.sha256"),
		sourceRoot,
		vendorFiles,
	); err != nil {
		return fmt.Errorf("vendor checksum inventory: %w", err)
	}
	return nil
}

func gitOutput(sourceRoot string, args ...string) ([]byte, error) {
	commandArgs := append([]string{"-C", sourceRoot}, args...)
	output, err := exec.Command("git", commandArgs...).Output()
	if err != nil {
		return nil, fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return output, nil
}

func splitNULPaths(raw []byte) []string {
	if len(raw) == 0 {
		return nil
	}
	parts := bytes.Split(raw, []byte{0})
	if len(parts[len(parts)-1]) == 0 {
		parts = parts[:len(parts)-1]
	}
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		result = append(result, string(part))
	}
	return result
}

func regularTreeFiles(root, relativeTo string) ([]string, error) {
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return nil, err
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("tree root must be a real directory")
	}
	var result []string
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("tree contains symbolic link %q", path)
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("tree contains non-regular file %q", path)
		}
		relative, err := filepath.Rel(relativeTo, path)
		if err != nil {
			return err
		}
		result = append(result, filepath.ToSlash(relative))
		return nil
	})
	sort.Strings(result)
	return result, err
}

func verifyChecksumInventory(manifestPath, sourceRoot string, expectedNames []string) error {
	file, _, err := openRegular(manifestPath)
	if err != nil {
		return err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	var actualNames []string
	for scanner.Scan() {
		line := scanner.Text()
		if len(line) < 67 || line[64:66] != "  " ||
			!lowerSHA256Pattern.MatchString(line[:64]) {
			return errors.New("checksum inventory contains a malformed line")
		}
		name := line[66:]
		if !fs.ValidPath(name) || name == "." {
			return fmt.Errorf("checksum inventory contains unsafe path %q", name)
		}
		dataFile, _, err := openRegular(filepath.Join(sourceRoot, filepath.FromSlash(name)))
		if err != nil {
			return err
		}
		digest := sha256.New()
		_, copyErr := io.Copy(digest, dataFile)
		closeErr := dataFile.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if hex.EncodeToString(digest.Sum(nil)) != line[:64] {
			return fmt.Errorf("checksum mismatch for %q", name)
		}
		actualNames = append(actualNames, name)
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if !slices.Equal(actualNames, expectedNames) {
		return errors.New("checksum inventory does not contain the exact expected ordered file set")
	}
	return nil
}

func readModuleSums(path string) (map[string]string, error) {
	file, _, err := openRegular(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	result := make(map[string]string)
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 3 || strings.HasSuffix(fields[1], "/go.mod") {
			continue
		}
		if !strings.HasPrefix(fields[2], "h1:") {
			continue
		}
		key := fields[0] + "@" + fields[1]
		if existing, duplicate := result[key]; duplicate && existing != fields[2] {
			return nil, fmt.Errorf("go.sum contains conflicting sums for %q", key)
		}
		result[key] = fields[2]
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func vendoredTreeDigest(sourceRoot, modulePath string) (string, error) {
	moduleRoot := filepath.Join(sourceRoot, "vendor", filepath.FromSlash(modulePath))
	paths, err := regularTreeFiles(moduleRoot, moduleRoot)
	if err != nil {
		return "", err
	}
	if len(paths) == 0 {
		return "", errors.New("vendored module tree contains no files")
	}
	digest := sha256.New()
	_, _ = io.WriteString(digest, "proof-tool/vendored-module-tree/v1\x00")
	for _, relative := range paths {
		path := filepath.Join(moduleRoot, filepath.FromSlash(relative))
		file, info, err := openRegular(path)
		if err != nil {
			return "", err
		}
		if _, err := fmt.Fprintf(digest, "%d:%s:%d:", len(relative), relative, info.Size()); err != nil {
			file.Close()
			return "", err
		}
		n, copyErr := io.Copy(digest, file)
		closeErr := file.Close()
		if copyErr != nil {
			return "", copyErr
		}
		if closeErr != nil {
			return "", closeErr
		}
		if n != info.Size() {
			return "", fmt.Errorf("vendored file %q changed while hashing", path)
		}
		_, _ = digest.Write([]byte{0})
	}
	return "sha256:" + hex.EncodeToString(digest.Sum(nil)), nil
}

func gnarkPatchDigests(sourceRoot string) (map[string]string, error) {
	result := make(map[string]string, len(gnarkPatchNames))
	for _, name := range gnarkPatchNames {
		path := filepath.Join(sourceRoot, "experiments", "wasm-prover", "patches", name)
		file, _, err := openRegular(path)
		if err != nil {
			return nil, err
		}
		digest := sha256.New()
		_, copyErr := io.Copy(digest, file)
		closeErr := file.Close()
		if copyErr != nil {
			return nil, copyErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
		result[name] = "sha256:" + hex.EncodeToString(digest.Sum(nil))
	}
	return result, nil
}

func readHexLine(path string, expectedBytes int) ([]byte, error) {
	line, err := readOneLine(path)
	if err != nil {
		return nil, err
	}
	if len(line) != expectedBytes*2 {
		return nil, fmt.Errorf("%s has invalid hexadecimal length", path)
	}
	decoded, err := hex.DecodeString(line)
	if err != nil {
		return nil, err
	}
	return decoded, nil
}

func verifyDigestEntry(dir string, expected digestEntry) error {
	if expected.Filename != filepath.Base(expected.Filename) || expected.SizeBytes <= 0 ||
		!lowerSHA256Pattern.MatchString(expected.SHA256) ||
		!lowerSHA256Pattern.MatchString(expected.Blake2b256) {
		return fmt.Errorf("invalid root-manifest entry %q", expected.Filename)
	}
	path := filepath.Join(dir, expected.Filename)
	file, info, err := openRegular(path)
	if err != nil {
		return err
	}
	defer file.Close()
	sha := sha256.New()
	blake, err := blake2b.New256(nil)
	if err != nil {
		return err
	}
	n, err := io.Copy(io.MultiWriter(sha, blake), file)
	if err != nil {
		return err
	}
	if n != info.Size() || n != expected.SizeBytes ||
		hex.EncodeToString(sha.Sum(nil)) != expected.SHA256 ||
		hex.EncodeToString(blake.Sum(nil)) != expected.Blake2b256 {
		return fmt.Errorf("root-manifest digest mismatch for %q", expected.Filename)
	}
	return nil
}

func readDigestManifest(path string) (digestManifest, error) {
	var value digestManifest
	err := readStrictJSON(path, &value)
	return value, err
}

func readStrictJSON(path string, destination any) error {
	file, _, err := openRegular(path)
	if err != nil {
		return err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("JSON artifact contains trailing data")
	}
	return nil
}

func readOneLine(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if len(data) < 2 || data[len(data)-1] != '\n' || strings.Count(string(data), "\n") != 1 {
		return "", fmt.Errorf("%s must contain exactly one non-empty newline-terminated line", path)
	}
	return strings.TrimSuffix(string(data), "\n"), nil
}

func openRegular(path string) (*os.File, fs.FileInfo, error) {
	linkInfo, err := os.Lstat(path)
	if err != nil {
		return nil, nil, err
	}
	if !linkInfo.Mode().IsRegular() {
		return nil, nil, fmt.Errorf("%s is not a non-symlink regular file", path)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, nil, err
	}
	if !info.Mode().IsRegular() || !os.SameFile(linkInfo, info) {
		file.Close()
		return nil, nil, fmt.Errorf("%s changed while being opened", path)
	}
	return file, info, nil
}

func uniqueSetting(info *debug.BuildInfo, key string) (string, error) {
	var value string
	found := false
	for _, setting := range info.Settings {
		if setting.Key != key {
			continue
		}
		if found {
			return "", fmt.Errorf("binary build setting %q is duplicated", key)
		}
		value = setting.Value
		found = true
	}
	if !found {
		return "", fmt.Errorf("binary build setting %q is absent", key)
	}
	return value, nil
}

func uniqueProperty(properties []property, name string) (string, error) {
	var value string
	found := false
	for _, property := range properties {
		if property.Name != name {
			continue
		}
		if found {
			return "", fmt.Errorf("property %q is duplicated", name)
		}
		value = property.Value
		found = true
	}
	if !found {
		return "", fmt.Errorf("property %q is absent", name)
	}
	return value, nil
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
