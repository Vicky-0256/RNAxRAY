package core

// Preferences (contract R6): the resource budget, the UI theme and whether
// external public-data lookups are allowed (EVIDENCE.md), stored in
// preferences.json in the application config directory. Unknown keys are
// preserved so later preferences can share the file.
//
// Physical memory is read without cgo: sysctl hw.memsize on macOS,
// /proc/meminfo on Linux and GlobalMemoryStatusEx on Windows.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

// PrefsFileName is the preferences file inside the config directory.
const PrefsFileName = "preferences.json"

const (
	// fallbackTotalMB is used when physical memory cannot be determined.
	fallbackTotalMB uint64 = 8192
	minMemMB        uint64 = 256
)

// Themes accepted by the "theme" preference; "system" follows the OS.
var Themes = []string{"system", "light", "dark"}

// Budget is a resource amount: the global scheduler budget or one task's claim.
type Budget struct {
	CPU   uint32 `json:"cpu"`
	MemMB uint64 `json:"mem_mb"`
}

// SystemCPUs is the number of logical CPUs available to the process.
func SystemCPUs() uint32 {
	if n := runtime.NumCPU(); n > 0 {
		return uint32(n)
	}
	return 1
}

var memOnce = sync.OnceValues(func() (uint64, bool) {
	bytes, ok := physicalBytes()
	mb := bytes / (1024 * 1024)
	return mb, ok && mb > 0
})

// SystemMemMB is the total physical memory in MiB, if the platform reports it.
func SystemMemMB() (uint64, bool) { return memOnce() }

// parseMeminfo reads MemTotal (in bytes) from Linux /proc/meminfo text.
func parseMeminfo(text string) (uint64, bool) {
	scanner := bufio.NewScanner(strings.NewReader(text))
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "MemTotal:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0, false
		}
		kb, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return 0, false
		}
		return kb * 1024, true
	}
	return 0, false
}

// DefaultBudget is all cores and 75% of physical memory.
func DefaultBudget() Budget {
	total, ok := SystemMemMB()
	if !ok {
		total = fallbackTotalMB
	}
	return Budget{CPU: SystemCPUs(), MemMB: max(total*3/4, minMemMB)}
}

func maxMemMB() uint64 {
	total, ok := SystemMemMB()
	if !ok {
		total = fallbackTotalMB
	}
	return max(total, minMemMB)
}

// readPrefs is the stored object; a missing or corrupt file is empty.
func readPrefs(path string) map[string]any {
	stored := map[string]any{}
	if path == "" {
		return stored
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return stored
	}
	var value any
	if json.Unmarshal(data, &value) != nil {
		return stored
	}
	if object, ok := value.(map[string]any); ok {
		return object
	}
	return stored
}

func validateBudget(b Budget) (Budget, error) {
	cpus := SystemCPUs()
	if b.CPU == 0 || b.CPU > cpus {
		return b, fmt.Errorf("budget cpu must be between 1 and %d", cpus)
	}
	limit := maxMemMB()
	if b.MemMB < minMemMB || b.MemMB > limit {
		return b, fmt.Errorf("budget mem_mb must be between %d and %d", minMemMB, limit)
	}
	return b, nil
}

// asUint converts a JSON-ish number (float64 from encoding/json, or a Go
// integer from native callers) to a non-negative integer no larger than limit.
func asUint(value any, limit uint64) (uint64, bool) {
	switch v := value.(type) {
	case float64:
		if v < 0 || v != math.Trunc(v) || v > float64(limit) {
			return 0, false
		}
		return uint64(v), true
	case json.Number:
		n, err := strconv.ParseUint(v.String(), 10, 64)
		return n, err == nil && n <= limit
	case int:
		return uint64(v), v >= 0 && uint64(v) <= limit
	case int32:
		return uint64(v), v >= 0 && uint64(v) <= limit
	case int64:
		return uint64(v), v >= 0 && uint64(v) <= limit
	case uint:
		return uint64(v), uint64(v) <= limit
	case uint32:
		return uint64(v), uint64(v) <= limit
	case uint64:
		return v, v <= limit
	}
	return 0, false
}

// storedBudget decodes a stored {cpu, mem_mb} (both required).
func storedBudget(value any) (Budget, bool) {
	object, ok := value.(map[string]any)
	if !ok {
		return Budget{}, false
	}
	cpu, ok1 := asUint(object["cpu"], math.MaxUint32)
	mem, ok2 := asUint(object["mem_mb"], math.MaxUint64)
	return Budget{CPU: uint32(cpu), MemMB: mem}, ok1 && ok2
}

// LoadBudget is the stored budget, or the default when absent or no longer
// valid (for example after moving the config to a smaller machine).
func LoadBudget(path string) Budget {
	if b, ok := storedBudget(readPrefs(path)["budget"]); ok {
		if b, err := validateBudget(b); err == nil {
			return b
		}
	}
	return DefaultBudget()
}

