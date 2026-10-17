package views

import (
	"fmt"
	"strings"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
	"rnaxraydesktop/widgets"
)

// Region: hybrids with an arm on gene:[start, end] (either arm order),
// optionally with the other arm on a partner range (analysis_region).

const regionRows = 200

var overlapRules = []string{"Any overlap", "Fully contained"}

type regionFilters struct {
	start, end         int
	partner            string // "" = any
	partnerStart, pEnd int
	overlap, typ       string
}

type regionState struct {
	applied regionFilters
	// inputs
	start, end, partnerStart, partnerEnd string
	partner, overlap, typ                string
	inputErr                             string

	load    loader
	data    *regionData
	profile *widgets.Profile
	list    ui.ListState
	hover   int
}

type regionData struct {
	gene               string
	f                  regionFilters
	records, reads     int64
	distinct           int64
	hasDistinct, exact bool
	partners           []partnerTotal
	bin                int
	rows               []regionRow
}

type regionRow struct {
	Gene1   string `json:"gene1"`
	Start1  int    `json:"start1"`
	End1    int    `json:"end1"`
	Gene2   string `json:"gene2"`
	Start2  int    `json:"start2"`
	End2    int    `json:"end2"`
	Type    string `json:"type"`
	Records int64  `json:"records"`
	Reads   int64  `json:"reads"`
}

func (s *regionState) init() {
	s.partner, s.overlap, s.typ = allPartners, overlapRules[0], allTypes
	s.applied = regionFilters{overlap: overlapRules[0], typ: allTypes}
	s.profile = widgets.NewProfile()
	s.hover = -1
}

// selectionChanged starts a new gene at its first 500 nt.
func (s *regionState) selectionChanged(geneChanged bool, length int) {
	if geneChanged || s.applied.end == 0 {
		end := 500
		if length > 0 {
			end = min(end, length)
		}
		s.applyRange(1, end)
		s.partner, s.partnerStart, s.partnerEnd = allPartners, "", ""
		s.applied.partner, s.applied.partnerStart, s.applied.pEnd = "", 0, 0
	}
}

// applyRange sets the anchor range (inputs and applied).
func (s *regionState) applyRange(start, end int) {
	s.applied.start, s.applied.end = start, end
	s.start, s.end = coordText(start), coordText(end)
	s.inputErr = ""
}

func (s *regionState) fromInputs() (regionFilters, error) {
	f := regionFilters{overlap: s.overlap, typ: s.typ}
	var ok [4]bool
	f.start, ok[0] = parseCoord(s.start)
	f.end, ok[1] = parseCoord(s.end)
	f.partnerStart, ok[2] = parseCoord(s.partnerStart)
	f.pEnd, ok[3] = parseCoord(s.partnerEnd)
	for _, good := range ok {
		if !good {
			return f, fmt.Errorf("positions must be whole numbers")
		}
	}
	if f.start <= 0 || f.end <= 0 || f.start > f.end {
		return f, fmt.Errorf("enter a start and an end, start not after end")
	}
	if s.partner != allPartners {
		f.partner = s.partner
	}
	if (f.partnerStart > 0) != (f.pEnd > 0) || f.partnerStart > f.pEnd {
		return f, fmt.Errorf("a partner range needs both a start and an end, start not after end")
	}
	if f.partnerStart > 0 && f.partner == "" {
		return f, fmt.Errorf("choose a partner gene for the partner range")
	}
	return f, nil
}

func (p *explorePage) regionKey() string {
	return fmt.Sprintf("%s\x00%+v", p.sel, p.rg.applied)
}

