//go:build e2e

package main

import (
	"os"
	"path/filepath"
	"testing"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
)

// TestEvidenceLive goes Go service -> real evidence worker -> MCP SDK ->
// rnacentral-mcp-server -> rnacentral.org with public ids only.
//
//	RNAXRAY_EVIDENCE_LIVE=1 CGO_ENABLED=0 go test -tags e2e -run TestEvidenceLive -v .
func TestEvidenceLive(t *testing.T) {
	if os.Getenv("RNAXRAY_EVIDENCE_LIVE") == "" {
		t.Skip("RNAXRAY_EVIDENCE_LIVE is not set (makes real requests to rnacentral.org)")
	}
	root := repoRoot()
	python := filepath.Join(root, "desktop", "resources", "native", "python", "bin", "python3")
	rt, err := core.NewRuntime(core.Bridge{Root: root, Python: python}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	prefs := filepath.Join(t.TempDir(), "preferences.json")
	service := core.NewService(rt, core.ServiceOptions{PreferencesPath: prefs,
		EvidenceCacheDir: t.TempDir(), EvidenceLogDir: t.TempDir()})
	defer service.Shutdown()

	if _, err := service.DescribeRNA("", "hsa-mir-21", "9606", true, false); err == nil {
		t.Fatal("a lookup ran with external_lookup off")
	}
	if _, err := service.SetPreferences(core.Obj{"external_lookup": true}); err != nil {
		t.Fatal(err)
	}
	status, err := service.EvidenceStatus(true)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("status %+v", status)

	project := filepath.Join(t.TempDir(), "p.rnaxrayproj")
	if _, err := service.CreateProject(project, "Evidence", ""); err != nil {
		t.Fatal(err)
	}
	card, err := service.DescribeRNA(project, "hsa-mir-21", "9606", true, false)
	if err != nil {
		t.Fatal(err)
	}
	text := ""
	if card.DisplayText != nil {
		text = *card.DisplayText
	}
	t.Logf("hsa-mir-21: %s %s, %d chars, ids %v", card.Status, card.ContentKind, len(text), card.SourceIdentifiers)
	if card.Status != "success" || card.ContentKind != "external_ai_summary" || len(card.SourceIdentifiers) == 0 {
		t.Fatalf("card %+v", card)
	}
	missing, err := service.DescribeRNA(project, "KX377335", "", true, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("KX377335: %s (%v)", missing.Status, deref(missing.StatusDetail))
	if missing.Status != "not_found_or_no_summary" || missing.DisplayText != nil {
		t.Fatalf("card %+v", missing)
	}
	unconfirmed, _ := service.DescribeRNA(project, "hsa-mir-21", "9606", false, false)
	if unconfirmed.Status != "identity_unconfirmed" {
		t.Fatalf("unconfirmed %+v", unconfirmed)
	}
	saved, err := service.AttachEvidence(project, card, model.EvidenceBinding{StructureID: "s1", Record: "all",
		ResultDigest: model.EvidenceDigest("((..))"), IncludeInReport: true})
	if err != nil {
		t.Fatal(err)
	}
	listed, err := service.ListEvidence(project)
	if err != nil || len(listed) != 1 || listed[0].EvidenceID != saved.EvidenceID {
		t.Fatalf("listed %v %v", listed, err)
	}
	if _, err := os.Stat(filepath.Join(project, "evidence", saved.EvidenceID+".raw.txt")); err != nil {
		t.Fatalf("raw text not saved: %v", err)
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
