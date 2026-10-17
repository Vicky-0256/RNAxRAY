// Package widgets holds the drawing widgets several pages share: the
// contact heatmap (Explore, Compare) and the arc diagram (Structure).
package widgets

import (
	"fmt"
	"math"

	"github.com/egoist/mygo/ui"
)

// Cell is one square of a contact map in gene coordinates: arm 1 [X, X+W)
// on the horizontal axis, arm 2 [Y, Y+H) on the vertical one.
type Cell struct {
	X, Y, W, H float64
	Color      ui.Color
}

// Window is a range of gene coordinates on both axes.
type Window struct{ X0, X1, Y0, Y1 float64 }

// Heatmap is the state of one contact-map view: its cells, the zoom window
// and the cell picked. Keep it in the page's state; Show builds it.
//
// Cells are painted into a GPU canvas once per change of data, window or
// size, so a map of hundreds of thousands of cells costs one image a frame.
type Heatmap struct {
	cells   []Cell
	version int
	lenX    float64
	lenY    float64
	view    Window

	canvas *ui.Canvas
	drawn  struct {
		version int
		view    Window
		w, h    int
		dark    bool
	}
	// Picked is the index of the highlighted cell, -1 for none.
	Picked int
	// Highlight, when W > 0, outlines a region (e.g. a merged interaction).
	Highlight Cell
	// MinCell is the smallest side (DIPs) a cell is drawn with, centred on
	// it; 0 draws cells at their size (at least one pixel).
	MinCell float32
	// Background, when not transparent, replaces the theme surface under
	// the cells (e.g. white for rnaxray's similarity heatmap).
	Background ui.Color

	dragging bool
	lastX    float32
	lastY    float32
}

// NewHeatmap makes an empty map.
func NewHeatmap() *Heatmap { return &Heatmap{Picked: -1} }

// SetCells replaces the data and resets the zoom to the whole lengths.
func (h *Heatmap) SetCells(cells []Cell, lengthX, lengthY float64) {
	h.cells = cells
	h.version++
	h.lenX, h.lenY = math.Max(lengthX, 1), math.Max(lengthY, 1)
	h.view = Window{0, h.lenX, 0, h.lenY}
	h.Picked = -1
}

// Cells returns the data shown.
func (h *Heatmap) Cells() []Cell { return h.cells }

// View returns the zoom window; SetView changes it (clamped).
func (h *Heatmap) View() Window { return h.view }

func (h *Heatmap) SetView(v Window) {
	h.view = h.clamp(v)
}

// ResetZoom shows the whole map.
func (h *Heatmap) ResetZoom() { h.view = Window{0, h.lenX, 0, h.lenY} }

// Zoomed reports whether a part of the map is shown.
func (h *Heatmap) Zoomed() bool {
	return h.view != (Window{0, h.lenX, 0, h.lenY})
}

func (h *Heatmap) clamp(v Window) Window {
	minSpan := 20.0
	clampAxis := func(a0, a1, length float64) (float64, float64) {
		span := math.Max(minSpan, math.Min(a1-a0, length))
		if a0 < 0 {
			a0 = 0
		}
		if a0+span > length {
			a0 = math.Max(0, length-span)
		}
		return a0, a0 + span
	}
	v.X0, v.X1 = clampAxis(v.X0, v.X1, h.lenX)
	v.Y0, v.Y1 = clampAxis(v.Y0, v.Y1, h.lenY)
	return v
}

// HeatEvent reports what the user did in a frame.
type HeatEvent struct {
	// Clicked is the index of the cell clicked, -1 for none.
	Clicked int
	// X, Y are the gene coordinates under the pointer when Hover is true.
	X, Y  float64
	Hover bool
}

const axisPad = 44