func (p *explorePage) loadRegion() {
	s := &p.rg
	if s.applied.end == 0 {
		return
	}
	path, ids, gene, f := p.a.Project.Path, p.ids, p.gene, s.applied
	p.ensure(&s.load, p.regionKey(), func() (func(), error) {
		payload := core.Obj{"gene": gene, "start": f.start, "end": f.end, "limit": regionRows, "overlap": "any"}
		if f.overlap == overlapRules[1] {
			payload["overlap"] = "contained"
		}
		if f.partner != "" {
			payload["partner"] = f.partner
		}
		if f.partnerStart > 0 {
			payload["partner_start"], payload["partner_end"] = f.partnerStart, f.pEnd
		}
		if types := typesPayload(f.typ); types != nil {
			payload["types"] = types
		}
		got, err := p.query(path, "analysis_region", ids, payload)
		if err != nil {
			return nil, err
		}
		if v := int(num(got["start"])); v > 0 {
			f.start, f.end = v, int(num(got["end"])) // as answered
		}
		d := &regionData{gene: gene, f: f, records: int64(num(got["records"])), reads: int64(num(got["reads"])),
			exact: got["rows_exact"] != false}
		if v, ok := got["distinct"].(float64); ok {
			d.distinct, d.hasDistinct = int64(v), true
		}
		_ = model.Decode(got["partners"], &d.partners)
		_ = model.Decode(got["rows"], &d.rows)
		profile, _ := got["profile"].(map[string]any)
		d.bin = int(num(profile["bin_size"]))
		starts, ends, values := ints(profile["start"]), ints(profile["end"]), floats(profile["value"])
		return func() {
			s.data = d
			s.profile.Set(starts, ends, values)
		}, nil
	})
}

func (p *explorePage) regionView(c *ui.Context) {
	s := &p.rg
	t := c.Theme()
	p.loadRegion()
	submit := func() {
		f, err := s.fromInputs()
		if err != nil {
			s.inputErr = err.Error()
			return
		}
		s.inputErr, s.applied = "", f
	}
	ui.Scroll(c).Grow(1).Children(func() {
		ui.Column(c).Gap(14).Children(func() {
			ui.Row(c).Gap(12).Wrap().AlignItems(ui.End).Children(func() {
				coordInput(c, "rg-start", "Start", &s.start, "start").OnSubmit(submit)
				coordInput(c, "rg-end", "End", &s.end, "end").OnSubmit(submit)
				picker(c, "rg-partner", "Partner", &s.partner, withAll(allPartners, p.genes()), 190)
				coordInput(c, "rg-pstart", "Partner start", &s.partnerStart, "optional").OnSubmit(submit)
				coordInput(c, "rg-pend", "Partner end", &s.partnerEnd, "optional").OnSubmit(submit)
				picker(c, "rg-overlap", "Overlap", &s.overlap, overlapRules, 150)
				picker(c, "rg-type", "Chimera type", &s.typ, withAll(allTypes, p.summary.types), 130)
				if ui.PrimaryButton(c, "Explore").Clicked() {
					submit()
				}
			})
			if s.inputErr != "" {
				errorLine(c, s.inputErr)
			}
			loadingLine(c, &s.load, "the region")
			d := s.data
			if d == nil {
				return
			}
			Card(c, "", func() {
				ui.Row(c).Gap(24).Wrap().AlignItems(ui.Center).Children(func() {
					ui.Column(c).Grow(1).Gap(2).Children(func() {
						ui.Text(c, "Region "+span(d.f.start, d.f.end)+" nt").FontSize(ts(c, 16)).Bold()
						ui.Text(c, d.gene+" · "+regionSubtitle(d.f)).FontSize(ts(c, 12)).TextColor(t.TextMuted)
					})
					stat(c, "Hybrids", FormatNumber(d.records))
					stat(c, "Reads", FormatNumber(d.reads))
					stat(c, "Partners", FormatNumber(int64(len(d.partners))))
				})
				ev := s.profile.Show(c, 140, "Reads along "+d.gene, profileColor(t))
				s.hover = ev.Hover
				readout := fmt.Sprintf("Reads of the matching hybrids per %d nt bin of the anchor arm.", d.bin)
				if i := s.hover; i >= 0 && i < s.profile.Len() {
					start, end, v := s.profile.Bin(i)
					readout = fmt.Sprintf("%s · %s reads", span(start, end), trimFloat(v))
				}
				ui.Text(c, readout).FontSize(ts(c, 12)).TextColor(t.TextMuted)
				ui.Row(c).Gap(8).Children(func() {
					if ui.PrimaryButton(c, "Show hybrids").Tooltip("Interactions with arm 1 in this region").Clicked() {
						p.showRegionHybrids(d)
					}
					if ui.Button(c, "Fold this region").Clicked() {
						p.foldRegion(d)
					}
				})
			})
			partnerCard(c, "Partners", d.partners, true)
			p.regionTable(c, d)
		})
	})
}

