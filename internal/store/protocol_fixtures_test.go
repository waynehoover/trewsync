package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The entry shape, checked here against the same fixtures TypeScript checks
// (I03).
//
// `protocol-fixtures.json` at the repository root is the contract. Every case
// in it is fed to `Entry.Validate` here and to `checkEntryShape` in
// `client/src/core/engine.ts`, and the two have to agree: a valid case is
// accepted by both, an invalid one refused by both.
//
// The two languages decided this separately for a long time and decided it
// differently. The server refused an empty authenticator on a file and
// accepted one on a folder (F20); the client checked two of the server's seven
// rules. Nothing compared the lists, so a divergence was only ever found by
// meeting one in a vault.
type fixtureFile struct {
	GoodMac   string `json:"goodMac"`
	GoodChunk string `json:"goodChunk"`
	Cases     []struct {
		Name  string          `json:"name"`
		Valid bool            `json:"valid"`
		Why   string          `json:"why"`
		Entry json.RawMessage `json:"entry"`
	} `json:"cases"`
}

// retiredWithTheAuthenticator are the fixture's cases about the entry MAC and
// the parent digest, which protocol 1 removed (plan/protocol.md, "Writing": no
// mac, no parent). They stay in protocol-fixtures.json until the client is
// flipped (M2), because the TypeScript suite still reads them. An entry here
// has no such fields to refuse, so the server must accept every one of them;
// the client flip deletes them, and `goodMac` with them, and this list goes.
var retiredWithTheAuthenticator = map[string]bool{
	"a file with no authenticator":                true,
	"a folder with no authenticator":              true,
	"a deletion with no authenticator":            true,
	"an authenticator that is not a digest":       true,
	"a parent that is neither empty nor a digest": true,
}

func TestTheEntryShapeBothLanguagesEnforce(t *testing.T) {
	path := filepath.Join("..", "..", "protocol-fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var f fixtureFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if len(f.Cases) < 10 {
		t.Fatalf("only %d fixtures, which is not a contract", len(f.Cases))
	}

	valid, invalid, retired := 0, 0, 0
	for _, c := range f.Cases {
		// `$mac` and `$chunk` stand in for real digests, so the file stays
		// readable next to the rules it is about.
		text := strings.ReplaceAll(string(c.Entry), `"$mac"`, `"`+f.GoodMac+`"`)
		text = strings.ReplaceAll(text, `"$chunk"`, `"`+f.GoodChunk+`"`)

		var e Entry
		if err := json.Unmarshal([]byte(text), &e); err != nil {
			t.Fatalf("%s: parse entry: %v", c.Name, err)
		}
		err := e.Validate()
		if retiredWithTheAuthenticator[c.Name] {
			retired++
			if err != nil {
				t.Errorf("%s: refused, and protocol 1 has no authenticator to refuse it for: %v", c.Name, err)
			}
			continue
		}
		if c.Valid {
			valid++
			if err != nil {
				t.Errorf("%s: the client accepts this and the server does not: %v", c.Name, err)
			}
			continue
		}
		invalid++
		if err == nil {
			t.Errorf("%s: the client refuses this and the server does not (%s)", c.Name, c.Why)
		}
	}
	if valid == 0 || invalid == 0 {
		t.Fatalf("the fixtures cover only one verdict: %d valid, %d invalid", valid, invalid)
	}
	if retired != len(retiredWithTheAuthenticator) {
		t.Fatalf("%d of the %d retired cases are in the fixture: take the missing ones off the list",
			retired, len(retiredWithTheAuthenticator))
	}
}
