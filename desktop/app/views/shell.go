package views

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/model"
)

// View builds the window: the start page, or the project shell.
func (a *App) View(c *ui.Context) {
	applyBrandTheme(c)
	for _, m := range a.toasts {
		c.AddToast(ui.Toast{ID: m.ID, Title: m.Text})
	}
	a.toasts = nil
	if a.Project == nil {
		a.startView(c)
		return
	}
	t := c.Theme()
	ui.Column(c).Fill().Children(func() {
		a.topBar(c)
		ui.Row(c).Grow(1).AlignItems(ui.Stretch).Children(func() {
			a.navigation(c)
			content := ui.Column(c).Grow(1).MinWidth(0).ClipX().Background(brandCanvas(t)).Children(func() {
				if p := a.pages[a.Page]; p != nil {
					p.View(c.Key("page-" + a.Page))
				}
			})
			a.content = content.LayoutBounds()
		})
	})
	a.tasksDrawer(c)
	a.prefsDialog(c)
}

// navigation: the logo and project, the pages, and closing the project.
func (a *App) navigation(c *ui.Context) {
	t := c.Theme()
	page := a.Page
	ui.Column(c).Width(184).BorderWidth(0, 1, 0, 0).BorderColor(t.Border).Children(func() {
		ui.Column(c).Gap(8).Padding(14, 14, 10, 14).Children(func() {
			Logo(c, 26)
			ui.Text(c, a.Project.Name).Bold().MaxLines(2).Tooltip(a.Project.Path)
		})
		ui.Sidebar(c, &page, func() {
			for _, p := range Pages {
				item := ui.SidebarItem(c, p.ID, nil, p.Number+"  "+p.Title)
				if p.ID == page {
					// The web app's chosen page: the accent's tint, its bar on the left.
					item.Background(brandSoft(t)).TextColor(brandInk(t)).FontWeight(600).
						BorderWidth(0, 0, 0, 3).BorderColor(t.Accent)
				}
				if p.ID == "data" && len(a.Project.Samples) > 0 {
					item.Children(func() { ui.Badge(c, fmt.Sprint(len(a.Project.Samples))) })
				}
			}
		}).Grow(1).FillWidth().Background(t.Background).OnChange(func() { a.Navigate(page, nil) })
		ui.Column(c).Padding(10, 14, 14, 14).Children(func() {
			if ui.Button(c, "Close project").FillWidth().Tooltip("Back to the start page").Clicked() {
				a.Close()
			}
		})
	})
}

// topBar: project menu, reference, gene, selection, tasks and preferences.
func (a *App) topBar(c *ui.Context) {
	t := c.Theme()
	ui.Row(c).Gap(10).Padding(8, 12).AlignItems(ui.Center).BorderWidth(0, 0, 1, 0).BorderColor(t.Border).Children(func() {
		a.referencePicker(c)
		a.genePicker(c)
		a.selectionPicker(c)
		ui.Spacer(c)
		a.privacyChip(c)
		active := len(a.ActiveTasks())
		label := "Tasks idle"
		if active > 0 {
			label = fmt.Sprintf("%d task%s running", active, plural(active))
		}
		if ui.Button(c, label).Clicked() {
			a.drawerOpen = !a.drawerOpen
		}
		if ui.Button(c, "Preferences").Clicked() {
			a.openPrefs()
		}
	})
}

// privacyChip is the web app's "Local only" chip: what leaves this
// computer. A click opens Preferences, where external lookups are set.
func (a *App) privacyChip(c *ui.Context) {
	if !a.lookup.known {
		return
	}
	t := c.Theme()
	label, tip := "Local only", "Your data stays on this computer: external lookups are off."
	ink, bg, border := t.Success, brandOf(t).successSoft, t.Success.Mix(t.Border, 0.73)
	if a.lookup.on {
		label, tip = "RNAcentral lookups on", "Only the identifier and species you enter are sent to RNAcentral; no sequence, structure or project data."
		ink, bg, border = brandOf(t).mutedStrong, t.Surface, t.Border
	}
	// In a narrow window, as with large text, the dot alone keeps the
	// pickers and buttons of the bar in view; the name and tooltip stay.
	width, _ := c.Size()
	compact := width < t.Rem(90)
	if compact {
		tip = label + ". " + tip
	}
	b := ui.ButtonBase(c.Key("privacy-chip")).Cursor(ui.CursorPointer).Label(label).Tooltip(tip).
		Padding(4, 10).Radius(999).Background(bg).Border(1, border)
	b.Children(func() {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			ui.Box(c).Size(7, 7).Radius(4).Background(ink)
			if !compact {
				ui.Text(c, label).FontSize(ts(c, 12)).FontWeight(700).TextColor(ink)
			}
		})
	})
	if b.Clicked() {
		a.openPrefs()
	}
}

