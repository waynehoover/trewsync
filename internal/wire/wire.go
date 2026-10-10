// Package wire is the TrewSync protocol's message shapes and nothing else.
//
// It holds no state, opens no connection and knows no policy, so the whole
// vocabulary can be exercised without a server. That separation is deliberate:
// the cleanest boundary in Obsidian's engine is the one between orchestration
// and a transport that knows no policy, and this is the equivalent seam on the
// server side.
//
// Every reply names its outcome. The protocol's first design rule exists
// because in Obsidian's protocol `{res:"ok"}` on a push means "discard the
// upload", making the most natural success reply the destructive one. There is
// no `ok` here.
//
// The protocol is version 1, specified in plan/protocol.md: Basalt's protocol 7
// with the encryption taken out. Paths and bodies are plaintext, a device
// authenticates with a random token of its own, and a new device joins by
// redeeming a single-use invite token.
package wire

import (
	"errors"
	"unicode/utf8"

	"github.com/waynehoover/trewsync/internal/store"
)

// Proto is the newest protocol version this server implements, and MinProto the
// oldest it still answers. A version outside that range is refused at hello
// naming both numbers, not negotiated: interoperating with a version we have
// not seen is how a silent incompatibility gets shipped, and the one it would
// ship here is a device that connects and syncs under a credential nobody can
// revoke.
//
// Version 1 is this product's first. Basalt's protocol 7 is refused as `proto`,
// so a Basalt plugin pointed at this server is told which versions the two ends
// speak rather than failing to authenticate.
//
// Version 2 is protocol 1 and undo (PLAN.md section 4.5): the `undo` request,
// and the operation that wrote a version on each `history` entry; and search,
// the `search` request, which answers from the same literal search as MCP's
// search_notes. Protocol 2 had not been released when search joined it, so
// it is part of 2 rather than a version 3. Nothing in protocol 1 changed, so a session is answered in the version its hello asked
// for, and one that asked for 1 is answered exactly as protocol 1 was: no
// `undo`, which is an unknown op there, and history entries as they were. The
// upgrade order is the server first (docs/server.md, "Upgrade order"), so
// every device on protocol 1 keeps syncing through the upgrade.
//
// Version 3 is protocol 2 and settings (plan/settings-sync.md): a session of 3
// may write and is sent paths inside a profile root that paths.CheckConfig
// accepts. A session of 1 or 2 is held to paths.Check, as before, and never
// sees a settings entry: each is left out of its batches, whose ranges still
// cover it, the way a device's own echo is.
const (
	Proto    = 3
	MinProto = 1
	// ProtoUndo is the first version with undo, ProtoSearch the first with
	// search, and ProtoConfig the first with settings.
	ProtoUndo   = 2
	ProtoSearch = 2
	ProtoConfig = 3
)

// MaxRequestID bounds a client-chosen request id: an integer from 1 to 2^32-1.
// Zero is not a legal id, which is what makes a request that carries none
// detectable rather than indistinguishable from one that carries id 0.
const MaxRequestID = 1<<32 - 1

