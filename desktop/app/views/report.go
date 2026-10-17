package views

// ⑥ Report: a project-level summary assembled from the backend each time
// the page shows (manifest, references, samples with their index counts,
// conditions, differential tests with their strongest interactions, and
// structures), and "Export report…": the same sections as one
// self-contained HTML file with inline SVG figures (report_html.go).

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
	"rnaxraydesktop/widgets"
)

func init() {
	RegisterPageFactory("report", func(a *App) Page { return &reportPage{a: a} })
}

// reportAppVersion is the running app's version ("" in development).
var reportAppVersion = func() string { return mygo.App.Version() }

type reportPage struct {
	a       *App
	project string
	data    *reportData
	loading bool
	again   bool // Show ran while loading
}

func (p *reportPage) Show() { p.load() }

// reportInput is what the report reads from the window's state, copied on
// the main thread.
type reportInput struct {
	project model.Project
	runtime string
	now     time.Time
}

func (p *reportPage) load() {
	a := p.a
	if a.Project == nil {
		return
	}
	if p.loading {
		p.again = true
		return
	}
	if p.project != a.Project.Path {
		p.project, p.data = a.Project.Path, nil
	}
	in := reportInput{project: *a.Project, runtime: a.start.runtime, now: time.Now()}
	path := a.Project.Path
	backend := a.B
	p.loading = true
	a.Go(func() func() {
		d := gatherReport(backend, in)
		return func() {
			p.loading = false
			if a.Project == nil || a.Project.Path != path {
				return
			}
			p.data = d
			if p.again {
				p.again = false
				p.load()
			}
		}
	})
}

// ---- assembling (off the main thread)

// reportManifest reads project.json (read-only); the bridge's open_project
// answers when the file cannot be read directly.
func reportManifest(b core.Backend, path string) map[string]any {
	if raw, err := os.ReadFile(filepath.Join(path, "project.json")); err == nil {
		var manifest map[string]any
		if json.Unmarshal(raw, &manifest) == nil {
			return manifest
		}
	}
	opened, err := b.OpenProject(path)
	if err != nil {
		return nil
	}
	manifest, _ := opened["manifest"].(map[string]any)
	return manifest
}

type reportStructureEntry struct {
	structureEntry
	Summary struct {
		Pairs           int      `json:"pairs"`
		PseudoknotPairs int      `json:"pseudoknot_pairs"`
		Energy          *float64 `json:"energy"`
		Length          int      `json:"length"`
	} `json:"summary"`
}

