//go:build e2e

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/views"
)

// TestFolderImportFlow is the user's path through the UI: a new project
// from the start page with the zika_files subsets as its data folder, the
// matched samples imported as proposed, every pipeline run from the Data
// page. Each sample's .hyb must equal the one TestAcceptance made from the
// sample sheet for the same reads.
//
//	RNAXRAY_ACCEPT_DIR=<dir of TestAcceptance> RNAXRAY_ACCEPT_READS=200000 \
//	  CGO_ENABLED=0 go test -tags e2e -run TestFolderImportFlow -timeout 60m -v .
func TestFolderImportFlow(t *testing.T) {
	dir, reads := os.Getenv("RNAXRAY_ACCEPT_DIR"), os.Getenv("RNAXRAY_ACCEPT_READS")
	if dir == "" || reads == "" {
		t.Skip("RNAXRAY_ACCEPT_DIR and RNAXRAY_ACCEPT_READS are not set")
	}
	data := filepath.Join(dir, "reads-"+reads)
	reference := filepath.Join(dir, "zikv-"+reads+".rnaxrayproj")
	want := hybByInput(t, reference)
	if len(want) != 14 {
		t.Fatalf("run TestAcceptance with RNAXRAY_ACCEPT_READS=%s first (%d samples in %s)", reads, len(want), reference)
	}
	root := repoRoot()
	python := filepath.Join(root, "desktop", "resources", "native", "python", "bin", "python3")
	work := t.TempDir()
	rt, err := core.NewRuntime(core.Bridge{Root: root, Python: python}, filepath.Join(work, "cache"))
	if err != nil {
		t.Fatal(err)
	}
	service := core.NewService(rt, core.ServiceOptions{PreferencesPath: filepath.Join(work, "preferences.json")})
	defer service.Shutdown()
	q := &queue{}
	app := views.New(service, q, filepath.Join(work, "userdata"))
	defer app.Stop()
	d := &driver{t: t, q: q, a: app, tt: ui.NewTester(app.View, 1400, 1000)}
	started := time.Now()
	lap := func(what string) { t.Logf("[%6.1fs] %s", time.Since(started).Seconds(), what) }

	// 1. Start page: data folder (names the project), where to save, create.
	parent, _ := filepath.EvalSymlinks(work)
	views.PickFolder = func(title string) string {
		if strings.Contains(title, "raw data") {
			return data
		}
		return parent
	}
	d.click("Choose…")
	d.click("Change…")
	d.until("folder preview", time.Minute, func() bool { return d.has("Creates the folder") })
	d.click("Create project")
	d.until("folder review", time.Minute, func() bool { return d.has("Import 14 samples") })
	d.shot("folder-review")
	lap("project created, folder matched")
	if app.Project.Path != filepath.Join(parent, "reads-"+reads+".rnaxrayproj") {
		t.Fatalf("project at %s", app.Project.Path)
	}

	// 2. Import as proposed.
	d.click("Import 14 samples")
	d.until("samples imported", time.Minute, func() bool { return len(app.Project.Samples) == 14 })
	conditions := map[string]int{}
	for _, s := range app.Project.Samples {
		conditions[s.Condition]++
	}
	if fmt.Sprint(conditions) != "map[Aag:2 Livefire:3 ZAFR:2 ZBRA:2 ZILM:2 ZSIN:3]" {
		t.Fatalf("conditions %v", conditions)
	}
	lap("14 samples imported")

	// 3. Run all pending, with the time estimate shown first.
	d.click("Run all pending (14)")
	d.until("run dialog", 5*time.Minute, func() bool { return d.has("Estimated time") && d.has("Start") })
	estimate := ""
	for _, text := range d.tt.Texts() {
		if strings.HasPrefix(text, "about ") {
			estimate = text
		}
	}
	d.shot("folder-run")
	if d.has("Start anyway") {
		d.click("Start anyway")
	} else {
		d.click("Start")
	}
	runStarted := time.Now()
	d.until("all samples analysed", 60*time.Minute, func() bool {
		for _, task := range app.ActiveTasks() {
			if task.Status == "failed" {
				t.Fatalf("task %s failed: %s", task.TaskID, task.ErrorText())
			}
		}
		if len(app.ActiveTasks()) == 0 {
			app.RefreshProject()
		}
		for _, s := range app.Project.Samples {
			if !s.IsReady() {
				return false
			}
		}
		return true
	})
	lap(fmt.Sprintf("14 pipelines finished in %.0fs (estimated %s)", time.Since(runStarted).Seconds(), estimate))

	// 4. The same .hyb as the sample sheet import, sample by sample.
	got := hybByInput(t, app.Project.Path)
	for input, digest := range want {
		if got[input] != digest {
			t.Errorf("%s: .hyb differs from the sample sheet run (%s vs %s)", input, got[input], digest)
		}
	}
	if len(got) != len(want) {
		t.Errorf("%d samples, want %d", len(got), len(want))
	}
}

// hybByInput maps each sample's reads file name to the SHA-256 of its .hyb.
func hybByInput(t *testing.T, project string) map[string]string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(project, "project.json"))
	if err != nil {
		return nil
	}
	var manifest struct {
		Samples []struct {
			Reads   struct{ Path string }
			Outputs struct{ Hyb *string }
		}
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, s := range manifest.Samples {
		if s.Outputs.Hyb == nil {
			continue
		}
		f, err := os.Open(filepath.Join(project, *s.Outputs.Hyb))
		if err != nil {
			t.Fatal(err)
		}
		h := sha256.New()
		_, err = io.Copy(h, f)
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
		out[filepath.Base(s.Reads.Path)] = hex.EncodeToString(h.Sum(nil))
	}
	return out
}
