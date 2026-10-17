package views

// The project report's content (reportData, assembled by report.go) as
// tables shared by the Report page and the exported file, and the export
// itself: one self-contained HTML file (inline CSS and SVG, no external
// resources, print-friendly). Everything here is pure: no backend, no ui.

import (
	"bytes"
	"fmt"
	"html/template"
	"math"
	"path/filepath"
	"sort"
	"strings"

	"rnaxraydesktop/model"
	"rnaxraydesktop/widgets"
)

// reportMaxCells caps the significant cells drawn per test in the export
// (the strongest are kept).
const reportMaxCells = 20_000

// reportTopInteractions is how many merged interactions each test lists.
const reportTopInteractions = 10

type reportData struct {
	Name, Path, Description       string
	Created, Updated, CreatedWith string
	AppVersion, Runtime           string
	Generated                     string
	References                    []model.Reference
	Samples                       []reportSample
	Conditions                    []reportCondition
	Tests                         []reportTest
	Structures                    []reportStructure
	// Inputs are the reference and reads files with their fingerprints;
	// Settings how each sample's hybrids were called.
	Inputs   []reportFile
	Settings []reportSettings
	// Evidence are the saved external cards included in the report.
	Evidence []reportEvidence
	// Notes are parts that could not be loaded.
	Notes []string
}

type reportSample struct {
	ID, Label, Condition, Replicate string
	Reads, Format, Stages           string
	Ready                           bool
	// Counts is the sample's analysis_summary part (nil when not analysed).
	Counts *qcStats
}

type reportFile struct {
	File, UsedBy, Size, Fingerprint string
}

type reportSettings struct {
	Sample, Settings string
	Note             string // e.g. the reads changed after the run
}

type reportCondition struct {
	Name     string
	Samples  []string // labels
	Analysed int
	Counts   *qcStats // replicates merged (nil when none analysed)
}

type reportTest struct {
	ID, LabelA, LabelB string
	Genes              []string
	Params             string
	Created            string
	Summary            comparisonSummary
	// Top are the strongest merged interactions (by padj).
	Top []cmpInteraction
	// Cells are the significant cells read, coloured, weakest first.
	Cells      []widgets.Cell
	CellsTotal int64
	// SimCells is the similarity heatmap read (nil for tests made before it).
	SimCells []widgets.Cell
	// Energy is the test's folding-energy result (nil when not computed).
	Energy *energyResult
	Length int
	Err    string
}

type reportStructure struct {
	ID, Gene, Mode, Windows, Evidence, Created string
	Pairs, Pseudoknots, Length                 int
	Energy                                     *float64
	Arcs                                       []widgets.Pair
	Start, End                                 int
	Err                                        string
	// Digests are the evidence binding digests of the result: "all" and
	// each window "start-end".
	Digests map[string]string
}

// reportEvidence is a saved external card the user included in the report.
type reportEvidence struct {
	Title, Boundary, Query, Retrieved, Status string
	Result, Review, Note, Citations, Text     string
	SourceURL                                 string
}

// Facts are the card's label / value lines.
func (e *reportEvidence) Facts() [][2]string {
	facts := [][2]string{{"Query", e.Query}, {"Retrieved", e.Retrieved}, {"Status", e.Status}, {"Result", e.Result},
		{"Review", e.Review}, {"Citations", e.Citations}}
	if e.SourceURL != "" {
		facts = append(facts, [2]string{"Source", e.SourceURL})
	}
	if e.Note != "" {
		facts = append(facts, [2]string{"Researcher note", e.Note})
	}
	return facts
}

// reportEvidenceNote ends the section: what the cards are and are not.
const reportEvidenceNote = "Background material from external sources, kept as retrieved. It does not change any RNAxRay result, method, parameter or number."

