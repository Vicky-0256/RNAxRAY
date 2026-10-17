package core

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func near(a, b float64) bool { return math.Abs(a-b) <= 1e-6*math.Max(1, math.Abs(b)) }

func TestSampleEstimatePriorAndMeasured(t *testing.T) {
	// No history: the built-in rate, scaled by CPUs.
	seconds, measured := SampleEstimate(nil, "fastq.gz", 2_000_000_000, 10)
	if measured || !near(seconds, sampleOverhead+940) {
		t.Fatalf("prior %v %v", seconds, measured)
	}
	if half, _ := SampleEstimate(nil, "fastq.gz", 2_000_000_000, 5); !near(half, sampleOverhead+940*math.Pow(2, perfCPUExponent)) {
		t.Fatalf("5 cpus %v", half)
	}
	// Measured runs of the same format win (median; other formats ignored).
	history := []PerfRecord{
		{Kind: "sample_pipeline", Format: "fastq.gz", InputBytes: 100e6, CPU: 10, Seconds: 30},
		{Kind: "sample_pipeline", Format: "fastq.gz", InputBytes: 100e6, CPU: 10, Seconds: 50},
		{Kind: "sample_pipeline", Format: "fastq.gz", InputBytes: 200e6, CPU: 10, Seconds: 80},
		{Kind: "sample_pipeline", Format: "fastq", InputBytes: 100e6, CPU: 10, Seconds: 999},
	}
	seconds, measured = SampleEstimate(history, "fastq.gz", 1e9, 10)
	if !measured || !near(seconds, sampleOverhead+(80-sampleOverhead)*5) { // median rate: the 200 MB run
		t.Fatalf("measured %v %v", seconds, measured)
	}
	// A run measured with 5 CPUs counts as faster with 10.
	seconds, _ = SampleEstimate([]PerfRecord{{Kind: "sample_pipeline", Format: "hyb", InputBytes: 1e6, CPU: 5, Seconds: 10}}, "hyb", 1e6, 10)
	if !near(seconds, sampleOverhead+(10-sampleOverhead)*math.Pow(0.5, perfCPUExponent)) {
		t.Fatalf("scaled %v", seconds)
	}
	e := EstimatePipelines(history, []PipelineInput{{"fastq.gz", 1e9}, {"sam", 1e9}}, 10)
	if e.Samples != 2 || e.Measured != 1 || !near(e.Seconds, sampleOverhead+(80-sampleOverhead)*5+sampleOverhead+20) {
		t.Fatalf("batch %+v", e)
	}
}

func TestRemainingSeconds(t *testing.T) {
	work := map[string]any{"format": "fastq.gz", "input_bytes": 1e9, "cpu": 10.0}
	total, _ := SampleEstimate(nil, "fastq.gz", 1e9, 10)
	cases := []struct {
		progress Obj
		want     float64
		ok       bool
	}{
		{Obj{"stage": "check", "work": work}, total, true},
		{Obj{"stage": "reads", "work": work, "bytes_done": 50.0, "bytes_total": 100.0}, total * (1 - 0.075), true},
		{Obj{"stage": "map", "work": work, "bytes_done": 100.0, "bytes_total": 100.0}, total * 0.03, true},
		{Obj{"stage": "map", "detail": "waiting: another sample is mapping", "work": work}, 0, false},
		{Obj{"stage": "map"}, 0, false},
	}
	for i, c := range cases {
		got, ok := remainingSeconds(nil, c.progress, 4)
		if ok != c.ok || (ok && !near(got, c.want)) {
			t.Errorf("case %d: %v %v, want %v %v", i, got, ok, c.want, c.ok)
		}
	}
	if left, ok := remainingSeconds(nil, Obj{"stage": "index", "work": work}, 10); !ok || left > total*0.03 {
		t.Fatalf("after map %v", left)
	}
}

