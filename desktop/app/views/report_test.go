package views

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
	"rnaxraydesktop/widgets"
)

// reportFake answers read_comparison by comparison_id from
// testdata/report_read_comparison_*.json (captured from the ZIKV GUI
// project with limit 400 and the 30 strongest interactions).
type reportFake struct {
	*fakeBackend
	comparisons map[string]core.Obj
}

func (f *reportFake) ProjectOp(path, operation string, payload core.Obj) (core.Obj, error) {
	if operation == "read_comparison" {
		f.record("op:" + operation)
		if r, ok := f.comparisons[fmt.Sprint(payload["comparison_id"])]; ok {
			if payload["limit"] != reportMaxCells {
				return nil, fmt.Errorf("limit %v", payload["limit"])
			}
			return r, nil
		}
		return nil, fmt.Errorf("comparison does not exist")
	}
	return f.fakeBackend.ProjectOp(path, operation, payload)
}

func openReport(t *testing.T) (*App, *reportFake) {
	t.Helper()
	base := newFake(t)
	base.queries["analysis_summary"] = fixture(t, "qc_analysis_summary.json")["result"]
	base.ops["list_comparisons"] = fixture(t, "compare_list.json")
	base.ops["list_structures"] = fixture(t, "structure_list.json")
	base.ops["read_structure"] = fixture(t, "structure_read.json")
	f := &reportFake{fakeBackend: base, comparisons: map[string]core.Obj{
		"compare-1791998444625": fixture(t, "report_read_comparison_afr_bra.json"),
		"compare-1791998358218": fixture(t, "report_read_comparison_sub_afr.json"),
	}}
	previous := reportAppVersion
	reportAppVersion = func() string { return "0.1.0-test" }
	t.Cleanup(func() { reportAppVersion = previous })
	a := New(f, nil, "")
	a.SetRuntimeStatus("Runtime: darwin arm64 · Python 3.12.4", "")
	a.Open("/projects/zikv.rnaxrayproj")
	waitFlush(a)
	if a.Project == nil {
		t.Fatalf("project did not open: %q", a.start.status)
	}
	return a, f
}

func TestReportPageSections(t *testing.T) {
	a, _ := openReport(t)
	tt := ui.NewTester(a.View, 1100, 2600)
	a.Navigate("report", nil)
	csSettle(a, tt)
	p := a.PageFor("report").(*reportPage)
	if p.data == nil || p.loading {
		t.Fatalf("report not loaded (loading %v)", p.loading)
	}
	for _, text := range []string{
		"Report", "Project", "ZIKV GUI check", "/projects/zikv.rnaxrayproj", FormatTime("2026-10-14T15:03:55Z"), "RNAxRay Desktop 0.1.0",
		"6 (6 analysed)",
		// References and samples (counts from the indexes).
		"References", "ZAFR", "ZIKV_African_KX377335-1_virusRNA", "10,807",
		"Samples", "SUB_REP1", "ZAFR_REP1_sub.fastq", "done", "224,154", "239,156", "100.0%", "Type 2 55.5%",
		// Conditions merged: AFR = 224,154 + 349,387.
		"Conditions", "AFR_REP1, AFR_REP2", "2 of 2", "573,541",
		// Differential tests with their strongest interactions.
		"Differential tests", "AFR (2 merged) vs BRA (2 merged)", "SUB (2 merged) vs AFR (2 merged)", "1,023,236", "82,132",
		"25,276 / 56,856", "742 / 1,547", "Interactions A / B", "Top 10 merged interactions by padj", "5,720–5,729", "3,890–3,899", "No significant interaction.",
		"DESeq2 · min count 2 · merge range 100 nt · padj < 0.05",
		// Structures and runtime.
		"Structures", "1 window · 3,170–6,229", "AFR_REP1 + AFR_REP2", "1,055", "-452.0 kcal/mol",
		"Runtime", "0.1.0-test", "darwin arm64 · Python 3.12.4",
		// Inputs with fingerprints, and how each sample was run (the
		// fixture project has no checkpoint files on disk).
		"Pipeline settings and input files", "ZAFR.fasta", "reference ZAFR", "sample SUB_REP1", "quick fingerprint",
		"0d9849d59772d0d7bf4ba7aa93ca1ea2733a121a18bff4ea9df85a4dfd1fbc11", "not recorded (no run checkpoint was found)",
		"imported .hyb file: hybrids were called outside RNAxRay Desktop",
	} {
		if !tt.HasText(text) {
			t.Fatalf("report lacks %q: %q", text, tt.Texts())
		}
	}
	afr := p.data.Tests[0]
	if len(afr.Top) != reportTopInteractions || len(afr.Cells) != 400 || afr.CellsTotal != 82132 || afr.Length != 10807 {
		t.Fatalf("test: %d top, %d cells of %d, length %d", len(afr.Top), len(afr.Cells), afr.CellsTotal, afr.Length)
	}
	for i := 1; i < len(afr.Top); i++ {
		if cmpPadj(afr.Top[i].Padj) < cmpPadj(afr.Top[i-1].Padj) {
			t.Fatalf("top not sorted by padj at %d", i)
		}
	}
	st := p.data.Structures[0]
	if len(st.Arcs) != 1055 || st.Start != 3170 || st.End != 6229 {
		t.Fatalf("structure arcs %d %d-%d", len(st.Arcs), st.Start, st.End)
	}
	snapshot(t, tt, "report")
	tt.SetDark(true)
	tt.Frame()
	snapshot(t, tt, "report-dark")
	tt.SetDark(false)

	// A narrower window: the wide tables scroll sideways, and come back
	// when the window grows again.
	tt.SetSize(900, 2600)
	tt.Frame()
	tt.Frame()
	snapshot(t, tt, "report-narrow")
	if !tt.HasText(reportScrollHint) {
		t.Fatalf("narrow report has no scroll hint: %q", tt.Texts())
	}
	tt.SetSize(1100, 2600)
	tt.Frame()
	tt.Frame()
	if tt.HasText(reportScrollHint) {
		t.Fatalf("wide report still shows the scroll hint")
	}
	if !tt.HasText("Type 2 55.0%, Type 1 43.2%, Type 7 1.3%") {
		t.Fatalf("types: %q", tt.Texts())
	}
}