// Show builds the map as a square of side size (DIPs), with axes. Wheel
// zooms around the pointer, dragging pans, a double click resets the zoom,
// and a click picks the cell under the pointer.
func (h *Heatmap) Show(c *ui.Context, size float32, label string) HeatEvent {
	t := c.Theme()
	event := HeatEvent{Clicked: -1}
	box := ui.Box(c.Key("heatmap")).Size(size+axisPad, size+axisPad).Cursor(ui.CursorCrosshair).
		Role(ui.RoleImage).Label(label)
	plot := ui.Rect{X: axisPad, Y: 0, W: size, H: size}

	box.HandleInput(func(ev ui.InputEvent) bool {
		switch ev.Kind {
		case ui.InputScroll:
			if !plot.Contains(ev.X, ev.Y) {
				return false
			}
			factor := math.Pow(1.0015, float64(ev.DY))
			h.zoomAt(plot, ev.X, ev.Y, factor)
			return true
		}
		return false
	})
	if dx, dy, ok := box.Dragged(); ok && (dx != 0 || dy != 0) {
		h.dragging = true
		v := h.view
		sx := (v.X1 - v.X0) / float64(plot.W)
		sy := (v.Y1 - v.Y0) / float64(plot.H)
		h.SetView(Window{v.X0 - float64(dx)*sx, v.X1 - float64(dx)*sx, v.Y0 - float64(dy)*sy, v.Y1 - float64(dy)*sy})
	}
	if box.DoubleClicked() {
		h.ResetZoom()
	} else if box.Clicked() {
		if h.dragging {
			h.dragging = false
		} else if px, py, over := box.PointerPosition(); over && plot.Contains(px, py) {
			gx, gy := h.toGene(plot, px, py)
			// A cell drawn larger than it is (MinCell) is hit where it shows.
			padX := float64(h.MinCell/2) * (h.view.X1 - h.view.X0) / float64(plot.W)
			padY := float64(h.MinCell/2) * (h.view.Y1 - h.view.Y0) / float64(plot.H)
			if i := h.hit(gx, gy, padX, padY); i >= 0 {
				h.Picked = i
				event.Clicked = i
			}
		}
	}
	if !box.Pressed() {
		h.dragging = false
	}
	if px, py, over := box.PointerPosition(); over && plot.Contains(px, py) {
		event.X, event.Y = h.toGene(plot, px, py)
		event.Hover = true
	}

	dark := t.Background.R < 128
	box.Draw(func(p *ui.Painter, r ui.Rect) {
		area := ui.Rect{X: r.X + plot.X, Y: r.Y + plot.Y, W: plot.W, H: plot.H}
		background := t.Surface
		if h.Background.A > 0 {
			background = h.Background
		}
		p.Fill(area, background, 2)
		scale := p.Scale()
		w, hgt := int(math.Ceil(float64(area.W*scale))), int(math.Ceil(float64(area.H*scale)))
		if h.canvas == nil || h.drawn.w != w || h.drawn.h != hgt {
			h.canvas = ui.NewCanvas(w, hgt)
			h.drawn.version = -1
		}
		minCell := float64(h.MinCell * scale)
		if h.drawn.version != h.version || h.drawn.view != h.view || h.drawn.dark != dark {
			h.drawn.version, h.drawn.view, h.drawn.w, h.drawn.h, h.drawn.dark = h.version, h.view, w, hgt, dark
			v := h.view
			sx := float64(w) / (v.X1 - v.X0)
			sy := float64(hgt) / (v.Y1 - v.Y0)
			h.canvas.Draw(p, func(cp *ui.Painter) {
				for _, cell := range h.cells {
					if cell.X+cell.W < v.X0 || cell.X > v.X1 || cell.Y+cell.H < v.Y0 || cell.Y > v.Y1 {
						continue
					}
					cw, ch := math.Max(cell.W*sx, math.Max(minCell, 1)), math.Max(cell.H*sy, math.Max(minCell, 1))
					x := (cell.X-v.X0)*sx - (cw-cell.W*sx)/2
					y := (cell.Y-v.Y0)*sy - (ch-cell.H*sy)/2
					cp.Fill(ui.Rect{X: float32(x), Y: float32(y), W: float32(cw), H: float32(ch)}, cell.Color, 0)
				}
			})
		}
		p.Image(h.canvas.Bitmap(), area, ui.FillBox)
		p.Stroke(area, t.Border, 2, 1)
		h.drawMarks(p, area, t)
		h.drawAxes(p, r, area, t)
	})
	return event
}

