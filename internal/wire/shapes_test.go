package wire

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/waynehoover/trewsync/internal/store"
)

// The frames protocol 1 changed, as the client will read them (plan/protocol.md,
// "Handshake" and "Devices and invites"). Asserted over the marshalled JSON, not
// the structs, because the point is which keys are and are not there.
func TestTheShapesProtocolOneSends(t *testing.T) {
	expires := int64(1234)
	for _, c := range []struct {
		what string
		v    any
		want string
	}{
		{"invited", Invited{Res: "invited", ID: 3, Invite: "id", Token: "tok", ExpiresAt: &expires},
			`{"res":"invited","id":3,"invite":"id","token":"tok","expiresAt":1234}`},
		{"an invite that never expires", Invited{Res: "invited", ID: 3, Invite: "id", Token: "tok"},
			`{"res":"invited","id":3,"invite":"id","token":"tok","expiresAt":null}`},
		{"redeemed", Redeemed{Res: "redeemed", ID: 1, DeviceID: "dev"},
			`{"res":"redeemed","id":1,"deviceId":"dev"}`},
		{"uninvited", Uninvited{Res: "uninvited", ID: 4, Invite: "id"},
			`{"res":"uninvited","id":4,"invite":"id"}`},
		{"a listing's invite row", store.Invite{ID: "id", Label: "tablet", ExpiresAt: &expires},
			`{"invite":"id","label":"tablet","expiresAt":1234}`},
		{"an empty listing", DeviceList{Res: "devices", ID: 5, Devices: []DeviceStatus{}, Invites: []store.Invite{}},
			`{"res":"devices","id":5,"devices":[],"invites":[]}`},
	} {
		b, err := json.Marshal(c.v)
		if err != nil {
			t.Fatalf("%s: %v", c.what, err)
		}
		if string(b) != c.want {
			t.Errorf("%s marshals as\n  %s\nwant\n  %s", c.what, b, c.want)
		}
	}

	// ready: the epoch is always there, and nothing of the key schedule is.
	b, _ := json.Marshal(Ready{Res: "ready", ID: 1, Proto: Proto, MinProto: MinProto, Epoch: "e"})
	var ready map[string]any
	if err := json.Unmarshal(b, &ready); err != nil {
		t.Fatal(err)
	}
	if ready["epoch"] != "e" {
		t.Errorf("ready carries epoch %v", ready["epoch"])
	}
	for _, gone := range []string{"wrapped", "crypto", "maxDevices"} {
		if _, has := ready[gone]; has {
			t.Errorf("ready still carries %q: %s", gone, b)
		}
	}
}

// No field of Basalt's key schedule survives in what a client may send: a
// field left on the union would be decoded and silently ignored, and a client
// sending it would believe it had been heard (PLAN.md section 7: grep for the
// crypto's words).
func TestNoFieldOfTheCryptoSurvives(t *testing.T) {
	for _, typ := range []reflect.Type{reflect.TypeOf(In{}), reflect.TypeOf(PutEntry{}), reflect.TypeOf(PutMeta{})} {
		for i := 0; i < typ.NumField(); i++ {
			tag := strings.Split(typ.Field(i).Tag.Get("json"), ",")[0]
			for _, gone := range []string{"crypto", "claim", "wrapped", "auth", "sealed", "mac", "parent", "allowLast"} {
				if strings.EqualFold(tag, gone) {
					t.Errorf("%s.%s still carries %q", typ.Name(), typ.Field(i).Name, tag)
				}
			}
		}
	}
	// Protocol 2 added undo and search, and protocol 3 settings, so the range
	// is 1 to 3 and protocols 1 and 2 are still answered as they were.
	if Proto != 3 || MinProto != 1 || ProtoUndo != 2 || ProtoSearch != 2 || ProtoConfig != 3 {
		t.Errorf("the protocol range is %d to %d with undo and search from %d and %d and settings from %d; "+
			"it is 1 to 3, undo and search from 2, settings from 3", MinProto, Proto, ProtoUndo, ProtoSearch, ProtoConfig)
	}
}

// The numbers the contract's constants section names, as this side holds them.
func TestTheWireConstantsAreTheContracts(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "protocol-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Constants struct {
			Proto            int   `json:"proto"`
			MinProto         int   `json:"minProto"`
			InviteTokenBytes int   `json:"inviteTokenBytes"`
			DeviceTokenBytes int   `json:"deviceTokenBytes"`
			MaxNameBytes     int   `json:"maxNameBytes"`
			ChunkMax         int64 `json:"chunkMax"`
		} `json:"constants"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	c := f.Constants
	for _, check := range []struct {
		what      string
		got, want int64
	}{
		{"proto", int64(Proto), int64(c.Proto)},
		{"min proto", int64(MinProto), int64(c.MinProto)},
		{"invite token bytes", int64(store.InviteTokenBytes), int64(c.InviteTokenBytes)},
		{"device token bytes", int64(store.DeviceTokenBytes), int64(c.DeviceTokenBytes)},
		{"vault name bytes", int64(store.MaxVaultLen), int64(c.MaxNameBytes)},
		{"device name bytes", int64(store.MaxDeviceLen), int64(c.MaxNameBytes)},
		{"chunk max", store.ChunkMax, c.ChunkMax},
	} {
		if check.got != check.want {
			t.Errorf("%s: this side holds %d and the contract says %d", check.what, check.got, check.want)
		}
	}
}
