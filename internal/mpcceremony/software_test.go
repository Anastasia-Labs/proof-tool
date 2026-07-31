package mpcceremony

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"testing"

	"proof-tool/internal/prover"
)

const testSourceCommit = "0123456789abcdef0123456789abcdef01234567"

func TestRunningSoftwareBindingDerivesExactProcessIdentity(t *testing.T) {
	executable := []byte("exact test ceremony executable")
	source := newTestSoftwareSource(t, executable, testBuildInfo())

	binding, err := runningSoftwareBinding(prover.ProofToolVersion, ModeProduction, source)
	if err != nil {
		t.Fatalf("derive running binding: %v", err)
	}
	if binding.ProofToolVersion != prover.ProofToolVersion {
		t.Fatalf("proof tool version = %q", binding.ProofToolVersion)
	}
	if binding.GnarkVersion != GnarkVersion {
		t.Fatalf("gnark version = %q", binding.GnarkVersion)
	}
	if binding.GnarkCryptoVersion != GnarkCryptoVersion {
		t.Fatalf("gnark-crypto version = %q", binding.GnarkCryptoVersion)
	}
	if binding.DrandVersion != DrandVersion {
		t.Fatalf("drand version = %q", binding.DrandVersion)
	}
	if binding.GoVersion != ProductionGoVersion {
		t.Fatalf("Go version = %q", binding.GoVersion)
	}
	if binding.GoOS != ProductionGOOS ||
		binding.GoArch != ProductionGOARCH ||
		binding.GoAMD64 != ProductionGOAMD64 ||
		binding.Compiler != ProductionCompiler ||
		binding.BuildMode != ProductionBuildMode ||
		binding.CGOEnabled ||
		!binding.TrimPath {
		t.Fatalf("unexpected production build profile: %#v", binding)
	}
	if binding.SourceCommit != testSourceCommit || binding.SourceDirty {
		t.Fatalf("source identity = %q, dirty %t", binding.SourceCommit, binding.SourceDirty)
	}
	if want := NewDigest(executable); binding.ToolBinary != want {
		t.Fatalf("binary digest = %#v, want %#v", binding.ToolBinary, want)
	}
	if err := verifyRunningSoftware(binding, ModeProduction, source); err != nil {
		t.Fatalf("verify exact running binding: %v", err)
	}
}

