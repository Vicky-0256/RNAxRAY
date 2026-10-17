package views

import (
	"fmt"
	"strings"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
	"rnaxraydesktop/widgets"
)

// Viewpoint: interaction coverage along the selected gene and its partners
// (analysis_viewpoint, computed by the backend over all hybrids).

var resolutions = []string{"1 nt", "5 nt", "10 nt", "25 nt", "50 nt", "100 nt"}

type partnerTotal struct {
	Name    string `json:"name"`
	Records int64  `json:"records"`
	Reads   int64  `json:"reads"`
}

type viewpointState struct {
	partner, typ, measure, resolution string
	start, end                        string // inputs
	from, to                          int    // applied (0 = default)
	inputErr                          string

	load    loader
	data    *viewpointData
	profile *widgets.Profile
	hover   int
}

type viewpointData struct {
	gene           string
	start, end     int
	bin, requested int
	adjusted       bool
	measure        string
	records, reads int64
	arms           int64
	partners       []partnerTotal
}

func (s *viewpointState) init() {
	s.partner, s.typ, s.measure, s.resolution = allPartners, allTypes, measureRecords, "10 nt"
	s.profile = widgets.NewProfile()
	s.hover = -1
}

func (s *viewpointState) selectionChanged() {
	s.profile.Picked = -1
}

func (p *explorePage) viewpointKey() string {
	s := &p.vp
	return strings.Join([]string{p.sel, s.partner, s.typ, s.measure, s.resolution, fmt.Sprint(s.from, "-", s.to)}, "\x00")
}

func (p *explorePage) loadViewpoint() {
	s := &p.vp
	path, ids, gene := p.a.Project.Path, p.ids, p.gene
	partner, typ, measure, resolution, from, to := s.partner, s.typ, s.measure, s.resolution, s.from, s.to
	p.ensure(&s.load, p.viewpointKey(), func() (func(), error) {
		var bin int
		fmt.Sscanf(resolution, "%d", &bin)
		payload := core.Obj{"gene": gene, "bin_size": max(bin, 1), "measure": "records"}
		if measure == measureReads {
			payload["measure"] = "reads"
		}
		if partner != allPartners {
			payload["partner"] = partner
		}
		if types := typesPayload(typ); types != nil {
			payload["types"] = types
		}
		if from > 0 {
			payload["start"] = from
		}
		if to > 0 {
			payload["end"] = to
		}
		got, err := p.query(path, "analysis_viewpoint", ids, payload)
		if err != nil {
			return nil, err
		}
		d := &viewpointData{gene: gene, start: int(num(got["start"])), end: int(num(got["end"])),
			bin: int(num(got["bin_size"])), requested: int(num(got["requested_bin_size"])), adjusted: got["adjusted"] == true,
			measure: measure, records: int64(num(got["records"])), reads: int64(num(got["reads"])), arms: int64(num(got["arms"]))}
		_ = model.Decode(got["partners"], &d.partners)
		bins, _ := got["bins"].(map[string]any)
		starts, ends, values := ints(bins["start"]), ints(bins["end"]), floats(bins["value"])
		return func() {
			s.data = d
			s.profile.Set(starts, ends, values)
		}, nil
	})
}