// newReportEvidence describes a card against the report's structures.
func newReportEvidence(card *model.EvidenceCard, structures []reportStructure) reportEvidence {
	e := reportEvidence{Title: card.SourceProvider + " · " + card.SourceTool, Boundary: researchHeading(card),
		Query: researchQuery(card), Status: researchCardLabel(card), Review: researchReview(card.Review),
		Text: card.Text(), SourceURL: researchSourceURL(card)}
	e.Retrieved = "not retrieved"
	if card.RetrievedAt != nil && *card.RetrievedAt != "" {
		e.Retrieved = FormatTime(*card.RetrievedAt)
	}
	if detail := researchStatusText(card); detail != "" && card.Status != model.EvidenceSuccess {
		e.Status += " — " + detail
	}
	if researchShowDetail(card) {
		e.Status += " (" + *card.StatusDetail + ")"
	}
	if !card.LocalOrigin {
		e.Review += " · " + researchOriginNotice
	}
	e.Citations = "citations not verified"
	if card.CitationVerification == "verified" {
		e.Citations = "verified"
	}
	if len(card.SourceIdentifiers) > 0 {
		e.Citations += " · " + strings.Join(card.SourceIdentifiers, ", ")
	}
	if card.Review.Note != nil {
		e.Note = *card.Review.Note
	}
	e.Result = researchBindingText(card.Binding)
	if b := card.Binding; b != nil {
		found := false
		for i := range structures {
			s := &structures[i]
			if s.ID != b.StructureID {
				continue
			}
			found = true
			e.Result = s.Gene + " · " + e.Result
			if digest := s.Digests[b.Record]; digest != "" && !strings.EqualFold(digest, b.ResultDigest) {
				e.Result += " (the result changed after the card was saved)"
			}
		}
		if !found {
			e.Result += " (no longer in the project)"
		}
	}
	return e
}

// ---- tables (shared by the page and the HTML)

type reportCol struct {
	Title string
	// Width is the page's column width in DIPs (0 shares the room left).
	Width float32
	// Num aligns right.
	Num bool
}

// reportTableData is a table of text cells; a "\n" in a cell starts its
// secondary (smaller, muted) lines.
type reportTableData struct {
	Cols []reportCol
	Rows [][]string
}

func reportCount(n int64) string { return FormatNumber(n) }

func reportPercent(part, total int64) string { return qcPercent(part, total) }

// reportTypes: the three largest chimera types with their share.
func reportTypes(s *qcStats) string {
	if s == nil || s.Records == 0 {
		return "—"
	}
	types := append([]qcCount(nil), s.Types...)
	sort.SliceStable(types, func(i, j int) bool { return types[i].Records > types[j].Records })
	var parts []string
	for i, t := range types {
		if i == 3 {
			break
		}
		parts = append(parts, strings.ReplaceAll(t.Name, "_", " ")+" "+qcPercent(t.Records, s.Records))
	}
	return nameOr(strings.Join(parts, ", "), "—")
}

func reportCounts(s *qcStats) []string {
	if s == nil {
		return []string{"—", "—", "—", "—"}
	}
	return []string{reportCount(s.Records), reportCount(s.Reads), reportPercent(s.Intra, s.Records), reportPercent(s.Inter, s.Records)}
}

func (d *reportData) referenceTable() reportTableData {
	t := reportTableData{Cols: []reportCol{{Title: "Reference", Width: 120}, {Title: "File", Width: 220}, {Title: "Sequence"}, {Title: "Length (nt)", Width: 100, Num: true}}}
	for _, r := range d.References {
		file := filepath.Base(r.Path)
		if r.Path == "" {
			file = "—"
		}
		if r.Mode != "" {
			file += " (" + r.Mode + ")"
		}
		label := nameOr(r.Label, r.ID)
		if len(r.Sequences) == 0 {
			t.Rows = append(t.Rows, []string{label, file, "—", "—"})
		}
		for i, s := range r.Sequences {
			if i > 0 {
				label, file = "", ""
			}
			t.Rows = append(t.Rows, []string{label, file, s.Name, FormatNumber(int64(s.Length))})
		}
	}
	return t
}

func (d *reportData) sampleTable() reportTableData {
	t := reportTableData{Cols: []reportCol{{Title: "Sample", Width: 120}, {Title: "Reads file · stages", Width: 190},
		{Title: "Hybrids", Width: 80, Num: true}, {Title: "Reads", Width: 80, Num: true},
		{Title: "Intra", Width: 64, Num: true}, {Title: "Inter", Width: 56, Num: true}, {Title: "Main types", Width: 0}}}
	for _, s := range d.Samples {
		reads := "—"
		if s.Reads != "" {
			reads = filepath.Base(s.Reads)
		}
		sub := nameOr(s.Condition, "no condition")
		if s.Replicate != "" {
			sub += " · rep " + s.Replicate
		}
		row := []string{s.Label + "\n" + sub, reads + "\n" + nameOr(s.Stages, "—")}
		row = append(row, reportCounts(s.Counts)...)
		t.Rows = append(t.Rows, append(row, reportTypes(s.Counts)))
	}
	return t
}

