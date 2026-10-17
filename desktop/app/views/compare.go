package views

// ④ Compare: condition (or sample) A vs B.
//
// The main path is the differential test: a `compare` task runs DESeq2 on
// the 10-nt contact maps of the replicates (desktop/runtime/compare.py), and
// its registered result (`list_comparisons` / `read_comparison`) shows as a
// padj-weighted map of the significant cells plus the merged interactions.
// An interaction can be located on Explore's contact map, opened in Region,
// or folded once with A's and once with B's evidence ("Fold A & B").
//
// Under a test, compare_panels.go adds its enriched regions' local
// structures (structure_regions) and the folding energy of its interactions
// (an `energy` task, read_energy).
//
// "Quick view" is the descriptive comparison: the `compare_bins` query
// (library-size normalised, no statistics).
//
// Navigate options consumed by Show:
//
//	{"comparisonId": "<id>"}   select a result (the tasks drawer sends it)
//
// Navigate options produced:
//
//	explore:   {"view": "contact-map" | "region", "selectionKey": "c:AFR",
//	            "sampleIds": [...], "gene": "<gene>", "binSize": 10,
//	            "x": <arm 1 start>, "y": <arm 2 start>,
//	            "xEnd": x+binSize-1, "yEnd": y+binSize-1}
//	           The top bar's selection and gene are set to the same values
//	           first, so Explore shows the right data even if it ignores the
//	           focus fields.
//	structure: {"pair": [taskIdA, taskIdB], "pairLabels": [labelA, labelB]}
//	           (Fold A & B: the Structure page shows A above, B below once
//	           both finish).

import (
	"fmt"
	"math"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
	"rnaxraydesktop/widgets"
)

func init() {
	RegisterPageFactory("compare", func(a *App) Page { return newComparePage(a) })
	OnTaskFinished(func(a *App, t model.Task) {
		if t.Kind != "compare" {
			return
		}
		if p, ok := a.pages["compare"].(*comparePage); ok && a.Project != nil {
			p.loadList()
		}
	})
}

var (
	cmpRed  = ui.RGB(214, 69, 65)
	cmpBlue = ui.RGB(43, 108, 196)
)

// ---- data

type comparisonParams struct {
	MinCount   *float64 `json:"min_count"`
	Range      *float64 `json:"range"`
	PadjCutoff *float64 `json:"padj_cutoff"`
	SimMin     *float64 `json:"similarity_min"`
	GeneID     *string  `json:"gene_id"`
}

type comparisonSummary struct {
	CellsTested      int64     `json:"cells_tested"`
	Significant      int64     `json:"significant"`
	SignificantUp    int64     `json:"significant_up"`
	SignificantDown  int64     `json:"significant_down"`
	Interactions     int64     `json:"interactions"`
	InteractionsUp   int64     `json:"interactions_up"`
	InteractionsDown int64     `json:"interactions_down"`
	MaxCoordinate    int64     `json:"max_coordinate"`
	SizeFactors      []float64 `json:"size_factors"`
	SimilarityCells  int64     `json:"similarity_cells"`
	SimilarityCap    float64   `json:"similarity_cap"`
}

type comparisonEntry struct {
	ID         string            `json:"id"`
	TaskID     string            `json:"task_id"`
	SamplesOne []string          `json:"samples_one"`
	SamplesTwo []string          `json:"samples_two"`
	LabelOne   string            `json:"label_one"`
	LabelTwo   string            `json:"label_two"`
	Genes      []string          `json:"genes"`
	Parameters comparisonParams  `json:"parameters"`
	CreatedAt  string            `json:"created_at"`
	Paths      map[string]string `json:"paths"`
	Summary    comparisonSummary `json:"summary"`
	Available  *bool             `json:"available"`
}

type cmpInteraction struct {
	Direction string   `json:"direction"`
	X         int      `json:"x"`
	Y         int      `json:"y"`
	LFC       *float64 `json:"log2FoldChange"`
	Padj      *float64 `json:"padj"`
	BaseMean  *float64 `json:"baseMean"`
}

type comparisonResult struct {
	Summary comparisonSummary `json:"summary"`
	Cells   struct {
		X        []int      `json:"x"`
		Y        []int      `json:"y"`
		LFC      []*float64 `json:"log2FoldChange"`
		Padj     []*float64 `json:"padj"`
		BaseMean []*float64 `json:"baseMean"`
	} `json:"cells"`
	CellsTotal   int64            `json:"cells_total"`
	Truncated    bool             `json:"truncated"`
	Interactions []cmpInteraction `json:"interactions"`
	// Similarity is RNAxRay's similarity heatmap (bin/plot_similarity_map on
	// the two conditions' merged maps), strongest cells first; nil for tests
	// made before it existed.
	Similarity *struct {
		X     []int `json:"x"`
		Y     []int `json:"y"`
		Count []int `json:"count"`
	} `json:"similarity"`
}

// cmpQuickResult is compare_bins' result.
type cmpQuickResult struct {
	Gene     string     `json:"gene"`
	BinSize  int        `json:"bin_size"`
	Length   int        `json:"length"`
	Cells    int64      `json:"cells"`
	LibraryA *float64   `json:"library_a"`
	LibraryB *float64   `json:"library_b"`
	X        []int      `json:"x"`
	Y        []int      `json:"y"`
	ACount   []float64  `json:"a_count"`
	BCount   []float64  `json:"b_count"`
	A        []float64  `json:"a"`
	B        []float64  `json:"b"`
	Log2     []*float64 `json:"log2ratio"`
}

type cmpQuickRow struct {
	X, Y  int
	A, B  float64
	Ratio *float64 // log2 A/B
}

// cmpContext names the two groups of a result for Locate / Region / Fold.
type cmpContext struct {
	KeyA, KeyB     string
	IDsA, IDsB     []string
	GeneA, GeneB   string
	LabelA, LabelB string
	Bin, Pad       int
}

// cmpTarget is one row the actions act on.
type cmpTarget struct {
	X, Y      int
	HigherInB bool
}

type cmpFoldPlan struct {
	ctx        cmpContext
	start, end int
}

// ---- page

const (
	cmpModeTest = iota
	cmpModeQuick
)

type comparePage struct {
	a       *App
	project string

	keyA, keyB string
	minCount   float64
	mergeRange float64
	padj       float64
	simMin     float64
	settings   bool
	runMsg     string

	comparisons []comparisonEntry
	listErr     string
	loading     bool
	reloadAgain bool // a task finished while the list was loading

	mode       int
	selectedID string
	cache      map[string]*comparisonResult
	reading    map[string]bool
	readErr    map[string]string

	direction int // 0 all, 1 higher in A (up), 2 higher in B (down)
	table     ui.ListState
	row       int
	heat      *widgets.Heatmap
	heatKey   string
	simHeat   *widgets.Heatmap
	simKey    string
	shown     []cmpInteraction
	shownKey  string

	quick struct {
		busy     bool
		err      string
		data     *cmpQuickResult
		keyA     string
		keyB     string
		gene     string
		idsA     []string
		idsB     []string
		bin      string
		minCount float64
		rows     []cmpQuickRow
		rowsKey  string
		table    ui.ListState
		row      int
		heat     *widgets.Heatmap
		heatKey  string
	}

	foldOpen bool
	fold     cmpFoldPlan

	// panels of the selected test (compare_panels.go)
	panels cmpPanels
}

