package core

import "math"

// CPLfold memory model, the same as desktop/runtime/detector.py
// (cplfold_memory_estimate): base + c * n^2 bytes, c per structure mode.
const (
	cplfoldBaseBytes        = 192 * 1024 * 1024
	cplfoldBytesPerNt2Free  = 144.0
	cplfoldBytesPerNt2Knots = 196.0
)

// CPLfoldMemoryMB is the estimated peak memory of one fold of length nt,
// rounded up to MiB.
func CPLfoldMemoryMB(length int, allowPseudoknot bool) uint64 {
	c := cplfoldBytesPerNt2Free
	if allowPseudoknot {
		c = cplfoldBytesPerNt2Knots
	}
	bytes := cplfoldBaseBytes + c*float64(length)*float64(length)
	return uint64(math.Ceil(bytes / (1024 * 1024)))
}

// StructureClaimMB is the memory a structure task should claim: the
// estimate for its longest window times the folds that can run at once
// (workers, at most one per window), and at least the default 4096 MiB.
func StructureClaimMB(longest int, allowPseudoknot bool, parallel int) uint64 {
	need := CPLfoldMemoryMB(longest, allowPseudoknot) * uint64(max(parallel, 1))
	return max(need, 4096)
}

// CPLfoldMaxNT is the longest RNA one fold may have within budgetMB of
// memory: detector.py _max_length_for, the limit the runtime enforces
// (cplfold_limits). 0 when the budget is unknown or below the base.
func CPLfoldMaxNT(budgetMB uint64, allowPseudoknot bool) int {
	c := cplfoldBytesPerNt2Free
	if allowPseudoknot {
		c = cplfoldBytesPerNt2Knots
	}
	room := float64(budgetMB)*1024*1024 - cplfoldBaseBytes
	if room <= 0 {
		return 0
	}
	return int(math.Sqrt(room / c))
}
