package core

// Unified native task lifecycle (contracts C3 and R6). The UI never passes
// a command: it chooses an allowlisted kind and the shell builds the child
// command. The shell is the only writer of runs/<id>/status.json; the child
// writes result.json (folded into the snapshot's `output` at completion) and
// may write progress.json (passed through as `progress`).
//
// Scheduling (R6): every task claims {cpu, mem_mb} from one global budget. A
// task whose claim does not fit what running tasks leave free is persisted
// as `queued` and launched automatically, strictly FIFO: a waiting head
// blocks later tasks, so a large task is never overtaken indefinitely.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
)

// TaskKinds are the task kinds the UI may start.
var TaskKinds = []string{
	"validate_project",
	"cplfold",
	"pipeline",
	"sample_pipeline",
	"analysis_index",
	"structure",
	"compare",
	"energy",
}

var activeStates = []string{"queued", "running"}

// resumableStates are the terminal states ResumeTask accepts.
var resumableStates = []string{"interrupted", "failed", "cancelled"}

// StartFile stores the original TaskStartRequest for task_resume.
const StartFile = "task-start.json"

const (
	maxWindows = 4096
	maxSamples = 256
	// maxTasks bounds the in-memory table; the oldest finished task is
	// dropped first (it stays readable from disk).
	maxTasks = 256
)

const unsupportedKind = "engine unavailable or not enabled: unsupported task kind"

// OnFinish is called with (project, task id) after a task reaches a
// terminal state.
type OnFinish func(project, id string)

// pending is a task waiting for budget: its command is started at launch.
type pending struct {
	cmd      *exec.Cmd
	onFinish OnFinish
}

type taskState struct {
	kind        string
	status      string
	exitCode    *int
	err         *string
	cmd         *exec.Cmd     // running child; nil once reaped or taken
	exited      chan struct{} // closed when the running child has been reaped
	pending     *pending
	onFinish    OnFinish // of the running child; called by monitor or shutdown
	project     string
	runDir      string
	startedAt   string  // submission time; list order
	launchedAt  *string // process start; nil while queued
	finishedAt  *string
	output      any
	finished    time.Time // zero while active
	claim       Budget
	seq         uint64
	resumedFrom *string
}

// Scheduler owns the task table and the resource budget. The Tauri shell
// kept these as process globals; here they are one value per Service so
// tests stay independent.
type Scheduler struct {
	mu           sync.Mutex
	tasks        map[string]*taskState
	budget       *Budget
	seq          uint64
	shuttingDown atomic.Bool
}

// NewScheduler returns an empty scheduler using the system default budget.
func NewScheduler() *Scheduler {
	return &Scheduler{tasks: map[string]*taskState{}}
}

// Budget is the scheduler budget (preferences, else the system default).
func (s *Scheduler) Budget() Budget {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.budgetLocked()
}

func (s *Scheduler) budgetLocked() Budget {
	if s.budget != nil {
		return *s.budget
	}
	return DefaultBudget()
}

// SetBudget replaces the budget and starts queued tasks that now fit.
func (s *Scheduler) SetBudget(b Budget) {
	s.mu.Lock()
	s.budget = &b
	s.mu.Unlock()
	s.schedule()
}

// resetBudget restores the system default (tests).
func (s *Scheduler) resetBudget() {
	s.mu.Lock()
	s.budget = nil
	s.mu.Unlock()
}

var taskCounter atomic.Uint64

// NewTaskID is a fresh `task-<pid>-<nanos>-<n>` id.
func NewTaskID() string {
	return fmt.Sprintf("task-%d-%d-%d", os.Getpid(), time.Now().UnixNano(), taskCounter.Add(1)-1)
}

// ValidateID enforces the task id rule: a letter, then at most 63 letters,
// digits, dots, underscores or hyphens.
func ValidateID(id string) error {
	ok := id != "" && len(id) <= 64 && isASCIILetter(id[0])
	for i := 0; ok && i < len(id); i++ {
		c := id[i]
		ok = isASCIILetter(c) || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-'
	}
	if !ok {
		return errors.New("task id must start with a letter and contain at most 64 letters, digits, dots, underscores or hyphens")
	}
	return nil
}

func isASCIILetter(c byte) bool { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }

// validateSampleID applies the project manifest's id rule (project._ID).
func validateSampleID(id string) error {
	if ValidateID(id) != nil {
		return fmt.Errorf("invalid sample id %q: it must start with a letter and contain at most 64 letters, digits, dots, underscores or hyphens", id)
	}
	return nil
}

// iso is a UTC timestamp YYYY-MM-DDTHH:MM:SS.mmmZ (lexicographically sortable).
func iso(at time.Time) string {
	return at.UTC().Format("2006-01-02T15:04:05.000Z")
}

func logPaths(runDir string) []string {
	return []string{filepath.Join(runDir, "stdout.log"), filepath.Join(runDir, "stderr.log")}
}

