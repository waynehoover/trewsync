package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/telimus/internal/store"
	"github.com/waynehoover/telimus/internal/wire"
)

/* ---------------------------------------------------------------- *
 * What a stranger on the port learns: nothing about the build
 * ---------------------------------------------------------------- */

// sentinelVersion is what these tests set the server's version to. It is not a
// plausible release, on purpose: any occurrence of it anywhere in a pre-auth
// response is the version having escaped, and nothing else could produce this
// string by accident.
const sentinelVersion = "0.0.0-sentinel-Zq7Whk"

// Behind Caddy the port is on the internet, and every refusal below needs no
// credential at all. The proto refusal used to say "this server (version
// 0.3.2) speaks 3 to 3", which handed any prober the one string a targeted
// exploit starts from. The version moved behind authentication, where `ready`
// already carries it.
//
// This asserts the property, not three strings (rule 10). The three-string
// version of this test passed with the version added back to the pre-auth
// `auth` refusal, to `missing vault`, or to the 426 body, because it only ever
// looked at the two refusals it happened to name. So: stamp a sentinel, walk
// every pre-auth surface there is, and assert the sentinel is in none of them,
// headers included. docs/design.md, "What a stranger on the port learns".
//
// A surface added to the server and not to these tables is the hole this
// cannot close. The tables are written to be read against handleHello and
// HTTPHandler side by side.
func TestNoPreAuthSurfaceNamesTheServerVersion(t *testing.T) {
	t.Run("http", func(t *testing.T) {
		r := newRig(t)
		r.srv.SetVersion(sentinelVersion)
		hs := httptest.NewServer(HTTPHandler(r.srv, testLogger()))
		t.Cleanup(hs.Close)

		// Every verb on /health, and the 426 catch-all on paths a prober
		// actually tries, including the ones a scanner sends.
		for _, tc := range []struct{ what, method, path string }{
			{"health GET", "GET", "/health"},
			{"health HEAD", "HEAD", "/health"},
			{"health POST", "POST", "/health"},
			{"health PUT", "PUT", "/health"},
			{"health DELETE", "DELETE", "/health"},
			{"health OPTIONS", "OPTIONS", "/health"},
			{"root", "GET", "/"},
			{"root POST", "POST", "/"},
			{"unknown path", "GET", "/version"},
			{"unknown path", "GET", "/.well-known/anything"},
			{"unknown path", "POST", "/api/v1/whatever"},
			{"query string", "GET", "/?version=1"},
		} {
			req, err := http.NewRequest(tc.method, hs.URL+tc.path, nil)
			if err != nil {
				t.Fatalf("%s: %v", tc.what, err)
			}
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatalf("%s %s: %v", tc.method, tc.path, err)
			}
			body, err := io.ReadAll(res.Body)
			res.Body.Close()
			if err != nil {
				t.Fatalf("%s %s: reading: %v", tc.method, tc.path, err)
			}
			assertNoVersion(t, tc.what+" "+tc.method+" "+tc.path+" body", string(body))
			// Headers too. A Server or X-Powered-By added by a future
			// middleware is the same disclosure through a different door, and
			// nothing in the body assertions would have seen it.
			var headers strings.Builder
			headers.WriteString(res.Status)
			for k, vs := range res.Header {
				for _, v := range vs {
					headers.WriteString("\n" + k + ": " + v)
				}
			}
			assertNoVersion(t, tc.what+" "+tc.method+" "+tc.path+" headers", headers.String())
			if h := res.Header.Get("Server"); h != "" {
				t.Errorf("%s %s sends a Server header: %q", tc.method, tc.path, h)
			}
			if h := res.Header.Get("X-Powered-By"); h != "" {
				t.Errorf("%s %s sends an X-Powered-By header: %q", tc.method, tc.path, h)
			}
		}
	})

	// Every refusal handleHello can send before a credential has matched, plus
	// the two the connection can get without a hello at all. Each is the whole
	// frame as it came off the wire, not the message field, because a version
	// could as easily arrive in a field a struct would not decode.
	t.Run("websocket", func(t *testing.T) {
		for _, tc := range []struct {
			what string
			code string
			// send writes whatever produces the refusal. A raw send is used
			// where the refusal comes before the id is taken.
			send func(*rig, *client)
		}{
			{"proto too old", wire.CodeProto, func(r *rig, c *client) {
				c.sendRaw(wire.In{Op: "hello", ID: 1, Proto: wire.MinProto - 1,
					Vault: testVault, Device: "prober"})
			}},
			{"proto too new", wire.CodeProto, func(r *rig, c *client) {
				c.sendRaw(wire.In{Op: "hello", ID: 1, Proto: wire.Proto + 1,
					Vault: testVault, Device: "prober"})
			}},
			{"a Basalt plugin", wire.CodeProto, func(r *rig, c *client) {
				c.sendRaw(map[string]any{"op": "hello", "id": 1, "proto": 7,
					"crypto": "basalt/hkdf-aes-gcm/1", "vault": testVault, "device": "prober"})
			}},
			{"missing vault", wire.CodeAuth, func(r *rig, c *client) {
				c.sendJSON(wire.In{Op: "hello", Vault: "", Device: "prober"})
			}},
			{"no credential", wire.CodeAuth, func(r *rig, c *client) {
				c.sendJSON(wire.In{Op: "hello", Vault: testVault, Device: "prober"})
			}},
			{"bad token", wire.CodeAuth, func(r *rig, c *client) {
				c.sendJSON(wire.In{Op: "hello", Vault: testVault, Device: "prober",
					DeviceID: deviceID("prober"), Token: "not the token"})
			}},
			{"unknown vault", wire.CodeAuth, func(r *rig, c *client) {
				c.sendJSON(wire.In{Op: "hello", Vault: "no-such-vault", Device: "prober",
					DeviceID: deviceID("prober"), Token: deviceKey("prober")})
			}},
			{"reserved device id", wire.CodeAuth, func(r *rig, c *client) {
				c.sendJSON(wire.In{Op: "hello", Vault: testVault, Device: "prober",
					DeviceID: store.ReservedDeviceIDPrefix + "x", Token: deviceKey("prober")})
			}},
			{"bad vault name", wire.CodeBadName, func(r *rig, c *client) {
				c.sendJSON(wire.In{Op: "hello",
					Vault: strings.Repeat("v", store.MaxVaultLen+1), Device: "prober"})
			}},
			{"bad device name", wire.CodeBadName, func(r *rig, c *client) {
				c.sendJSON(wire.In{Op: "hello", Vault: testVault, Device: "a\nb"})
			}},
			{"negative cursor", wire.CodeProtoState, func(r *rig, c *client) {
				c.sendJSON(wire.In{Op: "hello", Vault: testVault, Device: "prober", Cursor: -1})
			}},
			{"an invite never issued", wire.CodeAuth, func(r *rig, c *client) {
				c.sendJSON(redeemHello([]byte("sixteen byte tok"), "prober"))
			}},
			{"a redemption with a short token", wire.CodeBadEntry, func(r *rig, c *client) {
				h := redeemHello([]byte("sixteen byte tok"), "prober")
				h.Token = "short"
				c.sendJSON(h)
			}},
			{"first op is not hello", wire.CodeProtoState, func(r *rig, c *client) {
				c.sendRaw(wire.In{Op: "get", ID: 1})
			}},
			{"hello is not JSON", wire.CodeProtoState, func(r *rig, c *client) {
				if err := c.conn.Write(c.ctx, websocket.MessageText, []byte(`{"op":`)); err != nil {
					c.t.Fatalf("write: %v", err)
				}
			}},
			{"first frame is binary", wire.CodeProtoState, func(r *rig, c *client) {
				c.sendBinary([]byte("not a hello"))
			}},
			{"no hello at all", wire.CodeProtoState, func(r *rig, c *client) {
				// The deadline fires on its own; nothing is sent.
			}},
		} {
			t.Run(tc.what, func(t *testing.T) {
				r := newRig(t)
				r.srv.SetVersion(sentinelVersion)
				r.srv.helloTimeout = 200 * time.Millisecond
				cl := r.dial("prober")
				tc.send(r, cl)
				frame := cl.recvFrame()
				var got struct {
					Res  string `json:"res"`
					Code string `json:"code"`
				}
				if err := json.Unmarshal(frame, &got); err != nil {
					t.Fatalf("%s: the refusal is not JSON: %v\n%s", tc.what, err, frame)
				}
				if got.Res != "err" || got.Code != tc.code {
					t.Fatalf("%s: got res %q code %q, want an err with code %q\n%s",
						tc.what, got.Res, got.Code, tc.code, frame)
				}
				assertNoVersion(t, tc.what, string(frame))
			})
		}
	})
}

