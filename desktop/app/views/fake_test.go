package views

import (
	"encoding/json"
	"errors"
	"image/png"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
)

// fakeBackend answers from testdata fixtures captured from a real project.
type fakeBackend struct {
	mu      sync.Mutex
	calls   []string
	tasks   []core.Obj
	queries map[string]any // operation -> result
	ops     map[string]core.Obj
	started []core.TaskStartRequest
	uiState core.Obj
	// queryErr, when set, is the error of every analysis query.
	queryErr error
}

func fixture(t testing.TB, name string) core.Obj {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	var out core.Obj
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func newFake(t testing.TB) *fakeBackend {
	return &fakeBackend{queries: map[string]any{}, ops: map[string]core.Obj{
		"open_project": fixture(t, "open_project.json"),
		"list_samples": fixture(t, "list_samples.json"),
	}}
}

func (f *fakeBackend) record(name string) {
	f.mu.Lock()
	f.calls = append(f.calls, name)
	f.mu.Unlock()
}

func (f *fakeBackend) Detect() (core.Obj, error) {
	f.record("detect")
	return core.Obj{"ok": true}, nil
}
func (f *fakeBackend) CreateProject(path, name, description string) (core.Obj, error) {
	f.record("create:" + name)
	return core.Obj{"ok": true}, nil
}
func (f *fakeBackend) EstimatePipelines(inputs []core.PipelineInput) core.PipelineEstimate {
	return core.EstimatePipelines(nil, inputs, 10)
}
func (f *fakeBackend) EstimateFold(lengths []int, beam, workers int) core.FoldEstimate {
	return core.EstimateFold(nil, lengths, beam, workers)
}
func (f *fakeBackend) ValidateProject(string, bool) (core.Obj, error) {
	return core.Obj{"ok": true}, nil
}
func (f *fakeBackend) OpenProject(path string) (core.Obj, error) {
	f.record("open:" + path)
	if path == "/missing" {
		return nil, errors.New("project.json is missing")
	}
	return f.ops["open_project"], nil
}
func (f *fakeBackend) UpdateUIState(path string, state core.Obj) (core.Obj, error) {
	f.mu.Lock()
	f.uiState = state
	f.mu.Unlock()
	return core.Obj{"ok": true}, nil
}
func (f *fakeBackend) SaveAnalysisRun(string, core.Obj) (core.Obj, error) {
	return core.Obj{"ok": true}, nil
}
func (f *fakeBackend) ReadInput(string, string) (core.Obj, error) { return core.Obj{"ok": true}, nil }
func (f *fakeBackend) ProjectOp(path, operation string, payload core.Obj) (core.Obj, error) {
	f.record("op:" + operation)
	if r, ok := f.ops[operation]; ok {
		return r, nil
	}
	return nil, errors.New("unsupported project operation " + operation)
}
func (f *fakeBackend) Query(path, operation string, payload core.Obj) (any, error) {
	f.record("query:" + operation)
	if f.queryErr != nil {
		return nil, f.queryErr
	}
	if r, ok := f.queries[operation]; ok {
		return r, nil
	}
	return nil, errors.New("no fixture for " + operation)
}
func (f *fakeBackend) CplfoldPredict(string, string, any, core.Obj) (core.Obj, error) {
	return core.Obj{"ok": true}, nil
}
func (f *fakeBackend) StartTask(req core.TaskStartRequest) (core.Obj, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.started = append(f.started, req)
	id := req.Kind + "-1"
	snapshot := core.Obj{"task_id": id, "kind": req.Kind, "status": "running", "started_at": "2026-10-14T10:00:00Z",
		"progress": core.Obj{"stage": "map", "detail": "bowtie2", "bytes_done": 25.0, "bytes_total": 100.0}}
	f.tasks = append(f.tasks, snapshot)
	return snapshot, nil
}
func (f *fakeBackend) ResumeTask(string, string) (core.Obj, error) {
	return nil, errors.New("not resumable")
}
func (f *fakeBackend) TaskStatus(_, id string) (core.Obj, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, t := range f.tasks {
		if t["task_id"] == id {
			return t, nil
		}
	}
	return nil, errors.New("unknown task")
}
func (f *fakeBackend) CancelTask(_, id string) (core.Obj, error) {
	return core.Obj{"task_id": id, "status": "cancelled"}, nil
}
func (f *fakeBackend) ListTasks(string) ([]core.Obj, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]core.Obj(nil), f.tasks...), nil
}
func (f *fakeBackend) Preferences() (core.Obj, error) {
	return core.Obj{"ok": true, "budget": core.Obj{"cpu": 10.0, "mem_mb": 24576.0}, "custom_budget": false,
		"system": core.Obj{"cpus": 10.0, "mem_mb": 32768.0}}, nil
}
func (f *fakeBackend) SetPreferences(patch core.Obj) (core.Obj, error) { return f.Preferences() }
func (f *fakeBackend) Shutdown()                                       {}

var _ core.Backend = (*fakeBackend)(nil)

// syncPoster runs posted work at once (tests drive frames themselves).
type syncPoster struct{}

func (syncPoster) Update(fn func()) { fn() }

// openFixture returns an app showing the fixture project.
func openFixture(t testing.TB) (*App, *fakeBackend) {
	f := newFake(t)
	a := New(f, nil, "")
	a.Open("/projects/zikv.rnaxrayproj")
	waitFlush(a)
	if a.Project == nil {
		t.Fatalf("project did not open: %q", a.start.status)
	}
	return a, f
}

// waitFlush runs goroutine work posted without a window until none is left.
func waitFlush(a *App) {
	for i := 0; i < 200; i++ {
		a.Flush()
		a.mu.Lock()
		empty := len(a.pending) == 0
		a.mu.Unlock()
		if empty && i > 20 {
			return
		}
		sleepMS(5)
	}
}

// snapshot writes the tester's last frame to $RNAXRAY_SNAPSHOT_DIR/<name>.png.
func snapshot(t testing.TB, tt *ui.Tester, name string) {
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

func coreTask(kind string) core.TaskStartRequest {
	id := "SUB_REP1"
	return core.TaskStartRequest{Kind: kind, SampleID: &id}
}

func (f *fakeBackend) ImportInput(path, source, role, label string) (core.Obj, error) {
	f.record("import:" + source)
	return core.Obj{"ok": true}, nil
}