func TestVerifyRunningSoftwareRejectsEveryBindingMismatch(t *testing.T) {
	source := newTestSoftwareSource(t, []byte("ceremony executable"), testBuildInfo())
	exact, err := runningSoftwareBinding(prover.ProofToolVersion, ModeProduction, source)
	if err != nil {
		t.Fatalf("derive exact binding: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*SoftwareBinding)
	}{
		{
			name: "proof tool version",
			mutate: func(binding *SoftwareBinding) {
				binding.ProofToolVersion = "9.9.9"
			},
		},
		{
			name: "gnark version",
			mutate: func(binding *SoftwareBinding) {
				binding.GnarkVersion = "v0.14.0"
			},
		},
		{
			name: "gnark-crypto version",
			mutate: func(binding *SoftwareBinding) {
				binding.GnarkCryptoVersion = "v0.19.0"
			},
		},
		{
			name: "drand version",
			mutate: func(binding *SoftwareBinding) {
				binding.DrandVersion = "v2.1.5"
			},
		},
		{
			name: "Go version",
			mutate: func(binding *SoftwareBinding) {
				binding.GoVersion = "go-other"
			},
		},
		{
			name: "source commit",
			mutate: func(binding *SoftwareBinding) {
				binding.SourceCommit = strings.Repeat("a", 40)
			},
		},
		{
			name: "dirty source",
			mutate: func(binding *SoftwareBinding) {
				binding.SourceDirty = true
			},
		},
		{
			name: "SHA-256",
			mutate: func(binding *SoftwareBinding) {
				binding.ToolBinary.SHA256 = NewDigest([]byte("other executable")).SHA256
			},
		},
		{
			name: "BLAKE2b-256",
			mutate: func(binding *SoftwareBinding) {
				binding.ToolBinary.Blake2b256 = NewDigest([]byte("other executable")).Blake2b256
			},
		},
		{
			name: "size",
			mutate: func(binding *SoftwareBinding) {
				binding.ToolBinary.Size++
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			changed := exact
			test.mutate(&changed)
			if err := verifyRunningSoftware(changed, ModeProduction, source); err == nil {
				t.Fatal("expected mismatch rejection")
			}
		})
	}
}

func TestRunningSoftwareBindingRejectsUnverifiableBuilds(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*debug.BuildInfo)
	}{
		{
			name: "missing VCS revision",
			mutate: func(info *debug.BuildInfo) {
				info.Settings = append(info.Settings[:1], info.Settings[2:]...)
			},
		},
		{
			name: "duplicate VCS revision",
			mutate: func(info *debug.BuildInfo) {
				info.Settings = append(
					info.Settings,
					debug.BuildSetting{Key: "vcs.revision", Value: testSourceCommit},
				)
			},
		},
		{
			name: "uppercase VCS revision",
			mutate: func(info *debug.BuildInfo) {
				info.Settings[1].Value = strings.ToUpper(testSourceCommit)
			},
		},
		{
			name: "short VCS revision",
			mutate: func(info *debug.BuildInfo) {
				info.Settings[1].Value = testSourceCommit[:39]
			},
		},
		{
			name: "zero VCS revision",
			mutate: func(info *debug.BuildInfo) {
				info.Settings[1].Value = strings.Repeat("0", 40)
			},
		},
		{
			name: "dirty checkout",
			mutate: func(info *debug.BuildInfo) {
				info.Settings[2].Value = "true"
			},
		},
		{
			name: "missing modified flag",
			mutate: func(info *debug.BuildInfo) {
				info.Settings = info.Settings[:2]
			},
		},
		{
			name: "non-Git VCS",
			mutate: func(info *debug.BuildInfo) {
				info.Settings[0].Value = "other"
			},
		},
		{
			name: "wrong gnark version",
			mutate: func(info *debug.BuildInfo) {
				info.Deps[0].Version = "v0.14.0"
			},
		},
		{
			name: "replaced gnark",
			mutate: func(info *debug.BuildInfo) {
				info.Deps[0].Replace = &debug.Module{
					Path:    "../gnark",
					Version: GnarkVersion,
				}
			},
		},
		{
			name: "missing gnark-crypto",
			mutate: func(info *debug.BuildInfo) {
				info.Deps = info.Deps[:1]
			},
		},
		{
			name: "duplicate gnark-crypto",
			mutate: func(info *debug.BuildInfo) {
				info.Deps = append(info.Deps, &debug.Module{
					Path:    gnarkCryptoModulePath,
					Version: GnarkCryptoVersion,
				})
			},
		},
		{
			name: "wrong drand version",
			mutate: func(info *debug.BuildInfo) {
				info.Deps[2].Version = "v2.1.5"
			},
		},
		{
			name: "replaced drand",
			mutate: func(info *debug.BuildInfo) {
				info.Deps[2].Replace = &debug.Module{
					Path:    "../drand",
					Version: DrandVersion,
				}
			},
		},
		{
			name: "missing drand",
			mutate: func(info *debug.BuildInfo) {
				info.Deps = info.Deps[:2]
			},
		},
		{
			name: "duplicate drand",
			mutate: func(info *debug.BuildInfo) {
				info.Deps = append(info.Deps, &debug.Module{
					Path:    drandModulePath,
					Version: DrandVersion,
				})
			},
		},
		{
			name: "linked Go version mismatch",
			mutate: func(info *debug.BuildInfo) {
				info.GoVersion = "go-other-version"
			},
		},
		{
			name: "unapproved Go version",
			mutate: func(info *debug.BuildInfo) {
				info.GoVersion = "go1.26.6"
			},
		},
		{
			name: "wrong operating system",
			mutate: func(info *debug.BuildInfo) {
				setTestBuildSetting(info, "GOOS", "darwin")
			},
		},
		{
			name: "wrong architecture",
			mutate: func(info *debug.BuildInfo) {
				setTestBuildSetting(info, "GOARCH", "arm64")
			},
		},
		{
			name: "wrong amd64 level",
			mutate: func(info *debug.BuildInfo) {
				setTestBuildSetting(info, "GOAMD64", "v3")
			},
		},
		{
			name: "CGO enabled",
			mutate: func(info *debug.BuildInfo) {
				setTestBuildSetting(info, "CGO_ENABLED", "1")
			},
		},
		{
			name: "trimpath disabled",
			mutate: func(info *debug.BuildInfo) {
				setTestBuildSetting(info, "-trimpath", "false")
			},
		},
		{
			name: "wrong compiler",
			mutate: func(info *debug.BuildInfo) {
				setTestBuildSetting(info, "-compiler", "gccgo")
			},
		},
		{
			name: "wrong build mode",
			mutate: func(info *debug.BuildInfo) {
				setTestBuildSetting(info, "-buildmode", "pie")
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			info := testBuildInfo()
			test.mutate(info)
			source := newTestSoftwareSource(t, []byte("ceremony executable"), info)
			if _, err := runningSoftwareBinding(prover.ProofToolVersion, ModeProduction, source); err == nil {
				t.Fatal("expected unverifiable build rejection")
			}
		})
	}
}

func TestRehearsalBindingRecordsAndVerifiesDirtyBuild(t *testing.T) {
	info := testBuildInfo()
	info.Settings[2].Value = "true"
	source := newTestSoftwareSource(t, []byte("dirty rehearsal executable"), info)

	binding, err := runningSoftwareBinding(prover.ProofToolVersion, ModeRehearsal, source)
	if err != nil {
		t.Fatalf("derive rehearsal binding: %v", err)
	}
	if !binding.SourceDirty {
		t.Fatal("dirty rehearsal build was recorded as clean")
	}
	if err := verifyRunningSoftware(binding, ModeRehearsal, source); err != nil {
		t.Fatalf("verify dirty rehearsal binding: %v", err)
	}

	claimedClean := binding
	claimedClean.SourceDirty = false
	if err := verifyRunningSoftware(claimedClean, ModeRehearsal, source); err == nil {
		t.Fatal("dirty rehearsal build matched a clean software claim")
	}
	if _, err := runningSoftwareBinding(prover.ProofToolVersion, ModeProduction, source); err == nil {
		t.Fatal("dirty build was accepted for production")
	}
}

