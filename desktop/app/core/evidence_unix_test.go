//go:build !windows

package core

import (
	"errors"
	"syscall"
	"testing"
	"time"
)

// waitGone waits until no process has pid (the worker and its fake MCP
// child after a timeout or cancel).
func waitGone(t *testing.T, pid int) {
	t.Helper()
	for range 100 {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatalf("process %d is still alive", pid)
}
