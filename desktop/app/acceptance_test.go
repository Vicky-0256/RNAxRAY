//go:build e2e

// P6 acceptance: the full ZIKV dataset through the native app, as
// reproduce_zikv ran it with the legacy pipeline: 14 samples from raw files,
// the six comparisons of reproduce_zikv/README.md and the ZAFR and ZILM
// whole-genome folds. The project lives in $RNAXRAY_ACCEPT_DIR and the test is
// resumable: rerun it after an interruption and it continues.
//
//	RNAXRAY_ACCEPT_DIR=<dir> RNAXRAY_ZIKA_FILES=<zika_files> CGO_ENABLED=0 \
//	  go test -tags e2e -run TestAcceptance -timeout 12h -v .
//
// Quick iteration: RNAXRAY_ACCEPT_READS=200000 takes only the first N reads of
// every file (subsets under <dir>/reads-N, project <dir>/zikv-N.rnaxrayproj)
// and runs the same flow in minutes. Only the full run is comparable with
// reproduce_zikv.
//
// It writes <dir>/acceptance.json (sample counts, comparison and structure
// ids) for reproduce_zikv/../rnaxray/desktop/scripts/compare-acceptance.py.
package main

import (
	"bufio"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
	"rnaxraydesktop/views"
)

type acceptSample struct{ name, condition, rep, file, reference, gene string }

const (
	geneAFR = "ZIKV_African_KX377335-1_virusRNA"
	geneBRA = "ZIKV_Brazilian_MF073357-1_virusRNA"
	geneILM = "ZIKV_FrenchPolynesian_KJ776791-2_virusRNA"
	geneSIN = "ZIKV_Singaporean_KY241713-1_virusRNA"
	genePE  = "ENSG_ENST_ZIKV-PE243-2015_virusRNA"
)

// The samples of reproduce_zikv/run_rnaxray_reproduction.sh (-e 0 is the default).
var acceptSamples = []acceptSample{
	{"ZAFR_REP1", "AFR", "1", "ZAFR_REP1.fastq.gz", "ZAFR.fasta", geneAFR},
	{"ZAFR_REP2", "AFR", "2", "ZAFR_REP2.fastq.gz", "ZAFR.fasta", geneAFR},
	{"ZBRA_REP1", "BRA", "1", "ZBRA_REP1.fastq.gz", "ZBRA.fasta", geneBRA},
	{"ZBRA_REP2", "BRA", "2", "ZBRA_REP2.fastq.gz", "ZBRA.fasta", geneBRA},
	{"ZILM_REP2", "ILM", "2", "ZILM_REP2.fastq.gz", "ZILM.fasta", geneILM},
	{"ZILM_REP3", "ILM", "3", "ZILM_REP3.fastq.gz", "ZILM.fasta", geneILM},
	{"ZSIN_REP1", "SIN", "1", "ZSIN_REP1.fastq.gz", "ZSIN.fasta", geneSIN},
	{"ZSIN_REP2", "SIN", "2", "ZSIN_REP2.fastq.gz", "ZSIN.fasta", geneSIN},
	{"ZSIN_REP3", "SIN", "3", "ZSIN_REP3.fastq.gz", "ZSIN.fasta", geneSIN},
	{"Livefire1", "BRA_human", "1", "Livefire1_comp.fasta.gz", "Zika.fasta", genePE},
	{"Livefire2", "BRA_human", "2", "Livefire2_comp.fasta.gz", "Zika.fasta", genePE},
	{"Livefire3", "BRA_human", "3", "Livefire3_comp.fasta.gz", "Zika.fasta", genePE},
	{"Aag1", "BRA_insect", "1", "Aag-1.assembled.collapse.fasta.gz", "Zika.fasta", genePE},
	{"Aag2", "BRA_insect", "2", "Aag-2.assembled.collapse.fasta.gz", "Zika.fasta", genePE},
}

// The comparisons of reproduce_zikv (condition one vs condition two).
var acceptComparisons = [][2]string{
	{"AFR", "BRA"}, {"AFR", "ILM"}, {"AFR", "SIN"}, {"SIN", "BRA"}, {"ILM", "BRA"}, {"BRA_human", "BRA_insect"},
}

