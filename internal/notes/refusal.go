package notes

import "unicode/utf8"

// NoteBytes is the largest note an agent may read or write: 1 MiB.
const NoteBytes = 1 << 20

// Refusal is an input the functions here decline, with the code Basalt's tools
// reported for it. The MCP layer turns it into the tool's error object; the
// code is part of the contract, the message is for people.
type Refusal struct {
	Code    string
	Message string
	// Path is the note a plan refused, when it read several. It can be one
	// the plan found in the vault rather than one the caller named, so a
	// tool reports it as note-derived. Empty otherwise.
	Path string
}

func (r *Refusal) Error() string { return r.Code + ": " + r.Message }

func refuse(code, message string) *Refusal { return &Refusal{Code: code, Message: message} }

// DecodeNote is Basalt's noteText: the note's bytes as text, refusing a note
// over NoteBytes (note_too_large) and bytes that are not UTF-8 (invalid_utf8).
// Go's decoder refuses the same sequences a fatal TextDecoder does, encoded
// surrogates and overlong forms included. A byte-order mark is kept, as
// Basalt's decoder was told to keep it.
func DecodeNote(b []byte) (string, error) {
	if len(b) > NoteBytes {
		return "", refuse("note_too_large", "notes must be at most 1 MiB")
	}
	if !utf8.Valid(b) {
		return "", refuse("invalid_utf8", "the note is not valid UTF-8")
	}
	return string(b), nil
}
