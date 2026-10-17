package views

// "Related research": RNAcentral's existing literature summary for a
// public RNA identifier the user confirms (desktop/spec/EVIDENCE.md),
// shown below the Structure viewer. Only the identifier and taxon leave
// the machine. A summary is background material, never a validation of a
// structure; a missing summary never means "not studied". Saved cards are
// bound to one structure result (structure, record, dot-bracket digest)
// and never carried over to another.

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
)

// lookupPref is the external_lookup preference as the window knows it.
type lookupPref struct {
	known, on bool
}

// setLookup records the preference from a Preferences answer.
func (a *App) setLookup(got core.Obj) {
	on, _ := got["external_lookup"].(bool)
	a.lookup = lookupPref{known: true, on: on}
}

// researchTarget is the structure result shown (nil when none).
type researchTarget struct {
	StructureID, Record, Digest, Gene string
}

// researchDigest is a result's binding digest: the dot-bracket of its
// records (one line per record).
func researchDigest(records []structureRecord) string {
	lines := make([]string, len(records))
	for i, r := range records {
		lines[i] = r.DBN
	}
	return model.EvidenceDigest(strings.Join(lines, "\n"))
}

// researchPublicID matches names that look like public RNA identifiers
// (miRBase names, RNAcentral URS ids, Ensembl, RefSeq/GenBank accessions);
// only those prefill the query.
var researchPublicID = regexp.MustCompile(`^(?:[a-z]{3}-(?:mir|miR|let)-[A-Za-z0-9-]+|URS[0-9A-F]{10}(?:_[0-9]+)?|ENS[A-Z]*[GT][0-9]{11}(?:\.[0-9]+)?|[NX]R_[0-9]{6,9}(?:\.[0-9]+)?)$`)

// researchCardLabel names a card's status; an ID mapping is not a summary.
func researchCardLabel(card *model.EvidenceCard) string {
	if card.SourceTool == core.ToolMap && card.Status == model.EvidenceSuccess {
		return "Mapping found"
	}
	return researchStatusLabel(card.Status)
}

// researchShowDetail: the status detail is shown for failures and for every
// ID mapping (its species check is kept there on success).
func researchShowDetail(card *model.EvidenceCard) bool {
	return card.StatusDetail != nil && *card.StatusDetail != "" &&
		(card.Status != model.EvidenceSuccess || card.SourceTool == core.ToolMap)
}

// researchStatusLabel names a card's status in a few words.
func researchStatusLabel(status string) string {
	switch status {
	case model.EvidenceSuccess:
		return "Summary found"
	case model.EvidenceSummaryUnavailable:
		return "No summary available"
	case model.EvidenceNotFoundOrNoSummary:
		return "Not found or no summary"
	case model.EvidenceUpstreamError:
		return "RNAcentral error"
	case model.EvidenceLocalError:
		return "Local error"
	case model.EvidenceTimeout:
		return "Timed out"
	case model.EvidenceCancelled:
		return "Cancelled"
	case model.EvidenceIdentityUnconfirmed:
		return "Identity not confirmed"
	case model.EvidenceUnexpectedResponse:
		return "Unexpected response"
	}
	return status
}

