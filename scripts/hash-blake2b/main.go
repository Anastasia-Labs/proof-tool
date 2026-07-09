// Command hash-blake2b emits build-manifest JSON for a list of files: for each
// file its basename, size in bytes, and sha256/blake2b256 digests (plain hex).
// It exists for scripts/build-wasm-prover.sh, which needs blake2b-256 without
// depending on host tooling; digests come from internal/proofassets so they
// match the hashes used across the proof-asset pipeline.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"proof-tool/internal/proofassets"
)

type fileEntry struct {
	Filename   string `json:"filename"`
	SizeBytes  int64  `json:"size_bytes"`
	SHA256     string `json:"sha256"`
	Blake2b256 string `json:"blake2b256"`
}

type manifest struct {
	GoVersion  string      `json:"go_version,omitempty"`
	BuildFlags []string    `json:"build_flags,omitempty"`
	Files      []fileEntry `json:"files"`
}

func main() {
	goVersion := flag.String("go-version", "", "go version string to record in the manifest")
	buildFlags := flag.String("build-flags", "", "space-separated build flags to record in the manifest")
	flag.Parse()
	if flag.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: hash-blake2b [-go-version V] [-build-flags F] <file>...")
		os.Exit(2)
	}

	m := manifest{GoVersion: *goVersion, Files: make([]fileEntry, 0, flag.NArg())}
	if *buildFlags != "" {
		m.BuildFlags = strings.Fields(*buildFlags)
	}
	for _, path := range flag.Args() {
		digest, err := proofassets.DigestFile(path)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		m.Files = append(m.Files, fileEntry{
			Filename:   filepath.Base(path),
			SizeBytes:  digest.Size,
			SHA256:     strings.TrimPrefix(digest.SHA256, "sha256:"),
			Blake2b256: strings.TrimPrefix(digest.Blake2b256, "blake2b256:"),
		})
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(m); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
