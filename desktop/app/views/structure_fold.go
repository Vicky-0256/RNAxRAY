package views

// ⑤ Structure, the New fold task: what to fold (input), how (advanced
// settings, folded away but always summarised), a check of the fold before
// it runs (what, evidence, time, memory and its limits, with every reason
// it cannot run yet), its status in place (queued, running, done, failed
// with an explanation and a next step, cancelled, interrupted), and the
// results with their numbers and units. The viewer is in structure.go.

import (
	"fmt"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
)

const (
	stDefaultAlpha = 0.5
	stDefaultBeam  = 100
)

// foldPlan is the fold the form describes, checked.
type foldPlan struct {
	gene     string
	length   int
	evidence string // its label
	ids      []string
	windows  []core.Window
	lengths  []int
	pk       bool
	// problems are why it cannot run yet, each with what to do.
	problems []string
	// limits are what the result will and will not show.
	limits []string
	req    core.TaskStartRequest
	memMB  uint64
	what   string // "whole RNA" | "2 windows"
	// maxNT is the longest fold the memory tasks may use allows (0 while
	// the budget is unknown), with parallel folds sharing it; longest is
	// the longest fold the form asks for.
	maxNT, parallel, longest int
}

// plan checks the form. Memory is checked against the task budget once it
// is known (askWorkers reads it with the CPU budget).
func (p *structurePage) plan() foldPlan {
	a := p.a
	pl := foldPlan{gene: p.gene, length: a.Project.GeneLength(p.gene), ids: a.SelectionIDs(p.evidence),
		evidence: a.SelectionLabel(p.evidence), what: "whole RNA"}
	switch {
	case pl.gene == "" || pl.length == 0:
		pl.problems = append(pl.problems, "Choose the RNA to fold.")
	case len(a.SelectionOptions()) == 0:
		pl.problems = append(pl.problems, "No sample has been analysed yet: run the pipeline on the Data page first, then come back.")
	case len(pl.ids) == 0:
		pl.problems = append(pl.problems, "Choose the samples whose chimeric reads guide the fold.")
	default:
		if msg := p.evidenceMismatch(); msg != "" {
			pl.problems = append(pl.problems, msg)
		}
	}
	params := map[string]any{"alpha": p.alpha, "beam": int(p.beam), "allow_pseudoknot": false}
	mode := p.mode
	pl.req = core.TaskStartRequest{Kind: "structure", SampleIDs: pl.ids, GeneID: &pl.gene, Mode: &mode, Parameters: params}
	workers := uint32(max(int(p.workers), 1))
	pl.req.Workers = &workers
	if p.mode == "windows" {
		windows, errs := stParseWindows(p.windows, pl.length)
		for _, e := range errs {
			pl.problems = append(pl.problems, e+" (windows are start-end, at least 20 nt).")
		}
		if len(errs) == 0 && len(windows) == 0 && pl.length > 0 {
			pl.problems = append(pl.problems, fmt.Sprintf("Add at least one window, one per line as start-end within 1-%s.", FormatNumber(int64(pl.length))))
		}
		pl.windows, pl.pk = windows, p.pseudoknot
		pl.req.Windows = windows
		params["allow_pseudoknot"] = p.pseudoknot
		for _, w := range windows {
			pl.lengths = append(pl.lengths, int(w.End-w.Start+1))
		}
		pl.what = fmt.Sprintf("%d window%s", len(windows), plural(len(windows)))
		pl.limits = append(pl.limits, "Each window is folded on its own: no pair joins two windows or leaves a window.")
		if !p.pseudoknot {
			pl.limits = append(pl.limits, "Pseudoknots are off: crossing pairs are not predicted.")
		}
	} else if pl.length > 0 {
		pl.lengths = []int{pl.length}
		pl.limits = append(pl.limits, "Whole-RNA folds cannot contain pseudoknots; fold windows to allow them.")
	}
	pl.limits = append(pl.limits, "Only chimeras with both arms inside the folded region are used as evidence.")
	pl.parallel = 1
	if p.mode == "windows" && len(pl.windows) > 0 {
		pl.parallel = max(min(int(workers), len(pl.windows)), 1)
	}
	for _, n := range pl.lengths {
		pl.longest = max(pl.longest, n)
	}
	if p.budgetMB > 0 {
		pl.maxNT = core.CPLfoldMaxNT(p.budgetMB/uint64(pl.parallel), pl.pk)
	}
	if len(pl.lengths) > 0 {
		pl.memMB = StructureMemClaim(pl.req, pl.length, pl.pk)
		pl.req.MemMB = &pl.memMB
		if p.budgetMB > 0 && pl.memMB > p.budgetMB {
			pl.problems = append(pl.problems, fmt.Sprintf("This fold needs about %.1f GB of memory but tasks may use %.1f GB. "+
				"Fold shorter windows, fewer windows at once (Advanced), or raise Memory in Preferences.",
				float64(pl.memMB)/1024, float64(p.budgetMB)/1024))
		}
	}
	return pl
}

