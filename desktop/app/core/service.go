package core

// Service implements Backend: the request building, validation and lane of
// every Tauri command of desktop/src-tauri/src/main.rs.
//
// Intentionally dropped with the webview: the asset-protocol scope that
// project_open granted (views read project files directly) and
// file_save_dialog's base64 payload (views write files themselves after
// mygo.Dialog.Save). Native dialogs are the views' business; project_
// import_input_dialog becomes ImportInput with the picked source path.

import (
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"rnaxraydesktop/model"
)

// AnalysisOperations are the read-only analysis queries (contract R3/R6),
// served on the compute lane.
var AnalysisOperations = []string{
	"analysis_summary",
	"analysis_contact_bins",
	"analysis_hybrids",
	"analysis_top",
	"compare_bins",
	"analysis_viewpoint",
	"analysis_region",
}

// ProjectOperations are the short control-lane operations on project.json;
// Python validates the rest.
var ProjectOperations = []string{
	"add_reference",
	"update_reference",
	"remove_reference",
	"add_sample",
	"update_sample",
	"remove_sample",
	"import_sample_sheet",
	"scan_data_folder",
	"import_sample_rows",
	"check_inputs",
	"disk_estimate",
	"list_samples",
	"list_structures",
	"read_structure",
	"read_reference_sequence",
	"list_comparisons",
	"read_comparison",
	"set_reference_annotation",
	"read_annotation",
	// Panels of a Compare test: enriched regions' local structures
	// (desktop/runtime/regions.py) and the folding-energy result
	// (desktop/runtime/energy.py; computed by an `energy` task).
	"structure_regions",
	"read_energy",
	// Files a project links outside its folder (desktop/runtime/trust.py).
	"list_untrusted_links",
	"trust_links",
}

// ServiceOptions configures a Service.
type ServiceOptions struct {
	// PreferencesPath is preferences.json in the application config
	// directory. Empty means default preferences that cannot be saved.
	PreferencesPath string
	// Logf receives errors nobody waits for (register_task_run, warm-up);
	// nil uses log.Printf.
	Logf func(format string, args ...any)
	// EvidenceCacheDir and EvidenceLogDir are the evidence worker's
	// RNAXRAY_EVIDENCE_CACHE (<app cache>/evidence) and RNAXRAY_EVIDENCE_LOG
	// (<app logs>).
	EvidenceCacheDir string
	EvidenceLogDir   string
}

// Service is the Backend over a Runtime and a task Scheduler.
type Service struct {
	rtMu      sync.RWMutex
	rt        *Runtime
	rtPending bool // the bundled runtime is still being unpacked
	tasks     *Scheduler
	prefsPath string
	logf      func(format string, args ...any)
	// taskCommand builds a task's child command; tests replace it.
	taskCommand func(rt *Runtime, task *Prepared) *exec.Cmd
	evidence    *EvidenceService
}

var _ Backend = (*Service)(nil)

// NewService wires the scheduler to the stored budget. rt may be nil when
// the runtime could not be resolved; bridge calls then fail.
func NewService(rt *Runtime, opts ServiceOptions) *Service {
	logf := opts.Logf
	if logf == nil {
		logf = log.Printf
	}
	tasks := NewScheduler()
	// A missing or invalid preferences file means the default budget.
	tasks.SetBudget(LoadBudget(opts.PreferencesPath))
	s := &Service{
		rt: rt, tasks: tasks, prefsPath: opts.PreferencesPath, logf: logf,
		taskCommand: func(rt *Runtime, task *Prepared) *exec.Cmd {
			return BridgeCommand(rt.Bridge.Python, rt.Bridge.Root, task.RequestFile, rt.ComputeEnv)
		},
	}
	cacheDir, logDir := opts.EvidenceCacheDir, opts.EvidenceLogDir
	s.evidence = newEvidenceService(func() (SidecarSpec, error) {
		rt, err := s.runtime()
		if err != nil {
			return SidecarSpec{}, err
		}
		if cacheDir == "" || logDir == "" {
			return SidecarSpec{}, errors.New("the evidence cache and log directories are not set")
		}
		for _, dir := range []string{cacheDir, logDir} {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return SidecarSpec{}, fmt.Errorf("could not create %s: %w", dir, err)
			}
		}
		return EvidenceSpec(rt.Bridge, cacheDir, logDir), nil
	}, func() bool { return LoadExternalLookup(s.prefsPath) }, cacheDir)
	if opts.PreferencesPath != "" {
		// Beside the preferences, not in the cache: clearing it keeps the seals.
		s.evidence.sealKeyPath = filepath.Join(filepath.Dir(opts.PreferencesPath), sealKeyFile)
	}
	return s
}

