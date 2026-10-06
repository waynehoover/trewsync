package store

import (
	"fmt"
	"testing"
)

// SampleChunkRefs, for doctor's quick mode: n references, each one the store
// holds, chosen by row without reading the rest; every reference when there
// are no more than n.
func TestSampleChunkRefsChoosesRealReferences(t *testing.T) {
	h := newTestStore(t)
	held := map[string]bool{}
	for i := 0; i < 50; i++ {
		e := h.file(t, fmt.Sprintf("n%d.md", i), fmt.Sprintf("body %d", i))
		held[e.Chunks[0]] = true
	}
	var got []string
	if err := h.SampleChunkRefs(8, func(vault, name string) error {
		if vault != "v1" || !held[name] {
			t.Errorf("a sample named %s/%s, which the store does not hold", vault, name)
		}
		got = append(got, name)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 8 {
		t.Fatalf("asked for 8 references and was given %d", len(got))
	}
	all := 0
	if err := h.SampleChunkRefs(500, func(string, string) error { all++; return nil }); err != nil {
		t.Fatal(err)
	}
	if all != 50 {
		t.Fatalf("a sample larger than the table gave %d of its 50 references", all)
	}
}