func (d *reportData) conditionTable() reportTableData {
	t := reportTableData{Cols: []reportCol{{Title: "Condition", Width: 110}, {Title: "Samples", Width: 0}, {Title: "Analysed", Width: 76, Num: true},
		{Title: "Hybrids", Width: 84, Num: true}, {Title: "Reads", Width: 84, Num: true}, {Title: "Intra", Width: 60, Num: true}, {Title: "Inter", Width: 60, Num: true}}}
	for _, c := range d.Conditions {
		row := []string{c.Name, nameOr(strings.Join(c.Samples, ", "), "—"), fmt.Sprintf("%d of %d", c.Analysed, len(c.Samples))}
		t.Rows = append(t.Rows, append(row, reportCounts(c.Counts)...))
	}
	return t
}

func (d *reportData) testTable() reportTableData {
	t := reportTableData{Cols: []reportCol{{Title: "Test (A vs B)", Width: 0}, {Title: "Cells tested", Width: 96, Num: true},
		{Title: "Significant", Width: 90, Num: true}, {Title: "Higher in A / B", Width: 120, Num: true}, {Title: "Interactions A / B", Width: 150, Num: true}}}
	for _, x := range d.Tests {
		s := x.Summary
		t.Rows = append(t.Rows, []string{x.LabelA + " vs " + x.LabelB, reportCount(s.CellsTested), reportCount(s.Significant),
			reportCount(s.SignificantUp) + " / " + reportCount(s.SignificantDown),
			reportCount(s.InteractionsUp) + " / " + reportCount(s.InteractionsDown)})
	}
	return t
}

func (x *reportTest) topTable() reportTableData {
	t := reportTableData{Cols: []reportCol{{Title: "#", Width: 32, Num: true}, {Title: "Arm 1 (nt)", Width: 110}, {Title: "Arm 2 (nt)", Width: 110},
		{Title: "Higher in", Width: 0}, {Title: "log2 A/B", Width: 76, Num: true}, {Title: "padj", Width: 76, Num: true}, {Title: "Mean count", Width: 84, Num: true}}}
	for i, r := range x.Top {
		higher := x.LabelA
		if r.Direction == "down" || (r.LFC != nil && *r.LFC < 0) {
			higher = x.LabelB
		}
		mean := "—"
		if r.BaseMean != nil && !math.IsNaN(*r.BaseMean) {
			mean = FormatNumber(int64(math.Round(*r.BaseMean)))
		}
		t.Rows = append(t.Rows, []string{fmt.Sprint(i + 1), span(r.X, r.X+9), span(r.Y, r.Y+9), higher,
			cmpFloat(r.LFC, "%.2f"), cmpFloat(r.Padj, "%.1e"), mean})
	}
	return t
}

func reportEnergy(e *float64) string {
	if e == nil || math.IsNaN(*e) {
		return "—"
	}
	return fmt.Sprintf("%.1f kcal/mol", *e)
}

func (d *reportData) structureTable() reportTableData {
	t := reportTableData{Cols: []reportCol{{Title: "RNA · mode", Width: 0}, {Title: "Evidence · created", Width: 180},
		{Title: "Pairs", Width: 64, Num: true}, {Title: "Pseudoknotted", Width: 104, Num: true}, {Title: "Energy", Width: 116, Num: true}}}
	for _, s := range d.Structures {
		t.Rows = append(t.Rows, []string{s.Gene + "\n" + s.Mode + prefix(" · ", s.Windows), nameOr(s.Evidence, "—") + "\n" + nameOr(FormatTime(s.Created), "—"),
			reportCount(int64(s.Pairs)), reportCount(int64(s.Pseudoknots)), reportEnergy(s.Energy)})
	}
	return t
}

// reportFingerprint: the full SHA-256 when it was computed, else the
// quick one (size and first and last MiB, see the meta line).
func reportFingerprint(sha, quick string) string {
	switch {
	case sha != "":
		return "SHA-256\n" + sha
	case quick != "":
		return "quick fingerprint\n" + quick
	}
	return "—"
}

