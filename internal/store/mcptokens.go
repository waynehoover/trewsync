package store

import (
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"errors"
	"fmt"
	"io"
)

// The sizes of an MCP token and of its id.
const (
	// MCPTokenBytes is the bearer credential an agent presents on /mcp: 32
	// random bytes, 43 characters of unpadded base64url on the wire.
	MCPTokenBytes = 32
	// MCPTokenIDBytes is a token's id, minted beside it and not derived from
	// it (PLAN.md section 2.3): the handle `trewd mcp-token -list` shows and
	// `-revoke` takes, and the author id a token's writes are recorded under.
	MCPTokenIDBytes = 16
	// MaxMCPLabelLen bounds a token's label, which becomes the author name on
	// the token's writes and so is held to a device name's bound.
	MaxMCPLabelLen = MaxDeviceLen
)

// MCPScope is what a token may do. Read is the default a token is minted
// with; write is asked for explicitly.
type MCPScope string

// The scopes. Write includes read.
const (
	ScopeRead  MCPScope = "read"
	ScopeWrite MCPScope = "write"
)

// Valid reports whether s is one of the scopes.
func (s MCPScope) Valid() bool { return s == ScopeRead || s == ScopeWrite }

// Allows reports whether a token of scope s may use something that needs
// need: write allows both, read allows read.
func (s MCPScope) Allows(need MCPScope) bool {
	return s == ScopeWrite || (s == ScopeRead && need == ScopeRead)
}

// AuthorKindMCP is the kind of the author row an MCP token has.
const AuthorKindMCP = "mcp"

// mcpTokensSchema holds the credentials agents use on /mcp and the author rows
// their writes are recorded under.
//
// A token is stored as its SHA-256 (HashToken), like a device's and an
// invite's: a copy of the database is not a place a live credential should
// be. The id is random and separate from the hash; the first eight hex
// characters of the hash are a fingerprint for a person to compare with, never
// an identity (PLAN.md section 2.3).
//
// last_used is written at most once a minute, so on its own it cannot show a
// stolen token used once between two legitimate uses; used_count counts every
// authenticated request and is what shows it (PLAN.md section 2.3).
//
// Authors are not devices (PLAN.md sections 2.3 and 3.3). A device row is a
// sync peer: it has a hello credential, its sessions carry applied checkpoints,
// and the device list is what the panel and delivery status are made from. An
// agent is none of those things, and a row for it in the devices table would
// present as an offline peer every checkpoint waited on and would need a device
// id the base64url rule does not allow. So an author has its own table and a
// kind, and nothing that lists devices reads it. Revoking the token deletes
// both rows in one transaction; entries keep the name their writes were made
// under, as they keep a revoked device's.
const mcpTokensSchema = `
CREATE TABLE IF NOT EXISTS mcp_tokens (
  vault_id   TEXT    NOT NULL,
  id         TEXT    NOT NULL PRIMARY KEY,
  token_hash TEXT    NOT NULL UNIQUE,
  label      TEXT    NOT NULL,
  scope      TEXT    NOT NULL CHECK (scope IN ('read', 'write')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used  INTEGER NOT NULL DEFAULT 0,
  used_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS mcp_tokens_by_vault ON mcp_tokens(vault_id);

CREATE TABLE IF NOT EXISTS authors (
  vault_id   TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('mcp')),
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, id)
);
`

// ErrUnknownMCPToken is a token id this vault does not hold: never minted,
// or revoked already.
var ErrUnknownMCPToken = errors.New("no such MCP token on this vault")

// MCPToken is one token as a listing shows it. It carries no credential and
// nothing derived from one except the fingerprint, which is eight hex
// characters of the hash: enough for a person to tell two tokens apart, far
// too little to be tried against anything.
type MCPToken struct {
	ID          string   `json:"id"`
	Label       string   `json:"label"`
	Scope       MCPScope `json:"scope"`
	CreatedAt   int64    `json:"createdAt"`
	ExpiresAt   *int64   `json:"expiresAt"`
	LastUsed    int64    `json:"lastUsed"`
	UsedCount   int64    `json:"usedCount"`
	Fingerprint string   `json:"fingerprint"`
}

// Expired reports whether the token has stopped working at now, in
// milliseconds.
func (t MCPToken) Expired(now int64) bool { return t.ExpiresAt != nil && now >= *t.ExpiresAt }

// NewMCPToken is what minting a token hands back, once: the listing row and
// the raw token, which is not stored and cannot be recovered.
type NewMCPToken struct {
	MCPToken
	Token []byte
}

