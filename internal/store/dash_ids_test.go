package store

import "testing"

// An id a person types after a command must never be read as a flag, as
// TestNoInviteIDBeginsWithADash holds for invites.
func TestNoOperationIDBeginsWithADash(t *testing.T) {
	for i := 0; i < 4096; i++ {
		id, err := newOperationID()
		if err != nil {
			t.Fatal(err)
		}
		if id[0] == '-' {
			t.Fatalf("operation id %q begins with a dash", id)
		}
	}
}

func TestNoMCPTokenIDBeginsWithADash(t *testing.T) {
	for i := 0; i < 4096; i++ {
		id, err := newMCPTokenID()
		if err != nil {
			t.Fatal(err)
		}
		if EncodeToken(id)[0] == '-' {
			t.Fatalf("token id %q begins with a dash", EncodeToken(id))
		}
	}
}
