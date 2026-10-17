package views

// ① Data: references and the sample table. Import raw files or a sample
// sheet (previewed first), run / resume selected samples (with a disk
// check first), check and relink inputs. Mirrors desktop/ui/data-page.js.

import (
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
)

func init() {
	RegisterPageFactory("data", func(a *App) Page {
		return &dataPage{a: a, checked: map[string]*bool{}, inputs: map[string]dataInputItem{}, runningFor: map[string]string{}}
	})
}

var dataStages = []string{"map", "hyb", "index"}

var dataStorageModes = []string{"Link in place (recommended)", "Copy into the project"}

// dataInputItem is one check_inputs item.
type dataInputItem struct {
	Kind   string `json:"kind"`
	ID     string `json:"id"`
	Path   string `json:"path"`
	Status string `json:"status"`
	Detail string `json:"detail"`
}

// dataEstimate is disk_estimate's answer.
type dataEstimate struct {
	Totals struct {
		Input        int64 `json:"input_bytes"`
		Uncompressed int64 `json:"uncompressed_bytes"`
		TempPeak     int64 `json:"temp_peak_bytes"`
		Output       int64 `json:"output_bytes"`
		Required     int64 `json:"required_bytes"`
	} `json:"totals"`
	Volumes []struct {
		Path     string `json:"path"`
		Role     string `json:"role"`
		Required int64  `json:"required_bytes"`
		Free     int64  `json:"free_bytes"`
		OK       bool   `json:"ok"`
	} `json:"volumes"`
	Fits bool `json:"fits"`
}

// dataSheetRow is one planned sample of an import_sample_sheet dry run.
type dataSheetRow struct {
	Name      string `json:"name"`
	Condition string `json:"condition"`
	Replicate any    `json:"replicate"`
	Format    string `json:"format"`
	Path      string `json:"path"`
	Reference string `json:"reference"`
	GeneID    string `json:"gene_id"`
}

type dataRunDialog struct {
	open     bool
	ids      []string
	loading  bool
	estimate *dataEstimate
	err      string
	time     *core.PipelineEstimate
	leftOut  []string // samples not started: no reference
}

type dataSheetDialog struct {
	open, problemsOpen bool
	sheet              string
	rows               []dataSheetRow
	references         int
	problems           string
	mode               string
	status             string
	busy               bool
	table              ui.ListState
}

type dataAddDialog struct {
	open      bool
	paths     []string
	names     []string
	reference string // label shown in the select
	condition string
	replicate string
	gene      string
	mode      string
	status    string
	busy      bool
}

type dataEditDialog struct {
	open      bool
	id        string
	name      string
	condition string
	replicate string
	reference string
	gene      string
	status    string
	busy      bool
}

// dataSetRefDialog sets one reference for several samples that have none.
type dataSetRefDialog struct {
	open      bool
	ids       []string
	reference string // label shown in the select
	status    string
	busy      bool
}

type dataRenameDialog struct {
	open   bool
	id     string
	label  string
	status string
}

type dataPage struct {
	a *App
	// checked holds the sample check boxes by id (pointers stay bound).
	checked map[string]*bool
	// inputs: check_inputs items by "<kind>:<id>"; checkSummary the line
	// shown after a check.
	inputs       map[string]dataInputItem
	checkedOpen  int // a.opened whose inputs were checked
	checkSeq     int // only the latest check's answer is shown
	checkSummary string
	checking     bool
	// runningFor maps a sample to the task this session started for it,
	// until the manifest's stages name it.
	runningFor map[string]string
	table      ui.ListState

	run        dataRunDialog
	sheet      dataSheetDialog
	folder     dataFolderDialog
	add        dataAddDialog
	edit       dataEditDialog
	rename     dataRenameDialog
	setRef     dataSetRefDialog
	removeOpen bool
	removeIDs  []string
	allChecked bool
	allowing   bool // trust_links in flight
}

func (p *dataPage) Show() {
	if q := qcFor(p.a); q != nil {
		q.ensureStats()
	}
}

// ---- sample state helpers

func dataStage(s model.Sample, name string) model.Stage {
	if st, ok := s.Stages[name]; ok && st.Status != "" {
		return st
	}
	return model.Stage{Status: "pending"}
}

func dataSampleDone(s model.Sample) bool { return dataStage(s, "index").Status == "succeeded" }

// activeTask is the newest queued or running task of a sample.
func (p *dataPage) activeTask(s model.Sample) (model.Task, bool) {
	var best model.Task
	found := false
	consider := func(id string) {
		if id == "" {
			return
		}
		if t, ok := p.a.Tasks[id]; ok && t.Active() && (!found || t.StartedAt > best.StartedAt) {
			best, found = t, true
		}
	}
	consider(p.runningFor[s.ID])
	for _, name := range dataStages {
		consider(s.Stages[name].TaskID)
	}
	return best, found
}

// resumeLabel names the samples the toolbar button resumes: failed ones are
// retried, interrupted or cancelled ones resumed.
func (p *dataPage) resumeLabel(problems []model.Sample) string {
	failed := 0
	for _, s := range problems {
		if st, _ := p.problem(s); st.Status == "failed" {
			failed++
		}
	}
	switch failed {
	case 0:
		return fmt.Sprintf("Resume interrupted (%d)", len(problems))
	case len(problems):
		return fmt.Sprintf("Retry failed (%d)", len(problems))
	}
	return fmt.Sprintf("Resume or retry (%d)", len(problems))
}

// failReason is the short error of the task behind a failed stage ("" when
// that task is not known in this session).
func (p *dataPage) failReason(st model.Stage) string {
	if st.Status != "failed" || st.TaskID == "" {
		return ""
	}
	return ShortError(p.a.Tasks[st.TaskID].ErrorText())
}

// problem is the first failed, interrupted or cancelled stage; a stage left
// running by a task that is no longer active was cut off (interrupted).
func (p *dataPage) problem(s model.Sample) (model.Stage, bool) {
	for _, name := range dataStages {
		st := dataStage(s, name)
		switch st.Status {
		case "failed", "interrupted", "cancelled":
			return st, true
		case "running", "queued":
			if t, ok := p.a.Tasks[st.TaskID]; st.TaskID == "" || !ok || !t.Active() {
				st.Status = "interrupted"
				return st, true
			}
		}
	}
	return model.Stage{}, false
}

// needsReference: the sample's reads cannot be mapped, it has no
// reference (sample_run refuses it); a .hyb sample is already mapped.
func (p *dataPage) needsReference(s model.Sample) bool {
	return s.Reads.Format != "hyb" && p.a.Project.Reference(s.ReferenceID) == nil
}

// withoutReference: the selected samples that need a reference, or with
// nothing selected all of them.
func (p *dataPage) withoutReference(samples, selected []model.Sample) []model.Sample {
	if len(selected) > 0 {
		samples = selected
	}
	var out []model.Sample
	for _, s := range samples {
		if p.needsReference(s) {
			out = append(out, s)
		}
	}
	return out
}

// withReference splits samples into those that can run and the names of
// those without a reference.
func (p *dataPage) withReference(samples []model.Sample) (ok []model.Sample, missing []string) {
	for _, s := range samples {
		if p.needsReference(s) {
			missing = append(missing, s.Label())
		} else {
			ok = append(ok, s)
		}
	}
	return ok, missing
}

// noReferenceText says that names were not started.
func noReferenceText(names []string, started bool) string {
	list := strings.Join(names, ", ")
	switch {
	case started && len(names) == 1:
		return list + " is left out: it has no reference. Use Set reference… in its row."
	case started:
		return list + " are left out: they have no reference. Use Set reference above the samples to set it for all of them."
	case len(names) == 1:
		return list + " has no reference. Use Set reference… in its row first."
	}
	return list + " have no reference. Use Set reference above the samples first."
}

