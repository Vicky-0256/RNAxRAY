package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func ptr[T any](v T) *T { return &v }

// assertJSON compares got with the JSON text want after normalizing both.
func assertJSON(t *testing.T, got any, want string) {
	t.Helper()
	data, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var a, b any
	if err := json.Unmarshal(data, &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &b); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("got %s\nwant %s", data, want)
	}
}

// tempProject is a canonical directory holding an empty project.json.
func tempProject(t *testing.T) string {
	t.Helper()
	dir, err := canonicalPath(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "project.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// testScheduler has a fixed budget (default when cpu is 0); its tasks are
// shut down when the test ends.
func testScheduler(t *testing.T, cpu uint32, mem uint64) *Scheduler {
	s := NewScheduler()
	if cpu > 0 {
		s.SetBudget(Budget{cpu, mem})
	}
	t.Cleanup(s.ShutdownAll)
	return s
}

func waitFor(t *testing.T, s *Scheduler, id, project string, done func(Obj) bool) Obj {
	t.Helper()
	var snap Obj
	for range 250 {
		var err error
		if snap, err = s.Status(id, project); err != nil {
			t.Fatal(err)
		}
		if done(snap) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	return snap
}

func finished(s Obj) bool { _, ok := s["finished_at"].(string); return ok }

func big() Budget { return Budget{4, 8000} }