func TestReportExportHTML(t *testing.T) {
	a, _ := openReport(t)
	a.Project.Name = `ZIKV <b>"GUI"</b> & co`
	tt := ui.NewTester(a.View, 1100, 900)
	a.Navigate("report", nil)
	csSettle(a, tt)
	asked := pickSaveInto(t, t.TempDir())
	if err := tt.Click("Export report…"); err != nil {
		t.Fatal(err)
	}
	waitFlush(a)
	if len(*asked) != 1 || !strings.HasSuffix((*asked)[0], "ZIKV__b__GUI___b____co-report.html") {
		t.Fatalf("asked %q", *asked)
	}
	text := readExport(t, asked)
	if dir := os.Getenv("RNAXRAY_SNAPSHOT_DIR"); dir != "" {
		_ = os.WriteFile(filepath.Join(dir, "export-report.html"), []byte(text), 0o644)
	}
	if len(a.toasts) == 0 || a.toasts[len(a.toasts)-1].Text != "Saved "+(*asked)[0] {
		t.Fatalf("toasts %q", a.toasts)
	}
	if len(text) < 20_000 || len(text) > 2_000_000 {
		t.Fatalf("report size %d", len(text))
	}
	// What to check before reporting, in the export too.
	for _, want := range []string{"<h2>Before you report these results</h2>",
		"<li>These results cover the 6 analysed samples of this project;",
		"<li>Differential tests are DESeq2 on 10-nt contact maps;",
		"<li>Structures are computational predictions guided by chimeric reads;"} {
		if !strings.Contains(text, want) {
			t.Fatalf("export lacks %q", want)
		}
	}
	// The exported file is shared: it names the project folder, not where
	// it is on this computer (the path holds the user name).
	if strings.Contains(text, "/projects/zikv.rnaxrayproj") || !strings.Contains(text, "zikv.rnaxrayproj") {
		t.Fatal("the exported report gives the folder's absolute path")
	}
	for _, want := range []string{"<!DOCTYPE html>", `<section id="project">`, `<section id="references">`, `<section id="samples">`,
		`<section id="conditions">`, `<section id="pipeline">`, `<section id="differential-tests">`,
		"cfdf0a3a09b60d85c2900d07c983c2b2827591c7e4fc9c02e9475db6874a13d7", "Quick fingerprint: SHA-256 of the file size", `<section id="structures">`,
		"ZIKV &lt;b&gt;&#34;GUI&#34;&lt;/b&gt; &amp; co", "AFR (2 merged) vs BRA (2 merged)", "Top 10 merged interactions by padj",
		"5,720–5,729", "The 400 strongest of 82,132 cells are drawn.", "Arc diagram of 1,055 base pairs, 3,170–6,229.",
		"-452.0 kcal/mol", "RNAxRay Desktop: 0.1.0-test", "@media print"} {
		if !strings.Contains(text, want) {
			t.Fatalf("report lacks %q", want)
		}
	}
	if strings.Contains(text, `<b>"GUI"`) {
		t.Fatal("project name not escaped")
	}
	// Self-contained: no external resource.
	for _, bad := range []string{"<script", "<link", "src=", "http://", "https://"} {
		if strings.Contains(strings.ReplaceAll(text, `xmlns="http://www.w3.org/2000/svg"`, ""), bad) {
			t.Fatalf("report holds %q", bad)
		}
	}
	// One map (the other test has no significant cell) and one arc diagram,
	// each well-formed.
	svgs := regexp.MustCompile(`(?s)<svg .*?</svg>`).FindAllString(text, -1)
	if len(svgs) != 2 {
		t.Fatalf("%d figures", len(svgs))
	}
	for _, svg := range svgs {
		xmlWellFormed(t, svg)
	}
	if n := strings.Count(svgs[0], "<rect"); n < 400 {
		t.Fatalf("map has %d rects", n)
	}
	if !strings.Contains(svgs[1], "<path") || !strings.Contains(svgs[0], `id="test1-clip"`) || !strings.Contains(svgs[1], `id="structure1-clip"`) {
		t.Fatal("figure ids or arcs missing")
	}
}

