package views

// ⑤ Structure: evidence-guided CPLfold runs (task kind "structure"): the
// whole RNA (pseudoknot-free) or windows (pseudoknots allowed), with every
// chimera of the chosen selection as evidence. Lists saved results
// (list_structures), shows them as arc diagrams (read_structure) and
// compares two structures (A above, B below).
//
// Navigate options consumed by Show:
//
//	{"structureId": "<id>"}                 show a result as A (tasks drawer)
//	{"prefill": {"gene": "<gene>", "windows": [{"start": s, "end": e}],
//	             "selectionKey": "c:AFR", "source": "the contact map"}}
//	                                        fill the form in windows mode with
//	                                        pseudoknots on (Explore's "Fold
//	                                        this region")
//	{"pair": [taskIdA, taskIdB], "pairLabels": [labelA, labelB]}
//	                                        Compare's "Fold A & B": show A, then
//	                                        A and B, as the two tasks finish

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
	"rnaxraydesktop/widgets"
)

func init() {
	RegisterPageFactory("structure", func(a *App) Page { return newStructurePage(a) })
	OnTaskFinished(func(a *App, t model.Task) {
		if t.Kind != "structure" {
			return
		}
		if p, ok := a.pages["structure"].(*structurePage); ok && a.Project != nil {
			p.loadList()
		}
	})
	OnTaskFinished(func(a *App, t model.Task) {
		if t.Kind != "compare" {
			return
		}
		if p, ok := a.pages["structure"].(*structurePage); ok {
			p.layers.cmpStale = true // reloaded when the page shows
		}
	})
}

// ---- data

type structureEntry struct {
	ID         string         `json:"id"`
	TaskID     string         `json:"task_id"`
	SampleIDs  []string       `json:"sample_ids"`
	Samples    []string       `json:"samples"`
	GeneID     string         `json:"gene_id"`
	Mode       string         `json:"mode"`
	Windows    []core.Window  `json:"windows"`
	Parameters map[string]any `json:"parameters"`
	CreatedAt  string         `json:"created_at"`
	Available  *bool          `json:"available"`
	// Summary is the task's {pairs, pseudoknot_pairs, energy, length, ...}.
	Summary map[string]any `json:"summary"`
}

type structureRecord struct {
	WindowStart int      `json:"window_start"`
	WindowEnd   int      `json:"window_end"`
	Sequence    string   `json:"sequence"`
	DBN         string   `json:"dbn"`
	Pairs       [][2]int `json:"pairs"`
	// Bonus is each pair's chimera evidence (HYB bonus), aligned with Pairs.
	Bonus  []*float64 `json:"bonus"`
	Energy *float64   `json:"energy"`
	// mapped, when set, are the pairs moved onto another reference
	// (stMapRecords); they replace DBN and Pairs.
	mapped []stPair
}

// stWeights maps the records' pairs to their chimera bonus.
func stWeights(records []structureRecord) map[[2]int]float64 {
	out := map[[2]int]float64{}
	for _, r := range records {
		for i, pr := range r.Pairs {
			if i < len(r.Bonus) && r.Bonus[i] != nil {
				out[pr] = *r.Bonus[i]
			}
		}
	}
	return out
}

type structureResult struct {
	Structure structureEntry `json:"structure"`
	Meta      struct {
		Engine     string         `json:"engine"`
		GeneID     string         `json:"gene_id"`
		Mode       string         `json:"mode"`
		Parameters map[string]any `json:"parameters"`
		Timings    struct {
			TotalS float64 `json:"total_s"`
		} `json:"timings"`
		EvidenceInputs struct {
			Rows string `json:"rows"`
		} `json:"evidence_inputs"`
	} `json:"meta"`
	Records []structureRecord `json:"records"`
}

// span is the first and last position a record covers.
func (r structureRecord) span() (int, int) {
	start := r.WindowStart
	if start < 1 {
		start = 1
	}
	end := r.WindowEnd
	if end < start {
		end = start + len(r.Sequence) - 1
	}
	return start, end
}

// stPair is a base pair in gene coordinates with its bracket layer (0 for
// "()", higher for pseudoknot brackets).
type stPair struct{ I, J, Layer int }

const (
	dbnOpen  = "([{<ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	dbnClose = ")]}>abcdefghijklmnopqrstuvwxyz"
)

