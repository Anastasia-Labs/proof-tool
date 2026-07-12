//go:build js && wasm

package streamprove

import "syscall/js"

// yieldToEventLoop parks the Go goroutine until a zero-delay JS timer fires.
// time.Sleep(0) and runtime.Gosched do not let browser message/timer callbacks
// run while a long wasm call owns the JS stack.
func yieldToEventLoop() {
	done := make(chan struct{}, 1)
	var callback js.Func
	callback = js.FuncOf(func(js.Value, []js.Value) any {
		done <- struct{}{}
		return nil
	})
	js.Global().Call("setTimeout", callback, 0)
	<-done
	callback.Release()
}