// assertNoVersion fails when the sentinel, or anything that looks like it,
// appears in a pre-auth response.
func assertNoVersion(t *testing.T, what, got string) {
	t.Helper()
	if strings.Contains(got, sentinelVersion) {
		t.Fatalf("%s names the server version:\n%s", what, got)
	}
	// The sentinel with its decoration stripped, in case something prints only
	// a part of it. Nothing legitimate contains this either.
	if strings.Contains(got, "sentinel") {
		t.Fatalf("%s carries part of the server version:\n%s", what, got)
	}
}

// The version is still there for a device that has proved it holds the vault.
// Withholding it everywhere would take the one line an operator reads to know
// which end to upgrade.
func TestReadyStillCarriesTheVersionAfterAuthentication(t *testing.T) {
	r := newRig(t)
	r.srv.SetVersion(sentinelVersion)
	ready, _ := r.dial("a").hello(0)
	if ready.ServerVersion != sentinelVersion {
		t.Fatalf("serverVersion after auth = %q, want %q", ready.ServerVersion, sentinelVersion)
	}
}

// The proto refusal still has to say the numbers an old client needs, or the
// disclosure rule above would be satisfied by saying nothing useful at all.
// (disclosure_test.go:224; its crypto half went with the crypto field.)
func TestTheProtoRefusalStillNamesWhatThisServerSpeaks(t *testing.T) {
	r := newRig(t)
	r.srv.SetVersion(sentinelVersion)

	cl := r.dial("prober")
	cl.sendRaw(wire.In{Op: "hello", ID: 1, Proto: wire.MinProto - 1,
		Vault: testVault, Device: "prober"})
	msg := cl.expectErr(wire.CodeProto)
	// Derived, not written down: these assert that the refusal names the version
	// that was asked for and the range this server speaks, which is a property
	// of the machinery rather than of any particular number.
	for _, want := range []string{
		fmt.Sprintf("protocol %d", wire.MinProto-1),
		fmt.Sprintf("%d to %d", wire.MinProto, wire.Proto),
	} {
		if !strings.Contains(msg, want) {
			t.Fatalf("the proto refusal does not name %q: %q", want, msg)
		}
	}
}

