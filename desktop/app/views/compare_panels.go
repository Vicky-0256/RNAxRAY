package views

// Compare page panels of the selected test, for a lineage comparison
// figure:
//
//   - Enriched regions: for each direction, the most significant merged
//     interaction (padj below a cutoff) that the enriched lineage's own
//     whole-RNA fold forms, its two windows cut from both lineages' folds
//     and drawn as 2D diagrams (project operation structure_regions,
//     desktop/runtime/regions.py; another candidate can be chosen).
//   - Folding energy: RNAcofold dG of 2 x L nt around the arms of every
//     interaction with padj below a cutoff, in both lineages' sequences,
//     violins per direction with a paired t-test (an `energy` task,
//     desktop/runtime/energy.py; read back with read_energy).

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
)

func init() {
	OnTaskFinished(func(a *App, t model.Task) {
		p, ok := a.pages["compare"].(*comparePage)
		if !ok || a.Project == nil {
			return
		}
		switch t.Kind {
		case "energy":
			p.panels.energy = map[string]*energyResult{}
			p.panels.energyErr = map[string]string{}
			p.loadEnergy(p.selectedID)
		case "structure":
			// a new whole-RNA fold: list the folds again when the card shows
			p.panels.foldsLoaded = false
		}
	})
}

// cmpPanels is the panels' state (part of comparePage).
type cmpPanels struct {
	// whole-RNA folds of the project (list_structures, genome mode)
	folds        []structureEntry
	foldsLoading bool
	foldsLoaded  bool
	foldA, foldB string
	foldsFor     string // the test the default folds were picked for

	padj, reach, flank float64
	choice             map[string]int // direction -> chosen rank
	regions            *regionsResult
	regionsFor         string // comparison id of regions
	regionsBusy        bool
	regionsErr         string

	energyLen, energyPadj float64
	energyPick            string // "40 nt" when several lengths exist
	energy                map[string]*energyResult
	energyBusy            map[string]bool
	energyErr             map[string]string
	energyMsg             string
	violins               map[string][2]violinStats // id/length/side -> statistics (computed once)
}

func (s *cmpPanels) reset() {
	*s = cmpPanels{padj: 0.01, reach: 50, flank: 15, choice: map[string]int{}, energyLen: 40, energyPadj: 0.01,
		energy: map[string]*energyResult{}, energyBusy: map[string]bool{}, energyErr: map[string]string{}}
}

// ---- loading

func (p *comparePage) loadFolds() {
	a, s := p.a, &p.panels
	if a.Project == nil || s.foldsLoading {
		return
	}
	s.foldsLoading = true
	path := a.Project.Path
	a.Go(func() func() {
		listed, err := a.B.ProjectOp(path, "list_structures", nil)
		var entries []structureEntry
		if err == nil {
			err = model.Decode(listed["structures"], &entries)
		}
		return func() {
			if a.Project == nil || a.Project.Path != path {
				return
			}
			s.foldsLoading, s.foldsLoaded = false, true
			s.folds = nil
			if err != nil {
				s.regionsErr = "Could not list the structures: " + err.Error()
				return
			}
			listed := map[string]bool{}
			for _, e := range entries {
				if e.Mode == "genome" && (e.Available == nil || *e.Available) {
					s.folds = append(s.folds, e)
					listed[e.ID] = true
				}
			}
			if !listed[s.foldA] || !listed[s.foldB] {
				s.foldsFor = "" // pick again; the user's choices stay while they exist
			}
		}
	})
}

// defaultFolds picks, for each condition of the test, a whole-RNA fold on
// its gene, preferring one folded with that condition's own samples.
func (p *comparePage) defaultFolds(e *comparisonEntry, ctx cmpContext) {
	s := &p.panels
	if s.foldsFor == e.ID {
		return
	}
	s.foldsFor = e.ID
	pick := func(gene string, ids []string, avoid string) string {
		best, score := "", -1
		for _, f := range s.folds {
			if f.ID == avoid {
				continue
			}
			sc := 0
			if f.GeneID == gene {
				sc += 2
			}
			if len(f.SampleIDs) > 0 && cmpSameSet(ids, f.SampleIDs) {
				sc++
			}
			if sc > score {
				best, score = f.ID, sc
			}
		}
		return best
	}
	s.foldA = pick(ctx.GeneA, ctx.IDsA, "")
	s.foldB = pick(ctx.GeneB, ctx.IDsB, s.foldA)
}