func gatherReport(b core.Backend, in reportInput) *reportData {
	pr := &in.project
	d := &reportData{Name: pr.Name, Path: pr.Path, Description: pr.Description, References: pr.References,
		AppVersion: reportAppVersion(), Runtime: strings.TrimPrefix(in.runtime, "Runtime: "), Generated: in.now.Format("2006-01-02 15:04")}
	if manifest := reportManifest(b, pr.Path); manifest != nil {
		d.Created, _ = manifest["created_at"].(string)
		d.Updated, _ = manifest["updated_at"].(string)
		if app, ok := manifest["application"].(map[string]any); ok {
			d.CreatedWith = strings.TrimSpace(fmt.Sprintf("%s %s", str(app["name"]), str(app["version"])))
		}
	}
	labels := map[string]string{}
	for _, s := range pr.Samples {
		labels[s.ID] = s.Label()
	}
	label := func(id string) string { return nameOr(labels[id], id) }

	// Samples and their index counts (one analysis_summary for all).
	var ready []string
	for _, s := range pr.Samples {
		if s.IsReady() {
			ready = append(ready, s.ID)
		}
	}
	counts := map[string]*qcStats{}
	if len(ready) > 0 {
		result, err := b.Query(pr.Path, "analysis_summary", core.Obj{"sample_ids": ready})
		var parts []qcStats
		if err == nil {
			object, _ := result.(map[string]any)
			err = model.Decode(object["indexes"], &parts)
		}
		if err != nil {
			d.Notes = append(d.Notes, "Could not read the samples' counts: "+err.Error())
		}
		for i := range parts {
			if i < len(ready) {
				counts[ready[i]] = &parts[i]
			}
		}
	}
	for _, s := range pr.Samples {
		rep := ""
		if s.Replicate != nil {
			rep = dataReplicate(s.Replicate)
		}
		d.Samples = append(d.Samples, reportSample{ID: s.ID, Label: s.Label(), Condition: s.Condition, Replicate: rep,
			Reads: s.Reads.Path, Format: s.Reads.Format, Stages: s.StageSummary, Ready: s.IsReady(), Counts: counts[s.ID]})
	}
	d.Inputs, d.Settings = reportProvenance(pr)
	for _, c := range pr.Conditions {
		rc := reportCondition{Name: c.Name}
		var parts []qcStats
		for _, id := range c.SampleIDs {
			rc.Samples = append(rc.Samples, label(id))
			if s := counts[id]; s != nil {
				parts = append(parts, *s)
			}
			if s := pr.Sample(id); s != nil && s.IsReady() {
				rc.Analysed++
			}
		}
		if len(parts) > 0 {
			merged := qcMerge(parts)
			rc.Counts = &merged
		}
		d.Conditions = append(d.Conditions, rc)
	}

	// Differential tests.
	if listed, err := b.ProjectOp(pr.Path, "list_comparisons", nil); err != nil {
		d.Notes = append(d.Notes, "Could not list the differential tests: "+err.Error())
	} else {
		var entries []comparisonEntry
		_ = model.Decode(listed["comparisons"], &entries)
		for _, e := range entries {
			d.Tests = append(d.Tests, reportReadTest(b, pr, e, label))
		}
	}

	// Structures.
	if listed, err := b.ProjectOp(pr.Path, "list_structures", nil); err != nil {
		d.Notes = append(d.Notes, "Could not list the structures: "+err.Error())
	} else {
		var entries []reportStructureEntry
		_ = model.Decode(listed["structures"], &entries)
		for _, e := range entries {
			d.Structures = append(d.Structures, reportReadStructure(b, pr, e, label))
		}
	}

	// External sources the user included (EVIDENCE.md).
	if cards, err := b.ListEvidence(pr.Path); err != nil {
		d.Notes = append(d.Notes, "Could not read the external sources: "+err.Error())
	} else {
		for i := range cards {
			if cards[i].InReport() {
				d.Evidence = append(d.Evidence, newReportEvidence(&cards[i], d.Structures))
			}
		}
	}
	return d
}

// reportProvenance lists the input files with their fingerprints and how
// each sample's hybrids were called (from its run checkpoint).
func reportProvenance(pr *model.Project) ([]reportFile, []reportSettings) {
	var inputs []reportFile
	for _, r := range pr.References {
		if r.Path == "" {
			continue
		}
		inputs = append(inputs, reportFile{File: filepath.Base(r.Path), UsedBy: "reference " + dataRefName(r),
			Size: dataFormatBytes(r.SizeBytes), Fingerprint: reportFingerprint(r.SHA256, r.QuickHash)})
	}
	var settings []reportSettings
	for _, s := range pr.Samples {
		if s.Reads.Path != "" {
			inputs = append(inputs, reportFile{File: filepath.Base(s.Reads.Path), UsedBy: "sample " + s.Label(),
				Size: dataFormatBytes(s.Reads.SizeBytes), Fingerprint: reportFingerprint(s.Reads.SHA256, s.Reads.QuickHash)})
		}
		text, note := reportRunSettings(pr.Path, s)
		settings = append(settings, reportSettings{Sample: s.Label(), Settings: text, Note: note})
	}
	return inputs, settings
}

// reportCheckpoint is the part of <out>.checkpoint.json the report shows.
type reportCheckpoint struct {
	Input struct {
		Path  string  `json:"path"`
		Size  int64   `json:"size"`
		Mtime float64 `json:"mtime"`
	} `json:"input"`
	Options map[string]any `json:"options"`
}

