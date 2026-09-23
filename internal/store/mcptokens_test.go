package store

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
)

func mintToken(t *testing.T, h *harness, label string, scope MCPScope, expires *int64) NewMCPToken {
	t.Helper()
	tok, err := h.CreateMCPToken("v1", label, scope, expires, 1000)
	if err != nil {
		t.Fatalf("minting a token: %v", err)
	}
	return tok
}

// A token is stored as its hash under an id minted beside it, so nothing the
// listing carries is the credential or can be turned back into it, and the
// fingerprint is a display value rather than the identity (PLAN.md section
// 2.3).
func TestAnMCPTokenIsStoredAsAHashUnderARandomID(t *testing.T) {
	h := newTestStore(t)
	tok := mintToken(t, h, "Claude on Mac", ScopeRead, nil)
	if len(tok.Token) != MCPTokenBytes {
		t.Fatalf("the token is %d bytes, want %d", len(tok.Token), MCPTokenBytes)
	}
	if !ValidMCPTokenID(tok.ID) {
		t.Fatalf("id %q is not a token id", tok.ID)
	}
	hash := HashToken(tok.Token)
	if tok.Fingerprint != hash[:8] {
		t.Fatalf("fingerprint %q, want the first eight hex of the hash", tok.Fingerprint)
	}
	if strings.HasPrefix(hash, tok.ID) || tok.ID == tok.Fingerprint {
		t.Fatal("the id is derived from the hash; it must be minted separately")
	}

	var storedHash string
	if err := h.db.QueryRow(`SELECT token_hash FROM mcp_tokens WHERE id = ?`, tok.ID).Scan(&storedHash); err != nil {
		t.Fatal(err)
	}
	if storedHash != hash {
		t.Fatalf("stored %q, want the token's SHA-256", storedHash)
	}
	var clear int
	if err := h.db.QueryRow(`SELECT COUNT(*) FROM mcp_tokens WHERE token_hash = ? OR label = ?`,
		EncodeToken(tok.Token), EncodeToken(tok.Token)).Scan(&clear); err != nil {
		t.Fatal(err)
	}
	if clear != 0 {
		t.Fatal("the token is stored in the clear")
	}

	list, err := h.MCPTokens("v1")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(list)
	for _, secret := range []string{EncodeToken(tok.Token), hash} {
		if strings.Contains(string(b), secret) {
			t.Fatalf("the listing carries a credential: %s", b)
		}
	}
	if len(list) != 1 || list[0].ID != tok.ID || list[0].Scope != ScopeRead || list[0].Label != "Claude on Mac" {
		t.Fatalf("listing %+v", list)
	}
}

func TestAnMCPTokenAuthenticatesOnlyAsItself(t *testing.T) {
	h := newTestStore(t)
	a := mintToken(t, h, "a", ScopeRead, nil)
	b := mintToken(t, h, "b", ScopeWrite, nil)
	for _, tok := range []NewMCPToken{a, b} {
		got, ok, err := h.MatchMCPToken("v1", tok.Token)
		if err != nil || !ok || got.ID != tok.ID || got.Scope != tok.Scope {
			t.Fatalf("matching %s: %+v %v %v", tok.Label, got, ok, err)
		}
	}
	wrong := append([]byte(nil), a.Token...)
	wrong[0] ^= 1
	for _, raw := range [][]byte{wrong, a.Token[:31], nil, append(a.Token, 0)} {
		if _, ok, err := h.MatchMCPToken("v1", raw); ok || err != nil {
			t.Fatalf("%x matched (%v, %v)", raw, ok, err)
		}
	}
	if err := h.EnsureVault("v2", 1000); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := h.MatchMCPToken("v2", a.Token); ok {
		t.Fatal("a token matched on a vault it was not minted for")
	}
}

