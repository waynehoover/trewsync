package invite

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fixtures struct {
	Constants struct {
		InvitePrefix     string `json:"invitePrefix"`
		InviteTokenBytes int    `json:"inviteTokenBytes"`
		MaxNameBytes     int    `json:"maxNameBytes"`
	} `json:"constants"`
	Invite struct {
		Good []struct {
			String string `json:"string"`
			Token  string `json:"token"`
			URL    string `json:"url"`
			Vault  string `json:"vault"`
		} `json:"good"`
		Bad []struct {
			Why    string `json:"why"`
			String string `json:"string"`
		} `json:"bad"`
	} `json:"invite"`
}

func load(t *testing.T) fixtures {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "protocol-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f fixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Invite.Good) < 3 || len(f.Invite.Bad) < 15 {
		t.Fatalf("the invite section is not a contract: %d good, %d bad", len(f.Invite.Good), len(f.Invite.Bad))
	}
	return f
}

func TestTheConstantsAreTheContracts(t *testing.T) {
	c := load(t).Constants
	if Prefix != c.InvitePrefix || TokenBytes != c.InviteTokenBytes || MaxNameBytes != c.MaxNameBytes {
		t.Fatalf("Prefix %q, TokenBytes %d, MaxNameBytes %d; the contract says %q, %d, %d",
			Prefix, TokenBytes, MaxNameBytes, c.InvitePrefix, c.InviteTokenBytes, c.MaxNameBytes)
	}
}

func TestGoodInvitesParseToTheirFields(t *testing.T) {
	for _, g := range load(t).Invite.Good {
		inv, err := Parse(g.String)
		if err != nil {
			t.Errorf("%q: %v", g.String, err)
			continue
		}
		token, _ := base64.RawURLEncoding.DecodeString(g.Token)
		if !bytes.Equal(inv.Token, token) || inv.URL != g.URL || inv.Vault != g.Vault {
			t.Errorf("%q parsed to %+v", g.String, inv)
		}
	}
}

// Format has to produce the reference's exact string, not just something Parse
// reads back: a TypeScript decoder is on the other end. The whitespace-wrapped
// vector formats to its trimmed form.
func TestFormatProducesTheReferenceString(t *testing.T) {
	for _, g := range load(t).Invite.Good {
		token, _ := base64.RawURLEncoding.DecodeString(g.Token)
		got, err := Format(Invite{Token: token, URL: g.URL, Vault: g.Vault})
		if err != nil {
			t.Fatal(err)
		}
		if want := strings.Trim(g.String, " \t\r\n"); got != want {
			t.Errorf("Format(%s, %s) = %q, the reference %q", g.URL, g.Vault, got, want)
		}
	}
}

func TestBadInvitesAreRefused(t *testing.T) {
	for _, b := range load(t).Invite.Bad {
		if inv, err := Parse(b.String); err == nil {
			t.Errorf("%s: accepted, as %+v", b.Why, inv)
		}
	}
}

// A corrupted vector must fail on the consuming side (PLAN.md M0.5).
func TestACorruptedVectorIsCaught(t *testing.T) {
	g := load(t).Invite.Good[0]
	s := []byte(g.String)
	i := len(Prefix) + 5
	if s[i] == 'A' {
		s[i] = 'B'
	} else {
		s[i] = 'A'
	}
	if _, err := Parse(string(s)); err == nil {
		t.Error("an invite with one character changed still parsed")
	}
}
