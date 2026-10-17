package views

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
)

type startState struct {
	openPath   string
	pasteOpen  bool // the "paste a path" section of Open is expanded
	newParent  string
	newName    string
	dataFolder string // optional raw data folder to import after creating
	status     string
	creating   bool
	runtimeErr string
	runtime    string
	// preparing: the bundled runtime is being unpacked (first launch);
	// creating or opening a project waits for it.
	preparing bool
}

// ProjectSuffix ends every project folder the start page creates.
const ProjectSuffix = ".rnaxrayproj"

// Dialogs are native and block, so they run on a goroutine; tests replace them.
var (
	PickFolder = func(title string) string {
		paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Title: title, Directory: true})
		if err != nil || len(paths) == 0 {
			return ""
		}
		return paths[0]
	}
	PickFiles = func(title string, multiple bool) []string {
		paths, _ := mygo.Dialog.Open(mygo.OpenDialogOptions{Title: title, Multiple: multiple})
		return paths
	}
	PickSave = func(title, defaultPath string) string {
		path, _ := mygo.Dialog.Save(mygo.SaveDialogOptions{DefaultPath: defaultPath})
		return path
	}
)

// SetRuntimeStatus shows the bundled runtime's state on the start page
// once it is resolved (or failed).
func (a *App) SetRuntimeStatus(summary, err string) {
	a.start.runtime, a.start.runtimeErr, a.start.preparing = summary, err, false
}

// SetRuntimePreparing says the bundled runtime is being unpacked.
func (a *App) SetRuntimePreparing() {
	a.start.runtime, a.start.runtimeErr, a.start.preparing = "", "", true
}

// defaultProjectParent is where new projects go unless the user picks
// another folder: ~/Documents, else the home folder.
func defaultProjectParent() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	if info, err := os.Stat(filepath.Join(home, "Documents")); err == nil && info.IsDir() {
		return filepath.Join(home, "Documents")
	}
	return home
}

// ProjectFolderName turns a project name into a folder name:
// "ZIKV virion RNA" -> "ZIKV virion RNA.rnaxrayproj".
func ProjectFolderName(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.TrimSpace(name) {
		ok := r == ' ' || r == '-' || r == '_' || r == '.' ||
			(r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r > 127
		if ok {
			b.WriteRune(r)
			dash = false
		} else if !dash {
			b.WriteRune('-')
			dash = true
		}
	}
	base := strings.Trim(b.String(), " .-")
	if base == "" {
		base = "project"
	}
	return base + ProjectSuffix
}

// newProjectPath is the folder Create makes for name under parent; an
// existing non-empty folder gets " 2", " 3", ... appended.
func newProjectPath(parent, name string) string {
	folder := ProjectFolderName(name)
	path := filepath.Join(parent, folder)
	for i := 2; i < 1000; i++ {
		entries, err := os.ReadDir(path)
		if err != nil || len(entries) == 0 {
			return path
		}
		path = filepath.Join(parent, strings.TrimSuffix(folder, ProjectSuffix)+fmt.Sprintf(" %d", i)+ProjectSuffix)
	}
	return path
}

// openError explains the common reasons a folder does not open.
func openError(err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "project.json is missing"):
		return "This folder is not a RNAxRay project (it has no project.json). Choose a folder created by RNAxRay Desktop — its name usually ends in " +
			ProjectSuffix + " — or start a new project."
	case strings.Contains(msg, "no such file") || strings.Contains(msg, "does not exist"):
		return "The folder does not exist (moved or renamed?): " + msg
	}
	return "Could not open the project: " + msg
}

// startStep is one numbered step of the "how it works" strip.
func startStep(c *ui.Context, n, title, body string) {
	t := c.Theme()
	ui.Row(c).Gap(10).AlignItems(ui.Start).Grow(1).Basis(200).Children(func() {
		ui.Text(c, n).FontSize(13).Bold().TextColor(brandInk(t)).Width(18)
		ui.Column(c).Gap(2).Grow(1).Shrink(1).MinWidth(0).Children(func() {
			ui.Text(c, title).Bold()
			ui.Text(c, body).FontSize(12).TextColor(t.TextMuted)
		})
	})
}