// span of the folded region: "10,807 nt" or "3,000 + 400 nt".
func (pl foldPlan) span() string {
	parts := make([]string, len(pl.lengths))
	total := 0
	for i, n := range pl.lengths {
		parts[i] = FormatNumber(int64(n))
		total += n
	}
	if len(parts) > 4 {
		return FormatNumber(int64(total)) + " nt in all"
	}
	return strings.Join(parts, " + ") + " nt"
}

// ---- the form

func (p *structurePage) form(c *ui.Context) {
	t := c.Theme()
	pl := p.plan()
	card := Card(c, "New fold", func() {
		if p.prefillNote != "" {
			ui.Text(c, p.prefillNote).FontSize(ts(c, 12)).Padding(8).Radius(6).Background(t.Accent.Alpha(0.10))
		}
		p.inputs(c, pl)
		p.advanced(c)
	})
	// Cmd+Enter (Ctrl+Enter) runs the fold from anywhere in the form.
	card.OnShortcut(ui.Cmd, ui.KeyEnter, func() {
		if len(p.plan().problems) == 0 {
			p.runFold()
		}
	})
}

// runPanel: the check before running, Run fold and the status of the fold
// started here, pinned below the scrolling form so they stay in view.
func (p *structurePage) runPanel(c *ui.Context) {
	t := c.Theme()
	pl := p.plan()
	// At most about half the page, so the form and results keep room; a
	// longer check (a failure explained) scrolls inside.
	_, height := p.a.ContentSize()
	ui.Scroll(c.Key("st-run")).MaxHeight(clampF(height*0.55, 260, 560)).Margin(0, 14, 0, 0).Radius(10).
		Background(t.Background).Border(1, t.Border).Children(func() {
		ui.Column(c).Gap(8).Padding(12).Children(func() {
			p.check(c, pl)
			p.status(c)
		})
	})
}

