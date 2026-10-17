package core

import "rnaxraydesktop/model"

// Obj is a JSON object as the bridge sends and receives it.
type Obj = map[string]any

// Window is one gene-coordinate window of a structure task (1-based).
type Window struct {
	Start uint64 `json:"start"`
	End   uint64 `json:"end"`
}

// TaskStartRequest mirrors tasks::TaskStartRequest of the Tauri shell; it is
// also what task-start.json stores for task_resume.
type TaskStartRequest struct {
	ProjectPath string   `json:"project_path"`
	Kind        string   `json:"kind"`
	TaskID      *string  `json:"task_id,omitempty"`
	Sequence    *string  `json:"sequence,omitempty"`
	BonusMatrix *string  `json:"bonus_matrix,omitempty"`
	Parameters  any      `json:"parameters,omitempty"`
	Input       *string  `json:"input,omitempty"`
	Reference   *string  `json:"reference,omitempty"`
	SampleID    *string  `json:"sample_id,omitempty"`
	SampleIDs   []string `json:"sample_ids,omitempty"`
	GeneID      *string  `json:"gene_id,omitempty"`
	Mode        *string  `json:"mode,omitempty"`
	Windows     []Window `json:"windows,omitempty"`
	Workers     *uint32  `json:"workers,omitempty"`
	SamplesOne  []string `json:"samples_one,omitempty"`
	SamplesTwo  []string `json:"samples_two,omitempty"`
	// ComparisonID names the Compare test of an energy task.
	ComparisonID *string `json:"comparison_id,omitempty"`
	CPU          *uint32 `json:"cpu,omitempty"`
	MemMB        *uint64 `json:"mem_mb,omitempty"`
}

// Backend is everything the native UI asks of the shell: one method per
// Tauri command of desktop/src-tauri/src/main.rs (named in each comment),
// with the same validation, lanes and results. Views depend on this
// interface only, so tests can substitute a fake. Every method may block;
// call it from a goroutine and publish results with Window.Update.
//
// Native dialogs are not here: views call mygo.Dialog directly and pass the
// chosen paths in.
type Backend interface {
	// runtime_detect: the bridge's whole `detect` response; the detection
	// itself is under "result".
	Detect() (Obj, error)

	// project_create: creates the project directory and returns the bridge result.
	CreateProject(path, name, description string) (Obj, error)
	// project_validate.
	ValidateProject(path string, checkFiles bool) (Obj, error)
	// project_open: validates and opens a project; the result carries the
	// canonical "path" and the "manifest". (Tasks open their project
	// themselves, as task_start does.)
	OpenProject(path string) (Obj, error)
	// project_import_input_dialog after the dialog: imports source (a path
	// the view picked with mygo.Dialog) into the project's inputs with a
	// role ("" means "other") and label.
	ImportInput(path, source, role, label string) (Obj, error)
	// project_update_ui_state.
	UpdateUIState(path string, uiState Obj) (Obj, error)
	// project_save_analysis_run.
	SaveAnalysisRun(path string, result Obj) (Obj, error)
	// project_read_input.
	ReadInput(path, relative string) (Obj, error)

	// The expected time of running these samples' pipelines (perf.go).
	EstimatePipelines(inputs []PipelineInput) PipelineEstimate
	// The expected time of a structure fold of these window lengths.
	EstimateFold(lengths []int, beam, workers int) FoldEstimate

	// project_op: one of the PROJECT_OPERATIONS allowlist on the control
	// lane; payload must not contain "operation" or "path".
	ProjectOp(path, operation string, payload Obj) (Obj, error)
	// analysis_query: an allowlisted analysis operation on the compute lane;
	// returns the bridge's `result` field (as the Tauri command does).
	Query(projectPath, operation string, payload Obj) (any, error)
	// cplfold_predict (compute lane).
	CplfoldPredict(sequence string, evidenceMode string, evidenceArms any, parameters Obj) (Obj, error)

	// task_start / task_resume / task_status / task_cancel / task_list:
	// task snapshots as the Tauri scheduler returns them
	// ({task_id, kind, status, progress, claim, ...}).
	StartTask(request TaskStartRequest) (Obj, error)
	ResumeTask(projectPath, taskID string) (Obj, error)
	TaskStatus(projectPath, taskID string) (Obj, error)
	CancelTask(projectPath, taskID string) (Obj, error)
	ListTasks(projectPath string) ([]Obj, error)

	// preferences_get / preferences_set.
	Preferences() (Obj, error)
	SetPreferences(patch Obj) (Obj, error)

	// External evidence (desktop/spec/EVIDENCE.md), served by a separate
	// evidence worker that Go starts on demand. Every worker call fails
	// with ErrExternalLookupOff, before the worker starts, while the
	// external_lookup preference is off. There is deliberately no generic
	// tool/arguments entry: only these fixed operations exist.

	// EvidenceStatus is the worker's versions and allowed tools; connect
	// starts the RNAcentral MCP server (the Preferences connection test).
	EvidenceStatus(connect bool) (model.EvidenceStatus, error)
	// DescribeRNA reads RNAcentral's existing literature summary for a
	// public identifier (get_rna_description). Only rnaID and taxon (may be
	// empty) leave the machine. Without confirmed (the user confirmed the
	// identifier and species) it answers an identity_unconfirmed card
	// without network. force bypasses the worker's cache. Timeouts and
	// cancellation answer timeout / cancelled cards.
	DescribeRNA(projectPath, rnaID, taxon string, confirmed, force bool) (model.EvidenceCard, error)
	// MapRNAID checks an external identifier within a taxon (map_rna_id);
	// the mapping is advisory and never decides identity.
	MapRNAID(identifier, taxon string) (model.EvidenceCard, error)
	// CancelEvidence cancels the running lookup by killing the worker and
	// its MCP child; the next call starts them again.
	CancelEvidence()
	// ListEvidence is the project's saved cards (<project>/evidence/),
	// newest first.
	ListEvidence(projectPath string) ([]model.EvidenceCard, error)
	// AttachEvidence saves a card bound to one structure result (Go sets
	// project_id and attached_at; review starts unreviewed) and its raw
	// tool text when known.
	AttachEvidence(projectPath string, card model.EvidenceCard, binding model.EvidenceBinding) (model.EvidenceCard, error)
	// UpdateEvidence sets whether a saved card is in the report and, when
	// update.Review is set, the user's review state and note.
	UpdateEvidence(projectPath, id string, update model.EvidenceUpdate) (model.EvidenceCard, error)
	// DeleteEvidence removes a saved card and its raw text.
	DeleteEvidence(projectPath, id string) error
	// ClearEvidenceCache empties the worker's response cache.
	ClearEvidenceCache() error

	// Shutdown marks running tasks interrupted, stops the sidecars and
	// refuses later calls (application exit).
	Shutdown()
}