// reportOptionKeys are the checkpoint options that change the hybrids, in
// the order shown (work, source and keep_sam do not).
var reportOptionKeys = []string{"blast_threshold", "max_overlap", "max_hits", "energy"}

// reportRunSettings: the settings the sample's hybrids were called with,
// and a note when the reads changed after that run.
func reportRunSettings(project string, s model.Sample) (string, string) {
	if s.Reads.Format == "hyb" {
		return "imported .hyb file: hybrids were called outside RNAxRay Desktop", ""
	}
	if s.Outputs.Hyb == "" {
		for _, stage := range []string{"map", "hyb"} {
			switch status := dataStage(s, stage).Status; status {
			case "failed", "cancelled", "interrupted":
				return "no hybrids: the last run " + status + " at " + stage, ""
			}
		}
		return "not run yet", ""
	}
	base := strings.TrimSuffix(filepath.FromSlash(s.Outputs.Hyb), ".hyb")
	if !filepath.IsAbs(base) {
		base = filepath.Join(project, base)
	}
	raw, err := os.ReadFile(base + ".checkpoint.json")
	var ck reportCheckpoint
	if err == nil {
		err = json.Unmarshal(raw, &ck)
	}
	if err != nil || ck.Options == nil {
		return "not recorded (no run checkpoint was found)", ""
	}
	var parts []string
	for _, key := range reportOptionKeys {
		value, ok := ck.Options[key]
		if !ok {
			continue
		}
		text := fmt.Sprint(value)
		if b, isBool := value.(bool); isBool {
			text = map[bool]string{true: "on", false: "off"}[b]
		}
		parts = append(parts, key+" "+text)
	}
	if format, ok := ck.Options["format"].(string); ok && format != "" {
		parts = append(parts, "pipeline format "+format)
	}
	note := ""
	if ck.Input.Size != s.Reads.SizeBytes || (s.Reads.Mtime != 0 && math.Abs(ck.Input.Mtime-s.Reads.Mtime) > 0.01) {
		note = "The reads file now differs from the one this run used (size or modification time): run the sample again."
	}
	return nameOr(strings.Join(parts, " · "), "defaults"), note
}

func reportReadTest(b core.Backend, pr *model.Project, e comparisonEntry, label func(string) string) reportTest {
	names := func(ids []string) string {
		out := make([]string, len(ids))
		for i, id := range ids {
			out[i] = label(id)
		}
		return strings.Join(out, " + ")
	}
	x := reportTest{ID: e.ID, LabelA: nameOr(e.LabelOne, names(e.SamplesOne)), LabelB: nameOr(e.LabelTwo, names(e.SamplesTwo)),
		Genes: e.Genes, Params: cmpParamsText(&e), Created: e.CreatedAt, Summary: e.Summary}
	if e.Available != nil && !*e.Available {
		x.Err = "the result files are missing"
		return x
	}
	raw, err := b.ProjectOp(pr.Path, "read_comparison", core.Obj{"comparison_id": e.ID, "limit": reportMaxCells})
	var result comparisonResult
	if err == nil {
		err = model.Decode(raw, &result)
	}
	if err != nil {
		x.Err = err.Error()
		return x
	}
	if result.Summary.CellsTested > 0 {
		x.Summary = result.Summary // summary.json, as Compare shows it
	}
	top := append([]cmpInteraction(nil), result.Interactions...)
	sort.SliceStable(top, func(i, j int) bool { return cmpPadj(top[i].Padj) < cmpPadj(top[j].Padj) })
	x.Top = top[:min(len(top), reportTopInteractions)]
	x.Cells = cmpSignificantCells(&result, 0, cmpRed, cmpBlue) // the HTML report is light
	x.CellsTotal = max(result.CellsTotal, int64(len(x.Cells)))
	x.SimCells = cmpSimilarityCells(&result)
	// the folding energies, when computed (an older runtime may not know the operation)
	if raw, err := b.ProjectOp(pr.Path, "read_energy", core.Obj{"comparison_id": e.ID}); err == nil {
		var energy energyResult
		if model.Decode(raw, &energy) == nil && energy.Summary != nil && energy.Rows != nil {
			x.Energy = &energy
		}
	}
	for _, g := range e.Genes {
		x.Length = max(x.Length, pr.GeneLength(g))
	}
	if x.Length == 0 {
		x.Length = int(x.Summary.MaxCoordinate) + 10
	}
	return x
}

