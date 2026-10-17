package views

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
)

// exploreFake answers the analysis queries from testdata/explore_*.json
// (captured from the ZIKV GUI project, selection SUB) and records payloads.
type exploreFake struct {
	*fakeBackend
	mu       sync.Mutex
	payloads map[string][]core.Obj
}

func (f *exploreFake) Query(path, operation string, payload core.Obj) (any, error) {
	f.mu.Lock()
	copied := core.Obj{}
	raw, _ := json.Marshal(payload)
	_ = json.Unmarshal(raw, &copied)
	f.payloads[operation] = append(f.payloads[operation], copied)
	f.mu.Unlock()
	return f.fakeBackend.Query(path, operation, payload)
}

func (f *exploreFake) last(operation string) core.Obj {
	f.mu.Lock()
	defer f.mu.Unlock()
	list := f.payloads[operation]
	if len(list) == 0 {
		return nil
	}
	return list[len(list)-1]
}

func (f *exploreFake) count(operation string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.payloads[operation])
}

func openExplore(t *testing.T) (*App, *exploreFake, *explorePage, *ui.Tester) {
	t.Helper()
	base := newFake(t)
	for op, name := range map[string]string{"analysis_summary": "explore_summary.json", "analysis_contact_bins": "explore_contact.json",
		"analysis_hybrids": "explore_hybrids.json", "analysis_viewpoint": "explore_viewpoint.json", "analysis_region": "explore_region.json"} {
		base.queries[op] = fixture(t, name)
	}
	f := &exploreFake{fakeBackend: base, payloads: map[string][]core.Obj{}}
	a := New(f, nil, "")
	a.Open("/projects/zikv.rnaxrayproj")
	waitFlush(a)
	if a.Project == nil {
		t.Fatalf("project did not open: %q", a.start.status)
	}
	a.RegisterPage("structure", &navSpy{a: a})
	a.Navigate("explore", nil)
	p := a.PageFor("explore").(*explorePage)
	tt := ui.NewTester(a.View, 1100, 720)
	settle(a, tt)
	return a, f, p, tt
}

// navSpy stands in for ⑤ Structure and keeps the options it was shown with.
type navSpy struct {
	a       *App
	options map[string]any
}

func (n *navSpy) Show()            { n.options = n.a.NavOptions }
func (n *navSpy) View(*ui.Context) {}

func structureOptions(a *App) map[string]any { return a.PageFor("structure").(*navSpy).options }

// settle draws, lets queries answer, and draws again.
func settle(a *App, tt *ui.Tester) {
	for range 3 {
		tt.Frame()
		waitFlush(a)
	}
	tt.Frame()
}

const zikvGene = "ZIKV_African_KX377335-1_virusRNA"