func (a *App) startView(c *ui.Context) {
	t := c.Theme()
	s := &a.start
	if s.newParent == "" {
		s.newParent = defaultProjectParent()
	}
	ui.Scroll(c).Fill().Children(func() {
		ui.Column(c).Padding(32).Gap(16).MaxWidth(980).Children(func() {
			ui.Column(c).Gap(6).Children(func() {
				ui.Row(c).Gap(12).AlignItems(ui.End).Children(func() {
					Logo(c, 44)
					ui.Text(c, "Desktop").FontSize(22).TextColor(t.TextMuted).Padding(0, 0, 4, 0)
				})
				ui.Text(c, "From raw chimeric reads (FASTQ) to hybrids, interactions and RNA structure — all on this computer.").TextColor(t.TextMuted)
			})
			if s.runtimeErr != "" {
				ui.Text(c, "Runtime unavailable: "+s.runtimeErr).TextColor(t.Danger)
			}
			if s.preparing {
				ui.Row(c).Gap(10).AlignItems(ui.Center).Padding(10, 14).Radius(8).Background(t.Accent.Alpha(0.08)).Children(func() {
					ui.Spinner(c)
					ui.Column(c).Gap(2).Grow(1).Shrink(1).MinWidth(0).Children(func() {
						ui.Text(c, "Preparing the analysis runtime (first launch only, usually under a minute)…").Bold()
						ui.Text(c, "You can fill in a new project meanwhile; creating or opening one is possible as soon as it is ready.").
							FontSize(12).TextColor(t.TextMuted)
					})
				})
			}
			card(c, "How it works", func() {
				ui.Row(c).Gap(16).AlignItems(ui.Start).Wrap().Children(func() {
					startStep(c, "1", "Create a project", "A folder on your disk that keeps the sample list, pipeline outputs and results.")
					startStep(c, "2", "Add data", "On the Data page: the reference (FASTA) and your raw reads (FASTQ, many GB is fine). Files are linked where they are, not copied.")
					startStep(c, "3", "Run the pipeline", "Mapping and hybrid calling make the .hyb files, using the CPUs set in Preferences.")
					startStep(c, "4", "Analyse", "QC, Explore, Compare (DESeq2) and Structure (CPLfold), then export a Report.")
				})
			})
			ui.Row(c).Gap(16).AlignItems(ui.Stretch).Wrap().Children(func() {
				card(c, "Start a new project", func() {
					ui.Text(c, "Use this the first time you analyse a data set.").FontSize(12).TextColor(t.TextMuted)
					Field(c, "Project name", func() {
						ui.TextInput(c.Key("new-name"), &s.newName).Placeholder("e.g. ZIKV virion RNA").Label("Project name")
					})
					Field(c, "Save in", func() {
						ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
							ui.Text(c, nameOr(s.newParent, "Choose a folder")).FontSize(12).SingleLine().Grow(1).Shrink(1).MinWidth(0)
							if ui.Button(c, "Change…").Tooltip("Choose the folder the project folder is created in").Clicked() {
								a.Go(func() func() {
									path := PickFolder("Where should the project folder be created?")
									return func() {
										if path != "" {
											s.newParent = path
										}
									}
								})
							}
						})
					})
					Field(c, "Raw data folder (optional)", func() {
						ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
							ui.Text(c, nameOr(s.dataFolder, "Not chosen — you can add data later")).FontSize(12).SingleLine().Grow(1).Shrink(1).MinWidth(0)
							if s.dataFolder != "" && ui.Button(c, "Clear").Clicked() {
								s.dataFolder = ""
							}
							if ui.Button(c, "Choose…").Tooltip("The folder with your FASTQ files and reference FASTA; nothing in it is changed").Clicked() {
								a.Go(func() func() {
									path := PickFolder("Choose the folder with your raw data")
									return func() {
										if path != "" {
											s.dataFolder = path
											if strings.TrimSpace(s.newName) == "" {
												s.newName = filepath.Base(path)
											}
										}
									}
								})
							}
						})
					})
					if s.dataFolder != "" {
						ui.Text(c, "After the project is created, its files are matched to samples and references for you to review.").FontSize(12).TextColor(t.TextMuted)
					}
					name := strings.TrimSpace(s.newName)
					if name != "" && s.newParent != "" {
						ui.Text(c, "Creates the folder "+filepath.Join(s.newParent, ProjectFolderName(name))).FontSize(12).TextColor(t.TextMuted)
					}
					ui.Row(c).Gap(8).Justify(ui.End).AlignItems(ui.Center).Children(func() {
						ready := name != "" && s.newParent != "" && !s.creating && !s.preparing
						// Say what the disabled button waits for.
						switch {
						case s.creating:
						case s.preparing:
							ui.Text(c, "Waiting for the runtime to be ready.").FontSize(12).TextColor(t.TextMuted)
						case name == "":
							ui.Text(c, "Enter a project name to create it.").FontSize(12).TextColor(t.TextMuted)
						case s.newParent == "":
							ui.Text(c, "Choose where to save it.").FontSize(12).TextColor(t.TextMuted)
						}
						if ui.PrimaryButton(c, "Create project").Disabled(!ready).Clicked() {
							a.create(newProjectPath(s.newParent, name), name)
						}
					})
				}).Grow(1).Basis(360)
				card(c, "Open an existing project", func() {
					ui.Text(c, "Continue a project made earlier with RNAxRay Desktop. Choose its folder — the one whose name ends in "+
						ProjectSuffix+" and that contains project.json.").FontSize(12).TextColor(t.TextMuted)
					ui.Row(c).Gap(8).Children(func() {
						if ui.PrimaryButton(c, "Choose project folder…").Disabled(s.preparing).Clicked() {
							a.Go(func() func() {
								path := PickFolder("Open a RNAxRay project folder (" + ProjectSuffix + ")")
								return func() {
									if path != "" {
										s.openPath = path
										a.Open(path)
									}
								}
							})
						}
					})
					ui.Collapsible(c.Key("open-paste"), "Or paste a folder path", &s.pasteOpen, func() {
						ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
							ui.TextInput(c.Key("open-path"), &s.openPath).Placeholder("/path/to/study" + ProjectSuffix).Label("Project folder").Grow(1)
							if ui.Button(c, "Open").Disabled(s.preparing || strings.TrimSpace(s.openPath) == "").Clicked() {
								a.Open(s.openPath)
							}
						})
					})
				}).Grow(1).Basis(360)
			})
			if s.status != "" {
				ui.Text(c, s.status).TextColor(t.TextMuted)
			}
			card(c, "Recent projects", func() {
				if len(a.recent) == 0 {
					ui.Text(c, "None yet. Projects you create or open are listed here for one-click reopening.").FontSize(12).TextColor(t.TextMuted)
				}
				for _, r := range a.recent {
					r := r
					ui.Row(c.Key(r.Path)).Gap(8).Children(func() {
						ui.Column(c).Grow(1).Shrink(1).MinWidth(0).Children(func() {
							if brandLink(c, nameOr(r.Name, filepath.Base(r.Path))).Disabled(s.preparing).Clicked() {
								a.Open(r.Path)
							}
							ui.Text(c, r.Path).FontSize(12).TextColor(t.TextMuted).SingleLine()
						})
						if ui.Button(c, "Forget").Tooltip("Remove from this list (the folder is not deleted)").Clicked() {
							a.forget(r.Path)
						}
					})
				}
			})
			if s.runtime != "" {
				ui.Text(c, s.runtime).FontSize(12).TextColor(t.TextMuted)
			}
		})
	})
}

