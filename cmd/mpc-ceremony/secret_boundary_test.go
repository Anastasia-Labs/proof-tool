package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestProductionCeremonySourceAndBinaryExcludeWalletSecretAPIs(t *testing.T) {
	root := filepath.Clean(filepath.Join("..", ".."))
	forbiddenSource := []string{
		"DecodeMasterXPrvHex",
		"DiscoverCredentialPath",
		"ownershipdest.Assignment",
		"prover.Prove(",
		"--master-xprv",
		"--seed-phrase",
		"c065afd2832cd8b087c4d9ab7011f481",
	}
	for _, relativeRoot := range []string{"cmd/mpc-ceremony", "internal/mpcceremony"} {
		err := filepath.WalkDir(filepath.Join(root, relativeRoot), func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			for _, forbidden := range forbiddenSource {
				if bytes.Contains(data, []byte(forbidden)) {
					t.Errorf("production ceremony source %s contains forbidden wallet-secret API/literal %q", path, forbidden)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	binary := filepath.Join(t.TempDir(), "mpc-ceremony")
	build := exec.Command("go", "build", "-mod=vendor", "-trimpath", "-o", binary, "./cmd/mpc-ceremony")
	build.Dir = root
	build.Env = append(os.Environ(), "GOWORK=off")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build production ceremony binary: %v\n%s", err, output)
	}
	nm := exec.Command("go", "tool", "nm", binary)
	symbols, err := nm.CombinedOutput()
	if err != nil {
		t.Fatalf("inspect production ceremony symbols: %v\n%s", err, symbols)
	}
	for _, forbidden := range []string{
		"ownership.DecodeMasterXPrvHex",
		"ownership.DiscoverCredentialPath",
		"ownershipdest.Assignment",
		"prover.Prove",
	} {
		if bytes.Contains(symbols, []byte(forbidden)) {
			t.Errorf("production ceremony binary retains forbidden wallet-secret symbol %q", forbidden)
		}
	}
	binaryBytes, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{
		"--master-xprv",
		"--seed-phrase",
		"c065afd2832cd8b087c4d9ab7011f481",
	} {
		if bytes.Contains(binaryBytes, []byte(forbidden)) {
			t.Errorf("production ceremony binary contains forbidden wallet-secret literal %q", forbidden)
		}
	}
}
