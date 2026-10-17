package views

// Extra layers of the Structure viewer, for a PARIS-style arc map:
//
//   - B on A's coordinates: when B was folded on another reference (another
//     strain), its pairs are moved onto A's reference by a banded global
//     alignment of the two sequences (package seqmap), so the arcs and the
//     shared-pair statistics compare the same nucleotides.
//   - Differential arcs: the merged interactions of a Compare test (padj
//     below a cutoff), higher in condition one above the baseline (red),
//     higher in condition two below (blue), each on its own reference and
//     mapped onto A's.  The structures can be drawn in one colour so these
//     stand out.
//   - Gene track: the annotation attached to A's reference (Data page or
//     "Gene annotation…" here; GenBank, GFF/GTF, BED or TSV).  A GenBank
//     file's own sequence is aligned to the reference, so a related
//     strain's annotation lands on the right nucleotides.

import (
	"fmt"
	"strings"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
	"rnaxraydesktop/seqmap"
	"rnaxraydesktop/widgets"
)

// stLayers is the state behind the extra layers; version changes whenever
// asynchronous data arrive, so the arcs are rebuilt.
type stLayers struct {
	version int

	seqs       map[string]string
	seqPending map[string]bool
	seqErr     map[string]string

	maps       map[string]*seqmap.Map
	mapPending map[string]bool
	mapErr     map[string]string

	annot        map[string]*stAnnotation
	annotPending map[string]bool

	comparisons []comparisonEntry
	cmpLoading  bool
	cmpStale    bool // a Compare test finished since the list was read
	overlayID   string
	padj        float64
	mono        bool
	results     map[string]*comparisonResult
	resPending  map[string]bool
	resErr      map[string]string

	// notes describe the layers shown (set by syncArcs)
	notes []string
}

type stAnnotation struct {
	features []widgets.Feature
	file     string
	note     string
	err      string
}

func newSTLayers() stLayers {
	return stLayers{seqs: map[string]string{}, seqPending: map[string]bool{}, seqErr: map[string]string{},
		maps: map[string]*seqmap.Map{}, mapPending: map[string]bool{}, mapErr: map[string]string{},
		annot: map[string]*stAnnotation{}, annotPending: map[string]bool{}, padj: 0.01,
		results: map[string]*comparisonResult{}, resPending: map[string]bool{}, resErr: map[string]string{}}
}

// referenceOf is the id of the reference holding a gene ("" if none).
func stReferenceOf(pr *model.Project, gene string) string {
	if pr == nil {
		return ""
	}
	for _, r := range pr.References {
		for _, s := range r.Sequences {
			if s.Name == gene {
				return r.ID
			}
		}
	}
	return ""
}

// fetchSequence reads a reference sequence (blocking; call from a.Go).
func fetchSequence(b core.Backend, pr *model.Project, path, gene string) (string, error) {
	ref := stReferenceOf(pr, gene)
	if ref == "" {
		return "", fmt.Errorf("no reference holds %s", gene)
	}
	raw, err := b.ProjectOp(path, "read_reference_sequence", core.Obj{"reference_id": ref, "name": gene})
	if err != nil {
		return "", err
	}
	seq, _ := raw["sequence"].(string)
	if seq == "" {
		return "", fmt.Errorf("the sequence of %s is empty", gene)
	}
	return seq, nil
}

// geneMap is the map of gene from onto gene to: (nil, true) when they are
// the same gene, (map, true) when aligned, (nil, false) while aligning or
// after an error (mapErr).
func (p *structurePage) geneMap(from, to string) (*seqmap.Map, bool) {
	if from == "" || to == "" || from == to {
		return nil, true
	}
	l := &p.layers
	key := from + ">" + to
	if m, ok := l.maps[key]; ok {
		return m, true
	}
	if l.mapPending[key] || l.mapErr[key] != "" {
		return nil, false
	}
	l.mapPending[key] = true
	a, pr := p.a, p.a.Project
	path := pr.Path
	a.Go(func() func() {
		var m *seqmap.Map
		seqFrom, err := fetchSequence(a.B, pr, path, from)
		var seqTo string
		if err == nil {
			seqTo, err = fetchSequence(a.B, pr, path, to)
		}
		if err == nil {
			m, err = seqmap.Align(seqFrom, seqTo)
		}
		return func() {
			if a.Project == nil || a.Project.Path != path {
				return
			}
			delete(l.mapPending, key)
			if err != nil {
				l.mapErr[key] = err.Error()
			} else {
				l.maps[key] = m
			}
			l.version++
		}
	})
	return nil, false
}