func (p *dataPage) box(id string) *bool {
	b := p.checked[id]
	if b == nil {
		b = new(bool)
		p.checked[id] = b
	}
	return b
}

// selected: the checked samples, in table order.
func (p *dataPage) selected() []model.Sample {
	var out []model.Sample
	if p.a.Project == nil {
		return nil
	}
	for _, s := range p.a.Project.Samples {
		if b := p.checked[s.ID]; b != nil && *b {
			out = append(out, s)
		}
	}
	return out
}

func (p *dataPage) clearSelection() {
	for _, b := range p.checked {
		*b = false
	}
	p.allChecked = false
}

// ---- formatting

func dataBasename(path string) string {
	if path == "" {
		return "—"
	}
	parts := strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == '\\' })
	if len(parts) == 0 {
		return path
	}
	return parts[len(parts)-1]
}

// dataFormatBytes: 1024-based, as HD.formatBytes.
func dataFormatBytes(n int64) string {
	if n < 0 {
		return "—"
	}
	units := []string{"B", "KB", "MB", "GB", "TB"}
	size := float64(n)
	unit := 0
	for size >= 1024 && unit < len(units)-1 {
		size /= 1024
		unit++
	}
	switch {
	case unit == 0:
		return fmt.Sprintf("%d B", n)
	case size >= 100:
		return fmt.Sprintf("%.0f %s", size, units[unit])
	}
	return fmt.Sprintf("%.1f %s", size, units[unit])
}

// dataFormatCompact: 1.5 M, 224 k, 757 (HD.formatCompact).
func dataFormatCompact(n int64) string {
	switch {
	case n >= 10_000_000:
		return fmt.Sprintf("%.0f M", float64(n)/1e6)
	case n >= 1_000_000:
		return fmt.Sprintf("%.1f M", float64(n)/1e6)
	case n >= 10_000:
		return fmt.Sprintf("%.0f k", math.Round(float64(n)/1e3))
	}
	return FormatNumber(n)
}

func dataReplicate(v any) string {
	switch r := v.(type) {
	case nil:
		return "—"
	case float64:
		return strconv.FormatFloat(r, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}

// dataExactCount is the full count behind a compact one ("224 k").
func dataExactCount(records int64) string {
	return FormatNumber(records) + " hybrids"
}

func dataPlural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

func dataModeValue(label string) string {
	if label == dataStorageModes[1] {
		return "copied"
	}
	return "linked"
}

// stageLabel: the chip text of a stage status (HD.chip).
func dataStageLabel(status string) string {
	switch status {
	case "succeeded":
		return "done"
	case "skipped":
		return "—"
	case "":
		return "pending"
	}
	return status
}

func dataStageChip(c *ui.Context, name, status string) {
	t := c.Theme()
	b := ui.Badge(c, name+" "+dataStageLabel(status)).Tooltip(name + ": " + status)
	switch status {
	case "succeeded":
		b.Background(t.Success.Alpha(0.15)).TextColor(t.Success)
	case "failed", "interrupted", "cancelled":
		b.Background(t.Danger.Alpha(0.15)).TextColor(t.Danger)
	case "running", "queued":
		b.Background(t.Accent.Alpha(0.15)).TextColor(brandInk(t))
	case "skipped", "pending", "":
		b.TextColor(t.TextMuted)
	}
}

// dataInputChip marks a missing or changed input file.
func dataInputChip(c *ui.Context, item dataInputItem) {
	t := c.Theme()
	tip := item.Path
	if item.Detail != "" {
		tip += ": " + item.Detail
	}
	ui.Badge(c, item.Status).Background(t.Danger.Alpha(0.15)).TextColor(t.Danger).Tooltip(tip)
}

func dataRefName(r model.Reference) string { return nameOr(r.Label, r.ID) }

func (p *dataPage) refLabels() []string {
	var out []string
	for _, r := range p.a.Project.References {
		out = append(out, dataRefName(r))
	}
	return out
}

func (p *dataPage) refByLabel(label string) *model.Reference {
	for i, r := range p.a.Project.References {
		if dataRefName(r) == label {
			return &p.a.Project.References[i]
		}
	}
	return nil
}

func dataErrText(err error) string {
	if err == nil {
		return ""
	}
	return ShortError(err.Error())
}

// ---- view

func (p *dataPage) View(c *ui.Context) {
	a := p.a
	t := c.Theme()
	if a.Project != nil && p.checkedOpen != a.opened {
		// Files may have moved since the last session: mark them now, not
		// when a Resume fails again.
		p.checkedOpen, p.inputs, p.checkSummary = a.opened, nil, ""
		p.checkInputsQuiet()
	}
	if folder := a.pendingFolder; folder != "" && a.Project != nil {
		a.pendingFolder = "" // chosen on the start page with a new project
		p.scanFolder(folder)
	}
	if q := qcFor(a); q != nil {
		q.ensureStats()
	}
	ui.Column(c).Fill().MinWidth(0).Padding(24).Gap(16).Children(func() {
		ui.Row(c).Gap(8).Children(func() {
			ui.Column(c).Grow(1).Shrink(1).MinWidth(0).Children(func() {
				PageHeader(c, "Data", "References and samples of this project. Raw files are linked in place unless copied.")
			})
			if ui.Button(c, "Check inputs").Disabled(p.checking).Clicked() {
				p.runCheck(false)
			}
			if ui.Button(c, "Import sample sheet…").Clicked() {
				p.importSheet()
			}
			if ui.Button(c, "Import raw files…").Clicked() {
				p.importRaw()
			}
			if ui.PrimaryButton(c, "Import data folder…").Tooltip("Pick a folder; samples, replicates and references are matched from the file names").Clicked() {
				p.chooseFolder()
			}
		})
		if p.checkSummary != "" {
			ui.Text(c, p.checkSummary).FontSize(ts(c, 12)).TextColor(t.TextMuted)
		}
		p.foreignLinks(c)
		p.referencesCard(c)
		p.samplesCard(c)
	})
	p.runDialog(c)
	p.sheetDialog(c)
	p.folderDialog(c)
	p.addDialog(c)
	p.editDialog(c)
	p.setRefDialog(c)
	p.renameDialog(c)
	p.removeDialog(c)
}

// ---- references

func (p *dataPage) referencesCard(c *ui.Context) {
	a := p.a
	t := c.Theme()
	Card(c, "", func() {
		ui.Row(c).Gap(8).Children(func() {
			ui.Text(c, "References").FontSize(ts(c, 16)).Bold().Grow(1)
			if ui.Button(c, "Add reference…").Clicked() {
				p.addReference()
			}
		})
		refs := a.Project.References
		if len(refs) == 0 {
			ui.Text(c, "No reference yet. Add the FASTA the reads were (or will be) mapped to; sample sheets add theirs automatically.").
				TextColor(t.TextMuted)
			return
		}
		for _, r := range refs {
			r := r
			check, checked := p.inputs["reference:"+r.ID]
			ui.Row(c.Key("ref-" + r.ID)).Gap(12).AlignItems(ui.Center).Children(func() {
				ui.Text(c, dataRefName(r)).Bold().Width(120).SingleLine()
				ui.Text(c, dataBasename(r.Path)).Tooltip(r.Path).Grow(1).Shrink(1).MinWidth(0).SingleLine()
				seq := dataPlural(len(r.Sequences), "sequence", "sequences")
				if len(r.Sequences) == 1 {
					seq = r.Sequences[0].Name + " · " + FormatNumber(int64(r.Sequences[0].Length)) + " nt"
				}
				ui.Text(c, seq).TextColor(t.TextMuted).Shrink(1).MinWidth(0).SingleLine()
				ui.Badge(c, nameOr(r.Mode, "linked"))
				if checked && check.Status != "ok" {
					dataInputChip(c, check)
					if ui.Button(c, "Relink…").Clicked() {
						p.relink(check)
					}
				}
				if ui.Button(c, "Rename…").Tooltip("Change the reference's label").Clicked() {
					p.rename = dataRenameDialog{open: true, id: r.ID, label: dataRefName(r)}
				}
			})
		}
	})
}

func (p *dataPage) addReference() {
	a := p.a
	if a.Project == nil {
		return
	}
	path := a.Project.Path
	a.Go(func() func() {
		paths := PickFiles("Choose a reference FASTA", false)
		if len(paths) == 0 {
			return nil
		}
		result, err := a.B.ProjectOp(path, "add_reference", core.Obj{"source": paths[0], "mode": "linked"})
		return func() {
			if err != nil {
				a.Toast("Could not add the reference: %v", err)
				return
			}
			var r model.Reference
			_ = model.Decode(result["reference"], &r)
			name := nameOr(dataRefName(r), dataBasename(paths[0]))
			if existing, _ := result["existing"].(bool); existing {
				a.Toast("Reference already registered: %s", name)
			} else {
				a.Toast("Reference added: %s", name)
			}
			if p.add.open && p.add.reference == "" {
				p.add.reference = name
			}
			a.RefreshProject()
		}
	})
}

func (p *dataPage) renameDialog(c *ui.Context) {
	a := p.a
	t := c.Theme()
	d := &p.rename
	ui.Modal(c, &d.open, func() {
		ui.Column(c).Width(380).Gap(12).Children(func() {
			ui.Text(c, "Rename reference").FontSize(ts(c, 18)).Bold()
			Field(c, "Label", func() {
				ui.TextInput(c.Key("ref-label"), &d.label).Label("Label")
			})
			if d.status != "" {
				ui.Text(c, d.status).TextColor(t.Danger)
			}
			ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
				if ui.Button(c, "Cancel").Clicked() {
					d.open = false
				}
				label := strings.TrimSpace(d.label)
				if ui.PrimaryButton(c, "Save").Disabled(label == "").Clicked() {
					path, id := a.Project.Path, d.id
					a.Go(func() func() {
						_, err := a.B.ProjectOp(path, "update_reference", core.Obj{"reference_id": id, "label": label})
						return func() {
							if err != nil {
								d.status = err.Error()
								return
							}
							d.open = false
							a.RefreshProject()
						}
					})
				}
			})
		})
	})
}