// researchStatusText explains a status; it never turns a missing summary
// into "not studied".
func researchStatusText(card *model.EvidenceCard) string {
	switch card.Status {
	case model.EvidenceSuccess:
		if card.SourceTool == core.ToolMap {
			return "RNAcentral's answer about this identifier is below. It is advisory: you decide whether it is your RNA."
		}
		return ""
	case model.EvidenceSummaryUnavailable:
		return "RNAcentral has no literature summary for this identifier. This does not mean the RNA has not been studied."
	case model.EvidenceNotFoundOrNoSummary:
		return "RNAcentral found no entry, or no summary, for this identifier (it answers both the same way). Check the identifier; " +
			"a missing summary does not mean the RNA has not been studied."
	case model.EvidenceUpstreamError:
		return "RNAcentral could not be reached or answered with an error. Nothing is concluded; try again later."
	case model.EvidenceLocalError:
		return "The RNAcentral helper on this computer failed to start or stopped, so RNAcentral was not asked. " +
			"Nothing is concluded; try again, and restart RNAxRay Desktop if it keeps failing."
	case model.EvidenceTimeout:
		return fmt.Sprintf("No answer within %d s; the lookup was stopped. Nothing is concluded.", int(core.EvidenceTimeout.Seconds()))
	case model.EvidenceCancelled:
		return "The lookup was cancelled. Nothing is concluded."
	case model.EvidenceIdentityUnconfirmed:
		return "Confirm that the identifier and species refer to the RNA you study. Nothing was sent."
	case model.EvidenceUnexpectedResponse:
		return "The answer had an unexpected form and is not shown. Nothing is concluded."
	}
	return ""
}

// researchHeading is the card's boundary label.
func researchHeading(card *model.EvidenceCard) string {
	if card.SourceTool == core.ToolMap {
		return "RNAcentral identifier check — advisory, not an identity decision"
	}
	return model.EvidenceBoundary
}

// researchReview names a review state.
// researchOriginNotice marks a saved card without this computer's seal
// (core/evidence_seal.go): made elsewhere, or edited since it was saved.
const researchOriginNotice = "Made or edited on another computer: its text and review are not verified here"

func researchReview(r model.EvidenceReview) string {
	switch r.State {
	case model.ReviewReviewed:
		return "reviewed by the researcher"
	case model.ReviewRejected:
		return "marked not relevant by the researcher"
	}
	return "not reviewed"
}

// researchQuery is "identifier · taxon".
// researchQuery is the identifier and taxon, saying how a summary's taxon
// was checked: it is never sent with a summary (only a mapping sends it).
func researchQuery(card *model.EvidenceCard) string {
	taxon := card.TaxonText()
	if taxon == "" {
		return card.QueryIdentifier + " · no taxon"
	}
	out := card.QueryIdentifier + " · taxon " + taxon
	if card.SourceTool == core.ToolMap {
		return out
	}
	if card.TaxonCheck == core.TaxonCheckedByName {
		return out + " (checked by the miRBase name)"
	}
	return out + " (as entered; not sent to RNAcentral, not checked)"
}

// researchVersions is the server, SDK and adapter versions.
func researchVersions(card *model.EvidenceCard) string {
	return fmt.Sprintf("RNAcentral MCP server %s · MCP SDK %s · %s", nameOr(card.ServerPackageVersion, "unknown"),
		nameOr(card.SDKVersion, "unknown"), nameOr(card.AdapterVersion, "unknown adapter"))
}

// researchRetrieved is when RNAcentral answered (or was asked).
func researchRetrieved(card *model.EvidenceCard) string {
	if card.RetrievedAt != nil && *card.RetrievedAt != "" {
		return "Retrieved " + FormatTime(*card.RetrievedAt)
	}
	return "Requested " + FormatTime(card.RequestedAt) + " · no answer"
}

// researchSourceURL is the card's link when it points at RNAcentral.
func researchSourceURL(card *model.EvidenceCard) string {
	if card.SourceURL != nil && strings.HasPrefix(*card.SourceURL, "https://rnacentral.org/") {
		return *card.SourceURL
	}
	return ""
}

// researchBindingText names the result a saved card is bound to.
func researchBindingText(b *model.EvidenceBinding) string {
	if b == nil {
		return "not bound to a result"
	}
	record := "all windows"
	if b.Record != "all" {
		record = "window " + b.Record
	}
	return b.StructureID + " · " + record
}

// ---- panel

type researchPanel struct {
	a       *App
	project string

	identifier, taxon string
	confirmed         bool
	// prefillGene is the gene the identifier was last prefilled for and
	// prefilled the value it got.
	prefillGene, prefilled string
	targetKey              string

	seq     int
	running string // "", "describe" or "map"
	card    *model.EvidenceCard
	err     string
	saving  bool

	saved   []model.EvidenceCard
	listErr string
	// notes are the note drafts of saved cards (bound to the inputs).
	notes map[string]*string
}

