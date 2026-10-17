package views

import (
	"fmt"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
)

// csFake gives every started task its own id and answers read_structure by
// structure_id (the plain fake answers one fixture per operation).
type csFake struct {
	*fakeBackend
	n          int
	structures map[string]core.Obj
}

func (f *csFake) StartTask(req core.TaskStartRequest) (core.Obj, error) {
	snapshot, err := f.fakeBackend.StartTask(req)
	if err != nil {
		return nil, err
	}
	f.mu.Lock()
	f.n++
	snapshot["task_id"] = fmt.Sprintf("%s-%d", req.Kind, f.n)
	snapshot["progress"] = core.Obj{"stage": "fold", "detail": "1/1 windows", "bytes_done": 0.0, "bytes_total": 1.0}
	f.mu.Unlock()
	return snapshot, nil
}

func (f *csFake) ProjectOp(path, operation string, payload core.Obj) (core.Obj, error) {
	if operation == "read_structure" {
		if r, ok := f.structures[fmt.Sprint(payload["structure_id"])]; ok {
			f.record("op:" + operation)
			return r, nil
		}
	}
	return f.fakeBackend.ProjectOp(path, operation, payload)
}

// csRecordPage stands in for a page another file builds; it keeps the
// navigate options it was shown with.
type csRecordPage struct {
	a       *App
	options map[string]any
}

func (r *csRecordPage) Show()              { r.options = r.a.NavOptions }
func (r *csRecordPage) View(c *ui.Context) { ui.Text(c, "recorded page") }

func openCS(t *testing.T) (*App, *csFake) {
	t.Helper()
	f := &csFake{fakeBackend: newFake(t), structures: map[string]core.Obj{}}
	f.ops["list_comparisons"] = fixture(t, "compare_list.json")
	f.ops["read_comparison"] = fixture(t, "compare_read.json")
	f.queries["compare_bins"] = map[string]any(fixture(t, "compare_bins.json"))
	f.ops["list_structures"] = fixture(t, "structure_list.json")
	f.ops["read_structure"] = fixture(t, "structure_read.json")
	f.ops["read_annotation"] = core.Obj{"annotation": nil, "features": []any{}, "seqid": "", "sequence": nil}
	a := New(f, nil, "")
	a.Open("/projects/zikv.rnaxrayproj")
	waitFlush(a)
	if a.Project == nil {
		t.Fatalf("project did not open: %q", a.start.status)
	}
	return a, f
}

func (f *csFake) startedKinds() []core.TaskStartRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]core.TaskStartRequest(nil), f.started...)
}

func csCountCalls(f *csFake, name string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == name {
			n++
		}
	}
	return n
}

func csSettle(a *App, tt *ui.Tester) {
	for i := 0; i < 3; i++ {
		waitFlush(a)
		tt.Frame()
	}
}

