package views

// Data and drawings of the Compare page's panels (compare_panels.go):
// the enriched regions' local structures (bridge operation
// structure_regions, desktop/runtime/regions.py) and the folding-energy
// violins (read_energy, desktop/runtime/energy.py). Everything here is
// pure: no backend, no ui state.

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/egoist/mygo/ui"
)

// ---- enriched regions

type regionPanel struct {
	Windows             [][2]int     `json:"windows"`
	Pos                 []int        `json:"pos"`
	Window              []int        `json:"window"`
	Base                string       `json:"base"`
	X                   []float64    `json:"x"`
	Y                   []float64    `json:"y"`
	Partner             []int        `json:"partner"`
	Outside             []int        `json:"outside"`
	Linker              [][2]float64 `json:"linker"`
	PairsInWindow       []int        `json:"pairs_in_window"`
	InterWindowPairs    int          `json:"inter_window_pairs"`
	NotDrawn            int          `json:"not_drawn"`
	BasesPairedOutside  int          `json:"bases_paired_outside"`
	OutsidePartners     [][2]int     `json:"outside_partners"`
	OutsidePartnersText string       `json:"outside_partners_text"`
	Structure           int          `json:"structure"`
	StructureID         string       `json:"structure_id"`
	GeneID              string       `json:"gene_id"`
	Enriched            bool         `json:"enriched"`
}

type regionCandidate struct {
	Rank       int      `json:"rank"`
	X          int      `json:"x"`
	Y          int      `json:"y"`
	A          int      `json:"a"`
	B          int      `json:"b"`
	CellA      int      `json:"cell_a"`
	CellB      int      `json:"cell_b"`
	LFC        *float64 `json:"log2FoldChange"`
	Padj       float64  `json:"padj"`
	PairsOwn   int      `json:"pairs_own"`
	PairsOther int      `json:"pairs_other"`
}

type regionResult struct {
	Direction  string            `json:"direction"`
	Enriched   int               `json:"enriched"`
	Label      string            `json:"label"`
	Tested     int               `json:"tested"`
	Candidates []regionCandidate `json:"candidates"`
	Chosen     *int              `json:"chosen"`
	Windows    [][2]int          `json:"windows"`
	Panels     []regionPanel     `json:"panels"`
}

type regionsResult struct {
	Comparison struct {
		ID       string `json:"id"`
		LabelOne string `json:"label_one"`
		LabelTwo string `json:"label_two"`
		GeneOne  string `json:"gene_one"`
		GeneTwo  string `json:"gene_two"`
	} `json:"comparison"`
	Structures []struct {
		ID     string `json:"id"`
		GeneID string `json:"gene_id"`
		Length int    `json:"length"`
		Pairs  int    `json:"pairs"`
	} `json:"structures"`
	Parameters struct {
		Padj   float64 `json:"padj"`
		Reach  int     `json:"reach"`
		Flank  int     `json:"flank"`
		Linker int     `json:"linker"`
	} `json:"parameters"`
	Alignment []struct {
		From       string  `json:"from"`
		To         string  `json:"to"`
		Identity   float64 `json:"identity"`
		Mismatches int     `json:"mismatches"`
		Gaps       int     `json:"gaps"`
	} `json:"alignment"`
	Regions []regionResult `json:"regions"`
}

func (r *regionResult) chosen() *regionCandidate {
	if r.Chosen == nil {
		return nil
	}
	for i := range r.Candidates {
		if r.Candidates[i].Rank == *r.Chosen {
			return &r.Candidates[i]
		}
	}
	return nil
}

// regionName is "Region A" for the first direction, "Region B" for the second.
func regionName(k int) string { return "Region " + string(rune('A'+k)) }

// regionColor is the colour of the lineage the region is enriched in, in
// exported files.
func regionColor(enriched int) ui.Color { return figLight.condition(enriched) }