// inputs: the RNA, the evidence and the mode.
func (p *structurePage) inputs(c *ui.Context, pl foldPlan) {
	a := p.a
	t := c.Theme()
	var geneLabels []string
	names := map[string]string{}
	current := ""
	for _, r := range a.Project.References {
		for _, s := range r.Sequences {
			label := s.Name + " · " + FormatNumber(int64(s.Length)) + " nt"
			if _, seen := names[label]; seen {
				continue
			}
			geneLabels = append(geneLabels, label)
			names[label] = s.Name
			if s.Name == p.gene {
				current = label
			}
		}
	}
	Field(c, "1  RNA to fold", func() {
		ui.Select(c.Key("st-gene"), &current, geneLabels).FillWidth().Label("RNA to fold").Tooltip(current).
			OnChange(func() { p.gene = names[current] })
		if pl.length > 0 {
			// The full name, which the select may cut.
			ui.Text(c, p.gene+" · "+FormatNumber(int64(pl.length))+" nt").FontSize(ts(c, 12)).TextColor(t.TextMuted)
		}
	})
	options := a.SelectionOptions()
	var evLabels []string
	keys := map[string]string{}
	currentEv := ""
	for _, o := range options {
		evLabels = append(evLabels, o.Label)
		keys[o.Label] = o.Key
		if o.Key == p.evidence {
			currentEv = o.Label
		}
	}
	Field(c, "2  Evidence: chimeric reads of", func() {
		if len(evLabels) == 0 {
			ui.Text(c, "No analysed samples yet. Run the pipeline on the Data page; analysed samples and conditions appear here.").
				FontSize(12).TextColor(t.TextMuted)
			return
		}
		ui.Select(c.Key("st-evidence"), &currentEv, evLabels).FillWidth().Label("Evidence").
			OnChange(func() { p.evidence = keys[currentEv] })
		if len(pl.ids) > 0 {
			ui.Text(c, "Samples: "+p.sampleNames(pl.ids)).FontSize(ts(c, 12)).TextColor(t.TextMuted)
		}
	})
	Field(c, "3  What to fold", func() {
		ui.RadioGroup(c.Key("st-mode"), func() {
			ui.Radio(c, &p.mode, "genome", "The whole RNA (no pseudoknots)")
			ui.Radio(c, &p.mode, "windows", "Regions (windows), pseudoknots possible")
		}).Label("What to fold")
		ui.Text(c, stLimitText(pl)).FontSize(ts(c, 12)).TextColor(t.TextMuted)
		if p.mode != "windows" {
			p.overLimit(c, pl)
		}
	})
	if p.mode == "windows" {
		Field(c, "Windows: start-end, one per line (1-based, inclusive)", func() {
			ui.TextArea(c.Key("st-windows"), &p.windows).Lines(3, 8).Font("monospace").
				Placeholder("e.g.\n1-400\n2300-2700").Label("Windows")
			if len(pl.lengths) > 0 {
				ui.Text(c, pl.what+": "+pl.span()).FontSize(ts(c, 12)).TextColor(t.TextMuted)
			}
			p.overLimit(c, pl)
		})
		ui.Checkbox(c.Key("st-pk"), &p.pseudoknot, "Allow pseudoknots in the windows")
	}
}

// stLimitText: the native CPLfold limit with the memory tasks may use.
// Desktop folds natively, so there is no capacity test as in the browser.
func stLimitText(pl foldPlan) string {
	if pl.maxNT == 0 {
		return "Native CPLfold on this computer · no capacity test"
	}
	text := "Native CPLfold · up to " + FormatNumber(int64(pl.maxNT)) + " nt per fold"
	if pl.pk {
		text += " with pseudoknots"
	}
	if pl.parallel > 1 {
		text += fmt.Sprintf(", %d windows at once", pl.parallel)
	}
	return text + " in the memory tasks may use · no capacity test"
}

// overLimit says at the field when the fold asked for is longer than the
// limit, and what to do; Check before running gives the memory figures.
func (p *structurePage) overLimit(c *ui.Context, pl foldPlan) {
	if pl.maxNT == 0 || pl.longest <= pl.maxNT {
		return
	}
	what := "This RNA (" + FormatNumber(int64(pl.longest)) + " nt) is longer: fold windows of at most "
	if p.mode == "windows" {
		what = "The longest window (" + FormatNumber(int64(pl.longest)) + " nt) is longer: fold windows of at most "
	}
	next := FormatNumber(int64(pl.maxNT)) + " nt, or raise Memory in Preferences."
	if pl.parallel > 1 {
		next = FormatNumber(int64(pl.maxNT)) + " nt, fewer windows at once (Advanced), or raise Memory in Preferences."
	}
	ui.Text(c, what+next).FontSize(ts(c, 12)).TextColor(c.Theme().Danger)
}

