package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"rnaxraydesktop/model"
)

// TestCardsCarryALocalSeal: cards saved or changed by this app carry a
// seal only this computer can make; a card edited or planted elsewhere
// reads back as not from this computer, and changing it does not seal it.
func TestCardsCarryALocalSeal(t *testing.T) {
	f := evidenceService(t, 20*time.Second, true)
	s := f.s
	card, err := s.DescribeRNA(f.project, "hsa-mir-21", "9606", true, false)
	if err != nil {
		t.Fatal(err)
	}
	binding := model.EvidenceBinding{StructureID: "structure-1", Record: "all", ResultDigest: model.EvidenceDigest("((..))")}
	if _, err := s.AttachEvidence(f.project, card, binding); err != nil {
		t.Fatal(err)
	}
	local := func() bool {
		t.Helper()
		cards, err := s.ListEvidence(f.project)
		if err != nil || len(cards) != 1 {
			t.Fatalf("%v %v", cards, err)
		}
		return cards[0].LocalOrigin
	}
	if !local() {
		t.Fatal("a card saved here is not from this computer")
	}
	if _, err := s.UpdateEvidence(f.project, card.EvidenceID, model.EvidenceUpdate{IncludeInReport: true,
		Review: &model.EvidenceReviewUpdate{State: model.ReviewReviewed}}); err != nil {
		t.Fatal(err)
	}
	if !local() {
		t.Fatal("a card reviewed here is not from this computer")
	}
	// Clearing the evidence cache keeps the seal key.
	if err := os.RemoveAll(f.cache); err != nil {
		t.Fatal(err)
	}
	if !local() {
		t.Fatal("clearing the cache lost the seal")
	}
	// Edited elsewhere: the text changed.
	path := filepath.Join(f.project, "evidence", card.EvidenceID+".json")
	var raw map[string]any
	data, _ := os.ReadFile(path)
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	raw["display_text"] = "A forged summary."
	data, _ = json.Marshal(raw)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if local() {
		t.Fatal("an edited card reads as from this computer")
	}
	// Changing it here does not seal the edited content.
	if _, err := s.UpdateEvidence(f.project, card.EvidenceID, model.EvidenceUpdate{IncludeInReport: true,
		Review: &model.EvidenceReviewUpdate{State: model.ReviewReviewed}}); err != nil {
		t.Fatal(err)
	}
	if local() {
		t.Fatal("updating an edited card sealed it")
	}
	// Another computer's seal does not pass here.
	other := evidenceService(t, 20*time.Second, true)
	if err := os.MkdirAll(filepath.Join(other.project, "evidence"), 0o755); err != nil {
		t.Fatal(err)
	}
	card2, err := other.s.DescribeRNA(other.project, "hsa-mir-21", "9606", true, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := other.s.AttachEvidence(other.project, card2, binding); err != nil {
		t.Fatal(err)
	}
	moved, _ := os.ReadFile(filepath.Join(other.project, "evidence", card2.EvidenceID+".json"))
	if err := os.WriteFile(filepath.Join(f.project, "evidence", card2.EvidenceID+".json"), moved, 0o644); err != nil {
		t.Fatal(err)
	}
	cards, _ := s.ListEvidence(f.project)
	for _, c := range cards {
		if c.EvidenceID == card2.EvidenceID && c.LocalOrigin {
			t.Fatal("another computer's card reads as from this computer")
		}
	}
}