func candidateText(c *regionCandidate) string {
	lfc := "NA"
	if c.LFC != nil {
		lfc = fmt.Sprintf("%+.2f", *c.LFC)
	}
	return fmt.Sprintf("#%d · %s ↔ %s · log2FC %s · padj %.2e", c.Rank, FormatNumber(int64(c.CellA)), FormatNumber(int64(c.CellB)), lfc, c.Padj)
}

func windowsText(ws [][2]int) string {
	parts := make([]string, len(ws))
	for i, w := range ws {
		parts[i] = FormatNumber(int64(w[0])) + "–" + FormatNumber(int64(w[1]))
	}
	return strings.Join(parts, " / ")
}

// panelPairsText is "pairs in X 0 · in Y 0 · between windows 29".
func panelPairsText(pn *regionPanel) string {
	if len(pn.PairsInWindow) == 1 {
		return fmt.Sprintf("pairs in the window %d", pn.PairsInWindow[0])
	}
	parts := make([]string, 0, 3)
	for k, n := range pn.PairsInWindow {
		parts = append(parts, fmt.Sprintf("in %c %d", 'X'+k, n))
	}
	return "pairs " + strings.Join(parts, " · ") + fmt.Sprintf(" · between windows %d", pn.InterWindowPairs)
}

func panelOutsideText(pn *regionPanel) string {
	if pn.BasesPairedOutside == 0 {
		return "no base paired outside the windows"
	}
	return fmt.Sprintf("%d bases paired outside: %s", pn.BasesPairedOutside, strings.ReplaceAll(pn.OutsidePartnersText, "-", "–"))
}

