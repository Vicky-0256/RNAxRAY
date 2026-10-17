package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestIDsAreUniqueAndSafe(t *testing.T) {
	if NewTaskID() == NewTaskID() {
		t.Fatal("task ids repeat")
	}
	if err := ValidateID(NewTaskID()); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"../escape", "/tmp/a", "", "a/b", "1abc", strings.Repeat("a", 65)} {
		if ValidateID(id) == nil {
			t.Fatalf("accepted %q", id)
		}
	}
}

func TestISOTimestamps(t *testing.T) {
	if got := iso(time.Unix(0, 0)); got != "1970-01-01T00:00:00.000Z" {
		t.Fatal(got)
	}
	if got := iso(time.UnixMilli(1_709_210_096_789)); got != "2024-02-29T12:34:56.789Z" {
		t.Fatal(got)
	}
}

func TestUnsupportedKindIsRejected(t *testing.T) {
	run := "/p/runs/a"
	request := TaskStartRequest{ProjectPath: "/p", Kind: "sh"}
	if _, err := TaskPayload(request, "/p", "a", run, big()); err == nil {
		t.Fatal("sh accepted")
	}
	pipeline := request
	pipeline.Kind = "pipeline"
	pipeline.Input = ptr("inputs/a.sam")
	pipeline.Reference = ptr("inputs/r.fasta")
	payload, err := TaskPayload(pipeline, "/p", "a", run, big())
	if err != nil || payload["operation"] != "pipeline_run" || payload["input"] != "inputs/a.sam" {
		t.Fatalf("%v %v", payload, err)
	}
	missing := pipeline
	missing.Reference = nil
	if _, err := TaskPayload(missing, "/p", "a", run, big()); err == nil {
		t.Fatal("missing reference accepted")
	}
}

func TestSampleKindsMapToBridgeOperations(t *testing.T) {
	run := "/p/runs/a"
	for kind, operation := range map[string]string{
		"sample_pipeline": "sample_pipeline_run",
		"analysis_index":  "analysis_index_build",
	} {
		request := TaskStartRequest{ProjectPath: "/p", Kind: kind}
		if _, err := TaskPayload(request, "/p", "a", run, big()); err == nil {
			t.Fatalf("%s without sample accepted", kind)
		}
		for _, bad := range []string{"", "  ", "../x", "1abc", "a/b", strings.Repeat("a", 65)} {
			request.SampleID = ptr(bad)
			if _, err := TaskPayload(request, "/p", "a", run, big()); err == nil {
				t.Fatalf("%s accepted %q", kind, bad)
			}
		}
		request.SampleID = ptr("ZAFR_REP1")
		payload, err := TaskPayload(request, "/p", "a", run, big())
		if err != nil {
			t.Fatal(err)
		}
		assertJSON(t, payload, `{"operation":"`+operation+`","project_path":"/p","sample_id":"ZAFR_REP1","task_id":"a","run_dir":"/p/runs/a"}`)
	}
}

