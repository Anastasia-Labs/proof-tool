// Command generate-go-sbom emits a deterministic CycloneDX 1.5 SBOM from the
// Go build information embedded in an already-built executable. It performs no
// network access and records the exact linked module versions and module sums.
package main

import (
	"bufio"
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
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"
)

var gnarkPatchPaths = []string{
	"experiments/wasm-prover/patches/prove-stream.patch",
	"experiments/wasm-prover/patches/domain-read-no-precompute.patch",
	"experiments/wasm-prover/patches/release-ccs-after-solve.patch",
	"experiments/wasm-prover/patches/dispatch-before-fft.patch",
	"experiments/wasm-prover/patches/computeh-scoped-coset-tables.patch",
	"experiments/wasm-prover/patches/uints-constant-fold.patch",
	"experiments/wasm-prover/patches/computeh-parallel-transforms.patch",
	"experiments/wasm-prover/patches/mpc-phase1-parallel-update.patch",
	"experiments/wasm-prover/patches/mpc-phase1-parallel-codec.patch",
	"experiments/wasm-prover/patches/mpc-phase2-parallel-initialize.patch",
}

type bom struct {
	BOMFormat   string      `json:"bomFormat"`
	SpecVersion string      `json:"specVersion"`
	Version     int         `json:"version"`
	Metadata    metadata    `json:"metadata"`
	Components  []component `json:"components"`
}

type metadata struct {
	Tools      tools      `json:"tools"`
	Component  component  `json:"component"`
	Properties []property `json:"properties"`
}

type tools struct {
	Components []component `json:"components"`
}

type component struct {
	Type       string     `json:"type"`
	Group      string     `json:"group,omitempty"`
	Name       string     `json:"name"`
	Version    string     `json:"version,omitempty"`
	BOMRef     string     `json:"bom-ref,omitempty"`
	PURL       string     `json:"purl,omitempty"`
	Hashes     []hash     `json:"hashes,omitempty"`
	Properties []property `json:"properties,omitempty"`
}

type hash struct {
	Algorithm string `json:"alg"`
	Content   string `json:"content"`
}

type property struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

func main() {
	binaryPath := flag.String("binary", "", "path to the built Go executable")
	componentName := flag.String("name", "mpc-ceremony", "application component name")
	sourceRoot := flag.String("source-root", "", "exact source root containing go.sum, vendor, and reviewed patches")
	flag.Parse()
	if *binaryPath == "" || *sourceRoot == "" || flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "usage: generate-go-sbom --binary FILE --source-root DIR [--name NAME]")
		os.Exit(2)
	}
	sourceInfo, err := os.Lstat(*sourceRoot)
	if err != nil || !sourceInfo.IsDir() || sourceInfo.Mode()&os.ModeSymlink != 0 {
		fatal(errors.New("source root must be a real directory"))
	}
	moduleSums, err := readModuleSums(filepath.Join(*sourceRoot, "go.sum"))
	if err != nil {
		fatal(err)
	}
	gnarkPatchProperties, err := patchProperties(*sourceRoot)
	if err != nil {
		fatal(err)
	}

	info, err := buildinfo.ReadFile(*binaryPath)
	if err != nil {
		fatal(err)
	}
	revision, err := uniqueSetting(info.Settings, "vcs.revision")
	if err != nil {
		fatal(err)
	}
	modified, err := uniqueSetting(info.Settings, "vcs.modified")
	if err != nil {
		fatal(err)
	}
	if modified != "false" {
		fatal(fmt.Errorf("vcs.modified is %q, want false", modified))
	}
	if len(revision) != 40 {
		fatal(errors.New("vcs.revision is not an exact 40-character commit"))
	}

	components := make([]component, 0, len(info.Deps))
	seen := make(map[string]struct{}, len(info.Deps))
	for _, dependency := range info.Deps {
		if dependency == nil {
			fatal(errors.New("build information contains a nil dependency"))
		}
		module := dependency
		properties := make([]property, 0, 2)
		if dependency.Replace != nil {
			module = dependency.Replace
			properties = append(properties, property{
				Name:  "proof-tool:golang:replaces",
				Value: dependency.Path + "@" + dependency.Version,
			})
		}
		if module.Path == "" || module.Version == "" {
			fatal(fmt.Errorf("dependency %q has an incomplete module identity", dependency.Path))
		}
		key := module.Path + "@" + module.Version
		if _, duplicate := seen[key]; duplicate {
			fatal(fmt.Errorf("duplicate linked dependency %q", key))
		}
		seen[key] = struct{}{}
		upstreamSum, ok := moduleSums[key]
		if !ok {
			fatal(fmt.Errorf("linked dependency %q has no exact module content sum in go.sum", key))
		}
		if module.Sum != "" && module.Sum != upstreamSum {
			fatal(fmt.Errorf("linked dependency %q build-info sum differs from go.sum", key))
		}
		properties = append(properties, property{
			Name:  "proof-tool:golang:module-sum",
			Value: upstreamSum,
		})
		vendoredDigest, err := vendoredTreeDigest(*sourceRoot, module.Path)
		if err != nil {
			fatal(fmt.Errorf("linked dependency %q vendored tree: %w", key, err))
		}
		properties = append(properties, property{
			Name:  "proof-tool:golang:vendored-tree-sha256",
			Value: vendoredDigest,
		})
		if module.Path == "github.com/consensys/gnark" {
			properties = append(properties, gnarkPatchProperties...)
		}
		components = append(components, component{
			Type:       "library",
			Name:       module.Path,
			Version:    module.Version,
			BOMRef:     "pkg:golang/" + module.Path + "@" + module.Version,
			PURL:       "pkg:golang/" + module.Path + "@" + module.Version,
			Hashes:     moduleHashes(upstreamSum),
			Properties: properties,
		})
	}
	sort.Slice(components, func(i, j int) bool {
		if components[i].Name == components[j].Name {
			return components[i].Version < components[j].Version
		}
		return components[i].Name < components[j].Name
	})

	result := bom{
		BOMFormat:   "CycloneDX",
		SpecVersion: "1.5",
		Version:     1,
		Metadata: metadata{
			Tools: tools{Components: []component{{
				Type:    "application",
				Name:    "proof-tool/scripts/generate-go-sbom",
				Version: revision,
			}}},
			Component: component{
				Type:    "application",
				Name:    *componentName,
				Version: revision,
				BOMRef:  "pkg:golang/proof-tool/" + *componentName + "@" + revision,
				PURL:    "pkg:golang/proof-tool/" + *componentName + "@" + revision,
			},
			Properties: []property{
				{Name: "proof-tool:go-version", Value: info.GoVersion},
				{Name: "proof-tool:source-commit", Value: revision},
				{Name: "proof-tool:vcs-modified", Value: modified},
			},
		},
		Components: components,
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(result); err != nil {
		fatal(err)
	}
}

