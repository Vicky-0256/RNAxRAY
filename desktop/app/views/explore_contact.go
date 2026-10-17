package views

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/widgets"
)

// Contact map: analysis_contact_bins drawn with widgets.Heatmap.

const (
	binAuto = "Auto"
	// autoMaxCells bounds "Auto": the backend doubles the bin until the
	// map has at most this many non-empty cells.
	autoMaxCells = 200_000
	// fixedMaxCells keeps a chosen bin from producing a map too large to
	// draw; the backend then coarsens it (shown as adjusted).
	fixedMaxCells = 600_000

	orientBoth     = "Both arm orders"
	orientOriented = "Arm 1 on X"
	measureRecords = "Records"
	measureReads   = "Reads"
	scaleLinear    = "Linear"
	scaleLog       = "Log"
)

var (
	binOptions    = []string{binAuto, "10 nt", "20 nt", "50 nt", "100 nt", "200 nt"}
	capOptions    = []string{"90th percentile", "95th percentile", "99th percentile", "Maximum"}
	capFractions  = []float64{0.90, 0.95, 0.99, 1}
	measures      = []string{measureRecords, measureReads}
	orientations  = []string{orientBoth, orientOriented}
	scaleOptions  = []string{scaleLinear, scaleLog}
	mapSizeTarget = float32(430)
)

type contactState struct {
	gene2       string // partner gene on Y (the selected gene by default)
	bin         string
	measure     string
	orientation string
	typ         string
	colorCap    string
	scale       string

	load loader
	data *contactData
	heat *widgets.Heatmap
	// picked is the chosen cell (index into data), -1 for none.
	picked int
	hover  string
	// focus, when set, is a gene range {x, x end, y, y end} to pick and
	// zoom to once the map loads (from Compare).
	focus *[4]int
}

// contactData is one analysis_contact_bins answer, ready to draw.
type contactData struct {
	gene, gene2      string
	bin, requested   int
	adjusted         bool
	lengthX, lengthY int
	total, max       int
	measure          string
	orientation      string
	typ              string
	x, y, count      []int
	sorted           []int // counts, ascending (for the colour cap)
	at               map[[2]int]int
}

func (s *contactState) init() {
	s.bin, s.measure, s.orientation, s.typ = binAuto, measureRecords, orientBoth, allTypes
	s.colorCap, s.scale = capOptions[1], scaleLinear
	s.heat = widgets.NewHeatmap()
	s.picked = -1
}

func (s *contactState) selectionChanged(gene string, geneChanged bool) {
	if geneChanged || s.gene2 == "" {
		s.gene2 = gene
	}
	s.picked = -1
	s.hover = ""
}

func (p *explorePage) contactGene2() string {
	if p.cm.gene2 == "" {
		return p.gene
	}
	return p.cm.gene2
}

func (p *explorePage) contactKey() string {
	s := &p.cm
	return strings.Join([]string{p.sel, p.contactGene2(), s.bin, s.measure, s.orientation, s.typ}, "\x00")
}

func (p *explorePage) loadContact() {
	s := &p.cm
	path, ids, gene, gene2 := p.a.Project.Path, p.ids, p.gene, p.contactGene2()
	bin, measure, orientation, typ := s.bin, s.measure, s.orientation, s.typ
	colorCap, scale := s.colorCap, s.scale
	lengthX, lengthY := p.geneLength(gene), p.geneLength(gene2)
	p.ensure(&s.load, p.contactKey(), func() (func(), error) {
		payload := core.Obj{"gene": gene, "gene2": gene2, "measure": "records", "orientation": "both"}
		if measure == measureReads {
			payload["measure"] = "reads"
		}
		if orientation == orientOriented {
			payload["orientation"] = "oriented"
		}
		if types := typesPayload(typ); types != nil {
			payload["types"] = types
		}
		if bin == binAuto {
			payload["bin_size"], payload["max_cells"] = 10, autoMaxCells
		} else {
			var size int
			fmt.Sscanf(bin, "%d", &size)
			payload["bin_size"], payload["max_cells"] = size, fixedMaxCells
		}
		got, err := p.query(path, "analysis_contact_bins", ids, payload)
		if err != nil {
			return nil, err
		}
		d := decodeContact(got, measure, orientation, typ, lengthX, lengthY)
		cells := d.cells(colorCap, scale)
		return func() {
			s.data = d
			s.heat.SetCells(cells, float64(d.lengthX), float64(d.lengthY))
			s.picked = -1
			if s.colorCap != colorCap || s.scale != scale {
				p.recolor() // changed while loading
			}
			if f := s.focus; f != nil {
				s.focus = nil
				p.focusCell(f[0], f[1], f[2], f[3])
			}
		}, nil
	})
}