// LoadTheme is the stored theme, "system" when absent or unknown.
func LoadTheme(path string) string {
	if theme, ok := readPrefs(path)["theme"].(string); ok && validTheme(theme) {
		return theme
	}
	return "system"
}

// LoadExternalLookup is the "external_lookup" preference: whether the
// evidence worker may query RNAcentral. Absent or invalid means false.
func LoadExternalLookup(path string) bool {
	on, _ := readPrefs(path)["external_lookup"].(bool)
	return on
}

func validTheme(theme string) bool {
	for _, t := range Themes {
		if t == theme {
			return true
		}
	}
	return false
}

// DescribePreferences is the response of preferences_get / preferences_set.
func DescribePreferences(path string) Obj {
	stored := readPrefs(path)
	budget, custom := stored["budget"]
	var mem any
	if mb, ok := SystemMemMB(); ok {
		mem = mb
	}
	return normalize(Obj{
		"ok":              true,
		"path":            path,
		"budget":          LoadBudget(path),
		"custom_budget":   custom && budget != nil,
		"theme":           LoadTheme(path),
		"external_lookup": LoadExternalLookup(path),
		"defaults":        Obj{"budget": DefaultBudget(), "theme": "system", "external_lookup": false},
		"system":          systemInfo(mem),
		"speed":           Obj{"measured_samples": len(LoadPerf(perfPath(path)))},
	})
}

// ApplyPreferences applies a patch `{budget?: {cpu?, mem_mb?} | null,
// theme?: "system"|"light"|"dark" | null, external_lookup?: bool | null}`, writes the file atomically and
// returns the new budget. Omitted fields keep their value; null resets to
// the default. Unknown keys and invalid values are rejected without
// touching the file.
func ApplyPreferences(path string, patch Obj) (Budget, error) {
	if path == "" {
		return Budget{}, errors.New("cannot resolve the application config directory")
	}
	for key := range patch {
		if key != "budget" && key != "theme" && key != "external_lookup" {
			return Budget{}, fmt.Errorf("unknown preference %q", key)
		}
	}
	stored := readPrefs(path)
	if raw, present := patch["budget"]; present {
		if raw == nil {
			delete(stored, "budget")
		} else {
			fields, ok := raw.(map[string]any)
			if !ok {
				return Budget{}, errors.New("budget must be an object or null")
			}
			next := LoadBudget(path)
			for key, value := range fields {
				switch key {
				case "cpu":
					if value == nil {
						continue
					}
					n, ok := asUint(value, math.MaxUint32)
					if !ok {
						return Budget{}, errors.New("budget cpu must be a non-negative integer")
					}
					next.CPU = uint32(n)
				case "mem_mb":
					if value == nil {
						continue
					}
					n, ok := asUint(value, math.MaxUint64)
					if !ok {
						return Budget{}, errors.New("budget mem_mb must be a non-negative integer")
					}
					next.MemMB = n
				default:
					return Budget{}, fmt.Errorf("unknown budget field %q", key)
				}
			}
			valid, err := validateBudget(next)
			if err != nil {
				return Budget{}, err
			}
			stored["budget"] = valid
		}
	}
	if raw, present := patch["theme"]; present {
		if raw == nil {
			delete(stored, "theme")
		} else if theme, ok := raw.(string); ok && validTheme(theme) {
			stored["theme"] = theme
		} else {
			return Budget{}, fmt.Errorf("theme must be one of %s", strings.Join(Themes, ", "))
		}
	}
	if raw, present := patch["external_lookup"]; present {
		if raw == nil {
			delete(stored, "external_lookup")
		} else if on, ok := raw.(bool); ok {
			stored["external_lookup"] = on
		} else {
			return Budget{}, errors.New("external_lookup must be true, false or null")
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return Budget{}, fmt.Errorf("cannot create config directory: %w", err)
	}
	data, err := json.MarshalIndent(stored, "", "  ")
	if err != nil {
		return Budget{}, err
	}
	pending := path + ".tmp"
	if err := os.WriteFile(pending, data, 0o644); err != nil {
		return Budget{}, fmt.Errorf("cannot save preferences: %w", err)
	}
	// os.Rename replaces the destination on every platform (MoveFileEx on Windows).
	if err := os.Rename(pending, path); err != nil {
		return Budget{}, fmt.Errorf("cannot save preferences: %w", err)
	}
	return LoadBudget(path), nil
}

// normalize round-trips a value through JSON so callers always see the
// shapes the UI would (map[string]any, []any, float64 numbers).
func normalize(value Obj) Obj {
	data, err := json.Marshal(value)
	if err != nil {
		return value
	}
	var out Obj
	if json.Unmarshal(data, &out) != nil {
		return value
	}
	return out
}

// systemInfo describes this computer for Preferences.
func systemInfo(mem any) Obj {
	name, performance, efficiency := cpuInfo()
	info := Obj{"cpus": SystemCPUs(), "mem_mb": mem, "cpu_model": name}
	if performance > 0 {
		info["performance_cores"] = performance
		info["efficiency_cores"] = efficiency
	}
	return info
}
