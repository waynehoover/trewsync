package notes

import "strconv"

// Basalt measured its page budgets with Buffer.byteLength(JSON.stringify(row))
// and fingerprinted query options with JSON.stringify, so both depend on the
// exact bytes JavaScript's serialiser writes. Go's encoding/json writes others:
// it escapes <, > and &, U+2028 and U+2029, and replaces invalid UTF-8. These
// helpers write what JSON.stringify writes instead, for the few shapes the
// ports need.

const hexDigits = "0123456789abcdef"

// appendJSString appends JSON.stringify(s): a quote, backslash and the C0
// controls escaped (the five with short forms as such, the rest as \u00xx in
// lower case), everything else as itself.
func appendJSString(b []byte, s string) []byte {
	b = append(b, '"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"':
			b = append(b, '\\', '"')
		case c == '\\':
			b = append(b, '\\', '\\')
		case c == '\b':
			b = append(b, '\\', 'b')
		case c == '\f':
			b = append(b, '\\', 'f')
		case c == '\n':
			b = append(b, '\\', 'n')
		case c == '\r':
			b = append(b, '\\', 'r')
		case c == '\t':
			b = append(b, '\\', 't')
		case c < 0x20:
			b = append(b, '\\', 'u', '0', '0', hexDigits[c>>4], hexDigits[c&0xf])
		default:
			b = append(b, c)
		}
	}
	return append(b, '"')
}

// jsStringSize is len(appendJSString(nil, s)) without building it.
func jsStringSize(s string) int {
	n := 2
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"', c == '\\', c == '\b', c == '\f', c == '\n', c == '\r', c == '\t':
			n += 2
		case c < 0x20:
			n += 6
		default:
			n++
		}
	}
	return n
}

// jsStringsSize is the serialised size of a JSON array of strings.
func jsStringsSize(list []string) int {
	n := 2
	for i, s := range list {
		if i > 0 {
			n++
		}
		n += jsStringSize(s)
	}
	return n
}

// jsIntSize is the length of an integer as JSON.stringify writes it.
func jsIntSize(v int) int {
	return len(strconv.Itoa(v))
}

// jsBoolSize is the length of true or false.
func jsBoolSize(v bool) int {
	if v {
		return 4
	}
	return 5
}
