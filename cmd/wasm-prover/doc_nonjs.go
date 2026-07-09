//go:build !js || !wasm

package main

import (
	"fmt"
	"os"
)

// The wasm-prover command is built only with GOOS=js GOARCH=wasm. This stub
// lets native `go build ./...` and `go test ./cmd/wasm-prover/...` include the
// package without trying to compile syscall/js.
func main() {
	fmt.Fprintln(os.Stderr, "wasm-prover must be built with GOOS=js GOARCH=wasm (see scripts/build-wasm-prover.sh)")
	os.Exit(2)
}