func newComparePage(a *App) *comparePage {
	p := &comparePage{a: a}
	p.reset()
	return p
}

func (p *comparePage) reset() {
	p.minCount, p.mergeRange, p.padj, p.simMin = 2, 100, 0.05, 1
	p.keyA, p.keyB = "", ""
	p.comparisons, p.listErr, p.loading = nil, "", false
	p.mode, p.selectedID = cmpModeTest, ""
	p.cache = map[string]*comparisonResult{}
	p.reading = map[string]bool{}
	p.readErr = map[string]string{}
	p.direction, p.row = 0, -1
	p.table.Selected = &p.row
	p.heat = widgets.NewHeatmap()
	// 10-nt cells are a fraction of a pixel on a whole genome: draw each
	// significant one at least 3 DIPs wide so it can be seen.
	p.heat.MinCell = 3
	p.simHeat = widgets.NewHeatmap()
	p.simHeat.MinCell = 3
	p.heatKey, p.simKey, p.shownKey = "", "", ""
	p.quick.busy, p.quick.err, p.quick.data = false, "", nil
	p.quick.bin, p.quick.minCount, p.quick.row = "50 nt", 5, -1
	p.quick.table.Selected = &p.quick.row
	p.quick.heat = widgets.NewHeatmap()
	p.quick.heatKey, p.quick.rowsKey = "", ""
	p.foldOpen = false
	p.runMsg = ""
	p.panels.reset()
}

func (p *comparePage) Show() {
	a := p.a
	if a.Project == nil {
		return
	}
	if a.Project.Path != p.project {
		p.project = a.Project.Path
		p.reset()
	}
	p.defaultGroups()
	if id, _ := a.NavOptions["comparisonId"].(string); id != "" {
		p.selectedID = id
		p.mode = cmpModeTest
		p.row = -1
		a.NavOptions = nil
	}
	p.loadList()
}

// defaultGroups picks the first two conditions (or selections) for A and B.
func (p *comparePage) defaultGroups() {
	options := p.a.SelectionOptions()
	var conditions []SelectionOption
	keys := map[string]bool{}
	for _, o := range options {
		keys[o.Key] = true
		if o.Group == "Conditions" {
			conditions = append(conditions, o)
		}
	}
	pool := options
	if len(conditions) >= 2 {
		pool = conditions
	}
	if !keys[p.keyA] {
		p.keyA = ""
		if len(pool) > 0 {
			p.keyA = pool[0].Key
		}
	}
	if !keys[p.keyB] || p.keyB == p.keyA {
		p.keyB = ""
		for _, o := range pool {
			if o.Key != p.keyA {
				p.keyB = o.Key
				break
			}
		}
	}
}

// ---- loading

func (p *comparePage) loadList() {
	a := p.a
	if a.Project == nil {
		return
	}
	if p.loading {
		p.reloadAgain = true
		return
	}
	path := a.Project.Path
	p.loading = true
	a.Go(func() func() {
		listed, err := a.B.ProjectOp(path, "list_comparisons", nil)
		var entries []comparisonEntry
		if err == nil {
			err = model.Decode(listed["comparisons"], &entries)
		}
		return func() {
			if a.Project == nil || a.Project.Path != path {
				return
			}
			p.loading = false
			if p.reloadAgain {
				p.reloadAgain = false
				defer p.loadList()
			}
			if err != nil {
				p.listErr = err.Error()
				return
			}
			p.listErr = ""
			p.comparisons = entries
			// A re-run may reuse nothing, but results can change on disk.
			for _, e := range entries {
				if p.readErr[e.ID] != "" {
					delete(p.readErr, e.ID)
				}
			}
			if p.selectedID == "" && len(entries) > 0 && p.mode == cmpModeTest {
				p.selectedID = entries[0].ID
			}
			p.ensureResult()
		}
	})
}

func (p *comparePage) entry(id string) *comparisonEntry {
	for i := range p.comparisons {
		if p.comparisons[i].ID == id {
			return &p.comparisons[i]
		}
	}
	return nil
}

// ensureResult reads the selected comparison once.
func (p *comparePage) ensureResult() {
	a := p.a
	id := p.selectedID
	if id == "" || p.entry(id) == nil || p.cache[id] != nil || p.reading[id] || p.readErr[id] != "" || a.Project == nil {
		return
	}
	path := a.Project.Path
	p.reading[id] = true
	a.Go(func() func() {
		raw, err := a.B.ProjectOp(path, "read_comparison", core.Obj{"comparison_id": id, "limit": 250000})
		var result comparisonResult
		if err == nil {
			err = model.Decode(raw, &result)
		}
		return func() {
			if a.Project == nil || a.Project.Path != path {
				return
			}
			delete(p.reading, id)
			if err != nil {
				p.readErr[id] = err.Error()
				return
			}
			p.cache[id] = &result
		}
	})
}

func (p *comparePage) selectComparison(id string) {
	p.selectedID = id
	p.mode = cmpModeTest
	p.row = -1
	p.ensureResult()
}

// referenceNotice warns when A and B are mapped to different references:
// the test compares their positions 1:1, which is only meaningful when the
// references are colinear (e.g. two strains of one virus).
func (p *comparePage) referenceNotice() string {
	a := p.a
	refs := func(key string) []string {
		var out []string
		for _, id := range a.SelectionIDs(key) {
			if s := a.Project.Sample(id); s != nil && s.ReferenceID != "" && !slices.Contains(out, s.ReferenceID) {
				out = append(out, s.ReferenceID)
			}
		}
		return out
	}
	refA, refB := refs(p.keyA), refs(p.keyB)
	if len(refA) == 0 || len(refB) == 0 || slices.Equal(refA, refB) {
		return ""
	}
	name := func(ids []string) string {
		var out []string
		for _, id := range ids {
			if r := a.Project.Reference(id); r != nil {
				out = append(out, nameOr(r.Label, r.ID))
			} else {
				out = append(out, id)
			}
		}
		return strings.Join(out, ", ")
	}
	return fmt.Sprintf("A is mapped to %s and B to %s: positions are compared 1:1, which assumes the references are aligned position by position.",
		name(refA), name(refB))
}

// ---- actions

func (p *comparePage) runTest() {
	a := p.a
	p.runMsg = ""
	idsA, idsB := a.SelectionIDs(p.keyA), a.SelectionIDs(p.keyB)
	if len(idsA) == 0 || len(idsB) == 0 {
		p.runMsg = "Choose two analysed groups."
		return
	}
	for _, id := range idsA {
		for _, other := range idsB {
			if id == other {
				p.runMsg = "A and B share samples; choose two different groups."
				return
			}
		}
	}
	if len(idsA)+len(idsB) < 3 {
		p.runMsg = "The test needs at least three samples (two replicates in one condition)."
		return
	}
	var missing []string
	for _, id := range append(append([]string{}, idsA...), idsB...) {
		if s := a.Project.Sample(id); s == nil || !s.HasHyb() {
			missing = append(missing, p.sampleName(id))
		}
	}
	if len(missing) > 0 {
		p.runMsg = "Run these samples first: " + strings.Join(missing, ", ")
		return
	}
	labelA, labelB := a.SelectionLabel(p.keyA), a.SelectionLabel(p.keyB)
	req := core.TaskStartRequest{Kind: "compare", SamplesOne: idsA, SamplesTwo: idsB,
		Parameters: map[string]any{"min_count": int(p.minCount), "range": int(p.mergeRange), "padj_cutoff": p.padj,
			"similarity_min": int(math.Max(1, p.simMin)), "label_one": labelA, "label_two": labelB}}
	a.StartTask(req, "Differential test · "+labelA+" vs "+labelB, func(t model.Task, err error) {
		if err != nil {
			p.runMsg = "Could not start the test: " + err.Error()
			return
		}
		p.selectedID = t.TaskID
		p.mode = cmpModeTest
		p.row = -1
	})
}

