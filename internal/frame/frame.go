// Package frame is the chunk body framing of protocol 1: one marker byte, then
// either the raw chunk or its raw DEFLATE (RFC 1951) stream.
//
// Framing lives at the transport boundary (plan/protocol.md, "Chunk bodies").
// Everything above it, the store, assemble, the MCP tools, receives verified
// raw chunks and never sees a marker. Compression is a wire encoding only:
// chunk names are the SHA-256 of raw bytes, so Go's compress/flate and the
// plugin's fflate never have to agree on compressed output, only on what it
// decodes to.
package frame

import (
	"bytes"
	"compress/flate"
	"errors"
	"fmt"
	"io"
)

// The two markers. Any other first byte is refused.
const (
	MarkerRaw     byte = 0
	MarkerDeflate byte = 1
)

// Errors Decode returns, wrapped with detail. A caller maps each to the wire
// code `badchunk`; they are distinct so tests and logs can tell a limit from
// damage.
var (
	ErrEmpty    = errors.New("frame: empty")
	ErrMarker   = errors.New("frame: unknown marker")
	ErrTooLarge = errors.New("frame: over the chunk limit")
	ErrCorrupt  = errors.New("frame: undecodable deflate stream")
)

// probeBytes is how much of a chunk is tried before deflating all of it, the
// same probe the TypeScript encoder uses (client/src/core/frame.ts).
const probeBytes = 4096

// Encode frames raw bytes for the wire: deflated at level 6 when that is
// shorter, raw otherwise. The rule "deflate only when shorter" is what keeps a
// frame within maxRaw + 1 bytes for any chunk the receiver will accept.
//
// A chunk over twice the probe size is only deflated whole when its first
// probeBytes compress: attachments are mostly incompressible, and deflating a
// megabyte of JPEG to learn that costs CPU on every fetch for nothing. The probe
// is an optimisation only; the output rule above still decides.
func Encode(raw []byte) []byte {
	if len(raw) > 2*probeBytes && !deflates(raw[:probeBytes]) {
		return rawFrame(raw)
	}
	var buf bytes.Buffer
	buf.WriteByte(MarkerDeflate)
	w, err := flate.NewWriter(&buf, 6)
	if err == nil {
		_, err = w.Write(raw)
	}
	if err == nil {
		err = w.Close()
	}
	if err == nil && buf.Len()-1 < len(raw) {
		return buf.Bytes()
	}
	return rawFrame(raw)
}

func rawFrame(raw []byte) []byte {
	out := make([]byte, 1+len(raw))
	out[0] = MarkerRaw
	copy(out[1:], raw)
	return out
}

// deflates reports whether deflating b at level 6 makes it shorter.
func deflates(b []byte) bool {
	var buf bytes.Buffer
	w, err := flate.NewWriter(&buf, 6)
	if err != nil {
		return false
	}
	if _, err := w.Write(b); err != nil {
		return false
	}
	if err := w.Close(); err != nil {
		return false
	}
	return buf.Len() < len(b)
}

// Decode returns the raw chunk a frame carries, refusing anything that is not
// a well-formed, non-empty chunk of at most maxRaw bytes.
//
// The length check comes first, before any inflating: a frame longer than
// maxRaw + 1 cannot be a chunk this side accepts whatever it decodes to, and
// refusing it costs nothing. Inflating is bounded as it goes, so a small
// payload that expands without limit is refused when it passes the limit, not
// after it is all in memory.
//
// Bytes after the final deflate block are ignored. They cannot change the
// decoded bytes, and the decoded bytes are what the chunk name is checked
// against.
//
// The returned slice aliases frame for a raw frame; copy it to keep it past
// the frame's buffer.
func Decode(frame []byte, maxRaw int) ([]byte, error) {
	if len(frame) == 0 {
		return nil, fmt.Errorf("%w: no marker", ErrEmpty)
	}
	if len(frame) > maxRaw+1 {
		return nil, fmt.Errorf("%w: a %d-byte frame for a %d-byte limit", ErrTooLarge, len(frame), maxRaw)
	}
	payload := frame[1:]
	switch frame[0] {
	case MarkerRaw:
		if len(payload) == 0 {
			return nil, fmt.Errorf("%w: a raw chunk of no bytes", ErrEmpty)
		}
		return payload, nil
	case MarkerDeflate:
		r := flate.NewReader(bytes.NewReader(payload))
		defer r.Close()
		out, err := io.ReadAll(io.LimitReader(r, int64(maxRaw)+1))
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrCorrupt, err)
		}
		if len(out) > maxRaw {
			return nil, fmt.Errorf("%w: inflates past %d bytes", ErrTooLarge, maxRaw)
		}
		if len(out) == 0 {
			return nil, fmt.Errorf("%w: a deflated chunk of no bytes", ErrEmpty)
		}
		return out, nil
	default:
		return nil, fmt.Errorf("%w: %d", ErrMarker, frame[0])
	}
}