// advanced: alpha, beam and parallel windows, folded away. Their values
// stay visible in the summary line, flagged when changed.
func (p *structurePage) advanced(c *ui.Context) {
	t := c.Theme()
	changed := p.alpha != stDefaultAlpha || int(p.beam) != stDefaultBeam
	summary := fmt.Sprintf("Evidence weight %.2f · beam %d", p.alpha, int(p.beam))
	if p.mode == "windows" {
		summary += fmt.Sprintf(" · %d window%s at once", int(p.workers), plural(int(p.workers)))
	}
	if changed {
		summary += " · changed from the defaults"
	} else {
		summary += " · defaults"
	}
	ui.Collapsible(c.Key("st-advanced"), "Advanced settings", &p.advancedOpen, func() {
		ui.Column(c).Gap(10).Padding(6, 0, 0, 0).Children(func() {
			row := func(key, label string, value *float64, lo, hi, step float64, help string) {
				ui.Column(c).Gap(2).Children(func() {
					ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
						ui.Text(c, label).FontSize(ts(c, 12)).Bold().Width(150)
						ui.NumberInput(c.Key(key), value, lo, hi, step).Grow(1).Label(label)
					})
					ui.Text(c, help).FontSize(ts(c, 12)).TextColor(t.TextMuted)
				})
			}
			row("st-alpha", "Evidence weight (alpha)", &p.alpha, 0, 1, 0.05,
				"How strongly chimeric reads pull bases together, 0 to 1. 0 ignores them (energy only). Default 0.5.")
			row("st-beam", "Beam size", &p.beam, 1, 1000, 10,
				"How many partial structures CPLfold keeps per position. Larger is slower. Default 100.")
			if p.mode == "windows" {
				row("st-workers", "Windows at once", &p.workers, 1, 256, 1,
					"Windows folded in parallel; each needs its own memory. Default: your CPU budget.")
			}
			if ui.Button(c, "Reset to defaults").Disabled(!changed).Clicked() {
				p.alpha, p.beam = stDefaultAlpha, stDefaultBeam
			}
		})
	})
	// The values in use, also while the settings are folded away.
	color := t.TextMuted
	if changed {
		color = t.Warning
	}
	ui.Text(c, summary).FontSize(ts(c, 12)).TextColor(color)
}

// check: the fold to run, its cost and limits, and Run fold — disabled,
// with the reasons, until it can run.
func (p *structurePage) check(c *ui.Context, pl foldPlan) {
	t := c.Theme()
	p.estimate(pl)
	ui.Column(c.Key("st-check")).Gap(6).Children(func() {
		ui.Text(c, "Check before running").Bold()
		line := func(label, value string) {
			ui.Row(c).Gap(8).Children(func() {
				ui.Text(c, label).FontSize(ts(c, 12)).TextColor(t.TextMuted).Width(70)
				ui.Text(c, value).FontSize(ts(c, 12)).Grow(1).Shrink(1).MinWidth(0)
			})
		}
		if pl.length > 0 {
			what := pl.what + ", " + pl.span()
			if pl.what == "whole RNA" {
				what = "the whole RNA, " + pl.span()
			} else if pl.pk {
				what += ", pseudoknots allowed"
			}
			line("Fold", what)
		}
		if len(pl.ids) > 0 {
			line("Evidence", pl.evidence)
		}
		if p.est != nil {
			time := "about " + FormatDuration(p.est.Seconds) + " (measured on this computer)"
			if !p.est.Measured {
				time = "about " + FormatDuration(p.est.Seconds) + " (rough; the first fold after installing also " +
					"prepares the folding engine, about 1 min more)"
			}
			line("Time", time)
		}
		if pl.memMB > 0 {
			mem := fmt.Sprintf("about %.1f GB", float64(pl.memMB)/1024)
			if p.budgetMB > 0 {
				mem += fmt.Sprintf(" of the %.1f GB tasks may use", float64(p.budgetMB)/1024)
			}
			line("Memory", mem)
		}
		for _, l := range pl.limits {
			ui.Text(c, "• "+l).FontSize(ts(c, 12)).TextColor(t.TextMuted)
		}
		if len(pl.problems) > 0 {
			ui.Text(c, "Cannot run yet:").FontSize(ts(c, 12)).Bold().TextColor(t.Danger)
			for _, msg := range pl.problems {
				ui.Text(c, "• "+msg).FontSize(ts(c, 12)).TextColor(t.Danger)
			}
		}
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, "Shortcut: "+cmdName()+"+Enter").FontSize(ts(c, 12)).TextColor(t.TextMuted).Grow(1)
			busy := p.running()
			label := "Run fold"
			if busy {
				label = "Fold running…"
			}
			if ui.PrimaryButton(c, label).Disabled(len(pl.problems) > 0 || busy).Clicked() {
				p.runFold()
			}
		})
	})
}

