package core

// External evidence (desktop/spec/EVIDENCE.md): the EvidenceService owns a
// separate Python worker (`python -m desktop.runtime.evidence.worker
// --serve`, contract C1 framing) that speaks MCP to a fixed RNAcentral
// server child. Go decides everything that concerns the user's data: the
// external_lookup preference gate, identifier validation, identity
// confirmation, timeouts and cancellation (killing the worker's process
// group; the MCP child, in its own session, ends on its stdin's EOF), and
// the cards saved in
// <project>/evidence/. Only the public query fields (identifier, taxon)
// reach the worker; project paths, ids and structures never do.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	goruntime "runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"rnaxraydesktop/model"
)

// EvidenceTimeout bounds one worker call; the worker is killed after it.
const EvidenceTimeout = 45 * time.Second

// Evidence tools allowed in v1 (EVIDENCE.md).
const (
	ToolDescribe = "get_rna_description"
	ToolMap      = "map_rna_id"
)

// EvidenceTools are the only upstream tools the UI may reach.
var EvidenceTools = []string{ToolDescribe, ToolMap}

// evidenceAdapter names Go's own cards (identity_unconfirmed, local
// timeouts) whose worker never answered.
const evidenceAdapter = "rnaxray-evidence 1.0"

// ErrExternalLookupOff is returned by every worker call while the
// external_lookup preference is off.
var ErrExternalLookupOff = errors.New("External public-data lookups are off. Turn them on in Preferences to look up RNAcentral.")

const (
	maxDisplayText = 64 << 10
	maxRawText     = 1 << 20
	maxReviewNote  = 2000
)

var (
	rnaIDPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:|-]{0,99}$`)
	taxonIDPattern   = regexp.MustCompile(`^[0-9]{1,10}$`)
	taxonNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z .-]{0,63}$`)
	evidenceIDRe     = regexp.MustCompile(`^ev-[0-9a-f]{8,64}$`)
	digestPattern    = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	recordPattern    = regexp.MustCompile(`^(all|[0-9]{1,9}-[0-9]{1,9})$`)
)

// ValidateRNAID checks a public RNA identifier: 1-100 letters, digits and
// - _ . : |, starting with a letter or digit.
func ValidateRNAID(id string) error {
	if !rnaIDPattern.MatchString(id) {
		return errors.New("The identifier must be 1-100 letters, digits or - _ . : | (for example hsa-mir-21 or URS000075D341_9606).")
	}
	return nil
}

// ValidateTaxon checks a taxon: an NCBI taxonomy id (digits) or a short
// species name (letters, spaces, dots and hyphens, at most 64).
func ValidateTaxon(taxon string) error {
	if !taxonIDPattern.MatchString(taxon) && !taxonNamePattern.MatchString(taxon) {
		return errors.New("The species must be an NCBI taxonomy id such as 9606 or a short name such as Homo sapiens.")
	}
	return nil
}

// ValidateEvidenceID checks a card id (ev-<hex>).
func ValidateEvidenceID(id string) error {
	if !evidenceIDRe.MatchString(id) {
		return errors.New("invalid evidence id")
	}
	return nil
}

// EvidenceSpec is the worker's sidecar: the runtime's Python in the bridge
// root, the contract's environment allowlist only, its own process group.
func EvidenceSpec(b Bridge, cacheDir, logDir string) SidecarSpec {
	env := []string{
		"PYTHONDONTWRITEBYTECODE=1",
		"PYTHONUNBUFFERED=1",
		"PYTHONIOENCODING=utf-8",
		"RNAXRAY_EVIDENCE_CACHE=" + cacheDir,
		"RNAXRAY_EVIDENCE_LOG=" + logDir,
	}
	if goruntime.GOOS == "windows" {
		// Python cannot initialise sockets or randomness on Windows without it.
		if root := os.Getenv("SYSTEMROOT"); root != "" {
			env = append(env, "SYSTEMROOT="+root)
		}
	}
	return SidecarSpec{
		Name: "evidence", Program: b.Python, Dir: b.Root, Env: env, Timeout: EvidenceTimeout,
		Args: []string{"-m", "desktop.runtime.evidence.worker", "--serve"}, CleanEnv: true, Group: true,
	}
}