// Error codes. `code` is for the client to act on, `msg` is for a human to
// read; the protocol requires both, because an error a device cannot act on
// and a person cannot read is how a silent failure starts.
//
// Every code here has a row in the error table of plan/protocol.md, which also
// says whether the session continues after it, and
// TestI2RetryableMatchesTheProtocolDoc holds the two lists together.
const (
	CodeProto = "proto" // unsupported protocol number; the session closes
	CodeAuth  = "auth"  // bad credential, unknown invite, or not allowed

	// CodeBadEntry is a structurally invalid put: a folder carrying chunks, a
	// size that is not the sum of its chunks, a prev equal to path. Rejected
	// before any body is read where it can be, and the session continues.
	CodeBadEntry = "badentry"
	CodeStale    = "stale" // the path changed; reconcile and retry the write
	// CodeBadName is a vault or device name the server will not store: over
	// its bound, or carrying a control character, or a device id of the wrong
	// shape. Paths have their own code.
	CodeBadName = "badname"
	// CodeBadPath is a path the protocol refuses (plan/protocol.md, "Paths").
	// It rejects the entry and the session continues. The message begins with
	// the reason code and a colon, "dotprefix: ...", because the wire has one
	// code for twelve rules and the rule is what the person whose file will
	// not sync needs to know (PLAN.md section 4.9).
	CodeBadPath = "badpath"
	// CodeCollision is a create, or the destination of a move, whose folded
	// key is another live path's: two notes a case-folding disk would hold as
	// one (PLAN.md section 4.1). It rejects the entry and the session
	// continues. The message names the live path it collides with.
	CodeCollision = "collision"
	// CodeBadChunk is an uploaded body that does not decode as a frame or does
	// not hash to the name it was asked for, or a chunk name that is not a hex
	// SHA-256.
	CodeBadChunk = "badchunk"
	// CodeToolarge is a file, frame or chunk above the advertised ceiling.
	CodeToolarge = "toolarge"
	// CodeNoSpace is a write refused for want of disk.
	CodeNoSpace = "nospace"
	// CodeNoUID is a get for a uid this vault does not have.
	CodeNoUID = "nouid"
	// CodeNoContent is a get for an entry that has no body: a folder, or a
	// deletion. Distinct from CodeNoUID because the entry exists, and distinct
	// from an empty chunk list because a zero-byte file is a real file.
	CodeNoContent = "nocontent"
	// CodeNoChunk is a fetch for a chunk the server does not hold. Loud, so a
	// client is never left waiting for a body that is not coming.
	CodeNoChunk = "nochunk"
	// CodeNoDevice names a device this vault does not have: a revoke for an id
	// that is already gone. Its own code, beside nouid and nochunk, because
	// the protocol says what is missing rather than making a caller read the
	// sentence: a list read a moment ago is stale and wants refreshing, which
	// is a different act from every other refusal a revoke can get.
	CodeNoDevice = "nodevice"
	// CodeNoUndo is an undo (protocol 2) that cannot be done, whatever the
	// device does next: no such operation, one already undone, one whose
	// before-image a purge has taken, one that left nothing to put back, or
	// a folder it made that is not empty. The message says which. An undo
	// refused because a note changed since is `stale` instead, since that
	// one has an answer: the copy.
	CodeNoUndo = "noundo"
	// CodeTooMany is a device search (protocol 2) over its budget: more
	// searches at once, or more requests or reply bytes in a moment, than the
	// server gives one device, or than it runs for every device together. It
	// carries retryAfterMs, and the session continues; asking again after
	// the wait can succeed, which is why it is retryable. Searches have a
	// budget of their own so that a person searching cannot slow another
	// device's sync.
	CodeTooMany = "toomany"
	// CodeProtoState is a message that does not belong in the current state:
	// a put before hello, a stray binary frame, a frame that is not text. The
	// session closes.
	CodeProtoState = "protostate"
	// CodeInternal is a server-side fault. The put is not committed.
	CodeInternal = "internal"
	// CodeBusy is pre-authentication admission pressure or server shutdown.
	// Honest refusal beats degrading. It is the one refusal a client should
	// simply wait out, which is what `retryable` and `retryAfterMs` say.
	CodeBusy = "busy"
	// CodeCursor is a client whose cursor is ahead of the server's.
	//
	// It means the server has lost history the client has already applied:
	// restored from an old backup, or pointed at the wrong vault. Left alone,
	// the server reissues those uids for different content and the two diverge
	// with both sides reporting success. It is refused instead, because a
	// refusal is reversible and silent divergence is not. A client that sends
	// the epoch its cursor belongs to is spared it after a restore: see
	// In.Epoch.
	CodeCursor = "cursor"
)

/* ---------------------------------------------------------------- *
 * Client to server
 * ---------------------------------------------------------------- */

