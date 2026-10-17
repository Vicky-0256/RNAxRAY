package views

import (
	"testing"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
)

// qcFake holds analysis_summary until gate is closed (loading state).
type qcFake struct {
	*fakeBackend
	gate chan struct{}
}

func (f *qcFake) Query(path, operation string, payload core.Obj) (any, error) {
	if f.gate != nil {
		<-f.gate
	}
	return f.fakeBackend.Query(path, operation, payload)
}

func qcOpen(t *testing.T, gate chan struct{}, withSummary bool) (*App, *qcFake) {
	t.Helper()
	f := newFake(t)
	if withSummary {
		f.queries["analysis_summary"] = fixture(t, "qc_analysis_summary.json")["result"]
	}
	qf := &qcFake{fakeBackend: f, gate: gate}
	a := New(qf, nil, "")
	a.Open("/projects/zikv.rnaxrayproj")
	waitFlush(a)
	if a.Project == nil {
		t.Fatalf("project did not open: %q", a.start.status)
	}
	return a, qf
}

func TestQCPageCounts(t *testing.T) {
	gate := make(chan struct{})
	a, _ := qcOpen(t, gate, true)
	a.Navigate("qc", nil)
	tt := ui.NewTester(a.View, 1100, 720)
	dataExpect(t, tt, "Quality control", "Loading counts…", "loading…")
	close(gate)
	waitFlush(a)
	tt.Frame()
	dataExpect(t, tt,
		// Per sample (records, reads, reads per hybrid).
		"Per-sample summary", "Samples", "757", "224,154", "239,156", "1.07", "349,387", "411,891",
		// Shares: all intra-molecular, no ΔG; the four first types as columns.
		"100.0%", "0.0%", "Type 2", "Type 1", "Type 7", "Type 13", "55.5%",
		// Conditions merged: AFR = 224,154 + 349,387; BRA = 266,248 + 286,509.
		"Conditions (replicates merged)", "2 replicates", "573,541", "651,047", "552,757", "1,724", "AFR · rep 2")
	if tt.HasText("loading…") {
		t.Fatalf("still loading: %q", tt.Texts())
	}
	snapshot(t, tt, "qc")
	tt.SetDark(true)
	tt.Frame()
	snapshot(t, tt, "qc-dark")
	tt.SetDark(false)
	tt.Frame()

	// The Data page shows the same counts, compactly.
	q := qcFor(a)
	if q.stats["AFR_REP2"].Records != 349387 || q.stats["SUB_REP1"].Reads != 757 {
		t.Fatalf("stats %+v", q.stats)
	}
	// A sample's name selects it and opens Explore.
	if err := tt.Click("Explore AFR_REP1"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.Page != "explore" || a.Selected.Key != "s:AFR_REP1" {
		t.Fatalf("page %q selection %q", a.Page, a.Selected.Key)
	}
}

func TestQCPageError(t *testing.T) {
	a, f := qcOpen(t, nil, false)
	a.Navigate("qc", nil)
	waitFlush(a)
	tt := ui.NewTester(a.View, 1100, 720)
	waitFlush(a)
	tt.Frame()
	dataExpect(t, tt, "Could not load the counts: no fixture for analysis_summary", "Retry")
	snapshot(t, tt, "qc-error")
	f.queries["analysis_summary"] = fixture(t, "qc_analysis_summary.json")["result"]
	if err := tt.Click("Retry"); err != nil {
		t.Fatal(err)
	}
	waitFlush(a)
	tt.Frame()
	dataExpect(t, tt, "224,154")
	if tt.HasText("Could not load") {
		t.Fatalf("error still shown: %q", tt.Texts())
	}
}

func TestQCPageEmpty(t *testing.T) {
	f := newFake(t)
	listed := fixture(t, "list_samples.json")
	for _, s := range listed["samples"].([]any) {
		sample := s.(map[string]any)
		sample["ready"] = false
		sample["outputs"].(map[string]any)["index"] = nil
	}
	f.ops["list_samples"] = listed
	a := New(f, nil, "")
	a.Open("/projects/zikv.rnaxrayproj")
	waitFlush(a)
	a.Navigate("qc", nil)
	tt := ui.NewTester(a.View, 1100, 720)
	dataExpect(t, tt, "No analysed samples yet.", "Go to Data")
	snapshot(t, tt, "qc-empty")
	if err := tt.Click("Go to Data"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.Page != "data" {
		t.Fatalf("page %q", a.Page)
	}
}