// record is the persisted status. `progress` is not part of it: it is read
// from the child's progress.json whenever a snapshot is returned.
func (e *taskState) record(id string) Obj {
	return Obj{
		"ok": true, "task_id": id, "kind": e.kind, "status": e.status,
		"exit_code": e.exitCode, "error": e.err, "run_dir": e.runDir,
		"log_paths": logPaths(e.runDir), "started_at": e.startedAt,
		"launched_at": e.launchedAt, "finished_at": e.finishedAt,
		"output": e.output, "claim": e.claim, "resumed_from": e.resumedFrom,
	}
}

// snapshot is the record in plain JSON shapes.
func (e *taskState) snapshot(id string) Obj { return normalize(e.record(id)) }

// withProgress adds `progress`: the parsed run_dir/progress.json object, else
// nil. Called without holding the task lock.
func withProgress(value Obj) Obj {
	var progress any
	if dir, ok := value["run_dir"].(string); ok {
		if data, err := readProjectFile(filepath.Join(dir, "progress.json")); err == nil {
			var parsed any
			if json.Unmarshal(data, &parsed) == nil {
				if object, ok := parsed.(map[string]any); ok {
					progress = object
				}
			}
		}
	}
	value["progress"] = progress
	return value
}

// writeAtomic writes pretty JSON to dir/name through a temporary file.
// os.Rename replaces the destination on every platform.
func writeAtomic(dir, name string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(dir, name), data)
}

func writeStatus(runDir string, value any) error { return writeAtomic(runDir, "status.json", value) }

func (e *taskState) persist(id string) error { return writeStatus(e.runDir, e.record(id)) }

// canonicalPath resolves symlinks and makes the path absolute.
func canonicalPath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

// canonicalProject returns the canonical project and its runs directory,
// creating runs/ when needed and refusing one that escapes the project.
func canonicalProject(project string) (string, string, error) {
	root, err := canonicalPath(project)
	if err != nil {
		return "", "", fmt.Errorf("project path is invalid: %w", err)
	}
	runs := filepath.Join(root, "runs")
	if err := os.MkdirAll(runs, 0o755); err != nil {
		return "", "", err
	}
	runs, err = canonicalPath(runs)
	if err != nil {
		return "", "", err
	}
	if filepath.Dir(runs) != root {
		return "", "", errors.New("project runs directory escapes project")
	}
	return root, runs, nil
}

// prepareRunDir creates the unique runs/<id> directory for a new task and
// returns the canonical project and run directory.
func (s *Scheduler) prepareRunDir(project, id string) (string, string, error) {
	if err := ValidateID(id); err != nil {
		return "", "", err
	}
	root, runs, err := canonicalProject(project)
	if err != nil {
		return "", "", err
	}
	s.mu.Lock()
	_, used := s.tasks[id]
	s.mu.Unlock()
	if used {
		return "", "", errors.New("task id is already in use")
	}
	runDir := filepath.Join(runs, id)
	if err := os.Mkdir(runDir, 0o755); err != nil {
		if errors.Is(err, os.ErrExist) {
			return "", "", errors.New("task id is already in use")
		}
		return "", "", fmt.Errorf("cannot create unique task directory: %w", err)
	}
	return root, runDir, nil
}

// readResult reads the child's result.json (written via --result-file),
// falling back to the last JSON object line the bridge printed to stdout.
func readResult(runDir string) any {
	if data, err := readProjectFile(filepath.Join(runDir, "result.json")); err == nil {
		var value any
		if json.Unmarshal(data, &value) == nil {
			return value
		}
	}
	data, err := os.ReadFile(filepath.Join(runDir, "stdout.log"))
	if err != nil {
		return nil
	}
	lines := strings.Split(string(data), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.TrimSpace(lines[i]) == "" {
			continue
		}
		var value any
		if json.Unmarshal([]byte(lines[i]), &value) == nil {
			if object, ok := value.(map[string]any); ok {
				return object
			}
		}
		return nil
	}
	return nil
}

// outputField is the result's string `output` path (cplfold), else nil.
func outputField(result any) any {
	if object, ok := result.(map[string]any); ok {
		if output, ok := object["output"].(string); ok {
			return output
		}
	}
	return nil
}

// ---- Resource claims.

// DefaultClaim is the per-kind claim, clamped to the budget.
func DefaultClaim(kind string, budget Budget) Budget {
	var claim Budget
	switch kind {
	case "sample_pipeline", "pipeline", "structure":
		claim = Budget{budget.CPU, 4096}
	case "cplfold":
		claim = Budget{1, 2048}
	case "analysis_index":
		claim = Budget{1, 1024}
	case "compare":
		claim = Budget{budget.CPU, 3072}
	case "energy":
		claim = Budget{1, 1024}
	default:
		claim = Budget{1, 256}
	}
	return clampClaim(claim, budget)
}

func clampClaim(claim, budget Budget) Budget {
	return Budget{CPU: min(max(claim.CPU, 1), max(budget.CPU, 1)), MemMB: min(claim.MemMB, budget.MemMB)}
}