// stParseDBN reads dot-bracket (with pseudoknot brackets) into pairs at gene
// positions starting at offset.
func stParseDBN(dbn string, offset int) []stPair {
	if offset < 1 {
		offset = 1
	}
	stacks := map[int][]int{}
	var pairs []stPair
	for i, ch := range []byte(dbn) {
		if open := strings.IndexByte(dbnOpen, ch); open >= 0 {
			stacks[open] = append(stacks[open], i+1)
			continue
		}
		if close := strings.IndexByte(dbnClose, ch); close >= 0 && len(stacks[close]) > 0 {
			stack := stacks[close]
			i0 := stack[len(stack)-1]
			stacks[close] = stack[:len(stack)-1]
			pairs = append(pairs, stPair{I: i0 + offset - 1, J: i + 1 + offset - 1, Layer: close})
		}
	}
	return pairs
}

func stRecordPairs(r structureRecord) []stPair {
	if r.mapped != nil {
		return r.mapped
	}
	if r.DBN != "" {
		return stParseDBN(r.DBN, r.WindowStart)
	}
	out := make([]stPair, len(r.Pairs))
	for i, pr := range r.Pairs {
		out[i] = stPair{I: pr[0], J: pr[1]}
	}
	return out
}

// stPickRecords: all records, or the one window "start-end".
func stPickRecords(records []structureRecord, choice string) []structureRecord {
	if choice == "" || choice == "all" || len(records) <= 1 {
		return records
	}
	var out []structureRecord
	for _, r := range records {
		if fmt.Sprintf("%d-%d", r.WindowStart, r.WindowEnd) == choice {
			out = append(out, r)
		}
	}
	return out
}

// stStats compares the structures shown: A alone, or A and B with
// pairs counted only inside the regions both cover (a window fold against a
// whole-RNA fold).
type stStats struct {
	LengthA, LengthB     int
	PairsA, PairsB       int
	KnottedA, KnottedB   int
	EnergyA, EnergyB     string
	Shared, OnlyA, OnlyB int
	Jaccard              string
	DifferentCover       bool
}

func stCompare(recordsA, recordsB []structureRecord, compare bool) ([]stPair, []stPair, stStats) {
	var pairsA, pairsB []stPair
	for _, r := range recordsA {
		pairsA = append(pairsA, stRecordPairs(r)...)
	}
	for _, r := range recordsB {
		pairsB = append(pairsB, stRecordPairs(r)...)
	}
	statsA, statsB := pairsA, pairsB
	var s stStats
	if compare {
		spans := func(records []structureRecord) [][2]int {
			out := make([][2]int, len(records))
			for i, r := range records {
				start, end := r.span()
				out[i] = [2]int{start, end}
			}
			return out
		}
		inside := func(pairs []stPair, spans [][2]int) []stPair {
			var out []stPair
			for _, pr := range pairs {
				for _, sp := range spans {
					if pr.I >= sp[0] && pr.J <= sp[1] {
						out = append(out, pr)
						break
					}
				}
			}
			return out
		}
		spansA, spansB := spans(recordsA), spans(recordsB)
		statsA, statsB = inside(pairsA, spansB), inside(pairsB, spansA)
		cover := func(spans [][2]int) int {
			n := 0
			for _, sp := range spans {
				n += sp[1] - sp[0] + 1
			}
			return n
		}
		s.DifferentCover = cover(spansA) != cover(spansB)
	}
	key := func(p stPair) [2]int { return [2]int{p.I, p.J} }
	setA, setB := map[[2]int]bool{}, map[[2]int]bool{}
	for _, p := range statsA {
		setA[key(p)] = true
	}
	for _, p := range statsB {
		setB[key(p)] = true
	}
	for k := range setA {
		if setB[k] {
			s.Shared++
		}
	}
	length := func(records []structureRecord) int {
		n := 0
		for _, r := range records {
			n += len(r.Sequence)
		}
		return n
	}
	knotted := func(pairs []stPair) int {
		n := 0
		for _, p := range pairs {
			if p.Layer > 0 {
				n++
			}
		}
		return n
	}
	energy := func(records []structureRecord) string {
		sum, n := 0.0, 0
		for _, r := range records {
			if r.Energy != nil {
				sum += *r.Energy
				n++
			}
		}
		if n == 0 {
			return "—"
		}
		return fmt.Sprintf("%.1f kcal/mol", sum)
	}
	s.LengthA, s.LengthB = length(recordsA), length(recordsB)
	s.PairsA, s.PairsB = len(statsA), len(statsB)
	s.KnottedA, s.KnottedB = knotted(statsA), knotted(statsB)
	s.EnergyA, s.EnergyB = energy(recordsA), energy(recordsB)
	s.OnlyA, s.OnlyB = len(setA)-s.Shared, len(setB)-s.Shared
	s.Jaccard = "—"
	if union := len(setA) + len(setB) - s.Shared; union > 0 {
		s.Jaccard = fmt.Sprintf("%.3f", float64(s.Shared)/float64(union))
	}
	return pairsA, pairsB, s
}

