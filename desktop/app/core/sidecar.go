// Package core is the desktop shell's link to the Python runtime: the two
// persistent bridge sidecars, the task scheduler, preferences and the
// operation allowlists. It mirrors desktop/src-tauri (contract C1 and the
// R6 scheduler) so the Python side is unchanged.
package core

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const stderrTail = 4000

// SidecarSpec describes one persistent Python bridge process.
type SidecarSpec struct {
	Name    string
	Program string
	Args    []string
	Dir     string
	Env     []string // appended to os.Environ(), or the whole environment with CleanEnv
	Timeout time.Duration
	// CleanEnv gives the process only Env, not the shell's environment.
	CleanEnv bool
	// Group starts the process as the leader of its own process group (a
	// new process group on Windows); a timeout, Cancel or Shutdown kills
	// the whole tree, children included.
	Group bool
}

// Errors a request ends with when the sidecar was killed on purpose.
var (
	ErrSidecarTimeout   = errors.New("sidecar timed out")
	ErrSidecarCancelled = errors.New("request cancelled")
)

type proc struct {
	cmd   *exec.Cmd
	group bool
	stdin io.WriteCloser
	lines chan string
	done  chan struct{} // closed when stdout reaches EOF
	// quit is closed when the process is stopped: the reader then drops
	// lines instead of waiting for a request to take them.
	quit     chan struct{}
	quitOnce sync.Once
	mu       sync.Mutex
	stderr   []byte
}

func (p *proc) stopReading() { p.quitOnce.Do(func() { close(p.quit) }) }

func (p *proc) tail() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return strings.TrimSpace(string(p.stderr))
}

func (p *proc) exited() bool {
	select {
	case <-p.done:
		return true
	default:
		return false
	}
}

func (p *proc) kill() {
	p.stopReading()
	if p.cmd.Process != nil {
		if p.group {
			_ = killTree(p.cmd.Process.Pid)
		}
		_ = p.cmd.Process.Kill()
	}
	_ = p.cmd.Wait()
}

// shutdown closes stdin (the bridge exits on EOF) and kills it after 500 ms.
func (p *proc) shutdown() {
	p.stopReading()
	_ = p.stdin.Close()
	select {
	case <-p.done:
	case <-time.After(500 * time.Millisecond):
	}
	p.kill()
}

var errShuttingDown = errors.New("desktop runtime is shutting down")

// Sidecar speaks the newline JSON protocol of `bridge --serve`:
// stdin `{"id":N,"request":{...}}`, stdout `{"id":N,"response":{...}}`.
// Requests are serialized; the process restarts after a crash or EOF and is
// killed and restarted when a response exceeds the timeout.
type Sidecar struct {
	spec   SidecarSpec
	mu     sync.Mutex
	proc   *proc
	nextID uint64
	closed atomic.Bool
	// cancel is the running request's cancel channel (guarded by cancelMu,
	// not mu, which the request holds while it waits).
	cancelMu sync.Mutex
	cancel   chan struct{}
}

func NewSidecar(spec SidecarSpec) *Sidecar {
	return &Sidecar{spec: spec, nextID: 1}
}

