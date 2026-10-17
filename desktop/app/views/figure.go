package views

// figure: a small vector drawing (lines, polygons, circles, text) in its own
// coordinates, painted on screen by a ui.Painter and written to SVG by the
// exports, so a page and its exported file draw the same shapes. The
// Compare page's region diagrams and folding-energy violins are built as
// figures (compare_panels_plot.go).

import (
	"fmt"
	"math"
	"strings"

	"github.com/egoist/mygo/ui"
)

type figKind uint8

const (
	figLine   figKind = iota // open polyline through Pts
	figPoly                  // closed polygon
	figCircle                // circle at Pts[0], radius R
	figText                  // Text with its baseline at Pts[0]
)

type figPt struct{ X, Y float32 }

type figShape struct {
	Kind   figKind
	Pts    []figPt
	R      float32
	Stroke ui.Color // zero alpha: none
	Fill   ui.Color // zero alpha: none
	Width  float32
	Dash   bool
	Text   string
	Size   float32
	Anchor int // -1 start, 0 middle, 1 end
	Bold   bool
}

// figure is W x H units of shapes.
type figure struct {
	W, H   float32
	Shapes []figShape
}

// figPalette are the colours a figure is built with: the theme's on
// screen, figLight in exported files.
type figPalette struct {
	Text, Muted, Faint, Border, Background ui.Color
	A, B                                   ui.Color // conditions A and B
}

func figPaletteOf(t *ui.Theme) figPalette {
	a, b := condColors(t)
	return figPalette{Text: t.Text, Muted: t.TextMuted, Faint: t.TextMuted.Alpha(0.35), Border: t.Border, Background: t.Background, A: a, B: b}
}

// condition is the color of condition A (0) or B (1).
func (p figPalette) condition(k int) ui.Color {
	if k == 1 {
		return p.B
	}
	return p.A
}

// figLight is the palette of exported SVG files (white paper).
var figLight = figPalette{Text: ui.RGB(51, 51, 51), Muted: ui.RGB(107, 114, 128), Faint: ui.RGB(200, 204, 211),
	Border: ui.RGB(201, 206, 214), Background: ui.RGB(255, 255, 255), A: cmpRed, B: cmpBlue}

func (f *figure) line(stroke ui.Color, width float32, pts ...figPt) {
	f.Shapes = append(f.Shapes, figShape{Kind: figLine, Pts: pts, Stroke: stroke, Width: width})
}

func (f *figure) dashed(stroke ui.Color, width float32, pts ...figPt) {
	f.Shapes = append(f.Shapes, figShape{Kind: figLine, Pts: pts, Stroke: stroke, Width: width, Dash: true})
}

func (f *figure) poly(fill, stroke ui.Color, width float32, pts ...figPt) {
	f.Shapes = append(f.Shapes, figShape{Kind: figPoly, Pts: pts, Fill: fill, Stroke: stroke, Width: width})
}

func (f *figure) circle(x, y, r float32, fill, stroke ui.Color, width float32) {
	f.Shapes = append(f.Shapes, figShape{Kind: figCircle, Pts: []figPt{{x, y}}, R: r, Fill: fill, Stroke: stroke, Width: width})
}

func (f *figure) text(x, y float32, s string, size float32, color ui.Color, anchor int, bold bool) {
	f.Shapes = append(f.Shapes, figShape{Kind: figText, Pts: []figPt{{x, y}}, Text: s, Size: size, Fill: color, Anchor: anchor, Bold: bold})
}

// figTextWidth estimates the width of a label (the painter has no measure).
func figTextWidth(s string, size float32) float32 {
	return float32(len([]rune(s))) * size * 0.56
}

// fit is the scale and offset that fit the figure in r, centred.
func (f *figure) fit(r ui.Rect) (scale, ox, oy float32) {
	if f.W <= 0 || f.H <= 0 {
		return 1, r.X, r.Y
	}
	scale = min(r.W/f.W, r.H/f.H)
	return scale, r.X + (r.W-f.W*scale)/2, r.Y + (r.H-f.H*scale)/2
}

