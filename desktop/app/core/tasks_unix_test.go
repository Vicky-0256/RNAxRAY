//go:build !windows

package core

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func shell(dir, script string) *exec.Cmd {
	cmd := exec.Command("/bin/sh", "-c", script)
	cmd.Dir = dir
	return cmd
}

// startManaged starts cmd with the default claim for kind (callers build
// their own run directory).
func startManaged(s *Scheduler, cmd *exec.Cmd, project, id, kind, runDir string, onFinish OnFinish) (Obj, error) {
	return s.Submit(cmd, &Prepared{ID: id, Kind: kind, Project: project, RunDir: runDir,
		RequestFile: filepath.Join(runDir, "task-request.json"), Claim: DefaultClaim(kind, s.Budget())}, onFinish)
}

func submitSleeper(t *testing.T, s *Scheduler, project string, claim Budget, onFinish OnFinish) (string, Obj) {
	t.Helper()
	id := NewTaskID()
	root, runDir, err := s.prepareRunDir(project, id)
	if err != nil {
		t.Fatal(err)
	}
	cmd := shell(runDir, `printf '%s %s' "$RNAXRAY_TASK_CPUS" "$RNAXRAY_TASK_MEM_MB" > granted.txt; exec sleep 30`)
	snap, err := s.Submit(cmd, &Prepared{ID: id, Kind: "structure", Project: root, RunDir: runDir,
		RequestFile: filepath.Join(runDir, "task-request.json"), Claim: claim}, onFinish)
	if err != nil {
		t.Fatal(err)
	}
	return id, snap
}

func granted(project, id string) string {
	file := filepath.Join(project, "runs", id, "granted.txt")
	for range 250 {
		if text, err := os.ReadFile(file); err == nil && len(text) > 0 {
			return string(text)
		}
		time.Sleep(20 * time.Millisecond)
	}
	return ""
}

func TestOverBudgetTasksQueueAndStartInOrder(t *testing.T) {
	s := testScheduler(t, 2, 1000)
	project := tempProject(t)
	var mu sync.Mutex
	var done []string
	onFinish := func(_, id string) { mu.Lock(); done = append(done, id); mu.Unlock() }
	first, snap := submitSleeper(t, s, project, Budget{2, 100}, onFinish)
	if snap["status"] != "running" || snap["launched_at"] == nil {
		t.Fatalf("first %v", snap)
	}
	if got := granted(project, first); got != "2 100" {
		t.Fatalf("granted %q", got)
	}
	second, snap := submitSleeper(t, s, project, Budget{1, 100}, onFinish)
	if snap["status"] != "queued" || snap["launched_at"] != nil {
		t.Fatalf("second %v", snap)
	}
	assertJSON(t, snap["claim"], `{"cpu":1,"mem_mb":100}`)
	third, _ := submitSleeper(t, s, project, Budget{1, 100}, onFinish)
	if readJSON(t, filepath.Join(project, "runs", third, "status.json"))["status"] != "queued" {
		t.Fatal("queued status not persisted")
	}
	// Cancelling a queued task finishes it without a process.
	snap, err := s.Cancel(third, "")
	if err != nil || snap["status"] != "cancelled" || !finished(snap) {
		t.Fatalf("%v %v", snap, err)
	}
	mu.Lock()
	if len(done) != 1 || done[0] != third {
		t.Fatalf("finished %v", done)
	}
	mu.Unlock()
	if snap, _ := s.Status(second, ""); snap["status"] != "queued" {
		t.Fatalf("second %v", snap)
	}
	// Freeing the budget starts the head of the queue with its grant.
	if snap, _ := s.Cancel(first, ""); snap["status"] != "cancelled" {
		t.Fatalf("first %v", snap)
	}
	snap = waitFor(t, s, second, project, func(s Obj) bool { return s["status"] == "running" })
	if snap["status"] != "running" {
		t.Fatalf("second %v", snap)
	}
	if got := granted(project, second); got != "1 100" {
		t.Fatalf("granted %q", got)
	}
	if isFile(filepath.Join(project, "runs", third, "granted.txt")) {
		t.Fatal("cancelled queued task ran")
	}
	if _, err := s.Cancel(second, ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, s, second, project, finished)
}

func TestRaisingTheBudgetStartsQueuedTasks(t *testing.T) {
	s := testScheduler(t, 1, 1000)
	project := tempProject(t)
	first, _ := submitSleeper(t, s, project, Budget{1, 600}, nil)
	second, snap := submitSleeper(t, s, project, Budget{1, 600}, nil)
	if snap["status"] != "queued" {
		t.Fatalf("second %v", snap)
	}
	s.SetBudget(Budget{2, 2000})
	if snap, _ := s.Status(second, ""); snap["status"] != "running" {
		t.Fatalf("second %v", snap)
	}
	for _, id := range []string{first, second} {
		if _, err := s.Cancel(id, ""); err != nil {
			t.Fatal(err)
		}
		waitFor(t, s, id, project, finished)
	}
}

