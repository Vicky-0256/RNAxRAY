package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProjectOpAllowlist(t *testing.T) {
	if len(ProjectOperations) != 23 {
		t.Fatalf("%d project operations", len(ProjectOperations))
	}
	for _, operation := range ProjectOperations {
		request := map[string]any{"operation": operation, "path": "/p"}
		if got, err := projectOpRequest(request); err != nil || got["operation"] != operation {
			t.Fatalf("%s: %v", operation, err)
		}
	}
	for _, bad := range []any{
		map[string]any{"operation": "create_project", "path": "/p"},
		map[string]any{"operation": "run_task", "path": "/p"},
		map[string]any{"operation": "list_samples"},
		map[string]any{"operation": "list_samples", "path": " "},
		[]any{"list_samples"},
	} {
		if _, err := projectOpRequest(bad); err == nil {
			t.Fatalf("accepted %v", bad)
		}
	}
	// The Backend method refuses payloads that try to override the fixed keys.
	s := NewService(nil, ServiceOptions{})
	for _, payload := range []Obj{{"operation": "x"}, {"path": "/q"}} {
		if _, err := s.ProjectOp("/p", "list_samples", payload); err == nil || !strings.Contains(err.Error(), "must not contain") {
			t.Fatalf("payload %v: %v", payload, err)
		}
	}
	if _, err := s.ProjectOp("/p", "create_project", nil); err == nil || !strings.Contains(err.Error(), "unsupported project operation") {
		t.Fatal(err)
	}
	if _, err := s.ProjectOp("/p", "list_samples", nil); err == nil || !strings.Contains(err.Error(), "not available") {
		t.Fatalf("no runtime: %v", err)
	}
}

func TestAnalysisQueriesAreAllowlisted(t *testing.T) {
	for _, operation := range AnalysisOperations {
		request := map[string]any{"project_path": "/p", "operation": operation, "sample_ids": []any{"a"}, "bin_size": 10}
		got, err := analysisRequest(request)
		if err != nil {
			t.Fatal(err)
		}
		assertJSON(t, got, `{"project_path":"/p","operation":"`+operation+`","sample_ids":["a"],"bin_size":10}`)
	}
	for _, bad := range []any{
		map[string]any{"project_path": "/p", "operation": "import_input"},
		map[string]any{"project_path": "/p", "operation": "sample_pipeline_run"},
		map[string]any{"project_path": "/p"},
		map[string]any{"operation": "analysis_summary"},
		map[string]any{"project_path": " ", "operation": "analysis_summary"},
		[]any{"analysis_summary"},
	} {
		if _, err := analysisRequest(bad); err == nil {
			t.Fatalf("accepted %v", bad)
		}
	}
	s := NewService(nil, ServiceOptions{})
	if _, err := s.Query("/p", "analysis_summary", Obj{"project_path": "/q"}); err == nil {
		t.Fatal("payload overrode project_path")
	}
	if _, err := s.Query("/p", "import_input", nil); err == nil || !strings.Contains(err.Error(), "unsupported analysis operation") {
		t.Fatal(err)
	}
}

func TestReleaseIgnoresEnvironmentOverrides(t *testing.T) {
	t.Setenv("RNAXRAY_REPOSITORY_ROOT", "/attacker/repo")
	t.Setenv("RNAXRAY_PYTHON", "/attacker/python")
	if b, err := ResolveBridge(t.TempDir(), false, ""); err == nil {
		t.Fatalf("release build honored the environment: %v", b)
	}
	b, err := ResolveBridge(t.TempDir(), true, "")
	if err != nil || *b != (Bridge{Root: "/attacker/repo", Python: "/attacker/python"}) {
		t.Fatalf("dev: %v %v", b, err)
	}
	t.Setenv("RNAXRAY_PYTHON", "")
	if b, _ := ResolveBridge(t.TempDir(), true, ""); b.Python != "python3" {
		t.Fatalf("default python %q", b.Python)
	}
	// RNAXRAY_PYTHON alone is not an override.
	t.Setenv("RNAXRAY_REPOSITORY_ROOT", "")
	t.Setenv("RNAXRAY_PYTHON", "p")
	if _, err := ResolveBridge(t.TempDir(), true, ""); err == nil {
		t.Fatal("RNAXRAY_PYTHON alone selected a runtime")
	}
}

