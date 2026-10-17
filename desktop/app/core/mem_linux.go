package core

import "os"

// physicalBytes reads MemTotal from /proc/meminfo.
func physicalBytes() (uint64, bool) {
	text, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, false
	}
	return parseMeminfo(string(text))
}
