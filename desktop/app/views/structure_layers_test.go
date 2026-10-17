package views

import (
	"encoding/json"
	"math/rand"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
)

const braGene = "ZIKV_Brazilian_MF073357-1_virusRNA"

// layersFake answers read_reference_sequence per gene.
type layersFake struct {
	*csFake
	seqs map[string]string
}

func (f *layersFake) ProjectOp(path, operation string, payload core.Obj) (core.Obj, error) {
	if operation == "read_reference_sequence" {
		f.record("op:" + operation)
		name, _ := payload["name"].(string)
		return core.Obj{"name": name, "sequence": f.seqs[name], "length": float64(len(f.seqs[name]))}, nil
	}
	return f.csFake.ProjectOp(path, operation, payload)
}

// stLayerSequences: an African sequence and a Brazilian one with one extra
// nucleotide after position 72 (so BRA i is AFR i-1 after it), both 10,807 nt.
func stLayerSequences() (string, string) {
	r := rand.New(rand.NewSource(7))
	var b strings.Builder
	for range 10807 {
		b.WriteByte("ACGU"[r.Intn(4)])
	}
	afr := b.String()
	insert := "A"
	if afr[72] == 'A' || afr[71] == 'A' {
		insert = "C"
	}
	if afr[72] == 'C' || afr[71] == 'C' {
		insert = "G"
	}
	return afr, afr[:72] + insert + afr[72:len(afr)-1]
}

// stShiftedB is A's result moved by +1 onto the Brazilian reference.
func stShiftedB(t *testing.T) (core.Obj, core.Obj) {
	read := fixture(t, "structure_read.json")
	record := read["records"].([]any)[0].(map[string]any)
	record["window_start"] = record["window_start"].(float64) + 1
	record["window_end"] = record["window_end"].(float64) + 1
	for _, pr := range record["pairs"].([]any) {
		pair := pr.([]any)
		pair[0], pair[1] = pair[0].(float64)+1, pair[1].(float64)+1
	}
	entry := read["structure"].(map[string]any)
	entry["id"], entry["task_id"], entry["gene_id"] = structB, structB, braGene
	entry["sample_ids"] = []any{"ZBRA_REP1", "ZBRA_REP2"}
	read["meta"].(map[string]any)["gene_id"] = braGene
	list := fixture(t, "structure_list.json")
	raw, _ := json.Marshal(entry)
	var copied map[string]any
	_ = json.Unmarshal(raw, &copied)
	list["structures"] = append([]any{copied}, list["structures"].([]any)...)
	return read, list
}

func TestStructureLayers(t *testing.T) {
	a, cf := openCS(t)
	afr, bra := stLayerSequences()
	f := &layersFake{csFake: cf, seqs: map[string]string{africaGene: afr, braGene: bra}}
	a.B = f
	readB, listAB := stShiftedB(t)
	cf.structures[structB] = readB
	cf.ops["list_structures"] = listAB
	// a gene track made on the Brazilian sequence: moved by -1 onto AFR
	cf.ops["read_annotation"] = core.Obj{"annotation": map[string]any{"file_name": "bra.gb", "format": "genbank"},
		"features": []any{
			map[string]any{"start": 108.0, "end": 473.0, "name": "C"},
			map[string]any{"start": 474.0, "end": 977.0, "name": "prM"},
		}, "seqid": "BRA.1", "sequence": bra}

	tt := ui.NewTester(a.View, 1100, 1300)
	a.Navigate("structure", map[string]any{"structureId": structA})
	csSettle(a, tt)
	p := a.PageFor("structure").(*structurePage)
	p.viewB = structB
	p.ensureRead(structB)
	for range 6 {
		csSettle(a, tt)
	}

	// B, folded on BRA, is moved onto AFR: every pair lands on A's.
	if len(p.arcs.B) != 1055 || p.stats.Shared != 1055 || p.stats.OnlyA != 0 || p.stats.OnlyB != 0 {
		t.Fatalf("B %d pairs, shared %d, only A %d, only B %d; notes %q", len(p.arcs.B), p.stats.Shared, p.stats.OnlyA, p.stats.OnlyB, p.layers.notes)
	}
	note := strings.Join(p.layers.notes, "\n")
	if !strings.Contains(note, "B is shown on A's coordinates: "+braGene+" → "+africaGene+" by alignment") {
		t.Fatalf("notes %q", p.layers.notes)
	}
	// Gene track moved by -1.
	if len(p.arcs.Features) != 2 || p.arcs.Features[0].Start != 107 || p.arcs.Features[1].End != 976 {
		t.Fatalf("features %+v", p.arcs.Features)
	}
	if !strings.Contains(note, "Gene track moved from BRA.1 onto "+africaGene) || !tt.HasText("Genes: bra.gb") {
		t.Fatalf("annotation note %q", p.layers.notes)
	}

	// Differential arcs of the AFR vs BRA test: up on AFR, down moved from BRA.
	p.setOverlay("compare-1791998444625")
	for range 6 {
		csSettle(a, tt)
	}
	up, down := 0, 0
	for _, o := range p.arcs.Overlay {
		if o.Up {
			up++
		} else {
			down++
		}
	}
	if up != 65 || down != 235 {
		t.Fatalf("overlay %d up, %d down; notes %q", up, down, p.layers.notes)
	}
	note = strings.Join(p.layers.notes, "\n")
	if !strings.Contains(note, "Differential arcs: 300 interactions with padj < 0.01, 65 higher in AFR (2 merged) (above) and 235 higher in BRA (2 merged) (below).") ||
		!strings.Contains(note, braGene+" cells moved onto "+africaGene+" by alignment.") {
		t.Fatalf("overlay note %q", p.layers.notes)
	}
	// A BRA cell at x is drawn at AFR x+5-1.
	result := p.layers.results["compare-1791998444625"]
	for _, row := range result.Interactions {
		if row.Direction != "down" || min(row.X, row.Y) <= 100 {
			continue
		}
		want := min(row.X, row.Y) + 5 - 1
		found := false
		for _, o := range p.arcs.Overlay {
			found = found || (!o.Up && o.I == want)
		}
		if !found {
			t.Fatalf("no down arc at %d", want)
		}
		break
	}
	// A stricter cutoff keeps fewer.
	p.layers.padj = 1e-12
	p.layers.version++
	csSettle(a, tt)
	if n := len(p.arcs.Overlay); n == 0 || n >= 300 {
		t.Fatalf("padj 1e-12 kept %d", n)
	}
	if !p.layers.mono {
		t.Fatal("choosing differential arcs should draw the structures in one colour")
	}
	if p.arcs.Mono.A == 0 {
		t.Fatal("arcs not in one colour")
	}
	p.layers.padj = 0.01
	p.layers.version++
	csSettle(a, tt)
	snapshot(t, tt, "structure-layers")

	// The SVG export carries the layers.
	svg, _ := arcSVG{A: p.arcs.A, B: p.arcs.B, Start: 1, End: 10807, Overlay: p.arcs.Overlay,
		OverlayUpLabel: p.overlayLabels[0], OverlayDown: p.overlayLabels[1], Features: p.arcs.Features, Mono: ui.RGB(34, 34, 34)}.SVG()
	for _, text := range []string{"higher in AFR (2 merged)", "higher in BRA (2 merged)", ">prM<"} {
		if !strings.Contains(svg, text) {
			t.Fatalf("svg lacks %q", text)
		}
	}
}