// EvidenceService runs the evidence worker lazily and keeps the project
// cards. It is safe for concurrent use; worker calls are serialized.
type EvidenceService struct {
	mu      sync.Mutex
	sidecar *Sidecar
	closed  bool
	// spec builds the worker's sidecar (tests replace it).
	spec func() (SidecarSpec, error)
	// enabled reads the external_lookup preference.
	enabled  func() bool
	cacheDir string
	// sealKeyPath is this computer's card seal key ("" seals nothing).
	sealKeyPath string
	now         func() time.Time
}

func newEvidenceService(spec func() (SidecarSpec, error), enabled func() bool, cacheDir string) *EvidenceService {
	return &EvidenceService{spec: spec, enabled: enabled, cacheDir: cacheDir, now: func() time.Time { return time.Now().UTC() }}
}

func (e *EvidenceService) worker() (*Sidecar, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return nil, errors.New("desktop runtime is shutting down")
	}
	if e.sidecar == nil {
		spec, err := e.spec()
		if err != nil {
			return nil, err
		}
		e.sidecar = NewSidecar(spec)
	}
	return e.sidecar, nil
}

// call sends one request; the response must be an object with ok=true.
func (e *EvidenceService) call(request Obj) (map[string]json.RawMessage, error) {
	if !e.enabled() {
		return nil, ErrExternalLookupOff
	}
	sidecar, err := e.worker()
	if err != nil {
		return nil, err
	}
	raw, err := sidecar.Request(request)
	if err != nil {
		return nil, err
	}
	var response map[string]json.RawMessage
	if err := json.Unmarshal(raw, &response); err != nil {
		return nil, fmt.Errorf("evidence worker answer is not an object: %w", err)
	}
	var ok bool
	_ = json.Unmarshal(response["ok"], &ok)
	if !ok {
		var message string
		_ = json.Unmarshal(response["error"], &message)
		if message == "" {
			message = "evidence worker operation failed"
		}
		return nil, errors.New(message)
	}
	return response, nil
}

// Cancel ends the running worker call (killing the worker and its MCP
// child); the next call starts a new worker.
func (e *EvidenceService) Cancel() {
	e.mu.Lock()
	sidecar := e.sidecar
	e.mu.Unlock()
	if sidecar != nil {
		sidecar.Cancel()
	}
}

// Shutdown cancels the running call and stops the worker (application exit).
func (e *EvidenceService) Shutdown() {
	e.mu.Lock()
	e.closed = true
	sidecar := e.sidecar
	e.mu.Unlock()
	if sidecar != nil {
		sidecar.Cancel()
		sidecar.Shutdown()
	}
}

// pid is for tests.
func (e *EvidenceService) pid() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.sidecar == nil {
		return 0
	}
	return e.sidecar.pid()
}

func newEvidenceID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return "ev-" + hex.EncodeToString(b[:])
}

func strPtr(s string) *string { return &s }

// localCard is a card Go makes itself when the worker did not answer
// (identity not confirmed, timeout, cancelled).
func (e *EvidenceService) localCard(tool, identifier, taxon, status, detail string, requested time.Time) model.EvidenceCard {
	card := model.EvidenceCard{
		SchemaVersion: "1.0", EvidenceID: newEvidenceID(), SourceProvider: "RNAcentral", SourceTool: tool,
		AdapterVersion: evidenceAdapter, ServerPackageVersion: "unknown", SDKVersion: "unknown",
		QueryIdentifier: identifier, IdentityConfirmation: "unconfirmed",
		RequestedAt: requested.Format(time.RFC3339), Status: status, ContentKind: "external_ai_summary",
		SourceIdentifiers: []string{}, CitationVerification: "not_checked", RelationToStructure: "background_only",
		Review: model.EvidenceReview{State: model.ReviewUnreviewed},
	}
	if tool == ToolMap {
		card.ContentKind = "database_metadata"
	}
	if taxon != "" {
		card.Taxon = strPtr(taxon)
	}
	if detail != "" {
		card.StatusDetail = strPtr(detail)
	}
	return card
}