// Scheduler is the task scheduler (for views that need the budget).
func (s *Service) Scheduler() *Scheduler { return s.tasks }

func (s *Service) runtime() (*Runtime, error) {
	s.rtMu.RLock()
	defer s.rtMu.RUnlock()
	if s.rt == nil {
		if s.rtPending {
			return nil, errors.New("The bundled runtime is still being prepared; try again in a moment.")
		}
		return nil, errors.New("Native runtime is not available. Rebuild or reinstall RNAxRay Desktop with the runtime resources.")
	}
	return s.rt, nil
}

// SetPending marks the runtime as being prepared (first-launch unpacking).
func (s *Service) SetPending(pending bool) {
	s.rtMu.Lock()
	s.rtPending = pending
	s.rtMu.Unlock()
}

// SetRuntime attaches a runtime resolved after the service was made.
func (s *Service) SetRuntime(rt *Runtime) {
	s.rtMu.Lock()
	s.rt, s.rtPending = rt, false
	s.rtMu.Unlock()
}

func (s *Service) call(lane Lane, request Obj) (Obj, error) {
	rt, err := s.runtime()
	if err != nil {
		return nil, err
	}
	return rt.Call(lane, request)
}

// Detect is runtime_detect.
func (s *Service) Detect() (Obj, error) {
	return s.call(Control, Obj{"operation": "detect"})
}

// CreateProject is project_create.
func (s *Service) CreateProject(path, name, description string) (Obj, error) {
	return s.call(Control, Obj{"operation": "create_project", "path": path, "name": name, "description": description})
}

// ValidateProject is project_validate.
func (s *Service) ValidateProject(path string, checkFiles bool) (Obj, error) {
	return s.call(Control, Obj{"operation": "validate_project", "path": path, "check_files": checkFiles})
}

// OpenProject is project_open (without the asset scope, see above).
func (s *Service) OpenProject(path string) (Obj, error) {
	return s.call(Control, Obj{"operation": "open_project", "path": path, "check_files": false})
}

// ImportInput is project_import_input_dialog after the dialog: it links or
// copies source into the project's inputs. role defaults to "other".
func (s *Service) ImportInput(path, source, role, label string) (Obj, error) {
	if role == "" {
		role = "other"
	}
	return s.call(Control, Obj{"operation": "import_input", "path": path, "source": source, "role": role, "label": label})
}

// ReadInput is project_read_input.
func (s *Service) ReadInput(path, relative string) (Obj, error) {
	return s.call(Control, Obj{"operation": "read_input", "path": path, "relative": relative})
}

// SaveAnalysisRun is project_save_analysis_run.
func (s *Service) SaveAnalysisRun(path string, result Obj) (Obj, error) {
	return s.call(Control, Obj{"operation": "save_analysis_run", "path": path, "result": result})
}

// UpdateUIState is project_update_ui_state.
func (s *Service) UpdateUIState(path string, uiState Obj) (Obj, error) {
	return s.call(Control, Obj{"operation": "update_ui_state", "path": path, "ui_state": uiState})
}

