//go:build e2e

package main

import (
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/views"
)

// TestComparePanelsLive drives the Compare page's enriched regions and
// folding energy against the real core and bridge, on a project holding a
// two-lineage differential test with both lineages' whole-RNA folds (e.g.
// ZIKV AFR vs ILM: ZAFR and ZILM samples, their genome folds).
//
//	RNAXRAY_PANELS_PROJECT=<project> RNAXRAY_PANELS_TEST=<comparison id> RNAXRAY_PANELS_EXPECT='text|text' \
//	  CGO_ENABLED=0 go test -tags e2e -run TestComparePanelsLive -v .
//
// The test's energies (energy_L40.*) are computed again by an energy task.
func TestComparePanelsLive(t *testing.T) {
	project, comparison := os.Getenv("RNAXRAY_PANELS_PROJECT"), os.Getenv("RNAXRAY_PANELS_TEST")
	if project == "" || comparison == "" {
		t.Skip("RNAXRAY_PANELS_PROJECT / RNAXRAY_PANELS_TEST are not set")
	}
	root := repoRoot()
	python := filepath.Join(root, "desktop", "resources", "native", "python", "bin", "python3")
	if _, err := os.Stat(python); err != nil {
		t.Skip("staged runtime not available")
	}
	rt, err := core.NewRuntime(core.Bridge{Root: root, Python: python}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := core.NewService(rt, core.ServiceOptions{PreferencesPath: filepath.Join(t.TempDir(), "preferences.json")})
	t.Cleanup(service.Shutdown)
	for _, name := range []string{"energy_L40.tsv", "energy_L40.json"} {
		_ = os.Remove(filepath.Join(project, "comparisons", comparison, name))
	}

	app := views.New(service, nil, t.TempDir())
	tt := ui.NewTester(app.View, 1100, 3600)
	app.Open(project)
	waitFor(t, app, tt, func() bool { return app.Project != nil })
	app.Navigate("compare", map[string]any{"comparisonId": comparison})
	waitFor(t, app, tt, func() bool { return tt.HasText("Show regions") && tt.HasText("Not computed for this test yet.") })
	if err := tt.Click("Show regions"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, app, tt, func() bool { return tt.HasText("Region A · higher in AFR") && tt.HasText("Region B · higher in ILM") })

	if err := tt.Click("Compute"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Minute)
	for !tt.HasText("Compute again") {
		if time.Now().After(deadline) {
			t.Fatalf("energies not shown: %q", tt.Texts())
		}
		app.RefreshTasks()
		time.Sleep(200 * time.Millisecond)
		app.Flush()
		tt.Frame()
		for _, task := range app.Tasks {
			if task.Kind == "energy" && task.Status == "failed" {
				t.Fatalf("energy task failed: %s", task.ErrorText())
			}
		}
	}
	for i := 0; i < 5; i++ {
		app.Flush()
		tt.Frame()
		time.Sleep(50 * time.Millisecond)
	}
	var missing []string
	for _, want := range strings.Split(os.Getenv("RNAXRAY_PANELS_EXPECT"), "|") {
		if want != "" && !tt.HasText(want) {
			missing = append(missing, want)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("lacks %q in %q", missing, tt.Texts())
	}
	for _, text := range tt.Texts() {
		if strings.Contains(text, "between windows") || strings.Contains(text, "paired outside") || strings.Contains(text, "#") ||
			strings.Contains(text, "mean dG") || strings.Contains(text, "interactions with padj") || strings.Contains(text, "Windows ") {
			t.Log(text)
		}
	}
	if dir := os.Getenv("RNAXRAY_SNAPSHOT_DIR"); dir != "" {
		for _, dark := range []bool{false, true} {
			tt.SetDark(dark)
			tt.Frame()
			name := "live-compare-panels"
			if dark {
				name += "-dark"
			}
			f, err := os.Create(filepath.Join(dir, name+".png"))
			if err != nil {
				t.Fatal(err)
			}
			if err := png.Encode(f, tt.Image()); err != nil {
				t.Fatal(err)
			}
			f.Close()
		}
	}
}