func cmdName() string {
	if ui.Cmd == ui.Super {
		return "⌘"
	}
	return "Ctrl"
}

// estimate keeps p.est for the plan's lengths (computed off the UI thread).
func (p *structurePage) estimate(pl foldPlan) {
	if len(pl.lengths) == 0 {
		p.estKey, p.est = "", nil
		return
	}
	a := p.a
	workers := max(int(p.workers), 1)
	if p.mode != "windows" {
		workers = 1
	}
	key := fmt.Sprint(pl.lengths, int(p.beam), workers, pl.pk)
	if key == p.estKey {
		return
	}
	p.estKey, p.est = key, nil
	lengths, beam := pl.lengths, int(p.beam)
	a.Go(func() func() {
		e := a.B.EstimateFold(lengths, beam, workers)
		return func() {
			if p.estKey == key {
				p.est = &e
			}
		}
	})
}

func (p *structurePage) runFold() {
	a := p.a
	pl := p.plan()
	if len(pl.problems) > 0 || p.running() {
		return
	}
	p.starting, p.startErr, p.lastTask = true, "", ""
	mem := pl.memMB
	a.StartTask(pl.req, "Structure · "+pl.evidence+" · "+pl.what, func(t model.Task, err error) {
		p.starting = false
		if err != nil {
			p.startErr = StructureStartError(err, mem)
			return
		}
		p.prefillNote = ""
		p.lastTask = t.TaskID
		p.pendingShow = t.TaskID
	})
}

// running: this page's fold is starting, queued or running.
func (p *structurePage) running() bool {
	if p.starting {
		return true
	}
	t, ok := p.a.Tasks[p.lastTask]
	return ok && t.Active()
}

// ---- status of the fold started here

func (p *structurePage) status(c *ui.Context) {
	a := p.a
	t := c.Theme()
	box := func(color ui.Color, body func()) {
		ui.Column(c.Key("st-status")).Gap(6).Padding(10).Radius(8).Border(1, color).Children(body)
	}
	switch {
	case p.starting:
		box(t.Border, func() { ui.Spinner(c).Label("Starting the fold…") })
		return
	case p.startErr != "":
		box(t.Danger, func() {
			ui.Text(c, "The fold did not start").Bold().TextColor(t.Danger)
			ui.Text(c, p.startErr).FontSize(ts(c, 12))
		})
		return
	case p.lastTask == "":
		return
	}
	task, ok := a.Tasks[p.lastTask]
	if !ok {
		return
	}
	switch task.Status {
	case "queued":
		box(t.Accent, func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, "Waiting to start").Bold().Grow(1)
				if ui.Button(c, "Cancel").Clicked() {
					a.CancelTask(task.TaskID)
				}
			})
			ui.Text(c, "Other tasks are using the CPU or memory tasks may use (Preferences); this fold starts when they finish.").
				FontSize(12).TextColor(t.TextMuted)
		})
	case "running":
		box(t.Accent, func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, stStageText(task)).Bold().Grow(1).Shrink(1).MinWidth(0)
				if ui.Button(c, "Cancel").Tooltip("Stop the fold; nothing is saved").Clicked() {
					a.CancelTask(task.TaskID)
				}
			})
			ui.Progress(c, task.Progress.Fraction()).Label("Fold progress")
			ui.Text(c, stTimeLine(task)).FontSize(ts(c, 12)).TextColor(t.TextMuted)
		})
	case "succeeded":
		box(t.Success, func() {
			ui.Text(c, "Fold finished").Bold().TextColor(t.Success)
			done := "It is shown in the viewer and listed under Results."
			if e := p.entryForTask(task.TaskID); e != nil {
				if s := stSummaryText(e); s != "" {
					done = s + ". " + done
				}
			}
			ui.Text(c, done).FontSize(ts(c, 12))
		})
	case "failed":
		what, next := stExplain(task.ErrorText())
		box(t.Danger, func() {
			ui.Text(c, "The fold failed").Bold().TextColor(t.Danger)
			ui.Text(c, what).FontSize(ts(c, 12))
			ui.Text(c, "Next: "+next).FontSize(ts(c, 12))
			ui.Collapsible(c.Key("st-error"), "Technical details", &p.errorOpen, func() {
				ui.Text(c, truncate(task.ErrorText(), 600)+" (log: runs/"+task.TaskID+"/stderr.log)").FontSize(ts(c, 12)).
					TextColor(t.TextMuted).Selectable()
			})
		})
	case "cancelled":
		box(t.Border, func() {
			ui.Text(c, "Fold cancelled").Bold()
			ui.Text(c, "Nothing was saved, including windows that had already been folded. Change the form if needed, then run it again.").
				FontSize(12).TextColor(t.TextMuted)
		})
	case "interrupted":
		box(t.Warning, func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, "Fold stopped").Bold().Grow(1)
				if ui.Button(c, "Run it again").Clicked() {
					a.ResumeTaskThen(task.TaskID, a.TaskLabel(task), func(nt model.Task, err error) {
						if err == nil {
							p.lastTask, p.pendingShow = nt.TaskID, nt.TaskID
						}
					})
				}
			})
			ui.Text(c, "RNAxRay Desktop closed while it ran. Nothing was saved; it starts from the beginning.").
				FontSize(12).TextColor(t.TextMuted)
		})
	}
}