func stMapNote(from, to string, m *seqmap.Map) string {
	return fmt.Sprintf("%s → %s by alignment: %.1f%% identity, %d mismatches, %d gap columns", from, to,
		100*m.Identity, m.Mismatches, m.Gaps)
}

// stMapRecords moves records onto another reference; pairs with an end that
// faces a gap are dropped (dropped counts them).
func stMapRecords(records []structureRecord, m *seqmap.Map) (out []structureRecord, dropped int) {
	for _, r := range records {
		bonus := stWeights([]structureRecord{r})
		mapped := r
		mapped.DBN, mapped.Pairs, mapped.Bonus, mapped.mapped = "", nil, nil, []stPair{}
		for _, pr := range stRecordPairs(r) {
			i, j := m.Pos(pr.I), m.Pos(pr.J)
			if i == 0 || j == 0 {
				dropped++
				continue
			}
			if i > j {
				i, j = j, i
			}
			mapped.mapped = append(mapped.mapped, stPair{I: i, J: j, Layer: pr.Layer})
			mapped.Pairs = append(mapped.Pairs, [2]int{i, j})
			if w, ok := bonus[[2]int{pr.I, pr.J}]; ok {
				mapped.Bonus = append(mapped.Bonus, &w)
			} else {
				mapped.Bonus = append(mapped.Bonus, nil)
			}
		}
		start, end := r.span()
		mapped.WindowStart, mapped.WindowEnd = m.Nearest(start, 50), m.Nearest(end, 50)
		out = append(out, mapped)
	}
	return out, dropped
}

// annotation is the gene track of a gene, loading it when needed.
func (p *structurePage) annotation(gene string) *stAnnotation {
	l := &p.layers
	if an, ok := l.annot[gene]; ok {
		return an
	}
	if l.annotPending[gene] || p.a.Project == nil {
		return nil
	}
	ref := stReferenceOf(p.a.Project, gene)
	if ref == "" {
		return nil
	}
	l.annotPending[gene] = true
	a, pr := p.a, p.a.Project
	path := pr.Path
	a.Go(func() func() {
		an := &stAnnotation{}
		raw, err := a.B.ProjectOp(path, "read_annotation", core.Obj{"reference_id": ref, "gene": gene})
		var res struct {
			Annotation *struct {
				FileName string `json:"file_name"`
				Format   string `json:"format"`
			} `json:"annotation"`
			Features []struct {
				Start  int    `json:"start"`
				End    int    `json:"end"`
				Name   string `json:"name"`
				Detail string `json:"detail"`
			} `json:"features"`
			Seqid    string  `json:"seqid"`
			Sequence *string `json:"sequence"`
		}
		if err == nil {
			err = model.Decode(raw, &res)
		}
		if err == nil && res.Annotation != nil {
			an.file = res.Annotation.FileName
			var m *seqmap.Map
			if res.Sequence != nil && *res.Sequence != "" {
				var refSeq string
				refSeq, err = fetchSequence(a.B, pr, path, gene)
				if err == nil {
					m, err = seqmap.Align(*res.Sequence, refSeq)
				}
				if err == nil && !m.Same {
					an.note = "Gene track moved from " + nameOr(res.Seqid, "the annotation's sequence") + " onto " + gene + " by alignment (" +
						fmt.Sprintf("%.1f%% identity", 100*m.Identity) + ")."
				}
			}
			for _, f := range res.Features {
				start, end := f.Start, f.End
				if m != nil && !m.Same {
					start, end = m.Nearest(start, 30), m.Nearest(end, 30)
					if start == 0 || end == 0 {
						continue
					}
				}
				an.features = append(an.features, widgets.Feature{Start: start, End: end, Name: f.Name})
			}
		}
		return func() {
			if a.Project == nil || a.Project.Path != path {
				return
			}
			delete(l.annotPending, gene)
			if err != nil {
				an.err = err.Error()
			}
			l.annot[gene] = an
			l.version++
		}
	})
	return nil
}

