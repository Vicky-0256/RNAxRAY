package views

// ② QC: per-sample counts from the analysis indexes (one analysis_summary
// call for all analysed samples, as HD.loadStats does), with the replicates
// of each condition merged below them. The counts are also what the Data
// page's "Hybrids" column shows.

import (
	"fmt"
	"sort"
	"strings"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
)

func init() {
	RegisterPageFactory("qc", func(a *App) Page { return &qcPage{a: a, stats: map[string]qcStats{}} })
	// A finished run changes a sample's index: load the counts again.
	OnTaskFinished(func(a *App, t model.Task) {
		if t.Kind != "sample_pipeline" && t.Kind != "analysis_index" {
			return
		}
		if q := qcFor(a); q != nil {
			q.loadedKey = ""
		}
	})
}

// qcStats is one index's part of analysis_summary (or a merged sum).
type qcStats struct {
	Records int64     `json:"records"`
	Reads   int64     `json:"reads"`
	WithDG  int64     `json:"with_dg"`
	Intra   int64     `json:"intra_records"`
	Inter   int64     `json:"inter_records"`
	Types   []qcCount `json:"types"`
}

type qcCount struct {
	Name    string `json:"name"`
	Records int64  `json:"records"`
}

func (s qcStats) typeRecords(name string) int64 {
	for _, t := range s.Types {
		if t.Name == name {
			return t.Records
		}
	}
	return 0
}

// qcMerge sums the counts of replicates (what analysis_summary's "merged"
// reports for the same indexes).
func qcMerge(parts []qcStats) qcStats {
	var out qcStats
	index := map[string]int{}
	for _, p := range parts {
		out.Records += p.Records
		out.Reads += p.Reads
		out.WithDG += p.WithDG
		out.Intra += p.Intra
		out.Inter += p.Inter
		for _, t := range p.Types {
			i, ok := index[t.Name]
			if !ok {
				i = len(out.Types)
				index[t.Name] = i
				out.Types = append(out.Types, qcCount{Name: t.Name})
			}
			out.Types[i].Records += t.Records
		}
	}
	return out
}

type qcRow struct {
	header string // section title, or "" for a data row
	sample string // sample id
	cond   string // condition name (merged row)
}

type qcPage struct {
	a *App
	// stats by sample id; loadedKey is the project path and the ready ids
	// they were loaded for.
	stats     map[string]qcStats
	loadedKey string
	loading   bool
	err       string
	table     ui.ListState
}

func qcFor(a *App) *qcPage {
	q, _ := a.pages["qc"].(*qcPage)
	return q
}

func qcReadyIDs(a *App) []string {
	var ids []string
	if a.Project != nil {
		for _, s := range a.Project.Samples {
			if s.IsReady() {
				ids = append(ids, s.ID)
			}
		}
	}
	return ids
}

func (p *qcPage) Show() { p.ensureStats() }

// ensureStats loads the counts once per project and set of analysed
// samples; it is a guarded job, safe to call from View.
func (p *qcPage) ensureStats() {
	a := p.a
	if a.Project == nil || p.loading {
		return
	}
	ids := qcReadyIDs(a)
	key := a.Project.Path + "|" + strings.Join(ids, ",")
	if key == p.loadedKey {
		return
	}
	if p.loadedKey != "" && !strings.HasPrefix(p.loadedKey, a.Project.Path+"|") {
		p.stats = map[string]qcStats{} // another project
	}
	if len(ids) == 0 {
		p.loadedKey, p.err = key, ""
		return
	}
	p.loading, p.err = true, ""
	path := a.Project.Path
	a.Go(func() func() {
		result, err := a.B.Query(path, "analysis_summary", core.Obj{"sample_ids": ids})
		var parts []qcStats
		if err == nil {
			object, _ := result.(map[string]any)
			err = model.Decode(object["indexes"], &parts)
		}
		return func() {
			p.loading = false
			if a.Project == nil || a.Project.Path != path {
				return
			}
			p.loadedKey = key
			if err != nil {
				p.err = err.Error()
				return
			}
			for i, part := range parts {
				if i < len(ids) {
					p.stats[ids[i]] = part
				}
			}
		}
	})
}

func (p *qcPage) refresh() {
	p.stats = map[string]qcStats{}
	p.loadedKey = ""
	p.ensureStats()
}