func newResearchPanel(a *App) *researchPanel {
	return &researchPanel{a: a, notes: map[string]*string{}}
}

func (p *researchPanel) reset() {
	*p = researchPanel{a: p.a, project: p.project, notes: map[string]*string{}}
}

// Show loads the preference and the saved cards.
func (p *researchPanel) Show() {
	a := p.a
	if a.Project == nil {
		return
	}
	if a.Project.Path != p.project {
		p.project = a.Project.Path
		p.reset()
	}
	a.Go(func() func() {
		got, err := a.B.Preferences()
		return func() {
			if err == nil {
				a.setLookup(got)
			}
		}
	})
	p.loadSaved()
}

func (p *researchPanel) loadSaved() {
	a := p.a
	if a.Project == nil {
		return
	}
	path := a.Project.Path
	a.Go(func() func() {
		cards, err := a.B.ListEvidence(path)
		return func() {
			if a.Project == nil || a.Project.Path != path {
				return
			}
			if err != nil {
				p.listErr = err.Error()
				return
			}
			p.listErr, p.saved = "", cards
		}
	})
}

// follow resets the query state when the shown result changes, so nothing
// from one result is carried to another.
func (p *researchPanel) follow(target *researchTarget) {
	key, gene := "", p.a.Selected.Gene
	if target != nil {
		key = target.StructureID + "|" + target.Record + "|" + target.Digest
		gene = nameOr(target.Gene, gene)
	}
	if key != p.targetKey {
		p.targetKey = key
		p.card, p.err, p.confirmed = nil, "", false
		// A lookup still running was asked for the previous result: its
		// answer is dropped (seq) rather than shown and saved here.
		p.seq++
		p.running = ""
	}
	if gene != p.prefillGene {
		p.prefillGene = gene
		if p.identifier == "" || p.identifier == p.prefilled {
			p.identifier, p.prefilled = "", ""
			if researchPublicID.MatchString(gene) {
				p.identifier, p.prefilled = gene, gene
			}
			p.confirmed = false
		}
	}
}

func (p *researchPanel) lookup(op string, force bool) {
	a := p.a
	if a.Project == nil || p.running != "" {
		return
	}
	path := a.Project.Path
	id, taxon, confirmed := strings.TrimSpace(p.identifier), strings.TrimSpace(p.taxon), p.confirmed
	p.seq++
	seq := p.seq
	p.running, p.err, p.card = op, "", nil
	a.Go(func() func() {
		var card model.EvidenceCard
		var err error
		if op == "map" {
			card, err = a.B.MapRNAID(id, taxon)
		} else {
			card, err = a.B.DescribeRNA(path, id, taxon, confirmed, force)
		}
		return func() {
			if a.Project == nil || a.Project.Path != path || seq != p.seq {
				return
			}
			p.running = ""
			if err != nil {
				p.err = err.Error()
				if errors.Is(err, core.ErrExternalLookupOff) {
					a.lookup = lookupPref{known: true}
				}
				return
			}
			p.card = &card
		}
	})
}

func (p *researchPanel) cancel() {
	b := p.a.B
	go b.CancelEvidence()
}

func (p *researchPanel) save(target *researchTarget) {
	a := p.a
	if a.Project == nil || p.card == nil || target == nil || p.saving {
		return
	}
	path, card := a.Project.Path, *p.card
	binding := model.EvidenceBinding{StructureID: target.StructureID, Record: target.Record, ResultDigest: target.Digest}
	p.saving = true
	a.Go(func() func() {
		_, err := a.B.AttachEvidence(path, card, binding)
		return func() {
			if a.Project == nil || a.Project.Path != path {
				return
			}
			p.saving = false
			if err != nil {
				a.Toast("Could not save the card: %v", err)
				return
			}
			a.Toast("Saved to the project")
			p.loadSaved()
		}
	})
}