var stWindowLine = regexp.MustCompile(`^(\d+)\s*[-–:.\s]+\s*(\d+)$`)

// stParseWindows reads "start-end" per line (or separated by , ;).
func stParseWindows(text string, length int) ([]core.Window, []string) {
	var windows []core.Window
	var errs []string
	for _, line := range regexp.MustCompile(`[\n,;]+`).Split(text, -1) {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		m := stWindowLine.FindStringSubmatch(line)
		if m == nil {
			errs = append(errs, "Not a window: "+line)
			continue
		}
		start, _ := strconv.Atoi(m[1])
		end, _ := strconv.Atoi(m[2])
		if start > end {
			start, end = end, start
		}
		if start < 1 || (length > 0 && end > length) {
			limit := "?"
			if length > 0 {
				limit = strconv.Itoa(length)
			}
			errs = append(errs, line+" is outside 1-"+limit)
			continue
		}
		if end-start+1 < 20 {
			errs = append(errs, line+" is shorter than 20 nt")
			continue
		}
		windows = append(windows, core.Window{Start: uint64(start), End: uint64(end)})
	}
	return windows, errs
}

// ---- page

type structurePage struct {
	// shade colors arcs by chimera evidence (HYB bonus).
	shade   bool
	a       *App
	project string

	// form
	gene, evidence string
	mode           string // "genome" | "windows"
	windows        string
	pseudoknot     bool
	alpha, beam    float64
	workers        float64
	// estKey is the form state est was computed for (time and memory of
	// the fold the form describes).
	estKey      string
	est         *core.FoldEstimate
	prefillNote string
	prefsAsked  bool
	// budgetMB is the memory tasks may use (Preferences), 0 until read.
	budgetMB     uint64
	advancedOpen bool
	errorOpen    bool
	// the fold started here: starting, why it did not start, its task.
	starting bool
	startErr string
	lastTask string

	// list
	structures []structureEntry
	listErr    string
	loading    bool
	again      bool // a task finished while the list was loading

	// viewer
	viewA, viewB string
	record       string
	cache        map[string]*structureResult
	reading      map[string]bool
	readErr      map[string]string
	pendingPair  []string
	// pendingShow is a fold started here, shown once it is listed;
	// focusResult is that fold once shown, until the viewer has given its
	// heading the keyboard focus and announced it.
	pendingShow string
	focusResult string
	pairLabels  []string
	arcs        widgets.Arcs
	arcsKey     string
	stats       stStats
	dbnText     string
	// research is the Related research panel below the viewer and
	// target the result it binds saved cards to (set by syncArcs).
	research *researchPanel
	target   *researchTarget
	// layers: B on A's coordinates, differential arcs, gene track
	layers        stLayers
	overlayLabels [2]string
}

func newStructurePage(a *App) *structurePage {
	p := &structurePage{a: a, research: newResearchPanel(a)}
	p.reset()
	return p
}

func (p *structurePage) reset() {
	p.gene, p.evidence, p.mode, p.windows = "", "", "genome", ""
	p.pseudoknot, p.alpha, p.beam = false, 0.5, 100
	p.prefillNote, p.startErr, p.lastTask, p.starting = "", "", "", false
	p.structures, p.listErr, p.loading = nil, "", false
	p.viewA, p.viewB, p.record = "", "", "all"
	p.cache = map[string]*structureResult{}
	p.reading = map[string]bool{}
	p.readErr = map[string]string{}
	p.pendingPair, p.pairLabels, p.pendingShow, p.focusResult = nil, nil, "", ""
	p.arcsKey, p.dbnText, p.target = "", "", nil
	p.layers = newSTLayers()
}

func (p *structurePage) Show() {
	a := p.a
	if a.Project == nil {
		return
	}
	if a.Project.Path != p.project {
		p.project = a.Project.Path
		p.reset()
	}
	if p.gene == "" || a.Project.GeneLength(p.gene) == 0 {
		p.gene = a.Selected.Gene
	}
	if len(a.SelectionIDs(p.evidence)) == 0 {
		p.evidence = a.Selected.Key
	}
	if opts := a.NavOptions; opts != nil {
		p.applyOptions(opts)
		a.NavOptions = nil
	}
	p.askWorkers()
	p.loadList()
	if p.layers.comparisons == nil || p.layers.cmpStale {
		p.layers.cmpStale = false
		p.loadComparisons()
	}
	p.research.Show()
}

