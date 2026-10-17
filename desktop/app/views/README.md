# Native views: conventions

The desktop interface is built with MyGo's `ui` package (v0.4.8, see
`go list -m -f '{{.Dir}}' github.com/egoist/mygo` → `docs/ui/`, `ui/doc.go`).
Read `../.agents/skills/mygo-maintenance/SKILL.md` first: it lists the
lifetime rules (never store `ui.Element` in state, keys before
construction, slow work off the main thread).

## Structure

- `app.go`: `App`, the window state: `B` (`core.Backend`), `Project`
  (`model.Project`), `Tasks`, `Selected` (reference, gene, selection key
  `c:<condition>` / `s:<sample>`), navigation (`Navigate(page, options)`,
  `NavOptions`), async work (`Go`), tasks (`StartTask`, `CancelTask`,
  `ResumeTask`, `OnTaskFinished`), `Toast`, `RefreshProject`.
- `shell.go`: the window (`App.View`), top bar, sidebar, tasks drawer, and
  shared bits: `Card`, `Field`, `PageHeader`, `StatusChip`, `ProgressBar`,
  `FormatNumber`, `FormatTime`.
- `start.go`: start page, preferences, and the dialog hooks `PickFolder`,
  `PickFiles`, `PickSave` (variables, so tests replace them).
- One file per page: `data.go`, `qc.go`, `explore*.go`, `compare.go`,
  `structure.go`, `report.go`. A page is a type implementing `Page`
  (`View(c)`, `Show()`), registered from the file's `init()`:

  ```go
  func init() { RegisterPageFactory("compare", func(a *App) Page { return &comparePage{a: a} }) }
  ```

- `../widgets`: `Heatmap` (contact maps, canvas-backed, zoom/pan/pick) and
  `Arcs` (arc diagrams, two structures above/below).

## Rules

- **Never block the main thread.** Every `a.B.*` call goes in `a.Go(func()
  func() { ...; return func() { /* apply to state */ } })`. The returned
  function runs on the main thread and may touch page state.
- Guard results against a changed project: capture `a.Project.Path` before
  the call and compare it in the apply function.
- Page state lives in the page struct (and survives navigation). `Show()`
  is called when the page appears or the project opens: load data there,
  not in `View`.
- Use the theme's colors (`c.Theme()`: `Text`, `TextMuted`, `Background`,
  `Surface`, `Border`, `Accent`, `Success`, `Danger`, ...) so light and dark
  mode both work. Condition A is red (`ui.RGB(214, 69, 65)`), B blue
  (`ui.RGB(43, 108, 196)`).
- Show numbers with `FormatNumber`; times with `FormatTime`.
- Long lists use `ui.Table` / `ui.List` (they build only visible rows).
- English UI text, short and plain, as the existing pages.

## Tests

- `fake_test.go` has `fakeBackend` answering from `testdata/` fixtures
  captured from a real project (ZIKV: conditions SUB, AFR, BRA; reference
  ZAFR), plus `openFixture(t)`, `waitFlush(a)` and `snapshot(t, tt, name)`.
  Put page-specific fixtures in `testdata/<page>_*.json` and set them on
  the fake in your own test file (`f.queries[op] = ...`, `f.ops[op] = ...`).
- Drive views with `ui.NewTester(a.View, 1100, 720)`: `Click`, `Type`,
  `HasText`, `Texts`, `Frame`.
- `RNAXRAY_SNAPSHOT_DIR=<dir> go test ./views/` writes PNG snapshots: look at
  them (light and `tt.SetDark(true)`) before calling a page done.
- `CGO_ENABLED=0 go test ./...` and `go tool mygo vet .` must pass.