// The recheck is by id and hash together, so a revoked token stays revoked
// and nothing else named by its id can stand in for it.
func TestCheckMCPTokenIsTheCredentialAsItStandsNow(t *testing.T) {
	h := newTestStore(t)
	tok := mintToken(t, h, "agent", ScopeWrite, nil)
	hash := MCPTokenHash(tok.Token)
	if got, ok, err := h.CheckMCPToken("v1", tok.ID, hash); err != nil || !ok || got.Scope != ScopeWrite {
		t.Fatalf("check: %+v %v %v", got, ok, err)
	}
	if _, ok, _ := h.CheckMCPToken("v1", tok.ID, HashToken([]byte("some other token"))); ok {
		t.Fatal("the recheck accepted a different credential under the same id")
	}
	if err := h.RevokeMCPToken("v1", tok.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := h.CheckMCPToken("v1", tok.ID, hash); ok || err != nil {
		t.Fatalf("a revoked token still checks: %v %v", ok, err)
	}
	if _, ok, _ := h.MatchMCPToken("v1", tok.Token); ok {
		t.Fatal("a revoked token still authenticates")
	}
	if err := h.RevokeMCPToken("v1", tok.ID); !errors.Is(err, ErrUnknownMCPToken) {
		t.Fatalf("revoking twice: %v", err)
	}
}

// Each token has an author row of its own kind, created and removed with it,
// and it is never a device: nothing that lists sync peers sees it (PLAN.md
// sections 2.3 and 3.3).
func TestATokenHasAnAuthorRowThatIsNeverADevice(t *testing.T) {
	h := newTestStore(t)
	tok := mintToken(t, h, "Claude on Mac", ScopeWrite, nil)
	authors, err := h.Authors("v1")
	if err != nil {
		t.Fatal(err)
	}
	if len(authors) != 1 || authors[0].ID != tok.ID || authors[0].Kind != AuthorKindMCP || authors[0].Name != "Claude on Mac" {
		t.Fatalf("authors %+v", authors)
	}
	devices, err := h.Devices("v1")
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 0 {
		t.Fatalf("an author appears as a device: %+v", devices)
	}
	if _, _, ok, _ := h.DeviceByID("v1", tok.ID); ok {
		t.Fatal("an author's id resolves as a device")
	}
	if err := h.RevokeMCPToken("v1", tok.ID); err != nil {
		t.Fatal(err)
	}
	if authors, _ := h.Authors("v1"); len(authors) != 0 {
		t.Fatalf("revoking left the author row: %+v", authors)
	}
}

func TestCreateMCPTokenRefusesWhatCannotBeAToken(t *testing.T) {
	h := newTestStore(t)
	past := int64(999)
	for _, c := range []struct {
		name, label string
		scope       MCPScope
		expires     *int64
		vault       string
		want        error
	}{
		{"no label", "", ScopeRead, nil, "v1", ErrBadEntry},
		{"a control character", "a\nb", ScopeRead, nil, "v1", ErrBadEntry},
		{"a long label", strings.Repeat("x", MaxMCPLabelLen+1), ScopeRead, nil, "v1", ErrBadEntry},
		{"an unknown scope", "a", "admin", nil, "v1", ErrBadEntry},
		{"already expired", "a", ScopeRead, &past, "v1", ErrBadEntry},
		{"an unknown vault", "a", ScopeRead, nil, "nope", ErrUnknownVault},
	} {
		t.Run(c.name, func(t *testing.T) {
			if _, err := h.CreateMCPToken(c.vault, c.label, c.scope, c.expires, 1000); !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
		})
	}
	if list, _ := h.MCPTokens("v1"); len(list) != 0 {
		t.Fatalf("a refused token was stored: %+v", list)
	}
	if authors, _ := h.Authors("v1"); len(authors) != 0 {
		t.Fatalf("a refused token left an author: %+v", authors)
	}
}

func TestExpiryIsTheCallersClock(t *testing.T) {
	h := newTestStore(t)
	at := int64(5000)
	tok := mintToken(t, h, "a", ScopeRead, &at)
	got, ok, _ := h.MatchMCPToken("v1", tok.Token)
	if !ok || got.Expired(4999) || !got.Expired(5000) {
		t.Fatalf("%+v: expired at 4999 %v, at 5000 %v", got, got.Expired(4999), got.Expired(5000))
	}
	never := mintToken(t, h, "b", ScopeRead, nil)
	if never.Expired(1 << 62) {
		t.Fatal("a token with no expiry expired")
	}
}

// used_count adds up every request and last_used never moves backwards, so a
// single use between two legitimate ones is still counted (PLAN.md section
// 2.3).
func TestTokenUseIsCountedAndLastUsedOnlyMovesForward(t *testing.T) {
	h := newTestStore(t)
	tok := mintToken(t, h, "a", ScopeRead, nil)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := h.NoteMCPTokenUse("v1", tok.ID, int64(2000+i), 3); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if err := h.NoteMCPTokenUse("v1", tok.ID, 1500, 1); err != nil {
		t.Fatal(err)
	}
	list, _ := h.MCPTokens("v1")
	if list[0].UsedCount != 25 || list[0].LastUsed != 2007 {
		t.Fatalf("used %d times, last at %d; want 25 and 2007", list[0].UsedCount, list[0].LastUsed)
	}
	if err := h.RevokeMCPToken("v1", tok.ID); err != nil {
		t.Fatal(err)
	}
	if err := h.NoteMCPTokenUse("v1", tok.ID, 3000, 1); err != nil {
		t.Fatalf("counting a revoked token's last requests: %v", err)
	}
}

func TestScopes(t *testing.T) {
	for _, c := range []struct {
		have, need MCPScope
		ok         bool
	}{
		{ScopeRead, ScopeRead, true},
		{ScopeRead, ScopeWrite, false},
		{ScopeWrite, ScopeRead, true},
		{ScopeWrite, ScopeWrite, true},
		{"", ScopeRead, false},
		{"admin", ScopeWrite, false},
	} {
		if got := c.have.Allows(c.need); got != c.ok {
			t.Errorf("%q allows %q: %v, want %v", c.have, c.need, got, c.ok)
		}
	}
}