// In is the union of every client frame.
//
// Clients send flat JSON discriminated by `op`, so one struct with a switch
// beats per-op types plus a two-pass unmarshal. The cost is that a field only
// meaningful to one op is visible to all of them, which is why each handler
// validates what it uses rather than trusting the zero value.
type In struct {
	Op string `json:"op"`

	// ID is the client's request id, echoed on the reply and on any error
	// refusing it. Every request that expects a reply carries one; a request
	// that does not ends the session. Before ids, a reply was matched to the
	// one request in flight by position, and three separate client defects
	// came from that.
	ID int64 `json:"id,omitempty"`

	// hello
	//
	// A hello is one of two things, and says which by what it carries. A
	// device connecting names itself with DeviceID and proves it with Token,
	// its own random 32-byte credential in unpadded base64url. A device
	// joining carries Invite, the invite token, and with it the DeviceID and
	// Token it has chosen and will connect with from then on; redeeming the
	// invite is what registers them (plan/protocol.md, "Invite redemption").
	// A hello carrying neither is refused.
	Proto  int    `json:"proto"`
	Vault  string `json:"vault"`
	Token  string `json:"token"`
	Device string `json:"device"`
	Cursor int64  `json:"cursor"`
	// Epoch is the store epoch the client's cursor was read under, as the
	// `ready` that began it said. Optional, and empty on a first connect.
	//
	// Settled in M1 (plan/protocol.md, "Device session"). An epoch that is
	// not the store's means the server was restored or replaced, so the uid
	// sequence the cursor points into may have been reissued: the server
	// then ignores the cursor and replays the whole vault, rather than
	// refusing a cursor that is ahead or, worse, continuing from one that is
	// not and skipping the versions that replaced the ones it saw.
	Epoch string `json:"epoch,omitempty"`
	// Applied is a device's completed local checkpoint, never a metadata receipt.
	Applied *int64 `json:"applied,omitempty"`
	// DeviceID names the row in the vault's device list this connection
	// claims to be, and on `revoke` the row being revoked. It is deliberately
	// not the same field as Device. Device is a label a person reads beside a
	// version and two laptops may share it; this is the identity, and the
	// difference is the whole of what makes revoking one device rather than
	// "everything called laptop" possible.
	DeviceID string `json:"deviceId,omitempty"`

	// rename: Name is the new label for this device's own row, bounded exactly
	// as the hello's `device` is. It is never an identifier: two devices may
	// share one.
	Name string `json:"name,omitempty"`

	// Invite, at hello, is the invite token being redeemed: 16 bytes in
	// unpadded base64url. On `uninvite` it is the invite's id, the non-secret
	// handle a listing shows, which cannot redeem anything; the two never
	// meet, because only the device that asked for an invite is ever shown
	// its token (plan/protocol.md, "Devices and invites").
	Invite string `json:"invite,omitempty"`
	// invite: TTLMs is how long the invite lives, zero for the default and
	// never more than the cap; Label is a name for it a person reads in the
	// listing, bounded like a device name.
	TTLMs int64  `json:"ttlMs,omitempty"`
	Label string `json:"label,omitempty"`

	// put
	Path     string   `json:"path"`
	Meta     PutMeta  `json:"meta"`
	Chunks   []string `json:"chunks"`
	Base     int64    `json:"base"`
	PrevBase int64    `json:"prevBase"`

	// get
	UID int64 `json:"uid"`

	// history and deleted
	//
	// Before paginates: the oldest uid already held, to ask for the page before
	// it. Zero starts at the newest. Limit is advisory and the server bounds it.
	//
	// Shared by both listings on purpose. They are ordered the same way, by uid
	// descending, so the cursor means the same thing in both and a client that
	// can page one can page the other (F21).
	Before int64 `json:"before"`
	Limit  int   `json:"limit"`

	// putmany
	Entries []PutEntry `json:"entries"`

	// undo (protocol 2): OpID is the operation to undo, as a history entry's
	// `op` names it, and ToCopy asks for the copy, which writes the versions
	// the operation replaced beside their notes and changes nothing else.
	OpID   string `json:"opId,omitempty"`
	ToCopy bool   `json:"toCopy,omitempty"`

	// search (protocol 2): the server's literal search, the one MCP's
	// search_notes answers from (plan/protocol.md, "Search"). Query is the
	// literal, or the tag in tag mode; Mode is content (the default),
	// filename, both or tag; Folder keeps only notes beneath it;
	// IncludeChildren, true when absent, lets a tag match its nested tags;
	// ContextLines is 0 to 3 lines each side; After is the previous reply's
	// nextAfter. Limit, shared with the listings, is 1 to 200 matches, 50
	// when absent.
	Query           string `json:"query,omitempty"`
	Mode            string `json:"mode,omitempty"`
	Folder          string `json:"folder,omitempty"`
	CaseSensitive   bool   `json:"caseSensitive,omitempty"`
	IncludeChildren *bool  `json:"includeChildren,omitempty"`
	ContextLines    int    `json:"contextLines,omitempty"`
	After           string `json:"after,omitempty"`
}

// PutEntry is one file inside a batched put.
//
// The same fields a single put carries. A batch exists because latency
// multiplies round trips: two hundred paths were two hundred requests, and on a
// link with four hundred milliseconds in it that is eighty seconds of waiting
// for permission to send things the server was always going to want.
type PutEntry struct {
	Path     string   `json:"path"`
	Meta     PutMeta  `json:"meta"`
	Chunks   []string `json:"chunks"`
	Base     int64    `json:"base"`
	PrevBase int64    `json:"prevBase"`
}

// Entry converts one batched put into the store's record.
func (p PutEntry) Entry(device string) store.Entry {
	return store.Entry{
		Path:    p.Path,
		Size:    p.Meta.Size,
		CTime:   p.Meta.CTime,
		MTime:   p.Meta.MTime,
		Folder:  p.Meta.Folder,
		Deleted: p.Meta.Deleted,
		Device:  device,
		Prev:    p.Meta.Prev,
		Chunks:  chunkList(p.Chunks),
	}
}

// chunkList is the chunk names a put carried, as an array even when the put
// carried none (T59).
//
// A deletion or a folder has no chunks, and a writer may send null for them or
// leave the field out, which both decode to nil. The committed entry is what
// every other device is sent, and a nil list marshals to "chunks":null, which
// the client's batch check refuses as a protocol error: one writer's omission
// used to drop every other connected device. The store's read paths already
// give an empty array (store.Entry.Chunks); this is the same rule where the
// entry is made rather than where it is read.
func chunkList(names []string) []string {
	if names == nil {
		return []string{}
	}
	return names
}