func TestCompareRequestsAreValidated(t *testing.T) {
	run := "/p/runs/a"
	good := TaskStartRequest{
		ProjectPath: "/p", Kind: "compare",
		SamplesOne: []string{"ZAFR_REP1", "ZAFR_REP2"},
		SamplesTwo: []string{"ZBRA_REP1", "ZBRA_REP2"},
		Parameters: map[string]any{"min_count": 2},
	}
	if claim, err := ClaimFor(good, big()); err != nil || claim != (Budget{big().CPU, 3072}) {
		t.Fatalf("claim %v %v", claim, err)
	}
	if idPrefix("compare") != "compare-" {
		t.Fatal("prefix")
	}
	payload, err := TaskPayload(good, "/p", "a", run, big())
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, payload, `{"operation":"compare_run","project_path":"/p","samples_one":["ZAFR_REP1","ZAFR_REP2"],
		"samples_two":["ZBRA_REP1","ZBRA_REP2"],"parameters":{"min_count":2},"task_id":"a","run_dir":"/p/runs/a"}`)
	edits := []func(*TaskStartRequest){
		func(r *TaskStartRequest) { r.SamplesOne = nil },
		func(r *TaskStartRequest) { r.SamplesTwo = []string{} },
		func(r *TaskStartRequest) { r.SamplesOne = []string{"ZAFR_REP1"}; r.SamplesTwo = []string{"ZBRA_REP1"} },
		func(r *TaskStartRequest) { r.SamplesTwo = []string{"ZAFR_REP1", "ZBRA_REP1"} },
		func(r *TaskStartRequest) { r.SamplesOne = []string{"../x", "ZAFR_REP2"} },
		func(r *TaskStartRequest) { r.Parameters = []any{1} },
	}
	for i, edit := range edits {
		request := good
		edit(&request)
		if _, err := TaskPayload(request, "/p", "a", run, big()); err == nil {
			t.Fatalf("bad request %d accepted", i)
		}
	}
}

func TestStructureRequestsAreValidated(t *testing.T) {
	run := "/p/runs/a"
	good := TaskStartRequest{
		ProjectPath: "/p", Kind: "structure",
		SampleIDs:  []string{"ZAFR_REP1", "ZAFR_REP2"},
		GeneID:     ptr("ZIKV_African"),
		Mode:       ptr("windows"),
		Windows:    []Window{{Start: 100, End: 400}},
		Parameters: map[string]any{"pseudoknots": true},
		Workers:    ptr(uint32(2)),
	}
	claim, err := ClaimFor(good, big())
	if err != nil || claim != (Budget{2, 4096}) {
		t.Fatalf("claim %v %v", claim, err)
	}
	payload, err := TaskPayload(good, "/p", "a", run, claim)
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, payload, `{"operation":"structure_run","project_path":"/p","sample_ids":["ZAFR_REP1","ZAFR_REP2"],
		"gene_id":"ZIKV_African","mode":"windows","windows":[{"start":100,"end":400}],
		"parameters":{"pseudoknots":true},"workers":2,"task_id":"a","run_dir":"/p/runs/a"}`)
	genome := good
	genome.Mode, genome.Windows, genome.Workers, genome.Parameters = ptr("genome"), nil, nil, nil
	claim, err = ClaimFor(genome, big())
	if err != nil || claim.CPU != 4 {
		t.Fatalf("genome claim %v %v", claim, err)
	}
	payload, err = TaskPayload(genome, "/p", "a", run, claim)
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, payload["windows"], `[]`)
	assertJSON(t, payload["workers"], `4`)
	assertJSON(t, payload["parameters"], `{}`)
	edits := []func(*TaskStartRequest){
		func(r *TaskStartRequest) { r.SampleIDs = nil },
		func(r *TaskStartRequest) { r.SampleIDs = []string{} },
		func(r *TaskStartRequest) { r.SampleIDs = []string{"../x"} },
		func(r *TaskStartRequest) { r.SampleIDs = []string{"a", "a"} },
		func(r *TaskStartRequest) { r.GeneID = nil },
		func(r *TaskStartRequest) { r.GeneID = ptr("a\nb") },
		func(r *TaskStartRequest) { r.Mode = nil },
		func(r *TaskStartRequest) { r.Mode = ptr("both") },
		func(r *TaskStartRequest) { r.Windows = nil },
		func(r *TaskStartRequest) { r.Windows = []Window{{Start: 5, End: 5}} },
		func(r *TaskStartRequest) { r.Mode = ptr("genome") },
		func(r *TaskStartRequest) { r.Workers = ptr(uint32(0)) },
		func(r *TaskStartRequest) { r.Parameters = []any{1} },
	}
	for i, edit := range edits {
		request := good
		edit(&request)
		if _, err := TaskPayload(request, "/p", "a", run, big()); err == nil {
			t.Fatalf("bad request %d accepted", i)
		}
	}
	// Unknown window fields are rejected at deserialization.
	if _, err := DecodeTaskStartRequest([]byte(`{"project_path":"/p","kind":"structure","windows":[{"start":1,"end":2,"x":3}]}`)); err == nil {
		t.Fatal("unknown window field accepted")
	}
	if r, err := DecodeTaskStartRequest([]byte(`{"project_path":"/p","kind":"structure","windows":[{"start":1,"end":2}]}`)); err != nil || r.Windows[0] != (Window{1, 2}) {
		t.Fatalf("%v %v", r, err)
	}
}