func regionSubtitle(f regionFilters) string {
	parts := []string{"either arm"}
	if f.overlap == overlapRules[1] {
		parts[0] = "either arm fully inside"
	}
	if f.partner != "" {
		partner := "partner " + shortGene(f.partner)
		if f.partnerStart > 0 {
			partner += ":" + span(f.partnerStart, f.pEnd)
		}
		parts = append(parts, partner)
	}
	if f.typ != "" && f.typ != allTypes {
		parts = append(parts, f.typ)
	}
	return strings.Join(parts, " · ")
}

func (p *explorePage) regionTable(c *ui.Context, d *regionData) {
	s := &p.rg
	t := c.Theme()
	title := fmt.Sprintf("Strongest interactions (%d)", len(d.rows))
	if d.hasDistinct {
		title = fmt.Sprintf("Strongest interactions (%d of %s distinct)", len(d.rows), FormatNumber(d.distinct))
	}
	Card(c, title, func() {
		ui.Text(c, "Hybrids with the same genes, arm coordinates and type are merged; by reads.").FontSize(ts(c, 12)).TextColor(t.TextMuted)
		if !d.exact {
			caveat(c, "The order over several samples is approximate near the end of this list.")
		}
		rows := d.rows
		// One RNA in every row: name it once and give its columns to the arms.
		oneGene := len(rows) > 0
		for _, r := range rows {
			if r.Gene1 != rows[0].Gene1 || r.Gene2 != rows[0].Gene1 {
				oneGene = false
				break
			}
		}
		all := []ui.TableColumn{
			{Title: "Gene 1", MinWidth: 80}, {Title: "Arm 1 (nt)", Width: 140, Align: ui.End},
			{Title: "Gene 2", MinWidth: 80}, {Title: "Arm 2 (nt)", Width: 140, Align: ui.End},
			{Title: "Type", Width: 90}, {Title: "Hybrids", Width: 80, Align: ui.End}, {Title: "Reads", Width: 80, Align: ui.End},
		}
		var cols []ui.TableColumn
		var index []int
		for i, col := range all {
			if oneGene && (i == 0 || i == 2) {
				continue
			}
			if oneGene && (i == 1 || i == 3) {
				col.Width, col.MinWidth = 0, 120
			}
			cols, index = append(cols, col), append(index, i)
		}
		if oneGene {
			ui.Text(c, "Both arms of every interaction listed are on "+rows[0].Gene1+".").FontSize(ts(c, 12)).TextColor(t.TextMuted)
		}
		ui.Table(c.Key("rg-table"), &s.list, cols, len(rows), func(row, col int) {
			r := rows[row]
			col = index[col]
			text := ""
			switch col {
			case 0:
				text = r.Gene1
			case 1:
				text = span(r.Start1, r.End1)
			case 2:
				text = r.Gene2
			case 3:
				text = span(r.Start2, r.End2)
			case 4:
				text = r.Type
			case 5:
				text = FormatNumber(r.Records)
			case 6:
				text = FormatNumber(r.Reads)
			}
			ui.Text(c, text).SingleLine().Padding(3, 6)
		}).Height(280).Label("Region interactions").Children(func() {
			if len(rows) == 0 {
				ui.Text(c, "No hybrids in this region.").TextColor(t.TextMuted).Padding(12)
			}
		})
	})
}

// showRegionHybrids lists the hybrids with arm 1 in the region (and arm 2
// on the partner range) in Interactions.
func (p *explorePage) showRegionHybrids(d *regionData) {
	f := ixFilters{gene1: d.gene, gene2: d.f.partner, typ: d.f.typ, minReads: 1, x0: d.f.start, x1: d.f.end}
	if d.f.partnerStart > 0 {
		f.y0, f.y1 = d.f.partnerStart, d.f.pEnd
	}
	p.ix.apply(f)
	p.tab = tabInteractions
}

// foldRegion opens Structure with the region (and the partner range when
// it is on the same gene), clamped to the gene.
func (p *explorePage) foldRegion(d *regionData) {
	length := p.geneLength(d.gene)
	clamp := func(start, end int) [2]int {
		if length > 0 {
			end = min(end, length)
		}
		return [2]int{max(1, start), end}
	}
	windows := [][2]int{clamp(d.f.start, d.f.end)}
	if d.f.partner == d.gene && d.f.partnerStart > 0 {
		windows = append(windows, clamp(d.f.partnerStart, d.f.pEnd))
	}
	p.foldPrefill(d.gene, windows, "region")
}