func (p *comparePage) runRegions(e *comparisonEntry) {
	a, s := p.a, &p.panels
	if a.Project == nil || s.regionsBusy {
		return
	}
	if s.foldA == "" || s.foldB == "" {
		s.regionsErr = "Choose a whole-RNA fold for each lineage."
		return
	}
	if s.regionsFor != e.ID {
		s.choice = map[string]int{}
	}
	payload := core.Obj{"comparison_id": e.ID, "structure_one": s.foldA, "structure_two": s.foldB,
		"padj": s.padj, "reach": int(s.reach), "flank": int(s.flank)}
	choice := core.Obj{}
	for k, v := range s.choice {
		choice[k] = v
	}
	payload["choice"] = choice
	s.regionsBusy, s.regionsErr = true, ""
	path, id := a.Project.Path, e.ID
	a.Go(func() func() {
		raw, err := a.B.ProjectOp(path, "structure_regions", payload)
		var res regionsResult
		if err == nil {
			err = model.Decode(raw, &res)
		}
		return func() {
			if a.Project == nil || a.Project.Path != path {
				return
			}
			s.regionsBusy = false
			if err != nil {
				s.regionsErr = err.Error()
				return
			}
			s.regions, s.regionsFor = &res, id
			for _, r := range res.Regions {
				if r.Chosen != nil {
					s.choice[r.Direction] = *r.Chosen
				}
			}
		}
	})
}

func (p *comparePage) loadEnergy(id string) {
	a, s := p.a, &p.panels
	if a.Project == nil || id == "" || s.energyBusy[id] || s.energy[id] != nil || s.energyErr[id] != "" {
		return
	}
	length := 0
	if s.energyPick != "" {
		length, _ = strconv.Atoi(strings.TrimSuffix(s.energyPick, " nt"))
	}
	s.energyBusy[id] = true
	path := a.Project.Path
	a.Go(func() func() {
		payload := core.Obj{"comparison_id": id}
		if length > 0 {
			payload["length"] = length
		}
		raw, err := a.B.ProjectOp(path, "read_energy", payload)
		var res energyResult
		if err == nil {
			err = model.Decode(raw, &res)
		}
		return func() {
			if a.Project == nil || a.Project.Path != path {
				return
			}
			delete(s.energyBusy, id)
			if err != nil {
				s.energyErr[id] = err.Error()
				return
			}
			s.energy[id] = &res
			s.violins = nil
		}
	})
}

func (p *comparePage) runEnergy(e *comparisonEntry, ctx cmpContext) {
	a, s := p.a, &p.panels
	s.energyMsg = ""
	id := e.ID
	length, padj := int(s.energyLen), s.energyPadj
	req := core.TaskStartRequest{Kind: "energy", ComparisonID: &id, Parameters: map[string]any{"length": length, "padj": padj}}
	a.StartTask(req, fmt.Sprintf("Folding energy · %s vs %s · %d nt", ctx.LabelA, ctx.LabelB, length), func(t model.Task, err error) {
		if err != nil {
			s.energyMsg = "Could not start: " + err.Error()
			return
		}
		s.energyPick = fmt.Sprintf("%d nt", length)
	})
}

// ---- view

// panelLabels are the two conditions' names.
func (p *comparePage) panelLabels(ctx cmpContext) [2]string {
	return [2]string{ctx.LabelA, ctx.LabelB}
}

func (p *comparePage) foldTitle(f *structureEntry) string {
	names := make([]string, 0, len(f.SampleIDs))
	for _, id := range f.SampleIDs {
		names = append(names, p.sampleName(id))
	}
	evidence := strings.Join(names, " + ")
	if evidence == "" {
		evidence = "no evidence"
	}
	gene := shortName(f.GeneID)
	if r := p.a.Project.Reference(stReferenceOf(p.a.Project, f.GeneID)); r != nil {
		gene = nameOr(r.Label, gene)
	}
	return gene + " · " + evidence + " · " + FormatTime(f.CreatedAt)
}

func (p *comparePage) foldPicker(c *ui.Context, label string, color ui.Color, value *string) {
	s := &p.panels
	options := make([]string, 0, len(s.folds))
	current := ""
	for i := range s.folds {
		title := p.foldTitle(&s.folds[i])
		options = append(options, title)
		if s.folds[i].ID == *value {
			current = title
		}
	}
	ui.Column(c).Gap(4).Children(func() {
		ui.Text(c, label).FontSize(12).Bold().TextColor(color)
		ui.Select(c.Key("fold"), &current, options).Width(300).Label(label).OnChange(func() {
			for i, o := range options {
				if o == current {
					*value = s.folds[i].ID
				}
			}
		})
	})
}