func (a *App) referencePicker(c *ui.Context) {
	var labels []string
	ids := map[string]string{}
	current := ""
	for _, r := range a.Project.References {
		label := r.Label
		if label == "" {
			label = r.ID
		}
		labels = append(labels, label)
		ids[label] = r.ID
		if r.ID == a.Selected.ReferenceID {
			current = label
		}
	}
	if len(labels) == 0 {
		return
	}
	barLabel(c, "Reference")
	ui.Select(c.Key("reference"), &current, labels).Label("Reference").Width(110).OnChange(func() {
		a.Selected.ReferenceID = ids[current]
		a.normalizeSelection()
		a.saveUIState()
	})
}

func (a *App) genePicker(c *ui.Context) {
	var names []string
	for _, g := range a.Genes() {
		names = append(names, g.Name)
	}
	if len(names) == 0 {
		return
	}
	gene := a.Selected.Gene
	barLabel(c, "RNA")
	ui.Select(c.Key("gene"), &gene, names).Label("RNA").Width(210).Tooltip(gene).OnChange(func() {
		a.Selected.Gene = gene
		a.saveUIState()
	})
}

func (a *App) selectionPicker(c *ui.Context) {
	options := a.SelectionOptions()
	if len(options) == 0 {
		ui.Text(c, "No analysed samples yet").TextColor(c.Theme().TextMuted)
		return
	}
	var labels []string
	keys := map[string]string{}
	current := ""
	for _, o := range options {
		labels = append(labels, o.Label)
		keys[o.Label] = o.Key
		if o.Key == a.Selected.Key {
			current = o.Label
		}
	}
	barLabel(c, "Samples")
	ui.Select(c.Key("selection"), &current, labels).Label("Samples").Width(230).Tooltip("The samples, or a condition with its replicates merged, that QC, Explore and Structure show").OnChange(func() {
		a.Selected.Key = keys[current]
		a.saveUIState()
	})
}

// ---- tasks drawer

func (a *App) tasksDrawer(c *ui.Context) {
	if !a.drawerOpen {
		return
	}
	t := c.Theme()
	ui.Overlay(c, func() {
		back := ui.Row(c).Absolute().Left(0).Top(0).Right(0).Bottom(0).Justify(ui.End).
			Background(ui.RGBA(0, 0, 0, 0.25)).Modal()
		back.Children(func() {
			panel := ui.Column(c).Width(380).FillHeight().Padding(16).Gap(10).Background(t.Background).
				Role(ui.RoleDialog).Label("Tasks")
			panel.Children(func() {
				ui.Row(c).Children(func() {
					ui.Text(c, "Tasks").FontSize(ts(c, 18)).Bold().Grow(1)
					if ui.Button(c, "Close").Clicked() {
						a.drawerOpen = false
					}
				})
				tasks := a.TaskList()
				if len(tasks) == 0 {
					ui.Text(c, "No tasks in this project yet.").TextColor(t.TextMuted)
				}
				ui.Scroll(c).Grow(1).Gap(8).Children(func() {
					for _, task := range tasks {
						a.taskItem(c.Key(task.TaskID), task)
					}
				})
			})
			if panel.PressedOutside() || back.OverlayShortcut(0, ui.KeyEscape) {
				a.drawerOpen = false
			}
		})
	})
}

func (a *App) taskItem(c *ui.Context, task model.Task) {
	t := c.Theme()
	ui.Column(c).Gap(4).Padding(8).Radius(8).Border(1, t.Border).Children(func() {
		ui.Row(c).Gap(8).Children(func() {
			ui.Text(c, a.TaskLabel(task)).Bold().Grow(1).SingleLine()
			StatusChip(c, task.Status)
		})
		if task.Active() {
			ProgressBar(c, task)
		}
		meta := []string{FormatTime(task.StartedAt)}
		if task.FinishedAt != "" {
			meta = append(meta, "finished "+FormatTime(task.FinishedAt))
		}
		ui.Text(c, strings.Join(meta, " · ")).FontSize(ts(c, 12)).TextColor(t.TextMuted)
		if e := task.ErrorText(); e != "" {
			ui.Text(c, truncate(e, 400)).FontSize(ts(c, 12)).TextColor(t.Danger)
		}
		ui.Row(c).Gap(6).Children(func() {
			if task.Active() {
				if ui.Button(c, "Cancel").Clicked() {
					a.CancelTask(task.TaskID)
				}
			}
			if task.Status == "interrupted" || task.Status == "failed" || task.Status == "cancelled" {
				if ui.Button(c, "Resume").Clicked() {
					a.ResumeTask(task.TaskID)
				}
			}
			if task.Status == "succeeded" && task.Kind == "structure" {
				if ui.Button(c, "View structure").Clicked() {
					a.drawerOpen = false
					a.Navigate("structure", map[string]any{"structureId": task.TaskID})
				}
			}
			if task.Status == "succeeded" && task.Kind == "energy" {
				if ui.Button(c, "View results").Clicked() {
					a.drawerOpen = false
					a.Navigate("compare", nil)
				}
			}
			if task.Status == "succeeded" && task.Kind == "compare" {
				if ui.Button(c, "View results").Clicked() {
					a.drawerOpen = false
					a.Navigate("compare", map[string]any{"comparisonId": task.TaskID})
				}
			}
		})
	})
}