// ClaimFor is the claim of a request: per-kind defaults (structure: `workers`
// cpus), replaced by explicit cpu / mem_mb, which must fit inside the budget.
func ClaimFor(request TaskStartRequest, budget Budget) (Budget, error) {
	claim := DefaultClaim(request.Kind, budget)
	if request.Kind == "structure" && request.Workers != nil {
		claim.CPU = min(max(*request.Workers, 1), max(budget.CPU, 1))
	}
	if request.CPU != nil {
		if *request.CPU == 0 || *request.CPU > budget.CPU {
			return claim, fmt.Errorf("task cpu must be between 1 and the budget (%d)", budget.CPU)
		}
		claim.CPU = *request.CPU
	}
	if request.MemMB != nil {
		if *request.MemMB == 0 || *request.MemMB > budget.MemMB {
			return claim, fmt.Errorf("task mem_mb must be between 1 and the budget (%d)", budget.MemMB)
		}
		claim.MemMB = *request.MemMB
	}
	return claim, nil
}

// ---- Submission and scheduling.

// Prepared is everything the shell knows about a task before submission.
type Prepared struct {
	ID          string
	Kind        string
	Project     string
	RunDir      string
	RequestFile string
	Claim       Budget
	ResumedFrom *string
}

func idPrefix(kind string) string {
	switch kind {
	case "cplfold":
		return "cplfold-"
	case "pipeline":
		return "pipeline-"
	case "sample_pipeline":
		return "sample-"
	case "analysis_index":
		return "index-"
	case "structure":
		return "structure-"
	case "compare":
		return "compare-"
	case "energy":
		return "energy-"
	}
	return ""
}

// Prepare validates request, reserves runs/<id> in the (canonical, opened)
// project and writes the child request plus the stored start request.
func (s *Scheduler) Prepare(request TaskStartRequest, project string, resumedFrom *string) (*Prepared, error) {
	if !slices.Contains(TaskKinds, request.Kind) {
		return nil, errors.New(unsupportedKind)
	}
	id := idPrefix(request.Kind) + NewTaskID()
	if request.TaskID != nil {
		id = *request.TaskID
	}
	if err := ValidateID(id); err != nil {
		return nil, err
	}
	claim, err := ClaimFor(request, s.Budget())
	if err != nil {
		return nil, err
	}
	if resumedFrom != nil {
		s.mu.Lock()
		err := s.resumingLocked(*resumedFrom)
		s.mu.Unlock()
		if err != nil {
			return nil, err
		}
	}
	// Validate the payload before reserving a run directory.
	if _, err := TaskPayload(request, project, id, filepath.Join(project, "runs", id), claim); err != nil {
		return nil, err
	}
	root, runDir, err := s.prepareRunDir(project, id)
	if err != nil {
		return nil, err
	}
	payload, err := TaskPayload(request, root, id, runDir, claim)
	if err != nil {
		_ = os.RemoveAll(runDir)
		return nil, err
	}
	requestFile := filepath.Join(runDir, "task-request.json")
	stored := request
	stored.TaskID = nil
	stored.ProjectPath = root
	data, err := json.Marshal(payload)
	if err == nil {
		err = os.WriteFile(requestFile, data, 0o644)
	}
	if err == nil {
		err = writeAtomic(runDir, StartFile, stored)
	}
	if err != nil {
		_ = os.RemoveAll(runDir)
		return nil, fmt.Errorf("cannot save task request: %w", err)
	}
	return &Prepared{ID: id, Kind: request.Kind, Project: root, RunDir: runDir,
		RequestFile: requestFile, Claim: claim, ResumedFrom: resumedFrom}, nil
}

// resumingLocked refuses a second resume of from while an earlier resumed
// copy is still queued or running (both would write the same outputs).
func (s *Scheduler) resumingLocked(from string) error {
	for other, e := range s.tasks {
		if e.resumedFrom != nil && *e.resumedFrom == from && slices.Contains(activeStates, e.status) {
			return fmt.Errorf("task %s is already being resumed as %s", from, other)
		}
	}
	return nil
}

// Submit registers the task as queued and launches it at once when the
// budget allows. The returned snapshot shows running, queued or failed.
// cmd must not have been started; its stdio and process group are set here.
func (s *Scheduler) Submit(cmd *exec.Cmd, task *Prepared, onFinish OnFinish) (Obj, error) {
	if err := ValidateID(task.ID); err != nil {
		return nil, err
	}
	if filepath.Dir(filepath.Dir(task.RunDir)) != task.Project {
		return nil, errors.New("task run directory escapes project")
	}
	if s.shuttingDown.Load() {
		return nil, errors.New("the application is shutting down")
	}
	if onFinish == nil {
		onFinish = func(string, string) {}
	}
	id := task.ID
	s.mu.Lock()
	if _, used := s.tasks[id]; used {
		s.mu.Unlock()
		return nil, errors.New("task id is already in use")
	}
	if task.ResumedFrom != nil {
		if err := s.resumingLocked(*task.ResumedFrom); err != nil {
			s.mu.Unlock()
			// A concurrent resume won; this copy never ran.
			_ = os.RemoveAll(task.RunDir)
			return nil, err
		}
	}
	if len(s.tasks) >= maxTasks {
		oldest := ""
		var at time.Time
		for other, e := range s.tasks {
			if !e.finished.IsZero() && (oldest == "" || e.finished.Before(at)) {
				oldest, at = other, e.finished
			}
		}
		if oldest == "" {
			s.mu.Unlock()
			return nil, errors.New("task limit reached; wait for an active task to finish")
		}
		delete(s.tasks, oldest)
	}
	entry := &taskState{
		kind:        task.Kind,
		status:      "queued",
		pending:     &pending{cmd: cmd, onFinish: onFinish},
		project:     task.Project,
		runDir:      task.RunDir,
		startedAt:   iso(time.Now()),
		claim:       Budget{CPU: max(task.Claim.CPU, 1), MemMB: task.Claim.MemMB},
		seq:         s.seq,
		resumedFrom: task.ResumedFrom,
	}
	s.seq++
	if err := entry.persist(id); err != nil {
		s.mu.Unlock()
		return nil, fmt.Errorf("cannot save task status: %w", err)
	}
	s.tasks[id] = entry
	s.mu.Unlock()
	s.schedule()
	s.mu.Lock()
	entry, ok := s.tasks[id]
	var snap Obj
	if ok {
		snap = entry.snapshot(id)
	}
	s.mu.Unlock()
	if !ok {
		return nil, errors.New("task disappeared")
	}
	return withProgress(snap), nil
}

