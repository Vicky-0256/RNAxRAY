package seqmap

import (
	"math/rand"
	"os"
	"strings"
	"testing"
)

func randomRNA(r *rand.Rand, n int) string {
	var b strings.Builder
	for range n {
		b.WriteByte("ACGU"[r.Intn(4)])
	}
	return b.String()
}

func TestAlignIdentical(t *testing.T) {
	m, err := Align("ACGTACGT", "acguacgu")
	if err != nil || !m.Same || m.Pos(1) != 1 || m.Pos(8) != 8 || m.Pos(9) != 0 {
		t.Fatalf("%+v %v", m, err)
	}
}

func TestAlignIndelsAndMismatches(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	to := randomRNA(r, 5000)
	// from: delete to[1000] (1-based 1001), insert "GG" after to position 3000, one mismatch at 4000
	from := to[:1000] + to[1001:3000] + "GG" + to[3000:]
	b := []byte(from)
	k := 3999 - 1 + 2 // to position 4000 (1-based) in from coordinates: 4000 - 1 + 2
	if b[k] == 'A' {
		b[k] = 'C'
	} else {
		b[k] = 'A'
	}
	from = string(b)
	m, err := Align(from, to)
	if err != nil {
		t.Fatal(err)
	}
	cases := map[int]int{1: 1, 1000: 1000, 1001: 1002, 2999: 3000, 3000: 0, 3001: 0, 3002: 3001, 4001: 4000, len(from): len(to)}
	for i, want := range cases {
		if got := m.Pos(i); got != want {
			t.Fatalf("from %d -> %d, want %d", i, got, want)
		}
	}
	if m.Gaps != 3 || m.Mismatches != 1 {
		t.Fatalf("gaps %d mismatches %d", m.Gaps, m.Mismatches)
	}
	if m.Nearest(3000, 5) == 0 {
		t.Fatal("nearest should find an aligned neighbour")
	}
}

func readFasta(t *testing.T, path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skip("reference not available: " + path)
	}
	var b strings.Builder
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.HasPrefix(line, ">") {
			b.WriteString(strings.TrimSpace(line))
		}
	}
	return b.String()
}

// The ZIKV references of the reproduction: ZILM position i is ZAFR i-1
// after the 1-nt indel near 72.
func TestAlignZIKV(t *testing.T) {
	dir := os.Getenv("RNAXRAY_ZIKV_FASTA_DIR")
	if dir == "" {
		dir = "../../../../zika_files"
	}
	zafr, zilm := readFasta(t, dir+"/ZAFR.fasta"), readFasta(t, dir+"/ZILM.fasta")
	m, err := Align(zilm, zafr)
	if err != nil {
		t.Fatal(err)
	}
	for _, i := range []int{100, 1000, 5000, 10000} {
		if got := m.Pos(i); got != i-1 {
			t.Fatalf("ZILM %d -> ZAFR %d, want %d", i, got, i-1)
		}
	}
	if m.Pos(50) != 50 {
		t.Fatalf("ZILM 50 -> %d", m.Pos(50))
	}
	t.Logf("identity %.3f, %d mismatches, %d gap columns", m.Identity, m.Mismatches, m.Gaps)
}