// paint draws the figure scaled into r.
func (f *figure) paint(p *ui.Painter, r ui.Rect) {
	s, ox, oy := f.fit(r)
	at := func(q figPt) (float32, float32) { return ox + q.X*s, oy + q.Y*s }
	for i := range f.Shapes {
		sh := &f.Shapes[i]
		switch sh.Kind {
		case figLine, figPoly:
			if len(sh.Pts) < 2 {
				continue
			}
			if sh.Dash {
				for k := 0; k+1 < len(sh.Pts); k++ {
					x0, y0 := at(sh.Pts[k])
					x1, y1 := at(sh.Pts[k+1])
					figDashes(p, x0, y0, x1, y1, max(sh.Width*s, 1), sh.Stroke)
				}
				continue
			}
			var path ui.Path
			x, y := at(sh.Pts[0])
			path.MoveTo(x, y)
			for _, q := range sh.Pts[1:] {
				x, y = at(q)
				path.LineTo(x, y)
			}
			if sh.Kind == figPoly {
				path.Close()
				if sh.Fill.A > 0 {
					p.FillPath(&path, sh.Fill)
				}
			}
			if sh.Stroke.A > 0 && sh.Width > 0 {
				p.StrokePath(&path, max(sh.Width*s, 0.75), sh.Stroke)
			}
		case figCircle:
			x, y := at(sh.Pts[0])
			var path ui.Path
			path.Circle(x, y, max(sh.R*s, 1))
			if sh.Fill.A > 0 {
				p.FillPath(&path, sh.Fill)
			}
			if sh.Stroke.A > 0 && sh.Width > 0 {
				p.StrokePath(&path, max(sh.Width*s, 0.75), sh.Stroke)
			}
		case figText:
			x, y := at(sh.Pts[0])
			size := max(sh.Size*s, 8)
			w := figTextWidth(sh.Text, size)
			switch sh.Anchor {
			case 0:
				x -= w / 2
			case 1:
				x -= w
			}
			p.Text(x, y-size*0.95, sh.Text, size, sh.Fill)
		}
	}
}

func figDashes(p *ui.Painter, x0, y0, x1, y1, width float32, c ui.Color) {
	dx, dy := x1-x0, y1-y0
	length := float32(math.Hypot(float64(dx), float64(dy)))
	if length <= 0 {
		return
	}
	const on, off = 3, 3
	for d := float32(0); d < length; d += on + off {
		e := min(d+on, length)
		p.Line(x0+dx*d/length, y0+dy*d/length, x0+dx*e/length, y0+dy*e/length, width, c)
	}
}

// svg writes the figure's shapes as SVG elements in figure units, inside a
// group translated to (x, y) and scaled by scale.
func (f *figure) svg(b *strings.Builder, x, y, scale float64) {
	fmt.Fprintf(b, `<g transform="translate(%s %s) scale(%s)">`, svgNum(x), svgNum(y), strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.4f", scale), "0"), "."))
	pts := func(list []figPt) string {
		out := make([]string, len(list))
		for i, q := range list {
			out[i] = svgNum(float64(q.X)) + "," + svgNum(float64(q.Y))
		}
		return strings.Join(out, " ")
	}
	stroke := func(sh *figShape) string {
		if sh.Stroke.A == 0 || sh.Width <= 0 {
			return `stroke="none"`
		}
		s := svgFill("stroke", sh.Stroke) + fmt.Sprintf(` stroke-width="%s"`, svgNum(float64(sh.Width)))
		if sh.Dash {
			s += ` stroke-dasharray="3 3"`
		}
		return s
	}
	fill := func(sh *figShape) string {
		if sh.Fill.A == 0 {
			return `fill="none"`
		}
		return svgFill("fill", sh.Fill)
	}
	for i := range f.Shapes {
		sh := &f.Shapes[i]
		switch sh.Kind {
		case figLine:
			fmt.Fprintf(b, `<polyline points="%s" fill="none" %s stroke-linecap="round" stroke-linejoin="round"/>`, pts(sh.Pts), stroke(sh))
		case figPoly:
			fmt.Fprintf(b, `<polygon points="%s" %s %s/>`, pts(sh.Pts), fill(sh), stroke(sh))
		case figCircle:
			fmt.Fprintf(b, `<circle cx="%s" cy="%s" r="%s" %s %s/>`, svgNum(float64(sh.Pts[0].X)), svgNum(float64(sh.Pts[0].Y)),
				svgNum(float64(sh.R)), fill(sh), stroke(sh))
		case figText:
			anchor := map[int]string{-1: "start", 0: "middle", 1: "end"}[sh.Anchor]
			weight := ""
			if sh.Bold {
				weight = ` font-weight="600"`
			}
			fmt.Fprintf(b, `<text x="%s" y="%s" font-size="%s" text-anchor="%s"%s %s>%s</text>`, svgNum(float64(sh.Pts[0].X)),
				svgNum(float64(sh.Pts[0].Y)), svgNum(float64(sh.Size)), anchor, weight, svgFill("fill", sh.Fill), svgText(sh.Text))
		}
	}
	b.WriteString(`</g>`)
}
