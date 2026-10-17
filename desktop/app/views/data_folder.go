package views

// Import a data folder: scan_data_folder proposes one sample per reads file
// (condition and replicate from the file name, the reference by name) and
// the user reviews and edits the proposal before import_sample_rows.

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/model"
)

// dataFolderScan is scan_data_folder's answer.
type dataFolderScan struct {
	Folder  string `json:"folder"`
	Samples []struct {
		Path             string   `json:"path"`
		Format           string   `json:"format"`
		Size             int64    `json:"size_bytes"`
		Name             string   `json:"name"`
		Condition        *string  `json:"condition"`
		Replicate        *int     `json:"replicate"`
		Reference        *string  `json:"reference"`
		ReferenceGuessed bool     `json:"reference_guessed"`
		Notes            []string `json:"notes"`
	} `json:"samples"`
	References []string `json:"references"`
	Duplicates []struct {
		Path string `json:"path"`
		Kept string `json:"kept"`
	} `json:"duplicates"`
	Ignored map[string]int `json:"ignored"`
}

// dataFolderRow is one editable proposed sample.
type dataFolderRow struct {
	include   bool
	path      string
	size      int64
	name      string
	condition string
	replicate float64 // 0: none
	reference string  // label in refLabels, or dataNoReference
	notes     []string
}

const dataNoReference = "None"

type dataFolderDialog struct {
	open      bool
	scanning  bool
	folder    string
	rows      []dataFolderRow
	refs      []string // absolute paths
	refLabels []string // labels for the select, same order, then "None"
	skipped   []string // "9 plain copies of .gz files (the .gz is used)", ...
	mode      string
	status    string
	busy      bool
	table     ui.ListState
}

// chooseFolder asks for a folder and scans it.
func (p *dataPage) chooseFolder() {
	a := p.a
	a.Go(func() func() {
		folder := PickFolder("Choose the folder with your raw data")
		if folder == "" {
			return nil
		}
		return func() { p.scanFolder(folder) }
	})
}

// scanFolder proposes the folder's samples and opens the review dialog.
func (p *dataPage) scanFolder(folder string) {
	a := p.a
	if a.Project == nil {
		return
	}
	path := a.Project.Path
	p.folder = dataFolderDialog{open: true, scanning: true, folder: folder, mode: dataStorageModes[0]}
	a.Go(func() func() {
		result, err := a.B.ProjectOp(path, "scan_data_folder", core.Obj{"folder": folder})
		var scan dataFolderScan
		if err == nil {
			err = model.Decode(result, &scan)
		}
		return func() {
			if a.Project == nil || a.Project.Path != path || p.folder.folder != folder {
				return
			}
			p.folder.scanning = false
			if err != nil {
				p.folder.status = "Could not read the folder: " + err.Error()
				return
			}
			p.applyScan(scan)
		}
	})
}

// folderLabel is a path shown relative to the scanned folder.
func folderLabel(folder, path string) string {
	if rel, err := filepath.Rel(folder, path); err == nil && !strings.HasPrefix(rel, "..") {
		return filepath.ToSlash(rel)
	}
	return path
}

func (p *dataPage) applyScan(scan dataFolderScan) {
	d := &p.folder
	d.refs = scan.References
	d.refLabels = nil
	for _, ref := range scan.References {
		d.refLabels = append(d.refLabels, folderLabel(scan.Folder, ref))
	}
	d.refLabels = append(d.refLabels, dataNoReference)
	d.rows = nil
	for _, s := range scan.Samples {
		row := dataFolderRow{include: true, path: s.Path, size: s.Size, name: s.Name, reference: dataNoReference, notes: s.Notes}
		if s.Condition != nil {
			row.condition = *s.Condition
		}
		if s.Replicate != nil {
			row.replicate = float64(*s.Replicate)
		}
		if s.Reference != nil {
			row.reference = folderLabel(scan.Folder, *s.Reference)
		}
		d.rows = append(d.rows, row)
	}
	d.skipped = nil
	if n := len(scan.Duplicates); n > 0 {
		d.skipped = append(d.skipped, dataPlural(n, "uncompressed copy", "uncompressed copies")+" of .gz files (the .gz is used)")
	}
	kinds := make([]string, 0, len(scan.Ignored))
	for kind := range scan.Ignored {
		kinds = append(kinds, kind)
	}
	sort.Strings(kinds)
	for _, kind := range kinds {
		d.skipped = append(d.skipped, fmt.Sprintf("%d %s", scan.Ignored[kind], kind))
	}
}