func (h *Heatmap) toGene(plot ui.Rect, px, py float32) (float64, float64) {
	v := h.view
	gx := v.X0 + float64((px-plot.X)/plot.W)*(v.X1-v.X0)
	gy := v.Y0 + float64((py-plot.Y)/plot.H)*(v.Y1-v.Y0)
	return gx, gy
}

func (h *Heatmap) zoomAt(plot ui.Rect, px, py float32, factor float64) {
	gx, gy := h.toGene(plot, px, py)
	v := h.view
	h.SetView(Window{gx - (gx-v.X0)*factor, gx + (v.X1-gx)*factor, gy - (gy-v.Y0)*factor, gy + (v.Y1-gy)*factor})
}

// hit returns the last cell covering (x, y), widened by pad on each side
// up to its drawn size: drawn last, so on top.
func (h *Heatmap) hit(x, y, padX, padY float64) int {
	for i := len(h.cells) - 1; i >= 0; i-- {
		cell := h.cells[i]
		px, py := math.Max(padX-cell.W/2, 0), math.Max(padY-cell.H/2, 0)
		if x >= cell.X-px && x < cell.X+cell.W+px && y >= cell.Y-py && y < cell.Y+cell.H+py {
			return i
		}
	}
	return -1
}

func (h *Heatmap) mark(area ui.Rect, cell Cell, pad float64) (ui.Rect, bool) {
	v := h.view
	sx := float64(area.W) / (v.X1 - v.X0)
	sy := float64(area.H) / (v.Y1 - v.Y0)
	x0, x1 := cell.X-pad, cell.X+cell.W+pad
	y0, y1 := cell.Y-pad, cell.Y+cell.H+pad
	if x1 < v.X0 || x0 > v.X1 || y1 < v.Y0 || y0 > v.Y1 {
		return ui.Rect{}, false
	}
	r := ui.Rect{X: area.X + float32((x0-v.X0)*sx), Y: area.Y + float32((y0-v.Y0)*sy),
		W: float32(math.Max((x1-x0)*sx, 4)), H: float32(math.Max((y1-y0)*sy, 4))}
	return r, true
}

func (h *Heatmap) drawMarks(p *ui.Painter, area ui.Rect, t *ui.Theme) {
	p.Clip(area, 2, func() {
		if h.Highlight.W > 0 {
			if r, ok := h.mark(area, h.Highlight, 0); ok {
				p.Stroke(r, t.Text, 2, 2)
			}
		}
		if h.Picked >= 0 && h.Picked < len(h.cells) {
			if r, ok := h.mark(area, h.cells[h.Picked], 0); ok {
				r = ui.Rect{X: r.X - 3, Y: r.Y - 3, W: r.W + 6, H: r.H + 6}
				p.Stroke(r, t.Text, 2, 2)
			}
		}
	})
}

// drawAxes labels both axes with about five ticks in gene coordinates.
func (h *Heatmap) drawAxes(p *ui.Painter, r, area ui.Rect, t *ui.Theme) {
	v := h.view
	ticks := func(a0, a1 float64) []float64 {
		span := a1 - a0
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
	for _, x := range ticks(v.X0, v.X1) {
		px := area.X + float32((x-v.X0)/(v.X1-v.X0))*area.W
		p.Line(px, area.Y+area.H, px, area.Y+area.H+4, 1, t.Border)
		label := fmt.Sprint(int(x))
		p.Text(px-float32(len(label))*3, area.Y+area.H+16, label, 10, t.TextMuted)
	}
	for _, y := range ticks(v.Y0, v.Y1) {
		py := area.Y + float32((y-v.Y0)/(v.Y1-v.Y0))*area.H
		p.Line(area.X-4, py, area.X, py, 1, t.Border)
		label := fmt.Sprint(int(y))
		p.Text(r.X+2, py+3, label, 10, t.TextMuted)
	}
}
