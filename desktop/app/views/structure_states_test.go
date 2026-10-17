package views

import (
	"fmt"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
)

// stLongGene is a reference sequence name as long as some annotations make.
const stLongGene = "ENSG00000223972.5_DDX11L1_transcribed_unprocessed_pseudogene_chr1_11869-14409_plus_strand_isoform_long_name_RNA"

// stStatesFixture opens the Structure page with synthetic content: a long
// RNA name next to the real ones and many results.
func stStatesFixture(t *testing.T, results int) (*App, *csFake, *ui.Tester) {
	t.Helper()
	a, f := openCS(t)
	ref := &a.Project.References[0]
	ref.Sequences = append(ref.Sequences, model.Sequence{Name: stLongGene, Length: 2534})
	list := fixture(t, "structure_list.json")
	base := list["structures"].([]any)[0].(map[string]any)
	items := []any{}
	for i := 0; i < results; i++ {
		e := map[string]any{}
		for k, v := range base {
			e[k] = v
		}
		e["id"], e["task_id"] = fmt.Sprintf("structure-%03d", i), fmt.Sprintf("structure-%03d", i)
		e["created_at"] = fmt.Sprintf("2026-10-%02dT10:00:00Z", 15-i%14)
		if i%3 == 1 {
			e["gene_id"], e["mode"], e["windows"] = stLongGene, "genome", []any{}
			e["summary"] = map[string]any{"pairs": 712, "pseudoknot_pairs": 0, "energy": -811.4, "length": 2534}
		}
		if i == 2 {
			e["available"] = false
		}
		items = append(items, e)
	}
	list["structures"] = items
	f.ops["list_structures"] = list
	tt := ui.NewTester(a.View, 1100, 1100)
	a.Navigate("structure", nil)
	csSettle(a, tt)
	return a, f, tt
}

// stTaskState gives the fold started from the form the status.
func stTaskState(a *App, tt *ui.Tester, task model.Task) {
	task.TaskID, task.Kind = "structure-1", "structure"
	a.storeTask(task)
	csSettle(a, tt)
}

// TestStructureStateSnapshots renders each state of the New fold task. It
// asserts nothing so it also runs against earlier versions of the page for
// before/after comparisons (RNAXRAY_SNAPSHOT_DIR).
func TestStructureStateSnapshots(t *testing.T) {
	now := time.Now().UTC()
	at := func(d time.Duration) string { return now.Add(d).Format(time.RFC3339) }
	f64 := func(v float64) *float64 { return &v }

	a, _, tt := stStatesFixture(t, 30)
	p := a.PageFor("structure").(*structurePage)
	p.gene = stLongGene
	csSettle(a, tt)
	snapshot(t, tt, "states-long-many")

	// Longer than the native limit with an 8 GB task budget.
	p.gene, p.budgetMB = africaGene, 8192
	tt.Frame()
	snapshot(t, tt, "states-over-limit")

	a, f, tt := stStatesFixture(t, 0)
	f.ops["list_structures"] = core.Obj{"structures": []any{}}
	a.PageFor("structure").(*structurePage).loadList()
	csSettle(a, tt)
	snapshot(t, tt, "states-empty")

	p = a.PageFor("structure").(*structurePage)
	p.structures, p.loading = nil, true
	tt.Frame()
	snapshot(t, tt, "states-loading")
	p.loading = false

	for i := range a.Project.Samples {
		a.Project.Samples[i].Ready, a.Project.Samples[i].Outputs.Index = false, ""
	}
	p.evidence = ""
	tt.Frame()
	tt.Frame()
	snapshot(t, tt, "states-no-samples")

	states := []struct {
		name string
		task model.Task
	}{
		{"queued", model.Task{Status: "queued", StartedAt: at(-5 * time.Second)}},
		{"partial", model.Task{Status: "running", LaunchedAt: at(-30 * time.Second), SecondsLeft: f64(40),
			Progress: &model.Progress{Stage: "fold", Detail: "3/8 windows on 4 workers", BytesDone: f64(3), BytesTotal: f64(8), Units: "windows"}}},
		{"failed-memory", model.Task{Status: "failed", FinishedAt: at(0),
			Error: "10807 nt exceeds the CPLfold limit of 5331 nt for this memory budget (pseudoknot-free). Use windows mode for long RNAs."}},
		{"failed-evidence", model.Task{Status: "failed", FinishedAt: at(0),
			Error: "ValueError: no intramolecular ZIKV_African_KX377335-1_virusRNA chimeras fall inside the requested region"}},
		{"cancelled", model.Task{Status: "cancelled", FinishedAt: at(0)}},
		{"interrupted", model.Task{Status: "interrupted", FinishedAt: at(0)}},
		{"succeeded", model.Task{Status: "succeeded", FinishedAt: at(0)}},
	}
	for _, s := range states {
		a, f, tt := stStatesFixture(t, 3)
		if s.name == "succeeded" {
			list := f.ops["list_structures"]
			items := list["structures"].([]any)
			items[0].(map[string]any)["task_id"] = "structure-1"
		}
		if err := tt.Click("Run fold"); err != nil {
			t.Fatal(err)
		}
		csSettle(a, tt)
		stTaskState(a, tt, s.task)
		if s.name == "succeeded" {
			a.PageFor("structure").(*structurePage).loadList()
			csSettle(a, tt)
		}
		snapshot(t, tt, "states-"+s.name)
		if s.name == "partial" || s.name == "failed-memory" {
			tt.SetDark(true)
			tt.Frame()
			snapshot(t, tt, "states-"+s.name+"-dark")
			tt.SetDark(false)
		}
	}
}