func (d *reportData) inputTable() reportTableData {
	t := reportTableData{Cols: []reportCol{{Title: "File", Width: 200}, {Title: "Used by", Width: 130},
		{Title: "Size", Width: 84, Num: true}, {Title: "Fingerprint", Width: 0}}}
	for _, in := range d.Inputs {
		t.Rows = append(t.Rows, []string{in.File, in.UsedBy, in.Size, in.Fingerprint})
	}
	return t
}

func (d *reportData) settingsTable() reportTableData {
	t := reportTableData{Cols: []reportCol{{Title: "Sample", Width: 130}, {Title: "Hybrid calling settings", Width: 0}}}
	for _, s := range d.Settings {
		cell := s.Settings
		if s.Note != "" {
			cell += "\n" + s.Note
		}
		t.Rows = append(t.Rows, []string{s.Sample, cell})
	}
	return t
}

// reportFingerprintNote explains the fingerprints and where the settings
// come from.
const reportFingerprintNote = "Quick fingerprint: SHA-256 of the file size and its first and last MiB, recorded when the file was added; " +
	"it tells a changed file from the same file without reading all of it. Settings are those recorded in each sample's run checkpoint " +
	"(samples/<sample>/<name>.checkpoint.json), named as in the rnaxraypipe options."

// Line describes a structure in one line.
func (s *reportStructure) Line() string {
	parts := []string{s.Mode + prefix(" ", s.Windows)}
	if s.Evidence != "" {
		parts = append(parts, "evidence "+s.Evidence)
	}
	parts = append(parts, fmt.Sprintf("%s base pairs (%s pseudoknotted)", FormatNumber(int64(s.Pairs)), FormatNumber(int64(s.Pseudoknots))))
	if s.Energy != nil {
		parts = append(parts, reportEnergy(s.Energy))
	}
	parts = append(parts, s.ID)
	return strings.Join(parts, " · ")
}

func prefix(p, s string) string {
	if s == "" {
		return ""
	}
	return p + s
}

// exportFacts are projectFacts for the exported file, which is shared: the
// folder is named, not where it is on this computer.
func (d *reportData) exportFacts() [][2]string {
	facts := d.projectFacts()
	for i := range facts {
		if facts[i][0] == "Folder" {
			facts[i][1] = filepath.Base(facts[i][1])
		}
	}
	return facts
}

// projectFacts are the Project section's label / value lines.
func (d *reportData) projectFacts() [][2]string {
	facts := [][2]string{{"Name", d.Name}, {"Folder", d.Path}}
	if d.Description != "" {
		facts = append(facts, [2]string{"Description", d.Description})
	}
	facts = append(facts,
		[2]string{"Created", nameOr(FormatTime(d.Created), "—")},
		[2]string{"Last changed", nameOr(FormatTime(d.Updated), "—")},
		[2]string{"Created with", nameOr(d.CreatedWith, "—")},
		[2]string{"Samples", fmt.Sprintf("%d (%d analysed)", len(d.Samples), d.analysed())},
		[2]string{"Differential tests", fmt.Sprint(len(d.Tests))},
		[2]string{"Structures", fmt.Sprint(len(d.Structures))},
	)
	return facts
}

func (d *reportData) analysed() int {
	n := 0
	for _, s := range d.Samples {
		if s.Ready {
			n++
		}
	}
	return n
}