// regionFigure draws one panel: the windows' backbone, the pairs inside
// them (between windows in the enriched lineage's colour), bases paired
// outside the windows hollow; size is the figure's side in units.
func regionFigure(pn *regionPanel, enriched ui.Color, pal figPalette, size float32) *figure {
	f := &figure{W: size, H: size}
	n := len(pn.Pos)
	if n == 0 || len(pn.X) != n || len(pn.Y) != n {
		f.text(size/2, size/2, "No bases", 12, pal.Muted, 0, false)
		return f
	}
	minX, maxX, minY, maxY := math.Inf(1), math.Inf(-1), math.Inf(1), math.Inf(-1)
	grow := func(x, y float64) {
		minX, maxX, minY, maxY = math.Min(minX, x), math.Max(maxX, x), math.Min(minY, y), math.Max(maxY, y)
	}
	for k := range n {
		grow(pn.X[k], pn.Y[k])
	}
	for _, q := range pn.Linker {
		grow(q[0], q[1])
	}
	const margin = 26
	span := math.Max(maxX-minX, maxY-minY)
	if span <= 0 {
		span = 1
	}
	scale := (float64(size) - 2*margin) / span
	// the layout's y axis points up (RNAplot); centre the drawing
	offX := margin + ((float64(size)-2*margin)-(maxX-minX)*scale)/2
	offY := margin + ((float64(size)-2*margin)-(maxY-minY)*scale)/2
	at := func(x, y float64) figPt {
		return figPt{float32(offX + (x-minX)*scale), float32(offY + (maxY-y)*scale)}
	}
	pts := make([]figPt, n)
	for k := range n {
		pts[k] = at(pn.X[k], pn.Y[k])
	}
	// backbone of each window, the linker dashed
	start := 0
	for k := 1; k <= n; k++ {
		if k == n || pn.Window[k] != pn.Window[k-1] {
			if k-start > 1 {
				f.line(pal.Muted, 1, pts[start:k]...)
			}
			if k < n {
				link := []figPt{pts[k-1]}
				for _, q := range pn.Linker {
					link = append(link, at(q[0], q[1]))
				}
				link = append(link, pts[k])
				if len(pn.Windows) > 2 {
					link = []figPt{pts[k-1], pts[k]}
				}
				f.dashed(pal.Faint, 1, link...)
			}
			start = k
		}
	}
	// pairs: inside a window, then between windows on top
	for pass := range 2 {
		for k, q := range pn.Partner {
			if q <= k || q >= n {
				continue
			}
			between := pn.Window[k] != pn.Window[q]
			if between != (pass == 1) {
				continue
			}
			color, width := pal.Text.Alpha(0.55), float32(1.4)
			if between {
				color, width = enriched, 2.2
			}
			f.line(color, width, pts[k], pts[q])
		}
	}
	step := scale * 15 // RNAplot bases are ~15 units apart
	radius := float32(math.Max(1.6, math.Min(4.5, step*0.32)))
	for k := range n {
		x, y := pts[k].X, pts[k].Y
		switch {
		case k < len(pn.Outside) && pn.Outside[k] > 0:
			f.circle(x, y, radius, pal.Background, pal.Text, 1.1)
		case k < len(pn.Partner) && pn.Partner[k] >= 0 && pn.Partner[k] < n && pn.Window[pn.Partner[k]] != pn.Window[k]:
			f.circle(x, y, radius, enriched, ui.Color{}, 0)
		case k < len(pn.Partner) && pn.Partner[k] >= 0:
			f.circle(x, y, radius, pal.Muted, ui.Color{}, 0)
		default:
			f.circle(x, y, radius, pal.Faint, ui.Color{}, 0)
		}
	}
	// window ends: coordinates beside the first and last base of each window
	// pushed along the backbone, away from the window's next base, so the
	// ends of two windows that meet stay apart
	var cx, cy float32
	for _, q := range pts {
		cx, cy = cx+q.X/float32(n), cy+q.Y/float32(n)
	}
	unit := func(dx, dy float32) (float32, float32) {
		d := float32(math.Hypot(float64(dx), float64(dy)))
		if d < 1e-3 {
			return 0, 0
		}
		return dx / d, dy / d
	}
	label := func(k, toward int, text string) {
		tx, ty := unit(pts[k].X-pts[toward].X, pts[k].Y-pts[toward].Y)
		rx, ry := unit(pts[k].X-cx, pts[k].Y-cy)
		dx, dy := unit(tx+rx, ty+ry)
		d := float32(1)
		if dx == 0 && dy == 0 {
			dy = -1
		}
		x, y := pts[k].X+dx/d*11, pts[k].Y+dy/d*11+3
		anchor := 0
		if dx/d > 0.4 {
			anchor = -1
		} else if dx/d < -0.4 {
			anchor = 1
		}
		x = min(max(x, 2), float32(size)-2)
		y = min(max(y, 9), float32(size)-2)
		f.text(x, y, text, 9, pal.Muted, anchor, false)
	}
	// Each end is pushed away from the end it faces: the other window's end
	// across the linker, or (first and last base) each other.
	multi := pn.Window[n-1] != pn.Window[0]
	for k := range n {
		if (k == 0 || pn.Window[k] != pn.Window[k-1]) && n > 1 {
			text, toward := FormatNumber(int64(pn.Pos[k])), k+1
			switch {
			case k > 0:
				toward = k - 1
			case multi:
				toward = n - 1
			}
			if k == 0 {
				text = "5′ " + text
			}
			label(k, toward, text)
		}
		if (k == n-1 || pn.Window[k] != pn.Window[k+1]) && n > 1 {
			toward := k - 1
			switch {
			case k < n-1:
				toward = k + 1
			case multi:
				toward = 0
			}
			label(k, toward, FormatNumber(int64(pn.Pos[k])))
		}
	}
	return f
}

