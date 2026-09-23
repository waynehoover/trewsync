package store

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"

	"github.com/waynehoover/trew/internal/invite"
)

// The sizes of the three random things a vault's access is made of.
const (
	// InviteTokenBytes is an invite's redemption token: the secret an invite
	// string carries, and the only thing that redeems it.
	InviteTokenBytes = invite.TokenBytes
	// InviteIDBytes is an invite's id: the non-secret handle a listing shows
	// and `uninvite` takes. Minted beside the token and not derived from it,
	// so nothing a listing carries can redeem anything (strip ledger, hazard
	// 1).
	InviteIDBytes = 8
	// DeviceTokenBytes is a device's credential, chosen by the device when it
	// redeems an invite and presented at every hello.
	DeviceTokenBytes = 32
)

// invitesSchema is the invites table. See Invite for the listing's shape and
// RedeemInvite for the transaction that spends a row.
//
// The token is stored as its SHA-256, never in the clear, like a device's: a
// server holding the token could redeem it, and a copy of the database is not
// a place a live credential should be. A spent row is kept, marked with the
// device that spent it, because that is what lets a redemption whose reply was
// lost be retried and recognised (plan/protocol.md, "Invite redemption", step
// 2). An unspent row that can no longer be redeemed, expired or cancelled, is
// swept the next time an invite is created on the vault.
//
// issued_by is the device that asked for the invite, or NULL when the operator
// did, on the server. It is what lets revoking a device cancel the invites it
// issued; see RevokeDevice.
const invitesSchema = `
CREATE TABLE IF NOT EXISTS invites (
  vault_id     TEXT    NOT NULL,
  id           TEXT    NOT NULL PRIMARY KEY,
  token_hash   TEXT    NOT NULL UNIQUE,
  label        TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  used_at      INTEGER,
  used_by      TEXT,
  cancelled_at INTEGER,
  issued_by    TEXT
);
CREATE INDEX IF NOT EXISTS invites_by_vault ON invites(vault_id, expires_at);
`

// ErrNoInvite is a redemption the vault refuses, and it is deliberately one
// error for every reason there is: an invite that is unknown, malformed,
// already spent by somebody else, cancelled or expired, and a device id the
// vault already has. Saying which would tell somebody holding a guessed or a
// stolen string that they had found a real one, and after a redemption it
// would confirm that this vault had an invite out a moment ago. The session
// turns every one of them into the same `auth` refusal (plan/protocol.md,
// "Invite redemption"), and none of them writes anything.
var ErrNoInvite = errors.New("no invite on this vault that this can redeem")