// reviewChecks are what to check before reporting this project's results,
// each only when its condition applies (the app's and the export's
// "Before you report these results").
func (d *reportData) reviewChecks() []string {
	analysed := 0
	for _, s := range d.Samples {
		if s.Ready {
			analysed++
		}
	}
	checks := []string{fmt.Sprintf("These results cover the %d analysed sample%s of this project; hybrid counts depend on the pipeline settings listed under Pipeline settings and input files.",
		analysed, plural(analysed))}
	if missing := len(d.Samples) - analysed; missing > 0 {
		checks = append(checks, fmt.Sprintf("%d of %d samples are not analysed: they are missing from the condition counts and the differential tests.", missing, len(d.Samples)))
	}
	var single []string
	for _, c := range d.Conditions {
		if c.Analysed == 1 {
			single = append(single, c.Name)
		}
	}
	if len(single) > 0 {
		checks = append(checks, "Only one analysed replicate in "+strings.Join(single, ", ")+": differences involving it have no replicate variance behind them.")
	}
	changed := 0
	for _, s := range d.Settings {
		if s.Note != "" {
			changed++
		}
	}
	switch {
	case changed == 1:
		checks = append(checks, "1 sample's input changed after it was analysed (see Pipeline settings); run it again before reporting.")
	case changed > 1:
		checks = append(checks, fmt.Sprintf("%d samples' inputs changed after they were analysed (see Pipeline settings); run them again before reporting.", changed))
	}
	if len(d.Tests) > 0 {
		checks = append(checks, "Differential tests are DESeq2 on 10-nt contact maps; padj assumes the replicates are independent biological samples, so check how they were made.")
	}
	if len(d.Structures) > 0 {
		checks = append(checks, "Structures are computational predictions guided by chimeric reads; support key helices with independent evidence (for example probing or mutation) before stating them.")
	}
	if len(d.Evidence) > 0 {
		checks = append(checks, "External sources are AI-generated literature summaries whose citations are not verified; read the cited papers before relying on them.")
	}
	if len(d.Notes) > 0 {
		checks = append(checks, "Parts of the project could not be read for this report (see the notes at the top); it is incomplete.")
	}
	return checks
}

// runtimeFacts: the app and runtime that made the report.
func (d *reportData) runtimeFacts() [][2]string {
	return [][2]string{{"RNAxRay Desktop", nameOr(d.AppVersion, "development build")}, {"Runtime", nameOr(d.Runtime, "not detected yet")},
		{"Report generated", d.Generated}}
}

// ---- figures

func (x *reportTest) figure(id string) (template.HTML, string) {
	if len(x.Cells) == 0 {
		return "", ""
	}
	length := float64(max(x.Length, 1))
	svg, drawn, _ := heatSVG{Cells: x.Cells, View: widgets.Window{X0: 0, X1: length, Y0: 0, Y1: length}, Size: 360,
		MaxCells: reportMaxCells, MinCellPx: 2.5, ID: id, XLabel: "Arm 1 (nt)", YLabel: "Arm 2 (nt)"}.SVG()
	caption := fmt.Sprintf("Significant 10-nt cells: red higher in %s, blue higher in %s; stronger colour, smaller padj.", x.LabelA, x.LabelB)
	if total := max(x.CellsTotal, int64(len(x.Cells))); int64(drawn) < total {
		caption += fmt.Sprintf(" The %s strongest of %s cells are drawn.", FormatNumber(int64(drawn)), FormatNumber(total))
	}
	return template.HTML(svg), caption //nolint:gosec // generated and escaped by heatSVG
}

func (x *reportTest) similarityFigure(id string) (template.HTML, string) {
	if len(x.SimCells) == 0 {
		return "", ""
	}
	length := float64(max(x.Length, 1))
	svg, drawn, _ := heatSVG{Cells: x.SimCells, View: widgets.Window{X0: 0, X1: length, Y0: 0, Y1: length}, Size: 360,
		MaxCells: reportMaxCells, MinCellPx: 2.5, ID: id, XLabel: "Arm 1 (nt)", YLabel: "Arm 2 (nt)"}.SVG()
	caption := fmt.Sprintf("Similarity heatmap (rnaxray plot_similarity_map): cells in both %s and %s; green = the smaller summed count, capped at the 95%% quantile (%g).",
		x.LabelA, x.LabelB, x.Summary.SimilarityCap)
	if total := max(x.Summary.SimilarityCells, int64(len(x.SimCells))); int64(drawn) < total {
		caption += fmt.Sprintf(" The %s strongest of %s cells are drawn.", FormatNumber(int64(drawn)), FormatNumber(total))
	}
	return template.HTML(svg), caption //nolint:gosec // generated and escaped by heatSVG
}