func TestClaimsHaveKindDefaultsAndBoundedOverrides(t *testing.T) {
	budget := big()
	claim := func(r TaskStartRequest) Budget {
		t.Helper()
		c, err := ClaimFor(r, budget)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	for kind, want := range map[string]Budget{
		"sample_pipeline":  {4, 4096},
		"structure":        {4, 4096},
		"cplfold":          {1, 2048},
		"validate_project": {1, 256},
		"analysis_index":   {1, 1024},
		"energy":           {1, 1024},
	} {
		if got := claim(TaskStartRequest{Kind: kind}); got != want {
			t.Fatalf("%s: %v", kind, got)
		}
	}
	structure := TaskStartRequest{Kind: "structure", Workers: ptr(uint32(64)), MemMB: ptr(uint64(6000))}
	if got := claim(structure); got != (Budget{4, 6000}) {
		t.Fatalf("structure %v", got)
	}
	overridden := TaskStartRequest{Kind: "sample_pipeline", CPU: ptr(uint32(2)), MemMB: ptr(uint64(100))}
	if got := claim(overridden); got != (Budget{2, 100}) {
		t.Fatalf("overridden %v", got)
	}
	for _, bad := range []TaskStartRequest{
		{Kind: "cplfold", CPU: ptr(uint32(0))},
		{Kind: "cplfold", CPU: ptr(uint32(5))},
		{Kind: "cplfold", MemMB: ptr(uint64(0))},
		{Kind: "cplfold", MemMB: ptr(uint64(8001))},
	} {
		if _, err := ClaimFor(bad, budget); err == nil {
			t.Fatalf("accepted %+v", bad)
		}
	}
	// Defaults never exceed a small budget.
	if got, _ := ClaimFor(TaskStartRequest{Kind: "sample_pipeline"}, Budget{1, 512}); got != (Budget{1, 512}) {
		t.Fatalf("small %v", got)
	}
}

func TestAdmissionIsFIFOWithHeadBlocking(t *testing.T) {
	budget := big()
	idle := Budget{}
	ids := func(v []admitted) []string {
		out := []string{}
		for _, a := range v {
			out = append(out, a.id)
		}
		return out
	}
	// Submission order is seq, not slice order.
	queue := []queuedTask{{2, "c", Budget{1, 100}, ""}, {0, "a", Budget{3, 100}, ""}, {1, "b", Budget{3, 100}, ""}}
	// `b` does not fit after `a`; the small `c` must not overtake it.
	if got := ids(admit(queue, idle, budget)); !slices.Equal(got, []string{"a"}) {
		t.Fatal(got)
	}
	if got := admit(queue, Budget{2, 0}, budget); len(got) != 0 {
		t.Fatal(got)
	}
	if got := ids(admit(queue, Budget{1, 0}, budget)); !slices.Equal(got, []string{"a"}) {
		t.Fatal(got)
	}
	// Memory blocks as well as cpu.
	queue = []queuedTask{{0, "m", Budget{1, 5000}, ""}, {1, "n", Budget{1, 10}, ""}}
	if got := admit(queue, Budget{0, 4000}, budget); len(got) != 0 {
		t.Fatal(got)
	}
	if got := ids(admit(queue, idle, budget)); !slices.Equal(got, []string{"m", "n"}) {
		t.Fatal(got)
	}
	// An oversized claim is clamped and runs alone instead of deadlocking.
	queue = []queuedTask{{0, "huge", Budget{64, 1 << 20}, ""}}
	if got := admit(queue, idle, budget); len(got) != 1 || got[0] != (admitted{"huge", budget}) {
		t.Fatal(got)
	}
	if got := admit(queue, Budget{1, 0}, budget); len(got) != 0 {
		t.Fatal(got)
	}
}

func TestEarlyStartOfTheNextSample(t *testing.T) {
	budget := Budget{10, 16000}
	full := Budget{10, 4096}
	next := []queuedTask{{1, "s2", full, "sample_pipeline"}, {2, "s3", full, "sample_pipeline"}}
	// One sample runs: the next one starts early (only the head).
	if got := earlyStart(next, []string{"sample_pipeline"}, full, budget); got == nil || *got != (admitted{"s2", full}) {
		t.Fatal(got)
	}
	// Two already run, or something else runs, or nothing runs (then the
	// normal admission starts it): no early start.
	for _, running := range [][]string{{"sample_pipeline", "sample_pipeline"}, {"structure"}, {"sample_pipeline", "compare"}, nil} {
		if got := earlyStart(next, running, full, budget); got != nil {
			t.Fatalf("%v: %v", running, got)
		}
	}
	// The head must be a sample pipeline (FIFO is kept) and fit in memory.
	if got := earlyStart([]queuedTask{{0, "f", full, "structure"}, {1, "s", full, "sample_pipeline"}}, []string{"sample_pipeline"}, full, budget); got != nil {
		t.Fatal(got)
	}
	if got := earlyStart(next, []string{"sample_pipeline"}, Budget{10, 14000}, budget); got != nil {
		t.Fatal(got)
	}
}

func TestProgressIsPassedThrough(t *testing.T) {
	s := testScheduler(t, 0, 0)
	project := tempProject(t)
	dir := filepath.Join(project, "runs", "with-progress")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, text string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("status.json", `{"task_id":"with-progress","kind":"sample_pipeline","status":"succeeded","started_at":"2024-01-01T00:00:00.000Z"}`)
	progress := `{"stage":"bowtie2","detail":"mapping","bytes_done":10,"bytes_total":100,"updated_at":"2024-01-01T00:00:01.000Z"}`
	write("progress.json", progress)
	snap, err := s.Status("with-progress", project)
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, snap["progress"], progress)
	if snap["claim"] != nil || snap["resumed_from"] != nil {
		t.Fatalf("missing keys are not null: %v", snap)
	}
	listed, err := s.List(project)
	if err != nil || len(listed) != 1 {
		t.Fatalf("%v %v", listed, err)
	}
	assertJSON(t, listed[0]["progress"], progress)
	// Partial writes or non-objects are reported as no progress.
	write("progress.json", `{"stage":`)
	if snap, _ := s.Status("with-progress", project); snap["progress"] != nil {
		t.Fatal("partial progress passed through")
	}
	write("progress.json", `[1]`)
	if snap, _ := s.Status("with-progress", project); snap["progress"] != nil {
		t.Fatal("non-object progress passed through")
	}
	if err := os.Remove(filepath.Join(dir, "progress.json")); err != nil {
		t.Fatal(err)
	}
	if snap, _ := s.Status("with-progress", project); snap["progress"] != nil {
		t.Fatal("missing progress is not null")
	}
	// The persisted record never contains progress.
	if _, ok := readJSON(t, filepath.Join(dir, "status.json"))["progress"]; ok {
		t.Fatal("progress persisted")
	}
}