func (p *comparePage) regionsCard(c *ui.Context, e *comparisonEntry, ctx cmpContext) {
	t := c.Theme()
	s := &p.panels
	labels := p.panelLabels(ctx)
	if !s.foldsLoaded && !s.foldsLoading {
		p.loadFolds()
	}
	if s.foldsLoaded {
		p.defaultFolds(e, ctx)
	}
	Card(c, "", func() {
		ui.Row(c).Gap(8).Children(func() {
			ui.Text(c, "Enriched regions").FontSize(16).Bold().Grow(1)
			if s.regions != nil && s.regionsFor == e.ID {
				if ui.Button(c, "Export SVG…").Tooltip("Save both regions' diagrams").Clicked() {
					p.exportRegionsSVG(ctx)
				}
				if ui.Button(c, "Export TSV…").Tooltip("Save the bases of every diagram (layout, partners)").Clicked() {
					p.exportRegionsTSV(ctx)
				}
			}
		})
		ui.Text(c, fmt.Sprintf("For each direction, the most significant interaction that the enriched lineage's own whole-RNA fold forms (a base pair within the reach of both arms), cut from both lineages' folds: windows = those pairs ± flank, joined by a %d-nt linker for the layout only.", 3)).
			FontSize(12).TextColor(t.TextMuted)
		if s.foldsLoaded && len(s.folds) < 2 {
			ui.Text(c, "Fold the whole RNA of each lineage on the Structure page (New fold → whole RNA) to draw the regions.").TextColor(t.TextMuted)
			return
		}
		ui.Row(c).Gap(12).AlignItems(ui.End).Wrap().Children(func() {
			p.foldPicker(c.Key("cmp-fold-a"), "Fold of "+labels[0], cmpRed, &s.foldA)
			p.foldPicker(c.Key("cmp-fold-b"), "Fold of "+labels[1], cmpBlue, &s.foldB)
			Field(c, "padj <", func() {
				ui.NumberInput(c.Key("cmp-reg-padj"), &s.padj, 1e-12, 1, 0.001).Label("Regions padj cutoff")
			})
			Field(c, "Reach (nt)", func() {
				ui.NumberInput(c.Key("cmp-reg-reach"), &s.reach, 0, 1000, 10).Label("Reach")
			})
			Field(c, "Flank (nt)", func() {
				ui.NumberInput(c.Key("cmp-reg-flank"), &s.flank, 0, 200, 5).Label("Flank")
			})
			label := "Show regions"
			if s.regionsBusy {
				label = "Cutting…"
			}
			if ui.PrimaryButton(c, label).Disabled(s.regionsBusy || !s.foldsLoaded).Clicked() {
				s.choice = map[string]int{}
				p.runRegions(e)
			}
		})
		if s.regionsErr != "" {
			ui.Text(c, ShortError(s.regionsErr)).TextColor(t.Danger)
		}
		res := s.regions
		if res == nil || s.regionsFor != e.ID {
			return
		}
		for k := range res.Regions {
			p.regionBlock(c.Key(fmt.Sprintf("cmp-region-%d", k)), e, k, &res.Regions[k], labels)
		}
		var notes []string
		seen := map[string]bool{}
		for _, m := range res.Alignment {
			if seen[m.To+">"+m.From] {
				continue // the reverse map of one already named
			}
			seen[m.From+">"+m.To] = true
			notes = append(notes, fmt.Sprintf("%s → %s by alignment: %.1f%% identity, %d gap columns", shortName(m.From), shortName(m.To), 100*m.Identity, m.Gaps))
		}
		if len(notes) > 0 {
			ui.Text(c, strings.Join(notes, " · ")+". Windows and interactions are on "+labels[0]+"'s coordinates; each panel shows its fold's own.").
				FontSize(11).TextColor(t.TextMuted)
		}
	})
}

