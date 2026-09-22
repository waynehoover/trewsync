package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDatabasePathsAreLiteralFilesystemPaths(t *testing.T) {
	for _, name := range []string{"what?next", "100%25", "hash#name", "spaces and + plus"} {
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), name)
			dbPath, chunkDir := DataDir(dir)
			st, err := Open(dbPath, chunkDir)
			if err != nil {
				t.Fatal(err)
			}
			if err := st.EnsureVault("kept", 1000); err != nil {
				_ = st.Close()
				t.Fatal(err)
			}
			if err := st.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(dbPath); err != nil {
				t.Fatalf("database was not written at the requested path: %v", err)
			}
			for _, mode := range []Mode{Existing, ReadOnly} {
				opened, err := OpenMode(dbPath, chunkDir, mode, SyncFull)
				if err != nil {
					t.Fatal(err)
				}
				vaults, err := opened.Vaults()
				_ = opened.Close()
				if err != nil || len(vaults) != 1 || vaults[0] != "kept" {
					t.Fatalf("reopened another database: vaults %v, error %v", vaults, err)
				}
			}
		})
	}
}