func TestPerfHistoryFile(t *testing.T) {
	dir := t.TempDir()
	path := perfPath(filepath.Join(dir, PrefsFileName))
	for i := 0; i < perfKeep+5; i++ {
		if err := AppendPerf(path, PerfRecord{Kind: "sample_pipeline", Format: "fastq", InputBytes: int64(i + 1), Seconds: 1}); err != nil {
			t.Fatal(err)
		}
	}
	got := LoadPerf(path)
	if len(got) != perfKeep || got[0].InputBytes != 6 {
		t.Fatalf("kept %d, first %+v", len(got), got[0])
	}
	// Nothing measured is not recorded.
	_ = AppendPerf(path, PerfRecord{Kind: "sample_pipeline", Format: "fastq"})
	if len(LoadPerf(path)) != perfKeep {
		t.Fatal("empty record stored")
	}
	run := filepath.Join(dir, "run")
	os.MkdirAll(run, 0o755)
	os.WriteFile(filepath.Join(run, "result.json"), []byte(`{"ok":true,"performance":{"format":"fastq.gz","input_bytes":160000000,"cpu":10,"seconds":76.5,"stage_seconds":{"map":66}}}`), 0o644)
	record, ok := perfFromResult("sample_pipeline", run)
	if !ok || record.Format != "fastq.gz" || record.InputBytes != 160000000 || record.CPU != 10 || record.Seconds != 76.5 {
		t.Fatalf("%+v %v", record, ok)
	}
	os.WriteFile(filepath.Join(run, "result.json"), []byte(`{"ok":false,"performance":{"format":"fastq","input_bytes":1,"seconds":1}}`), 0o644)
	if _, ok := perfFromResult("sample_pipeline", run); ok {
		t.Fatal("a failed run was recorded")
	}
}

func TestEstimateFold(t *testing.T) {
	// Built-in rate: 10,807 nt at beam 100 took ~81 s on an M1 Pro.
	e := EstimateFold(nil, []int{10807}, 100, 1)
	if e.Measured || e.Seconds < 75 || e.Seconds > 95 {
		t.Fatalf("genome %+v", e)
	}
	// Windows spread over workers, never faster than the largest window.
	one := EstimateFold(nil, []int{3000, 3000, 3000, 3000}, 100, 1).Seconds - foldOverhead
	four := EstimateFold(nil, []int{3000, 3000, 3000, 3000}, 100, 4).Seconds - foldOverhead
	if !near(one, 4*four) {
		t.Fatalf("parallel %v vs %v", one, four)
	}
	if got := EstimateFold(nil, []int{5000, 100}, 100, 8).Seconds - foldOverhead; !near(got, priorFoldSeconds*math.Pow(5, foldExponent)) {
		t.Fatalf("largest window bound %v", got)
	}
	// Measured folds replace the built-in rate (seconds x parallel / units).
	history := []PerfRecord{{Kind: "structure", Units: FoldUnits([]int{2000}, 100), Parallel: 1, Seconds: 10}}
	e = EstimateFold(history, []int{2000}, 100, 1)
	if !e.Measured || !near(e.Seconds, 10+foldOverhead) {
		t.Fatalf("measured %+v", e)
	}
}

