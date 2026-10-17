// RNAxRay Desktop: native MyGo shell over the bundled Python runtime
// (desktop/runtime/bridge.py). See MYGO_DESKTOP_PLAN.md.
package main

import (
	"fmt"
	"log"
	"path/filepath"
	goruntime "runtime"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"rnaxraydesktop/core"
	"rnaxraydesktop/views"
)

// repoRoot is the source checkout, for development builds without a
// bundled runtime (desktop/app/main.go -> repository root).
func repoRoot() string {
	_, file, _, ok := goruntime.Caller(0)
	if !ok {
		return ""
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

// resolveRuntime finds the runtime: the packed archive of a packaged app
// (unpacked into the cache on first launch, which can take a while), else
// a runtime directory (development). It runs off the main thread.
func resolveRuntime(resources, cache string) (*core.Bridge, error) {
	archive, digest, ok, err := core.PackedRuntime(resources)
	if err != nil {
		return nil, err
	}
	if ok {
		return core.UnpackRuntime(archive, digest, filepath.Join(cache, "runtime"))
	}
	return core.ResolveBridge(resources, mygo.IsDev() || !mygo.App.IsPackaged(), repoRoot())
}

// detectSummary is one line about the runtime for the start page.
func detectSummary(response core.Obj) string {
	result, _ := response["result"].(map[string]any)
	platform, _ := result["platform"].(map[string]any)
	return fmt.Sprintf("Runtime: %v %v · Python %v", platform["os"], platform["architecture"], platform["python"])
}

func main() {
	resources, _ := mygo.App.Path(mygo.PathResources)
	cache, _ := mygo.App.Path(mygo.PathCache)
	userData, _ := mygo.App.Path(mygo.PathUserData)
	logs, _ := mygo.App.Path(mygo.PathLogs)
	// The evidence worker (EVIDENCE.md) starts on the first external
	// lookup and stops with the other sidecars in service.Shutdown.
	options := core.ServiceOptions{PreferencesPath: filepath.Join(userData, "preferences.json")}
	if cache != "" && logs != "" {
		options.EvidenceCacheDir = filepath.Join(cache, "evidence")
		options.EvidenceLogDir = logs
	}
	service := core.NewService(nil, options)
	service.SetPending(true)
	app := views.New(service, nil, userData)
	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:     "RNAxRay Desktop",
			Width:     1280,
			Height:    820,
			MinWidth:  900,
			MinHeight: 600,
			StateKey:  "main",
			Content:   ui.View(app.View),
		})
		app.SetPoster(win)
		if _, digest, ok, _ := core.PackedRuntime(resources); ok && !core.RuntimeReady(filepath.Join(cache, "runtime"), digest) {
			app.SetRuntimePreparing()
		}
		// Resolve (and on first launch unpack) the runtime, detect it, then
		// compile the CPLfold kernels so the first fold does not wait.
		go func() {
			bridge, err := resolveRuntime(resources, cache)
			var rt *core.Runtime
			if err == nil {
				// Files linked on this computer (trust.py): a project from
				// elsewhere cannot make Python open other absolute paths.
				rt, err = core.NewRuntimeWith(*bridge, cache,
					core.TrustedLinksEnv+"="+filepath.Join(userData, "linked-files.json"))
			}
			if err != nil {
				service.SetPending(false)
				win.Update(func() { app.SetRuntimeStatus("", err.Error()) })
				return
			}
			service.SetRuntime(rt)
			detected, err := service.Detect()
			win.Update(func() {
				if err != nil {
					app.SetRuntimeStatus("", err.Error())
					return
				}
				app.SetRuntimeStatus(detectSummary(detected), "")
			})
			if err == nil {
				service.WarmUp()
			}
		}()
	})
	mygo.App.OnWillQuit(func(*mygo.QuitEvent) {
		app.Stop()
		service.Shutdown()
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