// ---- samples

func (p *dataPage) samplesCard(c *ui.Context) {
	a := p.a
	t := c.Theme()
	samples := a.Project.Samples
	selected := p.selected()
	var problems, pending []model.Sample
	for _, s := range samples {
		_, active := p.activeTask(s)
		if _, bad := p.problem(s); bad && !active {
			problems = append(problems, s)
		}
		if !dataSampleDone(s) && !active {
			pending = append(pending, s)
		}
	}
	Card(c, "", func() {
		ui.Row(c).Gap(8).Children(func() {
			ui.Text(c, fmt.Sprintf("Samples (%d)", len(samples))).FontSize(ts(c, 16)).Bold()
			if len(samples) > 0 {
				all := len(selected) == len(samples)
				p.allChecked = all
				ui.Checkbox(c.Key("select-all"), &p.allChecked, "Select all").OnClick(func() {
					for _, s := range samples {
						*p.box(s.ID) = p.allChecked
					}
				})
			}
			ui.Spacer(c)
			if len(problems) > 0 {
				if ui.Button(c, p.resumeLabel(problems)).Clicked() {
					p.resumeSamples(problems)
				}
			}
			if noRef := p.withoutReference(samples, selected); len(noRef) > 0 {
				if ui.Button(c, fmt.Sprintf("Set reference (%d)…", len(noRef))).
					Tooltip("Choose one reference for the samples that have none").Clicked() {
					p.openSetRef(noRef)
				}
			}
			removeLabel := "Remove"
			if len(selected) > 0 {
				removeLabel = "Remove selected"
			}
			if ui.Button(c, removeLabel).Disabled(len(selected) == 0).Clicked() {
				p.removeIDs = nil
				for _, s := range selected {
					p.removeIDs = append(p.removeIDs, s.ID)
				}
				p.removeOpen = true
			}
			runLabel := fmt.Sprintf("Run all pending (%d)", len(pending))
			if len(selected) > 0 {
				runLabel = fmt.Sprintf("Run selected (%d)", len(selected))
			}
			if ui.PrimaryButton(c, runLabel).Disabled(len(selected) == 0 && len(pending) == 0).Clicked() {
				if len(selected) > 0 {
					p.runSamples(selected)
				} else {
					p.runSamples(pending)
				}
			}
		})
		if len(samples) == 0 {
			ui.Column(c).Gap(4).Padding(16, 0).Children(func() {
				ui.Text(c, "No samples yet.").Bold()
				ui.Text(c, "Next: click Import data folder… and pick the folder with your raw reads and reference FASTA: "+
					"samples, replicates and references are matched from the file names, and you review them before anything is imported. "+
					"Import raw files… adds single files; Import sample sheet… reads a TSV/CSV (name, condition, replicate, files, reference). "+
					"Then Run all pending makes the .hyb files.").
					TextColor(t.TextMuted)
			})
			return
		}
		p.samplesTable(c, samples)
	}).Grow(1).MinWidth(0)
}

func (p *dataPage) samplesTable(c *ui.Context, samples []model.Sample) {
	a := p.a
	stats := map[string]qcStats{}
	statsLoading := false
	if q := qcFor(a); q != nil {
		stats, statsLoading = q.stats, q.loading
	}
	cols := []ui.TableColumn{
		{Title: "", ID: "select", Width: 40, Fixed: true},
		{Title: "Sample", MinWidth: 130},
		{Title: "Condition", Width: 84},
		{Title: "Rep", Width: 50, Align: ui.End},
		{Title: "Raw file", Width: 136},
		{Title: "Stages", Width: 226},
		{Title: "Hybrids", Width: 70, Align: ui.End},
		{Title: "", ID: "actions", Width: 88},
	}
	p.table.Key = func(i int) any { return samples[i].ID }
	p.table.Label = func(i int) string { return samples[i].Label() }
	// The scroller keeps the columns' widths out of the page's minimum
	// width: a narrow window scrolls the table, not the page.
	ui.ScrollHorizontal(c).AlignItems(ui.Stretch).Grow(1).MinHeight(140).Children(func() { p.sampleRows(c, samples, cols, stats, statsLoading) })
}

