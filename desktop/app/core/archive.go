package core

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The staged runtime ships as one archive (desktop/scripts/pack-runtime.py)
// because MyGo leaves hidden files out of resources, and the runtime needs
// some (numpy/.dylibs on macOS, numpy/.libs on Windows). It is unpacked
// once into the cache, keyed by the archive's SHA-256.
const (
	RuntimeArchive       = "native.tar.gz"
	RuntimeArchiveSHA256 = "native.tar.gz.sha256"
	runtimeComplete      = ".complete"
)

// PackedRuntime reports the archive under resources and its expected
// SHA-256 (from the side file), or ok=false when the app has none.
func PackedRuntime(resources string) (archive, digest string, ok bool, err error) {
	archive = filepath.Join(resources, RuntimeArchive)
	if !isFile(archive) {
		return "", "", false, nil
	}
	raw, err := os.ReadFile(filepath.Join(resources, RuntimeArchiveSHA256))
	if err != nil {
		return "", "", false, fmt.Errorf("the bundled runtime has no %s: %w", RuntimeArchiveSHA256, err)
	}
	digest = strings.ToLower(strings.TrimSpace(strings.Fields(string(raw) + " ")[0]))
	if len(digest) != 64 {
		return "", "", false, fmt.Errorf("%s is not a SHA-256", RuntimeArchiveSHA256)
	}
	return archive, digest, true, nil
}

// UnpackedRuntimeDir is where the archive with this digest is unpacked
// (the runtime itself is its native/ subdirectory, as in resources).
func UnpackedRuntimeDir(cache, digest string) string {
	return filepath.Join(cache, "runtime-"+digest[:16])
}

// RuntimeReady reports whether the archive with this digest is unpacked.
func RuntimeReady(cache, digest string) bool {
	return isFile(filepath.Join(UnpackedRuntimeDir(cache, digest), runtimeComplete))
}

// UnpackRuntime makes sure the archive is unpacked under cache and returns
// the bridge in it. A finished unpack is reused; a new one is verified
// against digest, written to a temporary directory and renamed into place,
// and older runtime-* directories are removed.
func UnpackRuntime(archive, digest, cache string) (*Bridge, error) {
	dir := UnpackedRuntimeDir(cache, digest)
	if !RuntimeReady(cache, digest) {
		if err := os.MkdirAll(cache, 0o755); err != nil {
			return nil, err
		}
		tmp, err := os.MkdirTemp(cache, ".runtime-unpack-")
		if err != nil {
			return nil, err
		}
		defer os.RemoveAll(tmp)
		if err := extractVerified(archive, digest, filepath.Join(tmp, "native")); err != nil {
			return nil, err
		}
		if err := os.WriteFile(filepath.Join(tmp, runtimeComplete), []byte(digest+"\n"), 0o644); err != nil {
			return nil, err
		}
		_ = os.RemoveAll(dir) // an incomplete earlier attempt
		if err := os.Rename(tmp, dir); err != nil {
			return nil, err
		}
	}
	// On every launch, so a removal cut short by quitting is finished later.
	removeOldRuntimes(cache, filepath.Base(dir))
	b, err := BundledBridge(dir)
	if err == nil && b == nil {
		err = errors.New("the bundled runtime archive has no desktop/runtime/bridge.py")
	}
	return b, err
}

// staleUnpack is how old an unfinished unpack must be before it is
// removed (a younger one may belong to another instance still unpacking).
const staleUnpack = time.Hour

// removeOldRuntimes deletes other runtime versions and unpacks abandoned
// by a quit or crash.
func removeOldRuntimes(cache, keep string) {
	entries, _ := os.ReadDir(cache)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		old := strings.HasPrefix(e.Name(), "runtime-") && e.Name() != keep
		if strings.HasPrefix(e.Name(), ".runtime-unpack-") {
			if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > staleUnpack {
				old = true
			}
		}
		if old {
			_ = os.RemoveAll(filepath.Join(cache, e.Name()))
		}
	}
}

// extractVerified unpacks a .tar.gz into dest while hashing it, and fails
// (leaving dest to be discarded) when the digest differs or an entry would
// land outside dest.
func extractVerified(archive, digest, dest string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	hash := sha256.New()
	gz, err := gzip.NewReader(io.TeeReader(f, hash))
	if err != nil {
		return fmt.Errorf("the bundled runtime archive is unreadable: %w", err)
	}
	root, err := filepath.Abs(dest)
	if err != nil {
		return err
	}
	inside := func(path string) bool {
		rel, err := filepath.Rel(root, path)
		return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
	}
	tr := tar.NewReader(gz)
	var links []*tar.Header
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("the bundled runtime archive is damaged: %w", err)
		}
		name := filepath.FromSlash(h.Name)
		if absoluteEntry(h.Name) {
			return fmt.Errorf("unsafe path in the runtime archive: %q", h.Name)
		}
		target := filepath.Join(root, name)
		if !inside(target) && target != root {
			return fmt.Errorf("unsafe path in the runtime archive: %q", h.Name)
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(h.Mode)&0o755|0o600)
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, tr); err != nil {
				out.Close()
				return err
			}
			if err := out.Close(); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if absoluteEntry(h.Linkname) || !inside(filepath.Join(filepath.Dir(target), filepath.FromSlash(h.Linkname))) {
				return fmt.Errorf("unsafe link in the runtime archive: %q -> %q", h.Name, h.Linkname)
			}
			links = append(links, h) // after the files, so Windows can copy targets
		default:
			return fmt.Errorf("unsupported entry in the runtime archive: %q", h.Name)
		}
	}
	// Drain to the end so the whole file is hashed.
	if _, err := io.Copy(io.Discard, f); err != nil {
		return err
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != digest {
		return fmt.Errorf("the bundled runtime archive is corrupt (SHA-256 %s, expected %s); reinstall RNAxRay Desktop", got, digest)
	}
	for _, h := range links {
		target := filepath.Join(root, filepath.FromSlash(h.Name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := makeLink(h.Linkname, target); err != nil {
			return err
		}
	}
	return nil
}

// absoluteEntry reports archive names and link targets that are absolute
// on any platform: "/x" (not absolute for Windows' filepath), "C:x",
// backslashes, or UNC paths.
func absoluteEntry(name string) bool {
	return name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, "\\") ||
		strings.Contains(name, ":") || filepath.IsAbs(name)
}

// makeLink creates a symlink, or copies the target file where symlinks are
// not allowed (Windows without developer mode).
func makeLink(linkname, target string) error {
	if err := os.Symlink(linkname, target); err == nil {
		return nil
	}
	src := filepath.Join(filepath.Dir(target), filepath.FromSlash(linkname))
	info, err := os.Stat(src)
	if err != nil || info.IsDir() {
		return fmt.Errorf("cannot create %s -> %s", target, linkname)
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
