package core

import (
	"encoding/binary"
	"strings"
	"syscall"
)

// cpuInfo is the processor name and, on Apple silicon, its performance and
// efficiency core counts (0 when unknown).
func cpuInfo() (name string, performance, efficiency int) {
	if raw, err := syscall.Sysctl("machdep.cpu.brand_string"); err == nil {
		name = strings.TrimSpace(raw)
	}
	return name, sysctlInt("hw.perflevel0.physicalcpu"), sysctlInt("hw.perflevel1.physicalcpu")
}

// sysctlInt reads a 32-bit sysctl (see physicalBytes for the lost NUL).
func sysctlInt(key string) int {
	raw, err := syscall.Sysctl(key)
	if err != nil || len(raw) > 4 {
		return 0
	}
	buf := []byte(raw)
	for len(buf) < 4 {
		buf = append(buf, 0)
	}
	return int(binary.LittleEndian.Uint32(buf))
}