// folderSummary is the line above the table.
func (d *dataFolderDialog) summary() string {
	conditions := map[string]bool{}
	refs := map[string]bool{}
	n := 0
	for _, r := range d.rows {
		if !r.include {
			continue
		}
		n++
		if r.condition != "" {
			conditions[r.condition] = true
		}
		if r.reference != dataNoReference {
			refs[r.reference] = true
		}
	}
	return fmt.Sprintf("%s in %s, using %s.", dataPlural(n, "sample", "samples"),
		dataPlural(len(conditions), "condition", "conditions"), dataPlural(len(refs), "reference", "references"))
}

// withoutReference counts the included rows of reads with no reference
// (a .hyb file is already mapped and needs none).
func (d *dataFolderDialog) withoutReference() int {
	n := 0
	for _, r := range d.rows {
		if r.include && r.reference == dataNoReference && !strings.HasSuffix(strings.ToLower(r.path), ".hyb") {
			n++
		}
	}
	return n
}

// problem is why Import is disabled, or "".
func (d *dataFolderDialog) problem() string {
	n := 0
	for _, r := range d.rows {
		if !r.include {
			continue
		}
		n++
		if strings.TrimSpace(r.name) == "" {
			return "Every included sample needs a name."
		}
	}
	if n == 0 {
		return "Select at least one sample."
	}
	return ""
}

func (p *dataPage) folderDialog(c *ui.Context) {
	t := c.Theme()
	d := &p.folder
	if !d.open {
		return
	}
	ui.Modal(c, &d.open, func() {
		ui.Column(c).Width(980).Gap(10).Children(func() {
			ui.Text(c, "Import a data folder").FontSize(ts(c, 18)).Bold()
			ui.Text(c, d.folder).FontSize(ts(c, 12)).TextColor(t.TextMuted).SingleLine()
			if d.scanning {
				ui.Spinner(c).Label("Looking at the files…")
				return
			}
			if len(d.rows) == 0 {
				ui.Text(c, nameOr(d.status, "No read files (FASTQ, read FASTA, SAM or .hyb) were found in this folder or its subfolders.")).
					TextColor(t.TextMuted)
				ui.Row(c).Justify(ui.End).Children(func() {
					if ui.Button(c, "Close").Clicked() {
						d.open = false
					}
				})
				return
			}
			ui.Text(c, "Proposed from the file names: "+d.summary()+" Nothing is imported until you click Import.")
			ui.Text(c, "Samples with the same condition are treated as replicates of each other (merged in QC and Explore, compared in Compare). "+
				"Edit any cell; rows with a note need a look.").FontSize(ts(c, 12)).TextColor(t.TextMuted)
			if len(d.skipped) > 0 {
				ui.Text(c, "Not imported: "+strings.Join(d.skipped, "; ")+".").FontSize(ts(c, 12)).TextColor(t.TextMuted)
			}
			p.folderTable(c)
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, "Storage").TextColor(t.TextMuted)
				ui.Select(c.Key("folder-mode"), &d.mode, dataStorageModes).Label("Storage").Width(260)
			})
			if n := d.withoutReference(); n == 1 {
				ui.Text(c, "1 sample has no reference: it can be imported but not run until you set one.").TextColor(t.Warning)
			} else if n > 1 {
				ui.Text(c, fmt.Sprintf("%d samples have no reference: they can be imported but not run until you set one.", n)).TextColor(t.Warning)
			}
			if d.status != "" {
				ui.Text(c, d.status).TextColor(t.TextMuted)
			}
			problem := d.problem()
			if problem != "" {
				ui.Text(c, problem).TextColor(t.Danger)
			}
			ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
				if ui.Button(c, "Cancel").Disabled(d.busy).Clicked() {
					d.open = false
				}
				n := 0
				for _, r := range d.rows {
					if r.include {
						n++
					}
				}
				if ui.PrimaryButton(c, "Import "+dataPlural(n, "sample", "samples")).Disabled(d.busy || problem != "").Clicked() {
					p.confirmFolder()
				}
			})
		})
	})
}