func (p *dataPage) sampleRows(c *ui.Context, samples []model.Sample, cols []ui.TableColumn, stats map[string]qcStats, statsLoading bool) {
	t := c.Theme()
	ui.Table(c, &p.table, cols, len(samples), func(row, col int) {
		s := samples[row]
		task, active := p.activeTask(s)
		switch col {
		case 0:
			ui.Checkbox(c, p.box(s.ID), "").Label("Select " + s.Label())
		case 1:
			ui.Column(c).Gap(2).MinWidth(0).Children(func() {
				id := s.ID
				if brandLink(c, s.Label()).Label("Edit sample " + s.Label()).Tooltip("Edit sample").Clicked() {
					p.openEdit(id)
				}
				if s.GeneID != "" {
					ui.Text(c, s.GeneID).Tooltip(s.GeneID).FontSize(ts(c, 11)).TextColor(t.TextMuted).SingleLine()
				}
			})
		case 2:
			ui.Text(c, nameOr(s.Condition, "—")).SingleLine()
		case 3:
			ui.Text(c, dataReplicate(s.Replicate))
		case 4:
			p.fileCell(c, s)
		case 5:
			if active {
				ui.Column(c).Width(200).Gap(2).Children(func() { ProgressBar(c, task) })
				return
			}
			stage, bad := p.problem(s)
			reason := p.failReason(stage)
			ui.Column(c).Gap(2).Children(func() {
				ui.Row(c).Gap(4).Wrap().Children(func() {
					for _, name := range dataStages {
						status := dataStage(s, name).Status
						if (status == "running" || status == "queued") && bad {
							status = "interrupted"
						}
						dataStageChip(c, name, status)
					}
				})
				if p.needsReference(s) {
					id := s.ID
					ui.Row(c).Gap(6).Children(func() {
						ui.Text(c, "No reference").FontSize(ts(c, 11)).TextColor(c.Theme().Danger)
						if brandLink(c, "Set reference…").FontSize(ts(c, 11)).
							Tooltip("Choose the reference " + s.Label() + "'s reads are mapped to").Clicked() {
							p.openEdit(id)
						}
					})
				} else if reason != "" {
					ui.Text(c, reason).FontSize(ts(c, 11)).TextColor(c.Theme().Danger).SingleLine().
						Tooltip(reason + " — the full log is in the task drawer")
				}
			})
		case 6:
			label, exact := "—", ""
			if st, ok := stats[s.ID]; ok {
				label, exact = dataFormatCompact(st.Records), dataExactCount(st.Records)
			} else if s.IsReady() && statsLoading {
				label = "…"
			}
			if exact != "" {
				ui.Text(c, label).SingleLine().Tooltip(exact)
			} else {
				ui.Text(c, label).SingleLine()
			}
		case 7:
			p.rowAction(c, s, task, active)
		}
	}).Width(dataColumnsWidth(cols)).Grow(1)
}

// dataColumnsWidth: the columns' widths, a shared column at its MinWidth:
// the table's width in its scroller, which it grows to fill.
func dataColumnsWidth(cols []ui.TableColumn) float32 {
	var w float32
	for _, col := range cols {
		w += max(col.Width, col.MinWidth)
	}
	return w + 2
}

func (p *dataPage) fileCell(c *ui.Context, s model.Sample) {
	t := c.Theme()
	reads := s.Reads
	check, checked := p.inputs["sample:"+s.ID]
	ui.Column(c).Gap(2).MinWidth(0).Children(func() {
		ui.Text(c, dataBasename(reads.Path)).Tooltip(reads.Path).SingleLine()
		var meta []string
		for _, part := range []string{reads.Format, dataFormatBytes(reads.SizeBytes), nameOr(reads.Mode, "linked")} {
			if part != "" {
				meta = append(meta, part)
			}
		}
		ui.Text(c, strings.Join(meta, " · ")).FontSize(ts(c, 11)).TextColor(t.TextMuted).SingleLine()
		if checked && check.Status != "ok" {
			ui.Row(c).Gap(4).Children(func() {
				dataInputChip(c, check)
				if ui.Button(c, "Relink…").Clicked() {
					p.relink(check)
				}
			})
		}
	})
}

func (p *dataPage) rowAction(c *ui.Context, s model.Sample, task model.Task, active bool) {
	a := p.a
	id := s.ID
	switch {
	case active:
		if ui.Button(c, "Cancel").Tooltip("Cancel " + s.Label() + "'s run").Clicked() {
			a.CancelTask(task.TaskID)
		}
	case p.needsReference(s):
		ui.Button(c, "Run").Disabled(true).Tooltip("Set a reference first: reads are mapped to it")
	default:
		if _, bad := p.problem(s); bad {
			if ui.Button(c, "Resume").Clicked() {
				p.resumeSamples([]model.Sample{s})
			}
		} else if !dataSampleDone(s) {
			if ui.Button(c, "Run").Clicked() {
				p.runSamples([]model.Sample{s})
			}
		} else if ui.Button(c, "Explore").Clicked() {
			a.Selected.Key = "s:" + id
			a.Navigate("explore", nil)
		}
	}
}

// ---- run / resume

func (p *dataPage) runSamples(samples []model.Sample) {
	a := p.a
	var idle []model.Sample
	for _, s := range samples {
		if _, active := p.activeTask(s); !active {
			idle = append(idle, s)
		}
	}
	if len(idle) == 0 {
		a.Toast("Those samples are already running.")
		return
	}
	runnable, leftOut := p.withReference(idle)
	if len(runnable) == 0 {
		a.Toast("%s", noReferenceText(leftOut, false))
		return
	}
	var ids []string
	for _, s := range runnable {
		ids = append(ids, s.ID)
	}
	p.run = dataRunDialog{open: true, ids: ids, loading: true, leftOut: leftOut}
	path := a.Project.Path
	var inputs []core.PipelineInput
	for _, id := range ids {
		if s := a.Project.Sample(id); s != nil {
			inputs = append(inputs, core.PipelineInput{Format: s.Reads.Format, InputBytes: s.Reads.SizeBytes})
		}
	}
	a.Go(func() func() {
		result, err := a.B.ProjectOp(path, "disk_estimate", core.Obj{"sample_ids": ids, "include_completed": true})
		var estimate dataEstimate
		if err == nil {
			err = model.Decode(result, &estimate)
		}
		timing := a.B.EstimatePipelines(inputs)
		return func() {
			if a.Project == nil || a.Project.Path != path || !sameIDs(p.run.ids, ids) {
				return
			}
			p.run.loading = false
			p.run.time = &timing
			if err != nil {
				p.run.err = err.Error()
				return
			}
			p.run.estimate = &estimate
		}
	})
}

func sameIDs(x, y []string) bool { return strings.Join(x, "\x00") == strings.Join(y, "\x00") }

func (p *dataPage) runDialog(c *ui.Context) {
	a := p.a
	t := c.Theme()
	d := &p.run
	if !d.open {
		return
	}
	ui.Modal(c, &d.open, func() {
		ui.Column(c).Width(520).Gap(12).Children(func() {
			ui.Text(c, "Run "+dataPlural(len(d.ids), "sample", "samples")).FontSize(ts(c, 18)).Bold()
			var names []string
			for _, id := range d.ids {
				if s := a.Project.Sample(id); s != nil {
					names = append(names, s.Label())
				}
			}
			ui.Text(c, strings.Join(names, ", "))
			if len(d.leftOut) > 0 {
				ui.Text(c, noReferenceText(d.leftOut, true)).FontSize(ts(c, 12)).TextColor(t.Warning)
			}
			switch {
			case d.loading:
				ui.Row(c).Gap(8).Children(func() {
					ui.Spinner(c)
					ui.Text(c, "Estimating disk space…").TextColor(t.TextMuted)
				})
			case d.err != "":
				ui.Text(c, "Disk estimate unavailable: "+d.err).TextColor(t.Danger)
			case d.estimate != nil:
				e := d.estimate
				input := dataFormatBytes(e.Totals.Input)
				if e.Totals.Uncompressed != e.Totals.Input {
					input += " (" + dataFormatBytes(e.Totals.Uncompressed) + " uncompressed)"
				}
				ui.Column(c).Gap(4).Children(func() {
					for _, line := range [][2]string{{"Input", input}, {"Temporary peak", dataFormatBytes(e.Totals.TempPeak)},
						{"Results", dataFormatBytes(e.Totals.Output)}} {
						ui.Row(c).Gap(8).Children(func() {
							ui.Text(c, line[0]).TextColor(t.TextMuted).Width(130)
							ui.Text(c, line[1])
						})
					}
				})
				for _, v := range e.Volumes {
					text := fmt.Sprintf("%s needed for %s on %s, %s free.", dataFormatBytes(v.Required), v.Role, v.Path, dataFormatBytes(v.Free))
					if v.OK {
						ui.Text(c, text).FontSize(ts(c, 12)).TextColor(t.TextMuted)
					} else {
						ui.Text(c, "Not enough space: "+text).FontSize(ts(c, 12)).TextColor(t.Danger)
					}
				}
			}
			if e := d.time; e != nil && e.Seconds > 0 {
				ui.Row(c).Gap(8).Children(func() {
					ui.Text(c, "Estimated time").TextColor(t.TextMuted).Width(130)
					ui.Text(c, "about "+FormatDuration(e.Seconds)).Bold()
				})
				basis := fmt.Sprintf("From the speed measured on this computer (%d CPUs).", e.CPU)
				switch {
				case e.Measured == 0:
					basis = fmt.Sprintf("Rough: nothing measured on this computer yet (%d CPUs); the first finished sample calibrates it.", e.CPU)
				case e.Measured < e.Samples:
					basis = fmt.Sprintf("Partly measured on this computer (%d of %d samples' formats; %d CPUs).", e.Measured, e.Samples, e.CPU)
				}
				ui.Text(c, basis).FontSize(ts(c, 12)).TextColor(t.TextMuted)
			}
			ui.Text(c, "Each sample runs mapping → .hyb → analysis index as one task; tasks wait in the queue when the CPU / memory budget (Preferences) is used up. "+
				"While one sample maps, the next one already prepares its reads.").
				FontSize(12).TextColor(t.TextMuted)
			ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
				if ui.Button(c, "Cancel").Clicked() {
					d.open = false
				}
				label := "Start"
				if d.estimate != nil && !d.estimate.Fits {
					label = "Start anyway"
				}
				if ui.PrimaryButton(c, label).Disabled(d.loading).Clicked() {
					d.open = false
					p.startRuns(d.ids)
				}
			})
		})
	})
}