type queuedTask struct {
	seq   uint64
	id    string
	claim Budget
	kind  string
}

type admitted struct {
	id    string
	claim Budget
}

// admit picks the queued tasks to launch now, with their (clamped) claims:
// FIFO by seq, stopping at the first claim that does not fit (head-of-line
// blocking). Claims larger than the whole budget are clamped, so when
// nothing runs the head always fits and the queue cannot deadlock.
func admit(queued []queuedTask, used, budget Budget) []admitted {
	sort.Slice(queued, func(i, j int) bool { return queued[i].seq < queued[j].seq })
	var launch []admitted
	for _, q := range queued {
		claim := clampClaim(q.claim, budget)
		if used.CPU+claim.CPU > budget.CPU || used.MemMB+claim.MemMB > budget.MemMB {
			break
		}
		used.CPU += claim.CPU
		used.MemMB += claim.MemMB
		launch = append(launch, admitted{q.id, claim})
	}
	return launch
}

// MapSlotEnv names the lock file sample pipelines hold while Bowtie2 maps.
const MapSlotEnv = "RNAXRAY_MAP_SLOT"

// earlyKind is the task kind that may start before the CPUs are free:
// its first stage (reading and collapsing reads) runs on one core, and its
// mapping waits for the machine-wide map slot, so starting it while
// another sample maps hides that stage without competing for the cores.
const earlyKind = "sample_pipeline"

// EarlyStart enables earlyStart (benchmarks turn it off to compare).
var EarlyStart = true

// earlyStart is the queue head to start beyond the CPU budget, if any:
// only a sample pipeline, only when exactly one other sample pipeline (and
// nothing else) runs, and only when its memory fits.
func earlyStart(queued []queuedTask, running []string, used, budget Budget) *admitted {
	if !EarlyStart || len(queued) == 0 || len(running) != 1 || running[0] != earlyKind {
		return nil
	}
	sort.Slice(queued, func(i, j int) bool { return queued[i].seq < queued[j].seq })
	head := queued[0]
	if head.kind != earlyKind {
		return nil
	}
	claim := clampClaim(head.claim, budget)
	if used.MemMB+claim.MemMB > budget.MemMB {
		return nil
	}
	return &admitted{head.id, claim}
}

type started struct {
	id, project, runDir string
	cmd                 *exec.Cmd
	exited              chan struct{}
	onFinish            OnFinish
}

// schedule launches every queued task that fits the budget.
func (s *Scheduler) schedule() {
	for !s.shuttingDown.Load() {
		var monitors []started
		var failed []started
		s.mu.Lock()
		budget := s.budgetLocked()
		var used Budget
		var queued []queuedTask
		var running []string
		for id, e := range s.tasks {
			if e.status == "running" && e.cmd != nil {
				used.CPU += e.claim.CPU
				used.MemMB += e.claim.MemMB
				running = append(running, e.kind)
			} else if e.status == "queued" && e.pending != nil {
				queued = append(queued, queuedTask{e.seq, id, e.claim, e.kind})
			}
		}
		launch := admit(queued, used, budget)
		if len(launch) == 0 {
			if early := earlyStart(queued, running, used, budget); early != nil {
				launch = append(launch, *early)
			}
		}
		for _, a := range launch {
			e := s.tasks[a.id]
			if e == nil || e.pending == nil {
				continue
			}
			p := e.pending
			e.pending = nil
			e.claim = a.claim
			if s.launch(a.id, e, p.cmd) {
				e.onFinish = p.onFinish
				monitors = append(monitors, started{a.id, e.project, e.runDir, e.cmd, e.exited, p.onFinish})
			} else {
				failed = append(failed, started{id: a.id, project: e.project, onFinish: p.onFinish})
			}
		}
		s.mu.Unlock()
		for _, m := range monitors {
			go s.monitor(m)
		}
		for _, f := range failed {
			f.onFinish(f.project, f.id)
		}
		// A failed launch released its share; later tasks may fit now.
		if len(failed) == 0 {
			return
		}
	}
}