func TestFoldRemaining(t *testing.T) {
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	total := EstimateFold(nil, []int{10807}, 100, 1).Seconds
	work := map[string]any{"lengths": []any{10807.0}, "beam": 100.0, "workers": 1.0}
	left, ok := foldRemaining(nil, Obj{"stage": "fold", "work": work, "updated_at": now.Add(-30 * time.Second).Format(time.RFC3339)}, now)
	if !ok || !near(left, total-foldOverhead-30) {
		t.Fatalf("genome %v %v", left, ok)
	}
	if _, ok := foldRemaining(nil, Obj{"stage": "fold", "work": work, "updated_at": now.Add(-time.Hour).Format(time.RFC3339)}, now); ok {
		t.Fatal("overdue fold reported a time left")
	}
	windows := map[string]any{"lengths": []any{3000.0, 3000.0, 3000.0, 3000.0}, "beam": 100.0, "workers": 2.0}
	wtotal := EstimateFold(nil, []int{3000, 3000, 3000, 3000}, 100, 2).Seconds
	left, ok = foldRemaining(nil, Obj{"stage": "fold", "work": windows, "bytes_done": 1.0, "bytes_total": 4.0}, now)
	if !ok || !near(left, wtotal*0.75) {
		t.Fatalf("windows %v %v", left, ok)
	}
	if _, ok := foldRemaining(nil, Obj{"stage": "write", "work": windows}, now); ok {
		t.Fatal("write stage")
	}
	// A finished fold's result.json becomes a structure record.
	run := t.TempDir()
	os.WriteFile(filepath.Join(run, "result.json"), []byte(`{"ok":true,"performance":{"lengths":[3000,3000],"beam":100,"workers":2,"seconds":12}}`), 0o644)
	record, ok := perfFromResult("structure", run)
	if !ok || record.Parallel != 2 || !near(record.Units, FoldUnits([]int{3000, 3000}, 100)) || record.Seconds != 12 {
		t.Fatalf("%+v %v", record, ok)
	}
	if err := AppendPerf(filepath.Join(run, perfFile), record); err != nil || len(LoadPerf(filepath.Join(run, perfFile))) != 1 {
		t.Fatalf("structure record not stored: %v", err)
	}
	// A fold that compiled the kernels does not measure the speed.
	os.WriteFile(filepath.Join(run, "result.json"), []byte(`{"ok":true,"performance":{"lengths":[3000],"beam":100,"workers":1,"seconds":70,"compiled":true}}`), 0o644)
	if _, ok := perfFromResult("structure", run); ok {
		t.Fatal("a compiling fold was recorded")
	}
}

// TestFoldRateFromAParallelRun: a run that took exactly its estimate does
// not change the next estimate (the stored rate is per unit of the work an
// estimate charges, not of all windows times the workers).
func TestFoldRateFromAParallelRun(t *testing.T) {
	lengths := []int{10000, 100}
	prior := EstimateFold(nil, lengths, 100, 2)
	dir := t.TempDir()
	runDir := filepath.Join(dir, "run")
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		t.Fatal(err)
	}
	result := fmt.Sprintf(`{"ok":true,"performance":{"lengths":[10000,100],"beam":100,"workers":2,"seconds":%f}}`,
		prior.Seconds-foldOverhead)
	if err := os.WriteFile(filepath.Join(runDir, "result.json"), []byte(result), 0o644); err != nil {
		t.Fatal(err)
	}
	record, ok := perfFromResult("structure", runDir)
	if !ok {
		t.Fatal("no record")
	}
	again := EstimateFold([]PerfRecord{record}, lengths, 100, 2)
	if math.Abs(again.Seconds-prior.Seconds)/prior.Seconds > 0.01 {
		t.Fatalf("estimate %.1f s, after a run that took exactly that: %.1f s", prior.Seconds, again.Seconds)
	}
	if single := EstimateFold([]PerfRecord{record}, []int{10000}, 100, 1); single.Seconds > prior.Seconds*1.01 {
		t.Fatalf("one 10 kb fold now %.1f s, was %.1f s", single.Seconds, prior.Seconds)
	}
}

// TestFoldsDoNotPushSampleTimingsOut: the history is kept per kind.
func TestFoldsDoNotPushSampleTimingsOut(t *testing.T) {
	path := filepath.Join(t.TempDir(), perfFile)
	if err := AppendPerf(path, PerfRecord{Kind: "sample_pipeline", Format: "fastq.gz", InputBytes: 1 << 20, CPU: 10, Seconds: 5}); err != nil {
		t.Fatal(err)
	}
	for range perfKeep + 5 {
		if err := AppendPerf(path, PerfRecord{Kind: "structure", Units: 1, Parallel: 1, Work: 1, Seconds: 1}); err != nil {
			t.Fatal(err)
		}
	}
	samples, folds := 0, 0
	for _, r := range LoadPerf(path) {
		switch r.Kind {
		case "sample_pipeline":
			samples++
		case "structure":
			folds++
		}
	}
	if samples != 1 || folds != perfKeep {
		t.Fatalf("kept %d sample and %d fold records", samples, folds)
	}
}