func (p *structurePage) applyOptions(opts map[string]any) {
	if raw, ok := opts["prefill"]; ok {
		var prefill struct {
			Gene         string `json:"gene"`
			SelectionKey string `json:"selectionKey"`
			Source       string `json:"source"`
			Windows      []struct {
				Start float64 `json:"start"`
				End   float64 `json:"end"`
			} `json:"windows"`
		}
		if model.Decode(raw, &prefill) == nil {
			if prefill.Gene != "" {
				p.gene = prefill.Gene
			}
			p.mode = "windows"
			p.pseudoknot = true
			lines := make([]string, len(prefill.Windows))
			for i, w := range prefill.Windows {
				lines[i] = fmt.Sprintf("%d-%d", int(w.Start), int(w.End))
			}
			p.windows = strings.Join(lines, "\n")
			if prefill.SelectionKey != "" {
				p.evidence = prefill.SelectionKey
			}
			source := prefill.Source
			if source == "" {
				source = "a fold request"
			}
			p.prefillNote = "Prefilled from " + source + ". Check the window, then press Run fold below."
		}
	}
	if id, _ := opts["structureId"].(string); id != "" {
		p.show(id)
	}
	if raw, ok := opts["pair"]; ok {
		var pair, labels []string
		if model.Decode(raw, &pair) == nil && len(pair) == 2 {
			p.pendingPair = pair
			_ = model.Decode(opts["pairLabels"], &labels)
			p.pairLabels = labels
			p.viewA, p.viewB, p.record = "", "", "all"
		}
	}
}

// askWorkers defaults "Parallel windows" to the CPU budget.
func (p *structurePage) askWorkers() {
	if p.prefsAsked || p.workers > 0 {
		return
	}
	p.prefsAsked = true
	a := p.a
	a.Go(func() func() {
		prefs, err := a.B.Preferences()
		cpu, mem := 4.0, 0.0
		if err == nil {
			if budget, _ := prefs["budget"].(map[string]any); budget != nil {
				if v, ok := budget["cpu"].(float64); ok && v >= 1 {
					cpu = v
				}
				mem, _ = budget["mem_mb"].(float64)
			}
		}
		return func() {
			if p.workers <= 0 {
				p.workers = cpu
			}
			p.budgetMB = uint64(mem)
		}
	})
}

func (p *structurePage) loadList() {
	a := p.a
	if a.Project == nil {
		return
	}
	if p.loading {
		p.again = true
		return
	}
	path := a.Project.Path
	p.loading = true
	a.Go(func() func() {
		listed, err := a.B.ProjectOp(path, "list_structures", nil)
		var entries []structureEntry
		if err == nil {
			err = model.Decode(listed["structures"], &entries)
		}
		return func() {
			if a.Project == nil || a.Project.Path != path {
				return
			}
			p.loading = false
			if p.again {
				p.again = false
				defer p.loadList()
			}
			if err != nil {
				p.listErr = err.Error()
				return
			}
			p.listErr = ""
			p.structures = entries
			p.resolvePair()
		}
	})
}

// resolvePair shows the A fold of a pending pair once it is listed, and B
// once both are.
func (p *structurePage) resolvePair() {
	if p.pendingShow != "" && p.entry(p.pendingShow) != nil {
		p.show(p.pendingShow)
		p.focusResult, p.pendingShow = p.pendingShow, ""
	}
	if len(p.pendingPair) != 2 {
		return
	}
	hasA, hasB := p.entry(p.pendingPair[0]) != nil, p.entry(p.pendingPair[1]) != nil
	if hasA && p.viewA != p.pendingPair[0] {
		p.show(p.pendingPair[0])
	}
	if hasA && hasB {
		p.viewB = p.pendingPair[1]
		p.ensureRead(p.viewB)
		p.pendingPair = nil
	}
}

func (p *structurePage) entry(id string) *structureEntry {
	for i := range p.structures {
		if p.structures[i].ID == id {
			return &p.structures[i]
		}
	}
	return nil
}

func (p *structurePage) show(id string) {
	p.viewA = id
	if p.viewB == id {
		p.viewB = ""
	}
	p.record = "all"
	p.ensureRead(id)
}

