package metrics

import (
	"reflect"
	"testing"
	"time"
)

// Durations land in the bucket whose bound is the first at or above them,
// with the count, sum and maximum kept beside the buckets.
func TestAHistogramCountsIntoItsFixedBuckets(t *testing.T) {
	var h Histogram
	for _, d := range []time.Duration{0, time.Millisecond, 3 * time.Millisecond, 2 * time.Second, time.Minute} {
		h.Observe(d)
	}
	s := h.Snapshot()
	want := make([]int64, len(Bounds)+1)
	want[0], want[1], want[7], want[len(Bounds)] = 2, 1, 1, 1
	if !reflect.DeepEqual(s.Buckets, want) {
		t.Fatalf("buckets %v, want %v", s.Buckets, want)
	}
	if s.Count != 5 || s.MaxMs != 60000 || s.SumMs != 62004 {
		t.Fatalf("count %d, max %v, sum %v", s.Count, s.MaxMs, s.SumMs)
	}
	if len(s.BoundsMs) != len(Bounds) || s.BoundsMs[0] != 1 {
		t.Fatalf("bounds %v", s.BoundsMs)
	}
}

// The consecutive count is failures since the last success, which is what
// separates a bad moment from a store that has stopped taking notes.
func TestConsecutiveFailuresResetOnASuccess(t *testing.T) {
	r := New()
	r.CommitFailed()
	r.CommitFailed()
	if s := r.Snapshot(); s.ConsecutiveCommitFailures != 2 || s.CommitFailures != 2 || s.LastCommitFailureAt == 0 {
		t.Fatalf("%+v", s)
	}
	r.Committed()
	if s := r.Snapshot(); s.ConsecutiveCommitFailures != 0 || s.CommitFailures != 2 || s.Commits != 1 {
		t.Fatalf("%+v", s)
	}
}

// A nil registry is a server with no metrics, and every method on it is a
// no-op rather than a panic.
func TestANilRegistryCountsNothing(t *testing.T) {
	var r *Registry
	r.Committed()
	r.CommitFailed()
	r.BatchFellBack()
	r.Stale()
	r.AuthFailed()
	r.RateLimited()
	r.Evicted()
	if s := r.Snapshot(); s.Commits != 0 {
		t.Fatalf("%+v", s)
	}
}

// Nothing from the vault can reach a snapshot, because nothing in it can hold
// a word: every field is a number or a histogram of numbers, and there are no
// labels (PLAN.md section 2.2: paths, chunk names, credentials and note bodies
// stay out of metrics). A string field added later fails here first.
func TestASnapshotCarriesNothingFromTheVault(t *testing.T) {
	var check func(t reflect.Type, where string)
	check = func(typ reflect.Type, where string) {
		switch typ.Kind() {
		case reflect.Int64, reflect.Int, reflect.Float64:
		case reflect.Slice:
			check(typ.Elem(), where+"[]")
		case reflect.Struct:
			for i := 0; i < typ.NumField(); i++ {
				f := typ.Field(i)
				check(f.Type, where+"."+f.Name)
			}
		default:
			t.Errorf("%s is a %s, which could carry words from the vault", where, typ.Kind())
		}
	}
	check(reflect.TypeOf(Snapshot{}), "Snapshot")
}