func (p *dataPage) startRuns(ids []string) {
	a := p.a
	var reqs []core.TaskStartRequest
	var labels, sampleIDs, names []string
	for _, id := range ids {
		s := a.Project.Sample(id)
		if s == nil {
			continue
		}
		sampleID := s.ID
		reqs = append(reqs, core.TaskStartRequest{Kind: "sample_pipeline", SampleID: &sampleID})
		labels = append(labels, "Pipeline · "+s.Label())
		sampleIDs = append(sampleIDs, sampleID)
		names = append(names, s.Label())
	}
	started, answered := 0, 0
	// In order, so the queue runs the samples as they are listed.
	a.StartTasksInOrder(reqs, labels, func(i int, t model.Task, err error) {
		answered++
		if err != nil {
			a.Toast("Could not start %s: %v", names[i], err)
		} else {
			started++
			p.runningFor[sampleIDs[i]] = t.TaskID
		}
		if answered == len(reqs) && started > 0 {
			a.Toast("Started %s.", dataPlural(started, "sample run", "sample runs"))
			p.clearSelection()
			a.RefreshProject()
		}
	})
}

// resumeSamples re-runs the stored task request (Python resumes from
// checkpoints); without a known task, it starts a fresh run.
func (p *dataPage) resumeSamples(samples []model.Sample) {
	a := p.a
	samples, leftOut := p.withReference(samples)
	if len(leftOut) > 0 {
		a.Toast("%s", noReferenceText(leftOut, len(samples) > 0))
	}
	for _, s := range samples {
		stage, _ := p.problem(s)
		sampleID, name := s.ID, s.Label()
		label := "Pipeline · " + name
		if stage.TaskID == "" {
			a.StartTask(core.TaskStartRequest{Kind: "sample_pipeline", SampleID: &sampleID}, label, func(t model.Task, err error) {
				if err != nil {
					a.Toast("Could not resume %s: %v", name, err)
					return
				}
				p.runningFor[sampleID] = t.TaskID
			})
			continue
		}
		a.ResumeTaskThen(stage.TaskID, label, func(t model.Task, err error) {
			if err != nil {
				a.Toast("Could not resume %s: %v", name, err)
				return
			}
			p.runningFor[sampleID] = t.TaskID
			a.RefreshProject()
		})
	}
}

// ---- remove

func (p *dataPage) removeDialog(c *ui.Context) {
	a := p.a
	if !p.removeOpen {
		return
	}
	var names []string
	for _, id := range p.removeIDs {
		if s := a.Project.Sample(id); s != nil {
			names = append(names, s.Label())
		}
	}
	message := "Remove " + strings.Join(names, ", ") + " from the project? Linked raw files are not touched; results in the project stay on disk."
	if ui.AlertDialog(c, &p.removeOpen, "Remove samples", message, "Cancel", "Remove") == 1 {
		ids := append([]string(nil), p.removeIDs...)
		path := a.Project.Path
		a.Go(func() func() {
			var errs []string
			for _, id := range ids {
				if _, err := a.B.ProjectOp(path, "remove_sample", core.Obj{"sample_id": id}); err != nil {
					errs = append(errs, id+": "+err.Error())
				}
			}
			return func() {
				for _, e := range errs {
					a.Toast("Could not remove %s", e)
				}
				if removed := len(ids) - len(errs); removed > 0 {
					a.Toast("Removed %s.", dataPlural(removed, "sample", "samples"))
				}
				for _, id := range ids {
					delete(p.checked, id)
				}
				p.allChecked = false
				a.RefreshProject()
			}
		})
	}
}

// ---- edit sample

func (p *dataPage) openEdit(id string) {
	s := p.a.Project.Sample(id)
	if s == nil {
		return
	}
	reference := ""
	if r := p.a.Project.Reference(s.ReferenceID); r != nil {
		reference = dataRefName(*r)
	}
	replicate := ""
	if s.Replicate != nil {
		replicate = dataReplicate(s.Replicate)
	}
	p.edit = dataEditDialog{open: true, id: id, name: s.Label(), condition: s.Condition, replicate: replicate,
		reference: reference, gene: s.GeneID}
}

// dataParseReplicate: "" is none; otherwise a positive whole number.
func dataParseReplicate(text string) (any, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, true
	}
	n, err := strconv.Atoi(text)
	if err != nil || n < 1 {
		return nil, false
	}
	return n, true
}

func dataNullable(text string) any {
	if text = strings.TrimSpace(text); text == "" {
		return nil
	}
	return text
}

// geneOptions: "—" (none / reference default) and the sequences of the
// chosen reference, plus the current value when it is not among them.
func (p *dataPage) geneOptions(refLabel, current, none string) []string {
	options := []string{none}
	found := current == "" || current == none
	if r := p.refByLabel(refLabel); r != nil {
		for _, s := range r.Sequences {
			options = append(options, s.Name)
			found = found || s.Name == current
		}
	}
	if !found {
		options = append(options, current)
	}
	return options
}