func (p *structurePage) ensureRead(id string) {
	a := p.a
	if id == "" || p.cache[id] != nil || p.reading[id] || a.Project == nil {
		return
	}
	path := a.Project.Path
	p.reading[id] = true
	delete(p.readErr, id)
	a.Go(func() func() {
		raw, err := a.B.ProjectOp(path, "read_structure", core.Obj{"structure_id": id})
		var result structureResult
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

// evidenceMismatch says why the evidence cannot be used for the chosen RNA:
// its samples are mapped to another reference (their chimeras name other
// sequences). "" when they match or the RNA's reference is unknown.
func (p *structurePage) evidenceMismatch() string {
	a := p.a
	if a.Project == nil || p.gene == "" {
		return ""
	}
	var want *model.Reference
	for i, r := range a.Project.References {
		for _, s := range r.Sequences {
			if s.Name == p.gene {
				want = &a.Project.References[i]
			}
		}
	}
	if want == nil {
		return ""
	}
	name := func(r *model.Reference) string {
		if r.Label != "" {
			return r.Label
		}
		return r.ID
	}
	for _, id := range a.SelectionIDs(p.evidence) {
		s := a.Project.Sample(id)
		if s == nil || s.ReferenceID == "" || s.ReferenceID == want.ID {
			continue
		}
		other := s.ReferenceID
		if r := a.Project.Reference(other); r != nil {
			other = name(r)
		}
		return fmt.Sprintf("%s is mapped to %s, not to %s (the reference of this RNA). Choose evidence mapped to %s.",
			a.SelectionLabel(p.evidence), other, name(want), name(want))
	}
	return ""
}

func (p *structurePage) evidenceNames(e *structureEntry) string {
	ids := e.SampleIDs
	if len(ids) == 0 {
		ids = e.Samples
	}
	names := make([]string, len(ids))
	for i, id := range ids {
		names[i] = id
		if s := p.a.Project.Sample(id); s != nil {
			names[i] = s.Label()
		}
	}
	return strings.Join(names, " + ")
}

// ---- view

func (p *structurePage) View(c *ui.Context) {
	ui.Column(c).Fill().Padding(24).Gap(16).Children(func() {
		PageHeader(c, "Structure", "Predict RNA secondary structure with CPLfold, using your samples' chimeric reads as evidence, and compare structures.")
		ui.Row(c).Grow(1).Gap(16).AlignItems(ui.Stretch).Children(func() {
			// The form and results scroll; the check, Run fold and the
			// fold's status stay pinned below them.
			ui.Column(c).Width(354).Gap(12).Children(func() {
				ui.Scroll(c.Key("st-side")).Grow(1).Padding(0, 14, 0, 0).Gap(16).Children(func() {
					p.form(c)
					p.list(c)
				})
				p.runPanel(c)
			})
			ui.Scroll(c.Key("st-main")).Grow(1).Gap(16).Children(func() {
				p.viewer(c)
				p.research.View(c, p.researchTarget())
			})
		})
	})
}

func (p *structurePage) viewer(c *ui.Context) {
	t := c.Theme()
	Card(c, "", func() {
		var a, b *structureResult
		if p.viewA != "" {
			a = p.cache[p.viewA]
		}
		if p.viewB != "" {
			b = p.cache[p.viewB]
		}
		var windowChoices []string
		if a != nil && len(a.Records) > 1 {
			windowChoices = append(windowChoices, "All windows")
			for _, r := range a.Records {
				windowChoices = append(windowChoices, fmt.Sprintf("Window %d-%d", r.WindowStart, r.WindowEnd))
			}
		}
		ui.Row(c).Gap(8).AlignItems(ui.Center).Wrap().Children(func() {
			heading := ui.Text(c.Key("st-viewer-title"), "Viewer").FontSize(ts(c, 16)).Bold().Grow(1)
			if e := p.entry(p.viewA); a != nil && e != nil {
				heading.Focusable().Label("Viewer: " + stResultLabel(e))
				// A fold started here has just arrived: the keyboard focus
				// moves to its heading (not the diagram) and screen readers
				// hear the result once.
				if p.focusResult != "" && p.focusResult == p.viewA {
					p.focusResult = ""
					heading.Focus()
					c.Announce("Structure ready · " + stResultLabel(e))
				}
			}
			if len(windowChoices) > 0 {
				current := "All windows"
				if p.record != "all" {
					current = "Window " + p.record
				}
				ui.Select(c.Key("st-record"), &current, windowChoices).Width(200).Label("Window").OnChange(func() {
					if current == "All windows" {
						p.record = "all"
					} else {
						p.record = strings.TrimPrefix(current, "Window ")
					}
				})
			}
			if a != nil && ui.Checkbox(c.Key("st-shade"), &p.shade, "Shade by chimera support").
				Tooltip("Arc opacity follows the pair's HYB bonus: faint arcs have little chimera evidence").Changed() {
				p.arcs.Shade = p.shade
			}
			if p.viewB != "" && ui.Button(c, "Clear B").Clicked() {
				p.viewB = ""
			}
			if a != nil {
				if ui.Button(c, "Save .dbn").Clicked() {
					p.saveDBN(a)
				}
				if ui.Button(c, "Export SVG…").Tooltip("Save the arc diagram as shown").Clicked() {
					p.exportArcsSVG(a)
				}
			}
		})
		if len(p.pendingPair) == 2 {
			labels := "A and B"
			if len(p.pairLabels) == 2 {
				labels = p.pairLabels[0] + " (A) and " + p.pairLabels[1] + " (B)"
			}
			ui.Text(c, "Folding "+labels+"; they show here as the folds finish.").FontSize(ts(c, 12)).TextColor(t.TextMuted)
		}
		if p.viewA == "" {
			msg := "Run a fold to see its arc diagram here."
			if len(p.structures) > 0 {
				msg = "Choose a result to display; add a second one with “Compare as B”."
			}
			ui.Text(c, msg).TextColor(t.TextMuted)
			return
		}
		for _, id := range []string{p.viewA, p.viewB} {
			if err := p.readErr[id]; id != "" && err != "" {
				errorLine(c, "Could not read the structure: "+err)
				return
			}
		}
		if a == nil || (p.viewB != "" && b == nil) {
			ui.Text(c, "Loading…").TextColor(t.TextMuted)
			return
		}
		p.layerControls(c, stGene(a))
		p.syncArcs(a, b)
		p.arcs.Mono = p.monoColor(t)
		metaA := p.entry(p.viewA)
		labelA := "A · " + p.viewA
		if metaA != nil {
			labelA = "A · " + p.evidenceNames(metaA)
		}
		labelB := ""
		if b != nil {
			labelB = "B · " + p.viewB
			if metaB := p.entry(p.viewB); metaB != nil {
				labelB = "B · " + p.evidenceNames(metaB)
			}
		}
		ui.Row(c).Gap(14).Wrap().Children(func() {
			colorA, colorB := condColors(t)
			if p.layers.mono {
				colorA, colorB = t.Text, t.Text
			}
			if b != nil && p.layers.mono {
				labelA, labelB = labelA+" (above)", labelB+" (below)"
			}
			stLegend(c, colorA, labelA)
			if b != nil {
				stLegend(c, colorB, labelB)
				if !p.layers.mono {
					stLegend(c, t.TextMuted, "in both")
				}
			}
			if len(p.arcs.Overlay) > 0 {
				stLegend(c, cmpRed, p.overlayLabels[0])
				stLegend(c, cmpBlue, p.overlayLabels[1])
			}
		})
		height := float32(340)
		if b != nil || len(p.arcs.Overlay) > 0 {
			height = 440
		}
		if len(p.arcs.Features) > 0 {
			height += 20
		}
		condA, condB := condColors(t)
		ev := p.arcs.Show(c.Key("st-arcs"), height, condA, condB, t.TextMuted, "Arc diagram of base pairs")
		info := fmt.Sprintf("%s–%s · wheel zooms, drag pans, double click resets", FormatNumber(int64(p.arcs.Start)), FormatNumber(int64(p.arcs.End)))
		if ev.Hover {
			info = "Position " + FormatNumber(int64(ev.Position)) + " · " + info
		}
		ui.Text(c, info).FontSize(ts(c, 11)).TextColor(t.TextMuted)
		for _, note := range p.layers.notes {
			ui.Text(c, note).FontSize(ts(c, 12)).TextColor(t.TextMuted)
		}
		if p.stats.DifferentCover {
			ui.Text(c, "Pair statistics count pairs inside the regions both structures cover.").FontSize(ts(c, 12)).TextColor(t.TextMuted)
		}
		p.statsTable(c, b != nil)
		ui.Text(c, p.metaLine(a)).FontSize(ts(c, 12)).TextColor(t.TextMuted)
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, "Dot-bracket (A)").Bold().Grow(1)
			if ui.Button(c, "Copy").Clicked() {
				c.WriteClipboard(p.dbnText)
				p.a.Toast("Dot-bracket copied")
			}
		})
		ui.TextArea(c.Key("st-dbn"), &p.dbnText).ReadOnly(true).Font("monospace").FontSize(ts(c, 11)).Height(130).Label("Dot-bracket")
	})
}