// CplfoldPredict is cplfold_predict on the compute lane.
func (s *Service) CplfoldPredict(sequence, evidenceMode string, evidenceArms any, parameters Obj) (Obj, error) {
	if evidenceMode == "" {
		evidenceMode = "none"
	}
	if evidenceArms == nil {
		evidenceArms = []any{}
	}
	if parameters == nil {
		parameters = Obj{}
	}
	return s.call(Compute, Obj{"operation": "cplfold_predict", "sequence": sequence,
		"evidenceMode": evidenceMode, "evidenceArms": evidenceArms, "parameters": parameters})
}

// mergeRequest copies payload and adds the fixed keys, which payload must
// not contain.
func mergeRequest(payload Obj, fixed Obj) (Obj, error) {
	request := Obj{}
	for key, value := range payload {
		if _, clash := fixed[key]; clash {
			return nil, fmt.Errorf("payload must not contain %q", key)
		}
		request[key] = value
	}
	for key, value := range fixed {
		request[key] = value
	}
	return request, nil
}

// projectOpRequest accepts {path, operation, ...} for one of ProjectOperations.
func projectOpRequest(request any) (Obj, error) {
	object, ok := request.(map[string]any)
	if !ok {
		return nil, errors.New("project operation must be a JSON object")
	}
	operation, _ := object["operation"].(string)
	if !slices.Contains(ProjectOperations, operation) {
		return nil, fmt.Errorf("unsupported project operation; expected one of %s", strings.Join(ProjectOperations, ", "))
	}
	if path, _ := object["path"].(string); strings.TrimSpace(path) == "" {
		return nil, errors.New("project operation needs a project path")
	}
	return object, nil
}

// ProjectOp is project_op.
func (s *Service) ProjectOp(path, operation string, payload Obj) (Obj, error) {
	request, err := mergeRequest(payload, Obj{"operation": operation, "path": path})
	if err != nil {
		return nil, err
	}
	if request, err = projectOpRequest(request); err != nil {
		return nil, err
	}
	return s.call(Control, request)
}

// analysisRequest accepts {project_path, operation, ...} for one of the
// read-only AnalysisOperations; everything else is forwarded unchanged for
// Python to validate.
func analysisRequest(request any) (Obj, error) {
	object, ok := request.(map[string]any)
	if !ok {
		return nil, errors.New("analysis query must be a JSON object")
	}
	operation, _ := object["operation"].(string)
	if !slices.Contains(AnalysisOperations, operation) {
		return nil, fmt.Errorf("unsupported analysis operation; expected one of %s", strings.Join(AnalysisOperations, ", "))
	}
	if path, _ := object["project_path"].(string); strings.TrimSpace(path) == "" {
		return nil, errors.New("analysis query needs a project_path")
	}
	return object, nil
}

// Query is analysis_query; it returns the response's `result` field.
func (s *Service) Query(projectPath, operation string, payload Obj) (any, error) {
	request, err := mergeRequest(payload, Obj{"operation": operation, "project_path": projectPath})
	if err != nil {
		return nil, err
	}
	if request, err = analysisRequest(request); err != nil {
		return nil, err
	}
	response, err := s.call(Compute, request)
	if err != nil {
		return nil, err
	}
	return response["result"], nil
}

// openProject opens the project through the control lane and returns its
// canonical path.
func (s *Service) openProject(path string) (string, error) {
	opened, err := s.call(Control, Obj{"operation": "open_project", "path": path})
	if err != nil {
		return "", err
	}
	project, ok := opened["path"].(string)
	if !ok {
		return "", errors.New("project path missing")
	}
	return project, nil
}