// regionsSVG is both regions, each fold's panel with its title and counts.
func regionsSVG(res *regionsResult, labels [2]string, title string) string {
	const panel, gap, left, top = 300.0, 24.0, 16.0, 36.0
	const textH = 78.0
	var regions []regionResult
	for _, r := range res.Regions {
		if len(r.Panels) > 0 {
			regions = append(regions, r)
		}
	}
	width := left*2 + 2*panel + gap
	rowH := 34 + panel + textH
	height := top + float64(max(len(regions), 1))*rowH + 40
	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s" viewBox="0 0 %s %s" %s font-size="11">`,
		svgNum(width), svgNum(height), svgNum(width), svgNum(height), svgFont)
	fmt.Fprintf(&b, `<rect width="100%%" height="100%%" fill="#ffffff"/>`)
	fmt.Fprintf(&b, `<text x="%s" y="22" font-size="14" font-weight="600" fill="%s">%s</text>`, svgNum(left), svgInk, svgText(title))
	if len(regions) == 0 {
		fmt.Fprintf(&b, `<text x="%s" y="%s" fill="%s">No interaction is formed by its lineage's fold.</text>`, svgNum(left), svgNum(top+20), svgMuted)
	}
	y := top
	for _, r := range res.Regions {
		if len(r.Panels) == 0 {
			continue
		}
		k := 0
		if r.Direction == "down" {
			k = 1
		}
		c := r.chosen()
		head := regionName(k) + " · higher in " + labels[r.Enriched]
		if c != nil {
			head += " · " + candidateText(c) + " (of " + FormatNumber(int64(r.Tested)) + ")"
		}
		fmt.Fprintf(&b, `<text x="%s" y="%s" font-size="12.5" font-weight="600" %s>%s</text>`, svgNum(left), svgNum(y+14), svgFill("fill", regionColor(r.Enriched)), svgText(head))
		fmt.Fprintf(&b, `<text x="%s" y="%s" fill="%s">Windows %s (%s coordinates)</text>`, svgNum(left), svgNum(y+28), svgMuted,
			svgText(windowsText(r.Windows)), svgText(labels[0]))
		for i := range r.Panels {
			pn := &r.Panels[i]
			x := left + float64(i)*(panel+gap)
			fig := regionFigure(pn, regionColor(r.Enriched), figLight, panel)
			fmt.Fprintf(&b, `<rect x="%s" y="%s" width="%s" height="%s" fill="none" stroke="%s" rx="6"/>`, svgNum(x), svgNum(y+34), svgNum(panel), svgNum(panel), svgLine)
			fig.svg(&b, x, y+34, 1)
			ty := y + 34 + panel + 16
			fmt.Fprintf(&b, `<text x="%s" y="%s" font-weight="600" fill="%s">%s fold · %s</text>`, svgNum(x), svgNum(ty), svgInk,
				svgText(labels[pn.Structure]), svgText(windowsText(pn.Windows)))
			fmt.Fprintf(&b, `<text x="%s" y="%s" fill="%s">%s</text>`, svgNum(x), svgNum(ty+15), svgMuted, svgText(panelPairsText(pn)))
			for j, line := range wrapText(panelOutsideText(pn), 58) {
				if j > 2 {
					break
				}
				fmt.Fprintf(&b, `<text x="%s" y="%s" fill="%s">%s</text>`, svgNum(x), svgNum(ty+30+float64(j)*14), svgMuted, svgText(line))
			}
		}
		y += rowH
	}
	note := fmt.Sprintf("Windows: extent of the enriched fold's pairs within ±%d nt of both arms, ±%d nt; joined by a %d-nt linker for the layout only (RNAplot). Coloured: pairs between windows; hollow: paired outside the windows.",
		res.Parameters.Reach, res.Parameters.Flank, res.Parameters.Linker)
	for i, line := range wrapText(note, 115) {
		fmt.Fprintf(&b, `<text x="%s" y="%s" font-size="10" fill="%s">%s</text>`, svgNum(left), svgNum(height-24+float64(i)*13), svgMuted, svgText(line))
	}
	b.WriteString(`</svg>`)
	return b.String()
}

// wrapText splits s into lines of at most width runes at spaces.
func wrapText(s string, width int) []string {
	var lines []string
	var line []string
	n := 0
	for _, w := range strings.Fields(s) {
		if n > 0 && n+1+len([]rune(w)) > width {
			lines = append(lines, strings.Join(line, " "))
			line, n = nil, 0
		}
		if n > 0 {
			n++
		}
		line = append(line, w)
		n += len([]rune(w))
	}
	if len(line) > 0 {
		lines = append(lines, strings.Join(line, " "))
	}
	return lines
}

// ---- folding energy