// MaxBatchEntries bounds one batched put.
//
// A cap rather than a stream, because the server holds every entry of a batch
// in memory while it waits for the bodies, and because a want list has to be
// computed from all of them before any of it can be answered. Two hundred and
// fifty six is enough that a first sync is a handful of round trips and small
// enough that a batch is never a reason to run out of anything.
const MaxBatchEntries = 256

// MaxBatchBytes bounds one batched put two ways: the encoded `putmany` frame
// may not exceed it, and neither may the summed declared sizes of the entries
// in it (S18), which is the raw budget of plan/protocol.md ("Limits"). Both are
// advertised in `ready` so a client can split a batch before sending rather
// than discover the bound by being refused.
//
// The frame bound is what makes "every legal message is receivable" true: the
// read limit is set above it (server.ReadLimit), so a frame over this cap is
// read in full and refused with `toolarge`, never dropped with a bare
// disconnect that the client answers by retrying the identical batch for ever
// (S22). The size bound is what stops one authenticated batch streaming
// gigabytes of bodies: 256 entries at the 64 MiB file limit was 16 GiB of
// allowed upload in one exchange. A file whose size alone exceeds this goes
// through a single `put`, which is bounded by perFileMax instead.
//
// 16 MiB is thousands of notes at the sizes people write them and small enough
// that a batch is never why a server ran out of memory holding it.
const MaxBatchBytes = 16 << 20

// MaxFetchBytes bounds the summed raw size of the bodies one `fetch` may ask
// for (S21). The server knows every size from the same stat that answers
// presence; a client bounds itself with the declared sizes of the files it is
// fetching, which are exactly those sums. Over it is `toolarge` with no bodies.
//
// 64 MiB matches the default file limit, so one fetch can always carry one
// file, and a first download of a text vault is still a handful of round trips.
const MaxFetchBytes = 64 << 20

// PutMeta is the metadata of one version. It is nested rather than flat so that
// the fields a client assembles from the filesystem travel together and are
// obviously the same set in both directions.
type PutMeta struct {
	Size    int64 `json:"size"`
	CTime   int64 `json:"ctime"`
	MTime   int64 `json:"mtime"`
	Folder  bool  `json:"folder"`
	Deleted bool  `json:"deleted"`
	// Prev is the previous path on a rename, so a rename is one operation
	// rather than a delete plus an add.
	Prev string `json:"prev,omitempty"`
}

// Entry converts a put into the store's record. The uid is assigned on commit
// and is deliberately not settable by a client.
//
// The device is the session's and is passed in, exactly as it is for one entry
// of a batch. Reading it off the message would let a device write under another
// device's name, and a device name is what a person reads next to a version to
// work out where it came from. Taking it as an argument makes that unwritable
// rather than something the caller has to remember to overwrite.
func (in In) Entry(device string) store.Entry {
	return store.Entry{
		Path:    in.Path,
		Size:    in.Meta.Size,
		CTime:   in.Meta.CTime,
		MTime:   in.Meta.MTime,
		Folder:  in.Meta.Folder,
		Deleted: in.Meta.Deleted,
		Device:  device,
		Prev:    in.Meta.Prev,
		Chunks:  chunkList(in.Chunks),
	}
}

/* ---------------------------------------------------------------- *
 * Server to client
 * ---------------------------------------------------------------- */

// Ready answers a device's hello and carries the limits a client needs before
// its first put. It is sent before any catch-up, so a client never has to
// guess a ceiling or discover one by being rejected.
//
// Cursor is what the *server* holds. A client compares it with its own and
// knows immediately how far behind it is. The protocol's fourth design rule
// is that no persisted boolean decides whether a vault uploads: the client
// announces what it has, the server answers with what it has, and neither
// remembers a verdict from last time.
//
// Epoch is the store's (PLAN.md section 2.8): minted when the store was made,
// and different in every backup of it. A client keeps it beside its cursor,
// and a different one here means its cursor belongs to a history that may
// have been replaced; see In.Epoch for what the server does about that.
//
// Proto is the version this session speaks, which is the one its hello asked
// for, and MinProto the oldest this server answers (wire.MinProto). A client
// holds the first to its own version and names both ends in its error when
// they differ.
type Ready struct {
	Res           string `json:"res"` // "ready"
	ID            int64  `json:"id,omitempty"`
	Proto         int    `json:"proto"`
	MinProto      int    `json:"minProto"`
	ServerVersion string `json:"serverVersion"`
	Epoch         string `json:"epoch"`
	Cursor        int64  `json:"cursor"`
	PerFileMax    int64  `json:"perFileMax"`
	ChunkMax      int64  `json:"chunkMax"`
	MaxChunks     int    `json:"maxChunks"`
	MaxBatchBytes int64  `json:"maxBatchBytes"`
	MaxFetchBytes int64  `json:"maxFetchBytes"`
}