func stLegend(c *ui.Context, color ui.Color, label string) {
	ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
		ui.Box(c).Size(14, 3).Background(color)
		ui.Text(c, label).FontSize(ts(c, 12)).TextColor(c.Theme().TextMuted)
	})
}

// stGene is the gene a result was folded on.
func stGene(r *structureResult) string {
	if r == nil {
		return ""
	}
	return nameOr(r.Meta.GeneID, r.Structure.GeneID)
}

// syncArcs rebuilds pairs, statistics and text when what is shown changes.
func (p *structurePage) syncArcs(a, b *structureResult) {
	key := fmt.Sprintf("%s|%s|%s|%d", p.viewA, p.viewB, p.record, p.layers.version)
	if key == p.arcsKey {
		return
	}
	p.arcsKey = key
	p.layers.notes = nil
	geneA := stGene(a)
	recordsA := stPickRecords(a.Records, p.record)
	var recordsB []structureRecord
	if b != nil {
		recordsB = stPickRecords(b.Records, p.record)
		if p.record != "all" && len(recordsB) == 0 {
			recordsB = b.Records
		}
		// B folded on another reference: move it onto A's coordinates.
		if geneB := stGene(b); geneB != "" && geneA != "" && geneB != geneA {
			m, ok := p.geneMap(geneB, geneA)
			switch {
			case ok && m != nil:
				var dropped int
				recordsB, dropped = stMapRecords(recordsB, m)
				note := "B is shown on A's coordinates: " + stMapNote(geneB, geneA, m) + "."
				if dropped > 0 {
					note += fmt.Sprintf(" %s pairs of B with an unaligned end are left out.", FormatNumber(int64(dropped)))
				}
				p.layers.notes = append(p.layers.notes, note)
			case p.layers.mapErr[geneB+">"+geneA] != "":
				p.layers.notes = append(p.layers.notes, "B is not shown: could not align "+geneB+" to "+geneA+": "+p.layers.mapErr[geneB+">"+geneA])
				recordsB = nil
			default:
				p.layers.notes = append(p.layers.notes, "Aligning "+geneB+" to "+geneA+" to show B on A's coordinates…")
				recordsB = nil
			}
		}
	}
	pairsA, pairsB, stats := stCompare(recordsA, recordsB, b != nil)
	p.stats = stats
	start, end := 0, 0
	for _, r := range append(append([]structureRecord{}, recordsA...), recordsB...) {
		s, e := r.span()
		if start == 0 || s < start {
			start = s
		}
		if e > end {
			end = e
		}
	}
	if start == 0 {
		start, end = 1, 100
	}
	gene := a.Meta.GeneID
	if gene == "" {
		gene = a.Structure.GeneID
	}
	length := p.a.Project.GeneLength(gene)
	if length < end {
		length = end
	}
	toArcs := func(pairs []stPair) []widgets.Pair {
		out := make([]widgets.Pair, len(pairs))
		for i, pr := range pairs {
			out[i] = widgets.Pair{I: pr.I, J: pr.J}
		}
		return out
	}
	p.arcs.Set(toArcs(pairsA), toArcs(pairsB), length)
	weights := func(pairs []stPair, records []structureRecord) []float64 {
		known := stWeights(records)
		out := make([]float64, len(pairs))
		for i, pr := range pairs {
			out[i] = known[[2]int{pr.I, pr.J}]
		}
		return out
	}
	p.arcs.WeightA, p.arcs.WeightB = weights(pairsA, recordsA), weights(pairsB, recordsB)
	p.arcs.Shade = p.shade
	overlay, labels, note, _ := p.overlayArcs(geneA)
	p.arcs.Overlay, p.overlayLabels = overlay, labels
	if note != "" {
		p.layers.notes = append(p.layers.notes, note)
	}
	p.arcs.Features = nil
	if an := p.annotation(geneA); an != nil {
		p.arcs.Features = an.features
		if an.err != "" {
			p.layers.notes = append(p.layers.notes, "Gene annotation: "+an.err)
		} else if an.note != "" {
			p.layers.notes = append(p.layers.notes, an.note)
		}
	}
	p.arcs.Start, p.arcs.End = float64(start), float64(end)
	if end-start < 20 {
		p.arcs.Start, p.arcs.End = 1, float64(length)
	}
	p.dbnText = stDBNText(gene, recordsA)
	p.target = &researchTarget{StructureID: p.viewA, Record: p.record, Digest: researchDigest(recordsA), Gene: gene}
}