func (p *researchPanel) update(id string, update model.EvidenceUpdate) {
	a := p.a
	if a.Project == nil {
		return
	}
	path := a.Project.Path
	a.Go(func() func() {
		_, err := a.B.UpdateEvidence(path, id, update)
		return func() {
			if a.Project == nil || a.Project.Path != path {
				return
			}
			if err != nil {
				a.Toast("Could not update the card: %v", err)
			}
			p.loadSaved()
		}
	})
}

func (p *researchPanel) remove(id string) {
	a := p.a
	if a.Project == nil {
		return
	}
	path := a.Project.Path
	a.Go(func() func() {
		err := a.B.DeleteEvidence(path, id)
		return func() {
			if a.Project == nil || a.Project.Path != path {
				return
			}
			if err != nil {
				a.Toast("Could not remove the card: %v", err)
			}
			p.loadSaved()
		}
	})
}

// View draws the panel for the result shown (target may be nil).
func (p *researchPanel) View(c *ui.Context, target *researchTarget) {
	a := p.a
	t := c.Theme()
	p.follow(target)
	Card(c, "Related research", func() {
		if !a.lookup.known {
			ui.Text(c, "Loading…").TextColor(t.TextMuted)
			return
		}
		if !a.lookup.on {
			ui.Text(c, "Look up what RNAcentral already holds about a public RNA identifier: an AI-generated literature summary "+
				"with its sources, as background for your own reading.").TextColor(t.TextMuted)
			ui.Text(c, "External lookups are off. When you turn them on, only the identifier and species you enter are sent to "+
				"RNAcentral; no sequence, structure or project data leaves this computer.").FontSize(ts(c, 12)).TextColor(t.TextMuted)
			ui.Row(c).Children(func() {
				if brandLink(c, "Turn on in Preferences…").Clicked() {
					a.openPrefs()
				}
			})
			p.savedView(c, target)
			return
		}
		p.queryView(c)
		if p.err != "" {
			errorLine(c, p.err)
		}
		if p.card != nil {
			p.cardView(c, p.card, target)
		}
		p.savedView(c, target)
	})
}

func (p *researchPanel) queryView(c *ui.Context) {
	t := c.Theme()
	running := p.running != ""
	ui.Row(c).Gap(12).Wrap().Children(func() {
		ui.Column(c).Grow(2).Basis(220).Children(func() {
			Field(c, "Public identifier", func() {
				ui.TextInput(c.Key("rs-id"), &p.identifier).Placeholder("e.g. hsa-mir-21 or URS000075D341_9606").Label("Public identifier").Disabled(running)
			})
		})
		ui.Column(c).Grow(1).Basis(160).Children(func() {
			Field(c, "Species (taxon)", func() {
				ui.TextInput(c.Key("rs-taxon"), &p.taxon).Placeholder("e.g. 9606 or Homo sapiens").Label("Species (taxon)").Disabled(running)
			})
		})
	})
	ui.Checkbox(c.Key("rs-confirm"), &p.confirmed, "I confirm this identifier and species refer to the RNA I am studying").Disabled(running)
	ui.Text(c, "Sends only: identifier, taxon. Nothing else leaves this computer.").FontSize(ts(c, 12)).TextColor(t.TextMuted)
	id, taxon := strings.TrimSpace(p.identifier), strings.TrimSpace(p.taxon)
	ui.Row(c).Gap(8).AlignItems(ui.Center).Wrap().Children(func() {
		if ui.PrimaryButton(c, "View existing summary").Disabled(running || id == "").
			Tooltip("RNAcentral's existing literature summary for the identifier").Clicked() {
			p.lookup("describe", false)
		}
		if ui.Button(c, "Check identifier").Disabled(running || id == "" || taxon == "").
			Tooltip("Ask RNAcentral how it maps the identifier within the species (needs the taxon)").Clicked() {
			p.lookup("map", false)
		}
		if running {
			ui.Spinner(c).Label("Looking up RNAcentral")
			ui.Text(c, "Asking RNAcentral…").FontSize(ts(c, 12)).TextColor(t.TextMuted)
			if ui.Button(c, "Cancel").Clicked() {
				p.cancel()
			}
		}
	})
}

