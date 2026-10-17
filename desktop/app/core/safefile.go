package core

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// A project folder may come from someone else, so the files the app reads
// and rewrites in it are untrusted: a planted symlink must not redirect a
// write outside it, and a huge file or a FIFO must not hang the app.

// maxProjectFile is the largest status, progress, result or card file read.
const maxProjectFile = 16 << 20

// writeFileAtomic writes path through a new temporary file beside it
// (created exclusively, so never through an existing file or symlink),
// then renames it over path (which replaces a symlink, not its target).
func writeFileAtomic(path string, data []byte) error {
	pending, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	name := pending.Name()
	_, err = pending.Write(data)
	if err == nil {
		err = pending.Chmod(0o644)
	}
	if closeErr := pending.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(name, path)
	}
	if err != nil {
		_ = os.Remove(name)
	}
	return err
}

// isRegularFile: path itself (not a symlink's target) is a regular file.
func isRegularFile(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular()
}

// readProjectFile reads a regular file (not a symlink, FIFO or device) of
// at most maxProjectFile bytes.
func readProjectFile(path string) ([]byte, error) {
	if info, err := os.Lstat(path); err != nil {
		return nil, err
	} else if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", filepath.Base(path))
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxProjectFile+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxProjectFile {
		return nil, fmt.Errorf("%s is larger than %d MB", filepath.Base(path), maxProjectFile>>20)
	}
	return data, nil
}