// researchTarget is the result A shown, if its arcs are current.
func (p *structurePage) researchTarget() *researchTarget {
	if p.target == nil || p.viewA == "" || p.target.StructureID != p.viewA || p.target.Record != p.record || p.cache[p.viewA] == nil {
		return nil
	}
	return p.target
}

func stDBNText(gene string, records []structureRecord) string {
	if gene == "" {
		gene = "RNA"
	}
	var b strings.Builder
	for _, r := range records {
		fmt.Fprintf(&b, ">%s:%d-%d", gene, r.WindowStart, r.WindowEnd)
		if r.Energy != nil {
			fmt.Fprintf(&b, " %g", *r.Energy)
		}
		fmt.Fprintf(&b, "\n%s\n%s\n", r.Sequence, r.DBN)
	}
	return b.String()
}

func (p *structurePage) statsTable(c *ui.Context, compare bool) {
	t := c.Theme()
	s := p.stats
	type row struct{ label, a, b string }
	rows := []row{
		{"Length (nt)", FormatNumber(int64(s.LengthA)), FormatNumber(int64(s.LengthB))},
		{"Base pairs", FormatNumber(int64(s.PairsA)), FormatNumber(int64(s.PairsB))},
		{"Pseudoknotted pairs", FormatNumber(int64(s.KnottedA)), FormatNumber(int64(s.KnottedB))},
		{"Energy", s.EnergyA, s.EnergyB},
	}
	if compare {
		rows = append(rows,
			row{"Shared pairs", FormatNumber(int64(s.Shared)), FormatNumber(int64(s.Shared))},
			row{"Only in this structure", FormatNumber(int64(s.OnlyA)), FormatNumber(int64(s.OnlyB))},
			row{"Pair agreement (Jaccard)", s.Jaccard, ""})
	}
	ui.Column(c).Gap(0).Radius(8).Border(1, t.Border).Children(func() {
		line := func(label, a, b string, header bool) {
			r := ui.Row(c).Padding(5, 10).BorderWidth(0, 0, 1, 0).BorderColor(t.Border)
			r.Children(func() {
				ui.Text(c, label).Grow(1)
				ta := ui.Text(c, a).Width(130).TextAlign(ui.End)
				if header {
					ta.Bold()
				}
				if compare {
					tb := ui.Text(c, b).Width(130).TextAlign(ui.End)
					if header {
						tb.Bold()
					}
				}
			})
		}
		line("", "A", "B", true)
		for _, r := range rows {
			line(r.label, r.a, r.b, false)
		}
	})
}

