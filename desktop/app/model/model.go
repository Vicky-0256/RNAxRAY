// Package model holds the typed project data the views show, decoded from
// the bridge's JSON (project.json schema 2.0, list_samples, task
// snapshots). Unknown fields are ignored; the bridge stays the authority.
package model

import (
	"encoding/json"
	"sort"
)

// Decode converts a JSON-shaped value (as core.Obj holds) into out.
func Decode(value any, out any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

type Sequence struct {
	Name   string `json:"name"`
	Length int    `json:"length"`
}

type Reference struct {
	ID        string     `json:"id"`
	Label     string     `json:"label"`
	Path      string     `json:"path"`
	Mode      string     `json:"mode"`
	SizeBytes int64      `json:"size_bytes"`
	QuickHash string     `json:"quick_hash"`
	SHA256    string     `json:"sha256"`
	Sequences []Sequence `json:"sequences"`
}

type Reads struct {
	Path      string  `json:"path"`
	Mode      string  `json:"mode"`
	Format    string  `json:"format"`
	SizeBytes int64   `json:"size_bytes"`
	Mtime     float64 `json:"mtime"`
	QuickHash string  `json:"quick_hash"`
	SHA256    string  `json:"sha256"`
}

type Outputs struct {
	Hyb        string `json:"hyb"`
	Homodimers string `json:"homodimers"`
	Stats      string `json:"stats"`
	Contact    string `json:"contact"`
	Index      string `json:"index"`
}

type Stage struct {
	Status    string `json:"status"`
	TaskID    string `json:"task_id"`
	UpdatedAt string `json:"updated_at"`
}

type Sample struct {
	ID           string           `json:"id"`
	Name         string           `json:"name"`
	Condition    string           `json:"condition"`
	Replicate    any              `json:"replicate"`
	ReferenceID  string           `json:"reference_id"`
	GeneID       string           `json:"gene_id"`
	Reads        Reads            `json:"reads"`
	Outputs      Outputs          `json:"outputs"`
	Stages       map[string]Stage `json:"stages"`
	Ready        bool             `json:"ready"`
	StageSummary string           `json:"stage_summary"`
	CreatedAt    string           `json:"created_at"`
}

// IsReady: the sample has an analysis index (it can be explored).
func (s Sample) IsReady() bool { return s.Ready || s.Outputs.Index != "" }

// HasHyb: a .hyb exists, produced or linked.
func (s Sample) HasHyb() bool { return s.Outputs.Hyb != "" || s.Reads.Format == "hyb" }

// Label is the name shown for the sample.
func (s Sample) Label() string {
	if s.Name != "" {
		return s.Name
	}
	return s.ID
}

type Condition struct {
	Name      string   `json:"name"`
	SampleIDs []string `json:"sample_ids"`
}

// UntrustedLink is a file the project names outside its folder that was
// not linked on this computer (list_samples untrusted_links): Python does
// not open it until the user allows it.
type UntrustedLink struct {
	Path   string   `json:"path"`
	UsedBy []string `json:"used_by"`
}

// Project is an opened project: its manifest summary plus the sample model.
type Project struct {
	Path        string
	Name        string
	Description string
	References  []Reference
	Samples     []Sample
	Conditions  []Condition
	// UntrustedLinks: see UntrustedLink (empty when all may be opened).
	UntrustedLinks []UntrustedLink
	UIState        map[string]any
}

func (p *Project) Sample(id string) *Sample {
	for i := range p.Samples {
		if p.Samples[i].ID == id {
			return &p.Samples[i]
		}
	}
	return nil
}

func (p *Project) Reference(id string) *Reference {
	for i := range p.References {
		if p.References[i].ID == id {
			return &p.References[i]
		}
	}
	return nil
}

// GeneLength is the length of a reference sequence by name (0 if unknown).
func (p *Project) GeneLength(name string) int {
	for _, r := range p.References {
		for _, s := range r.Sequences {
			if s.Name == name {
				return s.Length
			}
		}
	}
	return 0
}

// DeriveConditions groups samples by condition when the bridge sends none.
func DeriveConditions(samples []Sample) []Condition {
	var out []Condition
	index := map[string]int{}
	for _, s := range samples {
		if s.Condition == "" {
			continue
		}
		i, ok := index[s.Condition]
		if !ok {
			i = len(out)
			index[s.Condition] = i
			out = append(out, Condition{Name: s.Condition})
		}
		out[i].SampleIDs = append(out[i].SampleIDs, s.ID)
	}
	return out
}

// Progress is a task's progress.json as the scheduler passes it through.
type Progress struct {
	Stage      string   `json:"stage"`
	Detail     string   `json:"detail"`
	BytesDone  *float64 `json:"bytes_done"`
	BytesTotal *float64 `json:"bytes_total"`
	Units      string   `json:"units"`
	UpdatedAt  string   `json:"updated_at"`
}

// Fraction is the done share in [0, 1], or -1 when unknown.
func (p *Progress) Fraction() float64 {
	if p == nil || p.BytesDone == nil || p.BytesTotal == nil || *p.BytesTotal <= 0 {
		return -1
	}
	f := *p.BytesDone / *p.BytesTotal
	if f < 0 {
		return 0
	}
	if f > 1 {
		return 1
	}
	return f
}

// Task is a scheduler snapshot (task_start / task_status / task_list).
type Task struct {
	TaskID      string    `json:"task_id"`
	Kind        string    `json:"kind"`
	Status      string    `json:"status"`
	ExitCode    *int      `json:"exit_code"`
	Error       any       `json:"error"`
	StartedAt   string    `json:"started_at"`
	LaunchedAt  string    `json:"launched_at"`
	FinishedAt  string    `json:"finished_at"`
	Progress    *Progress `json:"progress"`
	SecondsLeft *float64  `json:"seconds_left"`
	ResumedFrom string    `json:"resumed_from"`
	Output      any       `json:"output"`
}

var activeStatuses = map[string]bool{"queued": true, "running": true}

func (t Task) Active() bool { return activeStatuses[t.Status] }

// ErrorText flattens the snapshot's error (string or {message}).
func (t Task) ErrorText() string {
	switch e := t.Error.(type) {
	case string:
		return e
	case map[string]any:
		if m, ok := e["message"].(string); ok {
			return m
		}
	}
	return ""
}

// SortTasks orders newest first.
func SortTasks(tasks []Task) {
	sort.SliceStable(tasks, func(i, j int) bool { return tasks[i].StartedAt > tasks[j].StartedAt })
}