func (p *qcPage) View(c *ui.Context) {
	a := p.a
	t := c.Theme()
	p.ensureStats()
	ready := qcReadyIDs(a)
	ui.Column(c).Fill().MinWidth(0).Padding(24).Gap(16).Children(func() {
		ui.Row(c).Gap(12).Children(func() {
			ui.Column(c).Grow(1).Shrink(1).MinWidth(0).Children(func() {
				PageHeader(c, "Quality control", "Analysed samples: library size and chimera composition.")
			})
			if len(ready) > 0 {
				if ui.Button(c, "Refresh").Disabled(p.loading).Clicked() {
					p.refresh()
				}
			}
		})
		if len(ready) == 0 {
			Card(c, "", func() {
				ui.Text(c, "No analysed samples yet.")
				ui.Text(c, "Run the samples on the Data page; their counts appear here.").TextColor(t.TextMuted)
				ui.Row(c).Children(func() {
					if ui.PrimaryButton(c, "Go to Data").Clicked() {
						a.Navigate("data", nil)
					}
				})
			})
			return
		}
		if p.err != "" {
			notice(c, noticeError, func() {
				ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
					ui.Text(c, "Could not load the counts: "+ShortError(p.err)).TextColor(t.Danger).Grow(1).Shrink(1).MinWidth(0)
					if ui.Button(c, "Retry").Clicked() {
						p.refresh()
					}
				})
			})
		}
		if p.loading && len(p.stats) == 0 {
			ui.Row(c).Gap(8).Children(func() {
				ui.Spinner(c)
				ui.Text(c, "Loading counts…").TextColor(t.TextMuted)
			})
		}
		Card(c, "Per-sample summary", func() {
			p.summaryTable(c, ready)
			ui.Text(c, "Percentages are of hybrids. Merged rows add up the analysed replicates of each condition.").
				FontSize(12).TextColor(t.TextMuted)
		}).Grow(1).MinWidth(0)
	})
}

// qcTypeNames: the four most common hybrid types over the samples, largest
// first (ties in the order met).
func (p *qcPage) qcTypeNames(ready []string) []string {
	var names []string
	total := map[string]int64{}
	for _, id := range ready {
		for _, t := range p.stats[id].Types {
			if _, seen := total[t.Name]; !seen {
				names = append(names, t.Name)
			}
			total[t.Name] += t.Records
		}
	}
	sort.SliceStable(names, func(i, j int) bool { return total[names[i]] > total[names[j]] })
	if len(names) > 4 {
		names = names[:4]
	}
	return names
}

func (p *qcPage) rows(ready []string) []qcRow {
	a := p.a
	rows := []qcRow{{header: "Samples"}}
	for _, id := range ready {
		rows = append(rows, qcRow{sample: id})
	}
	var conds []qcRow
	for _, cond := range a.Project.Conditions {
		if len(a.SelectionIDs("c:"+cond.Name)) > 0 {
			conds = append(conds, qcRow{cond: cond.Name})
		}
	}
	if len(conds) > 0 {
		rows = append(rows, qcRow{header: "Conditions (replicates merged)"})
		rows = append(rows, conds...)
	}
	return rows
}

// statsFor returns a row's counts; ok is false while any part is missing.
func (p *qcPage) statsFor(r qcRow) (qcStats, bool) {
	if r.sample != "" {
		s, ok := p.stats[r.sample]
		return s, ok
	}
	var parts []qcStats
	for _, id := range p.a.SelectionIDs("c:" + r.cond) {
		s, ok := p.stats[id]
		if !ok {
			return qcStats{}, false
		}
		parts = append(parts, s)
	}
	return qcMerge(parts), len(parts) > 0
}

func qcPercent(part, total int64) string {
	if total == 0 {
		return "—"
	}
	return fmt.Sprintf("%.1f%%", 100*float64(part)/float64(total))
}