func TestCompareResultsAndActions(t *testing.T) {
	a, f := openCS(t)
	explore := &csRecordPage{a: a}
	a.RegisterPage("explore", explore)
	tt := ui.NewTester(a.View, 1100, 1400)
	a.Navigate("compare", nil)
	csSettle(a, tt)
	p := a.PageFor("compare").(*comparePage)
	// The newest result (AFR vs BRA) is selected and read.
	if p.selectedID != "compare-1791998444625" {
		t.Fatalf("selected %q", p.selectedID)
	}
	for _, text := range []string{"Differential tests", "AFR (2 merged) vs BRA (2 merged)", "SUB (2 merged) vs AFR (2 merged)",
		"82,132", "25,276", "56,856", "742 / 1,547", "Interactions A / B", "1.08 1.69 · 1.14 0.54", "Merged interactions (300)",
		"The map shows the 1,500 strongest of 82,132 significant cells."} {
		if !tt.HasText(text) {
			t.Fatalf("compare page lacks %q: %q", text, tt.Texts())
		}
	}
	if n := len(p.heat.Cells()); n != 1500 {
		t.Fatalf("heatmap cells %d", n)
	}
	snapshot(t, tt, "compare")
	tt.SetDark(true)
	tt.Frame()
	snapshot(t, tt, "compare-dark")
	tt.SetDark(false)

	// Direction filter.
	p.direction = 1
	tt.Frame()
	tt.Frame()
	for _, row := range p.shown {
		if row.Direction != "up" {
			t.Fatalf("filtered row %+v", row)
		}
	}
	p.direction = 0
	tt.Frame()
	tt.Frame()

	// A row click highlights the cmpInteraction on the map (padded by the merge range).
	if err := tt.Click("5720–5729"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if p.row != 0 {
		t.Fatalf("row %d", p.row)
	}
	if h := p.heat.Highlight; h.X != 5620 || h.Y != 3790 || h.W != 210 {
		t.Fatalf("highlight %+v", h)
	}
	if !tt.HasText("5720–5729 × 3890–3899") {
		t.Fatalf("texts %q", tt.Texts())
	}
	snapshot(t, tt, "compare-picked")

	// Locate: Explore on B's group (higher in B), contact map at the cell.
	if err := tt.Click("Locate"); err != nil {
		t.Fatal(err)
	}
	waitFlush(a)
	if a.Page != "explore" || explore.options["view"] != "contact-map" || explore.options["selectionKey"] != "c:BRA" ||
		explore.options["gene"] != "ZIKV_Brazilian_MF073357-1_virusRNA" || explore.options["x"] != 5720 || explore.options["y"] != 3890 ||
		explore.options["binSize"] != 10 || explore.options["yEnd"] != 3899 {
		t.Fatalf("page %q options %+v", a.Page, explore.options)
	}
	if a.Selected.Key != "c:BRA" || a.Selected.ReferenceID != "ZBRA" || a.Selected.Gene != "ZIKV_Brazilian_MF073357-1_virusRNA" {
		t.Fatalf("selection %+v", a.Selected)
	}
	a.Navigate("compare", nil)
	csSettle(a, tt)
	if p.row != 0 {
		t.Fatalf("row lost: %d", p.row)
	}
	if err := tt.Click("Region"); err != nil {
		t.Fatal(err)
	}
	if explore.options["view"] != "region" {
		t.Fatalf("options %+v", explore.options)
	}
	a.Navigate("compare", nil)
	csSettle(a, tt)

	// Fold A & B: confirm, then two window folds padded by the merge range.
	if err := tt.Click("Fold A & B"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if !tt.HasText("Fold ZIKV_African_KX377335-1_virusRNA:3790–5829") {
		t.Fatalf("texts %q", tt.Texts())
	}
	snapshot(t, tt, "compare-fold")
	if err := tt.Click("Start both"); err != nil {
		t.Fatal(err)
	}
	csSettle(a, tt)
	started := f.startedKinds()
	if len(started) != 2 {
		t.Fatalf("started %+v", started)
	}
	for i, want := range []struct {
		gene string
		ids  []string
	}{{"ZIKV_African_KX377335-1_virusRNA", []string{"AFR_REP1", "AFR_REP2"}}, {"ZIKV_Brazilian_MF073357-1_virusRNA", []string{"ZBRA_REP1", "ZBRA_REP2"}}} {
		req := started[i]
		params, _ := req.Parameters.(map[string]any)
		if req.Kind != "structure" || *req.GeneID != want.gene || *req.Mode != "windows" || strings.Join(req.SampleIDs, ",") != strings.Join(want.ids, ",") ||
			len(req.Windows) != 1 || req.Windows[0] != (core.Window{Start: 3790, End: 5829}) || params["allow_pseudoknot"] != true {
			t.Fatalf("fold %d: %+v params %+v", i, req, params)
		}
	}
	if a.Page != "structure" {
		t.Fatalf("page %q", a.Page)
	}
	sp := a.PageFor("structure").(*structurePage)
	if strings.Join(sp.pendingPair, ",") != "structure-1,structure-2" {
		t.Fatalf("pending pair %v", sp.pendingPair)
	}
	if a.TaskLabel(a.Tasks["structure-1"]) != "Structure · AFR (2 merged) · 3790-5829" {
		t.Fatalf("label %q", a.TaskLabel(a.Tasks["structure-1"]))
	}

	// The drawer's "View results" selects a comparison.
	a.Navigate("compare", map[string]any{"comparisonId": "compare-1791998358218"})
	csSettle(a, tt)
	if p.selectedID != "compare-1791998358218" || a.NavOptions != nil {
		t.Fatalf("selected %q", p.selectedID)
	}
}

func TestCompareRunTestAndValidation(t *testing.T) {
	a, f := openCS(t)
	tt := ui.NewTester(a.View, 1100, 1400)
	a.Navigate("compare", nil)
	csSettle(a, tt)
	p := a.PageFor("compare").(*comparePage)
	if p.keyA != "c:SUB" || p.keyB != "c:AFR" {
		t.Fatalf("defaults %q %q", p.keyA, p.keyB)
	}
	// Validation as the JS page.
	p.keyB = "c:SUB"
	if err := tt.Click("Run differential test"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if !tt.HasText("A and B share samples; choose two different groups.") {
		t.Fatalf("texts %q", tt.Texts())
	}
	p.keyA, p.keyB = "s:AFR_REP1", "s:ZBRA_REP1"
	_ = tt.Click("Run differential test")
	tt.Frame()
	if !tt.HasText("The test needs at least three samples (two replicates in one condition).") {
		t.Fatalf("texts %q", tt.Texts())
	}
	a.Project.Sample("ZBRA_REP2").Reads.Format = "fastq"
	p.keyA, p.keyB = "c:AFR", "c:BRA"
	_ = tt.Click("Run differential test")
	tt.Frame()
	if !tt.HasText("Run these samples first: ZBRA_REP2") || len(f.startedKinds()) != 0 {
		t.Fatalf("texts %q", tt.Texts())
	}
	a.Project.Sample("ZBRA_REP2").Reads.Format = "hyb"
	p.minCount, p.mergeRange, p.padj = 3, 50, 0.01
	_ = tt.Click("Run differential test")
	csSettle(a, tt)
	started := f.startedKinds()
	if len(started) != 1 {
		t.Fatalf("started %+v", started)
	}
	req := started[0]
	params := req.Parameters.(map[string]any)
	if req.Kind != "compare" || strings.Join(req.SamplesOne, ",") != "AFR_REP1,AFR_REP2" || strings.Join(req.SamplesTwo, ",") != "ZBRA_REP1,ZBRA_REP2" ||
		params["min_count"] != 3 || params["range"] != 50 || params["padj_cutoff"] != 0.01 || params["similarity_min"] != 1 ||
		params["label_one"] != "AFR (2 merged)" || params["label_two"] != "BRA (2 merged)" || req.ProjectPath != "/projects/zikv.rnaxrayproj" {
		t.Fatalf("request %+v params %+v", req, params)
	}
	for _, text := range []string{"Differential test · AFR (2 merged) vs BRA (2 merged)", "The test is running; results appear here when it finishes.", "Cancel"} {
		if !tt.HasText(text) {
			t.Fatalf("lacks %q: %q", text, tt.Texts())
		}
	}
	snapshot(t, tt, "compare-running")
	// The list reloads when the task finishes.
	before := csCountCalls(f, "op:list_comparisons")
	a.storeTask(model.Task{TaskID: "compare-1", Kind: "compare", Status: "succeeded", StartedAt: "2026-10-14T10:00:00Z"})
	csSettle(a, tt)
	if csCountCalls(f, "op:list_comparisons") != before+1 {
		t.Fatalf("list not reloaded: %v", f.calls)
	}
}

// TestCompareSimilarityHeatmap: a result with similarity.tsv shows RNAxRay's
// similarity heatmap under the test; an older result asks for a re-run.
func TestCompareSimilarityHeatmap(t *testing.T) {
	a, f := openCS(t)
	tt := ui.NewTester(a.View, 1100, 2200)
	a.Navigate("compare", nil)
	csSettle(a, tt)
	if !tt.HasText("This test was run before the similarity heatmap existed; run it again to get one.") {
		t.Fatalf("old result: %q", tt.Texts())
	}

	read := fixture(t, "compare_read.json")
	summary := read["summary"].(map[string]any)
	summary["similarity_cells"] = 3.0
	summary["similarity_cap"] = 40.0
	list := fixture(t, "compare_list.json")
	for _, item := range list["comparisons"].([]any) {
		if entry := item.(map[string]any); entry["id"] == "compare-1791998444625" {
			entry["parameters"].(map[string]any)["similarity_min"] = 10.0
		}
	}
	f.ops["list_comparisons"] = list
	// strongest first, as read_comparison returns them
	read["similarity"] = map[string]any{"x": []any{100.0, 5000.0, 20.0}, "y": []any{200.0, 9000.0, 30.0},
		"count": []any{80.0, 40.0, 10.0}}
	f.ops["read_comparison"] = read
	p := a.PageFor("compare").(*comparePage)
	p.reset()
	a.Navigate("compare", nil)
	csSettle(a, tt)
	for _, text := range []string{"Similarity heatmap", "Similar cells", "40",
		"(count ≥ 10 in each); green = the smaller of the two summed counts, capped at the 95% quantile (40). As rnaxray's plot_similarity_map."} {
		if !tt.HasText(text) && !strings.Contains(strings.Join(tt.Texts(), "\n"), text) {
			t.Fatalf("lacks %q: %q", text, tt.Texts())
		}
	}
	cells := p.simHeat.Cells()
	if len(cells) != 3 {
		t.Fatalf("similarity cells %d", len(cells))
	}
	// weakest first; capped at the 95% quantile, so 80 and 40 are equally strong
	if cells[0].X != 20 || cells[0].Color.A >= cells[1].Color.A || cells[1].Color.A != cells[2].Color.A {
		t.Fatalf("cells %+v", cells)
	}
	if cells[2].Color.R != cmpGreen.R || cells[2].Color.G != cmpGreen.G {
		t.Fatalf("colour %+v", cells[2].Color)
	}
	snapshot(t, tt, "compare-similarity")
}

func TestCompareQuickView(t *testing.T) {
	a, _ := openCS(t)
	tt := ui.NewTester(a.View, 1100, 1400)
	a.Navigate("compare", nil)
	csSettle(a, tt)
	p := a.PageFor("compare").(*comparePage)
	if err := tt.Click("Quick view"); err != nil {
		t.Fatal(err)
	}
	csSettle(a, tt)
	if !tt.HasText("Quick view · SUB (2 merged) vs AFR (2 merged)") {
		t.Fatalf("texts %q", tt.Texts())
	}
	rows := p.quickRows()
	if len(rows) == 0 || len(p.quick.heat.Cells()) == 0 {
		t.Fatalf("rows %d", len(rows))
	}
	for i := 1; i < len(rows); i++ {
		if rows[i].A+rows[i].B < p.quick.minCount {
			t.Fatalf("row below min count %+v", rows[i])
		}
	}
	snapshot(t, tt, "compare-quick")
	if err := tt.Click("Back to tests"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if p.mode != cmpModeTest {
		t.Fatal("still in quick view")
	}
}