func (s *Sidecar) spawn() (*proc, error) {
	cmd := exec.Command(s.spec.Program, s.spec.Args...)
	cmd.Dir = s.spec.Dir
	if s.spec.CleanEnv {
		cmd.Env = append([]string{}, s.spec.Env...)
	} else {
		cmd.Env = append(os.Environ(), s.spec.Env...)
	}
	hideWindow(cmd)
	if s.spec.Group {
		newProcessGroup(cmd)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("could not start desktop Python %s sidecar (%s): %w", s.spec.Name, s.spec.Program, err)
	}
	p := &proc{cmd: cmd, group: s.spec.Group, stdin: stdin, lines: make(chan string, 16), done: make(chan struct{}),
		quit: make(chan struct{})}
	go func() {
		reader := bufio.NewReaderSize(stdout, 1<<20)
		for {
			line, err := reader.ReadString('\n')
			if line != "" {
				select {
				case p.lines <- strings.TrimRight(line, "\r\n"):
				case <-p.quit:
				}
			}
			if err != nil {
				close(p.done)
				return
			}
		}
	}()
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stderr.Read(buf)
			if n > 0 {
				p.mu.Lock()
				p.stderr = append(p.stderr, buf[:n]...)
				if len(p.stderr) > stderrTail {
					p.stderr = append([]byte(nil), p.stderr[len(p.stderr)-stderrTail:]...)
				}
				p.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	return p, nil
}

// Request sends one request and returns the raw `response` object.
func (s *Sidecar) Request(request any) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return nil, errShuttingDown
	}
	if s.proc != nil && s.proc.exited() {
		s.proc.kill()
		s.proc = nil
	}
	id := s.nextID
	s.nextID++
	line, err := json.Marshal(map[string]any{"id": id, "request": request})
	if err != nil {
		return nil, fmt.Errorf("could not encode bridge request: %w", err)
	}
	line = append(line, '\n')
	// A write failure means the request never reached Python, so one
	// restart-and-retry is safe even for non-idempotent operations.
	for attempt := 0; ; attempt++ {
		if s.proc == nil {
			p, err := s.spawn()
			if err != nil {
				return nil, err
			}
			s.proc = p
		}
		if _, err := s.proc.stdin.Write(line); err == nil {
			break
		} else if attempt > 0 {
			s.proc.kill()
			s.proc = nil
			return nil, fmt.Errorf("could not send request to %s sidecar: %w", s.spec.Name, err)
		}
		s.proc.kill()
		s.proc = nil
	}
	cancel := make(chan struct{})
	s.cancelMu.Lock()
	s.cancel = cancel
	s.cancelMu.Unlock()
	defer func() {
		s.cancelMu.Lock()
		s.cancel = nil
		s.cancelMu.Unlock()
	}()
	// Shutdown sets closed before it cancels: either it sees this cancel
	// channel or this check sees closed.
	if s.closed.Load() {
		s.proc.kill()
		s.proc = nil
		return nil, errShuttingDown
	}
	timer := time.NewTimer(s.spec.Timeout)
	defer timer.Stop()
	for {
		select {
		case <-cancel:
			s.proc.kill()
			s.proc = nil
			return nil, fmt.Errorf("%s sidecar: %w", s.spec.Name, ErrSidecarCancelled)
		case text := <-s.proc.lines:
			if response, ok, err := match(text, id); ok {
				return response, err
			}
		case <-s.proc.done:
			// stdout is closed; the reader has queued everything it read.
			for {
				select {
				case text := <-s.proc.lines:
					if response, ok, err := match(text, id); ok {
						return response, err
					}
					continue
				default:
				}
				break
			}
			p := s.proc
			s.proc = nil
			time.Sleep(50 * time.Millisecond) // let the stderr reader collect the traceback
			detail := p.tail()
			p.kill()
			if detail == "" {
				detail = "no diagnostic output"
			}
			return nil, fmt.Errorf("%s sidecar exited unexpectedly: %s", s.spec.Name, detail)
		case <-timer.C:
			s.proc.kill()
			s.proc = nil
			return nil, fmt.Errorf("%s sidecar timed out after %d s and was restarted: %w", s.spec.Name, int(s.spec.Timeout.Seconds()), ErrSidecarTimeout)
		}
	}
}

// match decodes one stdout line; ok is false for non-protocol output and
// stale responses from earlier requests.
func match(text string, id uint64) (json.RawMessage, bool, error) {
	var message struct {
		ID       *uint64         `json:"id"`
		Response json.RawMessage `json:"response"`
	}
	if json.Unmarshal([]byte(text), &message) != nil || message.ID == nil || *message.ID != id {
		return nil, false, nil
	}
	if message.Response == nil {
		return nil, true, errors.New("bridge response is missing `response`")
	}
	return message.Response, true, nil
}

// Cancel ends the running request, if any, by killing the process (its
// process group with Group); the request returns ErrSidecarCancelled and
// the next one starts a new process.
func (s *Sidecar) Cancel() {
	s.cancelMu.Lock()
	defer s.cancelMu.Unlock()
	if s.cancel != nil {
		close(s.cancel)
		s.cancel = nil
	}
}

// Stop kills an idle process (the next request starts a new one); it waits
// for a running request to end first.
func (s *Sidecar) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.proc != nil {
		s.proc.shutdown()
		s.proc = nil
	}
}

// Shutdown stops the process and refuses later requests (application exit).
// A request in flight is cancelled rather than waited for.
func (s *Sidecar) Shutdown() {
	s.closed.Store(true)
	s.Cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.proc != nil {
		s.proc.shutdown()
		s.proc = nil
	}
}

// pid is for tests.
func (s *Sidecar) pid() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.proc == nil || s.proc.cmd.Process == nil {
		return 0
	}
	return s.proc.cmd.Process.Pid
}
