package views

// Shared export writers: TSV tables, contact maps and arc diagrams as SVG,
// and saveExport (save dialog, render and write off the main thread, toast).
// The page-specific exports are in export_pages.go; the project report is
// report_html.go.

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"html"
	"math"
	"os"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/widgets"
)

// saveExport asks where to save name, renders the file and writes it, all
// off the main thread; a toast reports the path or the error. render must
// only use data captured on the main thread.
func saveExport(a *App, title, name string, render func() ([]byte, error)) {
	a.Go(func() func() {
		path := PickSave(title, name)
		if path == "" {
			return nil
		}
		data, err := render()
		if err == nil {
			err = os.WriteFile(path, data, 0o644)
		}
		return func() {
			if err != nil {
				a.Toast("Could not export: %v", err)
				return
			}
			a.Toast("Saved %s", path)
		}
	})
}

// exportName makes a file name from parts: letters, digits, '.', '-' and
// '_' are kept, anything else becomes '_'.
func exportName(ext string, parts ...string) string {
	var kept []string
	for _, part := range parts {
		var b strings.Builder
		for _, r := range part {
			switch {
			case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
				b.WriteRune(r)
			default:
				b.WriteByte('_')
			}
		}
		if s := strings.Trim(b.String(), "_."); s != "" {
			kept = append(kept, s)
		}
	}
	if len(kept) == 0 {
		kept = []string{"export"}
	}
	return strings.Join(kept, "_") + ext
}

// ---- TSV

// tsvTable is a tab-separated file: "# " comment lines, a header and rows.
// Fields holding a tab, a line break or a quote are quoted (doubled quotes
// inside), as spreadsheet programs read them.
type tsvTable struct {
	Comments []string
	Header   []string
	Rows     [][]string
}

func (t tsvTable) Bytes() ([]byte, error) {
	var buf bytes.Buffer
	for _, comment := range t.Comments {
		comment = strings.NewReplacer("\r\n", " ", "\n", " ", "\r", " ").Replace(comment)
		buf.WriteString("# " + comment + "\n")
	}
	w := csv.NewWriter(&buf)
	w.Comma = '\t'
	if len(t.Header) > 0 {
		if err := w.Write(t.Header); err != nil {
			return nil, err
		}
	}
	for _, row := range t.Rows {
		if err := w.Write(row); err != nil {
			return nil, err
		}
	}
	w.Flush()
	return buf.Bytes(), w.Error()
}

// tsvFloat formats a number for a table: "" for none or NaN.
func tsvFloat(v *float64) string {
	if v == nil || math.IsNaN(*v) {
		return ""
	}
	return strconv.FormatFloat(*v, 'g', 6, 64)
}

// ---- SVG

// svgNum writes a coordinate with at most one decimal.
func svgNum(v float64) string {
	return strconv.FormatFloat(math.Round(v*10)/10, 'f', -1, 64)
}

// svgFill is a fill attribute pair for a colour (opacity when translucent).
func svgFill(attr string, c ui.Color) string {
	s := fmt.Sprintf(`%s="#%02x%02x%02x"`, attr, c.R, c.G, c.B)
	if c.A < 255 {
		s += fmt.Sprintf(` %s-opacity="%s"`, attr, strconv.FormatFloat(float64(c.A)/255, 'f', 2, 64))
	}
	return s
}

func svgText(s string) string { return html.EscapeString(s) }

// niceTicks returns about n round positions in [a0, a1].
func niceTicks(a0, a1 float64, n int) []float64 {
	span := a1 - a0
	if span <= 0 || n < 1 {
		return nil
	}
	step := math.Pow(10, math.Floor(math.Log10(span/float64(n))))
	for _, m := range []float64{1, 2, 5, 10} {
		if span/(step*m) <= float64(n)+1 {
			step *= m
			break
		}
	}
	var out []float64
	for x := math.Ceil(a0/step) * step; x <= a1+1e-9; x += step {
		out = append(out, x)
	}
	return out
}