// spawnChild starts cmd in its own process group with the granted claim in
// RNAXRAY_TASK_CPUS / RNAXRAY_TASK_MEM_MB and stdout/stderr in the run directory.
func spawnChild(cmd *exec.Cmd, runDir string, claim Budget) error {
	if cmd.Env == nil {
		cmd.Env = os.Environ()
	}
	cmd.Env = append(cmd.Env,
		"RNAXRAY_TASK_CPUS="+strconv.FormatUint(uint64(claim.CPU), 10),
		"RNAXRAY_TASK_MEM_MB="+strconv.FormatUint(claim.MemMB, 10))
	stdout, err := os.Create(filepath.Join(runDir, "stdout.log"))
	if err != nil {
		return err
	}
	defer stdout.Close()
	stderr, err := os.Create(filepath.Join(runDir, "stderr.log"))
	if err != nil {
		return err
	}
	defer stderr.Close()
	cmd.Stdin = nil
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	newProcessGroup(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("engine unavailable: %w", err)
	}
	return nil
}

// launch starts the child of a queued task (lock held). Returns whether it
// is running.
func (s *Scheduler) launch(id string, e *taskState, cmd *exec.Cmd) bool {
	now := time.Now()
	stamp := iso(now)
	e.launchedAt = &stamp
	if err := spawnChild(cmd, e.runDir, e.claim); err != nil {
		e.fail(id, err.Error(), now)
		return false
	}
	e.status = "running"
	e.cmd = cmd
	e.exited = make(chan struct{})
	if err := e.persist(id); err != nil {
		_ = killTree(cmd.Process.Pid)
		_ = cmd.Wait()
		e.cmd = nil
		e.fail(id, "cannot save task status: "+err.Error(), now)
		return false
	}
	return true
}

func (e *taskState) fail(id, message string, now time.Time) {
	stamp := iso(now)
	e.status = "failed"
	e.err = &message
	e.finished = now
	e.finishedAt = &stamp
	_ = e.persist(id)
}

// monitor waits for a running child, records its outcome and calls onFinish.
func (s *Scheduler) monitor(m started) {
	waitErr := m.cmd.Wait()
	close(m.exited)
	var exitCode *int
	var waitError *string
	var exitErr *exec.ExitError
	if waitErr == nil || errors.As(waitErr, &exitErr) {
		if code := m.cmd.ProcessState.ExitCode(); code >= 0 {
			exitCode = &code
		}
	} else {
		message := waitErr.Error()
		waitError = &message
	}
	// File reads happen without holding the task lock.
	result := readResult(m.runDir)
	s.mu.Lock()
	e, ok := s.tasks[m.id]
	if !ok {
		s.mu.Unlock()
		return
	}
	takenByShutdown := e.cmd != m.cmd
	if !takenByShutdown {
		// Still ours (not taken by shutdown): record how it ended.
		e.cmd = nil
		e.exitCode = exitCode
	} else {
		waitError = nil
	}
	if e.status == "cancelled" && waitError == nil && e.exitCode != nil && *e.exitCode == 0 &&
		isRegularFile(filepath.Join(m.runDir, "result.json")) {
		// The child finished as the cancel landed: it wrote its result
		// (atomically, last) and exited 0, so its outputs are complete.
		// Exit 0 alone is not enough: a killed group's parent can exit 0
		// once its children die.
		e.status, e.err = "succeeded", nil
	}
	if slices.Contains(activeStates, e.status) {
		ok := waitError == nil && e.exitCode != nil && *e.exitCode == 0
		if ok {
			e.status = "succeeded"
		} else {
			e.status = "failed"
		}
		if !ok && e.err == nil {
			var message string
			switch {
			case waitError != nil:
				message = *waitError
			case resultError(result) != "":
				message = resultError(result)
			case e.exitCode != nil:
				message = fmt.Sprintf("task exited with code %d", *e.exitCode)
			default:
				message = "task was terminated by a signal"
			}
			e.err = &message
		}
	}
	e.output = outputField(result)
	now := time.Now()
	stamp := iso(now)
	e.finished = now
	e.finishedAt = &stamp
	if err := e.persist(m.id); err != nil {
		message := err.Error()
		e.err = &message
	}
	s.mu.Unlock()
	s.schedule()
	if !takenByShutdown {
		// ShutdownAll finishes the tasks it takes.
		m.onFinish(m.project, m.id)
	}
}

func resultError(result any) string {
	if object, ok := result.(map[string]any); ok {
		if message, ok := object["error"].(string); ok {
			return message
		}
	}
	return ""
}

// liveSnapshot is the in-memory snapshot of id when it belongs to runDir.
func (s *Scheduler) liveSnapshot(id, runDir string) (Obj, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.tasks[id]; ok && e.runDir == runDir {
		return e.snapshot(id), true
	}
	return nil, false
}

