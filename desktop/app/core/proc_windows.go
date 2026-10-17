//go:build windows

package core

import (
	"os/exec"
	"syscall"
)

// hideWindow keeps console children from flashing a window (CREATE_NO_WINDOW).
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}
}