// DeviceStatus describes a registered device with its live delivery checkpoint.
//
// The device list answers a devices request with every device that may reach
// this vault, and every invite that could still add one.
//
// Neither slice is ever null, for the same reason Batch.Entries is not: a
// client that iterates one would crash on exactly the vault it is meant to
// handle. Neither carries a credential either: store.Device has no field that
// could, and store.Invite carries the invite's id, its label and its expiry,
// never its token or anything derived from the token; see the comments there.
//
// Invites ride on the device list rather than having an op of their own,
// because they are one subject. "What can reach my notes" is answered by the
// rows plus the invites that have not been redeemed yet, and a client that had
// to ask twice would be a client that could show half the answer.
type DeviceStatus struct {
	store.Device
	Online  bool   `json:"online"`
	Applied *int64 `json:"applied"`
}

// Applied acknowledges a checkpoint held for this connection's lifetime.
type Applied struct {
	Res    string `json:"res"`
	ID     int64  `json:"id"`
	Cursor int64  `json:"cursor"`
}

// DeviceList answers devices with access and live delivery state.
type DeviceList struct {
	Res     string         `json:"res"` // "devices"
	ID      int64          `json:"id,omitempty"`
	Devices []DeviceStatus `json:"devices"`
	Invites []store.Invite `json:"invites"`
}

// Revoked answers a revoke: the row is gone and every session that device had
// open has been closed, in that order, so the reply means both.
type Revoked struct {
	Res      string `json:"res"` // "revoked"
	ID       int64  `json:"id,omitempty"`
	DeviceID string `json:"deviceId"`
	// Self is true when the device revoked was this session's own, in which
	// case this reply is the last frame on the connection. A client that
	// unlinked itself is owed the difference between "you are gone" and a
	// server that hung up for its own reasons.
	Self bool `json:"self,omitempty"`
}

// Batch delivers entries, and is the only message that ever does.
//
// Catch-up and live changes share one shape on purpose. A client that has one
// code path for "apply these entries, then set the cursor to To" cannot have a
// bug in the live path that the catch-up path does not have, and the continuity
// check is the same assertion in both cases.
//
// From and To are a covered range, not the first and last uid present: every
// entry that exists with From <= uid <= To is in Entries. Purged history leaves
// holes in the sequence, and a client that read From/To as "the uids here"
// would see every hole as a lost file. The check is From == cursor+1.
//
// Entries is empty for a range that contains only the receiving device's own
// write. That is how a device is spared having to recognise its own echo: it
// gets the cursor advance without the payload, so there is nothing to compare
// and no chance of concluding its own file came from somewhere else. Obsidian's
// pusher has to match five fields byte-identically or it downloads its own file
// back over itself.
type Batch struct {
	Op      string        `json:"op"` // "batch"
	From    int64         `json:"from"`
	To      int64         `json:"to"`
	Entries []store.Entry `json:"entries"`
}

// CaughtUp ends the backlog. Cursor is the last uid delivered, so a client that
// has been asserting continuity all the way through can stop here and trust it.
type CaughtUp struct {
	Op     string `json:"op"` // "caught-up"
	Cursor int64  `json:"cursor"`
}

// Want lists the chunks the server lacks, in the order it wants them. It is
// never longer than the put's own chunk list and never contains a repeat.
type Want struct {
	Res    string   `json:"res"` // "want"
	ID     int64    `json:"id,omitempty"`
	Chunks []string `json:"chunks"`
}

// Resent answers a `resend`: how many bodies this device supplied, and how many
// the server is still without (I14).
//
// Both numbers, because they answer different questions and a caller needs
// both. Stored is what this device could produce and the server now has.
// Missing is what it still lacks after that: chunks belonging to versions this
// device never had, or has since edited away. Those are not this device's to
// fix, and reporting only the good news would have somebody run repair on every
// machine they own and never find out that a body is gone for good.
type Resent struct {
	Res     string `json:"res"` // "resent"
	ID      int64  `json:"id,omitempty"`
	Stored  int    `json:"stored"`
	Missing int    `json:"missing"`
}

// Have means every chunk was already held, so nothing was uploaded and the
// entry is committed. It carries the uid for the same reason Ack does.
type Have struct {
	Res string `json:"res"` // "have"
	ID  int64  `json:"id,omitempty"`
	UID int64  `json:"uid"`
}

// Ack means the upload is durable and the entry is committed, in that order.
//
// It is withheld until both are true. An ack sent earlier would mean "stored"
// was a claim a crash could expose, which is the first of the durability rules
// and the one the rest exist to protect.
//
// The uid is also how a device knows which write was its own, without comparing
// any content.
type Ack struct {
	Res string `json:"res"` // "ack"
	ID  int64  `json:"id,omitempty"`
	UID int64  `json:"uid"`
}