// stStageText says what a running fold does.
func stStageText(task model.Task) string {
	pr := task.Progress
	if pr == nil {
		return "Folding…"
	}
	switch pr.Stage {
	case "evidence":
		return "Reading the chimeric reads…"
	case "fold":
		if pr.BytesTotal != nil && *pr.BytesTotal > 1 && pr.BytesDone != nil {
			return fmt.Sprintf("Folding: %.0f of %.0f windows done", *pr.BytesDone, *pr.BytesTotal)
		}
		return "Folding…"
	case "write":
		return "Saving the results…"
	}
	return "Folding…"
}

// stTimeLine: elapsed and, when known, the time left.
func stTimeLine(task model.Task) string {
	parts := []string{}
	if at, err := time.Parse(time.RFC3339, task.LaunchedAt); err == nil {
		parts = append(parts, "running for "+FormatDuration(time.Since(at).Seconds()))
	}
	if task.SecondsLeft != nil {
		parts = append(parts, "about "+FormatDuration(*task.SecondsLeft)+" left")
	} else {
		parts = append(parts, "time left unknown")
	}
	return strings.Join(parts, " · ") + ". You can keep working; the fold continues in the background."
}

// stExplain turns a fold's error into what happened and what to do.
func stExplain(err string) (what, next string) {
	low := strings.ToLower(err)
	switch {
	case strings.Contains(low, "exceeds the cplfold limit"):
		return "The region is longer than CPLfold can fold with the memory tasks may use.",
			"fold shorter windows, or raise Memory in Preferences."
	case strings.Contains(low, "no intramolecular") || strings.Contains(low, "chimeras fall inside"):
		return "No chimeric read of these samples has both arms inside the folded region, so there is no evidence to guide the fold.",
			"choose a wider window or other samples, or check the region on Explore › Contact map."
	case strings.Contains(low, "memory") || strings.Contains(low, "killed") || strings.Contains(low, "signal"):
		return "The fold ran out of memory or was stopped by the system.",
			"fold shorter windows or fewer at once (Advanced), or close other programs and run it again."
	case strings.Contains(low, "not bundled") || strings.Contains(low, "unavailable") || strings.Contains(low, "no module"):
		return "The folding engine is missing from this installation.",
			"reinstall RNAxRay Desktop."
	case strings.Contains(low, "missing") || strings.Contains(low, "no such file") || strings.Contains(low, "not found"):
		return "A file the fold reads (a sample's .hyb or the reference) is missing or moved.",
			"use Check inputs on the Data page and relink the file, then run the fold again."
	}
	return "CPLfold stopped with an error.", "run it again; if it fails again, send the technical details below to the RNAxRay team."
}

// ---- results