// The settings come from the sample's run checkpoint (the rnaxraypipe
// format, as written by a real run), and a reads file that changed since
// that run is called out.
func TestReportRunSettings(t *testing.T) {
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, "samples", "ok"), 0o755); err != nil {
		t.Fatal(err)
	}
	checkpoint := `{"version": 1, "input": {"path": "/data/ok_rep1.fastq", "size": 6089196, "mtime": 1792136794.1215298},
		"options": {"blast_threshold": 0.1, "max_overlap": 4, "max_hits": 10, "energy": false, "keep_sam": "none",
		"source": "fastq", "work": "/x/ok_rep1.work", "format": "2026-10-14"}, "stages": {}}`
	if err := os.WriteFile(filepath.Join(project, "samples", "ok", "ok_rep1.checkpoint.json"), []byte(checkpoint), 0o644); err != nil {
		t.Fatal(err)
	}
	s := model.Sample{Reads: model.Reads{Path: "/data/ok_rep1.fastq", Format: "fastq", SizeBytes: 6089196, Mtime: 1792136794.12153},
		Outputs: model.Outputs{Hyb: "samples/ok/ok_rep1.hyb"}}
	text, note := reportRunSettings(project, s)
	if want := "blast_threshold 0.1 · max_overlap 4 · max_hits 10 · energy off · pipeline format 2026-10-14"; text != want || note != "" {
		t.Fatalf("settings %q, note %q", text, note)
	}
	s.Reads.SizeBytes++
	if _, note := reportRunSettings(project, s); !strings.Contains(note, "now differs from the one this run used") {
		t.Fatalf("changed reads not noted: %q", note)
	}
	s.Outputs.Hyb = ""
	if text, _ := reportRunSettings(project, s); text != "not run yet" {
		t.Fatalf("not run: %q", text)
	}
	// A failed run is not "not run".
	s.Stages = map[string]model.Stage{"map": {Status: "failed"}}
	if text, _ := reportRunSettings(project, s); text != "no hybrids: the last run failed at map" {
		t.Fatalf("failed run: %q", text)
	}
	if got := reportFingerprint("abc", "def"); got != "SHA-256\nabc" {
		t.Fatalf("fingerprint %q", got)
	}
}

func TestReportHTMLCapsAndEmpty(t *testing.T) {
	var cells []widgets.Cell
	for i := range 30_000 {
		cells = append(cells, widgets.Cell{X: float64(i % 1000 * 10), Y: float64(i / 1000 * 10), W: 10, H: 10, Color: cmpRed})
	}
	d := &reportData{Name: "Caps", Generated: "2026-10-14 12:00", Tests: []reportTest{{ID: "t", LabelA: "A<1>", LabelB: "B", Cells: cells,
		CellsTotal: 30_000, Length: 10_000, Summary: comparisonSummary{Significant: 30_000}}}}
	raw, err := renderReportHTML(d)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	svgs := regexp.MustCompile(`(?s)<svg .*?</svg>`).FindAllString(text, -1)
	if len(svgs) != 1 {
		t.Fatalf("%d figures", len(svgs))
	}
	xmlWellFormed(t, svgs[0])
	if n := strings.Count(svgs[0], `fill="#d64541"`); n != reportMaxCells {
		t.Fatalf("%d cells drawn", n)
	}
	for _, want := range []string{"The 20,000 strongest of 30,000 cells are drawn.", "A&lt;1&gt; vs B", "No significant interaction.",
		"No structure has been folded.", "No sample in this project.", "development build"} {
		if !strings.Contains(text, want) {
			t.Fatalf("lacks %q", want)
		}
	}
	empty, err := renderReportHTML(&reportData{Name: "Empty", Generated: time.Now().Format("2006-01-02")})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(empty), "<svg") || !strings.Contains(string(empty), "No differential test has been run.") {
		t.Fatal("empty report")
	}
}

func TestReportReviewChecks(t *testing.T) {
	ready := func(label, cond string, ok bool) reportSample {
		return reportSample{Label: label, Condition: cond, Ready: ok}
	}
	d := &reportData{
		Samples:    []reportSample{ready("A1", "A", true), ready("A2", "A", true), ready("B1", "B", true), ready("B2", "B", false)},
		Conditions: []reportCondition{{Name: "A", Analysed: 2}, {Name: "B", Analysed: 1}},
		Settings:   []reportSettings{{Sample: "A1", Note: "changed"}},
	}
	got := strings.Join(d.reviewChecks(), "\n")
	for _, want := range []string{"These results cover the 3 analysed samples", "1 of 4 samples are not analysed",
		"Only one analysed replicate in B", "1 sample's input changed after it was analysed"} {
		if !strings.Contains(got, want) {
			t.Fatalf("checks lack %q:\n%s", want, got)
		}
	}
	for _, absent := range []string{"Differential tests", "Structures are", "External sources", "could not be read"} {
		if strings.Contains(got, absent) {
			t.Fatalf("check %q without its condition:\n%s", absent, got)
		}
	}
}
