//go:build !windows

package core

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"rnaxraydesktop/model"
)

// A project folder may come from someone else: the files and symlinks in it
// must not make the app write outside it.

// TestListDoesNotWriteThroughPlantedSymlinks: opening a project rewrites
// stale running tasks as interrupted; a symlink planted as the temporary
// file, or as the run directory, must not redirect that write.
func TestListDoesNotWriteThroughPlantedSymlinks(t *testing.T) {
	base := t.TempDir()
	outside := filepath.Join(base, "outside")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(outside, "victim")
	project := filepath.Join(base, "p.rnaxrayproj")
	run := filepath.Join(project, "runs", "task-1")
	if err := os.MkdirAll(run, 0o755); err != nil {
		t.Fatal(err)
	}
	stale := []byte(`{"status":"running","started_at":"2026-10-15T10:00:00Z"}`)
	for path, data := range map[string][]byte{
		filepath.Join(project, "project.json"): []byte("{}"),
		filepath.Join(run, "status.json"):      stale,
		filepath.Join(outside, "status.json"):  stale,
	} {
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(victim, filepath.Join(run, "status.json.tmp")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(project, "runs", "task-2")); err != nil {
		t.Fatal(err)
	}
	tasks, err := NewScheduler().List(project)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(victim); err == nil {
		t.Fatal("wrote through the planted status.json.tmp symlink")
	}
	if data, _ := os.ReadFile(filepath.Join(outside, "status.json")); string(data) != string(stale) {
		t.Fatalf("rewrote a status outside the project: %s", data)
	}
	if len(tasks) != 1 || tasks[0]["task_id"] != "task-1" || tasks[0]["status"] != "interrupted" {
		t.Fatalf("tasks %v", tasks)
	}
	// Asked by id (status, resume), the symlinked run is not found either.
	s := NewScheduler()
	if snap, err := s.Status("task-2", project); err == nil {
		t.Fatalf("status through a symlinked run directory: %v", snap)
	}
	if _, err := s.ResumeRequest("task-2", project); err == nil {
		t.Fatal("resume through a symlinked run directory")
	}
	if data, _ := os.ReadFile(filepath.Join(outside, "status.json")); string(data) != string(stale) {
		t.Fatalf("rewrote a status outside the project: %s", data)
	}
}

// TestEvidenceUpdateDoesNotWriteThroughPlantedSymlink: saving a card
// (include in report, review) writes beside it, never through a symlink.
func TestEvidenceUpdateDoesNotWriteThroughPlantedSymlink(t *testing.T) {
	base := t.TempDir()
	victim := filepath.Join(base, "victim.txt")
	if err := os.WriteFile(victim, []byte("PRECIOUS\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(base, "p.rnaxrayproj")
	dir := filepath.Join(project, "evidence")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "project.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	id := "ev-0123456789abcdef0123456789abcdef"
	card := `{"evidence_id":"` + id + `","source_tool":"get_rna_description","status":"success",` +
		`"binding":{"structure_id":"s1","record":"all","result_digest":"sha256:00","include_in_report":true}}`
	if err := os.WriteFile(filepath.Join(dir, id+".json"), []byte(card), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(dir, id+".json.tmp")); err != nil {
		t.Fatal(err)
	}
	e := newEvidenceService(nil, func() bool { return false }, "")
	if _, err := e.Update(project, id, model.EvidenceUpdate{IncludeInReport: false}); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(victim); string(data) != "PRECIOUS\n" {
		t.Fatalf("victim overwritten: %.80s", data)
	}
}

// TestListedCardsKeepVersionOneInvariants: no card of this version has
// verified citations or claims to validate a structure; a card file that
// says so (edited or forged) is read back as not checked, background only.
func TestListedCardsKeepVersionOneInvariants(t *testing.T) {
	project := filepath.Join(t.TempDir(), "p.rnaxrayproj")
	dir := filepath.Join(project, "evidence")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "project.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	id := "ev-0123456789abcdef0123456789abcdef"
	card := `{"evidence_id":"` + id + `","source_tool":"get_rna_description","status":"success",` +
		`"citation_verification":"verified","relation_to_current_structure":"validates_structure"}`
	if err := os.WriteFile(filepath.Join(dir, id+".json"), []byte(card), 0o644); err != nil {
		t.Fatal(err)
	}
	cards, err := newEvidenceService(nil, func() bool { return false }, "").List(project)
	if err != nil || len(cards) != 1 {
		t.Fatalf("%v %v", cards, err)
	}
	if cards[0].CitationVerification != "not_checked" || cards[0].RelationToStructure != "background_only" {
		t.Fatalf("citations %q relation %q", cards[0].CitationVerification, cards[0].RelationToStructure)
	}
}

// TestRuntimeTellsPythonWhichLinksAreTrusted: the app passes its list of
// files linked on this computer to every Python process (sidecars and
// task children), which then refuse other absolute paths (trust.py).
func TestRuntimeTellsPythonWhichLinksAreTrusted(t *testing.T) {
	root := repoRoot(t)
	store := filepath.Join(t.TempDir(), "linked-files.json")
	rt, err := NewRuntimeWith(Bridge{Root: root, Python: testPython(t)}, t.TempDir(), TrustedLinksEnv+"="+store)
	if err != nil {
		t.Fatal(err)
	}
	want := TrustedLinksEnv + "=" + store
	for name, env := range map[string][]string{"control": rt.control.spec.Env, "compute": rt.compute.spec.Env, "tasks": rt.ComputeEnv} {
		if !slices.Contains(env, want) {
			t.Fatalf("%s env lacks %s: %v", name, want, env)
		}
	}
	if !slices.Contains(ProjectOperations, "trust_links") || !slices.Contains(ProjectOperations, "list_untrusted_links") {
		t.Fatal("the trust operations are not allowed")
	}
}