// stSummary is a listed structure's summary (from its task).
type stSummary struct {
	Pairs           int      `json:"pairs"`
	PseudoknotPairs int      `json:"pseudoknot_pairs"`
	Energy          *float64 `json:"energy"`
	Length          int      `json:"length"`
	Records         int      `json:"records"`
}

func (p *structurePage) entryForTask(id string) *structureEntry {
	for i := range p.structures {
		if p.structures[i].TaskID == id || p.structures[i].ID == id {
			return &p.structures[i]
		}
	}
	return nil
}

// stSummaryText: "1,055 base pairs (0 pseudoknotted) · −452.0 kcal/mol".
func stSummaryText(e *structureEntry) string {
	var s stSummary
	if e.Summary == nil || model.Decode(e.Summary, &s) != nil || s.Pairs == 0 && s.Length == 0 {
		return ""
	}
	text := FormatNumber(int64(s.Pairs)) + " base pairs"
	if s.PseudoknotPairs > 0 {
		text += fmt.Sprintf(" (%s pseudoknotted)", FormatNumber(int64(s.PseudoknotPairs)))
	}
	if s.Energy != nil {
		text += fmt.Sprintf(" · %.1f kcal/mol", *s.Energy)
	}
	return text
}

// stResultLabel names a result for screen readers: the RNA, what was
// folded and its numbers.
func stResultLabel(e *structureEntry) string {
	parts := []string{e.GeneID, stWhat(e)}
	if s := stSummaryText(e); s != "" {
		parts = append(parts, s)
	}
	return strings.Join(parts, " · ")
}

// stWhat: "whole RNA · 10,807 nt" or "2 windows · 3,060 nt".
func stWhat(e *structureEntry) string {
	if e.Mode == "genome" {
		var s stSummary
		if e.Summary != nil && model.Decode(e.Summary, &s) == nil && s.Length > 0 {
			return "whole RNA · " + FormatNumber(int64(s.Length)) + " nt"
		}
		return "whole RNA"
	}
	total := 0
	spans := make([]string, 0, len(e.Windows))
	for _, w := range e.Windows {
		total += int(w.End - w.Start + 1)
		spans = append(spans, FormatNumber(int64(w.Start))+"–"+FormatNumber(int64(w.End)))
	}
	text := fmt.Sprintf("%d window%s · %s nt", len(e.Windows), plural(len(e.Windows)), FormatNumber(int64(total)))
	if len(spans) <= 2 {
		text += " (" + strings.Join(spans, ", ") + ")"
	}
	return text
}

func (p *structurePage) list(c *ui.Context) {
	t := c.Theme()
	Card(c, "", func() {
		ui.Row(c).AlignItems(ui.Center).Children(func() {
			title := "Results"
			if n := len(p.structures); n > 0 {
				title = fmt.Sprintf("Results (%d)", n)
			}
			ui.Text(c, title).FontSize(ts(c, 16)).Bold().Grow(1)
			if ui.Button(c, "Refresh").Tooltip("Read the project's structures again").Clicked() {
				p.loadList()
			}
		})
		ui.Text(c, "Newest first. Show puts a result in the viewer as A; Compare as B overlays a second one.").
			FontSize(12).TextColor(t.TextMuted)
		others := p.otherTasks(c)
		if p.listErr != "" {
			ui.Text(c, "Could not read the project's structures: "+p.listErr+". Press Refresh to try again.").
				FontSize(12).TextColor(t.Danger)
		}
		if len(p.structures) == 0 {
			switch {
			case p.loading:
				ui.Spinner(c).Label("Loading results…")
			case others == 0 && p.listErr == "":
				ui.Text(c, "No structures yet. Choose an RNA and its evidence above and press Run fold; "+
					"results appear here and in the Report.").FontSize(ts(c, 12)).TextColor(t.TextMuted)
			}
			return
		}
		for i := range p.structures {
			e := &p.structures[i]
			isA, isB := p.viewA == e.ID, p.viewB == e.ID
			item := ui.Column(c.Key("st-"+e.ID)).Gap(3).Padding(8, 10).Radius(8).Border(1, t.Border)
			if isA || isB {
				item.Background(t.Accent.Alpha(0.10)).BorderColor(t.Accent)
			}
			item.Children(func() {
				// The whole RNA name, on up to two lines.
				ui.Text(c, e.GeneID).Bold().MaxLines(2).Tooltip(e.GeneID)
				ui.Text(c, stWhat(e)).FontSize(ts(c, 12))
				if s := stSummaryText(e); s != "" {
					ui.Text(c, s).FontSize(ts(c, 12))
				}
				meta := "Evidence: " + nameOr(p.evidenceNames(e), "—") + " · " + FormatTime(e.CreatedAt)
				ui.Text(c, meta).FontSize(ts(c, 12)).TextColor(t.TextMuted)
				if e.Available != nil && !*e.Available {
					ui.Text(c, "Its files are missing from the project folder; it cannot be shown. Run the fold again to recreate it.").
						FontSize(12).TextColor(t.Danger)
					return
				}
				ui.Row(c).Gap(6).Children(func() {
					if isA {
						ui.Badge(c, "A · shown").Background(cmpRed.Alpha(0.15)).TextColor(t.Text)
					} else if ui.Button(c, "Show").Clicked() {
						p.show(e.ID)
					}
					if isB {
						ui.Badge(c, "B · compared").Background(cmpBlue.Alpha(0.15)).TextColor(t.Text)
					} else if p.viewA != "" && !isA {
						if ui.Button(c, "Compare as B").Clicked() {
							p.viewB = e.ID
							p.ensureRead(e.ID)
						}
					}
				})
			})
		}
	})
}