// HashToken is how a credential is stored: the hex SHA-256 of its raw bytes.
//
// One function for devices and invites, because the rule is one rule and two
// copies of it are two chances to disagree about what a stored credential is.
// A bare, unsalted SHA-256 is right only because every input is random and
// long, 16 or 32 bytes from a CSPRNG: there is nothing to guess, so nothing for
// a salt or a slow hash to defend. It must never be used for anything a person
// chose.
func HashToken(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// DecodeToken reads a credential off the wire: unpadded, canonical base64url
// of exactly n bytes, or nothing. Strict, so one credential has one spelling:
// a decoder that took padding, stray characters or nonzero unused bits would
// accept strings no encoder writes.
func DecodeToken(s string, n int) ([]byte, bool) {
	if len(s) != base64.RawURLEncoding.EncodedLen(n) {
		return nil, false
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(s)
	if err != nil || len(b) != n {
		return nil, false
	}
	return b, true
}

// EncodeToken is DecodeToken's inverse: unpadded base64url.
func EncodeToken(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// EncodedTokenLen is how many characters a credential of n bytes is on the
// wire, for the messages that say what a malformed one should have been.
func EncodedTokenLen(n int) int { return base64.RawURLEncoding.EncodedLen(n) }

// ValidInviteID reports whether s is an invite id's shape.
func ValidInviteID(s string) bool {
	_, ok := DecodeToken(s, InviteIDBytes)
	return ok
}

// Invite is one outstanding invite, in the shape a listing shows it: its id,
// its label and when it stops working, null for never.
//
// Nothing else, deliberately. An invite token is a bearer credential, and a
// listing type with the token or its hash in it is one that hands a working
// invite to every paired device the first time somebody serialises the list,
// which Basalt's listing would have done under a bearer token (strip ledger,
// hazard 1). The id is minted separately from the token and cannot redeem
// anything; it is how a listing names the invite to cancel.
type Invite struct {
	ID        string `json:"invite"`
	Label     string `json:"label"`
	ExpiresAt *int64 `json:"expiresAt"`
}

// NewInvite is what creating an invite hands back, once: its id, its token,
// and when it expires. The token is not stored and cannot be recovered; the
// caller formats it into an invite string or passes it on and forgets it.
type NewInvite struct {
	ID        string
	Token     []byte
	ExpiresAt *int64
}

// CreateInvite mints an invite on a vault, and sweeps that vault's invites that
// can no longer be redeemed while it is there.
//
// issuedBy is the device asking, or empty for the operator, who asks on the
// server; revoking that device cancels the invite (see RevokeDevice). expiresAt
// is milliseconds, or nil for an invite that never expires, which is the
// deliberate choice `trew invite -ttl 0` makes. Sweeping at creation
// rather than on a timer keeps the table bounded by what was issued since the
// last issue, with no goroutine to forget to start. Spent rows are not swept:
// a redemption whose reply was lost is recognised by its row.
//
// The id and the token are random and are retried on the astronomically
// unlikely collision with a row already there, rather than surfacing a
// constraint error as a server fault a client retries for ever.
func (s *Store) CreateInvite(vaultID, label, issuedBy string, expiresAt *int64, now int64) (NewInvite, error) {
	if err := CheckName("invite", label, MaxDeviceLen); err != nil {
		return NewInvite{}, fmt.Errorf("%w: %v", ErrBadEntry, err)
	}
	var issuer any
	if issuedBy != "" {
		if !ValidDeviceID(issuedBy) {
			return NewInvite{}, fmt.Errorf("%w: the issuing device id is not one", ErrBadEntry)
		}
		issuer = issuedBy
	}
	if expiresAt != nil && *expiresAt <= now {
		return NewInvite{}, fmt.Errorf("%w: the invite would expire before it was issued", ErrBadEntry)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	var out NewInvite
	err := immediate(s.db, func(q execer) error {
		var exists int
		if err := q.QueryRow(`SELECT COUNT(*) FROM vaults WHERE vault_id = ?`, vaultID).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			return fmt.Errorf("%w: %q", ErrUnknownVault, vaultID)
		}
		if _, err := q.Exec(`DELETE FROM invites
		                      WHERE vault_id = ? AND used_at IS NULL
		                        AND (cancelled_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at < ?))`,
			vaultID, now); err != nil {
			return err
		}
		for attempt := 0; attempt < 3; attempt++ {
			id := make([]byte, InviteIDBytes)
			token := make([]byte, InviteTokenBytes)
			if _, err := io.ReadFull(rand.Reader, id); err != nil {
				return err
			}
			if _, err := io.ReadFull(rand.Reader, token); err != nil {
				return err
			}
			res, err := q.Exec(`INSERT INTO invites (vault_id, id, token_hash, label, created_at, expires_at, issued_by)
			                    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
				vaultID, EncodeToken(id), HashToken(token), label, now, nullableInt(expiresAt), issuer)
			if err != nil {
				return err
			}
			if n, err := res.RowsAffected(); err != nil {
				return err
			} else if n == 1 {
				out = NewInvite{ID: EncodeToken(id), Token: token, ExpiresAt: expiresAt}
				return nil
			}
		}
		return errors.New("three random invite ids or tokens in a row were already taken")
	})
	return out, err
}

// betweenRedeemWrites runs inside RedeemInvite's transaction, after the device
// row is inserted and before the invite is marked spent, and is nil in every
// build but a test's. Returning an error from it stands in for the process
// dying in that window, which is a few microseconds wide: a test that tried to
// hit it by timing would be a test that passes when the machine is busy.
// TestACrashBetweenRegisteringAndSpendingLeavesNeither.
var betweenRedeemWrites func() error

// RedeemInvite redeems an invite token for a device, in one transaction and in
// the order plan/protocol.md, "Invite redemption", gives:
//
//  1. Look the invite up by the SHA-256 of its token. None: refuse.
//  2. If the invite was spent by this device id, and that device's stored hash
//     is this token's, answer as redeemed again, without writing anything.
//     That is the retry of a redemption whose reply was lost, and it succeeds
//     even if the invite has expired since, because the redemption it repeats
//     did not. retried says it was one.
//  3. If the invite is spent by anybody else, cancelled or expired: refuse.
//  4. If the device id already names a device: refuse. Only here, after step
//     2 has let the lost-reply retry through.
//  5. Insert the device row and mark the invite spent by this device id.
//
// Every refusal is ErrNoInvite and writes nothing, so a refused redemption
// never spends the invite. The transaction takes the write lock at its start
// (see immediate), which is what makes single use hold across processes and
// store handles: eight handles redeeming one invite at once register exactly
// one device, because each reads the row only after the one before it has
// committed.
//
// token is the raw 16 bytes, and deviceHash the HashToken of the device's own
// raw token, which the device chose and will connect with.
func (s *Store) RedeemInvite(vaultID string, token []byte, deviceID, name, deviceHash string, now int64) (retried bool, err error) {
	if err := checkDeviceFields(deviceID, name, deviceHash); err != nil {
		return false, err
	}
	if len(token) != InviteTokenBytes {
		// The same refusal an unknown invite gets: the shape of an invite
		// must not be the answer to whether it exists.
		return false, fmt.Errorf("%w: vault %q", ErrNoInvite, vaultID)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	err = immediate(s.db, func(q execer) error {
		// 1.
		var id string
		var usedBy sql.NullString
		var usedAt, cancelledAt, expiresAt sql.NullInt64
		switch err := q.QueryRow(
			`SELECT id, used_by, used_at, cancelled_at, expires_at FROM invites
			  WHERE vault_id = ? AND token_hash = ?`, vaultID, HashToken(token)).
			Scan(&id, &usedBy, &usedAt, &cancelledAt, &expiresAt); {
		case errors.Is(err, sql.ErrNoRows):
			return fmt.Errorf("%w: vault %q", ErrNoInvite, vaultID)
		case err != nil:
			return err
		}
		// 2.
		if usedAt.Valid && usedBy.Valid && usedBy.String == deviceID {
			var stored string
			err := q.QueryRow(`SELECT auth_hash FROM devices WHERE vault_id = ? AND device_id = ?`,
				vaultID, deviceID).Scan(&stored)
			if err == nil && subtle.ConstantTimeCompare([]byte(stored), []byte(deviceHash)) == 1 {
				retried = true
				return nil
			}
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
		}
		// 3.
		if usedAt.Valid || cancelledAt.Valid || (expiresAt.Valid && expiresAt.Int64 < now) {
			return fmt.Errorf("%w: vault %q", ErrNoInvite, vaultID)
		}
		// 4.
		var existing int
		if err := q.QueryRow(`SELECT COUNT(*) FROM devices WHERE vault_id = ? AND device_id = ?`,
			vaultID, deviceID).Scan(&existing); err != nil {
			return err
		}
		if existing != 0 {
			return fmt.Errorf("%w: vault %q", ErrNoInvite, vaultID)
		}
		// 5.
		if err := insertDeviceTx(q, vaultID, deviceID, name, deviceHash, now); err != nil {
			return err
		}
		if betweenRedeemWrites != nil {
			if err := betweenRedeemWrites(); err != nil {
				return err
			}
		}
		res, err := q.Exec(`UPDATE invites SET used_at = ?, used_by = ?
		                     WHERE id = ? AND used_at IS NULL AND cancelled_at IS NULL`, now, deviceID, id)
		if err != nil {
			return err
		}
		if n, err := res.RowsAffected(); err != nil {
			return err
		} else if n != 1 {
			// Unreachable under the lock this transaction holds, and refused
			// rather than trusted if it ever is: a device registered by an
			// invite nobody could mark spent is a second redemption waiting.
			return fmt.Errorf("the invite could not be marked spent (%d rows)", n)
		}
		return nil
	})
	return retried, err
}

// Invites is every invite on a vault that could still be redeemed at now:
// unspent, not cancelled, and not expired, soonest to expire first and the
// ones that never expire last, then by id so two issued in one millisecond
// have an order that is not the query plan's (rule 7). Never nil.
//
// Nothing in it redeems anything; see Invite.
func (s *Store) Invites(vaultID string, now int64) ([]Invite, error) {
	rows, err := s.db.Query(
		`SELECT id, label, expires_at FROM invites
		  WHERE vault_id = ? AND used_at IS NULL AND cancelled_at IS NULL
		    AND (expires_at IS NULL OR expires_at >= ?)
		  ORDER BY expires_at IS NULL, expires_at, id`, vaultID, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Invite{}
	for rows.Next() {
		var inv Invite
		var expires sql.NullInt64
		if err := rows.Scan(&inv.ID, &inv.Label, &expires); err != nil {
			return nil, err
		}
		if expires.Valid {
			v := expires.Int64
			inv.ExpiresAt = &v
		}
		out = append(out, inv)
	}
	return out, rows.Err()
}

// CancelInvite retires an outstanding invite by its id, so a string somebody is
// holding stops working before it expires.
//
// ErrNoInvite for an id that is unknown, malformed, already spent, cancelled or
// expired, the one error those share everywhere else and for the same reason.
// The row is marked rather than deleted: cancelled and spent are different
// facts, and the next CreateInvite on the vault sweeps it. The check and the
// mark are one statement, so a cancel racing a redemption resolves one way:
// either the redemption marked it spent first and this refuses, or this
// cancelled it first and the redemption refuses.
func (s *Store) CancelInvite(vaultID, id string, now int64) error {
	if !ValidInviteID(id) {
		return fmt.Errorf("%w: vault %q", ErrNoInvite, vaultID)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	res, err := s.db.Exec(
		`UPDATE invites SET cancelled_at = ?
		  WHERE vault_id = ? AND id = ? AND used_at IS NULL AND cancelled_at IS NULL
		    AND (expires_at IS NULL OR expires_at >= ?)`, now, vaultID, id, now)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n != 1 {
		return fmt.Errorf("%w: vault %q", ErrNoInvite, vaultID)
	}
	return nil
}

// dropUnspentInvites deletes every invite nobody has redeemed, outstanding,
// expired and cancelled alike, and returns how many could still have been
// redeemed. Only a backup's snapshot calls it; see Backup.
func (s *Store) dropUnspentInvites() (int, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	now := nowMillis()
	var outstanding int
	err := immediate(s.db, func(q execer) error {
		if err := q.QueryRow(`SELECT COUNT(*) FROM invites
		                       WHERE used_at IS NULL AND cancelled_at IS NULL
		                         AND (expires_at IS NULL OR expires_at >= ?)`, now).Scan(&outstanding); err != nil {
			return err
		}
		_, err := q.Exec(`DELETE FROM invites WHERE used_at IS NULL`)
		return err
	})
	return outstanding, err
}

// OutstandingInvites counts the invites that could still be redeemed at now.
func (s *Store) OutstandingInvites(vaultID string, now int64) (int, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM invites
		  WHERE vault_id = ? AND used_at IS NULL AND cancelled_at IS NULL
		    AND (expires_at IS NULL OR expires_at >= ?)`, vaultID, now).Scan(&n)
	return n, err
}

// InviteRows counts every invite row for a vault, spent, cancelled and expired
// included, so a test can see the sweep.
func (s *Store) InviteRows(vaultID string) (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM invites WHERE vault_id = ?`, vaultID).Scan(&n)
	return n, err
}

// nullableInt is a pointer as a value SQLite stores as NULL when it is nil.
func nullableInt(v *int64) any {
	if v == nil {
		return nil
	}
	return *v
}