// Chunks answers a get with where the content lives. The client then fetches
// only the chunks it does not already hold from some other version of the file.
type Chunks struct {
	Res    string   `json:"res"` // "chunks"
	ID     int64    `json:"id,omitempty"`
	UID    int64    `json:"uid"`
	Size   int64    `json:"size"`
	Chunks []string `json:"chunks"`
}

// Bodies answers a fetch and says exactly how many binary frames follow, in
// the order asked. A fetch is answered by this or by an Err, never by bodies
// and then an error: a client that received three frames and then a refusal
// could not tell which three, and stale bodies from a refused fetch used to be
// consumed as the answer to the next one.
type Bodies struct {
	Res   string `json:"res"` // "bodies"
	ID    int64  `json:"id,omitempty"`
	Count int    `json:"count"`
}

// Invited answers an invite: the invite's id, its token, and the moment it
// stops working in milliseconds of the server's clock, or null for an invite
// that does not expire.
//
// The token is the whole credential: the one field anywhere in the protocol
// that can redeem an invite, sent once, to the device that asked. That device
// formats the invite string with its own server address and vault name
// (plan/protocol.md, "The invite string"). The id is the non-secret handle the
// device list shows and `uninvite` takes, minted beside the token and not
// derived from it.
type Invited struct {
	Res       string `json:"res"` // "invited"
	ID        int64  `json:"id,omitempty"`
	Invite    string `json:"invite"`
	Token     string `json:"token"`
	ExpiresAt *int64 `json:"expiresAt"`
}

// Redeemed answers a hello that carried an invite: the device row this
// redemption registered, under the id the hello asked for, so the redeemer can
// check the row it is about to keep a credential for is the one it named.
//
// The session closes after this. It is not a device session: the row exists
// now, and the device proves it holds the token it registered by connecting
// again as a device, which is the only place a syncing session is built. A
// retry of a redemption whose reply was lost gets this same answer
// (plan/protocol.md, "Invite redemption", step 2).
type Redeemed struct {
	Res      string `json:"res"` // "redeemed"
	ID       int64  `json:"id,omitempty"`
	DeviceID string `json:"deviceId"`
}

// Uninvited answers an uninvite: that invite is gone and the string somebody is
// holding no longer redeems. It names the invite's id so a client can tell
// which of several it cancelled, the way Revoked names the device.
type Uninvited struct {
	Res    string `json:"res"` // "uninvited"
	ID     int64  `json:"id,omitempty"`
	Invite string `json:"invite"`
}

// History answers a history request with every version of one path, newest
// first.
//
// Read-only, like Deleted below, and that is the whole of the recovery
// protocol. Restoring is not a server operation: a client asks for the history,
// fetches the version it wants with the ordinary `get`, writes it into the
// vault, and the ordinary sync uploads it as a new version. That leaves the
// server with no new way to mutate a vault, and the client had to download the
// content regardless, so the extra op would have bought nothing.
//
// Entries is never null. A client that iterates it would crash on exactly the
// answers it is meant to handle, which is the same reasoning as Batch.
type History struct {
	Res string `json:"res"` // "history"
	ID  int64  `json:"id,omitempty"`
	// Path echoes the request, so a client with several in flight can tell
	// which answer it is holding.
	Path    string        `json:"path"`
	Entries []store.Entry `json:"entries"`
}

// HistoryV2 is History in protocol 2, where each entry an agent operation or
// an undo wrote says which: its `op`, with the id a device's undo names.
type HistoryV2 struct {
	Res     string         `json:"res"` // "history"
	ID      int64          `json:"id,omitempty"`
	Path    string         `json:"path"`
	Entries []HistoryEntry `json:"entries"`
}

// HistoryEntry is one version in a protocol 2 history: the entry, and the
// operation that wrote it when an operation did. A device's own versions have
// no `op`.
type HistoryEntry struct {
	store.Entry
	Op *store.OperationRef `json:"op,omitempty"`
}

// Undone answers an undo (protocol 2): the undo committed, as the operation
// OpID, undoing Undoes. Steps say what it did to each path, in order, a copy's
// destination included; Entries are the versions it wrote, which reach every
// device, this one too, as an ordinary batch.
type Undone struct {
	Res         string           `json:"res"` // "undone"
	ID          int64            `json:"id,omitempty"`
	OpID        string           `json:"opId"`
	Undoes      string           `json:"undoes"`
	ToCopy      bool             `json:"toCopy"`
	CommittedAt int64            `json:"committedAt"`
	Steps       []store.UndoStep `json:"steps"`
	Entries     []UndoneEntry    `json:"entries"`
}

