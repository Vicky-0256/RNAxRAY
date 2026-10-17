package views

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func sleepMS(ms int) { time.Sleep(time.Duration(ms) * time.Millisecond) }

func TestStartPageOpensProject(t *testing.T) {
	f := newFake(t)
	a := New(f, nil, t.TempDir())
	a.SetRuntimeStatus("Runtime: macos arm64 · Python 3.11.17", "")
	tt := ui.NewTester(a.View, 1100, 720)
	for _, text := range []string{"How it works", "Start a new project", "Create project",
		"Open an existing project", "Choose project folder…", "Recent projects", "None yet."} {
		if !tt.HasText(text) {
			t.Fatalf("start page lacks %q: %q", text, tt.Texts())
		}
	}
	snapshot(t, tt, "start")
	a.Open("/missing")
	waitFlush(a)
	tt.Frame()
	if !tt.HasText(openError(errors.New("project.json is missing"))) {
		t.Fatalf("texts %q", tt.Texts())
	}
	a.Open("/projects/zikv.rnaxrayproj")
	waitFlush(a)
	tt.Frame()
	if a.Project == nil || a.Project.Name != "ZIKV GUI check" {
		t.Fatalf("project %+v", a.Project)
	}
	if len(a.recent) != 1 || a.recent[0].Path != "/projects/zikv.rnaxrayproj" {
		t.Fatalf("recent %+v", a.recent)
	}
	// Reopening the app lists the project as recent.
	again := New(f, nil, a.DataDir)
	if len(again.recent) != 1 {
		t.Fatalf("recent not persisted: %+v", again.recent)
	}
}

