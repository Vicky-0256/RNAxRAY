package views

import "strings"

// shortErrorMax is the longest error a page or toast shows.
const shortErrorMax = 160

// ShortError is one readable line of a backend error for a page or toast:
// for a Python traceback, what precedes it and its exception line, else
// the first line, cut at shortErrorMax characters. The full text stays in
// the task drawer and the logs.
func ShortError(text string) string {
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, strings.TrimRight(line, "\r "))
		}
	}
	if len(lines) == 0 {
		return ""
	}
	out := strings.TrimSpace(lines[0])
	const marker = "Traceback (most recent call last):"
	for i, line := range lines {
		if at := strings.Index(line, marker); at >= 0 {
			// What precedes the traceback, then its exception line.
			head := lines[0]
			if i == 0 {
				head = line[:at]
			}
			last := ""
			if i < len(lines)-1 {
				last = lines[len(lines)-1]
			}
			out = strings.TrimSpace(strings.TrimSpace(head) + " " + strings.TrimSpace(last))
			break
		}
	}
	if r := []rune(out); len(r) > shortErrorMax {
		out = string(r[:shortErrorMax]) + "…"
	}
	return out
}
