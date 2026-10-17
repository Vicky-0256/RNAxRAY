//go:build !darwin && !linux

package core

import "os"

// cpuInfo is the processor identifier Windows puts in the environment.
func cpuInfo() (name string, performance, efficiency int) {
	return os.Getenv("PROCESSOR_IDENTIFIER"), 0, 0
}