// energyFigure is the folding-energy violins of both directions.
func (x *reportTest) energyFigure() (template.HTML, string) {
	r := x.Energy
	if r == nil || r.Summary == nil || r.Rows == nil {
		return "", ""
	}
	labels := [2]string{x.LabelA, x.LabelB}
	svg := energySVG(r, labels, fmt.Sprintf("Folding energy of enriched interactions (2 × %d nt)", r.Summary.Parameters.Length))
	var parts []string
	for side := range 2 {
		st := r.Summary.Sides[energySides[side]]
		parts = append(parts, fmt.Sprintf("enriched in %s: n = %s, mean dG %s %s vs %s %s kcal/mol, paired t-test p = %s", labels[side],
			FormatNumber(int64(st.N)), labels[0], formatFloat(st.MeanOne, "%.2f"), labels[1], formatFloat(st.MeanTwo, "%.2f"), formatP(st.P)))
	}
	caption := fmt.Sprintf("RNAcofold dG of 2 × %d nt around the arms of each interaction with padj < %g, in %s's sequence and in %s's at the aligned positions; ",
		r.Summary.Parameters.Length, r.Summary.Parameters.Padj, x.LabelA, x.LabelB) + strings.Join(parts, "; ") + "."
	return template.HTML(svg), caption //nolint:gosec // generated and escaped by energySVG
}

func (s *reportStructure) figure(id string) (template.HTML, string) {
	if len(s.Arcs) == 0 {
		return "", ""
	}
	svg, _ := arcSVG{A: s.Arcs, Start: s.Start, End: s.End, Width: 900, ID: id, LabelA: s.Evidence}.SVG()
	caption := fmt.Sprintf("Arc diagram of %s base pairs, %s–%s.", FormatNumber(int64(len(s.Arcs))), FormatNumber(int64(s.Start)), FormatNumber(int64(s.End)))
	return template.HTML(svg), caption //nolint:gosec // generated and escaped by arcSVG
}

// ---- HTML

type reportHTMLTest struct {
	*reportTest
	Figure        template.HTML
	Caption       string
	SimFigure     template.HTML
	SimCaption    string
	EnergyFigure  template.HTML
	EnergyCaption string
	Table         reportTableData
}

type reportHTMLStructure struct {
	*reportStructure
	Figure  template.HTML
	Caption string
}