func decodeContact(got map[string]any, measure, orientation, typ string, lengthX, lengthY int) *contactData {
	d := &contactData{
		gene: str(got["gene"]), gene2: str(got["gene2"]),
		bin: int(num(got["bin_size"])), requested: int(num(got["requested_bin_size"])),
		adjusted: got["adjusted"] == true, total: int(num(got["total"])), max: int(num(got["max"])),
		measure: measure, orientation: orientation, typ: typ,
		x: ints(got["x"]), y: ints(got["y"]), count: ints(got["count"]),
	}
	if d.bin <= 0 {
		d.bin = 10
	}
	n := min(len(d.x), len(d.y), len(d.count))
	d.x, d.y, d.count = d.x[:n], d.y[:n], d.count[:n]
	d.lengthX = max(lengthX, int(num(got["length"])))
	d.lengthY = max(lengthY, int(num(got["length2"])))
	d.at = make(map[[2]int]int, n)
	for i := range n {
		d.at[[2]int{d.x[i], d.y[i]}] = i
		d.lengthX = max(d.lengthX, d.x[i]+d.bin)
		d.lengthY = max(d.lengthY, d.y[i]+d.bin)
	}
	d.sorted = append([]int(nil), d.count...)
	sort.Ints(d.sorted)
	return d
}

func str(v any) string { s, _ := v.(string); return s }

// colorCap is the count at which colours saturate.
func (d *contactData) colorCap(choice string) float64 {
	if len(d.sorted) == 0 {
		return 1
	}
	fraction := 0.95
	for i, label := range capOptions {
		if label == choice {
			fraction = capFractions[i]
		}
	}
	// linear interpolation between ranks, as the web page's quantile
	pos := float64(len(d.sorted)-1) * fraction
	lo, hi := int(math.Floor(pos)), int(math.Ceil(pos))
	v := float64(d.sorted[lo]) + (float64(d.sorted[hi])-float64(d.sorted[lo]))*(pos-float64(lo))
	return math.Max(v, 1)
}

// cells colours every cell by its count: viridis up to the cap.
func (d *contactData) cells(choice, scale string) []widgets.Cell {
	limit := d.colorCap(choice)
	out := make([]widgets.Cell, len(d.count))
	for i, n := range d.count {
		f := math.Min(float64(n)/limit, 1)
		if scale == scaleLog {
			f = math.Min(math.Log1p(float64(n))/math.Log1p(limit), 1)
		}
		out[i] = widgets.Cell{X: float64(d.x[i]), Y: float64(d.y[i]), W: float64(d.bin), H: float64(d.bin), Color: viridis(f)}
	}
	return out
}

// viridis maps [0, 1] to the viridis colour map (matplotlib anchors).
func viridis(f float64) ui.Color {
	stops := [][3]float64{{68, 1, 84}, {71, 44, 122}, {59, 81, 139}, {44, 113, 142}, {33, 144, 141},
		{39, 173, 129}, {92, 200, 99}, {170, 220, 50}, {253, 231, 37}}
	f = math.Max(0, math.Min(1, f)) * float64(len(stops)-1)
	i := int(math.Floor(f))
	if i >= len(stops)-1 {
		i = len(stops) - 2
	}
	t := f - float64(i)
	mix := func(k int) uint8 { return uint8(math.Round(stops[i][k] + (stops[i+1][k]-stops[i][k])*t)) }
	return ui.RGB(mix(0), mix(1), mix(2))
}

// cellRange is the inclusive gene range of a bin starting at x.
func cellRange(x, bin int) (int, int) { return max(1, x), x + bin - 1 }

