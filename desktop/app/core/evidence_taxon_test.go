package core

import (
	"strings"
	"testing"
	"time"
)

// TestDescribeChecksTheSpeciesByTheNamePrefix: RNAcentral's summaries are
// keyed by the miRBase name and the taxon is never sent with them, so the
// only species check is the name's prefix: a mismatch is refused before
// any request, a match (or no taxon) is recorded as checked by the name,
// and any other identifier keeps the taxon as entered, not checked.
func TestDescribeChecksTheSpeciesByTheNamePrefix(t *testing.T) {
	f := evidenceService(t, 20*time.Second, true)
	s := f.s
	if _, err := s.DescribeRNA(f.project, "hsa-mir-21", "10090", true, false); err == nil ||
		!strings.Contains(err.Error(), "9606") || !strings.Contains(err.Error(), "10090") {
		t.Fatalf("mismatch: %v", err)
	}
	if s.evidence.sidecar != nil {
		t.Fatal("the worker was started for a refused lookup")
	}
	card, err := s.DescribeRNA(f.project, "hsa-mir-21", "9606", true, false)
	if err != nil || card.TaxonCheck != TaxonCheckedByName || card.TaxonText() != "9606" {
		t.Fatalf("match: %+v %v", card, err)
	}
	card, err = s.DescribeRNA(f.project, "aae-mir-1", "", true, false)
	if err != nil || card.TaxonCheck != TaxonCheckedByName || card.TaxonText() != "7159" {
		t.Fatalf("no taxon: %+v %v", card, err)
	}
	card, err = s.DescribeRNA(f.project, "URS000039ED8D_9606", "9606", true, false)
	if err != nil || card.TaxonCheck != TaxonNotChecked || card.TaxonText() != "9606" {
		t.Fatalf("other identifier: %+v %v", card, err)
	}
}
