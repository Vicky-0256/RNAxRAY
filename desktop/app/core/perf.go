package core

// Speed of this computer for time estimates. Every finished sample
// pipeline adds its active time (sample_run.py's result "performance",
// without waiting for the map slot) to performance.json beside
// preferences.json; estimates use the recent runs of the same input format,
// or a built-in rate measured on an Apple M1 Pro until there are none.

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"sync"
	"time"
)

// PerfRecord is one finished sample pipeline or structure fold.
type PerfRecord struct {
	Kind       string  `json:"kind"`
	Format     string  `json:"format,omitempty"`
	InputBytes int64   `json:"input_bytes,omitempty"`
	CPU        uint32  `json:"cpu,omitempty"`
	Seconds    float64 `json:"seconds"`
	At         string  `json:"at"`
	// Structure folds: FoldUnits of the windows and how many ran at once.
	Units    float64 `json:"units,omitempty"`
	Parallel int     `json:"parallel,omitempty"`
	// Work is what EstimateFold charges for these windows (foldWork): the
	// fold's rate is Seconds / Work. Older records lack it.
	Work float64 `json:"work,omitempty"`
}

const (
	perfFile = "performance.json"
	perfKeep = 200
	// perfRecent is how many recent runs of a format an estimate uses.
	perfRecent = 20
	// perfCPUExponent: Bowtie2 time ~ cpus^-0.7 (measured: 4 -> 10 threads
	// is 1.9x faster).
	perfCPUExponent = 0.7
	priorCPU        = 10
	// sampleOverhead is the fixed time of a sample pipeline (process start,
	// Bowtie2 index, analysis index): 14 samples of 200,000 reads took 1.4 s
	// each more than their size alone predicts.
	sampleOverhead = 1.5
)

// priorSecondsPerMB are seconds per MB of input at 10 CPUs (Apple M1 Pro,
// ZIKV SPLASH reads; fastq.gz: 3 M reads, 160 MB in 76 s, and a full 2 GB
// sample in ~15 min).
var priorSecondsPerMB = map[string]float64{
	"fastq.gz": 0.47, "fastq": 0.078, "fasta.gz": 0.4, "fasta": 0.07, "sam": 0.02, "hyb": 0.01,
}

// sampleStageWeights is the share of a sample pipeline's time before and
// in each stage, for the remaining time of a running one (measured: reads
// ~15%, map ~82%, the rest ~3%).
var sampleStageWeights = map[string][2]float64{
	"check": {0, 0}, "reference": {0, 0}, "reads": {0, 0.15}, "map": {0.15, 0.82},
}

var perfMu sync.Mutex

func perfPath(prefsPath string) string {
	if prefsPath == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(prefsPath), perfFile)
}

// LoadPerf reads the history; a missing or corrupt file is empty.
func LoadPerf(path string) []PerfRecord {
	if path == "" {
		return nil
	}
	perfMu.Lock()
	defer perfMu.Unlock()
	return readPerf(path)
}

func readPerf(path string) []PerfRecord {
	var records []PerfRecord
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &records)
	}
	return records
}

