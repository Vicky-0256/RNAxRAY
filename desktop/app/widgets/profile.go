package widgets

import (
	"fmt"
	"math"
	"sort"

	"github.com/egoist/mygo/ui"
)

// Profile is a coverage plot along one gene: consecutive bins [start, end]
// (gene coordinates, inclusive) with a value each, drawn as bars. Keep it in
// the page's state; Set replaces the data and Show builds it.
//
// Bins thinner than a pixel are merged per pixel column (the column shows
// the largest value), so tens of thousands of bins cost a few hundred
// rectangles a frame.
type Profile struct {
	starts, ends []int
	values       []float64
	max          float64
	// Picked is the index of the chosen bin, -1 for none.
	Picked int
}

// NewProfile makes an empty plot.
func NewProfile() *Profile { return &Profile{Picked: -1} }

// Set replaces the bins (parallel slices) and clears the choice.
func (p *Profile) Set(starts, ends []int, values []float64) {
	n := min(len(starts), len(ends), len(values))
	p.starts, p.ends, p.values = starts[:n], ends[:n], values[:n]
	p.max = 0
	for _, v := range p.values {
		p.max = math.Max(p.max, v)
	}
	p.Picked = -1
}

// Len is the number of bins.
func (p *Profile) Len() int { return len(p.values) }

// Bin returns bin i.
func (p *Profile) Bin(i int) (start, end int, value float64) {
	return p.starts[i], p.ends[i], p.values[i]
}

// Max is the largest value.
func (p *Profile) Max() float64 { return p.max }

// ProfileEvent reports what the user did in a frame: bin indexes, -1 for none.
type ProfileEvent struct {
	Clicked, Hover int
}

const profileAxis = 48

func (p *Profile) span() (float64, float64) {
	if len(p.starts) == 0 {
		return 0, 1
	}
	return float64(p.starts[0]), float64(p.ends[len(p.ends)-1] + 1)
}

// binAt returns the bin under local x in a plot of width w, or -1.
func (p *Profile) binAt(x, w float32) int {
	if len(p.values) == 0 || w <= 0 {
		return -1
	}
	lo, hi := p.span()
	pos := lo + float64(x/w)*(hi-lo)
	i := sort.Search(len(p.ends), func(i int) bool { return float64(p.ends[i]) >= pos-0.5 })
	if i >= len(p.ends) {
		return -1
	}
	return i
}

// Show builds the plot, as wide as its parent and height h tall (DIPs),
// with a value axis on the left and gene coordinates below. A click picks
// the bin under the pointer.
func (p *Profile) Show(c *ui.Context, h float32, label string, color ui.Color) ProfileEvent {
	t := c.Theme()
	event := ProfileEvent{Clicked: -1, Hover: -1}
	box := ui.Box(c.Key("profile")).FillWidth().Height(h + 22).Cursor(ui.CursorCrosshair).Role(ui.RoleImage).Label(label)
	bounds := box.Bounds()
	plotW := bounds.W - profileAxis
	if px, py, over := box.PointerPosition(); over && px >= profileAxis && py <= h {
		event.Hover = p.binAt(px-profileAxis, plotW)
		if box.Clicked() && event.Hover >= 0 {
			p.Picked = event.Hover
			event.Clicked = event.Hover
		}
	}
	box.Draw(func(pt *ui.Painter, r ui.Rect) {
		area := ui.Rect{X: r.X + profileAxis, Y: r.Y, W: r.W - profileAxis, H: h}
		pt.Fill(area, t.Surface, 2)
		if len(p.values) > 0 && p.max > 0 && area.W > 0 {
			lo, hi := p.span()
			scale := float64(area.W) / (hi - lo)
			columns := int(math.Ceil(float64(area.W)))
			tops := make([]float64, columns+1)
			for i, v := range p.values {
				x0 := int((float64(p.starts[i]) - lo) * scale)
				x1 := int((float64(p.ends[i]+1) - lo) * scale)
				for x := max(x0, 0); x <= min(max(x1-1, x0), columns); x++ {
					tops[x] = math.Max(tops[x], v)
				}
			}
			for x, v := range tops {
				if v <= 0 {
					continue
				}
				bh := float32(v / p.max * float64(area.H-4))
				pt.Fill(ui.Rect{X: area.X + float32(x), Y: area.Y + area.H - bh, W: 1, H: bh}, color, 0)
			}
			if p.Picked >= 0 && p.Picked < len(p.values) {
				x0 := float32((float64(p.starts[p.Picked]) - lo) * scale)
				x1 := float32((float64(p.ends[p.Picked]+1) - lo) * scale)
				pt.Stroke(ui.Rect{X: area.X + x0 - 1, Y: area.Y + 1, W: max(x1-x0, 1) + 2, H: area.H - 2}, t.Text, 1, 1.5)
			}
			p.drawAxes(pt, r, area, t)
		}
		pt.Stroke(area, t.Border, 2, 1)
	})
	return event
}

func (p *Profile) drawAxes(pt *ui.Painter, r, area ui.Rect, t *ui.Theme) {
	lo, hi := p.span()
	for _, x := range niceTicks(lo, hi) {
		px := area.X + float32((x-lo)/(hi-lo))*area.W
		pt.Line(px, area.Y+area.H, px, area.Y+area.H+4, 1, t.Border)
		label := fmt.Sprint(int(x))
		pt.Text(px-float32(len(label))*3, area.Y+area.H+16, label, 10, t.TextMuted)
	}
	for _, v := range []float64{0, p.max / 2, p.max} {
		py := area.Y + area.H - float32(v/p.max)*(area.H-4)
		pt.Line(area.X-4, py, area.X, py, 1, t.Border)
		pt.Text(r.X+2, py+3, formatValue(v), 10, t.TextMuted)
	}
}

func formatValue(v float64) string {
	switch {
	case v >= 1e6:
		return fmt.Sprintf("%.1fM", v/1e6)
	case v >= 1e4:
		return fmt.Sprintf("%.0fk", v/1e3)
	case v == math.Trunc(v):
		return fmt.Sprint(int64(v))
	case v >= 10:
		return fmt.Sprintf("%.0f", v)
	}
	return fmt.Sprintf("%.2g", v)
}

// niceTicks returns about five round positions in [a0, a1].
func niceTicks(a0, a1 float64) []float64 {
	span := a1 - a0
	if span <= 0 {
		return nil
	}
	step := math.Pow(10, math.Floor(math.Log10(span/5)))
	for _, m := range []float64{1, 2, 5, 10} {
		if span/(step*m) <= 6 {
			step *= m
			break
		}
	}
	var out []float64
	for x := math.Ceil(a0/step) * step; x <= a1; x += step {
		out = append(out, x)
	}
	return out
}
