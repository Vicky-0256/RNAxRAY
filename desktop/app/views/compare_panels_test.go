package views

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
)

// pnFake records the payloads of the panels' project operations.
type pnFake struct {
	*csFake
	payloads map[string][]core.Obj
}

func (f *pnFake) ProjectOp(path, operation string, payload core.Obj) (core.Obj, error) {
	f.mu.Lock()
	f.payloads[operation] = append(f.payloads[operation], payload)
	f.mu.Unlock()
	return f.csFake.ProjectOp(path, operation, payload)
}

func (f *pnFake) last(operation string) core.Obj {
	f.mu.Lock()
	defer f.mu.Unlock()
	list := f.payloads[operation]
	if len(list) == 0 {
		return nil
	}
	return list[len(list)-1]
}

// openPanels opens the fixture project with the panels' fixtures: the two
// ZIKV lineages' whole-RNA folds, the regions and energies of AFR vs ILM
// (captured from a real project made of reproduce_zikv's data).
func openPanels(t *testing.T) (*App, *pnFake) {
	t.Helper()
	cs := &csFake{fakeBackend: newFake(t), structures: map[string]core.Obj{}}
	f := &pnFake{csFake: cs, payloads: map[string][]core.Obj{}}
	cs.ops["list_comparisons"] = fixture(t, "compare_list.json")
	cs.ops["read_comparison"] = fixture(t, "compare_read.json")
	cs.ops["list_structures"] = fixture(t, "compare_folds.json")
	cs.ops["structure_regions"] = fixture(t, "compare_regions.json")
	cs.ops["read_energy"] = fixture(t, "compare_energy.json")
	a := New(f, nil, "")
	a.Open("/projects/zikv.rnaxrayproj")
	waitFlush(a)
	if a.Project == nil {
		t.Fatalf("project did not open: %q", a.start.status)
	}
	return a, f
}

