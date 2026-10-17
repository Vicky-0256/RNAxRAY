package widgets

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestArcsSharedAndRender(t *testing.T) {
	var a, b []Pair
	for i := 0; i < 40; i++ {
		a = append(a, Pair{10 + i*20, 400 + i*15})
		if i%2 == 0 {
			b = append(b, Pair{10 + i*20, 400 + i*15})
		} else {
			b = append(b, Pair{30 + i*20, 200 + i*10})
		}
	}
	s := &Arcs{}
	s.Set(a, b, 1200)
	if s.Shared() != 20 {
		t.Fatalf("shared %d", s.Shared())
	}
	view := func(c *ui.Context) {
		th := c.Theme()
		ui.Column(c).Padding(10).Width(700).Children(func() {
			s.Show(c, 280, ui.RGB(214, 69, 65), ui.RGB(43, 108, 196), th.Text, "arcs")
		})
	}
	tt := ui.NewTester(view, 720, 320)
	snapshot(t, tt, "arcs")
	s.setRange(100, 500)
	tt.Frame()
	if s.Start != 100 || s.End != 500 {
		t.Fatalf("range %v-%v", s.Start, s.End)
	}
	snapshot(t, tt, "arcs-zoom")
}