// readDisk reads a snapshot persisted by an earlier session. A queued or
// running record without a live process in this session is marked
// interrupted (and saved so).
func readDisk(id, runDir string) (Obj, error) {
	// Only a real run directory (a symlink may come with a copied project
	// and point anywhere: it is neither read nor rewritten).
	if info, err := os.Lstat(runDir); err != nil || !info.IsDir() {
		return nil, errors.New("task not found")
	}
	data, err := readProjectFile(filepath.Join(runDir, "status.json"))
	if err != nil {
		return nil, errors.New("task not found")
	}
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, fmt.Errorf("task status is unreadable: %w", err)
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("task status is not a JSON object")
	}
	object["ok"] = true
	object["task_id"] = id
	object["run_dir"] = runDir
	object["log_paths"] = []any{filepath.Join(runDir, "stdout.log"), filepath.Join(runDir, "stderr.log")}
	for _, key := range []string{"kind", "exit_code", "error", "started_at", "launched_at", "finished_at", "output", "claim", "resumed_from"} {
		if _, ok := object[key]; !ok {
			object[key] = nil
		}
	}
	status, present := object["status"]
	state, _ := status.(string)
	if !present || slices.Contains(activeStates, state) {
		object["status"] = "interrupted"
		if object["error"] == nil {
			object["error"] = "the application stopped before this task finished"
		}
		if object["output"] == nil {
			object["output"] = outputField(readResult(runDir))
		}
		if err := writeStatus(runDir, object); err != nil {
			return nil, err
		}
	}
	return object, nil
}

// statusRaw is the snapshot without progress; finished tasks of earlier
// sessions need the project.
func (s *Scheduler) statusRaw(id, project string) (Obj, error) {
	if err := ValidateID(id); err != nil {
		return nil, err
	}
	s.mu.Lock()
	if e, ok := s.tasks[id]; ok {
		snap := e.snapshot(id)
		s.mu.Unlock()
		return snap, nil
	}
	s.mu.Unlock()
	if strings.TrimSpace(project) == "" {
		return nil, errors.New("task not found; pass project_path to read a finished task")
	}
	_, runs, err := canonicalProject(project)
	if err != nil {
		return nil, err
	}
	return readDisk(id, filepath.Join(runs, id))
}

// Status is a task snapshot with progress. project may be empty for tasks
// of this session.
func (s *Scheduler) Status(id, project string) (Obj, error) {
	snap, err := s.statusRaw(id, project)
	if err != nil {
		return nil, err
	}
	return withProgress(snap), nil
}

// List is every task of the project (live and on disk), newest first.
func (s *Scheduler) List(project string) ([]Obj, error) {
	if !isFile(filepath.Join(project, "project.json")) {
		return nil, errors.New("project directory with project.json does not exist")
	}
	_, runs, err := canonicalProject(project)
	if err != nil {
		return nil, err
	}
	items, err := os.ReadDir(runs)
	if err != nil {
		return nil, err
	}
	tasks := []Obj{}
	for _, item := range items {
		id := item.Name()
		runDir := filepath.Join(runs, id)
		// A run directory is one this app made: a symlink (from a copied
		// project) is skipped, so nothing is read or rewritten through it.
		if ValidateID(id) != nil || !item.IsDir() || !isRegularFile(filepath.Join(runDir, "status.json")) {
			continue
		}
		if live, ok := s.liveSnapshot(id, runDir); ok {
			tasks = append(tasks, withProgress(live))
		} else if value, err := readDisk(id, runDir); err == nil {
			tasks = append(tasks, withProgress(value))
		}
	}
	key := func(v Obj) string { started, _ := v["started_at"].(string); return started }
	sort.SliceStable(tasks, func(i, j int) bool { return key(tasks[i]) > key(tasks[j]) })
	return tasks, nil
}

// Cancel stops a queued or running task (killing the whole process tree).
// Unknown ids fall back to Status.
func (s *Scheduler) Cancel(id, project string) (Obj, error) {
	s.mu.Lock()
	e, ok := s.tasks[id]
	if !ok {
		s.mu.Unlock()
		return s.Status(id, project)
	}
	var finishQueued OnFinish
	message := "cancelled by user"
	if p := e.pending; p != nil {
		// Queued: nothing to kill, and it never reaches a monitor.
		e.pending = nil
		now := time.Now()
		stamp := iso(now)
		e.status = "cancelled"
		e.err = &message
		e.finished = now
		e.finishedAt = &stamp
		if err := e.persist(id); err != nil {
			s.mu.Unlock()
			return nil, err
		}
		finishQueued = p.onFinish
	} else if e.cmd != nil {
		select {
		case <-e.exited:
			// Already exited: the monitor finalizes it.
		default:
			if err := killTree(e.cmd.Process.Pid); err != nil {
				s.mu.Unlock()
				return nil, err
			}
			e.status = "cancelled"
			e.err = &message
			if err := e.persist(id); err != nil {
				s.mu.Unlock()
				return nil, err
			}
		}
	}
	snap := e.snapshot(id)
	project = e.project
	s.mu.Unlock()
	if finishQueued != nil {
		finishQueued(project, id)
	}
	// A cancelled task no longer counts against the budget or blocks the queue.
	s.schedule()
	return withProgress(snap), nil
}