func TestComparePanelsRegionsAndEnergy(t *testing.T) {
	a, f := openPanels(t)
	tt := ui.NewTester(a.View, 1100, 3200)
	a.Navigate("compare", nil)
	csSettle(a, tt)
	p := a.PageFor("compare").(*comparePage)
	s := &p.panels
	if s.foldA != "structure-zafr" || s.foldB != "structure-zilm" {
		t.Fatalf("default folds %q %q", s.foldA, s.foldB)
	}
	for _, text := range []string{"Enriched regions", "Folding energy", "Show regions",
		"mean dG AFR (2 merged) -24.53 · BRA (2 merged) -20.68 kcal/mol · t = -14.22",
		"ZAFR · ZAFR_REP1 + ZAFR_REP2 · 2026-10-16 11:00",
		"1,616 of 1,621 interactions with padj < 0.01 folded (5 ran off an end) · 40 nt fragments · ViennaRNA 2.7.2"} {
		if !tt.HasText(text) {
			t.Fatalf("lacks %q: %q", text, tt.Texts())
		}
	}
	if err := tt.Click("Show regions"); err != nil {
		t.Fatal(err)
	}
	csSettle(a, tt)
	payload := f.last("structure_regions")
	if payload["comparison_id"] != p.selectedID || payload["structure_one"] != "structure-zafr" || payload["structure_two"] != "structure-zilm" ||
		payload["padj"] != 0.01 || payload["reach"] != 50 || payload["flank"] != 15 {
		t.Fatalf("payload %v", payload)
	}
	for _, text := range []string{
		"Region A · higher in AFR (2 merged)", "#2 · 365 ↔ 10,305 · log2FC +7.31 · padj 7.31e-09",
		"Windows 341–415 / 10,252–10,318 on AFR (2 merged)'s coordinates · 29 pairs of AFR (2 merged)'s fold within ±50 nt of both arms (0 of BRA (2 merged)'s)",
		"pairs in X 0 · in Y 0 · between windows 29", "33 bases paired outside: 264–274; 8300–8310; 10090–10097; 10334–10344",
		"90 bases paired outside: 256–257; 527–530; 543–600; 10079–10092; 10099–10111; 10358–10384",
		"Region B · higher in BRA (2 merged)", "#7 · 9,365 ↔ 10,015 · log2FC -7.93 · padj 2.69e-09",
		"pairs in X 0 · in Y 0 · between windows 13", "49 bases paired outside: 9183–9195; 9578–9592; 9821–9839; 10057–10074",
		"63 bases paired outside: 9577–9616; 9853–9892; 9898–9901",
	} {
		if !tt.HasText(text) {
			t.Fatalf("lacks %q: %q", text, tt.Texts())
		}
	}
	snapshot(t, tt, "compare-panels")
	tt.SetDark(true)
	tt.Frame()
	snapshot(t, tt, "compare-panels-dark")
	tt.SetDark(false)

	// another candidate asks again with the choice
	s.choice["up"] = 5
	p.runRegions(p.entry(p.selectedID))
	csSettle(a, tt)
	choice, _ := f.last("structure_regions")["choice"].(core.Obj)
	if choice["up"] != 5 || choice["down"] != 7 {
		t.Fatalf("choice %v", f.last("structure_regions"))
	}

	// Compute starts an energy task on the selected test
	s.energyLen, s.energyPadj = 30, 0.05
	if err := tt.Click("Compute again"); err != nil {
		t.Fatal(err)
	}
	csSettle(a, tt)
	started := f.startedKinds()
	req := started[len(started)-1]
	params := req.Parameters.(map[string]any)
	if req.Kind != "energy" || req.ComparisonID == nil || *req.ComparisonID != p.selectedID || params["length"] != 30 || params["padj"] != 0.05 {
		t.Fatalf("request %+v", req)
	}
	if !tt.HasText("Folding energy · AFR (2 merged) vs BRA (2 merged) · 30 nt") {
		t.Fatalf("running task not listed: %q", tt.Texts())
	}
	// its end reloads the energies
	before := csCountCalls(f.csFake, "op:read_energy")
	id := ""
	for _, task := range a.Tasks {
		if task.Kind == "energy" {
			id = task.TaskID
		}
	}
	a.storeTask(model.Task{TaskID: id, Kind: "energy", Status: "succeeded", StartedAt: "2026-10-14T10:00:00Z"})
	csSettle(a, tt)
	if csCountCalls(f.csFake, "op:read_energy") <= before {
		t.Fatal("energies not reloaded")
	}

	// exports
	asked := pickSaveInto(t, t.TempDir())
	p.exportRegionsSVG(p.context(p.entry(p.selectedID)))
	waitFlush(a)
	svg := readExport(t, asked)
	xmlWellFormed(t, svg)
	keepExport(t, "export-regions.svg", svg)
	if !strings.Contains(svg, "Region A · higher in AFR (2 merged)") || strings.Count(svg, "<circle") != 2*142+2*94 {
		t.Fatalf("regions svg: %d circles", strings.Count(svg, "<circle"))
	}
	p.exportRegionsTSV(p.context(p.entry(p.selectedID)))
	waitFlush(a)
	if tsv := readExport(t, asked); strings.Count(tsv, "\n") != 2+1+2*142+2*94 || !strings.Contains(tsv, "Region A\tAFR (2 merged)\t2\tAFR (2 merged)\tstructure-zafr\tX\t342\tA\t79.47\t495.70\t\t274") {
		t.Fatalf("regions tsv:\n%.600s", tsv)
	}
	p.exportEnergySVG(p.context(p.entry(p.selectedID)))
	waitFlush(a)
	svg = readExport(t, asked)
	xmlWellFormed(t, svg)
	keepExport(t, "export-energy.svg", svg)
	if strings.Count(svg, "<polygon") != 8 || !strings.Contains(svg, "paired t-test p = 5.7e-37") || !strings.Contains(svg, "p = 2.4e-73") {
		t.Fatalf("energy svg: %d polygons", strings.Count(svg, "<polygon"))
	}
	p.exportEnergyTSV(p.context(p.entry(p.selectedID)))
	waitFlush(a)
	if tsv := readExport(t, asked); strings.Count(tsv, "\n") != 4+1+1616 || !strings.Contains(tsv, "length\tside\tx\ty\tlog2FoldChange\tpadj\tdG_one\tdG_two") {
		t.Fatalf("energy tsv:\n%.400s", tsv)
	}
}

