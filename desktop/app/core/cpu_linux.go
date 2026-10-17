package core

import (
	"os"
	"strings"
)

// cpuInfo is the processor name from /proc/cpuinfo; Linux does not tell
// performance from efficiency cores here.
func cpuInfo() (name string, performance, efficiency int) {
	text, err := os.ReadFile("/proc/cpuinfo")
	if err != nil {
		return "", 0, 0
	}
	for _, line := range strings.Split(string(text), "\n") {
		if key, value, ok := strings.Cut(line, ":"); ok && strings.TrimSpace(key) == "model name" {
			return strings.TrimSpace(value), 0, 0
		}
	}
	return "", 0, 0
}