// AppendPerf adds a record, keeping the most recent perfKeep of its kind
// (many folds must not push the sample timings out, nor the reverse).
func AppendPerf(path string, record PerfRecord) error {
	if path == "" || record.Seconds <= 0 || (record.Kind == "structure" && record.Units <= 0) ||
		(record.Kind != "structure" && record.InputBytes <= 0) {
		return nil
	}
	perfMu.Lock()
	defer perfMu.Unlock()
	records := append(readPerf(path), record)
	seen := map[string]int{}
	kept := make([]PerfRecord, 0, len(records))
	for i := len(records) - 1; i >= 0; i-- {
		if seen[records[i].Kind]++; seen[records[i].Kind] <= perfKeep {
			kept = append(kept, records[i])
		}
	}
	slices.Reverse(kept)
	records = kept
	data, err := json.MarshalIndent(records, "", " ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// perfFromResult is the record of a finished sample pipeline's or
// structure fold's result.json ("performance"), or false.
func perfFromResult(kind, runDir string) (PerfRecord, bool) {
	data, err := os.ReadFile(filepath.Join(runDir, "result.json"))
	if err != nil {
		return PerfRecord{}, false
	}
	var result struct {
		OK          bool `json:"ok"`
		Performance *struct {
			Format     string  `json:"format"`
			InputBytes int64   `json:"input_bytes"`
			CPU        uint32  `json:"cpu"`
			Seconds    float64 `json:"seconds"`
			Lengths    []int   `json:"lengths"`
			Beam       int     `json:"beam"`
			Workers    int     `json:"workers"`
			// The run compiled Numba kernels: its time is not the speed.
			Compiled bool `json:"compiled"`
		} `json:"performance"`
	}
	if json.Unmarshal(data, &result) != nil || !result.OK || result.Performance == nil || result.Performance.Compiled {
		return PerfRecord{}, false
	}
	p := result.Performance
	record := PerfRecord{Kind: kind, Seconds: p.Seconds, At: time.Now().UTC().Format(time.RFC3339)}
	switch kind {
	case "sample_pipeline":
		record.Format, record.InputBytes, record.CPU = p.Format, p.InputBytes, p.CPU
	case "structure":
		record.Units, record.Parallel = FoldUnits(p.Lengths, p.Beam), foldParallel(len(p.Lengths), p.Workers)
		record.Work = foldWork(p.Lengths, p.Beam, p.Workers)
		if record.Units <= 0 {
			return PerfRecord{}, false
		}
	default:
		return PerfRecord{}, false
	}
	return record, true
}

// ---- structure folds

const (
	// CPLfold time grows as length^1.7 and linearly with the beam (measured
	// on an Apple M1 Pro, one core, beam 100: 1000 nt 1.5 s, 2000 nt 5 s,
	// 5000 nt 21 s, 10,807 nt 81 s; pseudoknots barely change it).
	foldExponent = 1.7
	// priorFoldSeconds is the time of one unit (1000 nt, beam 100).
	priorFoldSeconds = 1.45
	// foldOverhead covers starting the task and reading the .hyb evidence.
	foldOverhead = 2.0
)

// FoldUnits is the work of folding windows of these lengths:
// sum of (length/1000)^1.7 x beam/100.
func FoldUnits(lengths []int, beam int) float64 {
	if beam <= 0 {
		beam = 100
	}
	var units float64
	for _, n := range lengths {
		units += math.Pow(float64(n)/1000, foldExponent) * float64(beam) / 100
	}
	return units
}

func foldParallel(windows, workers int) int {
	return max(1, min(max(workers, 1), max(windows, 1)))
}

// FoldEstimate is the expected time of a structure fold.
type FoldEstimate struct {
	Seconds  float64 `json:"seconds"`
	Measured bool    `json:"measured"`
}

// EstimateFold is the expected time of folding windows of these lengths
// (one for the whole RNA), at most workers at once, from this computer's
// recent folds or the built-in rate.
func EstimateFold(history []PerfRecord, lengths []int, beam, workers int) FoldEstimate {
	var rates []float64
	for i := len(history) - 1; i >= 0 && len(rates) < perfRecent; i-- {
		r := history[i]
		switch {
		case r.Kind != "structure" || r.Seconds <= 0:
		case r.Work > 0:
			rates = append(rates, r.Seconds/r.Work)
		case r.Units > 0: // older record: assumes the windows spread evenly
			rates = append(rates, r.Seconds*float64(max(r.Parallel, 1))/r.Units)
		}
	}
	rate, measured := priorFoldSeconds, false
	if len(rates) > 0 {
		sort.Float64s(rates)
		rate, measured = rates[len(rates)/2], true
	}
	return FoldEstimate{Seconds: foldWork(lengths, beam, workers)*rate + foldOverhead, Measured: measured}
}

// foldWork is the work of folding windows of these lengths at most workers
// at once: spread over the workers, but never less than the largest window.
func foldWork(lengths []int, beam, workers int) float64 {
	largest := 0
	for _, n := range lengths {
		largest = max(largest, n)
	}
	return math.Max(FoldUnits(lengths, beam)/float64(foldParallel(len(lengths), workers)), FoldUnits([]int{largest}, beam))
}

// foldRemaining is the time left of a running fold from its progress
// ({stage, bytes_done, bytes_total, updated_at, work: {lengths, beam,
// workers}}), or false.
func foldRemaining(history []PerfRecord, progress Obj, now time.Time) (float64, bool) {
	work, _ := progress["work"].(map[string]any)
	raw, _ := work["lengths"].([]any)
	var lengths []int
	for _, v := range raw {
		if n, ok := v.(float64); ok && n > 0 {
			lengths = append(lengths, int(n))
		}
	}
	if len(lengths) == 0 {
		return 0, false
	}
	beam, _ := work["beam"].(float64)
	workers, _ := work["workers"].(float64)
	total := EstimateFold(history, lengths, int(beam), int(workers)).Seconds
	switch stage, _ := progress["stage"].(string); stage {
	case "evidence":
		return total, true
	case "fold":
	default:
		return 0, false
	}
	if len(lengths) > 1 {
		done, _ := progress["bytes_done"].(float64)
		return total * (1 - math.Min(done/float64(len(lengths)), 1)), true
	}
	// One fold reports nothing until it ends: time since it started.
	at, err := time.Parse(time.RFC3339, fmt.Sprint(progress["updated_at"]))
	if err != nil {
		return 0, false
	}
	left := total - foldOverhead - now.Sub(at).Seconds()
	return left, left > 0
}

// cpuScale converts a time measured with from CPUs to one with to CPUs.
func cpuScale(from, to uint32) float64 {
	if from == 0 || to == 0 {
		return 1
	}
	return math.Pow(float64(from)/float64(to), perfCPUExponent)
}

// SampleEstimate is the expected active time of one sample pipeline and
// whether it comes from runs measured on this computer.
func SampleEstimate(history []PerfRecord, format string, inputBytes int64, cpu uint32) (seconds float64, measured bool) {
	var rates []float64
	for i := len(history) - 1; i >= 0 && len(rates) < perfRecent; i-- {
		r := history[i]
		if r.Kind == "sample_pipeline" && r.Format == format && r.InputBytes > 0 && r.Seconds > 0 {
			rates = append(rates, math.Max(r.Seconds-sampleOverhead, 0)/float64(r.InputBytes)*cpuScale(r.CPU, cpu))
		}
	}
	if len(rates) > 0 {
		sort.Float64s(rates)
		return sampleOverhead + rates[len(rates)/2]*float64(inputBytes), true
	}
	perMB, ok := priorSecondsPerMB[format]
	if !ok {
		perMB = priorSecondsPerMB["fastq.gz"]
	}
	return sampleOverhead + perMB*float64(inputBytes)/1e6*cpuScale(priorCPU, cpu), false
}

// PipelineInput is one sample to estimate.
type PipelineInput struct {
	Format     string `json:"format"`
	InputBytes int64  `json:"input_bytes"`
}

// PipelineEstimate is the expected time of a batch of sample pipelines.
type PipelineEstimate struct {
	Seconds float64 `json:"seconds"`
	// Measured is how many of the samples have runs of their format
	// measured on this computer; the rest use the built-in rate.
	Measured int    `json:"measured"`
	Samples  int    `json:"samples"`
	CPU      uint32 `json:"cpu"`
}

// EstimatePipelines adds up the samples' times. With several samples the
// next one's read preparation overlaps the current mapping, which the
// estimate ignores (it errs long).
func EstimatePipelines(history []PerfRecord, inputs []PipelineInput, cpu uint32) PipelineEstimate {
	e := PipelineEstimate{Samples: len(inputs), CPU: cpu}
	for _, in := range inputs {
		seconds, measured := SampleEstimate(history, in.Format, in.InputBytes, cpu)
		e.Seconds += seconds
		if measured {
			e.Measured++
		}
	}
	return e
}

// remainingSeconds is the time left of a running sample pipeline from its
// progress ({stage, detail, bytes_done, bytes_total, work}), or false when
// unknown (waiting for the map slot, unknown stage or input).
func remainingSeconds(history []PerfRecord, progress Obj, cpu uint32) (float64, bool) {
	work, _ := progress["work"].(map[string]any)
	format, _ := work["format"].(string)
	inputBytes, _ := work["input_bytes"].(float64)
	stage, _ := progress["stage"].(string)
	detail, _ := progress["detail"].(string)
	if format == "" || inputBytes <= 0 || len(detail) >= 7 && detail[:7] == "waiting" {
		return 0, false
	}
	if c, ok := work["cpu"].(float64); ok && c >= 1 {
		cpu = uint32(c)
	}
	total, _ := SampleEstimate(history, format, int64(inputBytes), cpu)
	weights, ok := sampleStageWeights[stage]
	if !ok {
		// Past mapping: seconds left.
		return math.Max(total*0.03*0.5, 1), true
	}
	done := weights[0]
	if d, ok := progress["bytes_done"].(float64); ok {
		if t, ok := progress["bytes_total"].(float64); ok && t > 0 {
			done += weights[1] * math.Min(d/t, 1)
		}
	}
	return total * (1 - done), true
}
