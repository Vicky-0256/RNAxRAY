package core

import (
	"encoding/binary"
	"syscall"
)

// physicalBytes reads sysctl hw.memsize (a little-endian uint64).
func physicalBytes() (uint64, bool) {
	raw, err := syscall.Sysctl("hw.memsize")
	if err != nil {
		return 0, false
	}
	// syscall.Sysctl drops one trailing NUL byte, which for an integer is
	// its (zero) most significant byte; pad it back.
	buf := []byte(raw)
	if len(buf) > 8 {
		return 0, false
	}
	for len(buf) < 8 {
		buf = append(buf, 0)
	}
	return binary.LittleEndian.Uint64(buf), true
}