// ShutdownAll kills every running task (application exit) and records
// running and queued tasks as interrupted, so they can be resumed next
// session. Later submissions are refused. Their onFinish runs before it
// returns, so they can still be registered while the runtime is up.
func (s *Scheduler) ShutdownAll() {
	s.shuttingDown.Store(true)
	type finish struct {
		project, id string
		onFinish    OnFinish
	}
	var finishes []finish
	s.mu.Lock()
	for id, e := range s.tasks {
		var message string
		var onFinish OnFinish
		switch {
		case e.pending != nil:
			onFinish = e.pending.onFinish
			e.pending = nil
			message = "the application exited before this queued task started"
		case e.cmd != nil:
			onFinish = e.onFinish
			_ = killTree(e.cmd.Process.Pid)
			// The monitor reaps the child; it does not need the lock for that.
			select {
			case <-e.exited:
			case <-time.After(5 * time.Second):
			}
			e.cmd = nil
			message = "the application exited while this task was running"
		default:
			continue
		}
		now := time.Now()
		stamp := iso(now)
		e.status = "interrupted"
		e.err = &message
		e.finished = now
		e.finishedAt = &stamp
		_ = e.persist(id)
		if onFinish != nil {
			finishes = append(finishes, finish{e.project, id, onFinish})
		}
	}
	s.mu.Unlock()
	for _, f := range finishes {
		f.onFinish(f.project, f.id)
	}
}

// ResumeRequest is the stored start request of a task in project that may
// be resumed (interrupted, failed or cancelled).
func (s *Scheduler) ResumeRequest(id, project string) (TaskStartRequest, error) {
	root, runs, err := canonicalProject(project)
	if err != nil {
		return TaskStartRequest{}, err
	}
	snap, err := s.statusRaw(id, root)
	if err != nil {
		return TaskStartRequest{}, err
	}
	runDir := filepath.Join(runs, id)
	if dir, _ := snap["run_dir"].(string); dir != runDir {
		return TaskStartRequest{}, errors.New("task does not belong to this project")
	}
	state, _ := snap["status"].(string)
	if !slices.Contains(resumableStates, state) {
		return TaskStartRequest{}, fmt.Errorf("only interrupted, failed or cancelled tasks can be resumed (this task is %s)", state)
	}
	data, err := os.ReadFile(filepath.Join(runDir, StartFile))
	if err != nil {
		return TaskStartRequest{}, errors.New("this task cannot be resumed: its original request was not stored")
	}
	request, err := DecodeTaskStartRequest(data)
	if err != nil {
		return TaskStartRequest{}, fmt.Errorf("stored task request is unreadable: %w", err)
	}
	request.TaskID = nil
	request.ProjectPath = root
	return request, nil
}

// DecodeTaskStartRequest parses a stored or UI-supplied start request.
// Unknown window fields are rejected (see Window.UnmarshalJSON).
func DecodeTaskStartRequest(data []byte) (TaskStartRequest, error) {
	var request TaskStartRequest
	err := json.Unmarshal(data, &request)
	return request, err
}

// UnmarshalJSON rejects unknown window fields, like serde's
// deny_unknown_fields on the Tauri side.
func (w *Window) UnmarshalJSON(data []byte) error {
	type plain Window
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var out plain
	if err := decoder.Decode(&out); err != nil {
		return err
	}
	*w = Window(out)
	return nil
}

// ---- Payloads.

func required(value *string, message string) (string, error) {
	if value == nil || strings.TrimSpace(*value) == "" {
		return "", errors.New(message)
	}
	return *value, nil
}

func objectParameters(request TaskStartRequest) (any, error) {
	switch p := request.Parameters.(type) {
	case nil:
		return Obj{}, nil
	case map[string]any:
		return p, nil
	}
	return nil, errors.New("task parameters must be an object")
}

func parametersOrEmpty(request TaskStartRequest) any {
	if request.Parameters == nil {
		return Obj{}
	}
	return request.Parameters
}

func validateGeneID(gene string) error {
	if strings.TrimSpace(gene) == "" || len(gene) > 256 || strings.IndexFunc(gene, unicode.IsControl) >= 0 {
		return errors.New("structure gene_id must be a non-empty name of at most 256 characters")
	}
	return nil
}

func structurePayload(request TaskStartRequest, project, id, runDir string, claim Budget) (Obj, error) {
	samples := request.SampleIDs
	if len(samples) == 0 {
		return nil, errors.New("structure sample_ids must list at least one sample")
	}
	if len(samples) > maxSamples {
		return nil, fmt.Errorf("structure accepts at most %d samples", maxSamples)
	}
	for index, sample := range samples {
		if err := validateSampleID(sample); err != nil {
			return nil, err
		}
		if slices.Contains(samples[:index], sample) {
			return nil, fmt.Errorf("structure sample id %q is duplicated", sample)
		}
	}
	gene, err := required(request.GeneID, "structure gene_id is required")
	if err != nil {
		return nil, err
	}
	if err := validateGeneID(gene); err != nil {
		return nil, err
	}
	if request.Mode == nil {
		return nil, errors.New("structure mode is required (genome or windows)")
	}
	mode := *request.Mode
	windows := request.Windows
	if windows == nil {
		windows = []Window{}
	}
	switch {
	case mode == "genome" && len(windows) > 0:
		return nil, errors.New("structure windows are only allowed in windows mode")
	case mode == "windows" && len(windows) == 0:
		return nil, errors.New("structure windows mode needs at least one window")
	case mode != "genome" && mode != "windows":
		return nil, errors.New("structure mode must be genome or windows")
	}
	if len(windows) > maxWindows {
		return nil, fmt.Errorf("structure accepts at most %d windows", maxWindows)
	}
	for _, w := range windows {
		if w.Start >= w.End {
			return nil, fmt.Errorf("structure window %d-%d must have start < end", w.Start, w.End)
		}
	}
	if request.Workers != nil && *request.Workers == 0 {
		return nil, errors.New("structure workers must be at least 1")
	}
	// Never more workers than the cpus granted to the task.
	workers := claim.CPU
	if request.Workers != nil {
		workers = min(*request.Workers, claim.CPU)
	}
	parameters, err := objectParameters(request)
	if err != nil {
		return nil, err
	}
	return Obj{
		"operation": "structure_run", "project_path": project, "sample_ids": samples,
		"gene_id": gene, "mode": mode, "windows": windows, "parameters": parameters,
		"workers": max(workers, 1), "task_id": id, "run_dir": runDir,
	}, nil
}