func TestStartPageCreatesProjectFolder(t *testing.T) {
	f := newFake(t)
	a := New(f, nil, t.TempDir())
	parent := t.TempDir()
	a.start.newParent = parent
	a.start.newName = "ZIKV virion/RNA"
	a.start.dataFolder = "/data/zika_files"
	f.ops["scan_data_folder"] = fixture(t, "data_folder_scan.json")
	tt := ui.NewTester(a.View, 1100, 720)
	if !tt.HasText("After the project is created, its files are matched to samples and references for you to review.") {
		t.Fatalf("texts %q", tt.Texts())
	}
	want := filepath.Join(parent, "ZIKV virion-RNA.rnaxrayproj")
	if !tt.HasText("Creates the folder " + want) {
		t.Fatalf("texts %q", tt.Texts())
	}
	// An existing non-empty folder of that name is not reused.
	if err := os.MkdirAll(filepath.Join(want, "x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := tt.Click("Create project"); err != nil {
		t.Fatal(err)
	}
	waitFlush(a)
	waitFlush(a)
	tt.Frame()
	got := strings.Join(f.calls, ",")
	if !strings.Contains(got, "create:ZIKV virion/RNA") || !strings.Contains(got, "open:"+filepath.Join(parent, "ZIKV virion-RNA 2.rnaxrayproj")) {
		t.Fatalf("calls %s", got)
	}
	// The chosen data folder is scanned on the Data page.
	waitFlush(a)
	tt.Frame()
	waitFlush(a)
	tt.Frame()
	if a.Page != "data" || !strings.Contains(strings.Join(f.calls, ","), "op:scan_data_folder") || !tt.HasText("Import a data folder") {
		t.Fatalf("page %q calls %v", a.Page, f.calls)
	}
}

// While the bundled runtime unpacks on first launch, creating or opening
// a project would only fail with "still being prepared": the start page
// says it is getting ready and waits.
func TestStartPageWaitsForTheRuntime(t *testing.T) {
	f := newFake(t)
	a := New(f, nil, t.TempDir())
	a.recent = []Recent{{Path: "/projects/zikv.rnaxrayproj", Name: "ZIKV GUI check"}}
	picked := 0
	old := PickFolder
	PickFolder = func(string) string { picked++; return "" }
	t.Cleanup(func() { PickFolder = old })
	a.start.newParent = t.TempDir()
	a.start.newName = "ZIKV"
	a.SetRuntimePreparing()
	tt := ui.NewTester(a.View, 1100, 720)
	for _, text := range []string{"Preparing the analysis runtime (first launch only, usually under a minute)…",
		"Waiting for the runtime to be ready."} {
		if !tt.HasText(text) {
			t.Fatalf("start page lacks %q: %q", text, tt.Texts())
		}
	}
	snapshot(t, tt, "start-preparing")
	for _, label := range []string{"Create project", "Choose project folder…", "ZIKV GUI check"} {
		_ = tt.Click(label)
		waitFlush(a)
		tt.Frame()
	}
	if len(f.calls) != 0 || a.Project != nil || picked != 0 {
		t.Fatalf("acted while preparing: %v, %d folder dialogs", f.calls, picked)
	}

	a.SetRuntimeStatus("Runtime: macos arm64 · Python 3.11.17", "")
	tt.Frame()
	if tt.HasText("Waiting for the runtime to be ready.") {
		t.Fatalf("still waiting: %q", tt.Texts())
	}
	if err := tt.Click("ZIKV GUI check"); err != nil {
		t.Fatal(err)
	}
	waitFlush(a)
	if a.Project == nil {
		t.Fatalf("recent project did not open: %v", f.calls)
	}
}

func TestProjectFolderName(t *testing.T) {
	for in, want := range map[string]string{
		"ZIKV virion RNA": "ZIKV virion RNA.rnaxrayproj",
		"a/b\\c:d":        "a-b-c-d.rnaxrayproj",
		"  ..  ":          "project.rnaxrayproj",
		"寨卡 RNA":          "寨卡 RNA.rnaxrayproj",
	} {
		if got := ProjectFolderName(in); got != want {
			t.Errorf("%q -> %q, want %q", in, got, want)
		}
	}
}

func TestShellNavigationSelectionAndTasks(t *testing.T) {
	a, f := openFixture(t)
	tt := ui.NewTester(a.View, 1100, 720)
	for _, text := range []string{"ZIKV GUI check", "1  Data", "6  Report", "Tasks idle"} {
		if !tt.HasText(text) {
			t.Fatalf("shell lacks %q: %q", text, tt.Texts())
		}
	}
	// Conditions come first; the selection defaults to the first.
	options := a.SelectionOptions()
	if len(options) < 3 || options[0].Key != "c:SUB" || !strings.Contains(options[0].Label, "2 replicates merged") {
		t.Fatalf("options %+v", options)
	}
	if got := a.SelectionIDs("c:AFR"); len(got) != 2 {
		t.Fatalf("AFR ids %v", got)
	}
	if a.Selected.Gene != "ZIKV_African_KX377335-1_virusRNA" {
		t.Fatalf("gene %q", a.Selected.Gene)
	}
	if err := tt.Click("4  Compare"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.Page != "compare" {
		t.Fatalf("page %q", a.Page)
	}
	snapshot(t, tt, "shell")
	// A started task shows in the top bar and the drawer.
	a.StartTask(coreTask("sample_pipeline"), "Pipeline · SUB_REP1", nil)
	waitFlush(a)
	tt.Frame()
	if !tt.HasText("1 task running") {
		t.Fatalf("texts %q", tt.Texts())
	}
	if err := tt.Click("1 task running"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	for _, text := range []string{"Pipeline · SUB_REP1", "running", "map · bowtie2 · 25%", "Cancel"} {
		if !tt.HasText(text) {
			t.Fatalf("drawer lacks %q: %q", text, tt.Texts())
		}
	}
	snapshot(t, tt, "drawer")
	if len(f.started) != 1 || f.started[0].ProjectPath != "/projects/zikv.rnaxrayproj" {
		t.Fatalf("started %+v", f.started)
	}
	if err := tt.Click("Cancel"); err != nil {
		t.Fatal(err)
	}
	waitFlush(a)
	tt.Frame()
	if a.Tasks["sample_pipeline-1"].Status != "cancelled" {
		t.Fatalf("task %+v", a.Tasks["sample_pipeline-1"])
	}
}

func TestPreferencesDialog(t *testing.T) {
	a, _ := openFixture(t)
	tt := ui.NewTester(a.View, 1100, 720)
	if err := tt.Click("Preferences"); err != nil {
		t.Fatal(err)
	}
	waitFlush(a)
	tt.Frame()
	if !tt.HasText("Resource budget for tasks") || a.prefs.cpu != 10 {
		t.Fatalf("prefs %+v texts %q", a.prefs, tt.Texts())
	}
	snapshot(t, tt, "preferences")
}

func TestFormatDuration(t *testing.T) {
	for seconds, want := range map[float64]string{0.2: "1 s", 42: "42 s", 84.8: "1 min 25 s", 120: "2 min", 1500: "25 min", 7500: "2 h 05 min"} {
		if got := FormatDuration(seconds); got != want {
			t.Errorf("%v: %q, want %q", seconds, got, want)
		}
	}
}

func TestChartsFollowTheWindow(t *testing.T) {
	a, _ := openFixture(t)
	p := a.PageFor("compare").(*comparePage)
	if got := p.mapSide(); got != 403.04 && (got < 400 || got > 405) {
		t.Fatalf("default map side %v", got)
	}
	a.content = ui.Rect{W: 1700, H: 1100}
	if got := p.mapSide(); got < 680 || got > 682 {
		t.Fatalf("large window map side %v", got)
	}
	a.content = ui.Rect{W: 600, H: 400}
	if got := p.mapSide(); got != 340 {
		t.Fatalf("small window map side %v", got)
	}
}

func TestArmPositionsOpenWhenSet(t *testing.T) {
	a, _ := openFixture(t)
	a.Navigate("explore", nil)
	waitFlush(a)
	tt := ui.NewTester(a.View, 1100, 720)
	if err := tt.Click("Interactions"); err != nil {
		t.Fatal(err)
	}
	waitFlush(a)
	tt.Frame()
	if !tt.HasText("Arm positions") || tt.HasText("Arm 1 from") {
		t.Fatal("arm filters open by default")
	}
	p := a.PageFor("explore").(*explorePage)
	p.ix.x0 = "100"
	tt.Frame()
	tt.Frame()
	if !tt.HasText("Arm positions (1 set)") || !tt.HasText("Arm 1 from") {
		t.Fatalf("texts %q", tt.Texts())
	}
}