func (p *comparePage) sampleName(id string) string {
	if p.a.Project != nil {
		if s := p.a.Project.Sample(id); s != nil {
			return s.Label()
		}
	}
	return id
}

func (p *comparePage) sampleNames(ids []string) string {
	names := make([]string, len(ids))
	for i, id := range ids {
		names[i] = p.sampleName(id)
	}
	return strings.Join(names, ", ")
}

// context derives the groups of a result: a condition key when the samples
// are exactly one condition's analysed samples, else the first sample.
func (p *comparePage) context(e *comparisonEntry) cmpContext {
	a := p.a
	keyFor := func(ids []string) string {
		if len(ids) == 0 {
			return ""
		}
		conditions := map[string]bool{}
		for _, id := range ids {
			if s := a.Project.Sample(id); s != nil && s.Condition != "" {
				conditions[s.Condition] = true
			}
		}
		if len(conditions) == 1 {
			for name := range conditions {
				all := a.SelectionIDs("c:" + name)
				if len(all) == len(ids) && cmpSameSet(all, ids) {
					return "c:" + name
				}
			}
		}
		return "s:" + ids[0]
	}
	geneFor := func(ids []string) string {
		if e.Parameters.GeneID != nil && *e.Parameters.GeneID != "" {
			return *e.Parameters.GeneID
		}
		if len(ids) > 0 {
			if s := a.Project.Sample(ids[0]); s != nil && s.GeneID != "" {
				return s.GeneID
			}
		}
		if len(e.Genes) > 0 {
			return e.Genes[0]
		}
		return a.Selected.Gene
	}
	pad := 100
	if e.Parameters.Range != nil {
		pad = int(*e.Parameters.Range)
	}
	return cmpContext{KeyA: keyFor(e.SamplesOne), KeyB: keyFor(e.SamplesTwo), IDsA: e.SamplesOne, IDsB: e.SamplesTwo,
		GeneA: geneFor(e.SamplesOne), GeneB: geneFor(e.SamplesTwo),
		LabelA: nameOr(e.LabelOne, p.sampleNames(e.SamplesOne)), LabelB: nameOr(e.LabelTwo, p.sampleNames(e.SamplesTwo)),
		Bin: 10, Pad: pad}
}

func cmpSameSet(a, b []string) bool {
	set := map[string]bool{}
	for _, x := range a {
		set[x] = true
	}
	for _, x := range b {
		if !set[x] {
			return false
		}
	}
	return true
}

// referenceOf returns the reference holding a gene.
func (p *comparePage) referenceOf(gene string) string {
	for _, r := range p.a.Project.References {
		for _, s := range r.Sequences {
			if s.Name == gene {
				return r.ID
			}
		}
	}
	return ""
}

// locate opens Explore on the group where the cell is stronger.
func (p *comparePage) locate(row cmpTarget, ctx cmpContext, view string) {
	a := p.a
	key, ids, gene := ctx.KeyA, ctx.IDsA, ctx.GeneA
	if row.HigherInB {
		key, ids, gene = ctx.KeyB, ctx.IDsB, ctx.GeneB
	}
	if ref := p.referenceOf(gene); ref != "" {
		a.Selected.ReferenceID = ref
	}
	a.Selected.Gene = gene
	if key != "" {
		a.Selected.Key = key
	}
	a.normalizeSelection()
	a.Navigate("explore", map[string]any{
		"view": view, "selectionKey": key, "sampleIds": append([]string(nil), ids...), "gene": gene,
		"binSize": ctx.Bin, "x": row.X, "y": row.Y, "xEnd": row.X + ctx.Bin - 1, "yEnd": row.Y + ctx.Bin - 1,
	})
}

// planFold opens the confirmation for two window folds around a row.
func (p *comparePage) planFold(row cmpTarget, ctx cmpContext) {
	start := cmpMax(1, cmpMin(row.X, row.Y)-ctx.Pad)
	end := cmpMax(row.X, row.Y) + ctx.Bin - 1 + ctx.Pad
	if length := p.a.Project.GeneLength(ctx.GeneA); length > 0 && end > length {
		end = length
	}
	p.fold = cmpFoldPlan{ctx: ctx, start: start, end: end}
	p.foldOpen = true
}

// startFold starts the A fold, then the B fold, then shows Structure.
func (p *comparePage) startFold() {
	a := p.a
	plan := p.fold
	p.foldOpen = false
	type group struct {
		ids         []string
		gene, label string
	}
	groups := []group{{plan.ctx.IDsA, plan.ctx.GeneA, plan.ctx.LabelA}, {plan.ctx.IDsB, plan.ctx.GeneB, plan.ctx.LabelB}}
	var started []string
	var next func(i int)
	next = func(i int) {
		if i >= len(groups) {
			if len(started) == 0 {
				return
			}
			options := map[string]any{}
			if len(started) == 2 {
				options["pair"] = started
				options["pairLabels"] = []string{plan.ctx.LabelA, plan.ctx.LabelB}
			} else {
				options["structureId"] = started[0]
			}
			a.Navigate("structure", options)
			return
		}
		g := groups[i]
		end := plan.end
		if length := a.Project.GeneLength(g.gene); length > 0 && end > length {
			end = length
		}
		gene, mode := g.gene, "windows"
		req := core.TaskStartRequest{Kind: "structure", SampleIDs: append([]string(nil), g.ids...), GeneID: &gene, Mode: &mode,
			Windows:    []core.Window{{Start: uint64(plan.start), End: uint64(end)}},
			Parameters: map[string]any{"allow_pseudoknot": true}}
		mem := StructureMemClaim(req, a.Project.GeneLength(g.gene), true)
		req.MemMB = &mem
		label := fmt.Sprintf("Structure · %s · %d-%d", g.label, plan.start, end)
		a.StartTask(req, label, func(t model.Task, err error) {
			if err != nil {
				a.Toast("Could not start the fold: %s", StructureStartError(err, mem))
			} else {
				started = append(started, t.TaskID)
			}
			next(i + 1)
		})
	}
	next(0)
}

func (p *comparePage) runQuick() {
	a := p.a
	p.runMsg = ""
	idsA, idsB := a.SelectionIDs(p.keyA), a.SelectionIDs(p.keyB)
	if len(idsA) == 0 || len(idsB) == 0 {
		p.runMsg = "Choose two analysed groups."
		return
	}
	if p.keyA == p.keyB {
		p.runMsg = "A and B are the same selection."
		return
	}
	gene := a.Selected.Gene
	if gene == "" {
		p.runMsg = "Choose a gene in the top bar."
		return
	}
	bin, _ := strconv.Atoi(strings.TrimSuffix(p.quick.bin, " nt"))
	if bin <= 0 {
		bin = 50
	}
	q := &p.quick
	q.busy, q.err, q.data, q.row = true, "", nil, -1
	q.keyA, q.keyB, q.gene, q.idsA, q.idsB = p.keyA, p.keyB, gene, idsA, idsB
	p.mode = cmpModeQuick
	path := a.Project.Path
	a.Go(func() func() {
		raw, err := a.B.Query(path, "compare_bins", core.Obj{"sample_ids_a": idsA, "sample_ids_b": idsB, "gene": gene,
			"bin_size": bin, "max_cells": 400000})
		var result cmpQuickResult
		if err == nil {
			err = model.Decode(raw, &result)
		}
		return func() {
			if a.Project == nil || a.Project.Path != path {
				return
			}
			q.busy = false
			if err != nil {
				q.err = err.Error()
				return
			}
			q.data = &result
			q.rowsKey, q.heatKey = "", ""
		}
	})
}