type energySide struct {
	N        int      `json:"n"`
	MeanOne  *float64 `json:"mean_dG_one"`
	MeanTwo  *float64 `json:"mean_dG_two"`
	MeanDiff *float64 `json:"mean_diff_one_minus_two"`
	T        *float64 `json:"t"`
	DF       *float64 `json:"df"`
	P        *float64 `json:"p"`
}

type energySummary struct {
	ComparisonID string `json:"comparison_id"`
	LabelOne     string `json:"label_one"`
	LabelTwo     string `json:"label_two"`
	GeneOne      string `json:"gene_one"`
	GeneTwo      string `json:"gene_two"`
	Parameters   struct {
		Length int     `json:"length"`
		Padj   float64 `json:"padj"`
	} `json:"parameters"`
	ViennaVersion string `json:"vienna_version"`
	Alignment     *struct {
		Identity   float64 `json:"identity"`
		Mismatches int     `json:"mismatches"`
		Gaps       int     `json:"gaps"`
	} `json:"alignment"`
	Interactions int                   `json:"interactions"`
	Folded       int                   `json:"folded"`
	Skipped      int                   `json:"skipped"`
	Sides        map[string]energySide `json:"sides"`
	Files        map[string]string     `json:"files"`
	CreatedAt    string                `json:"created_at"`
}

type energyResult struct {
	Lengths []int          `json:"lengths"`
	Length  int            `json:"length"`
	Summary *energySummary `json:"summary"`
	Rows    *struct {
		Side  []string   `json:"side"`
		X     []int      `json:"x"`
		Y     []int      `json:"y"`
		LFC   []*float64 `json:"log2FoldChange"`
		Padj  []*float64 `json:"padj"`
		DGOne []*float64 `json:"dG_one"`
		DGTwo []*float64 `json:"dG_two"`
	} `json:"rows"`
}

var energySides = [2]string{"enriched_in_one", "enriched_in_two"}

// values are the dG of one side: [lineage one, lineage two].
func (r *energyResult) values(side string) (one, two []float64) {
	if r.Rows == nil {
		return nil, nil
	}
	rows := r.Rows
	for k, s := range rows.Side {
		if s != side || k >= len(rows.DGOne) || k >= len(rows.DGTwo) || rows.DGOne[k] == nil || rows.DGTwo[k] == nil {
			continue
		}
		one = append(one, *rows.DGOne[k])
		two = append(two, *rows.DGTwo[k])
	}
	return one, two
}

// violins are a side's violin statistics: [lineage one, lineage two].
func (r *energyResult) violins(side int) [2]violinStats {
	one, two := r.values(energySides[side])
	return [2]violinStats{violin(one), violin(two)}
}

// violinStats is what a violin and box plot of values draw (ggplot2's
// geom_violin(trim = FALSE) and geom_boxplot defaults).
type violinStats struct {
	N                         int
	Q1, Median, Q3            float64
	WhiskerLo, WhiskerHi      float64
	Outliers                  []float64
	Grid, Density             []float64
	Min, Max, Mean, Bandwidth float64
}

// quantile7 is R's default (type 7) quantile of sorted values.
func quantile7(sorted []float64, p float64) float64 {
	n := len(sorted)
	if n == 0 {
		return math.NaN()
	}
	h := float64(n-1) * p
	lo := math.Floor(h)
	i := int(lo)
	if i+1 >= n {
		return sorted[n-1]
	}
	return sorted[i] + (h-lo)*(sorted[i+1]-sorted[i])
}

// bwNrd0 is R's bw.nrd0.
func bwNrd0(sorted []float64) float64 {
	n := len(sorted)
	if n < 2 {
		return 1
	}
	mean := 0.0
	for _, v := range sorted {
		mean += v
	}
	mean /= float64(n)
	ss := 0.0
	for _, v := range sorted {
		ss += (v - mean) * (v - mean)
	}
	sd := math.Sqrt(ss / float64(n-1))
	iqr := quantile7(sorted, 0.75) - quantile7(sorted, 0.25)
	lo := math.Min(sd, iqr/1.34)
	if lo <= 0 {
		lo = sd
	}
	if lo <= 0 {
		lo = math.Abs(sorted[0])
	}
	if lo <= 0 {
		lo = 1
	}
	return 0.9 * lo * math.Pow(float64(n), -0.2)
}