func (a *App) create(path, name string) {
	a.start.creating = true
	a.start.status = "Creating " + path + "…"
	a.Go(func() func() {
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			if entries, _ := os.ReadDir(path); len(entries) > 0 {
				return func() {
					a.start.creating = false
					a.start.status = "The folder is not empty; choose an empty or new folder."
				}
			}
		}
		_, err := a.B.CreateProject(path, name, "")
		return func() {
			a.start.creating = false
			if err != nil {
				a.start.status = fmt.Sprintf("Could not create the project: %v", err)
				return
			}
			a.start.newName = ""
			if a.start.dataFolder != "" {
				a.pendingFolder, a.start.dataFolder = a.start.dataFolder, ""
				a.Page = "data"
			}
			a.Open(path)
		}
	})
}

// card is a titled panel.
func card(c *ui.Context, title string, body func()) ui.Element {
	t := c.Theme()
	return ui.Column(c).Padding(16).Gap(10).Radius(8).Background(t.Background).Border(1, t.Border).Children(func() {
		if title != "" {
			ui.Text(c, title).FontSize(16).Bold()
		}
		body()
	})
}

// Card is the shared panel for pages.
func Card(c *ui.Context, title string, body func()) ui.Element { return card(c, title, body) }

func nameOr(name, fallback string) string {
	if name != "" {
		return name
	}
	return fallback
}

// ---- preferences