func (p *structurePage) metaLine(a *structureResult) string {
	m := a.Meta
	parts := []string{"Engine " + nameOr(m.Engine, "CPLfold")}
	if m.Parameters != nil {
		pk := "pseudoknot-free"
		if on, _ := m.Parameters["allow_pseudoknot"].(bool); on {
			pk = "pseudoknots allowed"
		}
		parts = append(parts, fmt.Sprintf("%s, alpha %v", pk, m.Parameters["alpha"]))
	}
	if m.Timings.TotalS > 0 {
		parts = append(parts, fmt.Sprintf("took %.1f s", m.Timings.TotalS))
	}
	if m.EvidenceInputs.Rows != "" {
		parts = append(parts, "evidence: "+m.EvidenceInputs.Rows)
	}
	return strings.Join(parts, " · ")
}

func (p *structurePage) saveDBN(a *structureResult) {
	gene := nameOr(a.Meta.GeneID, a.Structure.GeneID)
	text := stDBNText(gene, a.Records)
	name := nameOr(gene, "structure") + "_" + p.viewA + ".dbn"
	app := p.a
	app.Go(func() func() {
		path := PickSave("Save the dot-bracket file", name)
		if path == "" {
			return nil
		}
		err := os.WriteFile(path, []byte(text), 0o644)
		return func() {
			if err != nil {
				app.Toast("Could not save: %v", err)
			} else {
				app.Toast("Saved %s", path)
			}
		}
	})
}

// StructureMemClaim is the memory a structure request claims from the task
// budget: the CPLfold estimate for its longest window (the whole RNA in
// genome mode) times the windows folded at once.
func StructureMemClaim(req core.TaskStartRequest, geneLength int, allowPseudoknot bool) uint64 {
	longest, parallel := geneLength, 1
	if len(req.Windows) > 0 {
		longest = 0
		for _, w := range req.Windows {
			longest = max(longest, int(w.End-w.Start+1))
		}
		parallel = len(req.Windows)
		if req.Workers != nil {
			parallel = min(parallel, int(*req.Workers))
		}
	}
	return core.StructureClaimMB(longest, allowPseudoknot, parallel)
}

// StructureStartError explains a fold the memory budget cannot hold.
func StructureStartError(err error, needMB uint64) string {
	if strings.Contains(err.Error(), "mem_mb") {
		return fmt.Sprintf("this fold needs about %.1f GB of memory, more than the task budget. "+
			"Raise the memory budget in Preferences, use fewer parallel windows, or fold shorter windows.", float64(needMB)/1024)
	}
	return err.Error()
}