// startTask validates, stores and submits a task; it runs now or waits in
// the queue. When it ends, register_task_run records it in project.json.
func (s *Service) startTask(request TaskStartRequest, resumedFrom *string) (Obj, error) {
	if !slices.Contains(TaskKinds, request.Kind) {
		return nil, errors.New(unsupportedKind)
	}
	rt, err := s.runtime()
	if err != nil {
		return nil, err
	}
	project, err := s.openProject(request.ProjectPath)
	if err != nil {
		return nil, err
	}
	prepared, err := s.tasks.Prepare(request, project, resumedFrom)
	if err != nil {
		return nil, err
	}
	kind := request.Kind
	onFinish := func(project, id string) {
		register := Obj{"operation": "register_task_run", "path": project, "task_id": id}
		if _, err := rt.Call(Control, register); err != nil {
			s.logf("RNAxRay: register_task_run failed for %s: %v", id, err)
		}
		if kind == "sample_pipeline" || kind == "structure" {
			if record, ok := perfFromResult(kind, filepath.Join(project, "runs", id)); ok {
				if err := AppendPerf(perfPath(s.prefsPath), record); err != nil {
					s.logf("RNAxRay: cannot record the speed of %s: %v", id, err)
				}
			}
		}
	}
	return s.tasks.Submit(s.taskCommand(rt, prepared), prepared, onFinish)
}

// StartTask is task_start.
func (s *Service) StartTask(request TaskStartRequest) (Obj, error) {
	return s.startTask(request, nil)
}

// ResumeTask is task_resume: a new task (new id) from the stored request of
// an interrupted, failed or cancelled task. Stage checkpoints are Python's
// responsibility.
func (s *Service) ResumeTask(projectPath, taskID string) (Obj, error) {
	if err := ValidateID(taskID); err != nil {
		return nil, err
	}
	if strings.TrimSpace(projectPath) == "" {
		return nil, errors.New("project_path is required to resume a task")
	}
	project, err := s.openProject(projectPath)
	if err != nil {
		return nil, err
	}
	stored, err := s.tasks.ResumeRequest(taskID, project)
	if err != nil {
		return nil, err
	}
	return s.startTask(stored, &taskID)
}

// TaskStatus is task_status; projectPath may be empty for tasks of this
// session.
func (s *Service) TaskStatus(projectPath, taskID string) (Obj, error) {
	snap, err := s.tasks.Status(taskID, projectPath)
	if err == nil {
		s.addRemaining([]Obj{snap})
	}
	return snap, err
}

// addRemaining sets "seconds_left" on running sample pipelines whose time
// left can be estimated.
func (s *Service) addRemaining(tasks []Obj) {
	var history []PerfRecord
	loaded := false
	for _, task := range tasks {
		progress, _ := task["progress"].(map[string]any)
		kind := task["kind"]
		if (kind != "sample_pipeline" && kind != "structure") || task["status"] != "running" || progress == nil {
			continue
		}
		if !loaded {
			history, loaded = LoadPerf(perfPath(s.prefsPath)), true
		}
		left, ok := remainingSeconds(history, progress, s.tasks.Budget().CPU)
		if kind == "structure" {
			left, ok = foldRemaining(history, progress, time.Now())
		}
		if ok {
			task["seconds_left"] = math.Round(left)
		}
	}
}

// EstimateFold is the expected time of a structure fold of these window
// lengths (the whole RNA: one), from this computer's measured speed.
func (s *Service) EstimateFold(lengths []int, beam, workers int) FoldEstimate {
	return EstimateFold(LoadPerf(perfPath(s.prefsPath)), lengths, beam, workers)
}

// EstimatePipelines is the expected time of running these samples' pipelines
// with the current CPU budget, from this computer's measured speed.
func (s *Service) EstimatePipelines(inputs []PipelineInput) PipelineEstimate {
	return EstimatePipelines(LoadPerf(perfPath(s.prefsPath)), inputs, s.tasks.Budget().CPU)
}

// CancelTask is task_cancel.
func (s *Service) CancelTask(projectPath, taskID string) (Obj, error) {
	return s.tasks.Cancel(taskID, projectPath)
}

// ListTasks is task_list (the `tasks` array), newest first.
func (s *Service) ListTasks(projectPath string) ([]Obj, error) {
	tasks, err := s.tasks.List(projectPath)
	if err == nil {
		s.addRemaining(tasks)
	}
	return tasks, err
}