// loadAnnotation attaches an annotation file to the reference of gene.
func (p *structurePage) loadAnnotation(gene string, remove bool) {
	a := p.a
	if a.Project == nil {
		return
	}
	ref := stReferenceOf(a.Project, gene)
	if ref == "" {
		a.Toast("No reference holds %s", gene)
		return
	}
	path := a.Project.Path
	a.Go(func() func() {
		payload := core.Obj{"reference_id": ref}
		if !remove {
			paths := PickFiles("Choose a gene annotation (GenBank, GFF/GTF, BED or TSV)", false)
			if len(paths) == 0 {
				return nil
			}
			payload["source"] = paths[0]
		}
		_, err := a.B.ProjectOp(path, "set_reference_annotation", payload)
		return func() {
			if a.Project == nil || a.Project.Path != path {
				return
			}
			if err != nil {
				a.Toast("Could not set the annotation: %v", err)
				return
			}
			for g := range p.layers.annot {
				if stReferenceOf(a.Project, g) == ref {
					delete(p.layers.annot, g)
				}
			}
			p.layers.version++
			if remove {
				a.Toast("Annotation removed")
			} else {
				a.Toast("Annotation attached to the reference")
			}
		}
	})
}

// loadComparisons lists the Compare tests for the overlay.
func (p *structurePage) loadComparisons() {
	a, l := p.a, &p.layers
	if a.Project == nil || l.cmpLoading {
		return
	}
	l.cmpLoading = true
	path := a.Project.Path
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
			l.cmpLoading = false
			if err == nil {
				if entries == nil {
					entries = []comparisonEntry{}
				}
				l.comparisons = entries
			}
		}
	})
}

func (p *structurePage) comparison(id string) *comparisonEntry {
	for i := range p.layers.comparisons {
		if p.layers.comparisons[i].ID == id {
			return &p.layers.comparisons[i]
		}
	}
	return nil
}

func stComparisonTitle(e *comparisonEntry) string {
	return nameOr(e.LabelOne, strings.Join(e.SamplesOne, "+")) + " vs " + nameOr(e.LabelTwo, strings.Join(e.SamplesTwo, "+")) +
		" · " + FormatTime(e.CreatedAt)
}

// overlayResult reads a test's merged interactions once.
func (p *structurePage) overlayResult(id string) *comparisonResult {
	l := &p.layers
	if r := l.results[id]; r != nil || l.resPending[id] || l.resErr[id] != "" {
		return r
	}
	l.resPending[id] = true
	a := p.a
	path := a.Project.Path
	a.Go(func() func() {
		raw, err := a.B.ProjectOp(path, "read_comparison", core.Obj{"comparison_id": id, "limit": 1})
		var result comparisonResult
		if err == nil {
			err = model.Decode(raw, &result)
		}
		return func() {
			if a.Project == nil || a.Project.Path != path {
				return
			}
			delete(l.resPending, id)
			if err != nil {
				l.resErr[id] = err.Error()
			} else {
				l.results[id] = &result
			}
			l.version++
		}
	})
	return nil
}

// sampleGene is the gene a group of samples was analysed on.
func (p *structurePage) sampleGene(ids []string, fallback []string) string {
	for _, id := range ids {
		if s := p.a.Project.Sample(id); s != nil && s.GeneID != "" {
			return s.GeneID
		}
	}
	if len(fallback) > 0 {
		return fallback[0]
	}
	return ""
}