func (p *dataPage) editDialog(c *ui.Context) {
	a := p.a
	t := c.Theme()
	d := &p.edit
	if !d.open {
		return
	}
	s := a.Project.Sample(d.id)
	if s == nil {
		d.open = false
		return
	}
	ui.Modal(c, &d.open, func() {
		ui.Column(c).Width(460).Gap(12).Children(func() {
			ui.Text(c, "Sample "+s.Label()).FontSize(ts(c, 18)).Bold()
			Field(c, "Name", func() { ui.TextInput(c.Key("edit-name"), &d.name).Label("Name") })
			ui.Row(c).Gap(12).Children(func() {
				ui.Column(c).Grow(1).Children(func() {
					Field(c, "Condition", func() {
						ui.TextInput(c.Key("edit-condition"), &d.condition).Placeholder("e.g. AFR").Label("Condition")
					})
				})
				ui.Column(c).Width(110).Children(func() {
					Field(c, "Replicate", func() {
						ui.TextInput(c.Key("edit-replicate"), &d.replicate).Placeholder("—").Label("Replicate")
					})
				})
			})
			refs := append([]string{"—"}, p.refLabels()...)
			if d.reference == "" {
				d.reference = "—"
			}
			Field(c, "Reference", func() {
				ui.Select(c.Key("edit-reference"), &d.reference, refs).Label("Reference")
			})
			if d.gene == "" {
				d.gene = "—"
			}
			Field(c, "Gene", func() {
				ui.Select(c.Key("edit-gene"), &d.gene, p.geneOptions(d.reference, d.gene, "—")).Label("Gene")
			})
			ui.Text(c, s.Reads.Path).FontSize(ts(c, 12)).TextColor(t.TextMuted)
			if d.status != "" {
				ui.Text(c, d.status).TextColor(t.Danger)
			}
			ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
				if ui.Button(c, "Cancel").Clicked() {
					d.open = false
				}
				if ui.PrimaryButton(c, "Save").Disabled(d.busy || strings.TrimSpace(d.name) == "").Clicked() {
					p.saveEdit()
				}
			})
		})
	})
}

func (p *dataPage) saveEdit() {
	a := p.a
	d := &p.edit
	replicate, ok := dataParseReplicate(d.replicate)
	if !ok {
		d.status = "Replicate must be a positive whole number."
		return
	}
	var referenceID any
	if r := p.refByLabel(d.reference); r != nil {
		referenceID = r.ID
	}
	gene := d.gene
	if gene == "—" {
		gene = ""
	}
	changes := core.Obj{"name": strings.TrimSpace(d.name), "condition": dataNullable(d.condition), "replicate": replicate,
		"reference_id": referenceID, "gene_id": dataNullable(gene)}
	path, id := a.Project.Path, d.id
	d.busy, d.status = true, ""
	a.Go(func() func() {
		_, err := a.B.ProjectOp(path, "update_sample", core.Obj{"sample_id": id, "changes": changes})
		return func() {
			d.busy = false
			if err != nil {
				d.status = err.Error()
				return
			}
			d.open = false
			a.RefreshProject()
		}
	})
}

// ---- set one reference for several samples

func (p *dataPage) openSetRef(samples []model.Sample) {
	d := dataSetRefDialog{open: true}
	for _, s := range samples {
		d.ids = append(d.ids, s.ID)
	}
	if refs := p.refLabels(); len(refs) > 0 {
		d.reference = refs[0]
	}
	p.setRef = d
}

func (p *dataPage) setRefDialog(c *ui.Context) {
	a := p.a
	t := c.Theme()
	d := &p.setRef
	if !d.open {
		return
	}
	var names []string
	for _, id := range d.ids {
		if s := a.Project.Sample(id); s != nil {
			names = append(names, s.Label())
		}
	}
	refs := p.refLabels()
	ui.Modal(c, &d.open, func() {
		ui.Column(c).Width(460).Gap(12).Children(func() {
			ui.Text(c, "Set the reference of "+dataPlural(len(names), "sample", "samples")).FontSize(ts(c, 18)).Bold()
			ui.Text(c, strings.Join(names, ", ")).FontSize(ts(c, 12)).TextColor(t.TextMuted)
			if len(refs) == 0 {
				ui.Text(c, "The project has no reference yet. Add one under References first.").TextColor(t.Warning)
			} else {
				Field(c, "Reference", func() {
					ui.Select(c.Key("setref-reference"), &d.reference, refs).Label("Reference")
				})
				ui.Text(c, "Their reads are mapped to it when they run.").FontSize(ts(c, 12)).TextColor(t.TextMuted)
			}
			if d.status != "" {
				ui.Text(c, d.status).TextColor(t.Danger)
			}
			ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
				if ui.Button(c, "Cancel").Disabled(d.busy).Clicked() {
					d.open = false
				}
				if ui.PrimaryButton(c, "Set reference").Disabled(d.busy || p.refByLabel(d.reference) == nil || len(names) == 0).Clicked() {
					p.saveSetRef()
				}
			})
		})
	})
}

// saveSetRef updates each sample; the ones that fail stay in the dialog
// with the reason, the others are done.
func (p *dataPage) saveSetRef() {
	a := p.a
	d := &p.setRef
	r := p.refByLabel(d.reference)
	if r == nil {
		return
	}
	path, refID, ids := a.Project.Path, r.ID, append([]string(nil), d.ids...)
	labels := map[string]string{}
	for _, id := range ids {
		if s := a.Project.Sample(id); s != nil {
			labels[id] = s.Label()
		}
	}
	d.busy, d.status = true, ""
	a.Go(func() func() {
		var done, failed, reasons []string
		for _, id := range ids {
			_, err := a.B.ProjectOp(path, "update_sample", core.Obj{"sample_id": id, "changes": core.Obj{"reference_id": refID}})
			if err != nil {
				failed = append(failed, id)
				reasons = append(reasons, nameOr(labels[id], id)+": "+dataErrText(err))
			} else {
				done = append(done, nameOr(labels[id], id))
			}
		}
		return func() {
			d.busy = false
			if len(done) > 0 {
				a.RefreshProject()
			}
			if len(failed) == 0 {
				d.open = false
				a.Toast("Set the reference of %s to %s.", dataPlural(len(done), "sample", "samples"), d.reference)
				return
			}
			d.ids = failed
			d.status = "Could not set it for " + strings.Join(reasons, "; ")
			if len(done) > 0 {
				d.status = "Set the reference of " + strings.Join(done, ", ") + ". " + d.status
			}
		}
	})
}

// ---- import raw files (add_sample per file)

var dataReadSuffix = regexp.MustCompile(`(?i)\.(fastq|fq|fasta|fa|sam|hyb)(\.gz)?$`)

func (p *dataPage) importRaw() {
	a := p.a
	a.Go(func() func() {
		paths := PickFiles("Choose raw read files (FASTQ, FASTA, .gz, SAM or .hyb)", true)
		if len(paths) == 0 {
			return nil
		}
		return func() {
			if a.Project == nil {
				return
			}
			names := make([]string, len(paths))
			for i, path := range paths {
				names[i] = dataReadSuffix.ReplaceAllString(filepath.Base(path), "")
			}
			reference := ""
			if r := a.Project.Reference(a.Selected.ReferenceID); r != nil {
				reference = dataRefName(*r)
			} else if len(a.Project.References) > 0 {
				reference = dataRefName(a.Project.References[0])
			}
			p.add = dataAddDialog{open: true, paths: paths, names: names, reference: reference, mode: dataStorageModes[0]}
		}
	})
}