// Searched answers a search (protocol 2): one page of matches, at most the
// limit asked for and 64 KiB of rows, read at Head, the vault's head when the
// first page was asked for, which every continuation keeps.
//
// NextAfter continues the search, and is null on the last page. Complete is
// true only on a last page that skipped no note; Skipped names each note that
// could not be searched and why. Index says whether the server's search index
// narrowed the candidates, and why not when it did not, and IndexedHead how
// far it has indexed; the index only proposes, so a lagging or absent index
// costs speed and never a match. Scanned and ScannedBytes are what the page
// read. Note text is sent as the note holds it: a client that shows it to a
// person makes it safe to show.
type Searched struct {
	Res          string          `json:"res"` // "searched"
	ID           int64           `json:"id,omitempty"`
	Matches      []SearchMatch   `json:"matches"`
	Skipped      []SearchSkipped `json:"skipped"`
	NextAfter    *string         `json:"nextAfter"`
	Complete     bool            `json:"complete"`
	Head         int64           `json:"head"`
	IndexedHead  int64           `json:"indexedHead"`
	Index        SearchIndex     `json:"index"`
	Scanned      int             `json:"scanned"`
	ScannedBytes int             `json:"scannedBytes"`
}

// SearchMatch is one match: the note and its version, the 1-based line and
// column (in UTF-16 code units) of the match's first character, the line it
// is on (from at most 256 units before the match, at most 1,024 long), up to
// the context lines asked for each side (each at most 256), and whether any
// of those was cut. A file-name match has line 0, column 1, the path as text
// and kind "filename"; a tag match has kind "tag".
type SearchMatch struct {
	Path    string   `json:"path"`
	UID     int64    `json:"uid"`
	Line    int      `json:"line"`
	Column  int      `json:"column"`
	Text    string   `json:"text"`
	Before  []string `json:"before"`
	After   []string `json:"after"`
	Clipped bool     `json:"clipped"`
	Kind    string   `json:"kind,omitempty"`
}

// SearchSkipped is a note a search page could not search, and why: its code,
// such as note_too_large, invalid_utf8 or unreadable.
type SearchSkipped struct {
	Path string `json:"path"`
	Why  string `json:"why"`
}

// SearchIndex is what the index did for a page: Usable when it narrowed the
// candidates, and Why when it did not.
type SearchIndex struct {
	Usable bool   `json:"usable"`
	Why    string `json:"why,omitempty"`
}

// UndoneEntry is one version an undo wrote, and the version it displaced
// there, zero for a path that held nothing.
type UndoneEntry struct {
	Path        string `json:"path"`
	UID         int64  `json:"uid"`
	PreviousUID int64  `json:"previousUid"`
	Prev        string `json:"prev,omitempty"`
}

// Deleted answers a deleted request with every path whose newest version is a
// deletion.
//
// Renames are suppressed, and not optionally. A rename leaves a deletion behind
// at the old path, so without suppression most of this list is phantom
// deletions of files that still exist under another name, and a recovery list
// that is mostly noise is one nobody reads.
type Deleted struct {
	Res string `json:"res"` // "deleted"
	ID  int64  `json:"id,omitempty"`
	// Each entry carries `restorable`: the uid of the newest version with
	// content in it, or zero. Purge keeps only the newest version per path, and
	// for a deleted note that is the deletion record, so a note can be listed
	// here with nothing left to restore it from. A client that says "all still
	// recoverable" over this list without looking is telling somebody their
	// note is safe when it is not.
	Entries []store.Deletion `json:"entries"`
	// More says the list was cut short. A vault accumulates deletions for as
	// long as it exists, so the answer is bounded; saying nothing about it
	// would hand somebody a short list that looks complete, and the note they
	// are looking for is exactly the one that might be missing from it.
	More bool `json:"more"`
}

// Renamed answers a rename, and carries the name the row now holds.
//
// The name is echoed rather than assumed. A client that sent one and got a bare
// acknowledgement would have to believe its own request, and the server is the
// authority on what the device list says; anything that trimmed or refused part
// of a name would then be invisible until somebody read the list. Nothing here
// trims today, which is exactly why the field is cheap to add now and awkward
// to add later.
type Renamed struct {
	Res  string `json:"res"` // "renamed"
	ID   int64  `json:"id,omitempty"`
	Name string `json:"name"`
}

// Pong answers a ping. A client behind NAT needs something to send.
type Pong struct {
	Res string `json:"res"` // "pong"
}

// Acks answers a batched put, one result per entry, in the order they were sent.
//
// Per entry rather than one verdict for the batch. A single unacceptable file
// among two hundred good ones must not refuse the other hundred and
// ninety-nine, and a client needs to know which one it was: the alternative is
// a batch that fails as a unit and a client that has to bisect it to find out
// why.
type Acks struct {
	Res     string      `json:"res"` // "acks"
	ID      int64       `json:"id,omitempty"`
	Results []AckResult `json:"results"`
}

