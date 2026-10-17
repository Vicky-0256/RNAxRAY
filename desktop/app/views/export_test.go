package views

import (
	"encoding/csv"
	"encoding/xml"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/widgets"
)

// xmlWellFormed parses s as XML to the end.
func xmlWellFormed(t *testing.T, s string) {
	t.Helper()
	dec := xml.NewDecoder(strings.NewReader(s))
	for {
		_, err := dec.Token()
		if errors.Is(err, io.EOF) {
			return
		}
		if err != nil {
			t.Fatalf("not well-formed XML: %v\n%.300s", err, s)
		}
	}
}

// pickSaveInto makes the save dialog answer dir/<default name>; it returns
// the paths asked for.
func pickSaveInto(t *testing.T, dir string) *[]string {
	t.Helper()
	previous := PickSave
	var asked []string
	PickSave = func(title, name string) string {
		path := filepath.Join(dir, name)
		asked = append(asked, path)
		return path
	}
	t.Cleanup(func() { PickSave = previous })
	return &asked
}

func readExport(t *testing.T, asked *[]string) string {
	t.Helper()
	if len(*asked) == 0 {
		t.Fatal("the save dialog was not shown")
	}
	path := (*asked)[len(*asked)-1]
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestTSVQuotesTabsNewlinesAndQuotes(t *testing.T) {
	table := tsvTable{
		Comments: []string{"first line\nsecond line", "plain"},
		Header:   []string{"name", "value"},
		Rows:     [][]string{{"a\tb", "1"}, {"line\nbreak", `say "hi"`}, {"plain", ""}},
	}
	raw, err := table.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if !strings.HasPrefix(text, "# first line second line\n# plain\nname\tvalue\n") {
		t.Fatalf("head %q", text)
	}
	if !strings.Contains(text, "\"a\tb\"\t1\n") || !strings.Contains(text, "\"say \"\"hi\"\"\"") {
		t.Fatalf("quoting %q", text)
	}
	r := csv.NewReader(strings.NewReader(text))
	r.Comma, r.Comment = '\t', '#'
	records, err := r.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	want := append([][]string{table.Header}, table.Rows...)
	if len(records) != len(want) {
		t.Fatalf("records %q", records)
	}
	for i := range want {
		if strings.Join(records[i], "|") != strings.Join(want[i], "|") {
			t.Fatalf("row %d: %q want %q", i, records[i], want[i])
		}
	}
}

func TestExportName(t *testing.T) {
	for _, c := range []struct{ got, want string }{
		{exportName(".tsv", "AFR (2 merged)", "vs", "BRA"), "AFR__2_merged_vs_BRA.tsv"},
		{exportName("-report.html", "ZIKV <GUI>/check"), "ZIKV__GUI__check-report.html"},
		{exportName(".svg", "", "///"), "export.svg"},
	} {
		if c.got != c.want {
			t.Fatalf("%q want %q", c.got, c.want)
		}
	}
}

func TestHeatmapSVGWellFormedEscapedAndCapped(t *testing.T) {
	var cells []widgets.Cell
	for i := range 50 {
		cells = append(cells, widgets.Cell{X: float64(i * 10), Y: float64(i * 10), W: 10, H: 10, Color: ui.RGB(214, 69, 65).Alpha(0.5)})
	}
	// A cell outside the view is not counted.
	cells = append(cells, widgets.Cell{X: 5000, Y: 5000, W: 10, H: 10, Color: ui.RGB(1, 2, 3)})
	svg, drawn, total := heatSVG{Cells: cells, View: widgets.Window{X0: 0, X1: 500, Y0: 0, Y1: 500}, MaxCells: 10,
		Title: `A <&> "B"`, XLabel: "Arm 1", YLabel: "Arm 2", Note: "red & blue", ID: "t1"}.SVG()
	if drawn != 10 || total != 50 {
		t.Fatalf("drawn %d of %d", drawn, total)
	}
	xmlWellFormed(t, svg)
	if !strings.Contains(svg, "A &lt;&amp;&gt; &#34;B&#34;") || strings.Contains(svg, "<&>") {
		t.Fatalf("title not escaped: %.400s", svg)
	}
	// The last (strongest) cells are kept: the cell at 490 is drawn, 0 is not.
	if n := strings.Count(svg, `fill="#d64541" fill-opacity="0.50"`); n != 10 {
		t.Fatalf("%d cells drawn", n)
	}
	if !strings.Contains(svg, `<desc>10 of 50 cells in view drawn`) || !strings.Contains(svg, `id="t1-clip"`) {
		t.Fatalf("desc or id missing: %.600s", svg)
	}
	xmlWellFormed(t, string(svgFile(svg)))
}

func TestArcSVGWellFormed(t *testing.T) {
	a := []widgets.Pair{{I: 10, J: 50}, {I: 20, J: 40}, {I: 60, J: 90}}
	b := []widgets.Pair{{I: 20, J: 40}, {I: 70, J: 80}}
	svg, drawn := arcSVG{A: a, B: b, Start: 1, End: 100, Title: "gene <1>", LabelA: "A & co", LabelB: "B"}.SVG()
	xmlWellFormed(t, svg)
	if drawn != 5 {
		t.Fatalf("drawn %d", drawn)
	}
	// A only (red), B only (blue), shared above and below (grey).
	if strings.Count(svg, "<path") != 4 || !strings.Contains(svg, `stroke="#d64541"`) || !strings.Contains(svg, `stroke="#2b6cc4"`) {
		t.Fatalf("paths: %s", svg)
	}
	if !strings.Contains(svg, "gene &lt;1&gt;") || !strings.Contains(svg, "A &amp; co") || !strings.Contains(svg, "in both") {
		t.Fatalf("labels: %s", svg)
	}
	// One structure: arcs above only; a pair outside the range is skipped.
	svg, drawn = arcSVG{A: a, Start: 55, End: 100}.SVG()
	xmlWellFormed(t, svg)
	if drawn != 1 || strings.Contains(svg, "in both") {
		t.Fatalf("drawn %d: %s", drawn, svg)
	}
	// The arc rises above the axis: its control points have y < base.
	m := regexp.MustCompile(`d="M[0-9.]+ ([0-9.]+)C[0-9.]+ ([0-9.]+) `).FindStringSubmatch(svg)
	if m == nil || atof(m[2]) >= atof(m[1]) {
		t.Fatalf("arc %q", m)
	}
}

func atof(s string) float64 {
	v, _ := strconv.ParseFloat(s, 64)
	return v
}