func (p *dataPage) folderTable(c *ui.Context) {
	t := c.Theme()
	d := &p.folder
	cols := []ui.TableColumn{{Title: "", ID: "include", Width: 36, Fixed: true}, {Title: "Sample name", Width: 150},
		{Title: "Condition", Width: 120}, {Title: "Rep", Width: 84}, {Title: "File", MinWidth: 180},
		{Title: "Reference", Width: 150}, {Title: "Note", Width: 170}}
	rows := d.rows
	d.table.Label = func(i int) string { return rows[i].name }
	height := float32(44*len(rows) + 40)
	if height > 400 {
		height = 400
	}
	ui.Table(c, &d.table, cols, len(rows), func(row, col int) {
		r := &d.rows[row]
		key := func(name string) *ui.Context { return c.Key(fmt.Sprintf("folder-%s-%d", name, row)) }
		switch col {
		case 0:
			ui.Checkbox(key("include"), &r.include, "")
		case 1:
			ui.TextInput(key("name"), &r.name).Label("Sample name")
		case 2:
			ui.TextInput(key("condition"), &r.condition).Placeholder("none").Label("Condition")
		case 3:
			ui.NumberInput(key("rep"), &r.replicate, 0, 999, 1).Tooltip("Replicate number (0: none)")
		case 4:
			ui.Column(c).Gap(0).MinWidth(0).Children(func() {
				ui.Text(c, folderLabel(d.folder, r.path)).FontSize(ts(c, 12)).SingleLine().Tooltip(r.path)
				ui.Text(c, dataFormatBytes(r.size)).FontSize(ts(c, 11)).TextColor(t.TextMuted)
			})
		case 5:
			ui.Select(key("ref"), &r.reference, d.refLabels).Label("Reference")
		case 6:
			if len(r.notes) > 0 {
				ui.Text(c, "⚠ "+strings.Join(r.notes, "; ")).FontSize(ts(c, 11)).TextColor(t.Warning).Tooltip(strings.Join(r.notes, "\n"))
			}
		}
	}).Height(height).Border(1, t.Border).Radius(6)
}

// folderRows are the included rows as import_sample_rows wants them.
func (d *dataFolderDialog) importRows() []core.Obj {
	var out []core.Obj
	for _, r := range d.rows {
		if !r.include {
			continue
		}
		row := core.Obj{"path": r.path, "name": strings.TrimSpace(r.name)}
		if c := strings.TrimSpace(r.condition); c != "" {
			row["condition"] = c
		}
		if r.replicate >= 1 {
			row["replicate"] = int(r.replicate)
		}
		for i, label := range d.refLabels {
			if label == r.reference && i < len(d.refs) {
				row["reference"] = d.refs[i]
			}
		}
		out = append(out, row)
	}
	return out
}

func (p *dataPage) confirmFolder() {
	a := p.a
	d := &p.folder
	rows, mode, path := d.importRows(), dataModeValue(d.mode), a.Project.Path
	d.busy, d.status = true, "Importing (fingerprinting files)…"
	a.Go(func() func() {
		result, err := a.B.ProjectOp(path, "import_sample_rows", core.Obj{"rows": rows, "mode": mode})
		return func() {
			d.busy = false
			if err != nil {
				d.status = "Import failed: " + err.Error()
				return
			}
			var added, skipped []any
			_ = model.Decode(result["samples"], &added)
			_ = model.Decode(result["skipped"], &skipped)
			message := fmt.Sprintf("Imported %s", dataPlural(len(added), "sample", "samples"))
			if len(skipped) > 0 {
				message += fmt.Sprintf(", %d already in the project", len(skipped))
			}
			a.Toast("%s. Next: Run all pending.", message)
			d.open, d.status = false, ""
			a.RefreshProject()
		}
	})
}