// sourceURL keeps only RNAcentral https links.
func sourceURL(u *string) *string {
	if u == nil || !strings.HasPrefix(*u, "https://rnacentral.org/") || strings.ContainsAny(*u, " \t\r\n\"'<>\\") {
		return nil
	}
	return u
}

// sanitizeCard checks a card against the request that produced it and
// resets every field only the user or Go may set. A card that does not
// fit is replaced by an unexpected_response card.
func (e *EvidenceService) sanitizeCard(card model.EvidenceCard, tool, identifier, taxon string, requested time.Time) model.EvidenceCard {
	bad := func(detail string) model.EvidenceCard {
		return e.localCard(tool, identifier, taxon, model.EvidenceUnexpectedResponse, detail, requested)
	}
	if !slices.Contains(model.EvidenceStatuses, card.Status) {
		return bad("unknown status from the evidence worker")
	}
	if card.SourceTool != tool || card.QueryIdentifier != identifier {
		return bad("the evidence worker answered another query")
	}
	if card.TaxonText() != taxon {
		return bad("the evidence worker answered for another species")
	}
	if ValidateEvidenceID(card.EvidenceID) != nil {
		card.EvidenceID = newEvidenceID()
	}
	card.SourceURL = sourceURL(card.SourceURL)
	card.Binding = nil
	card.RawResponseLocalRef = nil
	card.CitationVerification = "not_checked"
	card.RelationToStructure = "background_only"
	card.Review = model.EvidenceReview{State: model.ReviewUnreviewed}
	if card.SourceIdentifiers == nil {
		card.SourceIdentifiers = []string{}
	}
	if tool == ToolDescribe {
		card.ContentKind = "external_ai_summary"
		card.IdentityConfirmation = "user_confirmed"
		if card.Status != model.EvidenceSuccess {
			card.DisplayText = nil
		}
	} else {
		card.ContentKind = "database_metadata"
		card.IdentityConfirmation = "unconfirmed"
	}
	if card.DisplayText != nil && len(*card.DisplayText) > maxDisplayText {
		card.DisplayText = strPtr((*card.DisplayText)[:maxDisplayText])
	}
	if card.Status == model.EvidenceSuccess && strings.TrimSpace(card.Text()) == "" {
		return bad("empty summary")
	}
	if card.RequestedAt == "" {
		card.RequestedAt = requested.Format(time.RFC3339)
	}
	return card
}

// lookup runs a describe or map_id request and turns local failures into
// cards (timeout, cancelled).
func (e *EvidenceService) lookup(request Obj, tool, identifier, taxon string) (model.EvidenceCard, error) {
	requested := e.now()
	response, err := e.call(request)
	switch {
	case errors.Is(err, ErrSidecarTimeout):
		return e.localCard(tool, identifier, taxon, model.EvidenceTimeout,
			fmt.Sprintf("no answer within %d s", int(EvidenceTimeout.Seconds())), requested), nil
	case errors.Is(err, ErrSidecarCancelled):
		return e.localCard(tool, identifier, taxon, model.EvidenceCancelled, "cancelled by the user", requested), nil
	case err != nil:
		return model.EvidenceCard{}, err
	}
	var card model.EvidenceCard
	if raw, ok := response["card"]; !ok || json.Unmarshal(raw, &card) != nil {
		return e.localCard(tool, identifier, taxon, model.EvidenceUnexpectedResponse, "the evidence worker sent no card", requested), nil
	}
	card = e.sanitizeCard(card, tool, identifier, taxon, requested)
	var rawText string
	if json.Unmarshal(response["raw_text"], &rawText) == nil && rawText != "" && len(rawText) <= maxRawText &&
		model.EvidenceDigest(rawText) == card.RawResponseDigest {
		card.RawText = rawText
	}
	return card, nil
}

