package mcp

import (
	"math"
	"sync"
	"time"
)

// Limits are the endpoint's budgets (PLAN.md section 2.3). A global cap on
// requests in flight bounds the whole endpoint; per-token admission, request
// and byte budgets keep one agent looping on search_notes from starving
// another, and none of it touches a device's sync, which never passes through
// this handler. Failed authentication has a budget of its own, per client
// address, so garbage cannot use up what a valid token is owed. The zero
// value of a field means its default.
type Limits struct {
	// InFlight is how many requests the endpoint works on at once: 32.
	InFlight int
	// TokenInFlight is how many one token may have at once: 8.
	TokenInFlight int
	// TokenRate and TokenBurst are one token's sustained requests per second
	// and how many it may make at once from rest: 5 and 30.
	TokenRate  float64
	TokenBurst float64
	// TokenBytesRate and TokenBytesBurst are the same for the bytes of the
	// replies it is sent: 4 MiB a second and 16 MiB.
	TokenBytesRate  float64
	TokenBytesBurst float64
	// FailRate and FailBurst are failed authentications per second, and at
	// once, from one address before it is told 429 instead of 401: 1 and 10.
	FailRate  float64
	FailBurst float64
	// BodyDeadline bounds how long a request's body may take to arrive, and
	// ToolDeadline how long a tool may work: 30 seconds each.
	BodyDeadline time.Duration
	ToolDeadline time.Duration
}

func (l Limits) withDefaults() Limits {
	def := func(v *float64, d float64) {
		if *v <= 0 {
			*v = d
		}
	}
	if l.InFlight <= 0 {
		l.InFlight = 32
	}
	if l.TokenInFlight <= 0 {
		l.TokenInFlight = 8
	}
	def(&l.TokenRate, 5)
	def(&l.TokenBurst, 30)
	def(&l.TokenBytesRate, 4<<20)
	def(&l.TokenBytesBurst, 16<<20)
	def(&l.FailRate, 1)
	def(&l.FailBurst, 10)
	if l.BodyDeadline <= 0 {
		l.BodyDeadline = 30 * time.Second
	}
	if l.ToolDeadline <= 0 {
		l.ToolDeadline = 30 * time.Second
	}
	return l
}

// bucket is a token bucket: capacity burst, refilled at rate per second.
type bucket struct {
	level float64
	last  time.Time
	rate  float64
	burst float64
}

func newBucket(rate, burst float64, now time.Time) *bucket {
	return &bucket{level: burst, last: now, rate: rate, burst: burst}
}

func (b *bucket) refill(now time.Time) {
	if now.After(b.last) {
		b.level = math.Min(b.burst, b.level+now.Sub(b.last).Seconds()*b.rate)
		b.last = now
	}
}

// take spends n if the bucket holds it, and otherwise says how long until it
// will.
func (b *bucket) take(now time.Time, n float64) (bool, time.Duration) {
	b.refill(now)
	if b.level >= n {
		b.level -= n
		return true, 0
	}
	return false, b.wait(n)
}

// charge spends n whether or not the bucket holds it: the bytes of a reply
// already sent. A bucket in debt admits nothing until it has refilled.
func (b *bucket) charge(now time.Time, n float64) {
	b.refill(now)
	b.level -= n
}

// ready reports whether the bucket is out of debt, and how long until it is.
func (b *bucket) ready(now time.Time) (bool, time.Duration) {
	b.refill(now)
	if b.level >= 0 {
		return true, 0
	}
	return false, b.wait(0)
}

func (b *bucket) wait(n float64) time.Duration {
	missing := n - b.level
	if missing <= 0 {
		return 0
	}
	return time.Duration(missing / b.rate * float64(time.Second))
}

// retryAfter is a wait as Retry-After says it: whole seconds, at least one.
func retryAfter(d time.Duration) int {
	s := int(math.Ceil(d.Seconds()))
	if s < 1 {
		return 1
	}
	return s
}

// tokenBudget is one token's share: requests in flight, and its buckets.
type tokenBudget struct {
	inFlight int
	requests *bucket
	bytes    *bucket
}

// budgets are every token's, by id, and the failed-authentication buckets, by
// client address.
type budgets struct {
	mu       sync.Mutex
	limits   Limits
	inFlight int
	tokens   map[string]*tokenBudget
	failures map[string]*bucket
}

// maxFailureHosts bounds how many addresses the failure buckets remember, so
// a spray of addresses cannot grow the map without limit.
const maxFailureHosts = 1024

func newBudgets(l Limits) *budgets {
	return &budgets{limits: l, tokens: map[string]*tokenBudget{}, failures: map[string]*bucket{}}
}

// admit takes one of the endpoint's slots. The release function gives it back.
func (b *budgets) admit() (func(), bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.inFlight >= b.limits.InFlight {
		return nil, false
	}
	b.inFlight++
	var once sync.Once
	return func() {
		once.Do(func() {
			b.mu.Lock()
			b.inFlight--
			b.mu.Unlock()
		})
	}, true
}

// admitToken takes one of a token's slots and one of its requests, if it has
// both and its byte budget is out of debt, and otherwise says when to retry.
func (b *budgets) admitToken(id string, now time.Time) (func(), time.Duration, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	t := b.tokens[id]
	if t == nil {
		t = &tokenBudget{
			requests: newBucket(b.limits.TokenRate, b.limits.TokenBurst, now),
			bytes:    newBucket(b.limits.TokenBytesRate, b.limits.TokenBytesBurst, now),
		}
		b.tokens[id] = t
	}
	if t.inFlight >= b.limits.TokenInFlight {
		return nil, time.Second, false
	}
	if ok, wait := t.bytes.ready(now); !ok {
		return nil, wait, false
	}
	if ok, wait := t.requests.take(now, 1); !ok {
		return nil, wait, false
	}
	t.inFlight++
	var once sync.Once
	return func() {
		once.Do(func() {
			b.mu.Lock()
			t.inFlight--
			b.mu.Unlock()
		})
	}, 0, true
}

// sent charges a token for the bytes of a reply.
func (b *budgets) sent(id string, n int, now time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if t := b.tokens[id]; t != nil {
		t.bytes.charge(now, float64(n))
	}
}

// forget drops a revoked token's budget.
func (b *budgets) forget(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.tokens, id)
}

// failed records a failed authentication from host and reports whether it is
// within the host's budget: false means answer 429, after wait.
func (b *budgets) failed(host string, now time.Time) (bool, time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	f := b.failures[host]
	if f == nil {
		if len(b.failures) >= maxFailureHosts {
			for k := range b.failures {
				delete(b.failures, k)
				break
			}
		}
		f = newBucket(b.limits.FailRate, b.limits.FailBurst, now)
		b.failures[host] = f
	}
	return f.take(now, 1)
}