func (p *explorePage) viewpointView(c *ui.Context) {
	s := &p.vp
	t := c.Theme()
	p.loadViewpoint()
	submit := func() {
		from, ok1 := parseCoord(s.start)
		to, ok2 := parseCoord(s.end)
		if !ok1 || !ok2 || (to > 0 && from > to) {
			s.inputErr = "Start and end must be positions, start not after end."
			return
		}
		s.inputErr, s.from, s.to = "", from, to
	}
	ui.Scroll(c).Grow(1).Children(func() {
		ui.Column(c).Gap(14).Children(func() {
			ui.Row(c).Gap(12).Wrap().AlignItems(ui.End).Children(func() {
				picker(c, "vp-partner", "Partner", &s.partner, withAll(allPartners, p.genes()), 190)
				picker(c, "vp-type", "Chimera type", &s.typ, withAll(allTypes, p.summary.types), 130)
				picker(c, "vp-measure", "Measure", &s.measure, measures, 110)
				picker(c, "vp-resolution", "Resolution", &s.resolution, resolutions, 90)
				coordInput(c, "vp-start", "Start", &s.start, "observed").OnSubmit(submit)
				coordInput(c, "vp-end", "End", &s.end, "gene end").OnSubmit(submit)
				if ui.PrimaryButton(c, "Apply").Clicked() {
					submit()
				}
			})
			if s.inputErr != "" {
				errorLine(c, s.inputErr)
			}
			loadingLine(c, &s.load, "the viewpoint")
			d := s.data
			if d == nil {
				return
			}
			if d.adjusted {
				notice(c, fmt.Sprintf("The resolution was increased to %d nt so the plot has at most 30,000 bins.", d.bin))
			}
			Card(c, "", func() {
				ui.Row(c).Gap(24).Wrap().Children(func() {
					ui.Column(c).Grow(1).Gap(2).Children(func() {
						ui.Text(c, "Interaction coverage").FontSize(16).Bold()
						what := "records"
						if d.measure == measureReads {
							what = "reads"
						}
						ui.Text(c, fmt.Sprintf("%s · %s nt · mean %s per nucleotide in %d nt bins.", d.gene, span(d.start, d.end), what, d.bin)).
							FontSize(12).TextColor(t.TextMuted)
					})
					stat(c, "Hybrids", FormatNumber(d.records))
					stat(c, "Reads", FormatNumber(d.reads))
					stat(c, "Arms", FormatNumber(d.arms))
				})
				_, height := p.a.ContentSize()
				ev := s.profile.Show(c, clampF(height*0.42, 180, 520), "Viewpoint coverage of "+d.gene, profileColor(t))
				s.hover = ev.Hover
				readout := "Hover the plot for a bin's coverage; click to choose it."
				if i := s.hover; i >= 0 && i < s.profile.Len() {
					start, end, v := s.profile.Bin(i)
					readout = fmt.Sprintf("%s · mean %s", span(start, end), trimFloat(v))
				}
				ui.Text(c, readout).FontSize(12).TextColor(t.TextMuted)
			})
			ui.Row(c).Gap(16).AlignItems(ui.Start).Wrap().Children(func() {
				Card(c, "Selected interval", func() {
					i := s.profile.Picked
					if i < 0 || i >= s.profile.Len() {
						ui.Text(c, "Click a bin of the plot to explore its region.").TextColor(t.TextMuted)
						return
					}
					start, end, v := s.profile.Bin(i)
					ui.Text(c, shortGene(d.gene)+":"+span(start, end)).Bold()
					ui.Text(c, "Mean coverage "+trimFloat(v)).TextColor(t.TextMuted)
					if ui.PrimaryButton(c, "Explore region").Clicked() {
						p.exploreRegion(start, end)
					}
				}).Width(280)
				partnerCard(c, "Partners in range", d.partners, d.measure == measureReads).Grow(1).Basis(320)
			})
		})
	})
}

// exploreRegion opens Region on gene:[start, end], widened to 20 nt at least.
func (p *explorePage) exploreRegion(start, end int) {
	if end-start+1 < 20 {
		mid := (start + end) / 2
		start, end = max(1, mid-10), mid+9
	}
	p.rg.applyRange(start, end)
	p.tab = tabRegion
}

// partnerCard shows partner genes with bars (the top eight).
func partnerCard(c *ui.Context, title string, partners []partnerTotal, byReads bool) ui.Element {
	t := c.Theme()
	return Card(c, title, func() {
		if len(partners) == 0 {
			ui.Text(c, "No partners.").TextColor(t.TextMuted)
			return
		}
		value := func(pt partnerTotal) int64 {
			if byReads {
				return pt.Reads
			}
			return pt.Records
		}
		top := value(partners[0])
		for _, pt := range partners {
			top = max(top, value(pt))
		}
		for i, pt := range partners {
			if i == 8 {
				ui.Text(c, fmt.Sprintf("and %d more", len(partners)-8)).FontSize(12).TextColor(t.TextMuted)
				break
			}
			ui.Row(c.Key(pt.Name)).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, shortGene(pt.Name)).Width(170).SingleLine().Tooltip(pt.Name)
				fraction := float32(1)
				if top > 0 {
					fraction = max(float32(value(pt))/float32(top), 0.02)
				}
				ui.Box(c).Grow(1).Height(8).Radius(4).Background(t.Border).Children(func() {
					ui.Box(c).WidthPercent(fraction * 100).FillHeight().Radius(4).Background(t.Accent)
				})
				ui.Text(c, FormatNumber(pt.Records)+" hybrids · "+FormatNumber(pt.Reads)+" reads").FontSize(12).
					TextColor(t.TextMuted).Width(170).TextAlign(ui.End)
			})
		}
	})
}

func trimFloat(v float64) string {
	s := fmt.Sprintf("%.2f", v)
	s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	return s
}