// otherTasks lists structure folds started elsewhere (Explore, Compare) or
// earlier: running ones with Cancel, recent failures explained. Returns how
// many it showed.
func (p *structurePage) otherTasks(c *ui.Context) int {
	a := p.a
	t := c.Theme()
	shown, failed := 0, 0
	for _, task := range a.TaskList() {
		if task.Kind != "structure" || task.TaskID == p.lastTask {
			continue
		}
		switch {
		case task.Active():
			shown++
			ui.Column(c.Key("task-"+task.TaskID)).Gap(4).Padding(8, 10).Radius(8).Border(1, t.Accent.Alpha(0.5)).Children(func() {
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					ui.Text(c, a.TaskLabel(task)).Bold().Grow(1).Shrink(1).MinWidth(0)
					if ui.Button(c, "Cancel").Clicked() {
						a.CancelTask(task.TaskID)
					}
				})
				if task.Status == "queued" {
					ui.Text(c, "Waiting to start").FontSize(ts(c, 12)).TextColor(t.TextMuted)
				} else {
					ui.Text(c, stStageText(task)).FontSize(ts(c, 12))
					ui.Progress(c, task.Progress.Fraction()).Label("Fold progress")
				}
			})
		case failed < 3 && (task.Status == "interrupted" || (task.Status == "failed" && task.FinishedAt >= a.SessionStart)):
			failed++
			shown++
			ui.Column(c.Key("task-"+task.TaskID)).Gap(4).Padding(8, 10).Radius(8).Border(1, t.Border).Children(func() {
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					ui.Text(c, a.TaskLabel(task)).Bold().Grow(1).Shrink(1).MinWidth(0)
					StatusChip(c, task.Status)
					if ui.Button(c, "Run it again").Clicked() {
						a.ResumeTask(task.TaskID)
					}
				})
				if task.Status == "interrupted" {
					ui.Text(c, "Stopped when RNAxRay Desktop closed; nothing was saved.").FontSize(ts(c, 12)).TextColor(t.TextMuted)
				} else {
					what, next := stExplain(task.ErrorText())
					ui.Text(c, what+" Next: "+next).FontSize(ts(c, 12)).TextColor(t.Danger)
				}
			})
		}
	}
	return shown
}

// sampleNames: "SUB_REP1 + SUB_REP2".
func (p *structurePage) sampleNames(ids []string) string {
	names := make([]string, len(ids))
	for i, id := range ids {
		names[i] = id
		if s := p.a.Project.Sample(id); s != nil {
			names[i] = s.Label()
		}
	}
	return strings.Join(names, " + ")
}
