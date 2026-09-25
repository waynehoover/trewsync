package gitexport

import (
	"time"

	"github.com/waynehoover/trew/internal/store"
)

// Which versions become which commit. The rule is a function of the store
// alone (its entries, the operation each belongs to, and the server time each
// was committed at) and of the settings, so an export rebuilt from scratch
// makes the same commits, byte for byte, as the one made while the notes
// arrived. Nothing here reads the exporter's own clock except to decide that a
// device's last run of versions has been quiet for long enough, and a later
// version could only have joined that run by carrying an earlier time.
//
// An agent's operation is one commit, whatever it wrote. A device's versions
// are one commit per run: consecutive versions by the same device, each within
// the quiet window of the one before it. Every version has an effective time,
// its recorded server time, never earlier than the one before it (a clock
// stepped backwards cannot reorder the history), or the time before it when it
// has none recorded. A version with no time recorded was written before the
// store kept them (store.CommitTimes), and without a clock there is no quiet
// to measure, so a run of those is broken only where it would otherwise hide a
// version: the second version of a path in one run starts the next commit.

// maxCommitEntries bounds one commit, so a device's first upload of a large
// vault is a few commits rather than one that has to be held whole.
const maxCommitEntries = 20000

// group is the versions one commit covers.
type group struct {
	op      *store.OpStamp // the operation, or nil for a device's run
	device  string
	entries []store.Entry
	// at is the commit's time, in milliseconds: the operation's committed_at,
	// or the effective time of the run's last version.
	at int64
	// lastAt is the planner's effective time after the group's last version,
	// which the state row keeps so a resumed plan starts where it stopped.
	lastAt int64
	// paths are the paths a version with no recorded time has touched.
	paths map[string]bool
}

func (g *group) first() int64 { return g.entries[0].UID }
func (g *group) last() int64  { return g.entries[len(g.entries)-1].UID }

// planner turns the store's versions, in uid order, into groups.
type planner struct {
	quiet time.Duration
	// lastAt is the effective time of the last version added, zero before
	// the first, and fallback the time a version with none recorded takes
	// when nothing before it has one: the store's creation.
	lastAt   int64
	fallback int64
	open     *group
	closed   []*group
	// closedEntries and closedBytes are what the closed groups hold, which
	// bound a step.
	closedEntries, closedBytes int64
}

// add places e, with its recorded time if it has one and its operation if it
// has one.
func (p *planner) add(e store.Entry, recorded int64, timed bool, op *store.OpStamp) {
	at := p.lastAt
	switch {
	case timed:
		at = max(recorded, p.lastAt)
	case at == 0:
		at = p.fallback
	}
	if p.open != nil && !p.joins(e, at, timed, op) {
		p.closeOpen()
	}
	if p.open == nil {
		p.open = &group{op: op, device: e.Device, paths: map[string]bool{}}
	}
	g := p.open
	g.entries = append(g.entries, e)
	if !timed {
		g.paths[e.Path] = true
	}
	p.lastAt = at
	if op != nil {
		p.lastAt = max(p.lastAt, op.CommittedAt)
		g.at = op.CommittedAt
	} else {
		g.at = at
	}
	g.lastAt = p.lastAt
	if op != nil && e.UID >= op.LastUID {
		p.closeOpen()
	}
}

// joins reports whether e belongs in the open group.
func (p *planner) joins(e store.Entry, at int64, timed bool, op *store.OpStamp) bool {
	g := p.open
	switch {
	case g.op != nil || op != nil:
		return g.op != nil && op != nil && g.op.ID == op.ID
	case e.Device != g.device:
		return false
	case len(g.entries) >= maxCommitEntries:
		return false
	case at-g.at >= p.quiet.Milliseconds():
		return false
	case !timed && g.paths[e.Path]:
		return false
	}
	return true
}

func (p *planner) closeOpen() {
	for _, e := range p.open.entries {
		p.closedEntries++
		p.closedBytes += e.Size
	}
	p.closed = append(p.closed, p.open)
	p.open = nil
}

// finish is called when every committed version has been added: the open
// group is closed if it is an operation (whose versions are all in, since an
// operation commits at once), or a device's run that has been quiet for the
// window at now.
func (p *planner) finish(now int64) {
	g := p.open
	if g == nil {
		return
	}
	if g.op != nil || now-g.at >= p.quiet.Milliseconds() {
		p.closeOpen()
	}
}

// openUntil is when the open group will have been quiet for the window, or
// zero when there is none.
func (p *planner) openUntil() int64 {
	if p.open == nil || p.open.op != nil {
		return 0
	}
	return p.open.at + p.quiet.Milliseconds()
}