// ---- shared small widgets

// barLabel names the top bar control after it.
// barLabel names a picker of the top bar; a window too narrow for the bar
// (as with large text) leaves it out, the picker keeping its own label.
func barLabel(c *ui.Context, text string) {
	if width, _ := c.Size(); width < c.Theme().Rem(80) {
		return
	}
	ui.Text(c, text).FontSize(ts(c, 12)).TextColor(c.Theme().TextMuted)
}

// StatusChip shows a task or stage status.
func StatusChip(c *ui.Context, status string) {
	t := c.Theme()
	b := ui.Badge(c, status)
	switch status {
	case "succeeded", "done", "available":
		b.Background(t.Success.Alpha(0.15)).TextColor(t.Success)
	case "failed", "interrupted", "missing", "changed":
		b.Background(t.Danger.Alpha(0.15)).TextColor(t.Danger)
	case "cancelled", "skipped", "pending":
		b.Background(t.TextMuted.Alpha(0.12)).TextColor(t.TextMuted)
	case "running", "queued":
		b.Background(t.Accent.Alpha(0.15)).TextColor(brandInk(t))
	}
}

// ProgressBar shows a task's progress.json: a fraction when known.
func ProgressBar(c *ui.Context, task model.Task) {
	t := c.Theme()
	fraction := task.Progress.Fraction()
	ui.Progress(c, fraction).Label(a11yProgress(task))
	if task.Progress != nil {
		detail := task.Progress.Stage
		if task.Progress.Detail != "" {
			detail += " · " + task.Progress.Detail
		}
		if fraction >= 0 {
			detail += fmt.Sprintf(" · %.0f%%", fraction*100)
		}
		if task.SecondsLeft != nil {
			detail += " · about " + FormatDuration(*task.SecondsLeft) + " left"
		}
		ui.Text(c, detail).FontSize(ts(c, 12)).TextColor(t.TextMuted).SingleLine()
	} else if task.Status == "queued" {
		ui.Text(c, "Waiting for CPU or memory budget").FontSize(ts(c, 12)).TextColor(t.TextMuted)
	}
}

func a11yProgress(task model.Task) string {
	if task.Progress != nil && task.Progress.Stage != "" {
		return "Progress: " + task.Progress.Stage
	}
	return "Progress"
}

// FormatTime shows an RFC 3339 time in local time.
func FormatTime(value string) string {
	if value == "" {
		return ""
	}
	when, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return value
	}
	return when.Local().Format("2006-01-02 15:04")
}

// FormatNumber groups thousands: 1234567 -> 1,234,567.
func FormatNumber(n int64) string {
	sign := ""
	if n < 0 {
		sign, n = "-", -n
	}
	s := fmt.Sprint(n)
	var out []byte
	for i := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, s[i])
	}
	return sign + string(out)
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// Field shows a visible label above a control (labels set with
// Element.Label are for assistive technology only).
func Field(c *ui.Context, label string, control func()) {
	ui.Column(c).Gap(4).Children(func() {
		ui.Text(c, label).FontSize(ts(c, 12)).Bold().TextColor(c.Theme().TextMuted)
		control()
	})
}

// PageHeader is the title and subtitle every page starts with.
func PageHeader(c *ui.Context, title, subtitle string) {
	ui.Column(c).Gap(4).Children(func() {
		ui.Text(c, title).FontSize(ts(c, 28)).FontWeight(800)
		if subtitle != "" {
			ui.Text(c, subtitle).TextColor(c.Theme().TextMuted)
		}
	})
}

// ---- placeholder for pages not built yet

type placeholder struct {
	a    *App
	info PageInfo
}

func (p *placeholder) Show() {}

func (p *placeholder) View(c *ui.Context) {
	ui.Column(c).Fill().Padding(24).Gap(8).Children(func() {
		ui.Text(c, p.info.Title).FontSize(ts(c, 28)).FontWeight(800)
		ui.Text(c, "This page is being rebuilt in the native interface.").TextColor(c.Theme().TextMuted)
	})
}

// FormatDuration is a rounded duration: "40 s", "1 min 25 s", "12 min",
// "2 h 05 min".
func FormatDuration(seconds float64) string {
	switch {
	case seconds < 60:
		return fmt.Sprintf("%.0f s", math.Max(seconds, 1))
	case seconds < 600:
		s := int(math.Round(seconds/5)) * 5
		if s%60 == 0 {
			return fmt.Sprintf("%d min", s/60)
		}
		return fmt.Sprintf("%d min %d s", s/60, s%60)
	case seconds < 3600:
		return fmt.Sprintf("%.0f min", math.Round(seconds/60))
	}
	minutes := int(math.Round(seconds / 60))
	return fmt.Sprintf("%d h %02d min", minutes/60, minutes%60)
}
