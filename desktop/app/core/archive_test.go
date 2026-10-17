package core

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

type entry struct {
	name, body, link string
	mode             int64
	dir              bool
}

func makeArchive(t *testing.T, dir string, entries []entry) (string, string) {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		h := &tar.Header{Name: e.name, Mode: e.mode}
		switch {
		case e.dir:
			h.Typeflag = tar.TypeDir
		case e.link != "":
			h.Typeflag, h.Linkname = tar.TypeSymlink, e.link
		default:
			h.Typeflag, h.Size = tar.TypeReg, int64(len(e.body))
		}
		if h.Mode == 0 {
			h.Mode = 0o644
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			tw.Write([]byte(e.body))
		}
	}
	tw.Close()
	gz.Close()
	path := filepath.Join(dir, RuntimeArchive)
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(buf.Bytes())
	digest := hex.EncodeToString(sum[:])
	os.WriteFile(filepath.Join(dir, RuntimeArchiveSHA256), []byte(digest+"  native.tar.gz\n"), 0o644)
	return path, digest
}

func runtimeEntries() []entry {
	python := "python/bin/python3"
	if runtime.GOOS == "windows" {
		python = "python/python.exe"
	}
	return []entry{
		{name: "desktop/runtime/", dir: true},
		{name: "desktop/runtime/bridge.py", body: "# bridge"},
		{name: python + ".11", body: "interpreter", mode: 0o755},
		{name: python, link: filepath.Base(python) + ".11"},
		{name: "python/lib/numpy/.dylibs/libopenblas.dylib", body: "blas"},
	}
}

func TestUnpackRuntimeKeepsHiddenFilesAndLinksAndReuses(t *testing.T) {
	resources, cache := t.TempDir(), t.TempDir()
	makeArchive(t, resources, runtimeEntries())
	archive, digest, ok, err := PackedRuntime(resources)
	if err != nil || !ok {
		t.Fatalf("packed runtime: %v %v", ok, err)
	}
	if RuntimeReady(cache, digest) {
		t.Fatal("ready before unpacking")
	}
	b, err := UnpackRuntime(archive, digest, cache)
	if err != nil {
		t.Fatal(err)
	}
	dir := UnpackedRuntimeDir(cache, digest)
	if b.Root != filepath.Join(dir, "native") || !RuntimeReady(cache, digest) {
		t.Fatalf("bridge %+v", b)
	}
	if body, err := os.ReadFile(filepath.Join(b.Root, "python/lib/numpy/.dylibs/libopenblas.dylib")); err != nil || string(body) != "blas" {
		t.Fatalf("hidden file: %q %v", body, err)
	}
	if body, err := os.ReadFile(b.Python); err != nil || string(body) != "interpreter" {
		t.Fatalf("interpreter through the link: %q %v", body, err)
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(b.Python)
		if info.Mode()&0o100 == 0 {
			t.Fatal("interpreter lost its executable bit")
		}
	}
	// A second call reuses the unpacked tree and finishes cleaning up: an
	// older version (left by a quit mid-removal) and an abandoned unpack
	// go, a recent unpack (maybe another instance's) stays.
	os.MkdirAll(filepath.Join(cache, "runtime-0000000000000000"), 0o755)
	abandoned, recent := filepath.Join(cache, ".runtime-unpack-1"), filepath.Join(cache, ".runtime-unpack-2")
	os.MkdirAll(abandoned, 0o755)
	os.MkdirAll(recent, 0o755)
	long := time.Now().Add(-2 * staleUnpack)
	os.Chtimes(abandoned, long, long)
	marker := filepath.Join(b.Root, "desktop/runtime/bridge.py")
	os.WriteFile(marker, []byte("# kept"), 0o644)
	if _, err := UnpackRuntime(archive, digest, cache); err != nil {
		t.Fatal(err)
	}
	if body, _ := os.ReadFile(marker); string(body) != "# kept" {
		t.Fatal("a ready runtime was unpacked again")
	}
	if isDir(filepath.Join(cache, "runtime-0000000000000000")) || isDir(abandoned) || !isDir(recent) {
		t.Fatal("leftovers not cleaned on a reuse launch")
	}
	makeArchive(t, resources, append(runtimeEntries(), entry{name: "extra.txt", body: "v2"}))
	archive, digest2, _, _ := PackedRuntime(resources)
	if _, err := UnpackRuntime(archive, digest2, cache); err != nil {
		t.Fatal(err)
	}
	left, _ := filepath.Glob(filepath.Join(cache, "runtime-*"))
	if len(left) != 1 || left[0] != UnpackedRuntimeDir(cache, digest2) {
		t.Fatalf("old runtimes not removed: %v", left)
	}
}

func TestUnpackRuntimeRejectsCorruptAndUnsafeArchives(t *testing.T) {
	for name, entries := range map[string][]entry{
		"escaping path": append(runtimeEntries(), entry{name: "../evil", body: "x"}),
		"escaping link": append(runtimeEntries(), entry{name: "python/evil", link: "../../../etc/passwd"}),
		"absolute link": append(runtimeEntries(), entry{name: "python/evil", link: "/etc/passwd"}),
	} {
		resources, cache := t.TempDir(), t.TempDir()
		archive, digest := makeArchive(t, resources, entries)
		if _, err := UnpackRuntime(archive, digest, cache); err == nil || !strings.Contains(err.Error(), "unsafe") {
			t.Fatalf("%s: %v", name, err)
		}
		if left, _ := filepath.Glob(filepath.Join(cache, "*")); len(left) != 0 {
			t.Fatalf("%s left %v", name, left)
		}
	}
	resources, cache := t.TempDir(), t.TempDir()
	archive, _ := makeArchive(t, resources, runtimeEntries())
	if _, err := UnpackRuntime(archive, strings.Repeat("0", 64), cache); err == nil || !strings.Contains(err.Error(), "corrupt") {
		t.Fatalf("bad digest accepted: %v", err)
	}
	if RuntimeReady(cache, strings.Repeat("0", 64)) {
		t.Fatal("a corrupt archive was marked ready")
	}
	if _, _, ok, err := PackedRuntime(t.TempDir()); ok || err != nil {
		t.Fatal("no archive must mean ok=false without error")
	}
	empty := t.TempDir()
	os.WriteFile(filepath.Join(empty, RuntimeArchive), []byte("x"), 0o644)
	if _, _, _, err := PackedRuntime(empty); err == nil {
		t.Fatal("an archive without its digest file was accepted")
	}
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