type prefsState struct {
	loading bool
	err     string
	cpu     float64
	memMB   float64
	sysCPU  float64
	sysMem  float64
	custom  bool
	// cpuModel, performance/efficiency cores (0: unknown) and samples
	// measured for time estimates.
	cpuModel           string
	perfCores, effCore float64
	measured           float64
	// External public-data lookups (EVIDENCE.md).
	lookup       bool
	lookupNotice bool // the first-enable notice is open
	testing      bool
	testMsg      string
	testErr      bool
}

func (a *App) openPrefs() {
	a.prefsOpen = true
	a.prefs = prefsState{loading: true}
	a.Go(func() func() {
		got, err := a.B.Preferences()
		return func() { a.applyPrefs(got, err) }
	})
}

func (a *App) applyPrefs(got core.Obj, err error) {
	a.prefs.loading = false
	if err != nil {
		a.prefs.err = err.Error()
		return
	}
	budget, _ := got["budget"].(map[string]any)
	system, _ := got["system"].(map[string]any)
	a.prefs.cpu, _ = budget["cpu"].(float64)
	a.prefs.memMB, _ = budget["mem_mb"].(float64)
	a.prefs.sysCPU, _ = system["cpus"].(float64)
	a.prefs.sysMem, _ = system["mem_mb"].(float64)
	a.prefs.custom, _ = got["custom_budget"].(bool)
	a.prefs.cpuModel, _ = system["cpu_model"].(string)
	a.prefs.perfCores, _ = system["performance_cores"].(float64)
	a.prefs.effCore, _ = system["efficiency_cores"].(float64)
	speed, _ := got["speed"].(map[string]any)
	a.prefs.measured, _ = speed["measured_samples"].(float64)
	a.prefs.lookup, _ = got["external_lookup"].(bool)
	a.setLookup(got)
}

func (a *App) prefsDialog(c *ui.Context) {
	t := c.Theme()
	p := &a.prefs
	ui.Modal(c, &a.prefsOpen, func() {
		ui.Column(c).Width(420).Gap(12).Children(func() {
			ui.Text(c, "Preferences").FontSize(18).Bold()
			switch {
			case p.loading:
				ui.Text(c, "Loading…").TextColor(t.TextMuted)
				return
			case p.err != "":
				ui.Text(c, p.err).TextColor(t.Danger)
				return
			}
			ui.Text(c, "Resource budget for tasks").Bold()
			ui.Text(c, "This computer: "+describeComputer(p)).FontSize(12).TextColor(t.TextMuted)
			speed := "Time estimates use a typical rate until a sample has finished on this computer."
			if p.measured > 0 {
				speed = fmt.Sprintf("Time estimates use the speed measured on this computer (%s).", dataPlural(int(p.measured), "finished sample", "finished samples"))
			}
			ui.Text(c, "By default tasks may use every CPU and 75% of the memory; tasks that do not fit wait in the queue. "+
				"One sample maps at a time with all CPUs while the next prepares its reads. "+speed).FontSize(12).TextColor(t.TextMuted)
			maxCPU := p.sysCPU
			if maxCPU < 1 {
				maxCPU = 1
			}
			ui.Row(c).Gap(8).Children(func() {
				ui.Text(c, "CPUs").Width(120)
				ui.NumberInput(c.Key("cpu"), &p.cpu, 1, maxCPU, 1).Width(120)
			})
			ui.Row(c).Gap(8).Children(func() {
				ui.Text(c, "Memory (MB)").Width(120)
				ui.NumberInput(c.Key("mem"), &p.memMB, 512, maxFloat(p.sysMem, 512), 256).Width(160)
			})
			ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
				if ui.Button(c, "Use defaults").Disabled(!p.custom).Clicked() {
					a.savePrefs(core.Obj{"budget": nil})
				}
				if ui.PrimaryButton(c, "Save").Clicked() {
					a.savePrefs(core.Obj{"budget": core.Obj{"cpu": int(p.cpu), "mem_mb": int(p.memMB)}})
				}
			})
			ui.Divider(c)
			a.lookupPrefs(c)
		})
	})
}

