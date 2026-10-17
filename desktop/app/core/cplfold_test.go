package core

import "testing"

// Values from detector.cplfold_memory_estimate (bytes / 2^20).
func TestCPLfoldMemoryMatchesDetector(t *testing.T) {
	for _, tc := range []struct {
		n    int
		pk   bool
		want float64
	}{
		{3000, false, 1427.9619140625}, {5331, false, 4094.832778930664},
		{10807, false, 16230.837295532227}, {10807, true, 22022.639652252197},
	} {
		got := CPLfoldMemoryMB(tc.n, tc.pk)
		if float64(got) < tc.want || float64(got)-tc.want >= 1 {
			t.Fatalf("%d nt pk=%v: %d MiB, detector %.2f", tc.n, tc.pk, got, tc.want)
		}
	}
	if StructureClaimMB(300, true, 4) != 4096 {
		t.Fatal("small windows keep the default claim")
	}
	if got := StructureClaimMB(10807, false, 1); got != 16231 {
		t.Fatalf("genome claim %d", got)
	}
	// detector.cplfold_limits(24 GiB): testdata/structure_read.json limits
	if got := CPLfoldMaxNT(24576, false); got != 13325 {
		t.Fatalf("pseudoknot-free limit %d", got)
	}
	if got := CPLfoldMaxNT(24576, true); got != 11421 {
		t.Fatalf("pseudoknot limit %d", got)
	}
	if CPLfoldMaxNT(0, false) != 0 || CPLfoldMaxNT(100, false) != 0 {
		t.Fatal("no limit without a budget")
	}
}
