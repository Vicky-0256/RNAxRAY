//go:build e2e

// Acceptance of a new user's path through the native views, the real core
// and the bundled runtime, with real ZIKV reads: success, missing input
// (no reference, moved file), a failing task, a cancelled task, offline
// lookup, and reopening the project to look at what is there. Each step
// checks that the task status, the files on disk and the page agree.
//
// RNAXRAY_FLOW_DATA=<dir with main/ and extra/> RNAXRAY_FLOW_OUT=<empty dir>
// RNAXRAY_SNAPSHOT_DIR=<dir>; run it offline (no outbound network) for the
// lookup step, e.g. under sandbox-exec. See desktop/VERIFICATION.md.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
	"rnaxraydesktop/views"
)

// flowStack is one launch of the app: runtime, service and views.
type flowStack struct {
	service *core.Service
	app     *views.App
	d       *driver
}

func newFlowStack(t *testing.T, out string) *flowStack {
	t.Helper()
	root := repoRoot()
	python := filepath.Join(root, "desktop", "resources", "native", "python", "bin", "python3")
	rt, err := core.NewRuntime(core.Bridge{Root: root, Python: python}, filepath.Join(out, "cache"))
	if err != nil {
		t.Fatal(err)
	}
	service := core.NewService(rt, core.ServiceOptions{PreferencesPath: filepath.Join(out, "userdata", "preferences.json"),
		EvidenceCacheDir: filepath.Join(out, "cache", "evidence"), EvidenceLogDir: filepath.Join(out, "logs")})
	q := &queue{}
	app := views.New(service, q, filepath.Join(out, "userdata"))
	return &flowStack{service: service, app: app, d: &driver{t: t, q: q, a: app, tt: ui.NewTester(app.View, 1400, 1000)}}
}

func (s *flowStack) close() {
	s.app.Stop()
	s.service.Shutdown()
}

func flowSample(a *views.App, name string) *model.Sample {
	for i, s := range a.Project.Samples {
		if s.Label() == name {
			return &a.Project.Samples[i]
		}
	}
	return nil
}

func flowStage(s *model.Sample, name string) string { return s.Stages[name].Status }

// flowIdle frames until n tasks besides before exist and none is queued
// or running.
func flowIdle(d *driver, what string, before map[string]bool, n int, timeout time.Duration) {
	d.until(what, timeout, func() bool {
		fresh := 0
		for id := range d.a.Tasks {
			if !before[id] {
				fresh++
			}
		}
		return fresh >= n && len(d.a.ActiveTasks()) == 0
	})
	d.a.RefreshProject()
	d.frame()
	time.Sleep(300 * time.Millisecond)
	d.frame()
}

// flowTask is the sample's latest pipeline task, found by its label (a
// task that fails before writing a stage leaves no task id in the stages).
func flowTask(a *views.App, s *model.Sample) (model.Task, bool) {
	var found model.Task
	ok := false
	for _, task := range a.Tasks {
		if a.TaskLabel(task) == "Pipeline · "+s.Label() && (!ok || task.StartedAt > found.StartedAt) {
			found, ok = task, true
		}
	}
	return found, ok
}

func flowTaskIDs(a *views.App) map[string]bool {
	ids := map[string]bool{}
	for id := range a.Tasks {
		ids[id] = true
	}
	return ids
}

func flowExists(project, rel string) bool {
	if rel == "" {
		return false
	}
	if !filepath.IsAbs(rel) {
		rel = filepath.Join(project, rel)
	}
	info, err := os.Stat(rel)
	return err == nil && info.Size() > 0
}

func flowLines(t *testing.T, path string) int64 {
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var n int64
	scan := bufio.NewScanner(f)
	scan.Buffer(make([]byte, 1<<20), 1<<24)
	for scan.Scan() {
		n++
	}
	return n
}

// rowTexts are the page texts from the row of label up to the next sample.
func rowTexts(d *driver, label string, others []string) []string {
	texts := d.tt.Texts()
	var out []string
	in := false
	for _, s := range texts {
		if s == label {
			in = true
		} else if in {
			for _, o := range others {
				if s == o && o != label {
					return out
				}
			}
		}
		if in {
			out = append(out, s)
		}
	}
	return out
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if strings.Contains(x, s) {
			return true
		}
	}
	return false
}