const (
	svgFont  = `font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"`
	svgInk   = "#333333"
	svgMuted = "#6b7280"
	svgLine  = "#c9ced6"
)

// heatSVG describes a contact map figure.
type heatSVG struct {
	Cells []widgets.Cell
	// View is the range drawn (gene coordinates).
	View widgets.Window
	// Size is the plot's side in px (default 420).
	Size float64
	// Title, XLabel and YLabel are plain text (escaped here).
	Title, XLabel, YLabel string
	// MaxCells caps the cells drawn (0: no cap). The cells are drawn in
	// order, later ones on top, so the last MaxCells are kept: callers order
	// them weakest first.
	MaxCells int
	// Note is a line under the plot (e.g. what the colours mean).
	Note string
	// MinCellPx is the smallest side a cell is drawn with (default 0.6),
	// so single cells stay visible on a small overview.
	MinCellPx float64
	// ID prefixes the element ids (unique per document when several
	// figures share one page).
	ID string
}

// SVG renders the map; drawn is the number of cells written, total the
// number of cells in view.
func (h heatSVG) SVG() (svg string, drawn, total int) {
	size := h.Size
	if size <= 0 {
		size = 420
	}
	v := h.View
	if v.X1 <= v.X0 || v.Y1 <= v.Y0 {
		v = widgets.Window{X0: 0, X1: 1, Y0: 0, Y1: 1}
		for _, c := range h.Cells {
			v.X1, v.Y1 = math.Max(v.X1, c.X+c.W), math.Max(v.Y1, c.Y+c.H)
		}
	}
	var inView []widgets.Cell
	for _, c := range h.Cells {
		if c.X+c.W < v.X0 || c.X > v.X1 || c.Y+c.H < v.Y0 || c.Y > v.Y1 {
			continue
		}
		inView = append(inView, c)
	}
	total = len(inView)
	if h.MaxCells > 0 && len(inView) > h.MaxCells {
		inView = inView[len(inView)-h.MaxCells:]
	}
	drawn = len(inView)

	const left, right, bottom = 58.0, 14.0, 42.0
	top := 12.0
	if h.Title != "" {
		top = 30
	}
	noteH := 0.0
	if h.Note != "" {
		noteH = 18
	}
	width, height := left+size+right, top+size+bottom+noteH
	sx, sy := size/(v.X1-v.X0), size/(v.Y1-v.Y0)
	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s" viewBox="0 0 %s %s" %s font-size="11">`,
		svgNum(width), svgNum(height), svgNum(width), svgNum(height), svgFont)
	label := h.Title
	if label == "" {
		label = "Contact map"
	}
	fmt.Fprintf(&b, `<title>%s</title>`, svgText(label))
	if drawn < total {
		fmt.Fprintf(&b, `<desc>%d of %d cells in view drawn (the strongest).</desc>`, drawn, total)
	}
	b.WriteString(`<rect width="100%" height="100%" fill="#ffffff"/>`)
	if h.Title != "" {
		fmt.Fprintf(&b, `<text x="%s" y="18" font-size="13" font-weight="600" fill="%s">%s</text>`, svgNum(left), svgInk, svgText(h.Title))
	}
	clipID := nameOr(h.ID, "heat") + "-clip"
	fmt.Fprintf(&b, `<defs><clipPath id="%s"><rect x="%s" y="%s" width="%s" height="%s"/></clipPath></defs>`,
		clipID, svgNum(left), svgNum(top), svgNum(size), svgNum(size))
	fmt.Fprintf(&b, `<rect x="%s" y="%s" width="%s" height="%s" fill="#f6f7f9"/>`, svgNum(left), svgNum(top), svgNum(size), svgNum(size))
	fmt.Fprintf(&b, `<g clip-path="url(#%s)" shape-rendering="crispEdges">`, clipID)
	for _, c := range inView {
		x := left + (c.X-v.X0)*sx
		y := top + (c.Y-v.Y0)*sy
		minPx := h.MinCellPx
		if minPx <= 0 {
			minPx = 0.6
		}
		w := math.Max(c.W*sx, minPx)
		hh := math.Max(c.H*sy, minPx)
		fmt.Fprintf(&b, `<rect x="%s" y="%s" width="%s" height="%s" %s/>`, svgNum(x), svgNum(y), svgNum(w), svgNum(hh), svgFill("fill", c.Color))
	}
	b.WriteString(`</g>`)
	fmt.Fprintf(&b, `<rect x="%s" y="%s" width="%s" height="%s" fill="none" stroke="%s"/>`, svgNum(left), svgNum(top), svgNum(size), svgNum(size), svgLine)
	// Axes: X along the bottom, Y down the left side (gene coordinates).
	for _, x := range niceTicks(v.X0, v.X1, 5) {
		px := left + (x-v.X0)*sx
		fmt.Fprintf(&b, `<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s"/>`, svgNum(px), svgNum(top+size), svgNum(px), svgNum(top+size+4), svgLine)
		fmt.Fprintf(&b, `<text x="%s" y="%s" text-anchor="middle" fill="%s">%d</text>`, svgNum(px), svgNum(top+size+16), svgMuted, int(x))
	}
	for _, y := range niceTicks(v.Y0, v.Y1, 5) {
		py := top + (y-v.Y0)*sy
		fmt.Fprintf(&b, `<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s"/>`, svgNum(left-4), svgNum(py), svgNum(left), svgNum(py), svgLine)
		fmt.Fprintf(&b, `<text x="%s" y="%s" text-anchor="end" fill="%s">%d</text>`, svgNum(left-6), svgNum(py+4), svgMuted, int(y))
	}
	if h.XLabel != "" {
		fmt.Fprintf(&b, `<text x="%s" y="%s" text-anchor="middle" fill="%s">%s</text>`, svgNum(left+size/2), svgNum(top+size+32), svgMuted, svgText(h.XLabel))
	}
	if h.YLabel != "" {
		fmt.Fprintf(&b, `<text transform="translate(12 %s) rotate(-90)" text-anchor="middle" fill="%s">%s</text>`, svgNum(top+size/2), svgMuted, svgText(h.YLabel))
	}
	if h.Note != "" {
		fmt.Fprintf(&b, `<text x="%s" y="%s" fill="%s">%s</text>`, svgNum(left), svgNum(top+size+bottom+12), svgMuted, svgText(h.Note))
	}
	b.WriteString(`</svg>`)
	return b.String(), drawn, total
}