func TestBridgeResultKeepsUnavailablePassthrough(t *testing.T) {
	if _, err := bridgeResult(json.RawMessage(`{"ok":true}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := bridgeResult(json.RawMessage(`{"ok":false,"status":"unavailable"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := bridgeResult(json.RawMessage(`{"ok":false,"error":"bad"}`)); err == nil || err.Error() != "bad" {
		t.Fatal(err)
	}
	if _, err := bridgeResult(json.RawMessage(`{"ok":false}`)); err == nil || err.Error() != "desktop runtime operation failed" {
		t.Fatal(err)
	}
}

func TestVersionsAreInSync(t *testing.T) {
	config := readJSON(t, filepath.Join("..", "mygo.json"))
	if config["version"] != AppVersion {
		t.Fatalf("mygo.json %v, AppVersion %s", config["version"], AppVersion)
	}
	if pkg := filepath.Join(repoRoot(t), "desktop", "package.json"); isFile(pkg) {
		if version := readJSON(t, pkg)["version"]; version != AppVersion {
			t.Fatalf("package.json %v, AppVersion %s", version, AppVersion)
		}
	}
}

// newTestService runs the repository bridge with the staged (or PATH) Python.
func newTestService(t *testing.T) *Service {
	t.Helper()
	root := repoRoot(t)
	if !isFile(filepath.Join(root, "desktop", "runtime", "bridge.py")) {
		t.Skip("repository layout not available")
	}
	rt, err := NewRuntime(Bridge{Root: root, Python: testPython(t)}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := NewService(rt, ServiceOptions{PreferencesPath: filepath.Join(t.TempDir(), "config", PrefsFileName)})
	t.Cleanup(s.Shutdown)
	return s
}

// createProject makes a fresh project through the bridge and returns its
// canonical path.
func createProject(t *testing.T, s *Service) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "e2e.rnaxrayproj")
	if _, err := s.CreateProject(path, "Go e2e", "end-to-end test"); err != nil {
		t.Fatal(err)
	}
	opened, err := s.OpenProject(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := opened["manifest"].(map[string]any); !ok {
		t.Fatalf("open_project returned no manifest: %v", opened)
	}
	return opened["path"].(string)
}

func waitTask(t *testing.T, s *Service, project, id string, timeout time.Duration) Obj {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		snap, err := s.TaskStatus(project, id)
		if err != nil {
			t.Fatal(err)
		}
		if finished(snap) || time.Now().After(deadline) {
			return snap
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// waitRun polls project.json until runs[] holds id with the given status.
func waitRun(t *testing.T, project, id, status string) map[string]any {
	t.Helper()
	var runs []any
	for range 200 {
		runs, _ = readJSON(t, filepath.Join(project, "project.json"))["runs"].([]any)
		for _, run := range runs {
			if entry, _ := run.(map[string]any); entry["id"] == id && entry["status"] == status {
				return entry
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("project.json runs[] has no %s run %s: %v", status, id, runs)
	return nil
}

// TestServiceValidateTaskEndToEnd: Service -> open_project -> task child
// (real bridge) -> status.json -> register_task_run in project.json.
func TestServiceValidateTaskEndToEnd(t *testing.T) {
	s := newTestService(t)
	detect, err := s.Detect()
	if err != nil || detect["ok"] != true {
		t.Fatalf("detect: %v %v", detect, err)
	}
	project := createProject(t, s)
	if validated, err := s.ValidateProject(project, true); err != nil || validated["ok"] != true {
		t.Fatalf("validate: %v %v", validated, err)
	}
	if _, err := s.ProjectOp(project, "list_samples", nil); err != nil {
		t.Fatalf("list_samples: %v", err)
	}
	if _, err := s.StartTask(TaskStartRequest{ProjectPath: project, Kind: "sh"}); err == nil {
		t.Fatal("unsupported kind started")
	}
	snap, err := s.StartTask(TaskStartRequest{ProjectPath: project, Kind: "validate_project"})
	if err != nil {
		t.Fatal(err)
	}
	id := snap["task_id"].(string)
	assertJSON(t, snap["claim"], `{"cpu":1,"mem_mb":256}`)
	snap = waitTask(t, s, project, id, 60*time.Second)
	if snap["status"] != "succeeded" || snap["exit_code"] != float64(0) {
		stderr, _ := os.ReadFile(filepath.Join(project, "runs", id, "stderr.log"))
		t.Fatalf("%v\n%s", snap, stderr)
	}
	run := waitRun(t, project, id, "succeeded")
	if run["kind"] != "validate_project" {
		t.Fatalf("registered run %v", run)
	}
	tasks, err := s.ListTasks(project)
	if err != nil || len(tasks) != 1 || tasks[0]["task_id"] != id {
		t.Fatalf("list: %v %v", tasks, err)
	}
	if _, err := s.ResumeTask(project, id); err == nil || !strings.Contains(err.Error(), "can be resumed") {
		t.Fatalf("resumed a succeeded task: %v", err)
	}
	// Preferences: a budget change applies to the scheduler at once.
	prefs, err := s.SetPreferences(Obj{"budget": Obj{"cpu": 1, "mem_mb": 512}, "theme": "dark"})
	if err != nil || prefs["custom_budget"] != true || prefs["theme"] != "dark" {
		t.Fatalf("prefs: %v %v", prefs, err)
	}
	if s.Scheduler().Budget() != (Budget{1, 512}) {
		t.Fatal("budget not applied")
	}
	if got, _ := s.Preferences(); got["custom_budget"] != true {
		t.Fatalf("preferences %v", got)
	}
	s.Shutdown()
	if _, err := s.Detect(); err == nil {
		t.Fatal("call after shutdown succeeded")
	}
	if _, err := s.StartTask(TaskStartRequest{ProjectPath: project, Kind: "validate_project"}); err == nil {
		t.Fatal("task started after shutdown")
	}
}
