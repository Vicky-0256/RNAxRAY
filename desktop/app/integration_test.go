package main

import (
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/views"
)

// TestRealStackHeadless drives the native views against the real Service
// and bridge: create a project, add a .hyb sample, index it as a task, and
// see the sample become ready.
func TestRealStackHeadless(t *testing.T) {
	root := repoRoot()
	python := filepath.Join(root, "desktop", "resources", "native", "python", "bin", "python3")
	if goruntime.GOOS == "windows" {
		python = filepath.Join(root, "desktop", "resources", "native", "python", "python.exe")
	}
	if _, err := os.Stat(python); err != nil {
		t.Skip("staged runtime not available")
	}
	rt, err := core.NewRuntime(core.Bridge{Root: root, Python: python}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := core.NewService(rt, core.ServiceOptions{PreferencesPath: filepath.Join(t.TempDir(), "preferences.json")})
	t.Cleanup(service.Shutdown)

	project := filepath.Join(t.TempDir(), "study.rnaxrayproj")
	// No window: posted work queues and app.Flush applies it on this
	// goroutine, as the main thread would (the test drives the frames).
	app := views.New(service, nil, t.TempDir())
	tt := ui.NewTester(app.View, 1280, 820)
	if _, err := service.CreateProject(project, "Headless", ""); err != nil {
		t.Fatal(err)
	}
	reference := filepath.Join(root, "data", "Zika_18S_formatted.fasta")
	if _, err := service.ProjectOp(project, "add_reference", core.Obj{"source": reference, "mode": "linked"}); err != nil {
		t.Fatal(err)
	}
	hyb := filepath.Join(root, "pipeline", "tests", "golden", "testData.hyb")
	added, err := service.ProjectOp(project, "add_sample", core.Obj{"source": hyb, "name": "T1", "condition": "test",
		"reference": reference, "gene_id": "18S_rRNA", "mode": "linked"})
	if err != nil {
		t.Fatal(err)
	}
	sample := added["sample"].(map[string]any)["id"].(string)

	app.Open(project)
	waitFor(t, app, tt, func() bool { return app.Project != nil })
	if !tt.HasText("Headless") {
		t.Fatalf("texts %q", tt.Texts())
	}
	app.StartTask(core.TaskStartRequest{Kind: "analysis_index", SampleID: &sample}, "Index · T1", nil)
	waitFor(t, app, tt, func() bool { return len(app.Tasks) == 1 })
	// The app polls only with a window; poll by hand here.
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		app.RefreshTasks()
		time.Sleep(50 * time.Millisecond)
		app.Flush()
		tt.Frame()
		done := false
		for _, task := range app.Tasks {
			done = !task.Active()
			if done && task.Status != "succeeded" {
				t.Fatalf("task %+v", task)
			}
		}
		if done {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	app.RefreshProject()
	waitFor(t, app, tt, func() bool { s := app.Project.Sample(sample); return s != nil && s.IsReady() })
	if keys := app.SelectionOptions(); len(keys) == 0 || keys[0].Key != "c:test" {
		t.Fatalf("selection options %+v", keys)
	}
}

func waitFor(t *testing.T, app *views.App, tt *ui.Tester, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		app.Flush()
		tt.Frame()
		if ok() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("condition not reached")
}

// TestPackedRuntime unpacks the app's packed runtime (pack-runtime.py output
// in resources/<platform>) the way a packaged app does on first launch,
// imports the native packages with it and runs the bridge's detect.
// RNAXRAY_PACKED_RUNTIME names the resources directory; CI sets it.
func TestPackedRuntime(t *testing.T) {
	resources := os.Getenv("RNAXRAY_PACKED_RUNTIME")
	if resources == "" {
		t.Skip("RNAXRAY_PACKED_RUNTIME is not set")
	}
	archive, digest, ok, err := core.PackedRuntime(resources)
	if err != nil || !ok {
		t.Fatalf("no packed runtime in %s: %v", resources, err)
	}
	cache := t.TempDir()
	started := time.Now()
	bridge, err := core.UnpackRuntime(archive, digest, cache)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("unpacked in %.1f s", time.Since(started).Seconds())
	cmd := exec.Command(bridge.Python, "-c", "import numpy, numba, RNA; numpy.linalg.inv(numpy.eye(3)); print(numpy.__version__, numba.__version__)")
	cmd.Env = append(os.Environ(), "PYTHONDONTWRITEBYTECODE=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("imports failed: %v\n%s", err, out)
	}
	t.Logf("packages: %s", out)
	rt, err := core.NewRuntime(*bridge, cache)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Shutdown()
	detected, err := rt.Call(core.Control, map[string]any{"operation": "detect"})
	if err != nil || detected["ok"] != true {
		t.Fatalf("detect: %v %v", err, detected)
	}
}