// overlayArcs are the test's interactions with padj below the cutoff on
// gene's coordinates; ready is false while a map or the result loads.
func (p *structurePage) overlayArcs(gene string) (arcs []widgets.OverlayArc, labels [2]string, note string, ready bool) {
	l := &p.layers
	e := p.comparison(l.overlayID)
	if e == nil {
		return nil, labels, "", true
	}
	labels = [2]string{"higher in " + nameOr(e.LabelOne, "A"), "higher in " + nameOr(e.LabelTwo, "B")}
	result := p.overlayResult(e.ID)
	if result == nil {
		if err := l.resErr[e.ID]; err != "" {
			return nil, labels, "Could not read the test: " + err, true
		}
		return nil, labels, "Reading the differential test…", false
	}
	genes := [2]string{p.sampleGene(e.SamplesOne, e.Genes), p.sampleGene(e.SamplesTwo, e.Genes)}
	var maps [2]*seqmap.Map
	var mapped []string
	for k, g := range genes {
		m, ok := p.geneMap(g, gene)
		if !ok {
			if err := l.mapErr[g+">"+gene]; err != "" {
				return nil, labels, "Could not align " + g + " to " + gene + ": " + err, true
			}
			return nil, labels, "Aligning " + g + " to " + gene + "…", false
		}
		maps[k] = m
		if m != nil {
			mapped = append(mapped, g)
		}
	}
	up, down := 0, 0
	for _, row := range result.Interactions {
		if row.Padj == nil || *row.Padj >= l.padj {
			continue
		}
		k, color := 0, cmpRed
		if row.Direction == "down" {
			k, color = 1, cmpBlue
		}
		// a merged interaction is a 10-nt cell: draw its centre
		i, j := min(row.X, row.Y)+5, max(row.X, row.Y)+5
		if m := maps[k]; m != nil {
			i, j = m.Nearest(i, 10), m.Nearest(j, 10)
			if i == 0 || j == 0 {
				continue
			}
		}
		arcs = append(arcs, widgets.OverlayArc{I: i, J: j, Up: k == 0, Color: color.Alpha(0.85), Width: 1.3})
		if k == 0 {
			up++
		} else {
			down++
		}
	}
	note = fmt.Sprintf("Differential arcs: %s interactions with padj < %g, %s %s (above) and %s %s (below).",
		FormatNumber(int64(up+down)), l.padj, FormatNumber(int64(up)), labels[0], FormatNumber(int64(down)), labels[1])
	if len(mapped) > 0 {
		note += " " + strings.Join(stUnique(mapped), ", ") + " cells moved onto " + gene + " by alignment."
	}
	return arcs, labels, note, true
}

func stUnique(items []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range items {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// setOverlay chooses the test drawn as differential arcs ("" for none).
// Turning it on draws the structures in one colour, as in a PARIS-style
// map: structures black, differences coloured.
func (p *structurePage) setOverlay(id string) {
	l := &p.layers
	if l.overlayID == "" && id != "" {
		l.mono = true
	}
	l.overlayID = id
	l.version++
}

// layerControls is the viewer's second row: differential arcs and genes.
func (p *structurePage) layerControls(c *ui.Context, gene string) {
	t := c.Theme()
	l := &p.layers
	options := []string{"None"}
	ids := []string{""}
	for i := range l.comparisons {
		options = append(options, stComparisonTitle(&l.comparisons[i]))
		ids = append(ids, l.comparisons[i].ID)
	}
	current := "None"
	for k, id := range ids {
		if id == l.overlayID {
			current = options[k]
		}
	}
	ui.Row(c).Gap(10).AlignItems(ui.End).Wrap().Children(func() {
		Field(c, "Differential arcs", func() {
			ui.Select(c.Key("st-overlay"), &current, options).Width(300).Label("Differential arcs").OnChange(func() {
				for k, o := range options {
					if o == current {
						p.setOverlay(ids[k])
					}
				}
			})
		})
		if l.overlayID != "" {
			Field(c, "padj <", func() {
				before := l.padj
				ui.NumberInput(c.Key("st-overlay-padj"), &l.padj, 1e-12, 1, 0.01).Width(100).Label("padj cutoff")
				if l.padj != before {
					l.version++
				}
			})
		}
		if ui.Checkbox(c.Key("st-mono"), &l.mono, "Structures in one colour").
			Tooltip("Draw A and B in the text colour so the differential arcs stand out").Changed() {
			l.version++
		}
		ui.Spacer(c)
		an := p.annotation(gene)
		label := "No gene annotation"
		if an != nil && an.file != "" {
			label = "Genes: " + an.file
		}
		ui.Text(c, label).FontSize(ts(c, 12)).TextColor(t.TextMuted).Margin(0, 0, 8, 0)
		if ui.Button(c, "Gene annotation…").Tooltip("Attach a GenBank, GFF/GTF, BED or TSV file to this reference").Clicked() {
			p.loadAnnotation(gene, false)
		}
		if an != nil && an.file != "" && ui.Button(c, "Remove").Tooltip("Detach the annotation from this reference").Clicked() {
			p.loadAnnotation(gene, true)
		}
	})
}

// monoColor is the structures' colour when drawn in one colour.
func (p *structurePage) monoColor(t *ui.Theme) ui.Color {
	if p.layers.mono {
		return t.Text
	}
	return ui.Color{}
}