func (p *researchPanel) cardView(c *ui.Context, card *model.EvidenceCard, target *researchTarget) {
	t := c.Theme()
	ok := card.Status == model.EvidenceSuccess
	tone := t.Warning
	if !ok {
		tone = t.TextMuted
	}
	ui.Column(c.Key("rs-card")).Gap(8).Padding(12).Radius(8).Border(1, t.Border).Children(func() {
		ui.Text(c, researchHeading(card)).Bold().Padding(4, 8).Radius(6).Background(tone.Alpha(0.14))
		ui.Row(c).Gap(8).AlignItems(ui.Center).Wrap().Children(func() {
			ui.Badge(c, researchCardLabel(card))
			ui.Text(c, researchQuery(card)).FontSize(ts(c, 12)).TextColor(t.TextMuted)
		})
		if text := researchStatusText(card); text != "" {
			ui.Text(c, text)
		}
		if researchShowDetail(card) {
			ui.Text(c, "Detail: "+*card.StatusDetail).FontSize(ts(c, 12)).TextColor(t.TextMuted)
		}
		if text := card.Text(); text != "" {
			ui.Text(c, text).Padding(8, 10).Radius(6).Background(t.Surface)
		}
		if len(card.SourceIdentifiers) > 0 {
			ui.Text(c, "Cited in the text (citations not verified): "+strings.Join(card.SourceIdentifiers, ", ")).FontSize(ts(c, 12))
		}
		ui.Text(c, researchRetrieved(card)+" · "+researchVersions(card)).FontSize(ts(c, 11)).TextColor(t.TextMuted)
		ui.Row(c).Gap(8).Wrap().Children(func() {
			if u := researchSourceURL(card); u != "" && ui.Button(c, "Open source").Tooltip(u).Clicked() {
				c.OpenURL(u)
			}
			if card.Saveable() {
				if ui.Button(c, "Save to project").Disabled(target == nil || p.saving).
					Tooltip("Save this card with the result shown above; it is not applied to any other result").Clicked() {
					p.save(target)
				}
			}
			if card.SourceTool == core.ToolDescribe && card.Status != model.EvidenceIdentityUnconfirmed &&
				ui.Button(c, "Fetch again").Disabled(p.running != "").Tooltip("Ask RNAcentral again instead of using the cached answer").Clicked() {
				p.lookup("describe", true)
			}
		})
		if card.Saveable() && target == nil {
			ui.Text(c, "Show a result above to save this card with it.").FontSize(ts(c, 12)).TextColor(t.TextMuted)
		}
	})
}

func (p *researchPanel) savedView(c *ui.Context, target *researchTarget) {
	t := c.Theme()
	if p.listErr != "" {
		errorLine(c, "Could not read the saved cards: "+p.listErr)
	}
	var current, other []*model.EvidenceCard
	for i := range p.saved {
		card := &p.saved[i]
		if target != nil && model.EvidenceRelation(*card, target.StructureID, target.Record, target.Digest) == model.RelationCurrent {
			current = append(current, card)
		} else {
			other = append(other, card)
		}
	}
	if len(current) == 0 && len(other) == 0 {
		return
	}
	ui.Column(c).Gap(8).Padding(10, 0, 0, 0).BorderWidth(1, 0, 0, 0).BorderColor(t.Border).Children(func() {
		if target != nil {
			ui.Text(c, fmt.Sprintf("Saved for this result (%d)", len(current))).Bold()
		}
		for _, card := range current {
			p.savedCard(c, card)
		}
		if len(other) > 0 {
			ui.Text(c, fmt.Sprintf("Saved for other results (%d) — not applied here", len(other))).FontSize(ts(c, 12)).Bold().TextColor(t.TextMuted)
			for _, card := range other {
				ui.Text(c.Key("rs-other-"+card.EvidenceID), card.QueryIdentifier+" · "+researchCardLabel(card)+
					" · for another result ("+researchBindingText(card.Binding)+")").FontSize(ts(c, 12)).TextColor(t.TextMuted)
			}
		}
	})
}

