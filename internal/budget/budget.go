// Package budget is the token bucket the server's two ways into a search
// share: the MCP endpoint's per-token budgets (internal/mcp) and a device's
// search over the protocol (internal/server). One definition, so a request
// rate or a byte budget means the same thing on both.
package budget

import (
	"math"
	"time"
)

// Bucket is a token bucket: capacity burst, refilled at rate per second. It
// holds no lock; its owner guards it.
type Bucket struct {
	level float64
	last  time.Time
	rate  float64
	burst float64
}

// New is a full bucket.
func New(rate, burst float64, now time.Time) *Bucket {
	return &Bucket{level: burst, last: now, rate: rate, burst: burst}
}

func (b *Bucket) refill(now time.Time) {
	if now.After(b.last) {
		b.level = math.Min(b.burst, b.level+now.Sub(b.last).Seconds()*b.rate)
		b.last = now
	}
}

// Take spends n if the bucket holds it, and otherwise says how long until it
// will.
func (b *Bucket) Take(now time.Time, n float64) (bool, time.Duration) {
	b.refill(now)
	if b.level >= n {
		b.level -= n
		return true, 0
	}
	return false, b.wait(n)
}

// Charge spends n whether or not the bucket holds it: the bytes of a reply
// already sent. A bucket in debt admits nothing until it has refilled.
func (b *Bucket) Charge(now time.Time, n float64) {
	b.refill(now)
	b.level -= n
}

// Ready reports whether the bucket is out of debt, and how long until it is.
func (b *Bucket) Ready(now time.Time) (bool, time.Duration) {
	b.refill(now)
	if b.level >= 0 {
		return true, 0
	}
	return false, b.wait(0)
}

func (b *Bucket) wait(n float64) time.Duration {
	missing := n - b.level
	if missing <= 0 {
		return 0
	}
	return time.Duration(missing / b.rate * float64(time.Second))
}
