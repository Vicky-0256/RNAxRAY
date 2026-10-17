//go:build e2e

// End to end through the native views, the real core and the bundled
// runtime, with real ZIKV data: create a project, import a sample sheet
// (two FASTQ subsets and two linked .hyb), run the pipeline from the Data
// page, run the differential test on Compare, and fold a window on
// Structure. Needs the staged runtime and the data paths below:
//
//	RNAXRAY_E2E_SHEET=<samples.tsv> RNAXRAY_SNAPSHOT_DIR=<dir> \
//	  CGO_ENABLED=0 go test -tags e2e -run TestEndToEnd -timeout 60m -v .
package main

import (
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/views"
)

// queue is a Poster whose work the test drains on its own goroutine, as
// the main thread would.
type queue struct {
	mu  sync.Mutex
	fns []func()
}

func (q *queue) Update(fn func()) {
	q.mu.Lock()
	q.fns = append(q.fns, fn)
	q.mu.Unlock()
}

func (q *queue) drain() {
	q.mu.Lock()
	fns := q.fns
	q.fns = nil
	q.mu.Unlock()
	for _, fn := range fns {
		fn()
	}
}

type driver struct {
	t  *testing.T
	q  *queue
	tt *ui.Tester
	a  *views.App
}

func (d *driver) frame() {
	d.q.drain()
	d.a.Flush()
	d.tt.Frame()
}

// until frames until ok, failing after timeout.
func (d *driver) until(what string, timeout time.Duration, ok func() bool) {
	d.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		d.frame()
		if ok() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	d.shot("timeout-" + strings.ReplaceAll(what, " ", "-"))
	d.t.Fatalf("%s: timed out; texts %q", what, d.tt.Texts())
}

func (d *driver) click(text string) {
	d.t.Helper()
	d.frame()
	if err := d.tt.Click(text); err != nil {
		d.shot("click-failed")
		d.t.Fatalf("click %q: %v; texts %q", text, err, d.tt.Texts())
	}
	d.frame()
}

// clickField focuses the input under a visible field label.
func (d *driver) clickField(label string) {
	d.t.Helper()
	d.frame()
	r, ok := d.tt.Find(label)
	if !ok {
		d.t.Fatalf("no field %q", label)
	}
	d.tt.ClickAt(r.X+20, r.Y+r.H+14)
	d.frame()
}

// newProject fills the start page: the project folder <parent>/<name>.rnaxrayproj.
func (d *driver) newProject(parent, name string) {
	d.t.Helper()
	views.PickFolder = func(string) string { return parent }
	d.click("Change…")
	d.clickField("Project name")
	d.tt.Type(name)
	d.click("Create project")
}

func (d *driver) has(text string) bool {
	for _, s := range d.tt.Texts() {
		if strings.Contains(s, text) {
			return true
		}
	}
	return false
}

func (d *driver) shot(name string) {
	dir := os.Getenv("RNAXRAY_SNAPSHOT_DIR")
	if dir == "" {
		return
	}
	f, err := os.Create(filepath.Join(dir, "e2e-"+name+".png"))
	if err != nil {
		return
	}
	defer f.Close()
	_ = png.Encode(f, d.tt.Image())
}

func (d *driver) tasksDone(kind string, n int) bool {
	done := 0
	for _, task := range d.a.Tasks {
		if task.Kind != kind {
			continue
		}
		if task.Status == "failed" || task.Status == "interrupted" || task.Status == "cancelled" {
			d.t.Fatalf("%s task %s: %s", kind, task.Status, task.ErrorText())
		}
		if task.Status == "succeeded" {
			done++
		}
	}
	return done >= n
}

