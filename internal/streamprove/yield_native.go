//go:build !js || !wasm

package streamprove

import "runtime"

func yieldToEventLoop() { runtime.Gosched() }