func comparePayload(request TaskStartRequest, project, id, runDir string) (Obj, error) {
	one, two := request.SamplesOne, request.SamplesTwo
	if len(one) == 0 {
		return nil, errors.New("compare samples_one must list at least one sample")
	}
	if len(two) == 0 {
		return nil, errors.New("compare samples_two must list at least one sample")
	}
	if len(one)+len(two) > maxSamples {
		return nil, fmt.Errorf("compare accepts at most %d samples", maxSamples)
	}
	if len(one)+len(two) < 3 {
		return nil, errors.New("compare needs at least three samples (two replicates in one condition)")
	}
	all := append(append([]string(nil), one...), two...)
	for index, sample := range all {
		if err := validateSampleID(sample); err != nil {
			return nil, err
		}
		if slices.Contains(all[:index], sample) {
			return nil, fmt.Errorf("compare sample id %q is listed twice", sample)
		}
	}
	parameters, err := objectParameters(request)
	if err != nil {
		return nil, err
	}
	return Obj{
		"operation": "compare_run", "project_path": project, "samples_one": one, "samples_two": two,
		"parameters": parameters, "task_id": id, "run_dir": runDir,
	}, nil
}

func energyPayload(request TaskStartRequest, project, id, runDir string) (Obj, error) {
	comparison, err := required(request.ComparisonID, "energy comparison_id is required")
	if err != nil {
		return nil, err
	}
	if err := ValidateID(comparison); err != nil {
		return nil, fmt.Errorf("energy comparison_id: %w", err)
	}
	parameters, err := objectParameters(request)
	if err != nil {
		return nil, err
	}
	return Obj{
		"operation": "energy_run", "project_path": project, "comparison_id": comparison,
		"parameters": parameters, "task_id": id, "run_dir": runDir,
	}, nil
}

// TaskPayload builds the allowlisted child request for request.Kind.
func TaskPayload(request TaskStartRequest, project, id, runDir string, claim Budget) (Obj, error) {
	switch request.Kind {
	case "validate_project":
		return Obj{"operation": "validate_project", "path": project, "check_files": true, "task_id": id, "run_dir": runDir}, nil
	case "cplfold":
		sequence, err := required(request.Sequence, "cplfold sequence is required")
		if err != nil {
			return nil, err
		}
		return Obj{"operation": "cplfold_run", "project_path": project, "sequence": sequence,
			"bonus_matrix": request.BonusMatrix, "parameters": parametersOrEmpty(request),
			"task_id": id, "run_dir": runDir}, nil
	case "pipeline":
		// Paths stay project-relative; the bridge rejects anything outside the project.
		input, err := required(request.Input, "pipeline input is required")
		if err != nil {
			return nil, err
		}
		reference, err := required(request.Reference, "pipeline reference is required")
		if err != nil {
			return nil, err
		}
		return Obj{"operation": "pipeline_run", "project_path": project, "input": input,
			"reference": reference, "parameters": parametersOrEmpty(request),
			"task_id": id, "run_dir": runDir}, nil
	case "sample_pipeline", "analysis_index":
		sample, err := required(request.SampleID, request.Kind+" sample_id is required")
		if err != nil {
			return nil, err
		}
		if err := validateSampleID(sample); err != nil {
			return nil, err
		}
		operation := "analysis_index_build"
		if request.Kind == "sample_pipeline" {
			operation = "sample_pipeline_run"
		}
		return Obj{"operation": operation, "project_path": project, "sample_id": sample, "task_id": id, "run_dir": runDir}, nil
	case "structure":
		return structurePayload(request, project, id, runDir, claim)
	case "compare":
		return comparePayload(request, project, id, runDir)
	case "energy":
		return energyPayload(request, project, id, runDir)
	}
	return nil, errors.New(unsupportedKind)
}

// BridgeCommand is the child command: the single-shot bridge reading
// task-request.json and writing result.json beside it. env is appended to
// the parent environment.
func BridgeCommand(python, root, requestFile string, env []string) *exec.Cmd {
	cmd := exec.Command(python, "-m", "desktop.runtime.bridge",
		"--repo-root", root,
		"--request", requestFile,
		"--result-file", filepath.Join(filepath.Dir(requestFile), "result.json"))
	cmd.Dir = root
	cmd.Env = append(os.Environ(), env...)
	return cmd
}