// The whole-genome folds of reproduce_zikv/analysis/cplfold.
var acceptFolds = []struct{ condition, gene string }{{"AFR", geneAFR}, {"ILM", geneILM}}

type acceptResult struct {
	Project     string            `json:"project"`
	Samples     map[string]string `json:"samples"`     // name -> sample id
	Comparisons map[string]string `json:"comparisons"` // "A vs B" -> comparison id
	Structures  map[string]string `json:"structures"`  // condition -> structure id
	Timings     map[string]string `json:"timings"`
}

func TestAcceptance(t *testing.T) {
	dir, data := os.Getenv("RNAXRAY_ACCEPT_DIR"), os.Getenv("RNAXRAY_ZIKA_FILES")
	if dir == "" || data == "" {
		t.Skip("RNAXRAY_ACCEPT_DIR and RNAXRAY_ZIKA_FILES are not set")
	}
	root := repoRoot()
	python := filepath.Join(root, "desktop", "resources", "native", "python", "bin", "python3")
	rt, err := core.NewRuntime(core.Bridge{Root: root, Python: python}, filepath.Join(dir, "cache"))
	if err != nil {
		t.Fatal(err)
	}
	service := core.NewService(rt, core.ServiceOptions{PreferencesPath: filepath.Join(dir, "preferences.json")})
	defer service.Shutdown()
	q := &queue{}
	app := views.New(service, q, filepath.Join(dir, "userdata"))
	defer app.Stop()
	d := &driver{t: t, q: q, a: app, tt: ui.NewTester(app.View, 1400, 1000)}
	result := acceptResult{Samples: map[string]string{}, Comparisons: map[string]string{}, Structures: map[string]string{}, Timings: map[string]string{}}
	started := time.Now()
	// Only tasks of this run count; a resumed run finds older interrupted ones.
	since := started.UTC().Add(-time.Second).Format(time.RFC3339)
	mine := func(task model.Task) bool { return task.StartedAt >= since }
	lap := func(what string) {
		result.Timings[what] = fmt.Sprintf("%.0fs", time.Since(started).Seconds())
		t.Logf("[%7.0fs] %s", time.Since(started).Seconds(), what)
	}
	project := filepath.Join(dir, "zikv.rnaxrayproj")
	resultName := "acceptance.json"
	if n, _ := strconv.Atoi(os.Getenv("RNAXRAY_ACCEPT_READS")); n > 0 {
		subsets := filepath.Join(dir, fmt.Sprintf("reads-%d", n))
		for _, s := range acceptSamples {
			if err := subsetReads(filepath.Join(data, s.file), subsets, n); err != nil {
				t.Fatal(err)
			}
		}
		// references are small: link them next to the subsets
		for _, ref := range []string{"ZAFR.fasta", "ZBRA.fasta", "ZILM.fasta", "ZSIN.fasta", "Zika.fasta"} {
			target := filepath.Join(subsets, ref)
			if _, err := os.Stat(target); err != nil {
				if err := os.Symlink(filepath.Join(data, ref), target); err != nil {
					t.Fatal(err)
				}
			}
		}
		data = subsets
		project = filepath.Join(dir, fmt.Sprintf("zikv-%d.rnaxrayproj", n))
		resultName = fmt.Sprintf("acceptance-%d.json", n)
		lap(fmt.Sprintf("subsets of %d reads", n))
	}
	result.Project = project

	// 1. Project and sample sheet (skipped when resuming).
	if _, err := os.Stat(filepath.Join(project, "project.json")); err != nil {
		var sheet strings.Builder
		sheet.WriteString("name\tcondition\treplicate\tfiles\treference\tgene_id\n")
		for _, s := range acceptSamples {
			file := filepath.Join(data, s.file)
			if _, err := os.Stat(file); err != nil {
				file = filepath.Join(data, strings.TrimSuffix(s.file, ".gz"))
			}
			fmt.Fprintf(&sheet, "%s\t%s\t%s\t%s\t%s\t%s\n", s.name, s.condition, s.rep,
				file, filepath.Join(data, s.reference), s.gene)
		}
		sheetPath := filepath.Join(dir, strings.TrimSuffix(resultName, ".json")+"-samples.tsv")
		if err := os.WriteFile(sheetPath, []byte(sheet.String()), 0o644); err != nil {
			t.Fatal(err)
		}
		views.PickFiles = func(string, bool) []string { return []string{sheetPath} }
		d.newProject(filepath.Dir(project), strings.TrimSuffix(filepath.Base(project), views.ProjectSuffix))
		d.until("project opens", time.Minute, func() bool { return app.Project != nil })
		d.click("Import sample sheet…")
		d.until("sheet preview", time.Minute, func() bool { return d.has("Nothing has been imported yet") })
		d.click("Import 14 samples")
		d.until("samples imported", time.Minute, func() bool { return len(app.Project.Samples) == 14 })
		lap("project and 14 samples")
	} else {
		app.Open(project)
		d.until("project opens", time.Minute, func() bool { return app.Project != nil && len(app.Project.Samples) == 14 })
		app.RefreshTasks()
		d.until("tasks listed", time.Minute, func() bool { return true })
		lap("project reopened")
	}
	for _, s := range app.Project.Samples {
		result.Samples[s.Name] = s.ID
	}

	// 2. Pipelines from the Data page.
	allReady := func() bool {
		for _, s := range app.Project.Samples {
			if !s.IsReady() {
				return false
			}
		}
		return true
	}
	d.frame()
	if !allReady() && len(app.ActiveTasks()) == 0 {
		app.Navigate("data", nil)
		d.until("pending button", time.Minute, func() bool { return d.has("Run all pending (") })
		for _, text := range d.tt.Texts() {
			if strings.HasPrefix(text, "Run all pending (") && text != "Run all pending (0)" {
				d.click(text)
				break
			}
		}
		d.until("disk estimate", 5*time.Minute, func() bool { return d.has("Start") })
		d.shot("accept-disk-estimate")
		if d.has("Start anyway") {
			d.click("Start anyway")
		} else {
			d.click("Start")
		}
	}
	d.until("all samples analysed", 10*time.Hour, func() bool {
		for _, task := range app.Tasks {
			if mine(task) && task.Kind == "sample_pipeline" && (task.Status == "failed" || task.Status == "interrupted") {
				t.Fatalf("pipeline %s %s: %s", task.TaskID, task.Status, task.ErrorText())
			}
		}
		if len(app.ActiveTasks()) == 0 {
			app.RefreshProject()
		}
		return allReady()
	})
	d.shot("accept-data")
	lap("all 14 samples analysed")

	// 3. Comparisons (start the missing ones, then wait for all).
	listed := func() []map[string]any {
		got, err := service.ProjectOp(project, "list_comparisons", nil)
		if err != nil {
			t.Fatal(err)
		}
		var out []map[string]any
		_ = model.Decode(got["comparisons"], &out)
		return out
	}
	ids := func(condition string) []string { return app.SelectionIDs("c:" + condition) }
	findComparison := func(one, two string) string {
		for _, entry := range listed() {
			if fmt.Sprint(entry["label_one"]) == one && fmt.Sprint(entry["label_two"]) == two {
				return fmt.Sprint(entry["id"])
			}
		}
		return ""
	}
	for _, pair := range acceptComparisons {
		if findComparison(pair[0], pair[1]) != "" || hasActive(app, "compare", pair[0]+" vs "+pair[1]) {
			continue
		}
		app.StartTask(core.TaskStartRequest{Kind: "compare", SamplesOne: ids(pair[0]), SamplesTwo: ids(pair[1]),
			Parameters: map[string]any{"min_count": 2, "range": 100, "padj_cutoff": 0.05, "label_one": pair[0], "label_two": pair[1]}},
			"Differential test · "+pair[0]+" vs "+pair[1], func(_ model.Task, err error) {
				if err != nil {
					t.Fatalf("start compare %v: %v", pair, err)
				}
			})
		d.frame()
	}
	// 4. Whole-genome folds (pseudoknot-free, alpha 0.5, beam 100).
	findStructure := func(condition string) string {
		got, err := service.ProjectOp(project, "list_structures", nil)
		if err != nil {
			t.Fatal(err)
		}
		var entries []map[string]any
		_ = model.Decode(got["structures"], &entries)
		want := strings.Join(ids(condition), ",")
		for _, e := range entries {
			var samples []string
			_ = model.Decode(e["sample_ids"], &samples)
			if e["mode"] == "genome" && strings.Join(samples, ",") == want {
				return fmt.Sprint(e["id"])
			}
		}
		return ""
	}
	for _, fold := range acceptFolds {
		if findStructure(fold.condition) != "" || hasActive(app, "structure", fold.condition) {
			continue
		}
		gene, mode := fold.gene, "genome"
		req := core.TaskStartRequest{Kind: "structure", SampleIDs: ids(fold.condition), GeneID: &gene, Mode: &mode,
			Parameters: map[string]any{"alpha": 0.5, "beam": 100, "allow_pseudoknot": false}}
		mem := views.StructureMemClaim(req, app.Project.GeneLength(gene), false)
		req.MemMB = &mem
		app.StartTask(req,
			"Structure · "+fold.condition+" · whole RNA", func(_ model.Task, err error) {
				if err != nil {
					t.Fatalf("start fold %v: %v", fold, err)
				}
			})
		d.frame()
	}
	d.until("comparisons and folds", 4*time.Hour, func() bool {
		for _, task := range app.Tasks {
			if mine(task) && (task.Kind == "compare" || task.Kind == "structure") && (task.Status == "failed" || task.Status == "interrupted") {
				t.Fatalf("%s %s %s: %s", task.Kind, task.TaskID, task.Status, task.ErrorText())
			}
		}
		if len(app.ActiveTasks()) > 0 {
			return false
		}
		for _, pair := range acceptComparisons {
			if findComparison(pair[0], pair[1]) == "" {
				return false
			}
		}
		for _, fold := range acceptFolds {
			if findStructure(fold.condition) == "" {
				return false
			}
		}
		return true
	})
	for _, pair := range acceptComparisons {
		result.Comparisons[pair[0]+" vs "+pair[1]] = findComparison(pair[0], pair[1])
	}
	for _, fold := range acceptFolds {
		result.Structures[fold.condition] = findStructure(fold.condition)
	}
	lap("6 comparisons and 2 genome folds")

	// 5. The pages show them.
	app.Navigate("compare", map[string]any{"comparisonId": result.Comparisons["AFR vs BRA"]})
	d.until("compare page", 2*time.Minute, func() bool { return d.has("Significant cells") })
	d.shot("accept-compare")
	app.Navigate("structure", map[string]any{"structureId": result.Structures["AFR"]})
	d.until("structure page", 2*time.Minute, func() bool { return d.has("Base pairs") })
	d.shot("accept-structure")
	app.Navigate("report", nil)
	d.until("report page", 5*time.Minute, func() bool { return d.has("Differential tests") })
	d.shot("accept-report")
	lap("pages")

	raw, _ := json.MarshalIndent(result, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, resultName), raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

// hasActive reports a queued or running task of kind whose label mentions what.
func hasActive(app *views.App, kind, what string) bool {
	for _, task := range app.ActiveTasks() {
		if task.Kind == kind && strings.Contains(app.TaskLabel(task), what) {
			return true
		}
	}
	return false
}

// subsetReads writes the first n reads of a FASTQ or FASTA file (gzipped or
// not) to dir/<name without .gz>, once.
func subsetReads(path, dir string, n int) error {
	target := filepath.Join(dir, strings.TrimSuffix(filepath.Base(path), ".gz"))
	if _, err := os.Stat(target); err == nil {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	in, err := os.Open(path)
	if err != nil {
		return err
	}
	defer in.Close()
	var reader io.Reader = in
	if strings.HasSuffix(path, ".gz") {
		gz, err := gzip.NewReader(in)
		if err != nil {
			return err
		}
		defer gz.Close()
		reader = gz
	}
	lines := 2 // FASTA records are two lines (collapsed files)
	if strings.Contains(path, ".fastq") || strings.Contains(path, ".fq") {
		lines = 4
	}
	tmp := target + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 1<<20), 1<<24)
	writer := bufio.NewWriter(out)
	for i := 0; i < n*lines && scanner.Scan(); i++ {
		writer.Write(scanner.Bytes())
		writer.WriteByte('\n')
	}
	if err := scanner.Err(); err != nil {
		out.Close()
		return err
	}
	if err := writer.Flush(); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, target)
}