// Status asks the worker for its versions; connect starts the MCP server
// and lists its tools (the connection test).
func (e *EvidenceService) Status(connect bool) (model.EvidenceStatus, error) {
	response, err := e.call(Obj{"operation": "status", "connect": connect})
	if err != nil {
		return model.EvidenceStatus{}, err
	}
	var status model.EvidenceStatus
	data, _ := json.Marshal(response)
	if err := json.Unmarshal(data, &status); err != nil {
		return model.EvidenceStatus{}, fmt.Errorf("unexpected status from the evidence worker: %w", err)
	}
	status.Enabled = true
	var tools []string
	for _, tool := range status.Tools {
		if slices.Contains(EvidenceTools, tool) {
			tools = append(tools, tool)
		}
	}
	status.Tools = tools
	return status, nil
}

// Describe is get_rna_description for a confirmed identifier.
func (e *EvidenceService) Describe(rnaID, taxon string, confirmed, force bool) (model.EvidenceCard, error) {
	rnaID, taxon = strings.TrimSpace(rnaID), strings.TrimSpace(taxon)
	if err := ValidateRNAID(rnaID); err != nil {
		return model.EvidenceCard{}, err
	}
	if taxon != "" {
		if err := ValidateTaxon(taxon); err != nil {
			return model.EvidenceCard{}, err
		}
	}
	if !e.enabled() {
		return model.EvidenceCard{}, ErrExternalLookupOff
	}
	taxon, check, err := checkTaxonByName(rnaID, taxon)
	if err != nil {
		return model.EvidenceCard{}, err
	}
	if !confirmed {
		return e.localCard(ToolDescribe, rnaID, taxon, model.EvidenceIdentityUnconfirmed,
			"confirm that the identifier and species refer to the RNA you study", e.now()), nil
	}
	request := Obj{"operation": "describe", "rna_id": rnaID, "taxon": nil, "force": force, "identity_confirmation": "user_confirmed"}
	if taxon != "" {
		request["taxon"] = taxon
	}
	card, err := e.lookup(request, ToolDescribe, rnaID, taxon)
	if err == nil {
		card.TaxonCheck = check
	}
	return card, err
}

// Map is map_rna_id: advisory mapping of an external id within a taxon.
func (e *EvidenceService) Map(identifier, taxon string) (model.EvidenceCard, error) {
	identifier, taxon = strings.TrimSpace(identifier), strings.TrimSpace(taxon)
	if err := ValidateRNAID(identifier); err != nil {
		return model.EvidenceCard{}, err
	}
	if taxon == "" {
		return model.EvidenceCard{}, errors.New("Checking an identifier needs the species (taxon).")
	}
	if err := ValidateTaxon(taxon); err != nil {
		return model.EvidenceCard{}, err
	}
	return e.lookup(Obj{"operation": "map_id", "identifier": identifier, "taxon": taxon}, ToolMap, identifier, taxon)
}

// ClearCache empties the worker's response cache.
func (e *EvidenceService) ClearCache() error {
	dir := e.cacheDir
	if dir == "" || filepath.Base(dir) != "evidence" {
		return errors.New("the evidence cache directory is not set")
	}
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(dir, entry.Name())); err != nil {
			return fmt.Errorf("could not clear the evidence cache: %w", err)
		}
	}
	return nil
}

// ---- project cards