func TestPrepareRejectsInvalidRequestsWithoutARunDir(t *testing.T) {
	s := testScheduler(t, 0, 0)
	project := tempProject(t)
	for _, request := range []TaskStartRequest{
		{Kind: "sh"},
		{Kind: "sample_pipeline"},
		{Kind: "cplfold", Sequence: ptr("ACGU"), CPU: ptr(^uint32(0))},
	} {
		if _, err := s.Prepare(request, project, nil); err == nil {
			t.Fatalf("accepted %+v", request)
		}
	}
	if entries, err := os.ReadDir(filepath.Join(project, "runs")); err == nil && len(entries) != 0 {
		t.Fatal("a run directory was reserved")
	}
}

func TestChildCommandPassesResultFile(t *testing.T) {
	request := filepath.Join("/p", "runs", "t", "task-request.json")
	cmd := BridgeCommand("py", "/r", request, []string{"X=1"})
	want := []string{"-m", "desktop.runtime.bridge", "--repo-root", "/r", "--request", request,
		"--result-file", filepath.Join("/p", "runs", "t", "result.json")}
	if !slices.Equal(cmd.Args[1:], want) || cmd.Dir != "/r" {
		t.Fatalf("args %v dir %s", cmd.Args, cmd.Dir)
	}
	if cmd.Env[len(cmd.Env)-1] != "X=1" {
		t.Fatal("env not passed")
	}
}