// Preferences is preferences_get.
func (s *Service) Preferences() (Obj, error) {
	if s.prefsPath == "" {
		return nil, errors.New("cannot resolve the application config directory")
	}
	return DescribePreferences(s.prefsPath), nil
}

// SetPreferences is preferences_set: `{budget?: {cpu?, mem_mb?} | null,
// theme?: ... | null, external_lookup?: bool | null}`. Turning
// external_lookup off cancels a running lookup. A new budget applies at once and starts queued
// tasks that now fit.
func (s *Service) SetPreferences(patch Obj) (Obj, error) {
	budget, err := ApplyPreferences(s.prefsPath, patch)
	if err != nil {
		return nil, err
	}
	s.tasks.SetBudget(budget)
	if !LoadExternalLookup(s.prefsPath) {
		s.evidence.Cancel()
	}
	return DescribePreferences(s.prefsPath), nil
}

// WarmUp compiles the CPLfold Numba kernels in the compute sidecar in the
// background right after launch, so the first prediction does not pay the
// one-off JIT cost (about 50 s on a fresh install; later launches load the
// on-disk cache). It returns at once.
func (s *Service) WarmUp() {
	rt, err := s.runtime()
	if err != nil {
		return
	}
	go func() {
		if _, err := rt.Call(Compute, Obj{"operation": "warmup"}); err != nil {
			s.logf("RNAxRay: compute warm-up failed: %v", err)
		}
	}()
}

// Shutdown marks running and queued tasks interrupted (killing their
// process trees), then stops the sidecars; later calls fail.
func (s *Service) Shutdown() {
	s.evidence.Shutdown()
	s.tasks.ShutdownAll()
	s.rtMu.RLock()
	rt := s.rt
	s.rtMu.RUnlock()
	if rt != nil {
		rt.Shutdown()
	}
}

// ---- external evidence (EVIDENCE.md)

// EvidenceStatus asks the evidence worker for its versions; connect also
// starts the RNAcentral MCP server and lists its tools.
func (s *Service) EvidenceStatus(connect bool) (model.EvidenceStatus, error) {
	return s.evidence.Status(connect)
}

// DescribeRNA is get_rna_description. Only rnaID and taxon reach the
// worker; projectPath is not sent. Without confirmed the answer is an
// identity_unconfirmed card made locally, without network.
func (s *Service) DescribeRNA(projectPath, rnaID, taxon string, confirmed, force bool) (model.EvidenceCard, error) {
	return s.evidence.Describe(rnaID, taxon, confirmed, force)
}

// MapRNAID is map_rna_id (advisory; the taxon is required).
func (s *Service) MapRNAID(identifier, taxon string) (model.EvidenceCard, error) {
	return s.evidence.Map(identifier, taxon)
}

// CancelEvidence cancels the running lookup.
func (s *Service) CancelEvidence() { s.evidence.Cancel() }

// ListEvidence reads <project>/evidence/.
func (s *Service) ListEvidence(projectPath string) ([]model.EvidenceCard, error) {
	return s.evidence.List(projectPath)
}

// AttachEvidence saves a card bound to a structure result.
func (s *Service) AttachEvidence(projectPath string, card model.EvidenceCard, binding model.EvidenceBinding) (model.EvidenceCard, error) {
	return s.evidence.Attach(projectPath, card, binding)
}

// UpdateEvidence changes a saved card's report inclusion and review.
func (s *Service) UpdateEvidence(projectPath, id string, update model.EvidenceUpdate) (model.EvidenceCard, error) {
	return s.evidence.Update(projectPath, id, update)
}

// DeleteEvidence removes a saved card.
func (s *Service) DeleteEvidence(projectPath, id string) error {
	return s.evidence.Delete(projectPath, id)
}

// ClearEvidenceCache empties the worker's response cache.
func (s *Service) ClearEvidenceCache() error { return s.evidence.ClearCache() }
