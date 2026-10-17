package core

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"rnaxraydesktop/model"
)

type evidenceFixture struct {
	s       *Service
	prefs   string
	cache   string
	project string
}

// evidenceService is a Service whose evidence worker is the fake in
// testdata/fake_evidence_worker.py, with the real spec (environment
// allowlist, process group) and a short timeout.
func evidenceService(t *testing.T, timeout time.Duration, enabled bool) *evidenceFixture {
	t.Helper()
	dir := t.TempDir()
	prefs := filepath.Join(dir, "config", PrefsFileName)
	cache := filepath.Join(dir, "cache", "evidence")
	logs := filepath.Join(dir, "logs")
	for _, d := range []string{cache, logs} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	script, err := filepath.Abs(filepath.Join("testdata", "fake_evidence_worker.py"))
	if err != nil {
		t.Fatal(err)
	}
	python := testPython(t)
	s := NewService(nil, ServiceOptions{PreferencesPath: prefs, EvidenceCacheDir: cache, EvidenceLogDir: logs})
	s.evidence.spec = func() (SidecarSpec, error) {
		spec := EvidenceSpec(Bridge{Root: dir, Python: python}, cache, logs)
		spec.Args = []string{"-B", script, "--serve"}
		spec.Timeout = timeout
		return spec, nil
	}
	t.Cleanup(s.Shutdown)
	if enabled {
		if _, err := s.SetPreferences(Obj{"external_lookup": true}); err != nil {
			t.Fatal(err)
		}
	}
	project := tempProject(t)
	if err := os.WriteFile(filepath.Join(project, "project.json"), []byte(`{"project_id":"proj-123"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	return &evidenceFixture{s: s, prefs: prefs, cache: cache, project: project}
}

func TestExternalLookupPreference(t *testing.T) {
	path := filepath.Join(t.TempDir(), PrefsFileName)
	if LoadExternalLookup(path) || DescribePreferences(path)["external_lookup"] != false {
		t.Fatal("external_lookup must default to false")
	}
	defaults, _ := DescribePreferences(path)["defaults"].(map[string]any)
	if defaults["external_lookup"] != false {
		t.Fatalf("defaults %v", defaults)
	}
	if _, err := ApplyPreferences(path, Obj{"external_lookup": true}); err != nil || !LoadExternalLookup(path) {
		t.Fatalf("enable: %v", err)
	}
	if DescribePreferences(path)["external_lookup"] != true {
		t.Fatal("described value not updated")
	}
	for _, bad := range []any{"yes", 1.0, Obj{}} {
		if _, err := ApplyPreferences(path, Obj{"external_lookup": bad}); err == nil {
			t.Fatalf("accepted %v", bad)
		}
	}
	if !LoadExternalLookup(path) {
		t.Fatal("rejected patch changed the file")
	}
	if _, err := ApplyPreferences(path, Obj{"external_lookup": nil}); err != nil || LoadExternalLookup(path) {
		t.Fatalf("null must reset to false: %v", err)
	}
}

func TestEvidenceRefusedWhileLookupOff(t *testing.T) {
	f := evidenceService(t, 10*time.Second, false)
	s := f.s
	if _, err := s.EvidenceStatus(true); !errors.Is(err, ErrExternalLookupOff) {
		t.Fatalf("status: %v", err)
	}
	if _, err := s.DescribeRNA(f.project, "hsa-mir-21", "9606", true, false); !errors.Is(err, ErrExternalLookupOff) {
		t.Fatalf("describe: %v", err)
	}
	if _, err := s.DescribeRNA(f.project, "hsa-mir-21", "9606", false, false); !errors.Is(err, ErrExternalLookupOff) {
		t.Fatalf("unconfirmed describe: %v", err)
	}
	if _, err := s.MapRNAID("hsa-mir-21", "9606"); !errors.Is(err, ErrExternalLookupOff) {
		t.Fatalf("map: %v", err)
	}
	card := model.EvidenceCard{EvidenceID: "ev-0123456789abcdef", SourceTool: ToolDescribe, QueryIdentifier: "x", Status: model.EvidenceSuccess}
	if _, err := s.AttachEvidence(f.project, card, model.EvidenceBinding{}); !errors.Is(err, ErrExternalLookupOff) {
		t.Fatalf("attach: %v", err)
	}
	if s.evidence.sidecar != nil || s.evidence.pid() != 0 {
		t.Fatal("the worker was prepared while lookups are off")
	}
	if _, err := os.Stat(filepath.Join(f.cache, "worker.pid")); err == nil {
		t.Fatal("the worker started while lookups are off")
	}
	// Local cards stay manageable with lookups off.
	if cards, err := s.ListEvidence(f.project); err != nil || len(cards) != 0 {
		t.Fatalf("list: %v %v", cards, err)
	}
}

func TestEvidenceValidation(t *testing.T) {
	for _, ok := range []string{"hsa-mir-21", "URS000075D341_9606", "KX377335.1", "ENSG00000284190", "a:b|c"} {
		if err := ValidateRNAID(ok); err != nil {
			t.Fatalf("%q refused: %v", ok, err)
		}
	}
	for _, bad := range []string{"", " ", "-x", "a b", "x;rm", "a/b", "../etc", "é", strings.Repeat("a", 101), "a\nb"} {
		if ValidateRNAID(bad) == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
	for _, ok := range []string{"9606", "10090", "Homo sapiens", "Mus musculus", "E. coli"} {
		if err := ValidateTaxon(ok); err != nil {
			t.Fatalf("taxon %q refused: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "96 06x;", "12345678901", "<script>", strings.Repeat("a", 65), "9606\n"} {
		if ValidateTaxon(bad) == nil {
			t.Fatalf("taxon %q accepted", bad)
		}
	}
	f := evidenceService(t, 10*time.Second, true)
	if _, err := f.s.DescribeRNA(f.project, "a b", "9606", true, false); err == nil {
		t.Fatal("bad identifier reached the worker")
	}
	if _, err := f.s.DescribeRNA(f.project, "hsa-mir-21", "9606;", true, false); err == nil {
		t.Fatal("bad taxon reached the worker")
	}
	if _, err := f.s.MapRNAID("hsa-mir-21", ""); err == nil {
		t.Fatal("map without taxon accepted")
	}
	if f.s.evidence.pid() != 0 {
		t.Fatal("validation failures started the worker")
	}
}

func TestEvidenceUnconfirmedNeedsNoNetwork(t *testing.T) {
	f := evidenceService(t, 10*time.Second, true)
	card, err := f.s.DescribeRNA(f.project, "hsa-mir-21", "9606", false, false)
	if err != nil {
		t.Fatal(err)
	}
	if card.Status != model.EvidenceIdentityUnconfirmed || card.Text() != "" || ValidateEvidenceID(card.EvidenceID) != nil ||
		card.QueryIdentifier != "hsa-mir-21" || card.TaxonText() != "9606" || card.IdentityConfirmation != "unconfirmed" {
		t.Fatalf("card %+v", card)
	}
	if f.s.evidence.pid() != 0 {
		t.Fatal("an unconfirmed identity started the worker")
	}
}

func TestEvidenceWorkerAnswers(t *testing.T) {
	f := evidenceService(t, 20*time.Second, true)
	s := f.s
	status, err := s.EvidenceStatus(true)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Enabled || !status.Connected || status.ServerPackageVersion != "0.1.1" || status.SDKVersion != "1.30.0" ||
		!slices.Equal(status.Tools, []string{ToolDescribe, ToolMap}) {
		t.Fatalf("status %+v", status)
	}
	// The worker sees only the environment allowlist.
	raw, err := s.evidence.call(Obj{"operation": "status"})
	if err != nil {
		t.Fatal(err)
	}
	var env []string
	if err := json.Unmarshal(raw["env"], &env); err != nil {
		t.Fatal(err)
	}
	allowed := []string{"PYTHONDONTWRITEBYTECODE", "PYTHONUNBUFFERED", "PYTHONIOENCODING", "RNAXRAY_EVIDENCE_CACHE", "RNAXRAY_EVIDENCE_LOG", "SYSTEMROOT"}
	for _, key := range env {
		// Python's C-locale coercion (PEP 538) and macOS add these itself.
		if !slices.Contains(allowed, key) && key != "LC_CTYPE" && !strings.HasPrefix(key, "__CF") {
			t.Fatalf("worker environment has %s: %v", key, env)
		}
	}

	card, err := s.DescribeRNA(f.project, "hsa-mir-21", "9606", true, false)
	if err != nil {
		t.Fatal(err)
	}
	if card.Status != model.EvidenceSuccess || !strings.HasPrefix(card.Text(), "WARNING: This summary was generated by AI.") ||
		card.ContentKind != "external_ai_summary" || card.IdentityConfirmation != "user_confirmed" {
		t.Fatalf("card %+v", card)
	}
	// Fields only the user or Go may set are reset.
	if card.Review.State != model.ReviewUnreviewed || card.Review.Reviewer != nil || card.CitationVerification != "not_checked" || card.Binding != nil {
		t.Fatalf("worker set review/citation/binding: %+v", card)
	}
	if card.RawText == "" || model.EvidenceDigest(card.RawText) != card.RawResponseDigest {
		t.Fatal("raw text not kept")
	}
	if card.SourceURL == nil || !strings.HasPrefix(*card.SourceURL, "https://rnacentral.org/") {
		t.Fatalf("source url %v", card.SourceURL)
	}

	notFound, err := s.DescribeRNA(f.project, "KX377335", "", true, false)
	if err != nil || notFound.Status != model.EvidenceNotFoundOrNoSummary || notFound.DisplayText != nil || notFound.Taxon != nil {
		t.Fatalf("not found: %v %+v", err, notFound)
	}
	for _, id := range []string{"weird", "elsewhere", "nocard"} {
		got, err := s.DescribeRNA(f.project, id, "9606", true, false)
		if err != nil || got.Status != model.EvidenceUnexpectedResponse || got.Text() != "" {
			t.Fatalf("%s: %v %+v", id, err, got)
		}
	}
	evil, err := s.DescribeRNA(f.project, "evil-url", "9606", true, false)
	if err != nil || evil.SourceURL != nil {
		t.Fatalf("non-RNAcentral link kept: %v %v", err, evil.SourceURL)
	}

	mapped, err := s.MapRNAID("hsa-mir-21", "9606")
	if err != nil || mapped.Status != model.EvidenceSuccess || mapped.ContentKind != "database_metadata" ||
		mapped.IdentityConfirmation != "unconfirmed" || !strings.Contains(mapped.Text(), "No RNAcentral entry found") {
		t.Fatalf("map: %v %+v", err, mapped)
	}
}

func TestEvidenceTimeoutAndCancelRestartWorker(t *testing.T) {
	f := evidenceService(t, 1500*time.Millisecond, true)
	s := f.s
	if _, err := s.DescribeRNA(f.project, "hsa-mir-21", "9606", true, false); err != nil {
		t.Fatal(err)
	}
	first := s.evidence.pid()
	child := readPid(t, filepath.Join(f.cache, "child.pid"))
	card, err := s.DescribeRNA(f.project, "slow", "9606", true, false)
	if err != nil || card.Status != model.EvidenceTimeout || card.Text() != "" {
		t.Fatalf("timeout: %v %+v", err, card)
	}
	if s.evidence.pid() != 0 {
		t.Fatal("timed-out worker is still registered")
	}
	waitGone(t, first)
	waitGone(t, child)

	again, err := s.DescribeRNA(f.project, "hsa-mir-21", "9606", true, false)
	if err != nil || again.Status != model.EvidenceSuccess {
		t.Fatalf("restart: %v %+v", err, again)
	}
	second := s.evidence.pid()
	if second == 0 || second == first {
		t.Fatalf("worker not restarted: %d -> %d", first, second)
	}

	// Cancel kills the running call's worker.
	s.evidence.sidecar.spec.Timeout = 30 * time.Second
	done := make(chan model.EvidenceCard, 1)
	go func() {
		c, _ := s.DescribeRNA(f.project, "slow", "9606", true, false)
		done <- c
	}()
	time.Sleep(400 * time.Millisecond)
	start := time.Now()
	s.CancelEvidence()
	select {
	case c := <-done:
		if c.Status != model.EvidenceCancelled {
			t.Fatalf("cancel: %+v", c)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancel did not end the call")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("cancel was slow")
	}
	waitGone(t, second)
	if c, err := s.DescribeRNA(f.project, "hsa-mir-21", "9606", true, false); err != nil || c.Status != model.EvidenceSuccess {
		t.Fatalf("after cancel: %v %+v", err, c)
	}
	// Cancel with nothing running is harmless.
	s.CancelEvidence()
}

func readPid(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	return pid
}

func sha256Hex(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func TestEvidenceAttachListUpdateDelete(t *testing.T) {
	f := evidenceService(t, 20*time.Second, true)
	s := f.s
	card, err := s.DescribeRNA(f.project, "hsa-mir-21", "9606", true, false)
	if err != nil {
		t.Fatal(err)
	}
	dbn := "((((....))))..((...))"
	binding := model.EvidenceBinding{StructureID: "structure-1", Record: "all", ResultDigest: model.EvidenceDigest(dbn),
		ProjectID: "forged", AttachedAt: "1999-01-01T00:00:00Z", IncludeInReport: false}
	saved, err := s.AttachEvidence(f.project, card, binding)
	if err != nil {
		t.Fatal(err)
	}
	b := saved.Binding
	if b == nil || b.ProjectID != "proj-123" || b.AttachedAt == "1999-01-01T00:00:00Z" || b.StructureID != "structure-1" {
		t.Fatalf("binding %+v", b)
	}
	if b.ResultDigest != "sha256:"+sha256Hex(dbn) {
		t.Fatalf("digest %s", b.ResultDigest)
	}
	dir := filepath.Join(f.project, "evidence")
	raw, err := os.ReadFile(filepath.Join(dir, card.EvidenceID+".raw.txt"))
	if err != nil || string(raw) != card.RawText || saved.RawResponseLocalRef == nil || *saved.RawResponseLocalRef != "evidence/"+card.EvidenceID+".raw.txt" {
		t.Fatalf("raw text: %v %q %v", err, raw, saved.RawResponseLocalRef)
	}
	stored, err := os.ReadFile(filepath.Join(dir, card.EvidenceID+".json"))
	if err != nil || strings.Contains(string(stored), "raw_text") || strings.Contains(string(stored), f.project) {
		t.Fatalf("stored card: %v %s", err, stored)
	}
	if _, err := s.AttachEvidence(f.project, card, binding); err == nil {
		t.Fatal("saved twice")
	}

	// A second card bound to another structure.
	other, _ := s.DescribeRNA(f.project, "KX377335", "", true, false)
	if _, err := s.AttachEvidence(f.project, other, model.EvidenceBinding{StructureID: "structure-2", Record: "3170-6229",
		ResultDigest: model.EvidenceDigest("..")}); err != nil {
		t.Fatal(err)
	}
	cards, err := s.ListEvidence(f.project)
	if err != nil || len(cards) != 2 {
		t.Fatalf("list: %v %d", err, len(cards))
	}
	relations := map[string]string{}
	for _, c := range cards {
		relations[c.QueryIdentifier] = model.EvidenceRelation(c, "structure-1", "all", model.EvidenceDigest(dbn))
	}
	if relations["hsa-mir-21"] != model.RelationCurrent || relations["KX377335"] != model.RelationOther {
		t.Fatalf("relations %v", relations)
	}
	// The same structure with a changed result is another result too.
	if model.EvidenceRelation(saved, "structure-1", "all", model.EvidenceDigest(dbn+".")) != model.RelationOther ||
		model.EvidenceRelation(saved, "structure-1", "3170-6229", model.EvidenceDigest(dbn)) != model.RelationOther ||
		model.EvidenceRelation(card, "structure-1", "all", "") != model.RelationUnbound {
		t.Fatal("changed result or record treated as current")
	}

	updated, err := s.UpdateEvidence(f.project, card.EvidenceID, model.EvidenceUpdate{IncludeInReport: true})
	if err != nil || !updated.InReport() || updated.Review.State != model.ReviewUnreviewed {
		t.Fatalf("include: %v %+v", err, updated)
	}
	updated, err = s.UpdateEvidence(f.project, card.EvidenceID, model.EvidenceUpdate{IncludeInReport: true,
		Review: &model.EvidenceReviewUpdate{State: model.ReviewReviewed, Note: " checked against PMC5549916 "}})
	if err != nil || updated.Review.State != model.ReviewReviewed || updated.Review.At == nil || updated.Review.Note == nil ||
		*updated.Review.Note != "checked against PMC5549916" {
		t.Fatalf("review: %v %+v", err, updated.Review)
	}
	if _, err := s.UpdateEvidence(f.project, card.EvidenceID, model.EvidenceUpdate{Review: &model.EvidenceReviewUpdate{State: "verified"}}); err == nil {
		t.Fatal("unknown review state accepted")
	}
	reread, _ := s.ListEvidence(f.project)
	for _, c := range reread {
		if c.EvidenceID == card.EvidenceID && (!c.InReport() || c.Review.State != model.ReviewReviewed) {
			t.Fatalf("update not stored: %+v", c)
		}
	}

	if err := s.DeleteEvidence(f.project, card.EvidenceID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, card.EvidenceID+".raw.txt")); !os.IsNotExist(err) {
		t.Fatal("raw text left behind")
	}
	if cards, _ := s.ListEvidence(f.project); len(cards) != 1 {
		t.Fatalf("after delete: %d", len(cards))
	}
	if err := s.DeleteEvidence(f.project, card.EvidenceID); err == nil {
		t.Fatal("deleted twice")
	}
}

func TestEvidenceStorageSafety(t *testing.T) {
	f := evidenceService(t, 20*time.Second, true)
	s := f.s
	card, err := s.DescribeRNA(f.project, "hsa-mir-21", "9606", true, false)
	if err != nil {
		t.Fatal(err)
	}
	good := model.EvidenceBinding{StructureID: "structure-1", Record: "all", ResultDigest: model.EvidenceDigest("()")}
	for _, b := range []model.EvidenceBinding{
		{StructureID: "../x", Record: "all", ResultDigest: good.ResultDigest},
		{StructureID: "structure-1", Record: "everything", ResultDigest: good.ResultDigest},
		{StructureID: "structure-1", Record: "all", ResultDigest: "md5:abc"},
	} {
		if _, err := s.AttachEvidence(f.project, card, b); err == nil {
			t.Fatalf("binding %+v accepted", b)
		}
	}
	forged := card
	forged.EvidenceID = "ev-../../escape"
	if _, err := s.AttachEvidence(f.project, forged, good); err == nil {
		t.Fatal("path-like evidence id accepted")
	}
	for _, status := range []string{model.EvidenceTimeout, model.EvidenceCancelled, model.EvidenceIdentityUnconfirmed, model.EvidenceUpstreamError} {
		failed := card
		failed.Status = status
		if _, err := s.AttachEvidence(f.project, failed, good); err == nil {
			t.Fatalf("%s card saved", status)
		}
	}
	if _, err := s.AttachEvidence(t.TempDir(), card, good); err == nil {
		t.Fatal("saved into a folder that is not a project")
	}
	for _, id := range []string{"../project", "ev-xyz", "ev-0123456789abcdef/../../x"} {
		if _, err := s.UpdateEvidence(f.project, id, model.EvidenceUpdate{}); err == nil {
			t.Fatalf("update %q accepted", id)
		}
		if err := s.DeleteEvidence(f.project, id); err == nil {
			t.Fatalf("delete %q accepted", id)
		}
	}
	// A symlinked evidence directory is refused.
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(f.project, "evidence")); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	if _, err := s.AttachEvidence(f.project, card, good); err == nil {
		t.Fatal("saved through a symlinked evidence directory")
	}
	if _, err := s.ListEvidence(f.project); err == nil {
		t.Fatal("listed through a symlinked evidence directory")
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatal("wrote outside the project")
	}
}

func TestEvidenceListSkipsForeignFiles(t *testing.T) {
	f := evidenceService(t, 20*time.Second, true)
	dir := filepath.Join(f.project, "evidence")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, "notes.json"), []byte(`{}`), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "ev-0123456789abcdef.json"), []byte(`{"evidence_id":"ev-fedcba9876543210"}`), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "ev-00112233445566778899.json"), []byte(`not json`), 0o644)
	if cards, err := f.s.ListEvidence(f.project); err != nil || len(cards) != 0 {
		t.Fatalf("list %v %v", cards, err)
	}
}

func TestClearEvidenceCache(t *testing.T) {
	f := evidenceService(t, 20*time.Second, false)
	if err := os.WriteFile(filepath.Join(f.cache, "entry.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := f.s.ClearEvidenceCache(); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(f.cache); len(entries) != 0 {
		t.Fatalf("cache not cleared: %v", entries)
	}
	bad := newEvidenceService(nil, func() bool { return true }, t.TempDir())
	if bad.ClearCache() == nil {
		t.Fatal("cleared a directory that is not the evidence cache")
	}
}

func TestEvidenceSpecAllowlist(t *testing.T) {
	spec := EvidenceSpec(Bridge{Root: "/r", Python: "/r/python/bin/python3"}, "/c/evidence", "/l")
	if !spec.CleanEnv || !spec.Group || spec.Timeout != 45*time.Second || spec.Dir != "/r" ||
		!slices.Equal(spec.Args, []string{"-m", "desktop.runtime.evidence.worker", "--serve"}) {
		t.Fatalf("spec %+v", spec)
	}
	for _, kv := range spec.Env {
		key, _, _ := strings.Cut(kv, "=")
		if !slices.Contains([]string{"PYTHONDONTWRITEBYTECODE", "PYTHONUNBUFFERED", "PYTHONIOENCODING", "RNAXRAY_EVIDENCE_CACHE", "RNAXRAY_EVIDENCE_LOG", "SYSTEMROOT"}, key) {
			t.Fatalf("env %s", kv)
		}
	}
	if !slices.Contains(spec.Env, "RNAXRAY_EVIDENCE_CACHE=/c/evidence") || !slices.Contains(spec.Env, "RNAXRAY_EVIDENCE_LOG=/l") {
		t.Fatalf("env %v", spec.Env)
	}
}