func TestRunningSoftwareBindingRejectsWrongCompiledVersionAndBadExecutable(t *testing.T) {
	source := newTestSoftwareSource(t, []byte("ceremony executable"), testBuildInfo())
	if _, err := runningSoftwareBinding(prover.ProofToolVersion, "unknown", source); err == nil {
		t.Fatal("expected ceremony mode rejection")
	}
	if _, err := runningSoftwareBinding("operator-supplied", ModeProduction, source); err == nil {
		t.Fatal("expected proof tool version rejection")
	}

	source.executable = func() (string, error) {
		return "", errors.New("unavailable")
	}
	if _, err := runningSoftwareBinding(prover.ProofToolVersion, ModeProduction, source); err == nil {
		t.Fatal("expected executable resolution rejection")
	}

	emptyPath := filepath.Join(t.TempDir(), "empty")
	if err := os.WriteFile(emptyPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	source.executable = func() (string, error) {
		return emptyPath, nil
	}
	if _, err := runningSoftwareBinding(prover.ProofToolVersion, ModeProduction, source); err == nil {
		t.Fatal("expected empty executable rejection")
	}
}

func TestProductionExecutableIdentityUsesKernelHeldLinuxImage(t *testing.T) {
	if runtime.GOOS != ProductionGOOS {
		t.Skip("production executable identity is Linux-only")
	}
	path, err := productionExecutablePath()
	if err != nil {
		t.Fatal(err)
	}
	if path != "/proc/self/exe" {
		t.Fatalf("production executable path = %q", path)
	}

	original := []byte("original executable image")
	replacement := []byte("same-uid path replacement")
	directory := t.TempDir()
	diskPath := filepath.Join(directory, "mpc-ceremony")
	if err := os.WriteFile(diskPath, original, 0o700); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(diskPath)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := os.Rename(diskPath, diskPath+".old"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(diskPath, replacement, 0o700); err != nil {
		t.Fatal(err)
	}
	kernelHeldPath := "/proc/self/fd/" + strconv.FormatUint(uint64(file.Fd()), 10)
	actual, err := digestRunningExecutable(kernelHeldPath)
	if err != nil {
		t.Fatal(err)
	}
	if expected := NewDigest(original); actual != expected {
		t.Fatalf("kernel-held executable digest = %#v, want original %#v", actual, expected)
	}
	if actual == NewDigest(replacement) {
		t.Fatal("kernel-held executable digest followed the replaced pathname")
	}
}

func testBuildInfo() *debug.BuildInfo {
	return &debug.BuildInfo{
		GoVersion: ProductionGoVersion,
		Settings: []debug.BuildSetting{
			{Key: "vcs", Value: "git"},
			{Key: "vcs.revision", Value: testSourceCommit},
			{Key: "vcs.modified", Value: "false"},
			{Key: "-buildmode", Value: ProductionBuildMode},
			{Key: "-compiler", Value: ProductionCompiler},
			{Key: "-trimpath", Value: "true"},
			{Key: "CGO_ENABLED", Value: "0"},
			{Key: "GOARCH", Value: ProductionGOARCH},
			{Key: "GOOS", Value: ProductionGOOS},
			{Key: "GOAMD64", Value: ProductionGOAMD64},
		},
		Deps: []*debug.Module{
			{
				Path:    gnarkModulePath,
				Version: GnarkVersion,
			},
			{
				Path:    gnarkCryptoModulePath,
				Version: GnarkCryptoVersion,
			},
			{
				Path:    drandModulePath,
				Version: DrandVersion,
			},
		},
	}
}

func newTestSoftwareSource(
	t *testing.T,
	executable []byte,
	info *debug.BuildInfo,
) runningSoftwareSource {
	t.Helper()
	executablePath := filepath.Join(t.TempDir(), "mpc-ceremony")
	if err := os.WriteFile(executablePath, executable, 0o700); err != nil {
		t.Fatalf("write test executable: %v", err)
	}
	return runningSoftwareSource{
		executable: func() (string, error) {
			return executablePath, nil
		},
		readBuildInfo: func() (*debug.BuildInfo, bool) {
			return info, true
		},
		runtimeVersion: func() string {
			return info.GoVersion
		},
	}
}

func setTestBuildSetting(info *debug.BuildInfo, key, value string) {
	for index := range info.Settings {
		if info.Settings[index].Key == key {
			info.Settings[index].Value = value
			return
		}
	}
	info.Settings = append(info.Settings, debug.BuildSetting{Key: key, Value: value})
}
