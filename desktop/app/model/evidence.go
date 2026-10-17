package model

// External evidence (desktop/spec/EVIDENCE.md): the EvidenceCard the
// evidence worker produces and Go stores in <project>/evidence/, its local
// binding to a structure result, and the worker's status answer.

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// Evidence card statuses (EVIDENCE.md, EvidenceCard.status).
const (
	EvidenceSuccess             = "success"
	EvidenceSummaryUnavailable  = "summary_unavailable"
	EvidenceNotFoundOrNoSummary = "not_found_or_no_summary"
	EvidenceUpstreamError       = "upstream_error"
	// EvidenceLocalError: the RNAcentral MCP server (a process on this
	// computer) failed to start or was lost; RNAcentral was not asked.
	EvidenceLocalError          = "local_error"
	EvidenceTimeout             = "timeout"
	EvidenceCancelled           = "cancelled"
	EvidenceIdentityUnconfirmed = "identity_unconfirmed"
	EvidenceUnexpectedResponse  = "unexpected_response"
)

// EvidenceStatuses are every status a card may carry.
var EvidenceStatuses = []string{EvidenceSuccess, EvidenceSummaryUnavailable, EvidenceNotFoundOrNoSummary,
	EvidenceUpstreamError, EvidenceLocalError, EvidenceTimeout, EvidenceCancelled, EvidenceIdentityUnconfirmed,
	EvidenceUnexpectedResponse}

// Review states. Only an explicit user action changes the state; the
// worker and Go always store "unreviewed".
const (
	ReviewUnreviewed = "unreviewed"
	ReviewReviewed   = "reviewed"
	ReviewRejected   = "rejected"
)

// ReviewStates are the states UpdateEvidence accepts.
var ReviewStates = []string{ReviewUnreviewed, ReviewReviewed, ReviewRejected}

// EvidenceBoundary is the label every card and report entry carries.
const EvidenceBoundary = "External AI literature summary — not a validation of this structure"

// EvidenceReview is a card's review by the researcher.
type EvidenceReview struct {
	State    string  `json:"state"`
	Reviewer *string `json:"reviewer"`
	At       *string `json:"at"`
	// Note is the researcher's own note (local; shown in the report).
	Note *string `json:"note,omitempty"`
}

// EvidenceBinding ties a saved card to one structure result (local only;
// never sent to the worker).
type EvidenceBinding struct {
	ProjectID   string `json:"project_id"`
	StructureID string `json:"structure_id"`
	// Record is "all" or one window "start-end".
	Record string `json:"record"`
	// ResultDigest is EvidenceDigest of the bound structure's dot-bracket.
	ResultDigest    string `json:"result_digest"`
	AttachedAt      string `json:"attached_at"`
	IncludeInReport bool   `json:"include_in_report"`
}

// EvidenceCard is one retrieval (EVIDENCE.md).
type EvidenceCard struct {
	SchemaVersion        string           `json:"schema_version"`
	EvidenceID           string           `json:"evidence_id"`
	SourceProvider       string           `json:"source_provider"`
	SourceTool           string           `json:"source_tool"`
	AdapterVersion       string           `json:"adapter_version"`
	ServerPackageVersion string           `json:"server_package_version"`
	SDKVersion           string           `json:"sdk_version"`
	QueryIdentifier      string           `json:"query_identifier"`
	Taxon                *string          `json:"taxon"`
	IdentityConfirmation string           `json:"identity_confirmation"`
	RequestedAt          string           `json:"requested_at"`
	RetrievedAt          *string          `json:"retrieved_at"`
	Status               string           `json:"status"`
	StatusDetail         *string          `json:"status_detail"`
	ContentKind          string           `json:"content_kind"`
	DisplayText          *string          `json:"display_text"`
	RawResponseDigest    string           `json:"raw_response_digest"`
	RawResponseLocalRef  *string          `json:"raw_response_local_ref"`
	SourceIdentifiers    []string         `json:"source_identifiers"`
	CitationVerification string           `json:"citation_verification"`
	RelationToStructure  string           `json:"relation_to_current_structure"`
	Review               EvidenceReview   `json:"review"`
	SourceURL            *string          `json:"source_url"`
	Binding              *EvidenceBinding `json:"binding"`
	// TaxonCheck says how the taxon of a describe card was checked
	// (core.TaxonCheckedByName, core.TaxonNotChecked; "" on older cards).
	TaxonCheck string `json:"taxon_check,omitempty"`
	// LocalSeal is the HMAC this computer puts on cards it saves or
	// changes (EVIDENCE.md); LocalOrigin is set on read when it checks out,
	// i.e. the card was made here and not edited since.
	LocalSeal   string `json:"local_seal,omitempty"`
	LocalOrigin bool   `json:"-"`
	// RawText is the raw tool text when the worker sends it (`raw_text`
	// next to the card); Go writes it to <id>.raw.txt on attach and never
	// stores it in the card file.
	RawText string `json:"-"`
}

// Text is the display text, or "".
func (c *EvidenceCard) Text() string {
	if c.DisplayText == nil {
		return ""
	}
	return *c.DisplayText
}

// TaxonText is the taxon, or "".
func (c *EvidenceCard) TaxonText() string {
	if c.Taxon == nil {
		return ""
	}
	return *c.Taxon
}

// Saveable reports whether the card may be attached to a project: only
// answers from RNAcentral, never local failures.
func (c *EvidenceCard) Saveable() bool {
	switch c.Status {
	case EvidenceSuccess, EvidenceSummaryUnavailable, EvidenceNotFoundOrNoSummary:
		return true
	}
	return false
}

// InReport reports whether a saved card is included in the report.
func (c *EvidenceCard) InReport() bool { return c.Binding != nil && c.Binding.IncludeInReport }

// EvidenceStatus is the worker's `status` answer plus Go's gate.
type EvidenceStatus struct {
	Enabled              bool     `json:"enabled"`
	Connected            bool     `json:"connected"`
	ServerPackageVersion string   `json:"server_package_version"`
	SDKVersion           string   `json:"sdk_version"`
	AdapterVersion       string   `json:"adapter_version"`
	Tools                []string `json:"tools"`
}

// EvidenceUpdate changes a saved card: whether the report includes it and,
// when Review is set, the researcher's review (an explicit user action).
type EvidenceUpdate struct {
	IncludeInReport bool
	Review          *EvidenceReviewUpdate
}

// EvidenceReviewUpdate is a review state chosen by the user and an
// optional note.
type EvidenceReviewUpdate struct {
	State string
	Note  string
}

// EvidenceDigest is a binding's result_digest: "sha256:<hex>" of the
// dot-bracket text.
func EvidenceDigest(dotBracket string) string {
	sum := sha256.Sum256([]byte(dotBracket))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// Relations of a saved card to the result shown.
const (
	RelationCurrent = "current"
	RelationOther   = "other_result"
	RelationUnbound = "unbound"
)

// EvidenceRelation says whether a saved card belongs to the structure
// (and record, and exact result) shown. A card bound to another structure,
// another record or a result whose dot-bracket changed is "other_result":
// it is never carried over.
func EvidenceRelation(c EvidenceCard, structureID, record, digest string) string {
	b := c.Binding
	if b == nil || b.StructureID == "" {
		return RelationUnbound
	}
	if b.StructureID == structureID && b.Record == record && strings.EqualFold(b.ResultDigest, digest) {
		return RelationCurrent
	}
	return RelationOther
}