func (p *explorePage) contactView(c *ui.Context) {
	s := &p.cm
	t := c.Theme()
	p.loadContact()
	genes := p.genes()
	ui.Scroll(c).Grow(1).Children(func() {
		ui.Column(c).Gap(14).Children(func() {
			ui.Row(c).Gap(12).Wrap().AlignItems(ui.End).Children(func() {
				if len(genes) > 1 {
					picker(c, "cm-gene2", "Partner on Y", &s.gene2, genes, 200)
				}
				picker(c, "cm-bin", "Bin size", &s.bin, binOptions, 92)
				picker(c, "cm-measure", "Measure", &s.measure, measures, 100)
				picker(c, "cm-orientation", "Orientation", &s.orientation, orientations, 150)
				picker(c, "cm-type", "Chimera type", &s.typ, withAll(allTypes, p.summary.types), 120)
			})
			loadingLine(c, &s.load, "the contact map")
			d := s.data
			if d == nil {
				return
			}
			if d.adjusted && s.bin == binAuto {
				notice(c, fmt.Sprintf("Auto bin: %d nt, so the map stays within %s cells.", d.bin, FormatNumber(autoMaxCells)))
			} else if d.adjusted {
				notice(c, fmt.Sprintf("The bin size was increased from %d to %d nt so the map stays within %s cells.",
					d.requested, d.bin, FormatNumber(fixedMaxCells)))
			}
			if len(d.count) == 0 {
				ui.Text(c, "No hybrids between these genes with these settings.").TextColor(t.TextMuted)
				return
			}
			ui.Row(c).Gap(20).AlignItems(ui.Start).Wrap().Children(func() {
				ui.Column(c).Gap(6).Children(func() {
					ev := s.heat.Show(c, mapSizeTarget, "Contact map of "+d.gene)
					if ev.Clicked >= 0 {
						s.picked = ev.Clicked
					}
					s.hover = ""
					if ev.Hover {
						s.hover = d.readout(ev.X, ev.Y)
					}
					ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
						hint := "Wheel zooms, drag pans, double-click resets. Click a cell for details."
						if s.hover != "" {
							hint = s.hover
						}
						ui.Text(c, hint).FontSize(12).TextColor(t.TextMuted).Grow(1).SingleLine().MaxWidth(mapSizeTarget - 40)
						if s.heat.Zoomed() && ui.Button(c, "Reset zoom").Clicked() {
							s.heat.ResetZoom()
						}
					})
				})
				ui.Column(c).Gap(12).Width(300).Children(func() {
					p.contactLegend(c, d)
					p.contactDetails(c, d)
				})
			})
		})
	})
}

func (p *explorePage) recolor() {
	s := &p.cm
	if s.data == nil {
		return
	}
	view, picked := s.heat.View(), s.heat.Picked
	s.heat.SetCells(s.data.cells(s.colorCap, s.scale), float64(s.data.lengthX), float64(s.data.lengthY))
	s.heat.SetView(view)
	s.heat.Picked = picked
}

// readout describes the cell under the pointer.
func (d *contactData) readout(gx, gy float64) string {
	if gx < 0 || gy < 0 {
		return ""
	}
	x := int(gx) / d.bin * d.bin
	y := int(gy) / d.bin * d.bin
	n := 0
	if i, ok := d.at[[2]int{x, y}]; ok {
		n = d.count[i]
	}
	x0, x1 := cellRange(x, d.bin)
	y0, y1 := cellRange(y, d.bin)
	return fmt.Sprintf("Arm 1 %s · arm 2 %s · %s %s", span(x0, x1), span(y0, y1), FormatNumber(int64(n)), strings.ToLower(d.measure))
}

func (p *explorePage) contactLegend(c *ui.Context, d *contactData) {
	s := &p.cm
	t := c.Theme()
	Card(c, "", func() {
		ui.Row(c).Gap(16).Wrap().Children(func() {
			stat(c, "Bin", fmt.Sprintf("%d nt", d.bin))
			stat(c, "Cells", FormatNumber(int64(len(d.count))))
			stat(c, "Hybrids drawn", FormatNumber(int64(d.total)))
		})
		ui.Row(c).Gap(10).Wrap().Children(func() {
			picker(c, "cm-cap", "Colour cap", &s.colorCap, capOptions, 145).OnChange(p.recolor)
			picker(c, "cm-scale", "Scale", &s.scale, scaleOptions, 84).OnChange(p.recolor)
		})
		limit := d.colorCap(s.colorCap)
		ui.Column(c).Gap(4).Children(func() {
			ui.Box(c).FillWidth().Height(10).Radius(3).Draw(func(pt *ui.Painter, r ui.Rect) {
				steps := 48
				for i := range steps {
					w := r.W / float32(steps)
					pt.Fill(ui.Rect{X: r.X + float32(i)*w, Y: r.Y, W: w + 0.5, H: r.H}, viridis(float64(i)/float64(steps-1)), 0)
				}
			})
			ui.Row(c).Children(func() {
				ui.Text(c, "1").FontSize(11).TextColor(t.TextMuted).Grow(1)
				ui.Text(c, fmt.Sprintf("≥ %s %s (max %s)", formatCount(limit), strings.ToLower(d.measure), FormatNumber(int64(d.max)))).
					FontSize(11).TextColor(t.TextMuted)
			})
		})
		ui.Row(c).Gap(8).Wrap().Children(func() {
			if ui.Button(c, "Export SVG…").Tooltip("Save the map as shown (cells in view)").Clicked() {
				p.exportContactSVG()
			}
			if ui.Button(c, "Export TSV…").Tooltip("Save the cells in view as a tab-separated file").Clicked() {
				p.exportContactTSV()
			}
		})
	})
}