func (p *researchPanel) savedCard(c *ui.Context, card *model.EvidenceCard) {
	t := c.Theme()
	id := card.EvidenceID
	ui.Column(c.Key("rs-saved-"+id)).Gap(6).Padding(8, 10).Radius(8).Border(1, t.Border).Children(func() {
		ui.Text(c, researchQuery(card)+" · "+researchCardLabel(card)).Bold()
		ui.Text(c, researchHeading(card)).FontSize(ts(c, 12)).TextColor(t.TextMuted)
		if text := card.Text(); text != "" {
			ui.Text(c, truncate(text, 400)).FontSize(ts(c, 12))
		}
		ui.Text(c, researchRetrieved(card)+" · "+researchReview(card.Review)+" · citations not verified").FontSize(ts(c, 11)).TextColor(t.TextMuted)
		if !card.LocalOrigin {
			ui.Text(c, researchOriginNotice+".").FontSize(ts(c, 11)).TextColor(t.Warning)
		}
		ui.Row(c).Gap(8).AlignItems(ui.Center).Wrap().Children(func() {
			if card.Binding != nil && ui.Checkbox(c.Key("rs-report-"+id), &card.Binding.IncludeInReport, "Include in report").Changed() {
				p.update(id, model.EvidenceUpdate{IncludeInReport: card.Binding.IncludeInReport})
			}
			note := p.note(card)
			if card.Review.State == model.ReviewUnreviewed {
				if ui.Button(c, "Mark reviewed").Tooltip("You have read the summary and checked its sources").Clicked() {
					p.update(id, model.EvidenceUpdate{IncludeInReport: card.InReport(), Review: &model.EvidenceReviewUpdate{State: model.ReviewReviewed, Note: note}})
				}
				if ui.Button(c, "Not relevant").Clicked() {
					p.update(id, model.EvidenceUpdate{IncludeInReport: card.InReport(), Review: &model.EvidenceReviewUpdate{State: model.ReviewRejected, Note: note}})
				}
			} else if ui.Button(c, "Mark unreviewed").Clicked() {
				p.update(id, model.EvidenceUpdate{IncludeInReport: card.InReport(), Review: &model.EvidenceReviewUpdate{State: model.ReviewUnreviewed, Note: note}})
			}
			if u := researchSourceURL(card); u != "" && ui.Button(c, "Open source").Tooltip(u).Clicked() {
				c.OpenURL(u)
			}
			if ui.Button(c, "Remove").Clicked() {
				p.remove(id)
			}
		})
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.TextInput(c.Key("rs-note-"+id), p.noteDraft(card)).Placeholder("Your note (shown in the report)").Label("Researcher note").Grow(1)
			if ui.Button(c, "Save note").Clicked() {
				p.update(id, model.EvidenceUpdate{IncludeInReport: card.InReport(),
					Review: &model.EvidenceReviewUpdate{State: card.Review.State, Note: p.note(card)}})
			}
		})
	})
}

// noteDraft is the persistent draft of a saved card's note, starting from
// the stored note.
func (p *researchPanel) noteDraft(card *model.EvidenceCard) *string {
	draft := p.notes[card.EvidenceID]
	if draft == nil {
		draft = new(string)
		if card.Review.Note != nil {
			*draft = *card.Review.Note
		}
		p.notes[card.EvidenceID] = draft
	}
	return draft
}

func (p *researchPanel) note(card *model.EvidenceCard) string { return *p.noteDraft(card) }
