package chunks

import (
	"crypto/rand"
	"fmt"
	"testing"

	"github.com/waynehoover/trewsync/internal/frame"
)

// What a fetch's double read costs (I09).
//
// The session verifies every requested body before it promises how many frames
// are coming, then reads every one of them again to send it. That is deliberate
// and it is what makes the answer to a fetch either a header and exactly N
// bodies or an error, never bodies followed by an error. The question this
// answers is what the second pass costs, because "read it twice" sounds
// expensive and the page cache may mean it is not.
//
// go test -bench Fetch -benchmem ./internal/chunks/
func benchFetch(b *testing.B, count int, size int) {
	b.Helper()
	st, err := New(b.TempDir(), 1<<30)
	if err != nil {
		b.Fatal(err)
	}
	names := make([]string, count)
	for i := range names {
		body := make([]byte, size)
		if _, err := rand.Read(body); err != nil {
			b.Fatal(err)
		}
		names[i] = Name(body)
		if err := st.Put("v", names[i], body); err != nil {
			b.Fatal(err)
		}
	}

	b.Run("verify then read again, which is what a fetch does", func(b *testing.B) {
		b.SetBytes(int64(count) * int64(size))
		b.ReportAllocs()
		for b.Loop() {
			for _, n := range names {
				if err := st.Check("v", n); err != nil {
					b.Fatal(err)
				}
			}
			for _, n := range names {
				body, err := st.Get("v", n)
				if err != nil {
					b.Fatal(err)
				}
				_ = body
			}
		}
	})

	b.Run("read once", func(b *testing.B) {
		b.SetBytes(int64(count) * int64(size))
		b.ReportAllocs()
		for b.Loop() {
			for _, n := range names {
				body, err := st.Get("v", n)
				if err != nil {
					b.Fatal(err)
				}
				_ = body
			}
		}
	})
}

// What reading and framing one body of an attachment costs a fetch: read with
// Get and framed by Encode, which copies a raw body into a frame one byte
// longer, against read with a spare byte in front and framed in place. The
// bodies are random, so the probe sends every one raw, as it sends most of an
// attachment.
//
//	go test ./internal/chunks -run '^$' -bench FetchFraming -benchmem
func BenchmarkFetchFraming(b *testing.B) {
	for _, size := range []int{256 << 10, 1 << 20} {
		st, err := New(b.TempDir(), 1<<20)
		if err != nil {
			b.Fatal(err)
		}
		body := make([]byte, size)
		if _, err := rand.Read(body); err != nil {
			b.Fatal(err)
		}
		name := Name(body)
		if err := st.Put("v", name, body); err != nil {
			b.Fatal(err)
		}
		b.Run(fmt.Sprintf("%dKiB/copied", size>>10), func(b *testing.B) {
			b.SetBytes(int64(size))
			b.ReportAllocs()
			for b.Loop() {
				raw, err := st.Get("v", name)
				if err != nil {
					b.Fatal(err)
				}
				if f := frame.Encode(raw); f[0] != frame.MarkerRaw {
					b.Fatal("a random body deflated")
				}
			}
		})
		b.Run(fmt.Sprintf("%dKiB/in-place", size>>10), func(b *testing.B) {
			b.SetBytes(int64(size))
			b.ReportAllocs()
			for b.Loop() {
				buf, err := st.GetWithHeadroom("v", name)
				if err != nil {
					b.Fatal(err)
				}
				if f := frame.EncodeWithHeadroom(buf); f[0] != frame.MarkerRaw {
					b.Fatal("a random body deflated")
				}
			}
		})
	}
}

func BenchmarkFetch(b *testing.B) {
	// A note is one chunk; an attachment is many. Both shapes, because the
	// per-chunk overhead and the per-byte cost are different questions.
	for _, c := range []struct{ count, size int }{
		{count: 64, size: 4 << 10},
		{count: 64, size: 256 << 10},
		{count: 512, size: 64 << 10},
	} {
		b.Run(fmt.Sprintf("%dx%dKiB", c.count, c.size>>10), func(b *testing.B) {
			benchFetch(b, c.count, c.size)
		})
	}
}