// /health answers "ok" and nothing else. Pinned separately from the version
// property because the body being exactly two bytes is its own promise: a
// health endpoint that grows a JSON summary is a health endpoint that will one
// day grow a version into it.
func TestHealthSaysOkAndNothingElse(t *testing.T) {
	r := newRig(t)
	r.srv.SetVersion(sentinelVersion)
	hs := httptest.NewServer(HTTPHandler(r.srv, testLogger()))
	t.Cleanup(hs.Close)

	res, err := http.Get(hs.URL + "/health")
	if err != nil {
		t.Fatalf("GET /health: %v", err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("reading /health: %v", err)
	}
	if res.StatusCode != http.StatusOK {
		t.Fatalf("/health answered %s", res.Status)
	}
	if string(body) != "ok\n" {
		t.Fatalf("/health body = %q, want exactly \"ok\\n\"", body)
	}
}

/* ---------------------------------------------------------------- *
 * What a stranger on the port learns: nothing about the vault either
 * ---------------------------------------------------------------- */

// Every pre-auth refusal is a function of the request, never of the vault.
//
// The suspicion this pins was that `auth` correctly says nothing while the
// codes around it still oracle: "this vault id parses", "this proto is old",
// "this vault is the one served". The first two turn out to be facts a caller
// already holds. `proto`, `badname`, `protostate` and `badentry` are decided by
// checking the frame against constants that are in this repository and in
// plan/protocol.md, so a prober learns nothing it could not have computed
// offline, and collapsing them into `auth` would cost a real client the one
// thing it is for: telling a person which end to fix. A client that cannot
// tell `proto` from `auth` cannot say whether to upgrade the server or the
// plugin, and one that cannot tell `badname` from `auth` sends somebody
// hunting a credential bug over a 65-character device name.
//
// The third is not a fact the caller holds, and Basalt leaked it: on a server
// told which vault it serves, a hello for any other vault was refused before
// its shape was judged and with a message naming the served vault. Every row
// below runs against both kinds of server for that reason.
//
// So the test is the boundary rather than a list of codes: the same probe
// against a vault this server serves, and against one it has never heard of,
// must produce the same frame, byte for byte. Anything that later starts
// answering differently for a vault that exists shows up here, whatever code
// it chooses.
func TestNoPreAuthRefusalDependsOnWhetherTheVaultExists(t *testing.T) {
	// One vault that is real in every way a vault can be: devices on it,
	// entries in it and an outstanding invite. If any of those can be sensed
	// from outside, this is the rig that would show it. Served explicitly or
	// not, because a server told which vault it serves has one more thing it
	// could leak, the name, and Basalt's did.
	furnished := func(t *testing.T, serving bool) *rig {
		t.Helper()
		r := newRig(t)
		if serving {
			r.srv.Serves(testVault)
		}
		r.device("laptop")
		r.device("phone")
		r.seed("note.md", "hello")
		r.invite(time.Hour)
		return r
	}

	long := strings.Repeat("x", store.MaxDeviceLen+1)
	for _, tc := range []struct {
		what string
		// code is what this probe is aiming at. Asserted as well as the two
		// frames matching, because two frames match beautifully when every
		// probe in the table is being refused by the same early check: this
		// table passed in full, and vacuously, when a missing `proto` field
		// meant every row got the protocol refusal (rule 10).
		code string
		// probe takes the vault name to aim at, so the same frame goes to a
		// vault that exists and to one that does not.
		probe func(vault string) wire.In
	}{
		{"no credential", wire.CodeAuth, func(v string) wire.In {
			return wire.In{Op: "hello", Vault: v, Device: "prober"}
		}},
		{"a wrong token", wire.CodeAuth, func(v string) wire.In {
			return wire.In{Op: "hello", Vault: v, Device: "prober", DeviceID: deviceID("laptop"),
				Token: deviceKey("not the laptop")}
		}},
		{"a malformed token", wire.CodeAuth, func(v string) wire.In {
			return wire.In{Op: "hello", Vault: v, Device: "prober", DeviceID: deviceID("laptop"),
				Token: "not the token"}
		}},
		{"a malformed device id", wire.CodeBadName, func(v string) wire.In {
			// Shape before credential, and as `badname` rather than `auth`, so
			// the shape of an id never becomes the answer to whether that
			// device exists, nor to whether the vault is served.
			return wire.In{Op: "hello", Vault: v, Device: "prober",
				DeviceID: strings.Repeat("d", store.MaxDeviceIDLen+1), Token: "anything"}
		}},
		{"a reserved device id", wire.CodeAuth, func(v string) wire.In {
			return wire.In{Op: "hello", Vault: v, Device: "prober",
				DeviceID: store.ReservedDeviceIDPrefix + "laptop", Token: deviceKey("laptop")}
		}},
		{"a device id that is not registered", wire.CodeAuth, func(v string) wire.In {
			return wire.In{Op: "hello", Vault: v, Device: "prober",
				DeviceID: deviceID("stranger"), Token: deviceKey("stranger")}
		}},
		{"an invite that was never issued", wire.CodeAuth, func(v string) wire.In {
			h := redeemHello([]byte("sixteen byte tok"), "newcomer")
			h.Vault = v
			return h
		}},
		{"a malformed invite", wire.CodeAuth, func(v string) wire.In {
			h := redeemHello(nil, "newcomer")
			h.Vault, h.Invite = v, "not an invite"
			return h
		}},
		{"a redemption onto a device that exists", wire.CodeAuth, func(v string) wire.In {
			h := redeemHello([]byte("sixteen byte tok"), "laptop")
			h.Vault = v
			return h
		}},
		{"a redemption with a malformed device id", wire.CodeBadName, func(v string) wire.In {
			h := redeemHello([]byte("sixteen byte tok"), "newcomer")
			h.Vault, h.DeviceID = v, "not base64!"
			return h
		}},
		{"a redemption with a short token", wire.CodeBadEntry, func(v string) wire.In {
			h := redeemHello([]byte("sixteen byte tok"), "newcomer")
			h.Vault, h.Token = v, "short"
			return h
		}},
		{"an over-long device name", wire.CodeBadName, func(v string) wire.In {
			return wire.In{Op: "hello", Vault: v, Device: long}
		}},
		{"a negative cursor", wire.CodeProtoState, func(v string) wire.In {
			return wire.In{Op: "hello", Vault: v, Device: "prober", Cursor: -1}
		}},
		{"a protocol this server does not speak", wire.CodeProto, func(v string) wire.In {
			return wire.In{Op: "hello", ID: 1, Proto: wire.Proto + 1, Vault: v, Device: "prober"}
		}},
	} {
		for _, serving := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s, serving=%v", tc.what, serving), func(t *testing.T) {
				real := furnished(t, serving)
				cl := real.dial("prober")
				cl.sendJSON(tc.probe(testVault))
				present := cl.recvFrame()

				absent := furnished(t, serving)
				cl = absent.dial("prober")
				cl.sendJSON(tc.probe("no-such-vault"))
				missing := cl.recvFrame()

				if string(present) != string(missing) {
					t.Fatalf("the refusal differs by whether the vault exists:\n  served: %s\n  unknown: %s",
						present, missing)
				}
				if !strings.Contains(string(present), `"code":"`+tc.code+`"`) {
					t.Fatalf("this probe never reached the check it is about: wanted %s, got %s",
						tc.code, present)
				}
			})
		}
	}
}

// An invalid invite reveals nothing about the registered devices.
func TestInvalidInviteDoesNotDiscloseDeviceCount(t *testing.T) {
	populated := newRig(t)
	for i := 0; i < 24; i++ {
		populated.device(fmt.Sprintf("device-%d", i))
	}
	empty := newRig(t)

	// Both clients are fresh, so sendJSON gives each the same request id and
	// fills in the current protocol number; a probe left at protocol zero is
	// refused before it reaches the invite at all.
	probe := redeemHello([]byte("sixteen byte tok"), "newcomer")

	cl := populated.dial("prober")
	cl.sendJSON(probe)
	withDevices := cl.recvFrame()

	cl = empty.dial("prober")
	cl.sendJSON(probe)
	withoutDevices := cl.recvFrame()

	if string(withDevices) != string(withoutDevices) {
		t.Fatalf("a populated vault answers a bogus invite differently:\n  populated:  %s\n  empty: %s",
			withDevices, withoutDevices)
	}
	if !strings.Contains(string(withDevices), `"code":"auth"`) {
		t.Fatalf("a bogus invite is not refused as auth: %s", withDevices)
	}
}