// TestStructureFoldStates checks what each state says and offers.
func TestStructureFoldStates(t *testing.T) {
	now := time.Now().UTC()
	at := func(d time.Duration) string { return now.Add(d).Format(time.RFC3339) }
	f64 := func(v float64) *float64 { return &v }
	expect := func(tt *ui.Tester, texts ...string) {
		t.Helper()
		for _, text := range texts {
			if !tt.HasText(text) {
				t.Fatalf("lacks %q: %q", text, tt.Texts())
			}
		}
	}

	// Long name, many results: the name in full, counts and units.
	a, _, tt := stStatesFixture(t, 30)
	p := a.PageFor("structure").(*structurePage)
	p.gene = stLongGene
	csSettle(a, tt)
	expect(tt, stLongGene+" · 2,534 nt", "Results (30)", "whole RNA · 2,534 nt", "712 base pairs · -811.4 kcal/mol",
		"Its files are missing from the project folder; it cannot be shown. Run the fold again to recreate it.")

	// Advanced settings: folded, values always shown, flagged when changed.
	expect(tt, "Advanced settings", "Evidence weight 0.50 · beam 100 · defaults")
	if tt.HasText("Beam size") {
		t.Fatal("advanced settings open by default")
	}
	p.beam = 200
	tt.Frame()
	expect(tt, "Evidence weight 0.50 · beam 200 · changed from the defaults")
	p.beam = stDefaultBeam

	// Memory over the budget blocks the run and says what to do.
	p.gene = africaGene
	p.budgetMB = 8192
	tt.Frame()
	expect(tt, "Cannot run yet:", "• This fold needs about 15.9 GB of memory but tasks may use 8.0 GB. "+
		"Fold shorter windows, fewer windows at once (Advanced), or raise Memory in Preferences.")
	p.budgetMB = 24576

	// Empty and loading.
	a, f, tt := stStatesFixture(t, 0)
	f.ops["list_structures"] = core.Obj{"structures": []any{}}
	p = a.PageFor("structure").(*structurePage)
	p.loadList()
	csSettle(a, tt)
	expect(tt, "No structures yet. Choose an RNA and its evidence above and press Run fold; results appear here and in the Report.")
	p.loading = true
	tt.Frame()
	expect(tt, "Loading results…")
	p.loading, p.listErr = false, "project.json is locked"
	tt.Frame()
	expect(tt, "Could not read the project's structures: project.json is locked. Press Refresh to try again.")

	// The fold started here, through its states.
	states := []struct {
		task  model.Task
		texts []string
	}{
		{model.Task{Status: "queued"}, []string{"Waiting to start", "Cancel", "Fold running…"}},
		{model.Task{Status: "running", LaunchedAt: at(-30 * time.Second), SecondsLeft: f64(40),
			Progress: &model.Progress{Stage: "fold", BytesDone: f64(3), BytesTotal: f64(8), Units: "windows"}},
			[]string{"Folding: 3 of 8 windows done", "about 40 s left. You can keep working; the fold continues in the background.", "Cancel"}},
		{model.Task{Status: "running", Progress: &model.Progress{Stage: "evidence"}}, []string{"Reading the chimeric reads…"}},
		{model.Task{Status: "failed", FinishedAt: at(0), Error: "10807 nt exceeds the CPLfold limit of 5331 nt for this memory budget (pseudoknot-free)."},
			[]string{"The fold failed", "The region is longer than CPLfold can fold with the memory tasks may use.",
				"Next: fold shorter windows, or raise Memory in Preferences.", "Technical details", "Run fold"}},
		{model.Task{Status: "failed", FinishedAt: at(0), Error: "ValueError: no intramolecular X chimeras fall inside the requested region"},
			[]string{"No chimeric read of these samples has both arms inside the folded region, so there is no evidence to guide the fold."}},
		{model.Task{Status: "failed", FinishedAt: at(0), Error: "Segmentation fault"},
			[]string{"CPLfold stopped with an error.", "Next: run it again; if it fails again, send the technical details below to the RNAxRay team."}},
		{model.Task{Status: "cancelled"}, []string{"Fold cancelled", "Nothing was saved, including windows that had already been folded. Change the form if needed, then run it again."}},
		{model.Task{Status: "interrupted"}, []string{"Fold stopped", "Run it again", "RNAxRay Desktop closed while it ran. Nothing was saved; it starts from the beginning."}},
		{model.Task{Status: "succeeded"}, []string{"Fold finished", "It is shown in the viewer and listed under Results."}},
	}
	a, _, tt = stStatesFixture(t, 3)
	if err := tt.Click("Run fold"); err != nil {
		t.Fatal(err)
	}
	csSettle(a, tt)
	for _, s := range states {
		stTaskState(a, tt, s.task)
		expect(tt, s.texts...)
	}
	// A running fold cannot be started twice; Cmd+Enter does nothing then.
	stTaskState(a, tt, model.Task{Status: "running"})
	p = a.PageFor("structure").(*structurePage)
	before := len(a.TaskList())
	p.runFold()
	csSettle(a, tt)
	if len(a.TaskList()) != before {
		t.Fatal("a second fold started while one runs")
	}
}

