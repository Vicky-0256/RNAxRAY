package widgets

import (
	"fmt"
	"math"

	"github.com/egoist/mygo/ui"
)

// Pair is a base pair in 1-based gene coordinates, I < J.
type Pair struct{ I, J int }

// Arcs draws one or two structures as arc diagrams over a gene: A's pairs
// above the baseline, B's below; pairs both have are drawn in the shared
// color. Wheel zooms along the gene, dragging pans, a double click resets.
type Arcs struct {
	A, B   []Pair
	Length int
	// WeightA/WeightB, aligned with A/B, are the pairs' chimera evidence
	// (HYB bonus); with Shade, an arc's opacity follows its weight.
	WeightA, WeightB []float64
	Shade            bool
	// Start/End are the visible range (1-based, inclusive).
	Start, End float64
	// Region, when End > Start, shades a region (e.g. a folded window).
	RegionStart, RegionEnd int
	// Overlay are extra arcs drawn over the structures (e.g. differential
	// interactions): Up ones above the baseline, the others below.
	Overlay []OverlayArc
	// Mono, when not transparent, draws both structures in this one colour
	// (so Overlay colours stand out, as in a PARIS-style arc map).
	Mono ui.Color
	// Features is a gene track drawn under the arcs (e.g. mature peptides).
	Features []Feature

	shared map[Pair]bool
	keyed  struct{ a, b int }
}

// OverlayArc is one extra arc (1-based positions, I < J).
type OverlayArc struct {
	I, J  int
	Up    bool
	Color ui.Color
	Width float32
}

// Feature is one block of the gene track (1-based, inclusive).
type Feature struct {
	Start, End int
	Name       string
}

// trackHeight is the gene track's height (DIPs) when Features is set.
const trackHeight = 16

// Set replaces the structures and shows the whole gene.
func (s *Arcs) Set(a, b []Pair, length int) {
	s.A, s.B, s.Length = a, b, length
	s.Start, s.End = 1, float64(length)
	s.shared = nil
}

// Shared counts the pairs present in both structures.
func (s *Arcs) Shared() int {
	s.index()
	return len(s.shared)
}

func (s *Arcs) index() {
	if s.shared != nil && s.keyed.a == len(s.A) && s.keyed.b == len(s.B) {
		return
	}
	inA := make(map[Pair]bool, len(s.A))
	for _, p := range s.A {
		inA[p] = true
	}
	s.shared = map[Pair]bool{}
	for _, p := range s.B {
		if inA[p] {
			s.shared[p] = true
		}
	}
	s.keyed.a, s.keyed.b = len(s.A), len(s.B)
}

// ArcEvent reports the gene position under the pointer.
type ArcEvent struct {
	Position int
	Hover    bool
}