// ---- view

func (p *comparePage) View(c *ui.Context) {
	ui.Scroll(c).Fill().Children(func() {
		ui.Column(c).Padding(24).Gap(16).Children(func() {
			PageHeader(c, "Compare", "Differential contacts between two conditions: DESeq2 on the 10-nt contact maps of the replicates (as rnaxray_compare), merged into interactions.")
			p.controls(c)
			p.list(c)
			if p.mode == cmpModeQuick {
				p.quickView(c)
			} else {
				p.results(c)
			}
		})
	})
	p.foldDialog(c)
}

func (p *comparePage) controls(c *ui.Context) {
	a := p.a
	t := c.Theme()
	Card(c, "", func() {
		options := a.SelectionOptions()
		if len(options) < 2 {
			ui.Text(c, "Comparisons need two analysed conditions or samples. Set conditions on the Data page and run the samples.").TextColor(t.TextMuted)
			return
		}
		ui.Row(c).Gap(12).AlignItems(ui.End).Wrap().Children(func() {
			p.groupPicker(c.Key("cmp-a"), "A (condition one)", &p.keyA, cmpRed, options)
			ui.Text(c, "vs").TextColor(t.TextMuted).Margin(0, 0, 8, 0)
			p.groupPicker(c.Key("cmp-b"), "B (condition two)", &p.keyB, cmpBlue, options)
			ui.Spacer(c)
			ui.Column(c).Gap(4).Children(func() {
				ui.Text(c, fmt.Sprintf("%d + %d replicates", len(a.SelectionIDs(p.keyA)), len(a.SelectionIDs(p.keyB)))).
					FontSize(12).Bold().TextColor(t.TextMuted)
				ui.Row(c).Gap(8).Children(func() {
					if ui.PrimaryButton(c, "Run differential test").Clicked() {
						p.runTest()
					}
					label := "Quick view"
					if p.quick.busy {
						label = "Binning…"
					}
					if ui.Button(c, label).Tooltip("Library-size normalised difference, no statistics").Disabled(p.quick.busy).Clicked() {
						p.runQuick()
					}
				})
			})
		})
		if p.runMsg != "" {
			ui.Text(c, p.runMsg).TextColor(t.Danger)
		}
		if notice := p.referenceNotice(); notice != "" {
			ui.Text(c, notice).FontSize(12).TextColor(t.Warning)
		}
		ui.Collapsible(c.Key("cmp-settings"), "Settings", &p.settings, func() {
			ui.Column(c).Gap(8).Padding(8, 0, 0, 0).Children(func() {
				ui.Row(c).Gap(16).Wrap().Children(func() {
					Field(c, "Keep cells with total count >", func() {
						ui.NumberInput(c.Key("cmp-min"), &p.minCount, 0, 1e6, 1).Width(110).Label("Minimum count")
					})
					Field(c, "Merge range (nt)", func() {
						ui.NumberInput(c.Key("cmp-range"), &p.mergeRange, 0, 10000, 10).Width(110).Label("Merge range")
					})
					Field(c, "padj cutoff", func() {
						ui.NumberInput(c.Key("cmp-padj"), &p.padj, 0.0001, 1, 0.01).Width(110).Label("padj cutoff")
					})
					Field(c, "Similarity: keep cells with count ≥", func() {
						ui.NumberInput(c.Key("cmp-simmin"), &p.simMin, 1, 1e6, 1).Width(110).Label("Similarity minimum count")
					})
					Field(c, "Quick view bin", func() {
						ui.Select(c.Key("cmp-bin"), &p.quick.bin, []string{"10 nt", "25 nt", "50 nt", "100 nt", "200 nt"}).Width(110).Label("Quick view bin")
					})
					Field(c, "Quick view min. count", func() {
						ui.NumberInput(c.Key("cmp-qmin"), &p.quick.minCount, 0, 1e6, 1).Width(110).Label("Quick view minimum count")
					})
				})
				ui.Text(c, "Only the differential test says whether a contact differs: it uses the replicates as the noise estimate and gives a padj per 10-nt cell, so it needs at least two biological replicates per condition. The quick view and the similarity heatmap only describe counts. The test follows rnaxray_compare: DESeq2 Wald test (condition one vs two, alpha 0.01, independent filtering); cells with padj below the cutoff are significant, and significant cells within the merge range of a stronger one are merged into it. The similarity heatmap follows plot_similarity_map: each condition's replicates are summed into one map (as if their .hyb files were concatenated), cells below the similarity minimum are dropped from each map, and a cell in both maps shows the smaller count (1 keeps every cell, as rnaxray does).").
					FontSize(12).TextColor(t.TextMuted)
			})
		})
	})
}

func (p *comparePage) groupPicker(c *ui.Context, label string, key *string, color ui.Color, options []SelectionOption) {
	var labels []string
	keys := map[string]string{}
	current := ""
	for _, o := range options {
		labels = append(labels, o.Label)
		keys[o.Label] = o.Key
		if o.Key == *key {
			current = o.Label
		}
	}
	ui.Column(c).Gap(4).Children(func() {
		ui.Text(c, label).FontSize(12).Bold().TextColor(color)
		ui.Select(c.Key("select"), &current, labels).Width(240).Label(label).OnChange(func() {
			*key = keys[current]
			p.runMsg = ""
		})
	})
}

// ---- tests list

func (p *comparePage) list(c *ui.Context) {
	a := p.a
	t := c.Theme()
	Card(c, "", func() {
		ui.Row(c).Children(func() {
			ui.Text(c, "Differential tests").FontSize(16).Bold().Grow(1)
			if ui.Button(c, "Refresh").Clicked() {
				p.cache = map[string]*comparisonResult{}
				p.readErr = map[string]string{}
				p.loadList()
			}
		})
		running := cmpTaskRows(c, a, "compare")
		if p.listErr != "" {
			// Not "no tests yet": the list is unknown.
			ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
				ui.Text(c, "Could not list comparisons: "+ShortError(p.listErr)).TextColor(t.Danger).Grow(1).Shrink(1).MinWidth(0)
				if ui.Button(c, "Retry").Clicked() {
					p.loadList()
				}
			})
			if len(p.comparisons) == 0 && running == 0 {
				return
			}
		}
		if len(p.comparisons) == 0 && running == 0 {
			msg := "No differential tests yet. Pick A and B, then Run differential test."
			if p.loading {
				msg = "Loading…"
			}
			ui.Text(c, msg).TextColor(t.TextMuted)
			return
		}
		for i := range p.comparisons {
			e := &p.comparisons[i]
			selected := p.mode == cmpModeTest && p.selectedID == e.ID
			item := ui.Column(c.Key("cmp-"+e.ID)).Gap(2).Padding(8, 10).Radius(8).Border(1, t.Border)
			if selected {
				item.Background(t.Accent.Alpha(0.10)).BorderColor(t.Accent)
			}
			item.Children(func() {
				title := nameOr(e.LabelOne, p.sampleNames(e.SamplesOne)) + " vs " + nameOr(e.LabelTwo, p.sampleNames(e.SamplesTwo))
				if cmpTitleButton(c, title).Clicked() {
					p.selectComparison(e.ID)
				}
				s := e.Summary
				meta := fmt.Sprintf("%s significant cells (%s higher in A, %s in B) · %s interactions · %s",
					FormatNumber(s.Significant), FormatNumber(s.SignificantUp), FormatNumber(s.SignificantDown),
					FormatNumber(s.Interactions), FormatTime(e.CreatedAt))
				if e.Available != nil && !*e.Available {
					meta += " · files missing"
				}
				ui.Text(c, meta).FontSize(12).TextColor(t.TextMuted)
			})
		}
	})
}