func (p *dataPage) addDialog(c *ui.Context) {
	t := c.Theme()
	d := &p.add
	if !d.open {
		return
	}
	ui.Modal(c, &d.open, func() {
		ui.Column(c).Width(620).Gap(12).Children(func() {
			ui.Text(c, "Import "+dataPlural(len(d.paths), "file", "files")).FontSize(ts(c, 18)).Bold()
			ui.Text(c, "Each file becomes one sample. Replicates are numbered in the order below, after any existing replicates of the condition unless you give the first one.").
				FontSize(12).TextColor(t.TextMuted)
			ui.Row(c).Gap(12).AlignItems(ui.End).Children(func() {
				ui.Column(c).Grow(1).Children(func() {
					Field(c, "Reference", func() {
						refs := p.refLabels()
						if len(refs) == 0 {
							ui.Text(c, "Add a reference first").TextColor(t.TextMuted)
							return
						}
						ui.Select(c.Key("add-reference"), &d.reference, refs).Label("Reference")
					})
				})
				if ui.Button(c, "Add…").Tooltip("Add a reference FASTA").Clicked() {
					p.addReference()
				}
			})
			ui.Row(c).Gap(12).Children(func() {
				ui.Column(c).Grow(1).Children(func() {
					Field(c, "Condition", func() {
						ui.TextInput(c.Key("add-condition"), &d.condition).Placeholder("e.g. AFR").Label("Condition")
					})
				})
				ui.Column(c).Width(130).Children(func() {
					Field(c, "First replicate", func() {
						ui.TextInput(c.Key("add-replicate"), &d.replicate).Placeholder("auto").Label("First replicate")
					})
				})
			})
			ui.Row(c).Gap(12).Children(func() {
				ui.Column(c).Grow(1).Basis(0).Children(func() {
					if d.gene == "" {
						d.gene = "Reference default"
					}
					Field(c, "Gene", func() {
						ui.Select(c.Key("add-gene"), &d.gene, p.geneOptions(d.reference, d.gene, "Reference default")).Label("Gene")
					})
				})
				ui.Column(c).Grow(1).Basis(0).Children(func() {
					Field(c, "Storage", func() {
						ui.Select(c.Key("add-mode"), &d.mode, dataStorageModes).Label("Storage")
					})
				})
			})
			ui.Scroll(c).MaxHeight(220).Gap(6).Children(func() {
				for i, path := range d.paths {
					ui.Row(c.Key(fmt.Sprintf("add-file-%d", i))).Gap(8).AlignItems(ui.Center).Children(func() {
						ui.Text(c, fmt.Sprint(i+1)).Width(20).TextColor(t.TextMuted)
						ui.TextInput(c.Key("name"), &d.names[i]).Width(180).Label("Sample name for " + filepath.Base(path))
						ui.Text(c, path).Tooltip(path).FontSize(ts(c, 12)).TextColor(t.TextMuted).Grow(1).Shrink(1).MinWidth(0).SingleLine()
					})
				}
			})
			if d.status != "" {
				ui.Text(c, d.status).TextColor(t.Danger)
			}
			ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
				if ui.Button(c, "Cancel").Disabled(d.busy).Clicked() {
					d.open = false
				}
				if ui.PrimaryButton(c, "Import").Disabled(d.busy).Clicked() {
					p.addSamples()
				}
			})
		})
	})
}

func (p *dataPage) addSamples() {
	a := p.a
	d := &p.add
	r := p.refByLabel(d.reference)
	if r == nil {
		d.status = "Choose the reference for these samples (needed for mapping)."
		return
	}
	first, ok := dataParseReplicate(d.replicate)
	if !ok {
		d.status = "The first replicate must be a positive whole number."
		return
	}
	condition := strings.TrimSpace(d.condition)
	start := 1
	if n, given := first.(int); given {
		start = n
	} else if condition != "" {
		// Continue the replicate numbering of an existing condition.
		for _, s := range a.Project.Samples {
			if s.Condition != condition {
				continue
			}
			if rep, ok := s.Replicate.(float64); ok && int(rep) >= start {
				start = int(rep) + 1
			}
		}
	}
	gene := d.gene
	if gene == "Reference default" {
		gene = ""
	}
	var payloads []core.Obj
	for i, path := range d.paths {
		payloads = append(payloads, core.Obj{"source": path, "name": dataNullable(d.names[i]), "condition": dataNullable(condition),
			"replicate": start + i, "reference_id": r.ID, "gene_id": dataNullable(gene), "mode": dataModeValue(d.mode)})
	}
	path := a.Project.Path
	d.busy, d.status = true, "Adding…"
	a.Go(func() func() {
		added := 0
		var errs []string
		for _, payload := range payloads {
			if _, err := a.B.ProjectOp(path, "add_sample", payload); err != nil {
				errs = append(errs, filepath.Base(payload["source"].(string))+": "+err.Error())
			} else {
				added++
			}
		}
		return func() {
			d.busy = false
			a.RefreshProject()
			if len(errs) > 0 {
				d.status = fmt.Sprintf("Added %d; %d failed:\n%s", added, len(errs), strings.Join(errs, "\n"))
				return
			}
			d.open, d.status = false, ""
			a.Toast("Added %s.", dataPlural(added, "sample", "samples"))
		}
	})
}

// ---- sample sheet

func (p *dataPage) importSheet() {
	a := p.a
	path := a.Project.Path
	a.Go(func() func() {
		paths := PickFiles("Choose a sample sheet (TSV or CSV)", false)
		if len(paths) == 0 {
			return nil
		}
		sheet := paths[0]
		result, err := a.B.ProjectOp(path, "import_sample_sheet", core.Obj{"sheet": sheet, "dry_run": true})
		var rows []dataSheetRow
		var refs []string
		if err == nil {
			err = model.Decode(result["samples"], &rows)
			_ = model.Decode(result["references"], &refs)
		}
		return func() {
			if a.Project == nil || a.Project.Path != path {
				return
			}
			p.sheet = dataSheetDialog{sheet: sheet, mode: dataStorageModes[0]}
			if err != nil {
				p.sheet.problems = err.Error()
				p.sheet.problemsOpen = true
				return
			}
			p.sheet.rows, p.sheet.references, p.sheet.open = rows, len(refs), true
		}
	})
}

func (p *dataPage) sheetDialog(c *ui.Context) {
	t := c.Theme()
	d := &p.sheet
	if d.problemsOpen {
		ui.Modal(c, &d.problemsOpen, func() {
			ui.Column(c).Width(560).Gap(12).Children(func() {
				ui.Text(c, "Sample sheet problems").FontSize(ts(c, 18)).Bold()
				ui.Text(c, dataBasename(d.sheet)+" cannot be imported:")
				ui.Scroll(c).MaxHeight(260).Padding(8).Radius(6).Background(t.Surface).Children(func() {
					for _, line := range strings.Split(d.problems, "; ") {
						ui.Text(c, line).FontSize(ts(c, 12)).TextColor(t.Danger)
					}
				})
				ui.Text(c, "Expected columns: name, condition (or dataset/group), replicate, files (several files separated by ';' become replicates), reference, optional gene_id. Relative paths are resolved from the sheet's folder.").
					FontSize(12).TextColor(t.TextMuted)
				ui.Row(c).Justify(ui.End).Children(func() {
					if ui.PrimaryButton(c, "Close").Clicked() {
						d.problemsOpen = false
					}
				})
			})
		})
	}
	if !d.open {
		return
	}
	ui.Modal(c, &d.open, func() {
		ui.Column(c).Width(720).Gap(12).Children(func() {
			ui.Text(c, "Import "+dataBasename(d.sheet)).FontSize(ts(c, 18)).Bold()
			ui.Text(c, fmt.Sprintf("%s, %d reference(s). Nothing has been imported yet.", dataPlural(len(d.rows), "sample", "samples"), d.references)).
				TextColor(t.TextMuted)
			cols := []ui.TableColumn{{Title: "Name", MinWidth: 100}, {Title: "Condition", Width: 86}, {Title: "Rep", Width: 52, Align: ui.End},
				{Title: "Format", Width: 70}, {Title: "File", Width: 190}, {Title: "Reference", Width: 120}}
			rows := d.rows
			d.table.Label = func(i int) string { return rows[i].Name }
			height := float32(36*len(rows) + 40)
			if height > 280 {
				height = 280
			}
			ui.Table(c, &d.table, cols, len(rows), func(row, col int) {
				r := rows[row]
				switch col {
				case 0:
					ui.Text(c, r.Name).SingleLine()
				case 1:
					ui.Text(c, nameOr(r.Condition, "—")).SingleLine()
				case 2:
					ui.Text(c, dataReplicate(r.Replicate))
				case 3:
					ui.Text(c, r.Format)
				case 4:
					ui.Text(c, dataBasename(r.Path)).Tooltip(r.Path).SingleLine()
				case 5:
					ref := "—"
					if r.Reference != "" {
						ref = dataBasename(r.Reference)
					}
					ui.Text(c, ref).Tooltip(r.Reference).SingleLine()
				}
			}).Height(height).Border(1, t.Border).Radius(6)
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, "Storage").TextColor(t.TextMuted)
				ui.Select(c.Key("sheet-mode"), &d.mode, dataStorageModes).Label("Storage").Width(260)
			})
			if d.status != "" {
				ui.Text(c, d.status).TextColor(t.TextMuted)
			}
			ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
				if ui.Button(c, "Cancel").Disabled(d.busy).Clicked() {
					d.open = false
				}
				if ui.PrimaryButton(c, "Import "+dataPlural(len(d.rows), "sample", "samples")).Disabled(d.busy).Clicked() {
					p.confirmSheet()
				}
			})
		})
	})
}