// lookupPrefs is the external public-data lookup switch, its first-enable
// notice, the connection test and the cache.
func (a *App) lookupPrefs(c *ui.Context) {
	t := c.Theme()
	p := &a.prefs
	ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
		on := p.lookup
		ui.Switch(c.Key("pref-lookup"), &on).Label("Allow external public-data lookups (RNAcentral)").OnClick(func() {
			switch {
			case on && !p.lookup:
				p.lookupNotice = true // enabled only after the notice
			case !on && p.lookup:
				p.lookupNotice = false
				a.savePrefs(core.Obj{"external_lookup": false})
				p.lookup = false
			}
		})
		ui.Text(c, "Allow external public-data lookups (RNAcentral)").Bold().Grow(1).Shrink(1).MinWidth(0)
	})
	ui.Text(c, "Off by default. Used by Structure › Related research.").FontSize(12).TextColor(t.TextMuted)
	if p.lookupNotice {
		ui.Column(c.Key("pref-lookup-notice")).Gap(8).Padding(10).Radius(8).Background(t.Warning.Alpha(0.12)).Children(func() {
			ui.Text(c, "Before you turn this on").Bold()
			ui.Text(c, "When you look up related research, RNAxRay sends the public identifier and species you type — nothing else — "+
				"to RNAcentral (EMBL-EBI) over the internet. No sequence, structure, read file or project data is sent.").FontSize(12)
			ui.Text(c, "Even public identifiers can reveal what you are working on. Summaries are AI-generated background, "+
				"not a validation of your results.").FontSize(12)
			ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
				if ui.Button(c, "Not now").Clicked() {
					p.lookupNotice = false
				}
				if ui.PrimaryButton(c, "Turn on").Clicked() {
					p.lookupNotice = false
					p.lookup = true
					a.savePrefs(core.Obj{"external_lookup": true})
				}
			})
		})
	}
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		if ui.Button(c, "Test connection").Disabled(!p.lookup || p.testing).Tooltip("Start the RNAcentral helper on this computer and list its tools (RNAcentral itself is not contacted)").Clicked() {
			a.testLookup()
		}
		if ui.Button(c, "Clear cache").Tooltip("Forget the RNAcentral answers kept on this computer").Clicked() {
			a.Go(func() func() {
				err := a.B.ClearEvidenceCache()
				return func() {
					if err != nil {
						a.Toast("Could not clear the cache: %v", err)
						return
					}
					a.Toast("RNAcentral cache cleared")
				}
			})
		}
		if p.testing {
			ui.Spinner(c).Label("Testing")
		}
	})
	if p.testMsg != "" {
		color := t.TextMuted
		if p.testErr {
			color = t.Danger
		}
		ui.Text(c, p.testMsg).FontSize(12).TextColor(color)
	}
}

func (a *App) testLookup() {
	p := &a.prefs
	p.testing, p.testMsg, p.testErr = true, "", false
	a.Go(func() func() {
		status, err := a.B.EvidenceStatus(true)
		return func() {
			p.testing = false
			if err != nil {
				p.testMsg, p.testErr = "Connection failed: "+err.Error(), true
				return
			}
			// The helper is a local process; RNAcentral itself is first asked
			// by a lookup, so this says nothing about the internet connection.
			state := "RNAcentral helper ready on this computer"
			if status.Connected {
				state = "RNAcentral helper running on this computer"
			}
			p.testMsg = fmt.Sprintf("%s · RNAcentral MCP server %s · MCP SDK %s · %s · tools: %s. This does not contact RNAcentral; the first lookup does.", state,
				nameOr(status.ServerPackageVersion, "unknown"), nameOr(status.SDKVersion, "unknown"),
				nameOr(status.AdapterVersion, "unknown adapter"), nameOr(strings.Join(status.Tools, ", "), "none"))
		}
	})
}

func (a *App) savePrefs(patch core.Obj) {
	a.Go(func() func() {
		got, err := a.B.SetPreferences(patch)
		return func() {
			if err != nil {
				a.Toast("Could not save preferences: %v", err)
				return
			}
			a.applyPrefs(got, nil)
			a.Toast("Preferences saved")
		}
	})
}

func maxFloat(x, y float64) float64 {
	if x > y {
		return x
	}
	return y
}

// describeComputer is "Apple M1 Pro · 10 CPUs (8 performance + 2 efficiency) · 32 GB memory".
func describeComputer(p *prefsState) string {
	var parts []string
	if p.cpuModel != "" {
		parts = append(parts, p.cpuModel)
	}
	cpus := fmt.Sprintf("%.0f CPUs", p.sysCPU)
	if p.perfCores > 0 {
		cpus += fmt.Sprintf(" (%.0f performance + %.0f efficiency)", p.perfCores, p.effCore)
	}
	parts = append(parts, cpus)
	if p.sysMem > 0 {
		parts = append(parts, fmt.Sprintf("%.0f GB memory", p.sysMem/1024))
	}
	return strings.Join(parts, " · ") + "."
}