// cmpTaskRows lists running tasks of a kind (progress, Cancel) and its
// interrupted or failed ones of this session (Resume); it returns how many
// are running.
func cmpTaskRows(c *ui.Context, a *App, kind string) int {
	t := c.Theme()
	running := 0
	failed := 0
	for _, task := range a.TaskList() {
		switch {
		case task.Kind != kind:
		case task.Active():
			running++
			ui.Column(c.Key("task-"+task.TaskID)).Gap(4).Padding(8, 10).Radius(8).Border(1, t.Accent.Alpha(0.5)).Children(func() {
				ui.Row(c).Gap(8).Children(func() {
					ui.Text(c, a.TaskLabel(task)).Bold().Grow(1)
					StatusChip(c, task.Status)
					if ui.Button(c, "Cancel").Clicked() {
						a.CancelTask(task.TaskID)
					}
				})
				ProgressBar(c, task)
			})
		case failed < 3 && (task.Status == "interrupted" || (task.Status == "failed" && task.FinishedAt >= a.SessionStart)):
			failed++
			ui.Column(c.Key("task-"+task.TaskID)).Gap(4).Padding(8, 10).Radius(8).Border(1, t.Border).Children(func() {
				ui.Row(c).Gap(8).Children(func() {
					ui.Text(c, a.TaskLabel(task)).Bold().Grow(1)
					StatusChip(c, task.Status)
					if ui.Button(c, "Resume").Clicked() {
						a.ResumeTask(task.TaskID)
					}
				})
				if e := task.ErrorText(); e != "" {
					ui.Text(c, truncate(e, 300)).FontSize(12).TextColor(t.Danger)
				}
			})
		}
	}
	return running
}

// ---- test result

func (p *comparePage) results(c *ui.Context) {
	a := p.a
	t := c.Theme()
	id := p.selectedID
	if id == "" {
		return
	}
	e := p.entry(id)
	if e == nil {
		if task, ok := a.Tasks[id]; ok && task.Active() {
			Card(c, "", func() {
				ui.Text(c, "The test is running; results appear here when it finishes.").TextColor(t.TextMuted)
			})
		}
		return
	}
	result := p.cache[id]
	if result == nil {
		Card(c, "", func() {
			if err := p.readErr[id]; err != "" {
				ui.Text(c, "Could not read the comparison: "+err).TextColor(t.Danger)
			} else {
				ui.Text(c, "Loading results…").TextColor(t.TextMuted)
			}
		})
		return
	}
	ctx := p.context(e)
	shown := p.shownInteractions(result)
	p.syncHeatmap(e, result)
	if p.row >= len(shown) {
		p.row = -1
	}
	Card(c, "", func() {
		s := result.Summary
		cutoff := 0.05
		if e.Parameters.PadjCutoff != nil {
			cutoff = *e.Parameters.PadjCutoff
		}
		ui.Column(c).Gap(2).Children(func() {
			ui.Text(c, ctx.LabelA+" vs "+ctx.LabelB).FontSize(18).Bold()
			ui.Text(c, fmt.Sprintf("%s · DESeq2 on %s cells (10 nt) · padj < %g · log2FC = A / B",
				strings.Join(e.Genes, ", "), FormatNumber(s.CellsTested), cutoff)).FontSize(12).TextColor(t.TextMuted)
		})
		sizeFactors := make([]string, len(s.SizeFactors))
		for i, v := range s.SizeFactors {
			sizeFactors[i] = fmt.Sprintf("%.2f", v)
		}
		ui.Row(c).Gap(10).Wrap().Children(func() {
			cmpStat(c, "Significant cells", FormatNumber(s.Significant), t.Text)
			cmpStat(c, "Higher in "+ctx.LabelA, FormatNumber(s.SignificantUp), cmpRed)
			cmpStat(c, "Higher in "+ctx.LabelB, FormatNumber(s.SignificantDown), cmpBlue)
			cmpStat(c, "Interactions A / B", FormatNumber(s.InteractionsUp)+" / "+FormatNumber(s.InteractionsDown), t.Text).
				Tooltip("Merged interactions higher in A / higher in B")
			if n := len(e.SamplesOne); n > 0 && n < len(sizeFactors) {
				cmpStat(c, "Size factors A · B", strings.Join(sizeFactors[:n], " ")+" · "+strings.Join(sizeFactors[n:], " "), t.Text).
					Tooltip("DESeq2 size factors, in sample order: " + strings.Join(append(append([]string{}, e.SamplesOne...), e.SamplesTwo...), ", "))
			} else {
				cmpStat(c, "Size factors", strings.Join(sizeFactors, " "), t.Text)
			}
		})
		ui.Text(c, "padj is corrected over every tested cell. Before reporting an interaction, check that each replicate supports it (open the region in Explore for each sample): a small padj with a low mean count can still come from one replicate.").
			FontSize(12).TextColor(t.TextMuted)
		if result.Truncated {
			ui.Text(c, fmt.Sprintf("The map shows the %s strongest of %s significant cells.",
				FormatNumber(int64(len(result.Cells.X))), FormatNumber(result.CellsTotal))).FontSize(12).TextColor(t.TextMuted)
		}
		ui.Row(c).Gap(16).AlignItems(ui.Start).Children(func() {
			ui.Column(c).Gap(6).Children(func() {
				if row := p.pickedInteraction(shown); row != nil {
					p.heat.Highlight = widgets.Cell{X: float64(row.X - ctx.Pad), Y: float64(row.Y - ctx.Pad),
						W: float64(2*ctx.Pad + ctx.Bin), H: float64(2*ctx.Pad + ctx.Bin)}
				} else {
					p.heat.Highlight = widgets.Cell{}
				}
				ev := p.heat.Show(c.Key("cmp-heat"), p.mapSide(), "Significant cells: red higher in A, blue higher in B; stronger colour, smaller padj")
				if ev.Clicked >= 0 {
					cells := p.heat.Cells()
					cell := cells[ev.Clicked]
					p.pickNearest(shown, cell.X, cell.Y, ctx)
					p.heat.Picked = -1
				}
				cmpLegend(c, ctx.LabelA, ctx.LabelB)
				ui.Row(c).Gap(8).Children(func() {
					if ui.Button(c, "Export SVG…").Tooltip("Save the significant map as shown").Clicked() {
						p.exportMapSVG()
					}
					if ui.Button(c, "Export TSV…").Tooltip("Save all merged interactions as a tab-separated file").Clicked() {
						p.exportInteractionsTSV()
					}
				})
			})
			ui.Column(c).Gap(8).Grow(1).MinWidth(320).Children(func() {
				ui.Row(c).Gap(8).Wrap().Children(func() {
					ui.Text(c, "Merged interactions ("+FormatNumber(int64(len(shown)))+")").Bold().Grow(1)
					previous := p.direction
					ui.Segmented(c.Key("cmp-direction"), &p.direction, "All", "Higher in A", "Higher in B").Label("Direction")
					if p.direction != previous {
						p.row = -1
					}
				})
				p.interactionTable(c, shown)
				var target *cmpTarget
				if row := p.pickedInteraction(shown); row != nil {
					target = &cmpTarget{X: row.X, Y: row.Y, HigherInB: row.LFC != nil && *row.LFC < 0}
				}
				p.actionRow(c, target, ctx)
				var files []string
				for _, k := range sortedKeys(e.Paths) {
					if e.Paths[k] != "" {
						files = append(files, e.Paths[k])
					}
				}
				if len(files) > 0 {
					ui.Text(c, "Files: "+strings.Join(files, ", ")).FontSize(11).TextColor(t.TextMuted)
				}
			})
		})
	})
	p.similarityCard(c, e, result, ctx)
	p.regionsCard(c.Key("cmp-regions"), e, ctx)
	p.energyCard(c.Key("cmp-energy"), e, ctx)
}