func formatCount(v float64) string {
	if v == math.Trunc(v) {
		return FormatNumber(int64(v))
	}
	return fmt.Sprintf("%.1f", v)
}

func (p *explorePage) contactDetails(c *ui.Context, d *contactData) {
	s := &p.cm
	t := c.Theme()
	Card(c, "Selected cell", func() {
		if s.picked < 0 || s.picked >= len(d.count) {
			ui.Text(c, "Click a cell of the map to see its hybrids or fold its region.").TextColor(t.TextMuted)
			return
		}
		x0, x1 := cellRange(d.x[s.picked], d.bin)
		y0, y1 := cellRange(d.y[s.picked], d.bin)
		genes := shortGene(d.gene)
		if d.gene2 != d.gene {
			genes += " × " + shortGene(d.gene2)
		}
		ui.Text(c, genes).FontSize(12).TextColor(t.TextMuted)
		for _, line := range [][2]string{{"Arm 1 (X)", span(x0, x1)}, {"Arm 2 (Y)", span(y0, y1)},
			{d.measure, FormatNumber(int64(d.count[s.picked]))}} {
			ui.Row(c.Key(line[0])).Gap(8).Children(func() {
				ui.Text(c, line[0]).TextColor(t.TextMuted).Width(80)
				ui.Text(c, line[1]).Bold()
			})
		}
		ui.Row(c).Gap(8).Wrap().Children(func() {
			if ui.PrimaryButton(c, "Show hybrids").Clicked() {
				p.showCellHybrids(d, x0, x1, y0, y1)
			}
			if ui.Button(c, "Fold this region").Tooltip("Open Structure with a window around this cell").Clicked() {
				p.foldCell(d, s.picked)
			}
		})
		if d.orientation == orientBoth && d.gene != d.gene2 {
			ui.Text(c, "Show hybrids lists arm 1 on "+shortGene(d.gene)+"; the map also counts the reverse order.").
				FontSize(12).TextColor(t.TextMuted)
		}
	})
}

// showCellHybrids switches to Interactions filtered to the cell's ranges.
func (p *explorePage) showCellHybrids(d *contactData, x0, x1, y0, y1 int) {
	f := ixFilters{gene1: d.gene, gene2: d.gene2, typ: d.typ, x0: x0, x1: x1, y0: y0, y1: y1, minReads: 1}
	p.ix.apply(f)
	p.tab = tabInteractions
}

// foldCell opens Structure with each arm's bin padded by max(50, 2 bins)
// and clamped to the gene: one window spanning both arms on one gene, else
// arm 1's window (as the web page's fold request).
func (p *explorePage) foldCell(d *contactData, i int) {
	pad := max(50, 2*d.bin)
	clamp := func(start, end, length int) [2]int {
		start = max(1, start)
		if length > 0 {
			end = min(end, length)
		}
		return [2]int{start, end}
	}
	lengthX := p.geneLength(d.gene)
	if lengthX == 0 {
		lengthX = d.lengthX
	}
	lengthY := p.geneLength(d.gene2)
	if lengthY == 0 {
		lengthY = d.lengthY
	}
	first := clamp(d.x[i]-pad, d.x[i]+d.bin-1+pad, lengthX)
	second := clamp(d.y[i]-pad, d.y[i]+d.bin-1+pad, lengthY)
	window := first
	if d.gene == d.gene2 {
		window = [2]int{min(first[0], second[0]), max(first[1], second[1])}
	}
	p.foldPrefill(d.gene, [][2]int{window}, "contact map")
}

// focusCell picks the cell holding (x, y) and zooms to the range around it.
func (p *explorePage) focusCell(x, y, xEnd, yEnd int) {
	s := &p.cm
	d := s.data
	if d == nil {
		return
	}
	if i, ok := d.at[[2]int{x / d.bin * d.bin, y / d.bin * d.bin}]; ok {
		s.picked, s.heat.Picked = i, i
	}
	half := float64(max(10*d.bin, 200, xEnd-x, yEnd-y))
	cx, cy := float64(x+max(xEnd, x))/2, float64(y+max(yEnd, y))/2
	s.heat.SetView(widgets.Window{X0: cx - half, X1: cx + half, Y0: cy - half, Y1: cy + half})
}
