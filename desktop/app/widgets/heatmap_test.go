package widgets

import (
	"image/png"
	"math/rand"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo/ui"
)

func snapshot(t *testing.T, tt *ui.Tester, name string) {
	dir := os.Getenv("RNAXRAY_SNAPSHOT_DIR")
	if dir == "" {
		return
	}
	f, err := os.Create(filepath.Join(dir, name+".png"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, tt.Image()); err != nil {
		t.Fatal(err)
	}
}

func TestHeatmapPickZoomAndReset(t *testing.T) {
	h := NewHeatmap()
	rng := rand.New(rand.NewSource(1))
	var cells []Cell
	for i := 0; i < 200000; i++ {
		x := float64(rng.Intn(1000) * 10)
		y := float64(rng.Intn(1000) * 10)
		cells = append(cells, Cell{X: x, Y: y, W: 10, H: 10, Color: ui.RGBA(214, 69, 65, 0.2+0.8*rng.Float32())})
	}
	cells = append(cells, Cell{X: 5000, Y: 2000, W: 400, H: 400, Color: ui.RGB(43, 108, 196)})
	h.SetCells(cells, 10000, 10000)
	var last HeatEvent
	view := func(c *ui.Context) {
		ui.Column(c).Padding(10).Children(func() { last = h.Show(c, 400, "test map") })
	}
	tt := ui.NewTester(view, 500, 500)
	snapshot(t, tt, "heatmap")
	// Click the big blue cell: plot origin is (10+44, 10), 400 px for 10 kb.
	tt.ClickAt(10+44+(5200.0/10000)*400, 10+(2200.0/10000)*400)
	tt.Frame()
	if h.Picked != len(cells)-1 {
		t.Fatalf("picked %d, last event %+v", h.Picked, last)
	}
	h.SetView(Window{4000, 7000, 1000, 4000})
	tt.Frame()
	if !h.Zoomed() {
		t.Fatal("not zoomed")
	}
	snapshot(t, tt, "heatmap-zoom")
	tt.Press(10+44+200, 10+200)
	tt.Release(10+44+200, 10+200)
	h.ResetZoom()
	if h.Zoomed() {
		t.Fatal("reset failed")
	}
}

func TestMinCellIsHitWhereItShows(t *testing.T) {
	h := NewHeatmap()
	h.SetCells([]Cell{{X: 5000, Y: 5000, W: 10, H: 10}}, 10000, 10000)
	// 10 nt of 10,000 on 400 DIPs is 0.4 DIP; drawn 3 DIPs wide it spans
	// 37.5 nt around the cell, half of it on each side.
	pad := 1.5 * 10000 / 400.0
	if h.hit(5005+pad*0.9, 5005, pad, pad) != 0 || h.hit(5005+pad*1.1, 5005, pad, pad) != -1 {
		t.Fatal("padded hit")
	}
	if h.hit(5011, 5005, 0, 0) != -1 || h.hit(5009, 5005, 0, 0) != 0 {
		t.Fatal("unpadded hit")
	}
}