// Author is one author row: who writes versions without being a device.
type Author struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"createdAt"`
}

// ValidMCPTokenID reports whether s is a token id's shape.
func ValidMCPTokenID(s string) bool {
	_, ok := DecodeToken(s, MCPTokenIDBytes)
	return ok
}

func fingerprint(hash string) string {
	if len(hash) < 8 {
		return hash
	}
	return hash[:8]
}

// CreateMCPToken mints a token on a vault, with its author row, in one
// transaction.
//
// label must be a name (CheckName) and not empty, because it is what the
// token's writes are recorded as and what a conflict copy made from one of
// them is named after. expiresAt is milliseconds, or nil for a token that
// never expires, which the operator asks for deliberately. The id and the
// token are random and retried on the vanishingly unlikely collision rather
// than surfacing a constraint error.
func (s *Store) CreateMCPToken(vaultID, label string, scope MCPScope, expiresAt *int64, now int64) (NewMCPToken, error) {
	if label == "" {
		return NewMCPToken{}, fmt.Errorf("%w: an MCP token needs a label, which its writes are recorded as", ErrBadEntry)
	}
	if err := CheckName("token", label, MaxMCPLabelLen); err != nil {
		return NewMCPToken{}, fmt.Errorf("%w: %v", ErrBadEntry, err)
	}
	if !scope.Valid() {
		return NewMCPToken{}, fmt.Errorf("%w: scope %q is neither read nor write", ErrBadEntry, scope)
	}
	if expiresAt != nil && *expiresAt <= now {
		return NewMCPToken{}, fmt.Errorf("%w: the token would expire before it was issued", ErrBadEntry)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	var out NewMCPToken
	err := immediate(s.db, func(q execer) error {
		var exists int
		if err := q.QueryRow(`SELECT COUNT(*) FROM vaults WHERE vault_id = ?`, vaultID).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			return fmt.Errorf("%w: %q", ErrUnknownVault, vaultID)
		}
		for attempt := 0; attempt < 3; attempt++ {
			id := make([]byte, MCPTokenIDBytes)
			token := make([]byte, MCPTokenBytes)
			if _, err := io.ReadFull(rand.Reader, id); err != nil {
				return err
			}
			if _, err := io.ReadFull(rand.Reader, token); err != nil {
				return err
			}
			hash := HashToken(token)
			res, err := q.Exec(`INSERT INTO mcp_tokens (vault_id, id, token_hash, label, scope, created_at, expires_at)
			                    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
				vaultID, EncodeToken(id), hash, label, string(scope), now, nullableInt(expiresAt))
			if err != nil {
				return err
			}
			if n, err := res.RowsAffected(); err != nil {
				return err
			} else if n != 1 {
				continue
			}
			// The author row, in the same transaction: a token whose writes
			// have no author would be recorded as nobody.
			res, err = q.Exec(`INSERT INTO authors (vault_id, id, kind, name, created_at) VALUES (?, ?, ?, ?, ?)`,
				vaultID, EncodeToken(id), AuthorKindMCP, label, now)
			if err != nil {
				return err
			}
			if n, err := res.RowsAffected(); err != nil {
				return err
			} else if n != 1 {
				return fmt.Errorf("the author row for a new token was not written (%d rows)", n)
			}
			out = NewMCPToken{
				MCPToken: MCPToken{
					ID: EncodeToken(id), Label: label, Scope: scope, CreatedAt: now,
					ExpiresAt: expiresAt, Fingerprint: fingerprint(hash),
				},
				Token: token,
			}
			return nil
		}
		return errors.New("three random token ids or tokens in a row were already taken")
	})
	return out, err
}

const mcpTokenCols = `id, label, scope, created_at, expires_at, last_used, used_count, token_hash`

func scanMCPToken(r scannable) (MCPToken, string, error) {
	var t MCPToken
	var scope, hash string
	var expires sql.NullInt64
	if err := r.Scan(&t.ID, &t.Label, &scope, &t.CreatedAt, &expires, &t.LastUsed, &t.UsedCount, &hash); err != nil {
		return MCPToken{}, "", err
	}
	t.Scope = MCPScope(scope)
	if expires.Valid {
		v := expires.Int64
		t.ExpiresAt = &v
	}
	t.Fingerprint = fingerprint(hash)
	return t, hash, nil
}