func TestShutdownMarksQueuedAndRunningInterrupted(t *testing.T) {
	s := testScheduler(t, 1, 1000)
	project := tempProject(t)
	first, _ := submitSleeper(t, s, project, Budget{1, 100}, nil)
	second, _ := submitSleeper(t, s, project, Budget{1, 100}, nil)
	// Simulate a restart: the in-memory table is gone, disk says active.
	s.mu.Lock()
	for _, id := range []string{first, second} {
		if e := s.tasks[id]; e != nil {
			if e.cmd != nil {
				_ = killTree(e.cmd.Process.Pid)
			}
			delete(s.tasks, id)
		}
	}
	s.mu.Unlock()
	for _, id := range []string{first, second} {
		snap, err := s.Status(id, project)
		if err != nil || snap["status"] != "interrupted" {
			t.Fatalf("%v %v", snap, err)
		}
		if _, err := s.ResumeRequest(id, project); err == nil {
			t.Fatal("resumed without a stored request")
		}
	}
	// The real shutdown: running and queued tasks become interrupted and
	// new submissions are refused.
	third, _ := submitSleeper(t, s, project, Budget{1, 100}, nil)
	fourth, snap := submitSleeper(t, s, project, Budget{1, 100}, nil)
	if snap["status"] != "queued" {
		t.Fatalf("fourth %v", snap)
	}
	s.ShutdownAll()
	for id, message := range map[string]string{
		third:  "the application exited while this task was running",
		fourth: "the application exited before this queued task started",
	} {
		disk := readJSON(t, filepath.Join(project, "runs", id, "status.json"))
		if disk["status"] != "interrupted" || disk["error"] != message || disk["finished_at"] == nil {
			t.Fatalf("%s: %v", id, disk)
		}
	}
	id := NewTaskID()
	root, runDir, err := s.prepareRunDir(project, id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := startManaged(s, shell(runDir, "exit 0"), root, id, "validate_project", runDir, nil); err == nil {
		t.Fatal("submitted after shutdown")
	}
}

func TestLiveProgressIsReported(t *testing.T) {
	s := testScheduler(t, 0, 0)
	project := tempProject(t)
	id := NewTaskID()
	project, runDir, err := s.prepareRunDir(project, id)
	if err != nil {
		t.Fatal(err)
	}
	cmd := shell(runDir, `printf '{"stage":"collapse","detail":"","bytes_done":1,"bytes_total":2,"updated_at":"x"}' > progress.tmp && mv progress.tmp progress.json; exec sleep 30`)
	if _, err := startManaged(s, cmd, project, id, "sample_pipeline", runDir, nil); err != nil {
		t.Fatal(err)
	}
	snap := waitFor(t, s, id, project, func(s Obj) bool { _, ok := s["progress"].(map[string]any); return ok })
	if snap["status"] != "running" {
		t.Fatalf("%v", snap)
	}
	progress := snap["progress"].(map[string]any)
	if progress["stage"] != "collapse" || progress["bytes_total"] != float64(2) {
		t.Fatalf("progress %v", progress)
	}
	if _, err := s.Cancel(id, ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, s, id, project, finished)
}

func TestResumeReusesTheStoredRequest(t *testing.T) {
	s := testScheduler(t, 0, 0)
	project := tempProject(t)
	request := TaskStartRequest{ProjectPath: project, Kind: "analysis_index", SampleID: ptr("ZSIN_REP3"), MemMB: ptr(uint64(128))}
	prepared, err := s.Prepare(request, project, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(prepared.ID, "index-") || prepared.Claim != (Budget{1, 128}) {
		t.Fatalf("%+v", prepared)
	}
	child := readJSON(t, prepared.RequestFile)
	if child["operation"] != "analysis_index_build" || child["run_dir"] != prepared.RunDir {
		t.Fatalf("child request %v", child)
	}
	id := prepared.ID
	if _, err := s.Submit(shell(prepared.RunDir, `printf '{"ok":false,"error":"boom"}' > result.json; exit 2`), prepared, nil); err != nil {
		t.Fatal(err)
	}
	if snap := waitFor(t, s, id, project, finished); snap["status"] != "failed" {
		t.Fatalf("%v", snap)
	}
	again, err := s.ResumeRequest(id, project)
	if err != nil {
		t.Fatal(err)
	}
	if again.Kind != "analysis_index" || *again.SampleID != "ZSIN_REP3" || *again.MemMB != 128 || again.TaskID != nil {
		t.Fatalf("%+v", again)
	}
	resumed, err := s.Prepare(again, project, &id)
	if err != nil || resumed.ID == id {
		t.Fatalf("%+v %v", resumed, err)
	}
	newID := resumed.ID
	snap, err := s.Submit(shell(resumed.RunDir, "exit 0"), resumed, nil)
	if err != nil || snap["resumed_from"] != id {
		t.Fatalf("%v %v", snap, err)
	}
	snap = waitFor(t, s, newID, project, finished)
	if snap["status"] != "succeeded" || snap["resumed_from"] != id {
		t.Fatalf("%v", snap)
	}
	// Succeeded tasks, unknown tasks and tasks of other projects are refused.
	if _, err := s.ResumeRequest(newID, project); err == nil || !strings.Contains(err.Error(), "can be resumed") {
		t.Fatalf("resumed a succeeded task: %v", err)
	}
	if _, err := s.ResumeRequest("missing", project); err == nil {
		t.Fatal("resumed a missing task")
	}
	if _, err := s.ResumeRequest(id, tempProject(t)); err == nil {
		t.Fatal("resumed a task of another project")
	}
	// An explicit task id is not reused by the resumed copy.
	named := request
	named.TaskID = ptr("named-task")
	prepared, err = s.Prepare(named, project, nil)
	if err != nil {
		t.Fatal(err)
	}
	stored := readJSON(t, filepath.Join(prepared.RunDir, StartFile))
	if stored["task_id"] != nil || stored["sample_id"] != "ZSIN_REP3" {
		t.Fatalf("stored %v", stored)
	}
	if _, err := s.Prepare(named, project, nil); err == nil {
		t.Fatal("id reused")
	}
}

func TestCancellationReapsChildAndKeepsCancelledStatus(t *testing.T) {
	s := testScheduler(t, 0, 0)
	project := tempProject(t)
	id := NewTaskID()
	project, runDir, err := s.prepareRunDir(project, id)
	if err != nil {
		t.Fatal(err)
	}
	var count atomic.Int32
	if _, err := startManaged(s, exec.Command("/bin/sleep", "30"), project, id, "validate_project", runDir,
		func(string, string) { count.Add(1) }); err != nil {
		t.Fatal(err)
	}
	if snap, err := s.Cancel(id, ""); err != nil || snap["status"] != "cancelled" {
		t.Fatalf("%v %v", snap, err)
	}
	for range 200 {
		if count.Load() == 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if count.Load() != 1 {
		t.Fatalf("on_finish ran %d times", count.Load())
	}
	snap, _ := s.Status(id, "")
	if snap["status"] != "cancelled" || !finished(snap) {
		t.Fatalf("%v", snap)
	}
	if readJSON(t, filepath.Join(project, "runs", id, "status.json"))["status"] != "cancelled" {
		t.Fatal("cancelled status not persisted")
	}
}

func TestCompletionReadsResultJSON(t *testing.T) {
	s := testScheduler(t, 0, 0)
	project := tempProject(t)
	id := NewTaskID()
	project, runDir, err := s.prepareRunDir(project, id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := startManaged(s, shell(runDir, `printf '{"ok":true,"output":"x.out"}' > result.json`), project, id, "cplfold", runDir, nil); err != nil {
		t.Fatal(err)
	}
	snap := waitFor(t, s, id, project, finished)
	if snap["status"] != "succeeded" || snap["kind"] != "cplfold" || snap["output"] != "x.out" || snap["exit_code"] != float64(0) {
		t.Fatalf("%v", snap)
	}
}

func TestFailureCopiesResultErrorAndNullOutput(t *testing.T) {
	s := testScheduler(t, 0, 0)
	project := tempProject(t)
	id := NewTaskID()
	project, runDir, err := s.prepareRunDir(project, id)
	if err != nil {
		t.Fatal(err)
	}
	cmd := shell(runDir, `printf '{"ok":false,"path":"p","errors":["bad"],"error":"bad"}' > result.json; exit 1`)
	if _, err := startManaged(s, cmd, project, id, "validate_project", runDir, nil); err != nil {
		t.Fatal(err)
	}
	snap := waitFor(t, s, id, project, finished)
	if snap["status"] != "failed" || snap["error"] != "bad" || snap["exit_code"] != float64(1) || snap["output"] != nil {
		t.Fatalf("%v", snap)
	}
}

// alive reports whether pid still exists (zombies count as gone).
func alive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	out, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	return err == nil && len(bytes.TrimSpace(out)) > 0 && !bytes.HasPrefix(bytes.TrimSpace(out), []byte("Z"))
}

// readPids waits for a whitespace-separated pid list written by a child.
func readPids(t *testing.T, file string, n int) []int {
	t.Helper()
	for range 500 {
		if text, err := os.ReadFile(file); err == nil {
			var pids []int
			for _, field := range strings.Fields(string(text)) {
				if pid, err := strconv.Atoi(field); err == nil {
					pids = append(pids, pid)
				}
			}
			if len(pids) >= n {
				return pids
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s did not list %d pids", file, n)
	return nil
}

func assertGone(t *testing.T, pids []int) {
	t.Helper()
	for _, pid := range pids {
		for i := 0; alive(pid); i++ {
			if i > 150 {
				t.Fatalf("process %d survived cancellation", pid)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
}

// TestCancelKillsWholeProcessTree: grandchildren die with the task.
func TestCancelKillsWholeProcessTree(t *testing.T) {
	s := testScheduler(t, 0, 0)
	project := tempProject(t)
	id := NewTaskID()
	project, runDir, err := s.prepareRunDir(project, id)
	if err != nil {
		t.Fatal(err)
	}
	script := `echo $$ > pids.tmp; sleep 30 & echo $! >> pids.tmp; (sleep 30; true) & echo $! >> pids.tmp; mv pids.tmp pids; wait`
	if _, err := startManaged(s, shell(runDir, script), project, id, "validate_project", runDir, nil); err != nil {
		t.Fatal(err)
	}
	pids := readPids(t, filepath.Join(runDir, "pids"), 3)
	for _, pid := range pids {
		if !alive(pid) {
			t.Fatalf("process %d is not running before cancel", pid)
		}
	}
	if snap, err := s.Cancel(id, ""); err != nil || snap["status"] != "cancelled" {
		t.Fatalf("%v %v", snap, err)
	}
	assertGone(t, pids)
	if snap := waitFor(t, s, id, project, finished); snap["status"] != "cancelled" {
		t.Fatalf("%v", snap)
	}
	if err := killTree(pids[0]); err != nil {
		t.Fatalf("killing a gone group must not fail: %v", err)
	}
}

// TestPipelineTaskRunsRealBridgeEndToEnd: task model -> bridge child ->
// rnaxraypipe, against the repository sources; skipped when they are absent.
func TestPipelineTaskRunsRealBridgeEndToEnd(t *testing.T) {
	root := repoRoot(t)
	for _, path := range []string{"pipeline/rnaxraypipe/__init__.py", "data/testData.sam", "desktop/runtime/bridge.py"} {
		if !isFile(filepath.Join(root, path)) {
			t.Skip("repository pipeline sources are not available")
		}
	}
	python := testPython(t)
	s := testScheduler(t, 0, 0)
	project := filepath.Join(t.TempDir(), "p.rnaxrayproj")
	setup := exec.Command(python, "-c", "import sys; from pathlib import Path; from desktop.runtime.project import new_project, import_input as i; p=Path(sys.argv[1]); new_project(p, 'Go e2e'); i(p, Path('data/testData.sam'), role='sam'); i(p, Path('data/Zika_18S_formatted.fasta'), role='reference')", project)
	setup.Dir = root
	setup.Env = append(os.Environ(), "PYTHONDONTWRITEBYTECODE=1")
	if out, err := setup.CombinedOutput(); err != nil {
		t.Fatalf("setup: %v\n%s", err, out)
	}
	project, err := canonicalPath(project)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := s.Prepare(TaskStartRequest{ProjectPath: project, Kind: "pipeline",
		Input: ptr("inputs/testData.sam"), Reference: ptr("inputs/Zika_18S_formatted.fasta")}, project, nil)
	if err != nil {
		t.Fatal(err)
	}
	id := prepared.ID
	cmd := BridgeCommand(python, root, prepared.RequestFile, []string{"PYTHONDONTWRITEBYTECODE=1"})
	var called atomic.Bool
	if _, err := s.Submit(cmd, prepared, func(string, string) { called.Store(true) }); err != nil {
		t.Fatal(err)
	}
	var snap Obj
	for range 1200 {
		snap, _ = s.Status(id, "")
		if finished(snap) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if snap["status"] != "succeeded" {
		stderr, _ := os.ReadFile(filepath.Join(prepared.RunDir, "stderr.log"))
		t.Fatalf("%v\n%s", snap, stderr)
	}
	output, _ := snap["output"].(string)
	if !strings.HasPrefix(output, project) || !strings.HasSuffix(output, "testData.hyb") {
		t.Fatalf("output %q", output)
	}
	got, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile(filepath.Join(root, "pipeline", "tests", "golden", "testData.hyb"))
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("output differs from the golden file (%v)", err)
	}
	for i := 0; !called.Load() && i < 50; i++ {
		time.Sleep(20 * time.Millisecond)
	}
	if !called.Load() {
		t.Fatal("on_finish hook did not run")
	}
}
