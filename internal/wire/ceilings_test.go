package wire

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The two ceilings each side writes down separately (R26).
//
// The client will not let a handshake raise its own memory limits past these,
// and it holds them as constants because it needs them before the handshake
// has told it anything. Raising the server's without raising the client's
// gives a server entitled to send a batch the client ends the connection over,
// and neither side reports that as a version mismatch: the client says the
// server overran a frame ceiling and the server says the client hung up.
//
// `protocol-fixtures.json` is where the two languages already keep what they
// both have to agree about, so the numbers go there and both read them.
func TestTheCeilingsBothLanguagesHardCode(t *testing.T) {
	path := filepath.Join("..", "..", "protocol-fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var f struct {
		Ceilings struct {
			MaxBatchBytes int64 `json:"maxBatchBytes"`
			MaxFetchBytes int64 `json:"maxFetchBytes"`
		} `json:"ceilings"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if f.Ceilings.MaxBatchBytes != MaxBatchBytes {
		t.Errorf("maxBatchBytes: the fixtures say %d and this package says %d; the client holds the fixtures' number",
			f.Ceilings.MaxBatchBytes, MaxBatchBytes)
	}
	if f.Ceilings.MaxFetchBytes != MaxFetchBytes {
		t.Errorf("maxFetchBytes: the fixtures say %d and this package says %d; the client holds the fixtures' number",
			f.Ceilings.MaxFetchBytes, MaxFetchBytes)
	}
}