func (p *comparePage) regionBlock(c *ui.Context, e *comparisonEntry, k int, r *regionResult, labels [2]string) {
	t := c.Theme()
	s := &p.panels
	color := regionColor(r.Enriched)
	ui.Column(c).Gap(8).Padding(10, 0, 0, 0).Children(func() {
		ui.Row(c).Gap(10).AlignItems(ui.Center).Wrap().Children(func() {
			ui.Text(c, regionName(k)+" · higher in "+labels[r.Enriched]).FontSize(15).Bold().TextColor(color)
			if len(r.Candidates) == 0 {
				ui.Text(c, fmt.Sprintf("none of the %s interactions with padj < %g is formed by %s's fold", FormatNumber(int64(r.Tested)), s.padj, labels[r.Enriched])).
					TextColor(t.TextMuted)
				return
			}
			options := make([]string, len(r.Candidates))
			current := ""
			for i := range r.Candidates {
				options[i] = candidateText(&r.Candidates[i])
				if r.Chosen != nil && r.Candidates[i].Rank == *r.Chosen {
					current = options[i]
				}
			}
			ui.Select(c.Key("candidate"), &current, options).Width(420).Label(regionName(k) + " interaction").OnChange(func() {
				for i, o := range options {
					if o == current {
						s.choice[r.Direction] = r.Candidates[i].Rank
						p.runRegions(e)
					}
				}
			})
			ui.Text(c, fmt.Sprintf("of %s with padj < %g", FormatNumber(int64(r.Tested)), s.padj)).FontSize(12).TextColor(t.TextMuted)
		})
		chosen := r.chosen()
		if chosen == nil || len(r.Panels) == 0 {
			return
		}
		ui.Text(c, fmt.Sprintf("Windows %s on %s's coordinates · %d pairs of %s's fold within ±%d nt of both arms (%d of %s's)",
			windowsText(r.Windows), labels[0], chosen.PairsOwn, labels[r.Enriched], int(s.reach), chosen.PairsOther, labels[1-r.Enriched])).
			FontSize(12).TextColor(t.TextMuted)
		ui.Row(c).Gap(16).Wrap().AlignItems(ui.Start).Children(func() {
			for i := range r.Panels {
				pn := &r.Panels[i]
				ui.Column(c.Key(fmt.Sprintf("panel-%d", i))).Gap(4).Width(340).Children(func() {
					fig := regionFigure(pn, color, figPaletteOf(t), 340)
					title := labels[pn.Structure] + " fold"
					ui.Box(c).Size(340, 340).Radius(8).Border(1, t.Border).Role(ui.RoleImage).
						Label(fmt.Sprintf("%s, %s: %s, %s", regionName(k), title, panelPairsText(pn), panelOutsideText(pn))).
						Draw(func(pt *ui.Painter, rect ui.Rect) { fig.paint(pt, rect) })
					ui.Text(c, title+" · "+windowsText(pn.Windows)).Bold().FontSize(12.5)
					ui.Text(c, panelPairsText(pn)).FontSize(12).TextColor(t.TextMuted)
					ui.Text(c, panelOutsideText(pn)).FontSize(12).TextColor(t.TextMuted)
					if pn.NotDrawn > 0 {
						ui.Text(c, fmt.Sprintf("%d crossing pairs left out of the layout", pn.NotDrawn)).FontSize(11).TextColor(t.Warning)
					}
				})
			}
		})
	})
}

