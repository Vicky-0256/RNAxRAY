package core

import (
	"syscall"
	"unsafe"
)

// memoryStatusEx is MEMORYSTATUSEX.
type memoryStatusEx struct {
	length               uint32
	memoryLoad           uint32
	totalPhys            uint64
	availPhys            uint64
	totalPageFile        uint64
	availPageFile        uint64
	totalVirtual         uint64
	availVirtual         uint64
	availExtendedVirtual uint64
}

var procGlobalMemoryStatusEx = syscall.NewLazyDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx")

// physicalBytes calls GlobalMemoryStatusEx.
func physicalBytes() (uint64, bool) {
	status := memoryStatusEx{}
	status.length = uint32(unsafe.Sizeof(status))
	if procGlobalMemoryStatusEx.Find() != nil {
		return 0, false
	}
	ok, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&status)))
	return status.totalPhys, ok != 0
}