func uniqueSetting(settings []debug.BuildSetting, key string) (string, error) {
	var value string
	found := false
	for _, setting := range settings {
		if setting.Key != key {
			continue
		}
		if found {
			return "", fmt.Errorf("build setting %q is duplicated", key)
		}
		value = setting.Value
		found = true
	}
	if !found || strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("build setting %q is missing", key)
	}
	return value, nil
}

func moduleHashes(sum string) []hash {
	if !strings.HasPrefix(sum, "h1:") {
		return nil
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(sum, "h1:"))
	if err != nil || len(decoded) != sha256.Size {
		fatal(fmt.Errorf("invalid Go module sum %q", sum))
	}
	return []hash{{
		Algorithm: "SHA-256",
		Content:   hex.EncodeToString(decoded),
	}}
}

func readModuleSums(path string) (map[string]string, error) {
	file, err := os.Open(path)
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
		if existing, ok := result[key]; ok && existing != fields[2] {
			return nil, fmt.Errorf("go.sum has conflicting content sums for %q", key)
		}
		result[key] = fields[2]
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if len(result) == 0 {
		return nil, errors.New("go.sum contains no module content sums")
	}
	return result, nil
}

func vendoredTreeDigest(sourceRoot, modulePath string) (string, error) {
	moduleRoot := filepath.Join(sourceRoot, "vendor", filepath.FromSlash(modulePath))
	rootInfo, err := os.Lstat(moduleRoot)
	if err != nil {
		return "", err
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("vendored module root is not a real directory")
	}
	var paths []string
	err = filepath.WalkDir(moduleRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == moduleRoot {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("vendored module contains symbolic link %q", path)
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("vendored module contains non-regular file %q", path)
		}
		paths = append(paths, path)
		return nil
	})
	if err != nil {
		return "", err
	}
	if len(paths) == 0 {
		return "", errors.New("vendored module tree contains no files")
	}
	sort.Strings(paths)
	digest := sha256.New()
	_, _ = io.WriteString(digest, "proof-tool/vendored-module-tree/v1\x00")
	for _, path := range paths {
		relative, err := filepath.Rel(moduleRoot, path)
		if err != nil {
			return "", err
		}
		relative = filepath.ToSlash(relative)
		info, err := os.Lstat(path)
		if err != nil {
			return "", err
		}
		if !info.Mode().IsRegular() {
			return "", fmt.Errorf("vendored module file %q changed type", path)
		}
		if _, err := fmt.Fprintf(digest, "%d:%s:%d:", len(relative), relative, info.Size()); err != nil {
			return "", err
		}
		file, err := os.Open(path)
		if err != nil {
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
			return "", fmt.Errorf("vendored module file %q changed size", path)
		}
		_, _ = digest.Write([]byte{0})
	}
	return "sha256:" + hex.EncodeToString(digest.Sum(nil)), nil
}

func patchProperties(sourceRoot string) ([]property, error) {
	result := make([]property, 0, len(gnarkPatchPaths))
	for _, relative := range gnarkPatchPaths {
		path := filepath.Join(sourceRoot, filepath.FromSlash(relative))
		info, err := os.Lstat(path)
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Size() <= 0 {
			return nil, fmt.Errorf("reviewed patch %q is not a non-empty regular file", relative)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(data)
		result = append(result, property{
			Name:  "proof-tool:vendored-patch:" + filepath.Base(relative) + ":sha256",
			Value: "sha256:" + hex.EncodeToString(sum[:]),
		})
	}
	return result, nil
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
