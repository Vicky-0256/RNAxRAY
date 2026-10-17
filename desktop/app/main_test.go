package main

import "testing"

func TestDetectSummary(t *testing.T) {
	got := detectSummary(map[string]any{"result": map[string]any{
		"platform": map[string]any{"os": "macos", "architecture": "arm64", "python": "3.11.17"}}})
	if got != "Runtime: macos arm64 · Python 3.11.17" {
		t.Fatalf("got %q", got)
	}
}