// similarityCard shows RNAxRay's similarity heatmap of the test's two groups.
func (p *comparePage) similarityCard(c *ui.Context, e *comparisonEntry, result *comparisonResult, ctx cmpContext) {
	t := c.Theme()
	Card(c, "", func() {
		ui.Text(c, "Similarity heatmap").FontSize(16).Bold()
		if result.Similarity == nil {
			ui.Text(c, "This test was run before the similarity heatmap existed; run it again to get one.").TextColor(t.TextMuted)
			return
		}
		key := e.ID
		if key != p.simKey {
			p.simKey = key
			length := float64(p.mapLength(e, result))
			p.simHeat.SetCells(cmpSimilarityCells(result), length, length)
		}
		minimum := 1.0
		if e.Parameters.SimMin != nil {
			minimum = *e.Parameters.SimMin
		}
		note := fmt.Sprintf("Cells in both %s and %s", ctx.LabelA, ctx.LabelB)
		if minimum > 1 {
			note += fmt.Sprintf(" (count ≥ %g in each)", minimum)
		}
		note += fmt.Sprintf("; green = the smaller of the two summed counts, capped at the 95%% quantile (%g). As rnaxray's plot_similarity_map.", result.Summary.SimilarityCap)
		ui.Text(c, note).FontSize(12).TextColor(t.TextMuted)
		ui.Row(c).Gap(10).Wrap().Children(func() {
			cmpStat(c, "Similar cells", FormatNumber(result.Summary.SimilarityCells), cmpGreen)
			cmpStat(c, "Colour cap", fmt.Sprintf("%g", result.Summary.SimilarityCap), t.Text)
		})
		if n := int64(len(result.Similarity.X)); n < result.Summary.SimilarityCells {
			ui.Text(c, fmt.Sprintf("The map shows the %s strongest of %s cells.", FormatNumber(n),
				FormatNumber(result.Summary.SimilarityCells))).FontSize(12).TextColor(t.TextMuted)
		}
		// similarity_heatmap.R draws on white; keep the theme surface in dark mode
		p.simHeat.Background = ui.Color{}
		if t.Background.R >= 128 {
			p.simHeat.Background = ui.RGB(255, 255, 255)
		}
		p.simHeat.Show(c.Key("cmp-sim-heat"), p.mapSide(), "Similarity heatmap: cells in both groups, green by the smaller count")
		ui.Row(c).Gap(8).Children(func() {
			if ui.Button(c, "Export SVG…").Tooltip("Save the similarity heatmap as shown").Clicked() {
				p.exportSimilaritySVG()
			}
		})
	})
}

// cmpGreen is similarity_heatmap.R's forestgreen.
var cmpGreen = ui.RGB(34, 139, 34)

// cmpSimilarityCells colours the similar cells forestgreen by count / cap
// (white at 0 on a light surface); weakest first so strong cells stay on top.
func cmpSimilarityCells(result *comparisonResult) []widgets.Cell {
	sim := result.Similarity
	if sim == nil {
		return nil
	}
	limit := math.Max(1, result.Summary.SimilarityCap)
	out := make([]widgets.Cell, 0, len(sim.X))
	for i := len(sim.X) - 1; i >= 0; i-- {
		if i >= len(sim.Y) || i >= len(sim.Count) {
			continue
		}
		ratio := math.Min(1, float64(sim.Count[i])/limit)
		out = append(out, widgets.Cell{X: float64(sim.X[i]), Y: float64(sim.Y[i]), W: 10, H: 10,
			Color: cmpGreen.Alpha(float32(0.06 + 0.94*ratio))})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Color.A < out[j].Color.A })
	return out
}

// cmpTitleButton is a list item's title that selects it.
func cmpTitleButton(c *ui.Context, title string) ui.Element {
	t := c.Theme()
	b := ui.ButtonBase(c).Cursor(ui.CursorPointer).Justify(ui.Start).Label(title)
	b.Children(func() { ui.Text(c, title).Bold().TextColor(brandInk(t)) })
	return b
}

func cmpStat(c *ui.Context, label, value string, color ui.Color) ui.Element {
	t := c.Theme()
	// The web app's stat tile, a bordered card.
	return ui.Column(c).Gap(4).Padding(8, 12).Radius(8).Background(t.Background).Border(1, t.Border).MinWidth(120).Children(func() {
		ui.Text(c, label).FontSize(12).TextColor(t.TextMuted)
		ui.Text(c, value).FontSize(18).Bold().TextColor(color)
	})
}

func cmpLegend(c *ui.Context, labelA, labelB string) {
	t := c.Theme()
	ui.Row(c).Gap(14).Children(func() {
		for _, item := range []struct {
			color ui.Color
			label string
		}{{cmpRed, "higher in " + labelA}, {cmpBlue, "higher in " + labelB}} {
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				ui.Box(c).Size(12, 12).Radius(3).Background(item.color)
				ui.Text(c, item.label).FontSize(12).TextColor(t.TextMuted)
			})
		}
	})
}

// shownInteractions: sorted by padj, filtered by direction (cached).
func (p *comparePage) shownInteractions(result *comparisonResult) []cmpInteraction {
	key := fmt.Sprintf("%s/%d", p.selectedID, p.direction)
	if key == p.shownKey {
		return p.shown
	}
	var out []cmpInteraction
	for _, row := range result.Interactions {
		if (p.direction == 1 && row.Direction != "up") || (p.direction == 2 && row.Direction != "down") {
			continue
		}
		out = append(out, row)
	}
	sort.SliceStable(out, func(i, j int) bool { return cmpPadj(out[i].Padj) < cmpPadj(out[j].Padj) })
	p.shown, p.shownKey = out, key
	// A new list starts at its top (a kept ListState keeps its place by key).
	p.table = ui.ListState{}
	return out
}

func cmpPadj(v *float64) float64 {
	if v == nil || math.IsNaN(*v) {
		return math.Inf(1)
	}
	return *v
}