func (p *qcPage) summaryTable(c *ui.Context, ready []string) {
	types := p.qcTypeNames(ready)
	rows := p.rows(ready)
	cols := []ui.TableColumn{
		{Title: "Sample", MinWidth: 110},
		{Title: "Hybrids", Width: 128, Align: ui.End},
		{Title: "Reads", Width: 84, Align: ui.End},
		{Title: "Reads / hybrid", Width: 112, Align: ui.End},
		{Title: "With ΔG", Width: 76, Align: ui.End},
		{Title: "Intra", Width: 72, Align: ui.End},
		{Title: "Inter", Width: 64, Align: ui.End},
	}
	for _, name := range types {
		cols = append(cols, qcTableColumn(name))
	}
	// The inline bar is scaled within each section (merged rows are sums).
	maxSample, maxCond := int64(1), int64(1)
	for _, r := range rows {
		s, ok := p.statsFor(r)
		switch {
		case !ok || r.header != "":
		case r.sample != "" && s.Records > maxSample:
			maxSample = s.Records
		case r.cond != "" && s.Records > maxCond:
			maxCond = s.Records
		}
	}
	p.table.Key = func(i int) any {
		r := rows[i]
		return r.header + "|" + r.sample + "|" + r.cond
	}
	p.table.Header = func(i int) bool { return rows[i].header != "" }
	p.table.Label = func(i int) string {
		if r := rows[i]; r.cond != "" {
			return r.cond
		}
		return rows[i].header + rows[i].sample
	}
	// The scroller keeps the columns' widths out of the page's minimum
	// width: a narrow window scrolls the table, not the page.
	ui.ScrollHorizontal(c).AlignItems(ui.Stretch).Grow(1).MinHeight(160).Children(func() { p.summaryRows(c, cols, rows, types, maxSample, maxCond) })
}

func (p *qcPage) summaryRows(c *ui.Context, cols []ui.TableColumn, rows []qcRow, types []string, maxSample, maxCond int64) {
	a := p.a
	t := c.Theme()
	ui.Table(c, &p.table, cols, len(rows), func(row, col int) {
		r := rows[row]
		if r.header != "" {
			ui.Text(c, r.header).Bold().FontSize(ts(c, 12)).TextColor(t.TextMuted).SingleLine()
			return
		}
		var sample *model.Sample
		if r.sample != "" {
			sample = a.Project.Sample(r.sample)
		}
		s, ok := p.statsFor(r)
		switch col {
		case 0:
			ui.Column(c).Gap(2).MinWidth(0).Children(func() {
				if sample != nil {
					id := sample.ID
					if brandLink(c, sample.Label()).Label("Explore " + sample.Label()).Tooltip("Select and explore").Clicked() {
						a.Selected.Key = "s:" + id
						a.Navigate("explore", nil)
					}
					detail := nameOr(sample.Condition, "no condition")
					if sample.Replicate != nil {
						detail += " · rep " + dataReplicate(sample.Replicate)
					}
					ui.Text(c, detail).FontSize(ts(c, 11)).TextColor(t.TextMuted).SingleLine()
				} else {
					ui.Text(c, r.cond).Bold().SingleLine()
					ui.Text(c, dataPlural(len(a.SelectionIDs("c:"+r.cond)), "replicate", "replicates")).FontSize(ts(c, 11)).TextColor(t.TextMuted).SingleLine()
				}
			})
		case 1:
			if !ok {
				label := "—"
				if p.loading {
					label = "loading…"
				}
				ui.Text(c, label).TextColor(t.TextMuted)
				return
			}
			scale := maxSample
			if r.cond != "" {
				scale = maxCond
			}
			width := float32(48 * float64(s.Records) / float64(scale))
			if width < 2 {
				width = 2
			}
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				ui.Row(c).Width(width).Height(8).Radius(2).Background(t.Accent.Alpha(0.7))
				ui.Text(c, FormatNumber(s.Records)).SingleLine()
			})
		default:
			if !ok {
				ui.Text(c, "—").TextColor(t.TextMuted)
				return
			}
			ui.Text(c, qcCell(s, col, types)).SingleLine()
		}
	}).Width(dataColumnsWidth(cols)).Grow(1)
}

func qcTableColumn(name string) ui.TableColumn {
	return ui.TableColumn{Title: strings.ReplaceAll(name, "_", " "), ID: "type:" + name, Width: 64, Align: ui.End}
}

// The columns after Sample and Hybrids, in qcCell's numbering.
const (
	qcColReads = 2 + iota
	qcColPerHybrid
	qcColDG
	qcColIntra
	qcColInter
	qcColTypes
)

func qcCell(s qcStats, col int, types []string) string {
	switch col {
	case qcColReads:
		return FormatNumber(s.Reads)
	case qcColPerHybrid:
		if s.Records == 0 {
			return "—"
		}
		return fmt.Sprintf("%.2f", float64(s.Reads)/float64(s.Records))
	case qcColDG:
		return qcPercent(s.WithDG, s.Records)
	case qcColIntra:
		return qcPercent(s.Intra, s.Records)
	case qcColInter:
		return qcPercent(s.Inter, s.Records)
	}
	if i := col - qcColTypes; i >= 0 && i < len(types) {
		return qcPercent(s.typeRecords(types[i]), s.Records)
	}
	return ""
}