// keepExport copies an exported file to $RNAXRAY_SNAPSHOT_DIR, to look at.
func keepExport(t *testing.T, name, text string) {
	if dir := os.Getenv("RNAXRAY_SNAPSHOT_DIR"); dir != "" {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestComparePanelsWithoutFolds(t *testing.T) {
	a, f := openPanels(t)
	f.ops["list_structures"] = core.Obj{"structures": []any{}}
	f.ops["read_energy"] = core.Obj{"lengths": []any{}, "summary": nil, "rows": nil}
	tt := ui.NewTester(a.View, 1100, 3200)
	a.Navigate("compare", nil)
	csSettle(a, tt)
	for _, text := range []string{"Fold the whole RNA of each lineage on the Structure page (New fold → whole RNA) to draw the regions.",
		"Not computed for this test yet.", "Compute"} {
		if !tt.HasText(text) {
			t.Fatalf("lacks %q: %q", text, tt.Texts())
		}
	}
}

func TestViolinStatistics(t *testing.T) {
	// R: quantile(x, c(.25, .5, .75)); bw.nrd0(x)
	x := []float64{1, 2, 3, 4, 10, 2.5, 3.5, -6}
	v := violin(x)
	if v.Q1 != 1.75 || v.Median != 2.75 || v.Q3 != 3.625 || math.Abs(v.Bandwidth-0.830846865458679) > 1e-12 {
		t.Fatalf("%+v", v)
	}
	// whiskers: furthest values within 1.5 IQR of the hinges; the rest are outliers
	if v.WhiskerLo != 1 || v.WhiskerHi != 4 || len(v.Outliers) != 2 {
		t.Fatalf("whiskers %v %v outliers %v", v.WhiskerLo, v.WhiskerHi, v.Outliers)
	}
	// the density integrates to about 1 over its grid (trim = FALSE: +-3 bandwidths)
	area := 0.0
	for g := 1; g < len(v.Grid); g++ {
		area += (v.Grid[g] - v.Grid[g-1]) * (v.Density[g] + v.Density[g-1]) / 2
	}
	if math.Abs(area-1) > 0.01 {
		t.Fatalf("area %v", area)
	}
	if bw := bwNrd0([]float64{5, 5, 5, 5}); math.Abs(bw-3.4103622746484) > 1e-12 {
		t.Fatalf("constant bw %v", bw)
	}
	if empty := violin(nil); empty.N != 0 || empty.Grid != nil {
		t.Fatalf("%+v", empty)
	}
}

func TestRegionFigureMarksBases(t *testing.T) {
	// two windows of three bases: 1-6 (between windows), 2 paired outside, 3 unpaired
	pn := &regionPanel{Windows: [][2]int{{1, 3}, {10, 12}}, Pos: []int{1, 2, 3, 10, 11, 12}, Window: []int{0, 0, 0, 1, 1, 1},
		Base: "GACGUC", X: []float64{0, 15, 30, 60, 75, 90}, Y: []float64{0, 0, 0, 0, 0, 0},
		Partner: []int{5, -1, -1, -1, -1, 0}, Outside: []int{0, 40, 0, 0, 0, 0}, Linker: [][2]float64{{40, 0}, {45, 0}, {50, 0}}}
	fig := regionFigure(pn, cmpRed, figLight, 200)
	var circles, red, hollow int
	for _, sh := range fig.Shapes {
		if sh.Kind != figCircle {
			continue
		}
		circles++
		if sh.Fill == cmpRed {
			red++
		}
		if sh.Fill == figLight.Background && sh.Stroke == figLight.Text {
			hollow++
		}
	}
	if circles != 6 || red != 2 || hollow != 1 {
		t.Fatalf("circles %d red %d hollow %d", circles, red, hollow)
	}
	var b strings.Builder
	fig.svg(&b, 0, 0, 1)
	if !strings.Contains(b.String(), "5′ 1") || !strings.Contains(b.String(), `stroke-dasharray="3 3"`) {
		t.Fatalf("%s", b.String())
	}
}

// TestReportIncludesFoldingEnergy: a test with energies gets the violins in
// the exported report, as the similarity heatmap.
func TestReportIncludesFoldingEnergy(t *testing.T) {
	a, f := openReport(t)
	f.ops["read_energy"] = fixture(t, "compare_energy.json")
	tt := ui.NewTester(a.View, 1100, 900)
	a.Navigate("report", nil)
	csSettle(a, tt)
	asked := pickSaveInto(t, t.TempDir())
	if err := tt.Click("Export report…"); err != nil {
		t.Fatal(err)
	}
	waitFlush(a)
	text := readExport(t, asked)
	for _, want := range []string{"Folding energy of enriched interactions (2 × 40 nt)",
		"enriched in AFR (2 merged): n = 375, mean dG AFR (2 merged) -24.53 vs BRA (2 merged) -20.68 kcal/mol, paired t-test p = 5.7e-37",
		"enriched in BRA (2 merged): n = 1,241"} {
		if !strings.Contains(text, want) {
			t.Fatalf("report lacks %q", want)
		}
	}
	svgs := regexp.MustCompile(`(?s)<svg .*?</svg>`).FindAllString(text, -1)
	energy := 0
	for _, svg := range svgs {
		xmlWellFormed(t, svg)
		if strings.Contains(svg, "Folding energy of enriched") {
			energy++
			if strings.Count(svg, "<polygon") != 8 {
				t.Fatalf("violins %d", strings.Count(svg, "<polygon"))
			}
		}
	}
	if energy != 2 { // both tests of the fixture answer the same energies
		t.Fatalf("%d energy figures of %d", energy, len(svgs))
	}
}