// AckResult is a uid, or the reason there is not one.
type AckResult struct {
	UID  int64  `json:"uid,omitempty"`
	Code string `json:"code,omitempty"`
	Msg  string `json:"msg,omitempty"`
}

// Err is every rejection.
//
// ID is present when the error answers a request, and absent on the errors the
// server sends unasked, the shutdown and revocation notices, which a client
// reads as the reason the connection is about to close.
//
// Retryable is always sent, from the table in Retryable below, so a client has
// nothing to interpret: back off and reconnect on true, stop on false. It is a
// plain bool with no omitempty precisely so that an error without it cannot be
// built; an error a client has to guess about is how a watching device ends up
// either giving up or hot-looping. RetryAfterMs is a hint that travels with
// `busy`.
type Err struct {
	Res          string `json:"res"` // "err"
	ID           int64  `json:"id,omitempty"`
	Code         string `json:"code"`
	Msg          string `json:"msg"`
	Retryable    bool   `json:"retryable"`
	RetryAfterMs int64  `json:"retryAfterMs,omitempty"`
}

// Error is a rejection: the code, the message for the human, and the retryable
// verdict the code implies. The id and any retryAfterMs hint are filled in by
// whoever is about to send it, which is the only place that knows whether a
// request is being answered.
func Error(code, msg string) Err {
	return Err{Res: "err", Code: code, Msg: msg, Retryable: Retryable(code)}
}

// Retryable says whether reconnecting later can succeed where retrying the same
// request cannot. It is the "retryable" column of the error table in
// plan/protocol.md.
//
// Only four codes are transient. `busy` is admission pressure or a shutdown.
// `nospace` is a full disk, which an operator clears. `internal`
// is a server fault the put did not survive, and the server is the thing that
// can be fixed. `toomany` is a device search over its budget, which the wait
// it names refills. Everything else names a fact about the request or the
// credentials that a retry does not change, and a watching client that
// reconnected on it would loop for ever.
func Retryable(code string) bool {
	switch code {
	case CodeBusy, CodeNoSpace, CodeInternal, CodeTooMany:
		return true
	}
	return false
}

// ErrNotText is a text frame that is not well-formed text: invalid UTF-8, or a
// JSON string escape naming half of a surrogate pair.
var ErrNotText = errors.New("the frame is not well-formed text")

// ValidText refuses a text frame that JSON decoding would quietly change.
//
// Go's decoder does not refuse invalid UTF-8 or an unpaired surrogate escape
// such as "\ud800": it substitutes U+FFFD and carries on. For a path that is
// a silent rename. A device sending one would have its note stored under a
// name it does not hold, told nothing, and every other device would receive a
// file its origin cannot find. So a frame that is not well-formed text is
// refused before it is decoded, as `protostate`, since the two ends no longer
// agree on what was said. RFC 6455 requires a text frame to be valid UTF-8,
// and RFC 8259 leaves an unpaired surrogate's meaning undefined, so nothing a
// correct client sends is refused.
func ValidText(data []byte) error {
	if !utf8.Valid(data) {
		return errors.Join(ErrNotText, errors.New("it is not valid UTF-8"))
	}
	inString := false
	for i := 0; i < len(data); i++ {
		c := data[i]
		if !inString {
			if c == '"' {
				inString = true
			}
			continue
		}
		switch c {
		case '"':
			inString = false
		case '\\':
			if i+1 >= len(data) {
				return nil // unterminated: the decoder refuses it
			}
			if data[i+1] != 'u' {
				i++ // a one-character escape
				continue
			}
			unit, ok := hex4(data, i+2)
			if !ok {
				return nil // malformed: the decoder refuses it
			}
			i += 5
			switch {
			case unit >= 0xdc00 && unit <= 0xdfff:
				return errors.Join(ErrNotText, errors.New("it escapes a low surrogate with no high surrogate before it"))
			case unit >= 0xd800 && unit <= 0xdbff:
				low, ok := uint16(0), false
				if i+6 < len(data) && data[i+1] == '\\' && data[i+2] == 'u' {
					low, ok = hex4(data, i+3)
				}
				if !ok || low < 0xdc00 || low > 0xdfff {
					return errors.Join(ErrNotText, errors.New("it escapes a high surrogate with no low surrogate after it"))
				}
				i += 6
			}
		}
	}
	return nil
}

// hex4 reads four hex digits at data[at:], as a JSON \u escape carries.
func hex4(data []byte, at int) (uint16, bool) {
	if at+4 > len(data) {
		return 0, false
	}
	var v uint16
	for _, c := range data[at : at+4] {
		var d byte
		switch {
		case c >= '0' && c <= '9':
			d = c - '0'
		case c >= 'a' && c <= 'f':
			d = c - 'a' + 10
		case c >= 'A' && c <= 'F':
			d = c - 'A' + 10
		default:
			return 0, false
		}
		v = v<<4 | uint16(d)
	}
	return v, true
}