func violin(values []float64) violinStats {
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	s := violinStats{N: len(sorted)}
	if s.N == 0 {
		return s
	}
	s.Min, s.Max = sorted[0], sorted[s.N-1]
	for _, v := range sorted {
		s.Mean += v
	}
	s.Mean /= float64(s.N)
	s.Q1, s.Median, s.Q3 = quantile7(sorted, 0.25), quantile7(sorted, 0.5), quantile7(sorted, 0.75)
	iqr := s.Q3 - s.Q1
	s.WhiskerLo, s.WhiskerHi = s.Q3, s.Q1
	for _, v := range sorted {
		if v < s.Q1-1.5*iqr || v > s.Q3+1.5*iqr {
			s.Outliers = append(s.Outliers, v)
			continue
		}
		s.WhiskerLo, s.WhiskerHi = math.Min(s.WhiskerLo, v), math.Max(s.WhiskerHi, v)
	}
	bw := bwNrd0(sorted)
	s.Bandwidth = bw
	const points = 256
	lo, hi := s.Min-3*bw, s.Max+3*bw
	s.Grid, s.Density = make([]float64, points), make([]float64, points)
	norm := 1 / (float64(s.N) * bw * math.Sqrt(2*math.Pi))
	for g := range points {
		x := lo + (hi-lo)*float64(g)/float64(points-1)
		sum := 0.0
		for _, v := range sorted {
			z := (x - v) / bw
			if z > -8 && z < 8 {
				sum += math.Exp(-0.5 * z * z)
			}
		}
		s.Grid[g], s.Density[g] = x, sum*norm
	}
	return s
}

func formatP(p *float64) string {
	if p == nil {
		return "NA"
	}
	if *p == 0 {
		return "< 1e-300"
	}
	return fmt.Sprintf("%.2g", *p)
}

func formatFloat(v *float64, format string) string {
	if v == nil {
		return "NA"
	}
	return fmt.Sprintf(format, *v)
}

// energyFigure is one side's violins (lineage one red, two blue) with box
// plots, in W x H units.
func energyFigure(stats [2]violinStats, labels [2]string, title, subtitle string, pal figPalette, w, h float32) *figure {
	f := &figure{W: w, H: h}
	const left, right, top, bottom = 52, 12, 60, 24
	f.text(left-40, 16, title, 12.5, pal.Text, -1, true)
	f.text(left-40, 32, subtitle, 10.5, pal.Muted, -1, false)
	if stats[0].N == 0 {
		f.text(w/2, h/2, "No interaction", 12, pal.Muted, 0, false)
		return f
	}
	lo, hi := math.Inf(1), math.Inf(-1)
	maxDensity := 0.0
	for _, s := range stats {
		if len(s.Grid) > 0 {
			lo, hi = math.Min(lo, s.Grid[0]), math.Max(hi, s.Grid[len(s.Grid)-1])
		}
		for _, d := range s.Density {
			maxDensity = math.Max(maxDensity, d)
		}
	}
	pad := (hi - lo) * 0.03
	lo, hi = lo-pad, hi+pad
	plotTop, plotBottom := float32(top), h-bottom
	y := func(v float64) float32 {
		return plotBottom - float32((v-lo)/(hi-lo))*(plotBottom-plotTop)
	}
	// axis, ticks and grid
	f.line(pal.Border, 1, figPt{left, plotTop}, figPt{left, plotBottom})
	for _, tick := range niceTicks(lo, hi, 6) {
		ty := y(tick)
		f.line(pal.Border.Alpha(0.6), 0.6, figPt{left, ty}, figPt{w - right, ty})
		f.text(left-5, ty+3.5, fmt.Sprintf("%g", tick), 9.5, pal.Muted, 1, false)
	}
	// the axis title over the axis (the painter does not rotate text)
	f.text(left-40, top-9, "Folding energy (kcal/mol)", 9.5, pal.Muted, -1, false)
	slot := (w - left - right) / 2
	half := slot * 0.42
	colors := [2]ui.Color{pal.A, pal.B}
	for k, s := range stats {
		if s.N == 0 {
			continue
		}
		cx := left + slot*(float32(k)+0.5)
		var outline []figPt
		for g := range s.Grid {
			outline = append(outline, figPt{cx - half*float32(s.Density[g]/maxDensity), y(s.Grid[g])})
		}
		for g := len(s.Grid) - 1; g >= 0; g-- {
			outline = append(outline, figPt{cx + half*float32(s.Density[g]/maxDensity), y(s.Grid[g])})
		}
		f.poly(colors[k].Alpha(0.55), colors[k], 1, outline...)
		bw := slot * 0.07
		f.line(pal.Text, 1, figPt{cx, y(s.WhiskerHi)}, figPt{cx, y(s.Q3)})
		f.line(pal.Text, 1, figPt{cx, y(s.Q1)}, figPt{cx, y(s.WhiskerLo)})
		f.poly(pal.Background, pal.Text, 1, figPt{cx - bw, y(s.Q3)}, figPt{cx + bw, y(s.Q3)}, figPt{cx + bw, y(s.Q1)}, figPt{cx - bw, y(s.Q1)})
		f.line(pal.Text, 2, figPt{cx - bw, y(s.Median)}, figPt{cx + bw, y(s.Median)})
		for _, v := range s.Outliers {
			f.circle(cx, y(v), 1.3, pal.Text, ui.Color{}, 0)
		}
		f.text(cx, plotBottom+14, labels[k], 10.5, pal.Text, 0, false)
	}
	return f
}

