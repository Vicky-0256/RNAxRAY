package core

import (
	"fmt"
	"regexp"
)

// RNAcentral's literature summaries are keyed by the miRBase name
// (litsumm/hsa-mir-21); the taxon is not sent with them, and neither the
// URS id nor the mature name a mapping returns has a summary (EVIDENCE.md,
// verified 2026-10-15). The species of a summary is therefore only checked
// by the name's prefix.

// Taxon checks recorded on a describe card (taxon_check).
const (
	TaxonCheckedByName = "name_prefix" // the miRBase prefix gives this taxon
	TaxonNotChecked    = "not_checked" // as entered; not sent, not checked
)

var mirbaseName = regexp.MustCompile(`^([a-z]{3})-(?:mir|miR|let)-`)

// mirbaseSpecies: NCBI taxon and name of common miRBase prefixes.
var mirbaseSpecies = map[string][2]string{
	"hsa": {"9606", "human"}, "mmu": {"10090", "mouse"}, "rno": {"10116", "rat"},
	"mml": {"9544", "rhesus macaque"}, "ptr": {"9598", "chimpanzee"}, "bta": {"9913", "cattle"},
	"ssc": {"9823", "pig"}, "cfa": {"9615", "dog"}, "eca": {"9796", "horse"}, "oar": {"9940", "sheep"},
	"gga": {"9031", "chicken"}, "xla": {"8355", "Xenopus laevis"}, "xtr": {"8364", "Xenopus tropicalis"},
	"dre": {"7955", "zebrafish"}, "dme": {"7227", "Drosophila melanogaster"}, "aae": {"7159", "Aedes aegypti"},
	"aga": {"7165", "Anopheles gambiae"}, "bmo": {"7091", "silkworm"}, "cel": {"6239", "Caenorhabditis elegans"},
	"ath": {"3702", "Arabidopsis thaliana"}, "osa": {"39947", "rice"}, "zma": {"4577", "maize"},
}

// checkTaxonByName returns the taxon to record and its check for a
// summary of rnaID; a taxon that contradicts the name is an error.
func checkTaxonByName(rnaID, taxon string) (string, string, error) {
	m := mirbaseName.FindStringSubmatch(rnaID)
	if m == nil {
		return taxon, TaxonNotChecked, nil
	}
	species, known := mirbaseSpecies[m[1]]
	if !known {
		return taxon, TaxonNotChecked, nil
	}
	if taxon != "" && taxon != species[0] {
		return "", "", fmt.Errorf("%s is a %s name (taxon %s), not taxon %s: check the identifier or the species",
			rnaID, species[1], species[0], taxon)
	}
	return species[0], TaxonCheckedByName, nil
}
