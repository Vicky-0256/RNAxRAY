package core

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const echoScript = `
import json, sys, time
for line in sys.stdin:
    msg = json.loads(line)
    req = msg["request"]
    if req.get("op") == "sleep":
        time.sleep(req["seconds"])
    if req.get("op") == "die":
        sys.stderr.write("boom\n"); sys.stderr.flush(); sys.exit(3)
    print("noise that is not json", flush=True)
    print(json.dumps({"id": msg["id"], "response": {"ok": True, "echo": req}}), flush=True)
`

// testPython is the interpreter for the stand-in sidecar: the staged
// runtime when present, else python3 (or python, as on Windows) on PATH.
func testPython(t *testing.T) string {
	t.Helper()
	staged := pythonIn(filepath.Join(repoRoot(t), "desktop", "resources", "native"))
	if isFile(staged) {
		return staged
	}
	for _, name := range []string{"python3", "python"} {
		if path, err := exec.LookPath(name); err == nil {
			return path
		}
	}
	t.Skip("python is not available")
	return ""
}

func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func echo(t *testing.T, timeout time.Duration) *Sidecar {
	s := NewSidecar(SidecarSpec{Name: "test", Program: testPython(t), Args: []string{"-c", echoScript},
		Dir: os.TempDir(), Env: []string{"PYTHONDONTWRITEBYTECODE=1"}, Timeout: timeout})
	t.Cleanup(s.Shutdown)
	return s
}

func decode(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestRoundtripReusesProcess(t *testing.T) {
	s := echo(t, 20*time.Second)
	first, err := s.Request(map[string]any{"op": "a", "n": 1})
	if err != nil {
		t.Fatal(err)
	}
	if decode(t, first)["echo"].(map[string]any)["n"] != float64(1) {
		t.Fatalf("unexpected %s", first)
	}
	pid := s.pid()
	second, err := s.Request(map[string]any{"op": "b"})
	if err != nil {
		t.Fatal(err)
	}
	if decode(t, second)["echo"].(map[string]any)["op"] != "b" || s.pid() != pid {
		t.Fatalf("second request %s, pid %d -> %d", second, pid, s.pid())
	}
}

func TestTimeoutKillsAndRestarts(t *testing.T) {
	s := echo(t, 1500*time.Millisecond)
	if _, err := s.Request(map[string]any{"op": "warm"}); err != nil {
		t.Fatal(err)
	}
	pid := s.pid()
	_, err := s.Request(map[string]any{"op": "sleep", "seconds": 30})
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected a timeout, got %v", err)
	}
	if s.pid() != 0 {
		t.Fatal("timed-out sidecar is still registered")
	}
	again, err := s.Request(map[string]any{"op": "after"})
	if err != nil {
		t.Fatal(err)
	}
	if decode(t, again)["echo"].(map[string]any)["op"] != "after" || s.pid() == pid {
		t.Fatalf("restart failed: %s", again)
	}
}

func TestCrashReportsStderrAndRestarts(t *testing.T) {
	s := echo(t, 20*time.Second)
	_, err := s.Request(map[string]any{"op": "die"})
	if err == nil || !strings.Contains(err.Error(), "exited unexpectedly") || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("expected crash with stderr, got %v", err)
	}
	ok, err := s.Request(map[string]any{"op": "x"})
	if err != nil || decode(t, ok)["ok"] != true {
		t.Fatalf("restart after crash: %v %s", err, ok)
	}
	s.Shutdown()
	if _, err := s.Request(map[string]any{"op": "x"}); err == nil {
		t.Fatal("request after shutdown succeeded")
	}
}

// TestRealBridgeServeRoundtrip runs desktop.runtime.bridge --serve through Runtime.
func TestRealBridgeServeRoundtrip(t *testing.T) {
	root := repoRoot(t)
	if !isFile(filepath.Join(root, "desktop", "runtime", "bridge.py")) {
		t.Skip("repository layout not available")
	}
	r, err := NewRuntime(Bridge{Root: root, Python: testPython(t)}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Shutdown)
	if _, err := r.Call(Control, map[string]any{"operation": "nope"}); err == nil || !strings.Contains(err.Error(), "unsupported") {
		t.Fatalf("expected unsupported operation error, got %v", err)
	}
	detect, err := r.Call(Control, map[string]any{"operation": "detect"})
	if err != nil || detect["ok"] != true {
		t.Fatalf("detect: %v %v", err, detect)
	}
}

func TestResolveBridge(t *testing.T) {
	dir := t.TempDir()
	if b, err := BundledBridge(dir); b != nil || err != nil {
		t.Fatalf("empty resources: %v %v", b, err)
	}
	native := filepath.Join(dir, "native")
	if err := os.MkdirAll(filepath.Join(native, "desktop", "runtime"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(native, "desktop", "runtime", "bridge.py"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := BundledBridge(dir); err == nil || !strings.Contains(err.Error(), "Bundled Python is missing") {
		t.Fatalf("missing python: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(pythonIn(native)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pythonIn(native), nil, 0o755); err != nil {
		t.Fatal(err)
	}
	b, err := ResolveBridge(dir, false, "")
	if err != nil || b.Root != native {
		t.Fatalf("bundled: %v %v", b, err)
	}
	t.Setenv("RNAXRAY_REPOSITORY_ROOT", "/elsewhere")
	if b, _ := ResolveBridge(dir, false, ""); b.Root != native {
		t.Fatal("packaged build honored RNAXRAY_REPOSITORY_ROOT")
	}
	if b, _ := ResolveBridge(dir, true, ""); b.Root != "/elsewhere" {
		t.Fatal("dev build ignored RNAXRAY_REPOSITORY_ROOT")
	}
	if _, err := ResolveBridge(t.TempDir(), false, ""); err == nil {
		t.Fatal("missing runtime accepted")
	}
}

func TestBridgeResult(t *testing.T) {
	if _, err := bridgeResult(json.RawMessage(`{"ok":false,"error":"bad thing"}`)); err == nil || err.Error() != "bad thing" {
		t.Fatalf("got %v", err)
	}
	if out, err := bridgeResult(json.RawMessage(`{"ok":false,"status":"unavailable"}`)); err != nil || out["status"] != "unavailable" {
		t.Fatalf("unavailable must pass through: %v", err)
	}
	if _, err := bridgeResult(json.RawMessage(`[1]`)); err == nil {
		t.Fatal("non-object accepted")
	}
}
