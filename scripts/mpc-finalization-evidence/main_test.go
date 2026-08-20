package main

import (
	"bytes"
	"encoding/hex"
	"strings"
	"testing"

	gnarklogger "github.com/consensys/gnark/logger"
	"github.com/rs/zerolog"

	"proof-tool/internal/circuit/ownership"
	"proof-tool/internal/mpcceremony"
)

func TestConfigureLibraryLoggingKeepsDiagnosticsOffStdout(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	gnarklogger.Set(zerolog.New(&stdout))
	t.Cleanup(gnarklogger.Disable)

	configureLibraryLogging(&stderr)
	diagnosticLogger := gnarklogger.Logger()
	diagnosticLogger.Debug().Msg("gnark diagnostic")

	if stdout.Len() != 0 {
		t.Fatalf("gnark wrote %q to stdout", stdout.String())
	}
	if !strings.Contains(stderr.String(), "gnark diagnostic") {
		t.Fatalf("gnark diagnostic missing from stderr: %q", stderr.String())
	}
}

func TestGoldenPublicPathDerivesPinnedCredential(t *testing.T) {
	master, err := ownership.DecodeMasterXPrvHex(
		"c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245" +
			"d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a" +
			"23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620",
	)
	if err != nil {
		t.Fatal(err)
	}
	credential, err := ownership.DeriveCredential(master, goldenPublicPath())
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(credential[:]); got != mpcceremony.GoldenPublicCredentialHex {
		t.Fatalf("golden path credential = %s, want %s", got, mpcceremony.GoldenPublicCredentialHex)
	}
}
