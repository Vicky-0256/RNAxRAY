package views

import (
	"encoding/csv"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/widgets"
)

// exportClick clicks a page's export button and returns the file written;
// with RNAXRAY_SNAPSHOT_DIR set the file is copied there for review.
func exportClick(t *testing.T, a *App, tt *ui.Tester, button string) (string, string) {
	t.Helper()
	asked := pickSaveInto(t, t.TempDir())
	if err := tt.Click(button); err != nil {
		t.Fatal(err)
	}
	waitFlush(a)
	text := readExport(t, asked)
	path := (*asked)[0]
	if want := "Saved " + path; len(a.toasts) == 0 || a.toasts[len(a.toasts)-1].Text != want {
		t.Fatalf("toasts %q, want %q", a.toasts, want)
	}
	tt.Frame()
	if dir := os.Getenv("RNAXRAY_SNAPSHOT_DIR"); dir != "" {
		_ = os.WriteFile(filepath.Join(dir, "export-"+filepath.Base(path)), []byte(text), 0o644)
	}
	return filepath.Base(path), text
}

// tsvRecords parses an exported TSV (comments skipped).
func tsvRecords(t *testing.T, text string) [][]string {
	t.Helper()
	r := csv.NewReader(strings.NewReader(text))
	r.Comma, r.Comment, r.FieldsPerRecord = '\t', '#', -1
	records, err := r.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	return records
}

func TestExploreInteractionsExportTSV(t *testing.T) {
	a, _, p, tt := openExplore(t)
	if err := tt.Click("Interactions"); err != nil {
		t.Fatal(err)
	}
	settle(a, tt)
	name, text := exportClick(t, a, tt, "Export TSV…")
	if name != "SUB_interactions.tsv" {
		t.Fatalf("name %q", name)
	}
	if !strings.Contains(text, "# RNAxRay interactions · selection SUB (2 merged)\n") || !strings.Contains(text, "# 40 of 1724 rows") {
		t.Fatalf("comments %.300q", text)
	}
	records := tsvRecords(t, text)
	if len(records) != 41 || strings.Join(records[0], ",") != "id,gene1,start1,end1,gene2,start2,end2,reads,type,dG,sample" {
		t.Fatalf("%d records, header %q", len(records), records[0])
	}
	first := p.ix.rows[0]
	if records[1][1] != first.Gene1 || records[1][10] != p.ids[first.Index] {
		t.Fatalf("first row %q", records[1])
	}
}

func TestExploreContactExportSVGAndTSV(t *testing.T) {
	a, _, p, tt := openExplore(t)
	d := p.cm.data
	if d == nil {
		t.Fatal("no map")
	}
	name, svg := exportClick(t, a, tt, "Export SVG…")
	if !strings.HasSuffix(name, ".svg") || !strings.HasPrefix(name, "SUB_ZIKV") {
		t.Fatalf("name %q", name)
	}
	xmlWellFormed(t, svg)
	if n := strings.Count(svg, "<rect") - 4; n != len(d.count) {
		t.Fatalf("%d cells drawn of %d", n, len(d.count))
	}
	// Zoomed in: the TSV has the cells in view only.
	p.cm.heat.SetView(widgets.Window{X0: 0, X1: 2000, Y0: 0, Y1: 2000})
	tt.Frame()
	_, text := exportClick(t, a, tt, "Export TSV…")
	records := tsvRecords(t, text)
	inView := contactInView(d, p.cm.heat.View())
	if len(records) != len(inView)+1 || len(inView) == 0 || len(inView) == len(d.count) {
		t.Fatalf("%d records, %d in view of %d", len(records), len(inView), len(d.count))
	}
	if !strings.Contains(text, "# Cells in view: arm 1 0–2000, arm 2 0–2000") || records[0][6] != "records" {
		t.Fatalf("tsv %.400q", text)
	}
}

func TestCompareExportTSVAndSVG(t *testing.T) {
	a, _ := openCS(t)
	tt := ui.NewTester(a.View, 1100, 1400)
	a.Navigate("compare", nil)
	csSettle(a, tt)
	name, text := exportClick(t, a, tt, "Export TSV…")
	if name != "AFR__2_merged_vs_BRA__2_merged_interactions.tsv" {
		t.Fatalf("name %q", name)
	}
	records := tsvRecords(t, text)
	if len(records) != 301 || records[1][2] != "5720" || records[1][1] != "higher in B" {
		t.Fatalf("%d records, first %q", len(records), records[1])
	}
	if !strings.Contains(text, "# RNAxRay differential test compare-1791998444625 · AFR (2 merged) (A) vs BRA (2 merged) (B)") {
		t.Fatalf("comments %.300q", text)
	}
	_, svg := exportClick(t, a, tt, "Export SVG…")
	xmlWellFormed(t, svg)
	if n := strings.Count(svg, `fill="#d64541"`) + strings.Count(svg, `fill="#2b6cc4"`); n != 1500 {
		t.Fatalf("%d cells", n)
	}
}

func TestStructureExportArcsSVG(t *testing.T) {
	a, f := openCS(t)
	readB, listAB, _ := stFixtureB(t)
	f.structures[structB] = readB
	f.ops["list_structures"] = listAB
	tt := ui.NewTester(a.View, 1100, 1400)
	a.Navigate("structure", map[string]any{"structureId": structA})
	csSettle(a, tt)
	name, svg := exportClick(t, a, tt, "Export SVG…")
	if name != "ZIKV_African_KX377335-1_virusRNA_"+structA+".svg" {
		t.Fatalf("name %q", name)
	}
	xmlWellFormed(t, svg)
	if strings.Count(svg, "<path") != 1 || strings.Count(svg, "M") < 1055 || !strings.Contains(svg, "A · AFR_REP1 + AFR_REP2") {
		t.Fatalf("svg %.500s", svg)
	}
	// With B: arcs above and below, shared in grey.
	if err := tt.Click("Compare as B"); err != nil {
		t.Fatal(err)
	}
	csSettle(a, tt)
	name, svg = exportClick(t, a, tt, "Export SVG…")
	xmlWellFormed(t, svg)
	if !strings.Contains(name, "_vs_") || strings.Count(svg, "<path") != 3 || !strings.Contains(svg, "B · ZBRA_REP1 + ZBRA_REP2") {
		t.Fatalf("%s: %.600s", name, svg)
	}
}