// evidenceDir is the canonical <project>/evidence (not created) and the
// project's id; it refuses a directory that is not a project or an
// evidence entry that is not a plain directory.
func evidenceDir(projectPath string) (string, string, error) {
	if strings.TrimSpace(projectPath) == "" {
		return "", "", errors.New("project path is required")
	}
	root, err := canonicalPath(projectPath)
	if err != nil {
		return "", "", fmt.Errorf("project path is invalid: %w", err)
	}
	manifest, err := os.ReadFile(filepath.Join(root, "project.json"))
	if err != nil {
		return "", "", errors.New("not a RNAxRay project: project.json is missing")
	}
	var project struct {
		ProjectID string `json:"project_id"`
	}
	_ = json.Unmarshal(manifest, &project)
	dir := filepath.Join(root, "evidence")
	if info, err := os.Lstat(dir); err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
		return "", "", errors.New("project evidence directory is not a plain directory")
	}
	return dir, project.ProjectID, nil
}

func cardPath(dir, id string) (string, error) {
	if err := ValidateEvidenceID(id); err != nil {
		return "", err
	}
	return filepath.Join(dir, id+".json"), nil
}

func readCard(path string) (model.EvidenceCard, error) {
	var card model.EvidenceCard
	data, err := readProjectFile(path)
	if err != nil {
		return card, err
	}
	if err := json.Unmarshal(data, &card); err != nil {
		return card, err
	}
	// The card file is project data (it may have been edited or come with
	// a copied project): this version never verifies citations nor relates
	// a card to a structure beyond background, whatever the file says.
	card.CitationVerification = "not_checked"
	card.RelationToStructure = "background_only"
	return card, nil
}

func writeCard(path string, card model.EvidenceCard) error {
	data, err := json.MarshalIndent(card, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFileAtomic(path, append(data, '\n')); err != nil {
		return fmt.Errorf("could not save the evidence card: %w", err)
	}
	return nil
}

func validateBinding(b model.EvidenceBinding) error {
	if err := ValidateID(b.StructureID); err != nil {
		return errors.New("binding structure_id is invalid")
	}
	if !recordPattern.MatchString(b.Record) {
		return errors.New(`binding record must be "all" or "start-end"`)
	}
	if !digestPattern.MatchString(b.ResultDigest) {
		return errors.New("binding result_digest must be sha256:<hex>")
	}
	return nil
}

// Attach saves a card returned by Describe or Map to the project, bound to
// one structure result; the raw tool text goes next to it when known.
func (e *EvidenceService) Attach(projectPath string, card model.EvidenceCard, binding model.EvidenceBinding) (model.EvidenceCard, error) {
	if !e.enabled() {
		return model.EvidenceCard{}, ErrExternalLookupOff
	}
	dir, projectID, err := evidenceDir(projectPath)
	if err != nil {
		return model.EvidenceCard{}, err
	}
	path, err := cardPath(dir, card.EvidenceID)
	if err != nil {
		return model.EvidenceCard{}, err
	}
	if !slices.Contains(EvidenceTools, card.SourceTool) || ValidateRNAID(card.QueryIdentifier) != nil {
		return model.EvidenceCard{}, errors.New("not an evidence card from RNAcentral")
	}
	if !card.Saveable() {
		return model.EvidenceCard{}, errors.New("only answers from RNAcentral can be saved, not local failures")
	}
	if err := validateBinding(binding); err != nil {
		return model.EvidenceCard{}, err
	}
	if _, err := os.Lstat(path); err == nil {
		return model.EvidenceCard{}, errors.New("this card is already saved in the project")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return model.EvidenceCard{}, fmt.Errorf("could not create the evidence directory: %w", err)
	}
	binding.ProjectID = projectID
	binding.AttachedAt = e.now().Format(time.RFC3339)
	card.Binding = &binding
	card.SourceURL = sourceURL(card.SourceURL)
	card.CitationVerification = "not_checked"
	card.RelationToStructure = "background_only"
	card.Review = model.EvidenceReview{State: model.ReviewUnreviewed}
	card.RawResponseLocalRef = nil
	if raw := card.RawText; raw != "" && len(raw) <= maxRawText && model.EvidenceDigest(raw) == card.RawResponseDigest {
		name := card.EvidenceID + ".raw.txt"
		if err := writeFileAtomic(filepath.Join(dir, name), []byte(raw)); err != nil {
			return model.EvidenceCard{}, fmt.Errorf("could not save the raw response: %w", err)
		}
		card.RawResponseLocalRef = strPtr("evidence/" + name)
	}
	card.RawText = ""
	if err := e.seal(&card); err != nil {
		return model.EvidenceCard{}, err
	}
	if err := writeCard(path, card); err != nil {
		return model.EvidenceCard{}, err
	}
	return card, nil
}

// List reads the project's saved cards, newest first; unreadable files
// and files whose name does not match their card are skipped.
func (e *EvidenceService) List(projectPath string) ([]model.EvidenceCard, error) {
	dir, _, err := evidenceDir(projectPath)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return []model.EvidenceCard{}, nil
	}
	if err != nil {
		return nil, err
	}
	cards := []model.EvidenceCard{}
	for _, entry := range entries {
		id, ok := strings.CutSuffix(entry.Name(), ".json")
		if !ok || !entry.Type().IsRegular() || ValidateEvidenceID(id) != nil {
			continue
		}
		card, err := readCard(filepath.Join(dir, entry.Name()))
		if err != nil || card.EvidenceID != id {
			continue
		}
		e.verify(&card)
		cards = append(cards, card)
	}
	sort.SliceStable(cards, func(i, j int) bool {
		ai, aj := "", ""
		if cards[i].Binding != nil {
			ai = cards[i].Binding.AttachedAt
		}
		if cards[j].Binding != nil {
			aj = cards[j].Binding.AttachedAt
		}
		if ai != aj {
			return ai > aj
		}
		return cards[i].EvidenceID < cards[j].EvidenceID
	})
	return cards, nil
}