// TestStructureNativeLimitAndFocus: the native CPLfold limit is shown up
// front (from the task memory budget, no capacity test), a fold longer than
// it is refused at its field with what to do, and a fold started here takes
// the keyboard focus to the viewer's heading and is announced once.
func TestStructureNativeLimitAndFocus(t *testing.T) {
	expect := func(tt *ui.Tester, texts ...string) {
		t.Helper()
		for _, text := range texts {
			if !tt.HasText(text) {
				t.Fatalf("lacks %q: %q", text, tt.Texts())
			}
		}
	}
	a, _, tt := stStatesFixture(t, 3)
	p := a.PageFor("structure").(*structurePage)
	p.gene = africaGene
	p.budgetMB = 24576
	tt.Frame()
	expect(tt, "Native CPLfold · up to 13,325 nt per fold in the memory tasks may use · no capacity test")
	if tt.HasText("without pseudoknots") || tt.HasText("Predict the secondary structure of one RNA, guided by the chimeric reads of your samples.") {
		t.Fatal("a hint the page already gives is repeated")
	}
	// Longer than the limit: said at the field, and Run fold waits.
	p.budgetMB = 8192
	tt.Frame()
	limit := FormatNumber(int64(core.CPLfoldMaxNT(8192, false)))
	expect(tt, "Native CPLfold · up to "+limit+" nt per fold in the memory tasks may use · no capacity test",
		"This RNA (10,807 nt) is longer: fold windows of at most "+limit+" nt, or raise Memory in Preferences.", "Cannot run yet:")
	// Windows folded at once share the memory; pseudoknots cost more.
	p.mode, p.windows, p.pseudoknot, p.workers = "windows", "1-3000\n3001-9000", true, 2
	tt.Frame()
	half := FormatNumber(int64(core.CPLfoldMaxNT(4096, true)))
	expect(tt, "Native CPLfold · up to "+half+" nt per fold with pseudoknots, 2 windows at once in the memory tasks may use · no capacity test",
		"The longest window (6,000 nt) is longer: fold windows of at most "+half+" nt, fewer windows at once (Advanced), or raise Memory in Preferences.")
	p.mode, p.budgetMB = "genome", 0
	tt.Frame()
	expect(tt, "Native CPLfold on this computer · no capacity test")
	if tt.HasText("This RNA (10,807 nt) is longer") {
		t.Fatal("over the limit while the budget is unknown")
	}

	// A fold started here arrives: focus on the heading, announced once.
	e := p.structures[0]
	p.pendingShow = e.TaskID
	p.resolvePair()
	csSettle(a, tt)
	label := "Viewer: " + stResultLabel(&e)
	if !tt.Focused(label) {
		t.Fatalf("the new result's heading %q has no focus", label)
	}
	announced := 0
	for _, text := range tt.Announcements() {
		if text == "Structure ready · "+stResultLabel(&e) {
			announced++
		}
	}
	tt.Frame()
	if announced != 1 || p.focusResult != "" {
		t.Fatalf("announced %d times %q, focusResult %q", announced, tt.Announcements(), p.focusResult)
	}
	// Showing another result by hand does not take the focus.
	if err := tt.Click("Show"); err != nil {
		t.Fatal(err)
	}
	csSettle(a, tt)
	if p.focusResult != "" {
		t.Fatal("a result shown by hand asks for the focus")
	}
}