// Show builds the diagram, filling the width it is given, height h DIPs.
func (s *Arcs) Show(c *ui.Context, h float32, colorA, colorB, colorShared ui.Color, label string) ArcEvent {
	t := c.Theme()
	s.index()
	if s.End <= s.Start {
		s.Start, s.End = 1, math.Max(float64(s.Length), 2)
	}
	box := ui.Box(c.Key("arcs")).FillWidth().Height(h).Cursor(ui.CursorCrosshair).Role(ui.RoleImage).Label(label)
	var width float32
	if b := box.Bounds(); b.W > 0 {
		width = b.W
	}
	box.HandleInput(func(ev ui.InputEvent) bool {
		if ev.Kind != ui.InputScroll || width <= 0 {
			return false
		}
		at := s.Start + float64(ev.X/width)*(s.End-s.Start)
		factor := math.Pow(1.0015, float64(ev.DY))
		s.setRange(at-(at-s.Start)*factor, at+(s.End-at)*factor)
		return true
	})
	if dx, _, ok := box.Dragged(); ok && dx != 0 && width > 0 {
		shift := -float64(dx) / float64(width) * (s.End - s.Start)
		s.setRange(s.Start+shift, s.End+shift)
	}
	if box.DoubleClicked() {
		s.setRange(1, float64(s.Length))
	}
	event := ArcEvent{}
	if px, _, over := box.PointerPosition(); over && width > 0 {
		event.Position = int(math.Round(s.Start + float64(px/width)*(s.End-s.Start)))
		event.Hover = true
	}
	box.Draw(func(p *ui.Painter, r ui.Rect) {
		p.Fill(r, t.Surface, 6)
		track := float32(0)
		if len(s.Features) > 0 {
			track = trackHeight + 4
		}
		below := len(s.B) > 0
		for _, o := range s.Overlay {
			below = below || !o.Up
		}
		base := r.Y + (r.H-track)/2
		if !below {
			base = r.Y + r.H - 22 - track
		}
		span := s.End - s.Start
		x := func(pos int) float32 { return r.X + float32((float64(pos)-s.Start)/span)*r.W }
		p.Clip(r, 6, func() {
			if s.RegionEnd > s.RegionStart {
				x0, x1 := x(s.RegionStart), x(s.RegionEnd)
				p.Fill(ui.Rect{X: x0, Y: r.Y, W: x1 - x0, H: r.H}, t.Accent.Alpha(0.08), 0)
			}
			maxUp := base - r.Y - 6
			maxDown := r.Y + r.H - base - 22 - track
			// With Shade, arcs go into five opacity buckets by weight (one
			// path each), from 0.12 for no evidence to 1 for the strongest.
			maxWeight := 0.0
			if s.Shade {
				for _, ws := range [][]float64{s.WeightA, s.WeightB} {
					for _, w := range ws {
						maxWeight = math.Max(maxWeight, w)
					}
				}
			}
			const buckets = 5
			bucket := func(weights []float64, index int) int {
				if maxWeight <= 0 || index >= len(weights) {
					return buckets - 1
				}
				b := int(math.Ceil(weights[index] / maxWeight * (buckets - 1)))
				return max(0, min(buckets-1, b))
			}
			draw := func(pairs []Pair, up bool, color ui.Color, onlyShared bool) {
				weights := s.WeightA
				if !up {
					weights = s.WeightB
				}
				var paths [buckets]ui.Path
				var counts [buckets]int
				for index, pr := range pairs {
					if float64(pr.J) < s.Start || float64(pr.I) > s.End {
						continue
					}
					if s.shared[pr] != onlyShared {
						continue
					}
					x0, x1 := x(pr.I), x(pr.J)
					height := (x1 - x0) / 2
					limit := maxUp
					if !up {
						limit = maxDown
					}
					if height > limit {
						height = limit
					}
					dir := float32(-1)
					if !up {
						dir = 1
					}
					// A half ellipse from two cubic curves.
					k := float32(0.5523)
					mid := (x0 + x1) / 2
					rx := (x1 - x0) / 2
					b := bucket(weights, index)
					paths[b].MoveTo(x0, base).
						CubeTo(x0, base+dir*height*k, mid-rx*k, base+dir*height, mid, base+dir*height).
						CubeTo(mid+rx*k, base+dir*height, x1, base+dir*height*k, x1, base)
					counts[b]++
				}
				for b := range buckets {
					if counts[b] > 0 {
						alpha := float32(0.12 + 0.88*float64(b)/(buckets-1))
						if maxWeight <= 0 {
							alpha = 1
						}
						p.StrokePath(&paths[b], 1, color.Alpha(alpha))
					}
				}
			}
			if s.Mono.A > 0 {
				colorA, colorB, colorShared = s.Mono, s.Mono, s.Mono
			}
			draw(s.A, true, colorA, false)
			draw(s.B, false, colorB, false)
			draw(s.A, true, colorShared, true)
			draw(s.B, false, colorShared, true)
			// Overlay arcs on top, one path per colour, width and side.
			type overlayKey struct {
				color ui.Color
				width float32
				up    bool
			}
			overlay := map[overlayKey]*ui.Path{}
			var order []overlayKey
			for _, o := range s.Overlay {
				if float64(o.J) < s.Start || float64(o.I) > s.End {
					continue
				}
				key := overlayKey{o.Color, max(o.Width, 1), o.Up}
				path := overlay[key]
				if path == nil {
					path = &ui.Path{}
					overlay[key] = path
					order = append(order, key)
				}
				x0, x1 := x(o.I), x(o.J)
				limit, dir := maxUp, float32(-1)
				if !o.Up {
					limit, dir = maxDown, 1
				}
				// height grows with the span relative to the visible width,
				// so long-range interactions stay arcs instead of flat caps
				height := limit * min(1, 0.06+0.94*(x1-x0)/r.W)
				k := float32(0.5523)
				mid, rx := (x0+x1)/2, (x1-x0)/2
				path.MoveTo(x0, base).
					CubeTo(x0, base+dir*height*k, mid-rx*k, base+dir*height, mid, base+dir*height).
					CubeTo(mid+rx*k, base+dir*height, x1, base+dir*height*k, x1, base)
			}
			for _, key := range order {
				p.StrokePath(overlay[key], key.width, key.color)
			}
			p.Line(r.X, base, r.X+r.W, base, 1, t.Border)
			// Gene track: alternating blocks with their names where they fit.
			if track > 0 {
				y := r.Y + r.H - 22 - trackHeight
				for index, f := range s.Features {
					if float64(f.End) < s.Start || float64(f.Start) > s.End {
						continue
					}
					x0, x1 := x(f.Start), x(f.End+1)
					fill := t.TextMuted.Alpha(0.22)
					if index%2 == 1 {
						fill = t.TextMuted.Alpha(0.38)
					}
					p.Fill(ui.Rect{X: x0, Y: y, W: max(x1-x0, 1), H: trackHeight}, fill, 0)
					if width := float32(len(f.Name)) * 6; f.Name != "" && x1-x0 > width+4 {
						p.Text((x0+x1)/2-width/2, y+trackHeight-4, f.Name, 10, t.Text)
					}
				}
			}
		})
		// Ticks along the bottom.
		step := math.Pow(10, math.Floor(math.Log10(span/5)))
		for _, m := range []float64{1, 2, 5, 10} {
			if span/(step*m) <= 8 {
				step *= m
				break
			}
		}
		for pos := math.Ceil(s.Start/step) * step; pos <= s.End; pos += step {
			px := x(int(pos))
			p.Line(px, r.Y+r.H-18, px, r.Y+r.H-14, 1, t.Border)
			label := fmt.Sprint(int(pos))
			p.Text(px-float32(len(label))*3, r.Y+r.H-3, label, 10, t.TextMuted)
		}
	})
	return event
}

func (s *Arcs) setRange(start, end float64) {
	length := math.Max(float64(s.Length), 2)
	span := math.Max(20, math.Min(end-start, length-1))
	if start < 1 {
		start = 1
	}
	if start+span > length {
		start = length - span
	}
	s.Start, s.End = start, start+span
}