// Update changes whether a saved card is in the report and, when asked,
// its review (an explicit user action).
func (e *EvidenceService) Update(projectPath, id string, update model.EvidenceUpdate) (model.EvidenceCard, error) {
	dir, _, err := evidenceDir(projectPath)
	if err != nil {
		return model.EvidenceCard{}, err
	}
	path, err := cardPath(dir, id)
	if err != nil {
		return model.EvidenceCard{}, err
	}
	card, err := readCard(path)
	if err != nil || card.EvidenceID != id {
		return model.EvidenceCard{}, errors.New("this evidence card is not saved in the project")
	}
	if card.Binding == nil {
		return model.EvidenceCard{}, errors.New("this evidence card is not bound to a result")
	}
	e.verify(&card)
	card.Binding.IncludeInReport = update.IncludeInReport
	if r := update.Review; r != nil {
		if !slices.Contains(model.ReviewStates, r.State) {
			return model.EvidenceCard{}, fmt.Errorf("review state must be one of %s", strings.Join(model.ReviewStates, ", "))
		}
		note := strings.TrimSpace(r.Note)
		if len(note) > maxReviewNote {
			return model.EvidenceCard{}, fmt.Errorf("the note must be at most %d characters", maxReviewNote)
		}
		review := model.EvidenceReview{State: r.State}
		if r.State != model.ReviewUnreviewed {
			review.Reviewer = strPtr("researcher")
			review.At = strPtr(e.now().Format(time.RFC3339))
		}
		if note != "" {
			review.Note = strPtr(note)
		}
		card.Review = review
	}
	// Only a card made here is sealed again: sealing an edited or imported
	// one would vouch for content this computer did not retrieve.
	if card.LocalOrigin {
		if err := e.seal(&card); err != nil {
			return model.EvidenceCard{}, err
		}
	} else {
		card.LocalSeal = ""
	}
	if err := writeCard(path, card); err != nil {
		return model.EvidenceCard{}, err
	}
	return card, nil
}

// Delete removes a saved card and its raw text.
func (e *EvidenceService) Delete(projectPath, id string) error {
	dir, _, err := evidenceDir(projectPath)
	if err != nil {
		return err
	}
	path, err := cardPath(dir, id)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return errors.New("this evidence card is not saved in the project")
		}
		return err
	}
	if err := os.Remove(filepath.Join(dir, id+".raw.txt")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