func TestEndToEnd(t *testing.T) {
	sheet := os.Getenv("RNAXRAY_E2E_SHEET")
	if sheet == "" {
		t.Skip("RNAXRAY_E2E_SHEET is not set")
	}
	root := repoRoot()
	python := filepath.Join(root, "desktop", "resources", "native", "python", "bin", "python3")
	rt, err := core.NewRuntime(core.Bridge{Root: root, Python: python}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := core.NewService(rt, core.ServiceOptions{PreferencesPath: filepath.Join(t.TempDir(), "preferences.json")})
	defer service.Shutdown()
	q := &queue{}
	app := views.New(service, q, t.TempDir())
	defer app.Stop()
	d := &driver{t: t, q: q, a: app, tt: ui.NewTester(app.View, 1280, 860)}
	views.PickFiles = func(string, bool) []string { return []string{sheet} }
	started := time.Now()
	lap := func(what string) { t.Logf("[%6.1fs] %s", time.Since(started).Seconds(), what) }

	// 1. New project from the start page.
	parent, _ := filepath.EvalSymlinks(t.TempDir())
	project := filepath.Join(parent, "E2E ZIKV.rnaxrayproj")
	d.newProject(parent, "E2E ZIKV")
	d.until("project opens", 60*time.Second, func() bool { return app.Project != nil })
	if app.Project.Path != project {
		t.Fatalf("project at %s, want %s", app.Project.Path, project)
	}
	lap("project created")

	// 2. Import the sample sheet (preview, then import).
	d.click("Import sample sheet…")
	d.until("sheet preview", 60*time.Second, func() bool { return d.has("Nothing has been imported yet") })
	d.shot("sheet-preview")
	d.click("Import 4 samples")
	d.until("samples imported", 60*time.Second, func() bool { return len(app.Project.Samples) == 4 })
	lap("4 samples imported")

	// 3. Run all pending from the Data page, through the disk estimate.
	d.until("pending samples", 30*time.Second, func() bool { return d.has("Run all pending (") })
	for _, label := range []string{"Run all pending (4)", "Run all pending (2)"} {
		if d.has(label) {
			d.click(label)
			break
		}
	}
	d.until("disk estimate", 60*time.Second, func() bool { return d.has("Start") })
	d.shot("disk-estimate")
	if d.has("Start anyway") {
		d.click("Start anyway")
	} else {
		d.click("Start")
	}
	d.until("pipelines finish", 40*time.Minute, func() bool { return d.tasksDone("sample_pipeline", 2) })
	lap("pipelines finished")
	d.until("samples ready", 5*time.Minute, func() bool {
		for _, s := range app.Project.Samples {
			if !s.IsReady() {
				return false
			}
		}
		return true
	})
	d.shot("data-done")
	lap("all samples analysed")

	// 4. QC shows counts.
	app.Navigate("qc", nil)
	d.until("qc counts", 2*time.Minute, func() bool { return d.has("224,154") })
	d.shot("qc")
	lap("QC counts")

	// 5. Compare: differential test SUB vs AFR.
	app.Navigate("compare", nil)
	d.click("Run differential test")
	d.until("compare finishes", 20*time.Minute, func() bool { return d.tasksDone("compare", 1) })
	d.until("compare result", 2*time.Minute, func() bool { return d.has("Significant cells") })
	d.shot("compare")
	lap("differential test")

	// 6. Explore contact map loads.
	app.Navigate("explore", map[string]any{"tab": "contact"})
	d.until("contact map", 2*time.Minute, func() bool { return d.has("Colour cap") })
	d.shot("explore")
	lap("contact map")

	// 7. Structure: fold one window with AFR evidence.
	app.Navigate("structure", map[string]any{"prefill": map[string]any{
		"gene": "ZIKV_African_KX377335-1_virusRNA", "windows": []map[string]int{{"start": 3170, "end": 3700}},
		"selectionKey": "c:AFR", "source": "the end-to-end test"}})
	d.until("prefill", 30*time.Second, func() bool { return d.has("Prefilled from the end-to-end test") })
	d.until("fold estimate", 30*time.Second, func() bool { return d.has("Check before running") })
	d.shot("structure-prefill")
	// A finished-task toast may cover the pinned Run fold button for a few
	// seconds; a person waits for it to go, so does the test.
	d.until("toasts gone", time.Minute, func() bool {
		for _, text := range d.tt.Texts() {
			if strings.HasSuffix(text, " finished") {
				return false
			}
		}
		return true
	})
	d.click("Run fold")
	d.shot("structure-started")
	d.until("fold finishes", 20*time.Minute, func() bool { return d.tasksDone("structure", 1) })
	d.until("arc viewer", 2*time.Minute, func() bool { return d.has("Base pairs") })
	d.shot("structure")
	lap("structure fold")
}