// energySideTitle is the title and subtitle of a side's panel.
func energySideTitle(r *energyResult, side int, labels [2]string) (string, string) {
	s := r.Summary
	st := s.Sides[energySides[side]]
	title := fmt.Sprintf("%s-enriched, n = %s", labels[side], FormatNumber(int64(st.N)))
	subtitle := fmt.Sprintf("2 × %d nt, RNAcofold · paired t-test p = %s", s.Parameters.Length, formatP(st.P))
	return title, subtitle
}

// energySVG is the two sides' violins side by side.
func energySVG(r *energyResult, labels [2]string, title string) string {
	const panelW, panelH, gap, left, top = 360.0, 330.0, 20.0, 16.0, 34.0
	width := left*2 + 2*panelW + gap
	height := top + panelH + 46
	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s" viewBox="0 0 %s %s" %s font-size="11">`,
		svgNum(width), svgNum(height), svgNum(width), svgNum(height), svgFont)
	fmt.Fprintf(&b, `<rect width="100%%" height="100%%" fill="#ffffff"/>`)
	fmt.Fprintf(&b, `<text x="%s" y="22" font-size="14" font-weight="600" fill="%s">%s</text>`, svgNum(left), svgInk, svgText(title))
	for side := range 2 {
		t, sub := energySideTitle(r, side, labels)
		fig := energyFigure(r.violins(side), labels, t, sub, figLight, panelW, panelH)
		fig.svg(&b, left+float64(side)*(panelW+gap), top, 1)
	}
	s := r.Summary
	note := fmt.Sprintf("%s of %s interactions with padj < %g folded (%d ran off an end); ViennaRNA %s RNAcofold, default model, 37 °C; %s fragments at the aligned positions.",
		FormatNumber(int64(s.Folded)), FormatNumber(int64(s.Interactions)), s.Parameters.Padj, s.Skipped, nameOr(s.ViennaVersion, "?"), labels[1])
	for i, line := range wrapText(note, 130) {
		fmt.Fprintf(&b, `<text x="%s" y="%s" font-size="10" fill="%s">%s</text>`, svgNum(left), svgNum(height-26+float64(i)*13), svgMuted, svgText(line))
	}
	b.WriteString(`</svg>`)
	return b.String()
}