func (p *comparePage) energyCard(c *ui.Context, e *comparisonEntry, ctx cmpContext) {
	t := c.Theme()
	s := &p.panels
	labels := p.panelLabels(ctx)
	p.loadEnergy(e.ID)
	res := s.energy[e.ID]
	Card(c, "", func() {
		ui.Row(c).Gap(8).Children(func() {
			ui.Text(c, "Folding energy").FontSize(16).Bold().Grow(1)
			if res != nil && res.Summary != nil {
				if ui.Button(c, "Export SVG…").Tooltip("Save both violin plots").Clicked() {
					p.exportEnergySVG(ctx)
				}
				if ui.Button(c, "Export TSV…").Tooltip("Save every interaction's dG in both lineages").Clicked() {
					p.exportEnergyTSV(ctx)
				}
			}
		})
		ui.Text(c, fmt.Sprintf("Each merged interaction with padj below the cutoff: a fragment centred on each arm (bin start + 5, %s's reference), the two joined with & and folded with RNAcofold (ViennaRNA defaults, 37 °C), once with %s's sequence and once with %s's at the aligned positions. Paired t-test per direction.",
			labels[0], labels[0], labels[1])).FontSize(12).TextColor(t.TextMuted)
		running := cmpTaskRows(c, p.a, "energy")
		ui.Row(c).Gap(12).AlignItems(ui.End).Wrap().Children(func() {
			Field(c, "Fragment (nt)", func() {
				ui.NumberInput(c.Key("cmp-en-len"), &s.energyLen, 4, 400, 10).Label("Fragment length")
			})
			Field(c, "padj <", func() {
				ui.NumberInput(c.Key("cmp-en-padj"), &s.energyPadj, 1e-12, 1, 0.001).Label("Energy padj cutoff")
			})
			label := "Compute"
			if res != nil && res.Summary != nil {
				label = "Compute again"
			}
			if ui.PrimaryButton(c, label).Tooltip("Runs as a task (about 2 cofolds per interaction)").Disabled(running > 0).Clicked() {
				p.runEnergy(e, ctx)
			}
			if res != nil && len(res.Lengths) > 1 {
				options := make([]string, len(res.Lengths))
				for i, l := range res.Lengths {
					options[i] = fmt.Sprintf("%d nt", l)
				}
				current := fmt.Sprintf("%d nt", res.Length)
				Field(c, "Show", func() {
					ui.Select(c.Key("cmp-en-show"), &current, options).Width(100).Label("Fragment length shown").OnChange(func() {
						s.energyPick = current
						delete(s.energy, e.ID)
						p.loadEnergy(e.ID)
					})
				})
			}
		})
		if s.energyMsg != "" {
			ui.Text(c, s.energyMsg).TextColor(t.Danger)
		}
		if err := s.energyErr[e.ID]; err != "" {
			ui.Text(c, "Could not read the energies: "+ShortError(err)).TextColor(t.Danger)
			return
		}
		if res == nil {
			ui.Text(c, "Loading…").TextColor(t.TextMuted)
			return
		}
		if res.Summary == nil {
			if running == 0 {
				ui.Text(c, "Not computed for this test yet.").TextColor(t.TextMuted)
			}
			return
		}
		sum := res.Summary
		ui.Row(c).Gap(16).Wrap().AlignItems(ui.Start).Children(func() {
			for side := range 2 {
				stats := p.violinStats(e.ID, res, side)
				title, subtitle := energySideTitle(res, side, labels)
				st := sum.Sides[energySides[side]]
				ui.Column(c.Key(fmt.Sprintf("cmp-violin-%d", side))).Gap(4).Width(400).Children(func() {
					fig := energyFigure(stats, labels, title, subtitle, figPaletteOf(t), 400, 340)
					ui.Box(c).Size(400, 340).Radius(8).Border(1, t.Border).Role(ui.RoleImage).Label(title + "; " + subtitle).
						Draw(func(pt *ui.Painter, rect ui.Rect) { fig.paint(pt, rect) })
					ui.Text(c, fmt.Sprintf("mean dG %s %s · %s %s kcal/mol · t = %s", labels[0], formatFloat(st.MeanOne, "%.2f"),
						labels[1], formatFloat(st.MeanTwo, "%.2f"), formatFloat(st.T, "%.2f"))).FontSize(12).TextColor(t.TextMuted)
				})
			}
		})
		note := fmt.Sprintf("%s of %s interactions with padj < %g folded (%d ran off an end) · %d nt fragments · ViennaRNA %s",
			FormatNumber(int64(sum.Folded)), FormatNumber(int64(sum.Interactions)), sum.Parameters.Padj, sum.Skipped, sum.Parameters.Length, nameOr(sum.ViennaVersion, "?"))
		if sum.Alignment != nil {
			note += fmt.Sprintf(" · %s positions by alignment (%.1f%% identity)", labels[1], 100*sum.Alignment.Identity)
		}
		if f := sum.Files["tsv"]; f != "" {
			note += " · " + f
		}
		ui.Text(c, note).FontSize(11).TextColor(t.TextMuted)
	})
}

// violinStats are a side's violins, computed once per result.
func (p *comparePage) violinStats(id string, res *energyResult, side int) [2]violinStats {
	s := &p.panels
	key := fmt.Sprintf("%s/%d/%d", id, res.Length, side)
	if v, ok := s.violins[key]; ok {
		return v
	}
	if s.violins == nil {
		s.violins = map[string][2]violinStats{}
	}
	v := res.violins(side)
	s.violins[key] = v
	return v
}

// ---- exports

func (p *comparePage) exportRegionsSVG(ctx cmpContext) {
	s := &p.panels
	res := s.regions
	if res == nil {
		return
	}
	labels := p.panelLabels(ctx)
	title := labels[0] + " vs " + labels[1] + " · enriched regions"
	saveExport(p.a, "Export the enriched regions", exportName(".svg", labels[0], "vs", labels[1], "regions"), func() ([]byte, error) {
		return svgFile(regionsSVG(res, labels, title)), nil
	})
}

