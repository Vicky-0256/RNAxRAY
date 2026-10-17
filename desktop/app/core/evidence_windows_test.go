//go:build windows

package core

import (
	"os"
	"testing"
	"time"
)

// waitGone waits until pid has exited (taskkill /T ended the tree).
func waitGone(t *testing.T, pid int) {
	t.Helper()
	for range 100 {
		p, err := os.FindProcess(pid)
		if err != nil {
			return
		}
		_ = p.Release()
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatalf("process %d is still alive", pid)
}