func reportReadStructure(b core.Backend, pr *model.Project, e reportStructureEntry, label func(string) string) reportStructure {
	ids := e.SampleIDs
	if len(ids) == 0 {
		ids = e.Samples
	}
	evidence := make([]string, len(ids))
	for i, id := range ids {
		evidence[i] = label(id)
	}
	s := reportStructure{ID: e.ID, Gene: e.GeneID, Mode: "whole RNA", Evidence: strings.Join(evidence, " + "), Created: e.CreatedAt,
		Pairs: e.Summary.Pairs, Pseudoknots: e.Summary.PseudoknotPairs, Energy: e.Summary.Energy, Length: e.Summary.Length}
	if e.Mode != "genome" {
		s.Mode = fmt.Sprintf("%d window%s", len(e.Windows), plural(len(e.Windows)))
		var spans []string
		for _, w := range e.Windows {
			spans = append(spans, span(int(w.Start), int(w.End)))
		}
		s.Windows = strings.Join(spans, ", ")
	}
	if e.Available != nil && !*e.Available {
		s.Err = "the result files are missing"
		return s
	}
	raw, err := b.ProjectOp(pr.Path, "read_structure", core.Obj{"structure_id": e.ID})
	var result structureResult
	if err == nil {
		err = model.Decode(raw, &result)
	}
	if err != nil {
		s.Err = err.Error()
		return s
	}
	s.Digests = map[string]string{"all": researchDigest(result.Records)}
	for _, r := range result.Records {
		s.Digests[fmt.Sprintf("%d-%d", r.WindowStart, r.WindowEnd)] = researchDigest([]structureRecord{r})
		start, end := r.span()
		if s.Start == 0 || start < s.Start {
			s.Start = start
		}
		s.End = max(s.End, end)
		for _, p := range stRecordPairs(r) {
			s.Arcs = append(s.Arcs, widgets.Pair{I: p.I, J: p.J})
		}
	}
	if s.Pairs == 0 {
		s.Pairs = len(s.Arcs)
	}
	if s.End-s.Start < 20 {
		s.Start, s.End = 1, max(pr.GeneLength(s.Gene), s.End, 2)
	}
	return s
}

// ---- export

func (p *reportPage) export() {
	d := p.data
	if d == nil {
		return
	}
	saveExport(p.a, "Export report", exportName("-report.html", d.Name), func() ([]byte, error) { return renderReportHTML(d) })
}

// ---- view

