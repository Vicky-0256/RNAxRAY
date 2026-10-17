// Package seqmap maps positions of one RNA sequence onto a related one
// (another strain's reference, or the sequence an annotation was made on)
// by a banded global alignment.
//
// The two references of a comparison are usually collinear with a few
// indels (ZIKV African KX377335 vs French Polynesian KJ776791: one 1-nt
// indel at 72), so a band of |len(a) - len(b)| + Band around the diagonal
// holds the optimal path.
package seqmap

import (
	"errors"
	"strings"
)

// Band is the extra half-width of the alignment band (nt).
const Band = 300

// MaxLength caps the sequences aligned (the traceback is length x band).
const MaxLength = 400_000

// Scores of the global alignment (linear gaps).
const (
	match    = 2
	mismatch = -1
	gap      = -3
)

// Map is the alignment of From onto To.
type Map struct {
	// To[i] is the 1-based position in To aligned to position i+1 of From,
	// 0 when it faces a gap.
	To []int32
	// Identity is the fraction of aligned columns with the same base.
	Identity float64
	// Matches, Mismatches and Gaps count the alignment columns.
	Matches, Mismatches, Gaps int
	// Same is true when the sequences are identical (To is the identity).
	Same bool
}

// Pos maps a 1-based position of From; 0 when it is unaligned or out of range.
func (m *Map) Pos(i int) int {
	if m == nil || i < 1 || i > len(m.To) {
		return 0
	}
	return int(m.To[i-1])
}

// Nearest maps a position to the closest aligned one within reach nt (for
// window ends that fall in a gap); 0 when none.
func (m *Map) Nearest(i, reach int) int {
	for d := 0; d <= reach; d++ {
		if p := m.Pos(i - d); p > 0 {
			return p + d
		}
		if p := m.Pos(i + d); p > 0 {
			return max(1, p-d)
		}
	}
	return 0
}

func normalise(s string) string {
	return strings.ReplaceAll(strings.ToUpper(s), "T", "U")
}

// Align maps from onto to.
func Align(from, to string) (*Map, error) {
	a, b := normalise(from), normalise(to)
	n, m := len(a), len(b)
	if n == 0 || m == 0 {
		return nil, errors.New("empty sequence")
	}
	if a == b {
		out := &Map{To: make([]int32, n), Same: true, Identity: 1, Matches: n}
		for i := range out.To {
			out.To[i] = int32(i + 1)
		}
		return out, nil
	}
	if n > MaxLength || m > MaxLength {
		return nil, errors.New("sequences longer than 400,000 nt are not aligned")
	}
	w := Band + abs(n-m)
	// Row i (0..n) holds columns j in [lo(i), hi(i)], j = i*m/n +- w.
	lo := func(i int) int { return max(0, i*m/n-w) }
	hi := func(i int) int { return min(m, i*m/n+w) }
	const negInf = -1 << 30
	width := 2*w + 2
	prev := make([]int32, width)
	cur := make([]int32, width)
	// trace: 0 diagonal, 1 up (gap in to), 2 left (gap in from)
	trace := make([]byte, (n+1)*width)
	get := func(row []int32, i, j int) int32 {
		k := j - lo(i)
		if j < lo(i) || j > hi(i) || k >= width {
			return negInf
		}
		return row[k]
	}
	for j := lo(0); j <= hi(0); j++ {
		prev[j-lo(0)] = int32(j * gap)
		trace[j-lo(0)] = 2
	}
	for i := 1; i <= n; i++ {
		l, h := lo(i), hi(i)
		for k := range cur {
			cur[k] = negInf
		}
		for j := l; j <= h; j++ {
			k := j - l
			best, dir := int32(negInf), byte(0)
			if j > 0 {
				if d := get(prev, i-1, j-1); d > negInf {
					s := int32(mismatch)
					if a[i-1] == b[j-1] {
						s = match
					}
					best, dir = d+s, 0
				}
			}
			if u := get(prev, i-1, j); u > negInf && u+gap > best {
				best, dir = u+gap, 1
			}
			if j > l {
				if left := cur[k-1]; left > negInf && left+gap > best {
					best, dir = left+gap, 2
				}
			} else if j == 0 {
				best, dir = int32(i*gap), 1
			}
			cur[k] = best
			trace[i*width+k] = dir
		}
		prev, cur = cur, prev
	}
	if m < lo(n) || m > hi(n) {
		return nil, errors.New("alignment band does not reach the end")
	}
	out := &Map{To: make([]int32, n)}
	i, j := n, m
	for i > 0 || j > 0 {
		var dir byte = 2
		if i > 0 && j >= lo(i) && j <= hi(i) {
			dir = trace[i*width+j-lo(i)]
		} else if i > 0 {
			dir = 1
		}
		if i == 0 {
			dir = 2
		}
		if j == 0 && i > 0 {
			dir = 1
		}
		switch dir {
		case 0:
			out.To[i-1] = int32(j)
			if a[i-1] == b[j-1] {
				out.Matches++
			} else {
				out.Mismatches++
			}
			i, j = i-1, j-1
		case 1:
			out.Gaps++
			i--
		default:
			out.Gaps++
			j--
		}
	}
	if cols := out.Matches + out.Mismatches + out.Gaps; cols > 0 {
		out.Identity = float64(out.Matches) / float64(cols)
	}
	return out, nil
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
