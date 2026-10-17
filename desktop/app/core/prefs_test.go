package core

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestDefaultsAreSane(t *testing.T) {
	budget := DefaultBudget()
	if budget.CPU < 1 || budget.CPU != SystemCPUs() {
		t.Fatalf("cpu %d, system %d", budget.CPU, SystemCPUs())
	}
	if budget.MemMB < minMemMB {
		t.Fatalf("mem %d", budget.MemMB)
	}
	total, ok := SystemMemMB()
	if ok && budget.MemMB != max(total*3/4, minMemMB) {
		t.Fatalf("mem %d of total %d", budget.MemMB, total)
	}
	if (runtime.GOOS == "darwin" || runtime.GOOS == "linux" || runtime.GOOS == "windows") && !ok {
		t.Fatal("physical memory is unknown")
	}
	// Plausible: between 256 MiB and 64 TiB.
	if ok && (total < 256 || total > 64<<20) {
		t.Fatalf("implausible physical memory %d MiB", total)
	}
	if runtime.GOOS == "darwin" {
		out, err := exec.Command("/usr/sbin/sysctl", "-n", "hw.memsize").Output()
		if err != nil {
			t.Fatal(err)
		}
		bytes, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
		if total != bytes/(1024*1024) {
			t.Fatalf("hw.memsize %d bytes, read %d MiB", bytes, total)
		}
	}
	if b, ok := parseMeminfo("MemTotal:       16384 kB\nMemFree: 1 kB\n"); !ok || b != 16384*1024 {
		t.Fatalf("parseMeminfo %d %v", b, ok)
	}
	if _, ok := parseMeminfo("nothing"); ok {
		t.Fatal("parseMeminfo accepted garbage")
	}
}

func readJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestPreferencesRoundTripAndReset(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config", PrefsFileName)
	if LoadBudget(path) != DefaultBudget() {
		t.Fatal("missing file is not the default budget")
	}
	if DescribePreferences(path)["custom_budget"] != false {
		t.Fatal("missing file reported a custom budget")
	}
	// Unknown keys written by other features survive updates.
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"theme":"dark","other":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	b, err := ApplyPreferences(path, Obj{"budget": Obj{"cpu": 1, "mem_mb": 512}})
	if err != nil || b != (Budget{1, 512}) {
		t.Fatalf("apply: %v %v", b, err)
	}
	if LoadBudget(path) != (Budget{1, 512}) {
		t.Fatal("budget not stored")
	}
	described := DescribePreferences(path)
	assertJSON(t, described["budget"], `{"cpu":1,"mem_mb":512}`)
	if described["custom_budget"] != true || described["theme"] != "dark" {
		t.Fatalf("described %v", described)
	}
	// Partial patch keeps the other field (JSON numbers decode as float64).
	if b, err := ApplyPreferences(path, Obj{"budget": map[string]any{"mem_mb": float64(1024)}}); err != nil || b != (Budget{1, 1024}) {
		t.Fatalf("partial: %v %v", b, err)
	}
	stored := readJSON(t, path)
	if stored["theme"] != "dark" || stored["other"] != float64(1) {
		t.Fatalf("unknown keys lost: %v", stored)
	}
	// Out-of-range values are rejected and leave the file untouched.
	for _, bad := range []Obj{
		{"budget": Obj{"cpu": 0}},
		{"budget": Obj{"cpu": SystemCPUs() + 1}},
		{"budget": Obj{"mem_mb": 1}},
		{"budget": Obj{"cpu": -1}},
		{"budget": Obj{"cpu": 1.5}},
		{"budget": Obj{"gpu": 1}},
		{"budget": "x"},
		{"theme": "pink"},
		{"colour": "x"},
	} {
		if _, err := ApplyPreferences(path, bad); err == nil {
			t.Fatalf("accepted %v", bad)
		}
	}
	if LoadBudget(path) != (Budget{1, 1024}) || LoadTheme(path) != "dark" {
		t.Fatal("rejected patch changed the file")
	}
	// Theme: set, then null resets to "system".
	if _, err := ApplyPreferences(path, Obj{"theme": "light"}); err != nil || LoadTheme(path) != "light" {
		t.Fatalf("theme: %v", err)
	}
	if _, err := ApplyPreferences(path, Obj{"theme": nil}); err != nil || LoadTheme(path) != "system" {
		t.Fatalf("theme reset: %v", err)
	}
	if LoadBudget(path) != (Budget{1, 1024}) {
		t.Fatal("theme patch changed the budget")
	}
	// null resets the budget to the defaults.
	if b, err := ApplyPreferences(path, Obj{"budget": nil}); err != nil || b != DefaultBudget() {
		t.Fatalf("reset: %v %v", b, err)
	}
	stored = readJSON(t, path)
	if _, ok := stored["budget"]; ok || stored["other"] != float64(1) {
		t.Fatalf("after reset: %v", stored)
	}
	if DescribePreferences(path)["custom_budget"] != false {
		t.Fatal("reset budget still custom")
	}
	// A corrupt file falls back to the defaults.
	if err := os.WriteFile(path, []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if LoadBudget(path) != DefaultBudget() || LoadTheme(path) != "system" {
		t.Fatal("corrupt file is not the default")
	}
	if _, err := ApplyPreferences("", Obj{}); err == nil {
		t.Fatal("saved without a path")
	}
}

func TestSystemInfoNamesTheProcessor(t *testing.T) {
	info := systemInfo(nil)
	t.Logf("%v", info)
	if runtime.GOOS == "darwin" && runtime.GOARCH == "arm64" {
		if info["cpu_model"] == "" || info["performance_cores"].(int) < 1 {
			t.Fatalf("Apple silicon not described: %v", info)
		}
		if info["performance_cores"].(int)+info["efficiency_cores"].(int) != int(SystemCPUs()) {
			t.Fatalf("core counts do not add up: %v", info)
		}
	}
}