func (p *reportPage) View(c *ui.Context) {
	t := c.Theme()
	d := p.data
	ui.Scroll(c.Key("report-scroll")).Fill().Children(func() {
		ui.Column(c).Padding(24).Gap(16).Children(func() {
			ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
				ui.Column(c).Grow(1).Shrink(1).MinWidth(0).Children(func() {
					PageHeader(c, "Report", "The project at a glance: data, counts, differential tests and structures.")
				})
				if p.loading {
					ui.Spinner(c).Label("Loading")
				}
				if ui.Button(c, "Refresh").Disabled(p.loading).Clicked() {
					p.load()
				}
				if ui.PrimaryButton(c, "Export report…").Tooltip("Save the report as one HTML file with its figures").Disabled(d == nil).Clicked() && d != nil {
					p.export()
				}
			})
			if d == nil {
				if p.loading {
					ui.Text(c, "Assembling the report…").TextColor(t.TextMuted)
				}
				return
			}
			for _, note := range d.Notes {
				errorLine(c, note)
			}
			Card(c, "Project", func() { reportFacts(c, d.projectFacts()) })
			Card(c, "Before you report these results", func() {
				for _, check := range d.reviewChecks() {
					ui.Text(c, "• "+check).FontSize(ts(c, 12))
				}
			})
			Card(c, "References", func() { reportTable(c, "references", d.referenceTable(), "No reference in this project.") })
			Card(c, "Samples", func() {
				reportTable(c, "samples", d.sampleTable(), "No sample in this project.")
				ui.Text(c, "Hybrids and reads from each analysed sample's index; intra / inter are shares of hybrids.").FontSize(ts(c, 12)).TextColor(t.TextMuted)
			})
			Card(c, "Conditions", func() {
				reportTable(c, "conditions", d.conditionTable(), "No condition: samples have no condition set.")
			})
			Card(c, "Pipeline settings and input files", func() {
				reportTable(c, "inputs", d.inputTable(), "No input file in this project.")
				if len(d.Settings) > 0 {
					reportTable(c, "settings", d.settingsTable(), "")
				}
				ui.Text(c, reportFingerprintNote).FontSize(ts(c, 12)).TextColor(t.TextMuted)
			})
			Card(c, "Differential tests", func() { p.testsView(c, d) })
			Card(c, "Structures", func() {
				reportTable(c, "structures", d.structureTable(), "No structure has been folded.")
				for _, s := range d.Structures {
					if s.Err != "" {
						ui.Text(c, s.Gene+" ("+s.ID+"): "+s.Err).FontSize(ts(c, 12)).TextColor(t.Danger)
					}
				}
			})
			Card(c, "External sources and researcher notes", func() { reportEvidenceView(c, d) })
			Card(c, "Runtime", func() { reportFacts(c, d.runtimeFacts()) })
		})
	})
}

func (p *reportPage) testsView(c *ui.Context, d *reportData) {
	t := c.Theme()
	if len(d.Tests) == 0 {
		ui.Text(c, "No differential test has been run.").TextColor(t.TextMuted)
		return
	}
	reportTable(c, "tests", d.testTable(), "")
	for i := range d.Tests {
		x := &d.Tests[i]
		ui.Column(c.Key("test-"+x.ID)).Gap(8).Padding(12, 0, 0, 0).BorderWidth(1, 0, 0, 0).BorderColor(t.Border).Children(func() {
			ui.Column(c).Gap(2).Children(func() {
				ui.Text(c, x.LabelA+" vs "+x.LabelB).FontSize(ts(c, 16)).Bold()
				ui.Text(c, strings.Join(x.Genes, ", ")+" · "+x.Params+" · log2 fold change = A / B · "+FormatTime(x.Created)).FontSize(ts(c, 12)).TextColor(t.TextMuted)
			})
			s := x.Summary
			ui.Row(c).Gap(10).Wrap().Children(func() {
				cmpStat(c, "Significant cells", FormatNumber(s.Significant), ui.Color{})
				condA, condB := condColors(t)
				cmpStat(c, "Higher in "+x.LabelA, FormatNumber(s.SignificantUp), condA)
				cmpStat(c, "Higher in "+x.LabelB, FormatNumber(s.SignificantDown), condB)
				cmpStat(c, "Interactions A / B", FormatNumber(s.InteractionsUp)+" / "+FormatNumber(s.InteractionsDown), ui.Color{}).
					Tooltip("Merged interactions higher in A / higher in B")
			})
			if x.Err != "" {
				errorLine(c, "Could not read the results: "+x.Err)
				return
			}
			if len(x.Top) == 0 {
				ui.Text(c, "No significant interaction.").TextColor(t.TextMuted)
				return
			}
			ui.Text(c, fmt.Sprintf("Top %d merged interactions by padj", len(x.Top))).Bold()
			reportTable(c, "top-"+x.ID, x.topTable(), "")
		})
	}
}

