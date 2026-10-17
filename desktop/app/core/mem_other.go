//go:build !darwin && !linux && !windows

package core

func physicalBytes() (uint64, bool) { return 0, false }
