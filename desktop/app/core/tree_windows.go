//go:build windows

package core

import (
	"bytes"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// newProcessGroup starts the task child in its own process group without a
// console window (CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW).
func newProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200 | 0x08000000}
}

// killTree ends the child and all its descendants with `taskkill /T /F`.
func killTree(pid int) error {
	cmd := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F")
	hideWindow(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return fmt.Errorf("could not cancel process tree: %s", detail)
	}
	return nil
}