func reportEvidenceView(c *ui.Context, d *reportData) {
	t := c.Theme()
	if len(d.Evidence) == 0 {
		ui.Text(c, "No external source is included. Save a card from Structure › Related research and switch on “Include in report”.").TextColor(t.TextMuted)
		return
	}
	for i := range d.Evidence {
		e := &d.Evidence[i]
		ui.Column(c.Key(fmt.Sprint("evidence-", i))).Gap(8).Padding(12, 0, 0, 0).BorderWidth(1, 0, 0, 0).BorderColor(t.Border).Children(func() {
			ui.Text(c, e.Title).FontSize(ts(c, 16)).Bold()
			ui.Text(c, e.Boundary).Bold().Padding(4, 8).Radius(6).Background(t.Warning.Alpha(0.14))
			reportFacts(c, e.Facts())
			if e.Text != "" {
				ui.Text(c, e.Text).Padding(8, 10).Radius(6).Background(t.Surface)
			}
		})
	}
	ui.Text(c, reportEvidenceNote).FontSize(ts(c, 12)).TextColor(t.TextMuted)
}

// reportFacts shows label / value lines.
func reportFacts(c *ui.Context, facts [][2]string) {
	t := c.Theme()
	ui.Column(c).Gap(4).Children(func() {
		for _, f := range facts {
			ui.Row(c.Key(f[0])).Gap(12).AlignItems(ui.Start).Children(func() {
				ui.Text(c, f[0]).TextColor(t.TextMuted).Width(150)
				ui.Text(c, f[1]).Grow(1).Shrink(1).MinWidth(0)
			})
		}
	})
}

// reportTable draws a short table (a few dozen rows at most) as rows of
// text; it scrolls sideways in a narrow window.
func reportTable(c *ui.Context, key string, table reportTableData, empty string) {
	t := c.Theme()
	if len(table.Rows) == 0 {
		if empty != "" {
			ui.Text(c, empty).TextColor(t.TextMuted)
		}
		return
	}
	minWidth := float32(16 + 12*(len(table.Cols)-1))
	for _, col := range table.Cols {
		if col.Width > 0 {
			minWidth += col.Width
		} else {
			minWidth += 140
		}
	}
	cell := func(col reportCol, text string, header bool) {
		lines := strings.Split(text, "\n")
		box := ui.Column(c).Gap(1)
		if col.Width > 0 {
			box.Width(col.Width)
		} else {
			box.Grow(1).Shrink(1).Basis(0).MinWidth(140)
		}
		if col.Num {
			box.AlignItems(ui.End)
		}
		box.Children(func() {
			for i, line := range lines {
				el := ui.Text(c, line)
				if col.Width > 0 {
					el.SingleLine()
				}
				switch {
				case header:
					el.FontSize(ts(c, 12)).Bold().TextColor(t.TextMuted)
				case i > 0:
					el.FontSize(ts(c, 11)).TextColor(t.TextMuted)
				}
			}
		})
	}
	rows := func(minWidth float32) {
		ui.Column(c).MinWidth(minWidth).Grow(1).Children(func() {
			ui.Row(c).Gap(12).Padding(6, 8).Background(t.Surface).Radius(6).Children(func() {
				for _, col := range table.Cols {
					cell(col, col.Title, true)
				}
			})
			for i, row := range table.Rows {
				ui.Row(c.Key(fmt.Sprint(i))).Gap(12).Padding(6, 8).BorderWidth(0, 0, 1, 0).BorderColor(t.Border).Children(func() {
					for j, col := range table.Cols {
						text := ""
						if j < len(row) {
							text = row[j]
						}
						cell(col, text, false)
					}
				})
			}
		})
	}
	// Laid out in the width given when it fits (the last column grows and
	// wraps), else scrolled sideways at its minimum width. The width is the
	// last frame's; the first frame asks for another.
	box := ui.Column(c.Key("table-" + key)).AlignItems(ui.Stretch).MinWidth(0).ClipX()
	width := box.Bounds().W
	if width == 0 {
		c.Invalidate()
	}
	box.Children(func() {
		if width >= minWidth {
			rows(0)
			return
		}
		// The scroll bar shows only on hover, so say that more columns
		// are off to the right.
		ui.Text(c, reportScrollHint).FontSize(ts(c, 11)).TextColor(t.TextMuted)
		ui.ScrollHorizontal(c).AlignItems(ui.Stretch).Children(func() { rows(minWidth) })
	})
}

const reportScrollHint = "More columns: scroll sideways →"