func TestExploreContactMapPickShowHybridsAndFold(t *testing.T) {
	a, f, p, tt := openExplore(t)
	if p.tab != tabContact || p.cm.data == nil {
		t.Fatalf("tab %d data %v err %q texts %q", p.tab, p.cm.data, p.cm.load.err, tt.Texts())
	}
	sent := f.last("analysis_contact_bins")
	if fmt.Sprint(sent["sample_ids"]) != "[SUB_REP1 SUB_REP2]" || sent["gene"] != zikvGene || sent["max_cells"] != float64(autoMaxCells) {
		t.Fatalf("contact payload %v", sent)
	}
	d := p.cm.data
	if len(d.count) != 2601 || d.bin != 100 || len(p.cm.heat.Cells()) != 2601 {
		t.Fatalf("cells %d bin %d", len(d.count), d.bin)
	}
	for _, text := range []string{"Explore", "Contact map", "Selected cell", "Bin size", "Colour cap", "1,724"} {
		if !tt.HasText(text) && !strings.Contains(strings.Join(tt.Texts(), "\n"), text) {
			t.Fatalf("contact map lacks %q: %q", text, tt.Texts())
		}
	}
	snapshot(t, tt, "explore-contact")

	// Click the strongest cell: the plot starts 44 DIPs right of the map box.
	best := 0
	for i, n := range d.count {
		if n > d.count[best] {
			best = i
		}
	}
	box, ok := tt.Find("Contact map of " + zikvGene)
	if !ok {
		t.Fatalf("no heatmap in %q", tt.Texts())
	}
	gx := (float64(d.x[best]) + float64(d.bin)/2) / float64(d.lengthX)
	gy := (float64(d.y[best]) + float64(d.bin)/2) / float64(d.lengthY)
	tt.ClickAt(box.X+44+float32(gx)*mapSizeTarget, box.Y+float32(gy)*mapSizeTarget)
	tt.Frame()
	if p.cm.picked != best {
		t.Fatalf("picked %d, want %d (box %+v)", p.cm.picked, best, box)
	}
	x0, x1 := cellRange(d.x[best], d.bin)
	if !tt.HasText("Arm 1 (X)") || !tt.HasText(span(x0, x1)) {
		t.Fatalf("details missing: %q", tt.Texts())
	}
	tt.Move(box.X+44+float32(gx)*mapSizeTarget, box.Y+float32(gy)*mapSizeTarget)
	tt.Frame()
	if !strings.Contains(p.cm.hover, fmt.Sprintf("%d records", d.count[best])) {
		t.Fatalf("hover %q", p.cm.hover)
	}
	snapshot(t, tt, "explore-contact-picked")
	tt.SetDark(true)
	tt.Frame()
	snapshot(t, tt, "explore-contact-dark")
	tt.SetDark(false)

	// Show hybrids: Interactions filtered to the cell's ranges.
	if err := tt.Click("Show hybrids"); err != nil {
		t.Fatal(err)
	}
	settle(a, tt)
	if p.tab != tabInteractions {
		t.Fatalf("tab %d", p.tab)
	}
	y0, y1 := cellRange(d.y[best], d.bin)
	filters := f.last("analysis_hybrids")["filters"].(map[string]any)
	if fmt.Sprint(filters["region"]) != fmt.Sprintf("map[x:[%d %d] y:[%d %d]]", x0, x1, y0, y1) || filters["gene1"] != zikvGene {
		t.Fatalf("hybrid filters %v", filters)
	}

	// Back to the map: the pick survived; fold its region.
	if err := tt.Click("Contact map"); err != nil {
		t.Fatal(err)
	}
	settle(a, tt)
	if p.cm.picked != best {
		t.Fatalf("pick lost: %d", p.cm.picked)
	}
	if err := tt.Click("Fold this region"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.Page != "structure" {
		t.Fatalf("page %q", a.Page)
	}
	pad := max(50, 2*d.bin)
	start := max(1, min(d.x[best], d.y[best])-pad)
	end := min(10807, max(d.x[best], d.y[best])+d.bin-1+pad)
	prefill := structureOptions(a)["prefill"].(map[string]any)
	want := fmt.Sprint(map[string]any{"gene": zikvGene, "windows": []map[string]int{{"start": start, "end": end}},
		"selectionKey": "c:SUB", "source": "contact map"})
	if fmt.Sprint(prefill) != want {
		t.Fatalf("prefill %v, want %v", prefill, want)
	}
}

func TestExploreInteractionsTableAndLoadMore(t *testing.T) {
	a, f, p, tt := openExplore(t)
	if err := tt.Click("Interactions"); err != nil {
		t.Fatal(err)
	}
	settle(a, tt)
	if len(p.ix.rows) != 40 || p.ix.total != 1724 {
		t.Fatalf("rows %d total %d err %q", len(p.ix.rows), p.ix.total, p.ix.load.err)
	}
	for _, text := range []string{"Showing 40 of 1,724 hybrids", "Gene 1", "Arm 2", "Reads", "Load more", "Sample"} {
		if !tt.HasText(text) {
			t.Fatalf("interactions lack %q: %q", text, tt.Texts())
		}
	}
	snapshot(t, tt, "explore-interactions")
	tt.SetDark(true)
	tt.Frame()
	snapshot(t, tt, "explore-interactions-dark")
	tt.SetDark(false)
	if err := tt.Click("Load more"); err != nil {
		t.Fatal(err)
	}
	settle(a, tt)
	if len(p.ix.rows) != 80 || f.last("analysis_hybrids")["offset"] != float64(40) {
		t.Fatalf("after load more: rows %d payload %v", len(p.ix.rows), f.last("analysis_hybrids"))
	}
	// Filters apply to the query (and reset the paging).
	p.ix.minReads = "2"
	p.ix.order = orderLabels[1]
	if err := tt.Click("Apply"); err != nil {
		t.Fatal(err)
	}
	settle(a, tt)
	sent := f.last("analysis_hybrids")
	if sent["order"] != "reads" || sent["offset"] != float64(0) || fmt.Sprint(sent["filters"]) != "map[min_reads:2]" {
		t.Fatalf("payload %v", sent)
	}
	if len(p.ix.rows) != 40 {
		t.Fatalf("rows %d", len(p.ix.rows))
	}
}

func TestExploreViewpointAndRegion(t *testing.T) {
	a, f, p, tt := openExplore(t)
	// Tall enough that "Explore region" stays in view with any platform's
	// fonts (Windows renders taller and pushed it below a 720 px window).
	tt.SetSize(1100, 1400)
	if err := tt.Click("Viewpoint"); err != nil {
		t.Fatal(err)
	}
	settle(a, tt)
	if p.vp.data == nil || p.vp.profile.Len() == 0 {
		t.Fatalf("viewpoint %+v err %q", p.vp.data, p.vp.load.err)
	}
	if !tt.HasText("Partners in range") || !tt.HasText("Selected interval") {
		t.Fatalf("viewpoint texts %q", tt.Texts())
	}
	snapshot(t, tt, "explore-viewpoint")
	// Pick a bin and explore its region.
	box, ok := tt.Find("Viewpoint coverage of " + zikvGene)
	if !ok {
		t.Fatalf("no profile: %q", tt.Texts())
	}
	tt.ClickAt(box.X+profileAxisForTest+(box.W-profileAxisForTest)/2, box.Y+60)
	tt.Frame()
	if p.vp.profile.Picked < 0 {
		t.Fatal("no bin picked")
	}
	start, end, _ := p.vp.profile.Bin(p.vp.profile.Picked)
	if err := tt.Click("Explore region"); err != nil {
		t.Fatal(err)
	}
	settle(a, tt)
	sent := f.last("analysis_region")
	if p.tab != tabRegion || sent["start"] != float64(start) || sent["end"] != float64(end) || sent["gene"] != zikvGene {
		t.Fatalf("tab %d region payload %v (bin %d-%d)", p.tab, sent, start, end)
	}
	for _, text := range []string{"Strongest interactions (25)", "Partners", "Show hybrids", "Fold this region"} {
		if !tt.HasText(text) {
			t.Fatalf("region lacks %q: %q", text, tt.Texts())
		}
	}
	snapshot(t, tt, "explore-region")
	tt.SetDark(true)
	tt.Frame()
	snapshot(t, tt, "explore-region-dark")
	tt.SetDark(false)
	if err := tt.Click("Fold this region"); err != nil {
		t.Fatal(err)
	}
	prefill := structureOptions(a)["prefill"].(map[string]any)
	// the fixture answers 3000-3600 whatever was asked; the fold uses the range shown
	if fmt.Sprint(prefill["windows"]) != "[map[end:3600 start:3000]]" || prefill["source"] != "region" || prefill["gene"] != zikvGene {
		t.Fatalf("prefill %v", prefill)
	}
}

const profileAxisForTest = 48

func TestExploreFollowsSelection(t *testing.T) {
	a, f, p, tt := openExplore(t)
	before := f.count("analysis_contact_bins")
	p.cm.picked = 3
	a.Selected.Key = "c:AFR"
	settle(a, tt)
	sent := f.last("analysis_contact_bins")
	if f.count("analysis_contact_bins") != before+1 || fmt.Sprint(sent["sample_ids"]) != "[AFR_REP1 AFR_REP2]" {
		t.Fatalf("no reload for the new selection: %d calls, last %v", f.count("analysis_contact_bins"), sent)
	}
	if p.cm.picked != -1 {
		t.Fatalf("pick kept across selections: %d", p.cm.picked)
	}
	if fmt.Sprint(f.last("analysis_summary")["sample_ids"]) != "[AFR_REP1 AFR_REP2]" {
		t.Fatalf("summary not reloaded: %v", f.last("analysis_summary"))
	}
	// Redrawing the same selection does not query again.
	n := f.count("analysis_contact_bins")
	settle(a, tt)
	if f.count("analysis_contact_bins") != n {
		t.Fatal("redraw queried again")
	}
}

func TestExploreDropsStaleResults(t *testing.T) {
	a, _, p, _ := openExplore(t)
	l := &p.cm.load
	l.reset()
	p.ensure(l, "old", func() (func(), error) { return func() { t.Error("stale result applied") }, nil })
	p.ensure(l, "new", func() (func(), error) { return nil, nil })
	waitFlush(a)
	if l.shown != "new" || l.busy() {
		t.Fatalf("loader %+v", *l)
	}
}

func TestExploreNavigationFromCompare(t *testing.T) {
	a, f, p, tt := openExplore(t)
	a.Navigate("explore", map[string]any{"view": "region", "selectionKey": "c:SUB", "gene": zikvGene,
		"binSize": 10, "x": 3000, "y": 5000, "xEnd": 3009, "yEnd": 5009})
	settle(a, tt)
	sent := f.last("analysis_region")
	if p.tab != tabRegion || sent["start"] != float64(3000) || sent["end"] != float64(3009) ||
		sent["partner_start"] != float64(5000) || sent["partner_end"] != float64(5009) || a.NavOptions != nil {
		t.Fatalf("tab %d payload %v", p.tab, sent)
	}
	a.Navigate("explore", map[string]any{"view": "contact-map", "binSize": 100, "x": 3000, "y": 1800, "xEnd": 3099, "yEnd": 1899})
	settle(a, tt)
	d := p.cm.data
	if p.tab != tabContact || p.cm.bin != "100 nt" || d == nil || p.cm.picked < 0 || d.x[p.cm.picked] != 3000 || d.y[p.cm.picked] != 1800 {
		t.Fatalf("tab %d bin %q picked %d", p.tab, p.cm.bin, p.cm.picked)
	}
	if !p.cm.heat.Zoomed() {
		t.Fatal("not zoomed to the cell")
	}
	snapshot(t, tt, "explore-contact-focus")
}