func (p *comparePage) exportRegionsTSV(ctx cmpContext) {
	res := p.panels.regions
	if res == nil {
		return
	}
	labels := p.panelLabels(ctx)
	comments := []string{"RNAxRay enriched regions · " + labels[0] + " vs " + labels[1] + " · test " + res.Comparison.ID,
		fmt.Sprintf("padj < %g · reach %d nt · flank %d nt · linker %d nt (layout only); x, y: RNAplot layout; partner: position paired inside the windows; outside: partner outside the windows",
			res.Parameters.Padj, res.Parameters.Reach, res.Parameters.Flank, res.Parameters.Linker)}
	render := func() ([]byte, error) {
		var rows [][]string
		for k, r := range res.Regions {
			c := r.chosen()
			for _, pn := range r.Panels {
				for i, pos := range pn.Pos {
					partner := ""
					if q := pn.Partner[i]; q >= 0 && q < len(pn.Pos) {
						partner = strconv.Itoa(pn.Pos[q])
					}
					outside := ""
					if pn.Outside[i] > 0 {
						outside = strconv.Itoa(pn.Outside[i])
					}
					rows = append(rows, []string{regionName(k), labels[r.Enriched], strconv.Itoa(c.Rank), labels[pn.Structure], pn.StructureID,
						string(rune('X' + pn.Window[i])), strconv.Itoa(pos), string(pn.Base[i]),
						strconv.FormatFloat(pn.X[i], 'f', 2, 64), strconv.FormatFloat(pn.Y[i], 'f', 2, 64), partner, outside})
				}
			}
		}
		header := []string{"region", "enriched_in", "rank", "fold", "structure_id", "window", "pos", "base", "x", "y", "partner", "outside"}
		return tsvTable{Comments: comments, Header: header, Rows: rows}.Bytes()
	}
	saveExport(p.a, "Export the enriched regions", exportName(".tsv", labels[0], "vs", labels[1], "regions"), render)
}

func (p *comparePage) exportEnergySVG(ctx cmpContext) {
	res := p.panels.energy[p.selectedID]
	if res == nil || res.Summary == nil {
		return
	}
	labels := p.panelLabels(ctx)
	title := fmt.Sprintf("%s vs %s · folding energy of enriched interactions (2 × %d nt)", labels[0], labels[1], res.Summary.Parameters.Length)
	saveExport(p.a, "Export the folding energies", exportName(".svg", labels[0], "vs", labels[1], fmt.Sprintf("energy_L%d", res.Length)), func() ([]byte, error) {
		return svgFile(energySVG(res, labels, title)), nil
	})
}

func (p *comparePage) exportEnergyTSV(ctx cmpContext) {
	res := p.panels.energy[p.selectedID]
	if res == nil || res.Summary == nil || res.Rows == nil {
		return
	}
	labels := p.panelLabels(ctx)
	sum := res.Summary
	comments := []string{fmt.Sprintf("RNAxRay folding energy · %s (one) vs %s (two) · test %s", labels[0], labels[1], sum.ComparisonID),
		fmt.Sprintf("RNAcofold (ViennaRNA %s) of 2 x %d nt centred on bin start + 5; padj < %g; dG in kcal/mol", nameOr(sum.ViennaVersion, "?"), sum.Parameters.Length, sum.Parameters.Padj)}
	for side := range 2 {
		st := sum.Sides[energySides[side]]
		comments = append(comments, fmt.Sprintf("%s: n = %d, mean dG_one %s, mean dG_two %s, paired t = %s, p = %s", energySides[side], st.N,
			formatFloat(st.MeanOne, "%.4f"), formatFloat(st.MeanTwo, "%.4f"), formatFloat(st.T, "%.6g"), formatFloat(st.P, "%.6g")))
	}
	rows := res.Rows
	render := func() ([]byte, error) {
		out := make([][]string, len(rows.Side))
		for k := range rows.Side {
			out[k] = []string{strconv.Itoa(res.Length), rows.Side[k], strconv.Itoa(rows.X[k]), strconv.Itoa(rows.Y[k]),
				tsvFloat(rows.LFC[k]), tsvFloat(rows.Padj[k]), tsvFloat(rows.DGOne[k]), tsvFloat(rows.DGTwo[k])}
		}
		return tsvTable{Comments: comments, Header: []string{"length", "side", "x", "y", "log2FoldChange", "padj", "dG_one", "dG_two"}, Rows: out}.Bytes()
	}
	saveExport(p.a, "Export the folding energies", exportName(".tsv", labels[0], "vs", labels[1], fmt.Sprintf("energy_L%d", res.Length)), render)
}