func (p *dataPage) confirmSheet() {
	a := p.a
	d := &p.sheet
	mode := dataModeValue(d.mode)
	path, sheet := a.Project.Path, d.sheet
	d.busy, d.status = true, "Importing (fingerprinting files)…"
	a.Go(func() func() {
		result, err := a.B.ProjectOp(path, "import_sample_sheet", core.Obj{"sheet": sheet, "mode": mode})
		return func() {
			d.busy = false
			if err != nil {
				d.status = "Import failed: " + err.Error()
				return
			}
			var added, skipped []any
			_ = model.Decode(result["samples"], &added)
			_ = model.Decode(result["skipped"], &skipped)
			message := fmt.Sprintf("Imported %s", dataPlural(len(added), "sample", "samples"))
			if len(skipped) > 0 {
				message += fmt.Sprintf(", %d already in the project", len(skipped))
			}
			a.Toast("%s.", message)
			d.open, d.status = false, ""
			a.RefreshProject()
		}
	})
}

// ---- files linked on another computer (F5)

// dataForeignShown is how many such files the warning lists by name.
const dataForeignShown = 8

// foreignLinks warns about files the project names outside its folder that
// were not linked on this computer: Python refuses to open them until the
// user allows them here.
func (p *dataPage) foreignLinks(c *ui.Context) {
	a := p.a
	links := a.Project.UntrustedLinks
	if len(links) == 0 {
		return
	}
	t := c.Theme()
	title := fmt.Sprintf("%d files outside this project's folder were not linked on this computer", len(links))
	if len(links) == 1 {
		title = "1 file outside this project's folder was not linked on this computer"
	}
	ui.Column(c.Key("data-foreign")).Gap(6).Padding(12, 14).Radius(8).Border(1, t.Warning).Background(t.Warning.Alpha(0.08)).Children(func() {
		ui.Text(c, title).Bold()
		ui.Text(c, "The project may come from another computer. RNAxRay does not open these files until you allow them; "+
			"allow them only if you trust where the project came from, or use Relink to point to your own copies.").FontSize(ts(c, 12))
		for i, link := range links {
			if i == dataForeignShown {
				ui.Text(c, fmt.Sprintf("and %d more", len(links)-dataForeignShown)).FontSize(ts(c, 12)).TextColor(t.TextMuted)
				break
			}
			ui.Text(c, link.Path).FontSize(ts(c, 12)).Font("monospace").SingleLine().Tooltip(strings.Join(link.UsedBy, ", "))
		}
		ui.Row(c).Justify(ui.End).Children(func() {
			if ui.Button(c, "Allow these files").Disabled(p.allowing).Clicked() {
				p.allowLinks(links)
			}
		})
	})
}

func (p *dataPage) allowLinks(links []model.UntrustedLink) {
	a := p.a
	path := a.Project.Path
	paths := make([]any, len(links))
	for i, link := range links {
		paths[i] = link.Path
	}
	p.allowing = true
	a.Go(func() func() {
		_, err := a.B.ProjectOp(path, "trust_links", core.Obj{"paths": paths})
		return func() {
			p.allowing = false
			if a.Project == nil || a.Project.Path != path {
				return
			}
			if err != nil {
				a.Toast("Could not allow the files: %s", dataErrText(err))
				return
			}
			a.Toast("Allowed %s.", dataPlural(len(paths), "file", "files"))
			a.RefreshProject()
		}
	})
}

// ---- check inputs and relink

// checkInputsQuiet checks on open: no toast, and a summary only when
// something needs a look (or the check could not run).
func (p *dataPage) checkInputsQuiet() { p.runCheck(true) }

func (p *dataPage) runCheck(quiet bool) {
	a := p.a
	path := a.Project.Path
	p.checkSeq++
	seq := p.checkSeq
	if !quiet {
		p.checking = true
	}
	a.Go(func() func() {
		result, err := a.B.ProjectOp(path, "check_inputs", nil)
		var items []dataInputItem
		var noReference []string
		if err == nil {
			err = model.Decode(result["items"], &items)
		}
		if err == nil && result["no_reference"] != nil {
			err = model.Decode(result["no_reference"], &noReference)
		}
		return func() {
			if !quiet {
				p.checking = false
			}
			if seq != p.checkSeq || a.Project == nil || a.Project.Path != path {
				return
			}
			if err != nil {
				if quiet {
					p.checkSummary = "Could not check the input files: " + dataErrText(err)
					return
				}
				a.ToastAs("check-inputs", "Check failed: %s", dataErrText(err))
				return
			}
			p.inputs = map[string]dataInputItem{}
			count := map[string]int{}
			for _, item := range items {
				p.inputs[item.Kind+":"+item.ID] = item
				count[item.Status]++
			}
			p.checkSummary = fmt.Sprintf("Inputs checked: %d ok, %d missing, %d changed.", count["ok"], count["missing"], count["changed"])
			if n := count["unconfirmed"]; n > 0 {
				p.checkSummary += fmt.Sprintf(" %d not opened (linked on another computer).", n)
			}
			if n := len(noReference); n > 0 {
				p.checkSummary += " " + dataPlural(n, "sample has", "samples have") + " no reference."
			}
			if quiet {
				if count["missing"]+count["changed"]+count["unconfirmed"]+len(noReference) == 0 {
					p.checkSummary = ""
				}
				return
			}
			switch {
			case count["missing"] > 0 || count["changed"] > 0:
				a.ToastAs("check-inputs", "%d missing, %d changed. Use Relink on the marked rows.", count["missing"], count["changed"])
			case len(noReference) > 0:
				a.ToastAs("check-inputs", "%s before running.", dataPlural(len(noReference), "sample needs a reference", "samples need a reference"))
			default:
				a.ToastAs("check-inputs", "All %d input files are present and unchanged.", len(items))
			}
		}
	})
}

func (p *dataPage) relink(item dataInputItem) {
	a := p.a
	path := a.Project.Path
	a.Go(func() func() {
		paths := PickFiles("Locate "+dataBasename(item.Path), false)
		if len(paths) == 0 {
			return nil
		}
		var err error
		if item.Kind == "reference" {
			_, err = a.B.ProjectOp(path, "update_reference", core.Obj{"reference_id": item.ID, "source": paths[0]})
		} else {
			_, err = a.B.ProjectOp(path, "update_sample", core.Obj{"sample_id": item.ID, "changes": core.Obj{"reads_path": paths[0]}})
		}
		return func() {
			if err != nil {
				a.Toast("Relink failed: %s", dataErrText(err))
				return
			}
			delete(p.inputs, item.Kind+":"+item.ID)
			a.Toast("Relinked %s.", dataBasename(paths[0]))
			a.RefreshProject()
		}
	})
}