// syncHeatmap rebuilds the map's cells when the result or direction changes.
func (p *comparePage) syncHeatmap(e *comparisonEntry, result *comparisonResult) {
	key := fmt.Sprintf("%s/%d", e.ID, p.direction)
	if key == p.heatKey {
		return
	}
	p.heatKey = key
	p.heat.SetCells(cmpSignificantCells(result, p.direction), float64(p.mapLength(e, result)), float64(p.mapLength(e, result)))
}

func (p *comparePage) mapLength(e *comparisonEntry, result *comparisonResult) int {
	length := 0
	for _, g := range e.Genes {
		length = cmpMax(length, p.a.Project.GeneLength(g))
	}
	if length == 0 {
		length = int(result.Summary.MaxCoordinate) + 10
	}
	return length
}

// cmpSignificantCells colours the significant 10-nt cells: red higher in A,
// blue higher in B, alpha by -log10 padj; weakest first so strong cells
// stay on top.
func cmpSignificantCells(result *comparisonResult, direction int) []widgets.Cell {
	cells := result.Cells
	out := make([]widgets.Cell, 0, len(cells.X))
	for i := len(cells.X) - 1; i >= 0; i-- {
		if i >= len(cells.Y) || i >= len(cells.LFC) || cells.LFC[i] == nil {
			continue
		}
		lfc := *cells.LFC[i]
		if (direction == 1 && lfc < 0) || (direction == 2 && lfc > 0) {
			continue
		}
		padj := 1e-300
		if i < len(cells.Padj) && cells.Padj[i] != nil && *cells.Padj[i] > 0 {
			padj = math.Max(*cells.Padj[i], 1e-300)
		}
		strength := math.Min(1, -math.Log10(padj)/20)
		color := cmpBlue
		if lfc > 0 {
			color = cmpRed
		}
		out = append(out, widgets.Cell{X: float64(cells.X[i]), Y: float64(cells.Y[i]), W: 10, H: 10,
			Color: color.Alpha(float32(0.2 + 0.8*strength))})
	}
	return out
}

func (p *comparePage) pickedInteraction(shown []cmpInteraction) *cmpInteraction {
	if p.row >= 0 && p.row < len(shown) {
		return &shown[p.row]
	}
	return nil
}

// pickNearest chooses the cmpInteraction nearest a clicked cell, within the
// merge range.
func (p *comparePage) pickNearest(shown []cmpInteraction, x, y float64, ctx cmpContext) {
	best, bestDistance := -1, math.Inf(1)
	for i, row := range shown {
		d := math.Max(math.Abs(float64(row.X)-x), math.Abs(float64(row.Y)-y))
		if d < bestDistance {
			best, bestDistance = i, d
		}
	}
	if best >= 0 && bestDistance <= math.Max(float64(ctx.Pad), 10) {
		p.row = best
	}
}

func (p *comparePage) interactionTable(c *ui.Context, shown []cmpInteraction) {
	t := c.Theme()
	if len(shown) == 0 {
		ui.Text(c, "No significant interaction in this direction.").TextColor(t.TextMuted)
		return
	}
	cols := []ui.TableColumn{{Title: "Arm 1 (nt)", Width: 112}, {Title: "Arm 2 (nt)", Width: 112},
		{Title: "log2 A/B", Width: 76, Align: ui.End}, {Title: "padj", Width: 72, Align: ui.End}, {Title: "Mean count", Align: ui.End}}
	p.table.Selected = &p.row
	p.table.Key = func(i int) any { return fmt.Sprintf("%d_%d_%s", shown[i].X, shown[i].Y, shown[i].Direction) }
	ui.Table(c.Key("cmp-table-"+p.shownKey), &p.table, cols, len(shown), func(i, col int) {
		row := shown[i]
		switch col {
		case 0:
			ui.Text(c, fmt.Sprintf("%d–%d", row.X, row.X+9)).SingleLine()
		case 1:
			ui.Text(c, fmt.Sprintf("%d–%d", row.Y, row.Y+9)).SingleLine()
		case 2:
			color := cmpBlue
			if row.LFC != nil && *row.LFC > 0 {
				color = cmpRed
			}
			text := ui.Text(c, cmpFloat(row.LFC, "%.2f"))
			if i != p.row { // the chosen row's text takes the accent's text color
				text.TextColor(color)
			}
		case 3:
			ui.Text(c, cmpFloat(row.Padj, "%.1e"))
		case 4:
			if row.BaseMean == nil {
				ui.Text(c, "—")
			} else {
				ui.Text(c, FormatNumber(int64(math.Round(*row.BaseMean))))
			}
		}
	}).Height(p.mapSide() - 40).Label("Merged interactions")
}

func cmpFloat(v *float64, format string) string {
	if v == nil || math.IsNaN(*v) {
		return "—"
	}
	return fmt.Sprintf(format, *v)
}

// actionRow: Locate, Region and Fold A & B for the chosen row.
func (p *comparePage) actionRow(c *ui.Context, target *cmpTarget, ctx cmpContext) {
	t := c.Theme()
	ui.Row(c).Gap(8).AlignItems(ui.Center).Wrap().Children(func() {
		none := target == nil
		if ui.Button(c, "Locate").Disabled(none).Tooltip("Show this cell on the contact map of the group where it is stronger").Clicked() && !none {
			p.locate(*target, ctx, "contact-map")
		}
		if ui.Button(c, "Region").Disabled(none).Tooltip("Open both arms in Region").Clicked() && !none {
			p.locate(*target, ctx, "region")
		}
		if ui.Button(c, "Fold A & B").Disabled(none).Tooltip("Fold the window spanning both arms with A's and with B's evidence").Clicked() && !none {
			p.planFold(*target, ctx)
		}
		if none {
			ui.Text(c, "Choose a row or a cell on the map.").FontSize(12).TextColor(t.TextMuted)
		} else {
			ui.Text(c, fmt.Sprintf("%d–%d × %d–%d", target.X, target.X+ctx.Bin-1, target.Y, target.Y+ctx.Bin-1)).FontSize(12).TextColor(t.TextMuted)
		}
	})
}

func (p *comparePage) foldDialog(c *ui.Context) {
	if !p.foldOpen {
		return
	}
	t := c.Theme()
	plan := p.fold
	ui.Modal(c.Key("cmp-fold"), &p.foldOpen, func() {
		ui.Column(c).Gap(12).Width(420).Children(func() {
			ui.Text(c, fmt.Sprintf("Fold %s:%d–%d", plan.ctx.GeneA, plan.start, plan.end)).FontSize(16).Bold()
			ui.Text(c, fmt.Sprintf("Two window folds (pseudoknots allowed) of %d nt: one with %s evidence, one with %s evidence. They appear on the Structure page.",
				plan.end-plan.start+1, plan.ctx.LabelA, plan.ctx.LabelB)).TextColor(t.TextMuted)
			ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
				if ui.Button(c, "Cancel").Clicked() {
					p.foldOpen = false
				}
				if ui.PrimaryButton(c, "Start both").Clicked() {
					p.startFold()
				}
			})
		})
	})
}

// ---- quick view