// renderReportHTML writes the report as one self-contained HTML file.
func renderReportHTML(d *reportData) ([]byte, error) {
	view := struct {
		*reportData
		Facts, Runtime                                         [][2]string
		ReferenceTable, SampleTable, ConditionTable, TestTable reportTableData
		StructureTable, InputTable, SettingsTable              reportTableData
		FingerprintNote                                        string
		TestDetails                                            []reportHTMLTest
		StructureDetails                                       []reportHTMLStructure
		EvidenceNote                                           string
		Checks                                                 []string
	}{reportData: d, Checks: d.reviewChecks(), EvidenceNote: reportEvidenceNote, Facts: d.exportFacts(), Runtime: d.runtimeFacts(), ReferenceTable: d.referenceTable(),
		SampleTable: d.sampleTable(), ConditionTable: d.conditionTable(), TestTable: d.testTable(), StructureTable: d.structureTable(),
		InputTable: d.inputTable(), SettingsTable: d.settingsTable(), FingerprintNote: reportFingerprintNote}
	for i := range d.Tests {
		x := &d.Tests[i]
		fig, caption := x.figure(fmt.Sprintf("test%d", i+1))
		simFig, simCaption := x.similarityFigure(fmt.Sprintf("test%dsim", i+1))
		energyFig, energyCaption := x.energyFigure()
		view.TestDetails = append(view.TestDetails, reportHTMLTest{reportTest: x, Figure: fig, Caption: caption,
			SimFigure: simFig, SimCaption: simCaption, EnergyFigure: energyFig, EnergyCaption: energyCaption, Table: x.topTable()})
	}
	for i := range d.Structures {
		s := &d.Structures[i]
		fig, caption := s.figure(fmt.Sprintf("structure%d", i+1))
		view.StructureDetails = append(view.StructureDetails, reportHTMLStructure{reportStructure: s, Figure: fig, Caption: caption})
	}
	var buf bytes.Buffer
	if err := reportTemplate.Execute(&buf, view); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

var reportTemplate = template.Must(template.New("report").Funcs(template.FuncMap{
	"count": func(n int64) string { return FormatNumber(n) },
	"join":  strings.Join,
	"time":  FormatTime,
	"lines": func(s string) []string { return strings.Split(s, "\n") },
}).Parse(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="RNAxRay Desktop">
<title>{{.Name}} · RNAxRay report</title>
<style>
:root { color-scheme: light; --ink: #1f2328; --muted: #656d76; --line: #d8dee4; --soft: #f6f8fa; --red: #d64541; --blue: #2b6cc4; }
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: var(--ink); font: 14px/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
main { max-width: 1000px; margin: 0 auto; padding: 32px 24px 48px; }
header h1 { margin: 0 0 4px; font-size: 26px; }
header p { margin: 0; color: var(--muted); }
section { margin-top: 32px; }
h2 { font-size: 19px; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
h3 { font-size: 16px; margin: 22px 0 4px; }
p.meta, figcaption, .muted { color: var(--muted); font-size: 12.5px; }
p.meta { margin: 0 0 10px; }
dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 18px; margin: 0; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; overflow-wrap: anywhere; }
.table { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { background: var(--soft); font-weight: 600; font-size: 12px; color: var(--muted); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.stats { display: flex; flex-wrap: wrap; gap: 10px; margin: 8px 0 12px; }
.stat { background: var(--soft); border-radius: 8px; padding: 6px 12px; min-width: 120px; }
.stat b { display: block; font-size: 17px; }
.stat span { color: var(--muted); font-size: 12px; }
td .sub { color: var(--muted); font-size: 12px; }
.up { color: var(--red); } .down { color: var(--blue); }
.evidence { border: 1px solid var(--line); border-radius: 10px; padding: 4px 16px 14px; margin-top: 16px; }
.boundary { display: inline-block; margin: 0 0 10px; padding: 3px 8px; border-radius: 6px; background: #fff8c5; color: #6f4e00; font-size: 13px; font-weight: 600; }
blockquote { margin: 10px 0 0; padding: 8px 12px; background: var(--soft); border-left: 3px solid var(--line); white-space: pre-wrap; }
.test, .structure { border: 1px solid var(--line); border-radius: 10px; padding: 4px 16px 14px; margin-top: 16px; }
.cols { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
.cols > figure { flex: 0 0 auto; }
.cols > .table { flex: 1 1 380px; }
figure { margin: 8px 0; }
figure svg { max-width: 100%; height: auto; display: block; }
.note { color: #9a6700; background: #fff8c5; padding: 6px 10px; border-radius: 6px; font-size: 13px; }
footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
@media print {
  main { max-width: none; padding: 0; }
  section { break-inside: auto; }
  .test, .structure, .evidence, figure, tr { break-inside: avoid; }
  h2, h3 { break-after: avoid; }
  .table { overflow: visible; }
}
</style>
</head>
<body>
<main>
<header>
<h1>{{.Name}}</h1>
<p>RNAxRay Desktop project report · {{.Generated}}</p>
</header>
{{range .Notes}}<p class="note">{{.}}</p>
{{end}}
<section id="project">
<h2>Project</h2>
<dl class="facts">{{range .Facts}}
<dt>{{index . 0}}</dt><dd>{{index . 1}}</dd>{{end}}
</dl>
</section>

<section id="checks">
<h2>Before you report these results</h2>
<ul>{{range .Checks}}
<li>{{.}}</li>{{end}}
</ul>
</section>

<section id="references">
<h2>References</h2>
{{if .ReferenceTable.Rows}}{{template "table" .ReferenceTable}}{{else}}<p class="muted">No reference in this project.</p>{{end}}
</section>

<section id="samples">
<h2>Samples</h2>
{{if .SampleTable.Rows}}{{template "table" .SampleTable}}
<p class="meta">Hybrids and reads from the analysis index of each analysed sample; intra / inter are shares of hybrids within one RNA / between two.</p>
{{else}}<p class="muted">No sample in this project.</p>{{end}}
</section>

<section id="conditions">
<h2>Conditions</h2>
{{if .ConditionTable.Rows}}{{template "table" .ConditionTable}}
<p class="meta">Counts add up the analysed replicates of each condition.</p>
{{else}}<p class="muted">No condition: samples have no condition set.</p>{{end}}
</section>

<section id="pipeline">
<h2>Pipeline settings and input files</h2>
{{if .InputTable.Rows}}{{template "table" .InputTable}}{{else}}<p class="muted">No input file in this project.</p>{{end}}
{{if .SettingsTable.Rows}}{{template "table" .SettingsTable}}{{end}}
<p class="meta">{{.FingerprintNote}}</p>
</section>

<section id="differential-tests">
<h2>Differential tests</h2>
{{if .TestDetails}}{{template "table" .TestTable}}
{{range .TestDetails}}<div class="test">
<h3>{{.LabelA}} vs {{.LabelB}}</h3>
<p class="meta">{{join .Genes ", "}} · {{.Params}} · log2 fold change = A / B · {{time .Created}} · {{.ID}}</p>
<div class="stats">
<div class="stat"><span>Cells tested</span><b>{{count .Summary.CellsTested}}</b></div>
<div class="stat"><span>Significant cells</span><b>{{count .Summary.Significant}}</b></div>
<div class="stat"><span>Higher in {{.LabelA}}</span><b class="up">{{count .Summary.SignificantUp}}</b></div>
<div class="stat"><span>Higher in {{.LabelB}}</span><b class="down">{{count .Summary.SignificantDown}}</b></div>
<div class="stat"><span>Interactions A / B</span><b>{{count .Summary.InteractionsUp}} / {{count .Summary.InteractionsDown}}</b></div>
</div>
{{if .Err}}<p class="note">Could not read the results: {{.Err}}</p>{{end}}
<div class="cols">
{{if .Figure}}<figure>{{.Figure}}<figcaption>{{.Caption}}</figcaption></figure>{{end}}
{{if .Table.Rows}}<div class="table"><p class="meta">Top {{len .Table.Rows}} merged interactions by padj</p>{{template "rows" .Table}}</div>{{else}}<p class="muted">No significant interaction.</p>{{end}}
</div>
{{if .SimFigure}}<div class="cols"><figure>{{.SimFigure}}<figcaption>{{.SimCaption}}</figcaption></figure></div>{{end}}
{{if .EnergyFigure}}<figure>{{.EnergyFigure}}<figcaption>{{.EnergyCaption}}</figcaption></figure>{{end}}
</div>
{{end}}{{else}}<p class="muted">No differential test has been run.</p>{{end}}
</section>

<section id="structures">
<h2>Structures</h2>
{{if .StructureDetails}}{{template "table" .StructureTable}}
{{range .StructureDetails}}<div class="structure">
<h3>{{.Gene}}</h3>
<p class="meta">{{.Line}}</p>
{{if .Err}}<p class="note">Could not read the structure: {{.Err}}</p>{{end}}
{{if .Figure}}<figure>{{.Figure}}<figcaption>{{.Caption}}</figcaption></figure>{{end}}
</div>
{{end}}{{else}}<p class="muted">No structure has been folded.</p>{{end}}
</section>

<section id="external-sources">
<h2>External sources and researcher notes</h2>
{{if .Evidence}}{{range .Evidence}}<div class="evidence">
<h3>{{.Title}}</h3>
<p class="boundary">{{.Boundary}}</p>
<dl class="facts">{{range .Facts}}
<dt>{{index . 0}}</dt><dd>{{index . 1}}</dd>{{end}}
</dl>
{{if .Text}}<blockquote>{{.Text}}</blockquote>{{end}}
</div>
{{end}}<p class="meta">{{.EvidenceNote}}</p>
{{else}}<p class="muted">No external source is included in this report.</p>{{end}}
</section>

<footer>
{{range $i, $f := .Runtime}}{{if $i}} · {{end}}{{index $f 0}}: {{index $f 1}}{{end}}
</footer>
</main>
</body>
</html>
{{define "table"}}<div class="table">{{template "rows" .}}</div>{{end}}
{{define "rows"}}<table>
<thead><tr>{{range .Cols}}<th{{if .Num}} class="num"{{end}}>{{.Title}}</th>{{end}}</tr></thead>
<tbody>{{$cols := .Cols}}{{range .Rows}}
<tr>{{range $i, $v := .}}<td{{if (index $cols $i).Num}} class="num"{{end}}>{{range $k, $l := lines $v}}{{if $k}}<br><span class="sub">{{$l}}</span>{{else}}{{$l}}{{end}}{{end}}</td>{{end}}</tr>{{end}}
</tbody>
</table>{{end}}
`))
