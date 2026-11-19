package mcp

import (
	"bytes"
	"net/http"
	"sync"
	"testing"

	"github.com/waynehoover/trewsync/internal/store"
)

// Security review L12: a wrong token is checked outside the endpoint's slots,
// which are for requests valid tokens make, and the checking has a small cap
// of its own.
func TestWrongTokensDoNotTakeTheEndpointsSlots(t *testing.T) {
	wrong := store.EncodeToken(bytes.Repeat([]byte{7}, store.MCPTokenBytes))

	// holdFirstCheck makes the first token check wait until release closes.
	holdFirstCheck := func(r *rig) (checking, release chan struct{}) {
		checking, release = make(chan struct{}), make(chan struct{})
		var first sync.Once
		r.h.duringAuth = func() {
			held := false
			first.Do(func() { held = true })
			if held {
				close(checking)
				<-release
			}
		}
		return checking, release
	}

	t.Run("a valid token gets the slot while a wrong one is checked", func(t *testing.T) {
		r := newRig(t, withLimits(Limits{InFlight: 1, FailBurst: 1000}))
		valid, _ := r.token(store.ScopeRead)
		checking, release := holdFirstCheck(r)
		done := make(chan int, 1)
		go func() {
			status, _, _ := r.post(legacy(wrong, toolCall("vault_status")))
			done <- status
		}()
		<-checking
		status, _, body := r.post(legacy(valid, toolCall("vault_status")))
		close(release)
		if status != http.StatusOK {
			t.Fatalf("a valid token was kept out while a wrong one was checked: %d %s", status, body)
		}
		if s := <-done; s != http.StatusUnauthorized {
			t.Fatalf("the wrong token ended %d, want 401", s)
		}
	})

	t.Run("checking has a cap of its own", func(t *testing.T) {
		r := newRig(t, withLimits(Limits{AuthInFlight: 1, FailBurst: 1000}))
		checking, release := holdFirstCheck(r)
		done := make(chan int, 1)
		go func() {
			status, _, _ := r.post(legacy(wrong, toolCall("vault_status")))
			done <- status
		}()
		<-checking
		status, h, _ := r.post(legacy(wrong, toolCall("vault_status")))
		close(release)
		if status != http.StatusTooManyRequests || h.Get("Retry-After") == "" {
			t.Fatalf("a second token was checked past the cap: %d %q", status, h.Get("Retry-After"))
		}
		if s := <-done; s != http.StatusUnauthorized {
			t.Fatalf("the wrong token ended %d, want 401", s)
		}
	})
}