func (p *comparePage) quickRows() []cmpQuickRow {
	q := &p.quick
	if q.data == nil {
		return nil
	}
	key := fmt.Sprintf("%p/%g", q.data, q.minCount)
	if key == q.rowsKey {
		return q.rows
	}
	d := q.data
	counts := func(raw, norm []float64, i int) float64 {
		if i < len(raw) {
			return raw[i]
		}
		if i < len(norm) {
			return norm[i]
		}
		return 0
	}
	var rows []cmpQuickRow
	for i := range d.X {
		if i >= len(d.Y) {
			break
		}
		a, b := counts(d.ACount, d.A, i), counts(d.BCount, d.B, i)
		if a+b < q.minCount {
			continue
		}
		row := cmpQuickRow{X: d.X[i], Y: d.Y[i], A: a, B: b}
		// Backend log2ratio = log2(B / A); shown as A / B.
		if i < len(d.Log2) && d.Log2[i] != nil {
			r := -*d.Log2[i]
			row.Ratio = &r
		}
		rows = append(rows, row)
	}
	abs := func(r *float64) float64 {
		if r == nil {
			return 0
		}
		return math.Abs(*r)
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if abs(rows[i].Ratio) != abs(rows[j].Ratio) {
			return abs(rows[i].Ratio) > abs(rows[j].Ratio)
		}
		return rows[i].A+rows[i].B > rows[j].A+rows[j].B
	})
	q.rows, q.rowsKey = rows, key
	q.row = -1
	q.table = ui.ListState{}
	return rows
}

func (p *comparePage) quickContext() cmpContext {
	q := &p.quick
	bin := 10
	if q.data != nil && q.data.BinSize > 0 {
		bin = q.data.BinSize
	}
	return cmpContext{KeyA: q.keyA, KeyB: q.keyB, IDsA: q.idsA, IDsB: q.idsB, GeneA: q.gene, GeneB: q.gene,
		LabelA: p.a.SelectionLabel(q.keyA), LabelB: p.a.SelectionLabel(q.keyB), Bin: bin}
}

func (p *comparePage) quickView(c *ui.Context) {
	t := c.Theme()
	q := &p.quick
	Card(c, "", func() {
		if q.busy {
			ui.Text(c, "Binning both groups…").TextColor(t.TextMuted)
			return
		}
		if q.err != "" {
			ui.Text(c, "The quick comparison is unavailable: "+q.err).TextColor(t.Danger)
			if ui.Button(c, "Back to tests").Clicked() {
				p.mode = cmpModeTest
			}
			return
		}
		if q.data == nil {
			return
		}
		d := q.data
		ctx := p.quickContext()
		rows := p.quickRows()
		ui.Row(c).Gap(8).Children(func() {
			ui.Column(c).Gap(2).Grow(1).Children(func() {
				ui.Text(c, "Quick view · "+ctx.LabelA+" vs "+ctx.LabelB).FontSize(18).Bold()
				meta := fmt.Sprintf("%s · %d-nt bins · %s cells", q.gene, d.BinSize, FormatNumber(int64(len(d.X))))
				if d.LibraryA != nil && d.LibraryB != nil {
					meta += " · libraries " + FormatNumber(int64(*d.LibraryA)) + " / " + FormatNumber(int64(*d.LibraryB))
				}
				ui.Text(c, meta+" · no statistics; use the differential test for padj").FontSize(12).TextColor(t.TextMuted)
			})
			if ui.Button(c, "Back to tests").Clicked() {
				p.mode = cmpModeTest
			}
		})
		if q.heatKey != q.rowsKey {
			q.heatKey = q.rowsKey
			length := d.Length
			if length <= 0 {
				for i := range d.X {
					length = cmpMax(length, cmpMax(d.X[i], d.Y[i]))
				}
				length += d.BinSize
			}
			q.heat.SetCells(cmpQuickCells(rows, d.BinSize), float64(length), float64(length))
		}
		if q.row >= 0 && q.row < len(rows) {
			r := rows[q.row]
			q.heat.Highlight = widgets.Cell{X: float64(r.X), Y: float64(r.Y), W: float64(d.BinSize), H: float64(d.BinSize)}
		} else {
			q.heat.Highlight = widgets.Cell{}
		}
		ui.Row(c).Gap(16).AlignItems(ui.Start).Children(func() {
			ui.Column(c).Gap(6).Children(func() {
				ev := q.heat.Show(c.Key("quick-heat"), p.mapSide(), "Normalised contact difference, red: higher in A, blue: higher in B")
				if ev.Clicked >= 0 {
					cell := q.heat.Cells()[ev.Clicked]
					for i, r := range rows {
						if float64(r.X) == cell.X && float64(r.Y) == cell.Y {
							q.row = i
						}
					}
					q.heat.Picked = -1
				}
				cmpLegend(c, ctx.LabelA, ctx.LabelB)
			})
			ui.Column(c).Gap(8).Grow(1).MinWidth(320).Children(func() {
				ui.Text(c, "Bins ("+FormatNumber(int64(len(rows)))+")").Bold()
				if len(rows) == 0 {
					ui.Text(c, "No bin reaches the minimum count.").TextColor(t.TextMuted)
				} else {
					cols := []ui.TableColumn{{Title: "Arm 1 (nt)", Width: 112}, {Title: "Arm 2 (nt)", Width: 112},
						{Title: "A", Width: 64, Align: ui.End}, {Title: "B", Width: 64, Align: ui.End}, {Title: "log2 A/B", Align: ui.End}}
					q.table.Selected = &q.row
					q.table.Key = func(i int) any { return [2]int{rows[i].X, rows[i].Y} }
					ui.Table(c.Key("quick-table-"+q.rowsKey), &q.table, cols, len(rows), func(i, col int) {
						r := rows[i]
						switch col {
						case 0:
							ui.Text(c, fmt.Sprintf("%d–%d", r.X, r.X+d.BinSize-1)).SingleLine()
						case 1:
							ui.Text(c, fmt.Sprintf("%d–%d", r.Y, r.Y+d.BinSize-1)).SingleLine()
						case 2:
							ui.Text(c, FormatNumber(int64(r.A)))
						case 3:
							ui.Text(c, FormatNumber(int64(r.B)))
						case 4:
							color := cmpBlue
							if r.Ratio != nil && *r.Ratio > 0 {
								color = cmpRed
							}
							text := ui.Text(c, cmpFloat(r.Ratio, "%.2f"))
							if i != q.row {
								text.TextColor(color)
							}
						}
					}).Height(p.mapSide() - 40).Label("Quick view bins")
				}
				var target *cmpTarget
				if q.row >= 0 && q.row < len(rows) {
					target = &cmpTarget{X: rows[q.row].X, Y: rows[q.row].Y, HigherInB: rows[q.row].B > rows[q.row].A}
				}
				p.actionRow(c, target, ctx)
			})
		})
	})
}

// cmpQuickCells colours bins by log2 A/B: red higher in A, blue higher in B.
func cmpQuickCells(rows []cmpQuickRow, bin int) []widgets.Cell {
	out := make([]widgets.Cell, 0, len(rows))
	for i := len(rows) - 1; i >= 0; i-- {
		r := rows[i]
		if r.Ratio == nil {
			continue
		}
		strength := math.Min(1, math.Abs(*r.Ratio)/3)
		color := cmpBlue
		if *r.Ratio > 0 {
			color = cmpRed
		}
		out = append(out, widgets.Cell{X: float64(r.X), Y: float64(r.Y), W: float64(bin), H: float64(bin),
			Color: color.Alpha(float32(0.15 + 0.85*strength))})
	}
	return out
}

func cmpMin(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func cmpMax(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// mapSide is the side of the Compare maps: about half the page width and
// two thirds of its height.
func (p *comparePage) mapSide() float32 {
	w, h := p.a.ContentSize()
	return clampF(min(w*0.44, h*0.62), 340, 820)
}