func TestAcceptanceFlow(t *testing.T) {
	data, out := os.Getenv("RNAXRAY_FLOW_DATA"), os.Getenv("RNAXRAY_FLOW_OUT")
	if data == "" || out == "" {
		t.Skip("RNAXRAY_FLOW_DATA and RNAXRAY_FLOW_OUT are not set")
	}
	log := map[string]any{}
	record := func(step string, v any) {
		log[step] = v
		raw, _ := json.MarshalIndent(log, "", "  ")
		_ = os.WriteFile(filepath.Join(out, "flow-result.json"), raw, 0o644)
		t.Logf("%s: %v", step, v)
	}
	started := time.Now()
	lap := func(what string) { t.Logf("[%6.1fs] %s", time.Since(started).Seconds(), what) }

	s := newFlowStack(t, out)
	d, app := s.d, s.app
	names := []string{"big_rep1", "broken_rep1", "moved_rep1", "ok_rep1", "noref_rep1"}

	// 1. New project from the start page.
	d.newProject(out, "Flow acceptance")
	d.until("project opens", 60*time.Second, func() bool { return app.Project != nil })
	project := app.Project.Path
	lap("project created")

	// 2. Import the main folder (reads + FASTA), then a folder without a FASTA.
	views.PickFolder = func(string) string { return filepath.Join(data, "main") }
	d.click("Import data folder…")
	d.until("main scan", 60*time.Second, func() bool { return d.has("Import 4 samples") })
	if d.has("has no reference") {
		t.Errorf("main folder: no-reference warning although every row has one")
	}
	d.shot("flow-import-main")
	d.click("Import 4 samples")
	d.until("4 imported", 60*time.Second, func() bool { return len(app.Project.Samples) == 4 })
	views.PickFolder = func(string) string { return filepath.Join(data, "extra") }
	d.click("Import data folder…")
	d.until("extra scan", 60*time.Second, func() bool { return d.has("Import 1 sample") })
	warned := d.has("1 sample has no reference: it can be imported but not run until you set one.")
	d.shot("flow-import-extra")
	d.click("Import 1 sample")
	d.until("5 imported", 60*time.Second, func() bool { return len(app.Project.Samples) == 5 })
	record("import", map[string]any{"samples": len(app.Project.Samples), "no_reference_warning": warned})
	if !warned {
		t.Errorf("extra folder: no warning for the row without a reference")
	}
	lap("5 samples imported")

	// 3. Missing input: move one reads file away, then Check inputs.
	moved := filepath.Join(data, "main", "moved_rep1.fastq")
	if err := os.Rename(moved, moved+".away"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Rename(moved+".away", moved) })
	d.click("Check inputs")
	d.until("check summary", 60*time.Second, func() bool { return d.has("Inputs checked:") })
	checkOK := d.has("Inputs checked: 5 ok, 1 missing, 0 changed. 1 sample has no reference.")
	noRefRow := rowTexts(d, "noref_rep1", names)
	movedRow := rowTexts(d, "moved_rep1", names)
	d.shot("flow-check-inputs")
	record("check_inputs", map[string]any{"summary_ok": checkOK, "noref_row": noRefRow, "moved_row": movedRow})
	if !checkOK {
		t.Errorf("check summary: %q", d.tt.Texts())
	}
	if !contains(noRefRow, "No reference") || !contains(noRefRow, "Set reference…") {
		t.Errorf("noref row: %q", noRefRow)
	}
	if !contains(movedRow, "missing") || !contains(movedRow, "Relink…") {
		t.Errorf("moved row: %q", movedRow)
	}

	// 4. Cancel: run the big sample alone and cancel it while it maps.
	d.click("Select big_rep1")
	d.click("Run selected (1)")
	d.until("estimate big", 60*time.Second, func() bool { return d.has("Start") })
	if d.has("Start anyway") {
		d.click("Start anyway")
	} else {
		d.click("Start")
	}
	d.until("big running", 3*time.Minute, func() bool {
		for _, task := range app.Tasks {
			if task.Status == "running" && task.Progress != nil && task.Progress.Stage == "map" {
				return true
			}
		}
		return false
	})
	time.Sleep(3 * time.Second)
	d.frame()
	d.shot("flow-big-running")
	d.click("Cancel")
	flowIdle(d, "big cancelled", nil, 1, 3*time.Minute)
	big := flowSample(app, "big_rep1")
	bigTask, _ := flowTask(app, big)
	bigRow := rowTexts(d, "big_rep1", names)
	d.shot("flow-cancelled")
	record("cancel", map[string]any{"task": bigTask.Status, "stages": big.Stages, "index_file": flowExists(project, big.Outputs.Index),
		"hyb_file": flowExists(project, big.Outputs.Hyb), "row": bigRow})
	if bigTask.Status != "cancelled" {
		t.Errorf("big task %q, want cancelled", bigTask.Status)
	}
	if flowStage(big, "index") == "succeeded" || flowExists(project, big.Outputs.Index) {
		t.Errorf("cancelled sample has an index: %+v", big.Stages)
	}
	if !contains(bigRow, "cancelled") || !contains(bigRow, "Resume") || contains(bigRow, "Explore") {
		t.Errorf("cancelled row: %q", bigRow)
	}
	lap("cancel checked")

	// 5. Run ok, broken, moved and noref together: noref is left out.
	for _, name := range []string{"ok_rep1", "broken_rep1", "moved_rep1", "noref_rep1"} {
		d.click("Select " + name)
	}
	before := flowTaskIDs(app)
	d.click("Run selected (4)")
	d.until("estimate 3", 60*time.Second, func() bool { return d.has("Run 3 samples") })
	leftOut := d.has("noref_rep1 is left out: it has no reference. Use Set reference… in its row.")
	d.shot("flow-run-dialog")
	if d.has("Start anyway") {
		d.click("Start anyway")
	} else {
		d.click("Start")
	}
	flowIdle(d, "three runs", before, 3, 20*time.Minute)
	d.frame()
	d.shot("flow-after-runs")
	lap("runs finished")
	result := map[string]any{"noref_left_out_message": leftOut}
	if !leftOut {
		t.Errorf("run dialog did not say noref_rep1 is left out: %q", d.tt.Texts())
	}

	// Success: every stage done, the files exist, the counts agree.
	ok := flowSample(app, "ok_rep1")
	okTask, _ := flowTask(app, ok)
	okRow := rowTexts(d, "ok_rep1", names)
	hybPath := filepath.Join(project, ok.Outputs.Hyb)
	var hybrids int64
	if flowExists(project, ok.Outputs.Hyb) {
		hybrids = flowLines(t, hybPath)
	}
	result["ok"] = map[string]any{"task": okTask.Status, "stages": ok.Stages, "hyb": ok.Outputs.Hyb, "index": ok.Outputs.Index,
		"hyb_file": flowExists(project, ok.Outputs.Hyb), "index_file": flowExists(project, ok.Outputs.Index), "hyb_lines": hybrids, "row": okRow}
	if okTask.Status != "succeeded" || flowStage(ok, "map") != "succeeded" || flowStage(ok, "hyb") != "succeeded" || flowStage(ok, "index") != "succeeded" {
		t.Errorf("ok sample: task %q stages %+v (%s)", okTask.Status, ok.Stages, okTask.ErrorText())
	}
	if !flowExists(project, ok.Outputs.Hyb) || !flowExists(project, ok.Outputs.Index) || hybrids == 0 {
		t.Errorf("ok sample outputs: %+v, %d hybrids", ok.Outputs, hybrids)
	}
	if !contains(okRow, "index done") || !contains(okRow, "Explore") {
		t.Errorf("ok row: %q", okRow)
	}

	// A failing task (truncated .gz) and a missing reads file: failed, with
	// a reason, never shown as done.
	for _, name := range []string{"broken_rep1", "moved_rep1"} {
		s := flowSample(app, name)
		task, known := flowTask(app, s)
		row := rowTexts(d, name, names)
		result[name] = map[string]any{"task": task.Status, "task_known": known, "error": task.ErrorText(), "stages": s.Stages,
			"index_file": flowExists(project, s.Outputs.Index), "row": row}
		if task.Status != "failed" {
			t.Errorf("%s task %q (known %v), want failed", name, task.Status, known)
		}
		if flowStage(s, "index") == "succeeded" || flowExists(project, s.Outputs.Index) {
			t.Errorf("%s: failed sample has an index", name)
		}
		if !contains(row, "failed") || contains(row, "index done") || contains(row, "Explore") {
			t.Errorf("%s row does not show the failure: %q", name, row)
		}
		if reason := ShortReason(task.ErrorText()); reason == "" || !contains(row, reason) {
			t.Errorf("%s row lacks the reason %q: %q", name, reason, row)
		}
	}
	noref := flowSample(app, "noref_rep1")
	_, norefStarted := flowTask(app, noref)
	result["noref"] = map[string]any{"started": norefStarted, "stages": noref.Stages}
	if norefStarted {
		t.Errorf("noref_rep1 was started")
	}
	record("runs", result)

	// Explore the success: the page shows the hybrids of the .hyb file.
	d.click("Explore")
	want := views.FormatNumber(hybrids) + " hybrids"
	d.until("explore ok", 2*time.Minute, func() bool { return d.has(want) || d.has("Could not") })
	exploreOK := d.has(want)
	d.shot("flow-explore")
	record("explore", map[string]any{"want": want, "shown": exploreOK})
	if !exploreOK {
		t.Errorf("explore: want %q: %q", want, d.tt.Texts())
	}

	// 6. Offline lookup: turn lookups on and ask; it must fail visibly.
	d.click("Preferences")
	d.until("prefs", 30*time.Second, func() bool { return d.has("Allow external public-data lookups (RNAcentral)") })
	d.click("Allow external public-data lookups (RNAcentral)")
	d.until("notice", 10*time.Second, func() bool { return d.has("Before you turn this on") })
	d.click("Turn on")
	d.click("Test connection")
	d.until("connection test", 90*time.Second, func() bool {
		return !d.has("Testing") && (d.has("Could not") || d.has("tools") || d.has("RNAcentral"))
	})
	d.shot("flow-offline-test-connection")
	prefsTexts := d.tt.Texts()
	// Offline, the helper still starts: the message must not claim RNAcentral was reached.
	if contains(prefsTexts, "Connected") || !contains(prefsTexts, "This does not contact RNAcentral") {
		t.Errorf("offline connection test: %q", prefsTexts)
	}
	d.tt.Key(0, ui.KeyEscape)
	d.frame()
	app.Navigate("structure", nil)
	d.until("research panel", 30*time.Second, func() bool { return d.has("Public identifier") })
	d.clickField("Public identifier")
	d.tt.Type("hsa-mir-21")
	d.clickField("Species (taxon)")
	d.tt.Type("9606")
	d.click("I confirm this identifier and species refer to the RNA I am studying")
	d.click("View existing summary")
	d.until("lookup answer", 2*time.Minute, func() bool {
		return !d.has("Asking RNAcentral…") && d.has("Nothing is concluded") || d.has("Summary found") || d.has("Not found or no summary") || d.has("No summary available")
	})
	d.shot("flow-offline-lookup")
	falseEmpty := d.has("Not found or no summary") || d.has("No summary available") || d.has("Summary found")
	record("offline", map[string]any{"test_connection": prefsTexts, "lookup_failed_visibly": d.has("Nothing is concluded"), "shown_as_empty_or_found": falseEmpty,
		"texts": d.tt.Texts()})
	if falseEmpty || !d.has("Nothing is concluded") {
		t.Errorf("offline lookup: %q", d.tt.Texts())
	}
	lap("offline lookup checked")

	// 7. Quit, relaunch, reopen from Recent projects, look at what is there.
	s.close()
	s = newFlowStack(t, out)
	d, app = s.d, s.app
	defer func() { s.close() }()
	d.frame()
	d.click("Flow acceptance")
	d.until("reopened", 60*time.Second, func() bool { return app.Project != nil && len(app.Project.Samples) == 5 })
	app.Navigate("data", nil)
	d.until("rows", 30*time.Second, func() bool { return d.has("ok_rep1") })
	time.Sleep(500 * time.Millisecond)
	d.frame()
	d.shot("flow-reopened-data")
	reopened := map[string]any{}
	for _, name := range names {
		reopened[name] = rowTexts(d, name, names)
	}
	record("reopen_data", reopened)
	if r := rowTexts(d, "ok_rep1", names); !contains(r, "index done") {
		t.Errorf("reopened ok row: %q", r)
	}
	if r := rowTexts(d, "big_rep1", names); !contains(r, "cancelled") || contains(r, "index done") {
		t.Errorf("reopened big row: %q", r)
	}
	for _, name := range []string{"broken_rep1", "moved_rep1"} {
		if r := rowTexts(d, name, names); !contains(r, "failed") || contains(r, "index done") {
			t.Errorf("reopened %s row: %q", name, r)
		}
	}
	// The file is still moved: checked on open, it is marked with Relink.
	d.until("moved marked", 30*time.Second, func() bool { return contains(rowTexts(d, "moved_rep1", names), "Relink…") })
	if r := rowTexts(d, "moved_rep1", names); !contains(r, "missing") {
		t.Errorf("reopened moved row not marked missing: %q", r)
	}
	d.click("Explore")
	d.until("explore reopened", 2*time.Minute, func() bool { return d.has(want) || d.has("Could not") })
	record("reopen_explore", map[string]any{"shown": d.has(want)})
	if !d.has(want) {
		t.Errorf("reopened explore: want %q: %q", want, d.tt.Texts())
	}
	app.Navigate("report", nil)
	d.until("report", 2*time.Minute, func() bool { return d.has("analysed)") })
	d.shot("flow-reopened-report")
	reportOK := d.has("5 (1 analysed)")
	// The settings ok_rep1 was run with come from its real checkpoint; a
	// failed sample is not shown as "not run".
	settingsOK := d.has("blast_threshold 0.1 · max_overlap 4 · max_hits 10 · energy off · pipeline format ")
	failedOK := d.has("no hybrids: the last run failed at map")
	record("reopen_report", map[string]any{"partial_shown": reportOK, "settings_shown": settingsOK, "failed_run_shown": failedOK})
	if !reportOK {
		t.Errorf("report does not say 1 of 5 analysed: %q", d.tt.Texts())
	}
	if !settingsOK || !failedOK {
		t.Errorf("report pipeline settings: recorded %v, failed run %v: %q", settingsOK, failedOK, d.tt.Texts())
	}

	// 8. A query that fails is not shown as an empty result: damage the
	// index, reopen, and look again.
	index := filepath.Join(project, ok.Outputs.Index)
	saved, err := os.ReadFile(index)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(index, []byte("not an index"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.WriteFile(index, saved, 0o644) })
	s.close()
	s = newFlowStack(t, out)
	d, app = s.d, s.app
	d.frame()
	d.click("Flow acceptance")
	d.until("reopened 2", 60*time.Second, func() bool { return app.Project != nil })
	app.Navigate("data", nil)
	d.until("rows 2", 30*time.Second, func() bool { return d.has("ok_rep1") })
	d.click("Explore")
	d.until("explore damaged", 2*time.Minute, func() bool { return d.has("Could not") || d.has(want) || d.has("No hybrids") })
	time.Sleep(time.Second)
	d.frame()
	d.shot("flow-damaged-index")
	damaged := map[string]any{"error_shown": d.has("Could not"), "empty_shown": d.has("No hybrids match these filters.") || d.has("0 hybrids"),
		"old_count_shown": d.has(want), "texts": d.tt.Texts()}
	record("damaged_index", damaged)
	if !d.has("Could not") || d.has("No hybrids match these filters.") || d.has(want) {
		t.Errorf("damaged index: %q", d.tt.Texts())
	}
	lap("done")
	fmt.Fprintln(os.Stderr, "flow result:", filepath.Join(out, "flow-result.json"))
}

// ShortReason is the row's one-line failure reason (views.ShortError).
func ShortReason(text string) string { return views.ShortError(text) }