// arcSVG describes an arc diagram: A's pairs above the axis, B's below,
// pairs both have in grey (as widgets.Arcs draws them).
type arcSVG struct {
	A, B []widgets.Pair
	// Start, End: the range shown (1-based, inclusive).
	Start, End int
	// Width in px (default 900); the height follows.
	Width          float64
	Title          string
	LabelA, LabelB string
	// ID prefixes the element ids (see heatSVG.ID).
	ID string
	// Overlay arcs (e.g. differential interactions) drawn over the pairs,
	// with their legend labels: up (above), down (below).
	Overlay                     []widgets.OverlayArc
	OverlayUpLabel, OverlayDown string
	// Mono, when not transparent, draws both structures in this colour.
	Mono ui.Color
	// Features is the gene track under the arcs.
	Features []widgets.Feature
}

var (
	arcColorA      = ui.RGB(214, 69, 65)
	arcColorB      = ui.RGB(43, 108, 196)
	arcColorShared = ui.RGB(140, 140, 140)
)

// SVG renders the diagram; drawn is the number of arcs written.
func (s arcSVG) SVG() (svg string, drawn int) {
	width := s.Width
	if width <= 0 {
		width = 900
	}
	start, end := s.Start, s.End
	if end <= start {
		start, end = 1, 2
		for _, p := range append(append([]widgets.Pair{}, s.A...), s.B...) {
			end = max(end, p.J)
		}
	}
	const left, right = 14.0, 14.0
	top := 12.0
	if s.Title != "" {
		top = 30
	}
	plotW := width - left - right
	half := math.Min(220, plotW/4)
	twoSided := len(s.B) > 0
	for _, o := range s.Overlay {
		twoSided = twoSided || !o.Up
	}
	plotH := half
	if twoSided {
		plotH = 2 * half
	}
	base := top + half
	track := 0.0
	if len(s.Features) > 0 {
		track = 20
	}
	legendY := top + plotH + track + 36
	height := legendY + 10
	span := float64(end - start)
	if span <= 0 {
		span = 1
	}
	x := func(pos int) float64 { return left + (float64(pos)-float64(start))/span*plotW }

	inA := make(map[widgets.Pair]bool, len(s.A))
	for _, p := range s.A {
		inA[p] = true
	}
	shared := map[widgets.Pair]bool{}
	for _, p := range s.B {
		if inA[p] {
			shared[p] = true
		}
	}
	var arcPath func(pairs []widgets.Pair, up, onlyShared, byWidth bool) string
	path := func(pairs []widgets.Pair, up, onlyShared bool) string {
		return arcPath(pairs, up, onlyShared, false)
	}
	arcPath = func(pairs []widgets.Pair, up, onlyShared, byWidth bool) string {
		var d strings.Builder
		for _, p := range pairs {
			if p.J < start || p.I > end || (!byWidth && shared[p] != onlyShared) {
				continue
			}
			// A half ellipse from two cubic curves (as widgets.Arcs).
			x0, x1 := x(p.I), x(p.J)
			rx := (x1 - x0) / 2
			h := math.Min(rx, half-6)
			if byWidth { // overlay arcs: height by span relative to the plot width
				h = (half - 6) * math.Min(1, 0.06+0.94*(x1-x0)/plotW)
			}
			if up {
				h = -h
			}
			const k = 0.5523
			mid := (x0 + x1) / 2
			fmt.Fprintf(&d, "M%s %sC%s %s %s %s %s %sC%s %s %s %s %s %s",
				svgNum(x0), svgNum(base),
				svgNum(x0), svgNum(base+h*k), svgNum(mid-rx*k), svgNum(base+h), svgNum(mid), svgNum(base+h),
				svgNum(mid+rx*k), svgNum(base+h), svgNum(x1), svgNum(base+h*k), svgNum(x1), svgNum(base))
			drawn++
		}
		return d.String()
	}
	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s" viewBox="0 0 %s %s" %s font-size="11">`,
		svgNum(width), svgNum(height), svgNum(width), svgNum(height), svgFont)
	label := s.Title
	if label == "" {
		label = "Arc diagram"
	}
	fmt.Fprintf(&b, `<title>%s</title>`, svgText(label))
	b.WriteString(`<rect width="100%" height="100%" fill="#ffffff"/>`)
	if s.Title != "" {
		fmt.Fprintf(&b, `<text x="%s" y="18" font-size="13" font-weight="600" fill="%s">%s</text>`, svgNum(left), svgInk, svgText(s.Title))
	}
	clipID := nameOr(s.ID, "arcs") + "-clip"
	fmt.Fprintf(&b, `<defs><clipPath id="%s"><rect x="%s" y="%s" width="%s" height="%s"/></clipPath></defs>`,
		clipID, svgNum(left), svgNum(top), svgNum(plotW), svgNum(plotH))
	fmt.Fprintf(&b, `<g clip-path="url(#%s)" fill="none" stroke-width="0.8">`, clipID)
	colorA, colorB, colorShared := arcColorA, arcColorB, arcColorShared
	if s.Mono.A > 0 {
		colorA, colorB, colorShared = s.Mono, s.Mono, s.Mono
	}
	for _, layer := range []struct {
		pairs      []widgets.Pair
		up, shared bool
		color      ui.Color
	}{{s.A, true, false, colorA}, {s.B, false, false, colorB}, {s.A, true, true, colorShared}, {s.B, false, true, colorShared}} {
		if d := path(layer.pairs, layer.up, layer.shared); d != "" {
			fmt.Fprintf(&b, `<path d="%s" %s/>`, d, svgFill("stroke", layer.color))
		}
	}
	// Overlay arcs, grouped by colour, width and side.
	type overlayKey struct {
		color ui.Color
		width float32
		up    bool
	}
	groups := map[overlayKey][]widgets.Pair{}
	var order []overlayKey
	for _, o := range s.Overlay {
		key := overlayKey{o.Color, max(o.Width, 1), o.Up}
		if _, ok := groups[key]; !ok {
			order = append(order, key)
		}
		groups[key] = append(groups[key], widgets.Pair{I: o.I, J: o.J})
	}
	for _, key := range order {
		if d := arcPath(groups[key], key.up, false, true); d != "" {
			fmt.Fprintf(&b, `<path d="%s" %s stroke-width="%s"/>`, d, svgFill("stroke", key.color), svgNum(float64(key.width)))
		}
	}
	b.WriteString(`</g>`)
	fmt.Fprintf(&b, `<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s"/>`, svgNum(left), svgNum(base), svgNum(left+plotW), svgNum(base), svgLine)
	if track > 0 {
		y := top + plotH + 2
		for index, f := range s.Features {
			if f.End < start || f.Start > end {
				continue
			}
			x0, x1 := math.Max(x(f.Start), left), math.Min(x(f.End+1), left+plotW)
			fill := "#d9d9d9"
			if index%2 == 1 {
				fill = "#bdbdbd"
			}
			fmt.Fprintf(&b, `<rect x="%s" y="%s" width="%s" height="16" fill="%s"><title>%s</title></rect>`,
				svgNum(x0), svgNum(y), svgNum(math.Max(x1-x0, 0.5)), fill, svgText(f.Name))
			if width := 6.0 * float64(len([]rune(f.Name))); f.Name != "" && x1-x0 > width+4 {
				fmt.Fprintf(&b, `<text x="%s" y="%s" text-anchor="middle" font-size="10" fill="%s">%s</text>`,
					svgNum((x0+x1)/2), svgNum(y+12), svgInk, svgText(f.Name))
			}
		}
	}
	axisY := top + plotH + track
	for _, pos := range niceTicks(float64(start), float64(end), 8) {
		px := x(int(pos))
		fmt.Fprintf(&b, `<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s"/>`, svgNum(px), svgNum(axisY+2), svgNum(px), svgNum(axisY+6), svgLine)
		fmt.Fprintf(&b, `<text x="%s" y="%s" text-anchor="middle" fill="%s">%d</text>`, svgNum(px), svgNum(axisY+18), svgMuted, int(pos))
	}
	type legendItem struct {
		color ui.Color
		label string
	}
	legend := []legendItem{{colorA, s.LabelA}}
	if len(s.B) > 0 {
		legend = append(legend, legendItem{colorB, s.LabelB})
		if s.Mono.A == 0 {
			legend = append(legend, legendItem{colorShared, "in both"})
		}
	}
	for _, o := range s.Overlay {
		if o.Up && s.OverlayUpLabel != "" {
			legend = append(legend, legendItem{o.Color, s.OverlayUpLabel})
			break
		}
	}
	for _, o := range s.Overlay {
		if !o.Up && s.OverlayDown != "" {
			legend = append(legend, legendItem{o.Color, s.OverlayDown})
			break
		}
	}
	lx := left
	for _, item := range legend {
		if item.label == "" {
			continue
		}
		fmt.Fprintf(&b, `<rect x="%s" y="%s" width="14" height="3" %s/>`, svgNum(lx), svgNum(legendY-4), svgFill("fill", item.color))
		fmt.Fprintf(&b, `<text x="%s" y="%s" fill="%s">%s</text>`, svgNum(lx+20), svgNum(legendY), svgMuted, svgText(item.label))
		lx += 40 + 6.5*float64(len([]rune(item.label)))
	}
	b.WriteString(`</svg>`)
	return b.String(), drawn
}

// svgFile makes a standalone .svg file of an inline SVG element.
func svgFile(svg string) []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8"?>` + "\n" + svg + "\n")
}