// MCPTokens is every token on a vault, oldest first and then by id, expired
// ones included so a listing shows what is still there to revoke. Never nil,
// and nothing in it authenticates anything.
func (s *Store) MCPTokens(vaultID string) ([]MCPToken, error) {
	rows, err := s.db.Query(`SELECT `+mcpTokenCols+` FROM mcp_tokens WHERE vault_id = ? ORDER BY created_at, id`, vaultID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MCPToken{}
	for rows.Next() {
		t, _, err := scanMCPToken(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// MatchMCPToken finds the token raw is, on this vault.
//
// Every row's hash is compared, in constant time, and the loop does not stop
// at a match, so how long the answer takes says nothing about which row, if
// any, it was. A vault holds a handful of tokens, so reading them all costs
// less than an index lookup would save. ok is false for a token that is not
// there, including one revoked a moment ago; expiry is the caller's to judge
// against its clock (MCPToken.Expired).
func (s *Store) MatchMCPToken(vaultID string, raw []byte) (MCPToken, bool, error) {
	if len(raw) != MCPTokenBytes {
		return MCPToken{}, false, nil
	}
	want := []byte(HashToken(raw))
	rows, err := s.db.Query(`SELECT `+mcpTokenCols+` FROM mcp_tokens WHERE vault_id = ?`, vaultID)
	if err != nil {
		return MCPToken{}, false, err
	}
	defer rows.Close()
	var found MCPToken
	matched := 0
	for rows.Next() {
		t, hash, err := scanMCPToken(rows)
		if err != nil {
			return MCPToken{}, false, err
		}
		if subtle.ConstantTimeCompare([]byte(hash), want) == 1 {
			found = t
			matched++
		}
	}
	if err := rows.Err(); err != nil {
		return MCPToken{}, false, err
	}
	// token_hash is UNIQUE, so two matches cannot happen; refused rather
	// than resolved if it ever does, because either answer would be a guess
	// about which credential this is.
	if matched > 1 {
		return MCPToken{}, false, fmt.Errorf("%d MCP tokens share one hash", matched)
	}
	return found, matched == 1, nil
}

// CheckMCPToken is the credential as it stands now: the row with this id,
// provided its hash is still hash. ok is false when the token was revoked, or
// when its id somehow names another credential, which is the check that makes
// a later row under a reused id unable to revive a request made with the old
// one. It is what every recheck after authentication calls: at dispatch,
// before a reply, and under the commit lock before a write (PLAN.md section
// 2.3).
func (s *Store) CheckMCPToken(vaultID, id, hash string) (MCPToken, bool, error) {
	t, stored, err := scanMCPToken(s.db.QueryRow(
		`SELECT `+mcpTokenCols+` FROM mcp_tokens WHERE vault_id = ? AND id = ?`, vaultID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return MCPToken{}, false, nil
	}
	if err != nil {
		return MCPToken{}, false, err
	}
	if subtle.ConstantTimeCompare([]byte(stored), []byte(hash)) != 1 {
		return MCPToken{}, false, nil
	}
	return t, true, nil
}

// MCPTokenHash is the stored hash a raw token is compared as, for a caller
// that authenticated with MatchMCPToken and rechecks with CheckMCPToken.
func MCPTokenHash(raw []byte) string { return HashToken(raw) }

// RevokeMCPToken deletes a token and its author row in one transaction. An id
// the vault does not hold is ErrUnknownMCPToken.
//
// The versions the token wrote keep the name they were written under, and the
// operations recorded for it (M5) keep its id and label as they were: revoking
// ends what the credential can do, it does not rewrite what it did.
func (s *Store) RevokeMCPToken(vaultID, id string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return immediate(s.db, func(q execer) error {
		res, err := q.Exec(`DELETE FROM mcp_tokens WHERE vault_id = ? AND id = ?`, vaultID, id)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return fmt.Errorf("%w: %q on vault %q", ErrUnknownMCPToken, id, vaultID)
		}
		_, err = q.Exec(`DELETE FROM authors WHERE vault_id = ? AND id = ? AND kind = ?`, vaultID, id, AuthorKindMCP)
		return err
	})
}

// NoteMCPTokenUse records count more authenticated requests by a token and
// moves its last_used to at, never backwards. The caller throttles it, so
// this is a write a minute per token in use rather than one per request. A
// revoked token is not an error: its requests were counted until the revoke
// removed the row they would have been added to.
func (s *Store) NoteMCPTokenUse(vaultID, id string, at, count int64) error {
	if count <= 0 {
		return nil
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.db.Exec(
		`UPDATE mcp_tokens SET last_used = MAX(last_used, ?), used_count = used_count + ? WHERE vault_id = ? AND id = ?`,
		at, count, vaultID, id)
	return err
}

// Authors is every author row on a vault, oldest first and then by id. Never
// nil.
func (s *Store) Authors(vaultID string) ([]Author, error) {
	rows, err := s.db.Query(
		`SELECT id, kind, name, created_at FROM authors WHERE vault_id = ? ORDER BY created_at, id`, vaultID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Author{}
	for rows.Next() {
		var a Author
		if err := rows.Scan(&a.ID, &a.Kind, &a.Name, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