func TestListMarksStaleRunningAsInterrupted(t *testing.T) {
	s := testScheduler(t, 0, 0)
	project := tempProject(t)
	runs := filepath.Join(project, "runs")
	for _, item := range [][3]string{
		{"old-done", "succeeded", "2024-01-01T00:00:00.000Z"},
		{"stale-run", "running", "2024-06-01T00:00:00.000Z"},
		{"stale-queue", "queued", "2024-03-01T00:00:00.000Z"},
	} {
		dir := filepath.Join(runs, item[0])
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		data, _ := json.Marshal(Obj{"task_id": item[0], "kind": "cplfold", "status": item[1], "started_at": item[2]})
		if err := os.WriteFile(filepath.Join(dir, "status.json"), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(runs, "analysis-without-status"), 0o755); err != nil {
		t.Fatal(err)
	}
	tasks, err := s.List(project)
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 3 || tasks[0]["task_id"] != "stale-run" || tasks[0]["status"] != "interrupted" ||
		tasks[1]["status"] != "interrupted" || tasks[2]["status"] != "succeeded" {
		t.Fatalf("listed %v", tasks)
	}
	if readJSON(t, filepath.Join(runs, "stale-run", "status.json"))["status"] != "interrupted" {
		t.Fatal("interrupted status not saved")
	}
	if snap, err := s.Status("stale-run", project); err != nil || snap["status"] != "interrupted" {
		t.Fatalf("%v %v", snap, err)
	}
	if _, err := s.Status("missing", project); err == nil {
		t.Fatal("missing task found")
	}
	if _, err := s.List(t.TempDir()); err == nil {
		t.Fatal("listed a directory without project.json")
	}
}

func TestEnergyRequestsAreValidated(t *testing.T) {
	run := "/p/runs/a"
	good := TaskStartRequest{ProjectPath: "/p", Kind: "energy", ComparisonID: ptr("compare-1"),
		Parameters: map[string]any{"length": 40, "padj": 0.01}}
	if idPrefix("energy") != "energy-" {
		t.Fatal("prefix")
	}
	payload, err := TaskPayload(good, "/p", "a", run, big())
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, payload, `{"operation":"energy_run","project_path":"/p","comparison_id":"compare-1",
		"parameters":{"length":40,"padj":0.01},"task_id":"a","run_dir":"/p/runs/a"}`)
	for i, edit := range []func(*TaskStartRequest){
		func(r *TaskStartRequest) { r.ComparisonID = nil },
		func(r *TaskStartRequest) { r.ComparisonID = ptr("../x") },
		func(r *TaskStartRequest) { r.Parameters = "40" },
	} {
		request := good
		edit(&request)
		if _, err := TaskPayload(request, "/p", "a", run, big()); err == nil {
			t.Fatalf("bad request %d accepted", i)
		}
	}
}
