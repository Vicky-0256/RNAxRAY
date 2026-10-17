//go:build !windows

package core

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestShutdownFinishesInterruptedTasks: tasks that ShutdownAll marks
// interrupted (running and queued) get their onFinish before it returns,
// so they can be registered while the runtime is still up, and only once.
func TestShutdownFinishesInterruptedTasks(t *testing.T) {
	s := testScheduler(t, 1, 1000)
	project := tempProject(t)
	var mu sync.Mutex
	calls := map[string]int{}
	onFinish := func(_, id string) {
		mu.Lock()
		calls[id]++
		mu.Unlock()
	}
	running, _ := submitSleeper(t, s, project, Budget{1, 100}, onFinish)
	queued, snap := submitSleeper(t, s, project, Budget{1, 100}, onFinish)
	if snap["status"] != "queued" {
		t.Fatalf("second %v", snap)
	}
	s.ShutdownAll()
	mu.Lock()
	got := map[string]int{running: calls[running], queued: calls[queued]}
	mu.Unlock()
	if got[running] != 1 || got[queued] != 1 {
		t.Fatalf("onFinish before ShutdownAll returned: %v", got)
	}
	// The monitor of the running task must not finish it a second time.
	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if calls[running] != 1 {
		t.Fatalf("running task finished %d times", calls[running])
	}
}

// TestCancelAfterCleanExitKeepsSucceeded: a cancel that lands after the
// child exited 0 but before it was reaped must not relabel it cancelled.
func TestCancelAfterCleanExitKeepsSucceeded(t *testing.T) {
	s := testScheduler(t, 0, 0)
	project := tempProject(t)
	for i := range 200 {
		id := NewTaskID()
		root, runDir, err := s.prepareRunDir(project, id)
		if err != nil {
			t.Fatal(err)
		}
		cmd := shell(runDir, `printf '{"ok":true}' > result.json`)
		if _, err := startManaged(s, cmd, root, id, "validate_project", runDir, nil); err != nil {
			t.Fatal(err)
		}
		time.Sleep(time.Duration(i%10) * time.Millisecond)
		_, _ = s.Cancel(id, "")
		snap := waitFor(t, s, id, project, finished)
		if exitedZero(snap["exit_code"]) && snap["status"] != "succeeded" {
			t.Fatalf("run %d: exit 0 but %v (error %v)", i, snap["status"], snap["error"])
		}
	}
}

// exitedZero: exit_code is 0 (*int in memory, a JSON number from disk).
func exitedZero(v any) bool {
	switch code := v.(type) {
	case *int:
		return code != nil && *code == 0
	case int:
		return code == 0
	case float64:
		return code == 0
	}
	return false
}

// TestResumeTwiceIsRefused: a second resume of the same task while the
// first resumed copy is active is refused.
func TestResumeTwiceIsRefused(t *testing.T) {
	s := testScheduler(t, 0, 0)
	project := tempProject(t)
	request := TaskStartRequest{ProjectPath: project, Kind: "analysis_index", SampleID: ptr("S1")}
	prepared, err := s.Prepare(request, project, nil)
	if err != nil {
		t.Fatal(err)
	}
	id := prepared.ID
	if _, err := s.Submit(shell(prepared.RunDir, "exit 2"), prepared, nil); err != nil {
		t.Fatal(err)
	}
	waitFor(t, s, id, project, finished)
	submit := func() error {
		again, err := s.ResumeRequest(id, project)
		if err != nil {
			return err
		}
		resumed, err := s.Prepare(again, project, &id)
		if err != nil {
			return err
		}
		_, err = s.Submit(shell(resumed.RunDir, "exec sleep 30"), resumed, nil)
		return err
	}
	if err := submit(); err != nil {
		t.Fatal(err)
	}
	err = submit()
	if err == nil || !strings.Contains(err.Error(), "already") {
		t.Fatalf("second resume: %v", err)
	}
	// The refused copy leaves no run directory behind.
	entries, _ := os.ReadDir(filepath.Join(project, "runs"))
	if len(entries) != 2 {
		t.Fatalf("run directories %d, want 2", len(entries))
	}
}

// TestShutdownDoesNotWaitForARunningRequest: application exit cancels the
// request in flight instead of waiting for it (up to the compute timeout).
func TestShutdownDoesNotWaitForARunningRequest(t *testing.T) {
	s := echo(t, 60*time.Second)
	if _, err := s.Request(map[string]any{"op": "warm"}); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := s.Request(map[string]any{"op": "sleep", "seconds": 20})
		done <- err
	}()
	time.Sleep(300 * time.Millisecond)
	start := time.Now()
	s.Shutdown()
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("Shutdown took %v", took)
	}
	if err := <-done; err == nil {
		t.Fatal("request in flight succeeded after shutdown")
	}
}

// TestServiceShutdownRegistersInterruptedTasks: at exit, running and queued
// tasks reach project.json runs[] as interrupted (real bridge).
func TestServiceShutdownRegistersInterruptedTasks(t *testing.T) {
	s := newTestService(t)
	project := createProject(t, s)
	s.tasks.SetBudget(Budget{1, 1000})
	s.taskCommand = func(rt *Runtime, task *Prepared) *exec.Cmd {
		return shell(task.RunDir, "exec sleep 30")
	}
	var ids []string
	for range 2 {
		snap, err := s.StartTask(TaskStartRequest{ProjectPath: project, Kind: "validate_project", CPU: ptr(uint32(1))})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, snap["task_id"].(string))
	}
	s.Shutdown()
	runs, _ := readJSON(t, filepath.Join(project, "project.json"))["runs"].([]any)
	for _, id := range ids {
		found := false
		for _, run := range runs {
			if entry, _ := run.(map[string]any); entry["id"] == id && entry["status"] == "interrupted" {
				found = true
			}
		}
		if !found {
			t.Fatalf("runs[] lacks interrupted %s: %v", id, runs)
		}
	}
}

// TestNoisySidecarDoesNotLeakItsReader: a bridge that prints more stdout
// lines than the buffer holds after its response does not leave the
// reader goroutine blocked once the process is stopped.
func TestNoisySidecarDoesNotLeakItsReader(t *testing.T) {
	noisy := `
import json, sys
for line in sys.stdin:
    msg = json.loads(line)
    print(json.dumps({"id": msg["id"], "response": {"ok": True}}), flush=True)
    for i in range(40):
        print("noise", i, flush=True)
`
	s := NewSidecar(SidecarSpec{Name: "noisy", Program: testPython(t), Args: []string{"-c", noisy},
		Dir: os.TempDir(), Env: []string{"PYTHONDONTWRITEBYTECODE=1"}, Timeout: 20 * time.Second})
	t.Cleanup(s.Shutdown)
	cycle := func() {
		if _, err := s.Request(map[string]any{"op": "x"}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(200 * time.Millisecond) // the noise fills the buffer
		s.Stop()
	}
	cycle()
	time.Sleep(200 * time.Millisecond)
	before := runtime.NumGoroutine()
	for range 5 {
		cycle()
	}
	time.Sleep(300 * time.Millisecond)
	if after := runtime.NumGoroutine(); after > before+1 {
		t.Fatalf("goroutines %d -> %d after 5 stopped sidecars", before, after)
	}
}
