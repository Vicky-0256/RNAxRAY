package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

const (
	ControlTimeout = 120 * time.Second
	ComputeTimeout = 900 * time.Second
)

// AppVersion is reported to Python as RNAXRAY_APP_VERSION.
var AppVersion = "0.1.4"

// Bridge locates the Python runtime: the repository root holding
// desktop/runtime/bridge.py and the interpreter that runs it.
type Bridge struct {
	Root   string
	Python string
}

func pythonIn(root string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(root, "python", "python.exe")
	}
	return filepath.Join(root, "python", "bin", "python3")
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// BundledBridge is <resources>/native when it holds the staged runtime;
// nil when the runtime is not bundled, an error when it is incomplete.
func BundledBridge(resources string) (*Bridge, error) {
	root := filepath.Join(resources, "native")
	if !isFile(filepath.Join(root, "desktop", "runtime", "bridge.py")) {
		return nil, nil
	}
	python := pythonIn(root)
	if !isFile(python) {
		return nil, fmt.Errorf("Bundled Python is missing at %s. Rebuild or reinstall the desktop runtime.", python)
	}
	return &Bridge{Root: root, Python: python}, nil
}

// ResolveBridge picks the runtime. Development builds honor
// RNAXRAY_REPOSITORY_ROOT / RNAXRAY_PYTHON and fall back to the staged runtime in
// the repository (desktop/resources/native); packaged builds only use the
// bundled one.
func ResolveBridge(resources string, dev bool, repo string) (*Bridge, error) {
	if dev {
		if root := os.Getenv("RNAXRAY_REPOSITORY_ROOT"); root != "" {
			python := os.Getenv("RNAXRAY_PYTHON")
			if python == "" {
				python = "python3"
			}
			return &Bridge{Root: root, Python: python}, nil
		}
	}
	if b, err := BundledBridge(resources); b != nil || err != nil {
		return b, err
	}
	if dev && repo != "" {
		if b, err := BundledBridge(filepath.Join(repo, "desktop", "resources")); b != nil || err != nil {
			return b, err
		}
	}
	return nil, errors.New("Native runtime is not bundled. Rebuild or reinstall RNAxRay Desktop with the runtime resources.")
}

// Lane picks the sidecar: short project operations or analysis queries.
type Lane int

const (
	Control Lane = iota
	Compute
)

// Runtime is the resolved bridge plus its two persistent sidecars (C1).
type Runtime struct {
	Bridge     Bridge
	ComputeEnv []string // for the compute sidecar and task children
	control    *Sidecar
	compute    *Sidecar
}

// NewRuntime checks the bridge and prepares (but does not start) both
// sidecars. cacheDir receives the numba cache; it may be empty.
func NewRuntime(b Bridge, cacheDir string) (*Runtime, error) {
	return NewRuntimeWith(b, cacheDir)
}

// TrustedLinksEnv names the file listing the files linked on this computer
// (desktop/runtime/trust.py): with it, Python refuses other absolute paths
// a project names. The app sets it; tests and the command line do not.
const TrustedLinksEnv = "RNAXRAY_TRUSTED_LINKS"

// NewRuntimeWith is NewRuntime with extra environment ("KEY=value") for
// every Python process: both sidecars and the task children.
func NewRuntimeWith(b Bridge, cacheDir string, env ...string) (*Runtime, error) {
	if !isFile(filepath.Join(b.Root, "desktop", "runtime", "bridge.py")) {
		return nil, fmt.Errorf("Desktop runtime bridge is missing under %s", b.Root)
	}
	base := []string{
		"RNAXRAY_APP_VERSION=" + AppVersion,
		"PYTHONUNBUFFERED=1",
		"PYTHONIOENCODING=utf-8",
		// Never write .pyc into the (signed, possibly read-only) app bundle.
		"PYTHONDONTWRITEBYTECODE=1",
	}
	base = append(base, env...)
	compute := append([]string(nil), base...)
	if cacheDir != "" {
		numba := filepath.Join(cacheDir, "numba")
		if os.MkdirAll(numba, 0o755) == nil {
			compute = append(compute, "NUMBA_CACHE_DIR="+numba)
		}
		// One Bowtie2 mapping at a time on this computer (sample_run.py),
		// so a sample admitted early only overlaps its read preparation.
		compute = append(compute, MapSlotEnv+"="+filepath.Join(cacheDir, "map.lock"))
	}
	spec := func(name string, env []string, timeout time.Duration) SidecarSpec {
		return SidecarSpec{
			Name: name, Program: b.Python, Dir: b.Root, Env: env, Timeout: timeout,
			Args: []string{"-m", "desktop.runtime.bridge", "--repo-root", b.Root, "--serve"},
		}
	}
	return &Runtime{
		Bridge:     b,
		ComputeEnv: compute,
		control:    NewSidecar(spec("control", base, ControlTimeout)),
		compute:    NewSidecar(spec("compute", compute, ComputeTimeout)),
	}, nil
}

// Call sends a request on a lane. Like the Tauri shell, a response with
// ok=false is an error unless its status is "unavailable", which the UI
// shows itself.
func (r *Runtime) Call(lane Lane, request map[string]any) (map[string]any, error) {
	sidecar := r.control
	if lane == Compute {
		sidecar = r.compute
	}
	raw, err := sidecar.Request(request)
	if err != nil {
		return nil, err
	}
	return bridgeResult(raw)
}

func bridgeResult(raw json.RawMessage) (map[string]any, error) {
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("bridge response is not an object: %w", err)
	}
	ok, _ := parsed["ok"].(bool)
	status, _ := parsed["status"].(string)
	if !ok && status != "unavailable" {
		if message, _ := parsed["error"].(string); message != "" {
			return nil, errors.New(message)
		}
		return nil, errors.New("desktop runtime operation failed")
	}
	return parsed, nil
}

// Shutdown stops both sidecars (application exit).
func (r *Runtime) Shutdown() {
	r.control.Shutdown()
	r.compute.Shutdown()
}
