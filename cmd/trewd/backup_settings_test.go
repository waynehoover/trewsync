package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/waynehoover/trewsync/internal/config"
	"github.com/waynehoover/trewsync/internal/gitexport"
)

// T38. A backup held the database, the bodies and backup.json, and nothing
// of the configuration file, so the documented restore, unpacking into a
// fresh directory or copying a plaintext backup back, came up with the Git
// export off and the daily-note settings at their defaults: the off-site
// history stopped without a word, doctor said only "note: the git export is
// off", and today_note wrote to the vault's root. Both kinds of backup now
// carry trewd.json, which holds paths and no secret, and a restore brings it
// back.
func TestARestoreBringsBackTheSettings(t *testing.T) {
	dir := seeded(t)
	want := config.File{GitExport: config.GitExport{Enabled: true, Branch: "notes"},
		Daily: config.Daily{Folder: "Journal"}}
	if err := config.Save(dir, want); err != nil {
		t.Fatal(err)
	}
	restoredHas := func(restored string) {
		t.Helper()
		got, found, err := config.Load(restored)
		if err != nil || !found {
			t.Fatalf("the restore holds no configuration file (%v)", err)
		}
		if got.Daily.Folder != "Journal" || !got.GitExport.Enabled || got.GitExport.Branch != "notes" {
			t.Fatalf("the restore's settings are %+v", got)
		}
		st, err := gitexport.Inspect(restored)
		if err != nil || !st.Enabled {
			t.Fatalf("the restored server's Git export is off: %+v (%v)", st, err)
		}
	}

	key := filepath.Join(t.TempDir(), "key")
	mustRun(t, "backup-key", "-x25519", "-out", key)
	archive := filepath.Join(t.TempDir(), "trew.tar.age")
	mustRun(t, "backup", "-data", dir, "-to", archive, "-recipients-file", key+".pub")
	unpacked := filepath.Join(t.TempDir(), "unpacked")
	mustRun(t, "unpack", "-from", archive, "-identity", key, "-to", unpacked, "-record", dir)
	restoredHas(unpacked)

	// An archive nothing compared with a record could be anybody's, and its
	// settings could point the Git export anywhere: they are set aside, not
	// used, and said.
	unchecked := filepath.Join(t.TempDir(), "unchecked")
	out := mustRun(t, "unpack", "-from", archive, "-identity", key, "-to", unchecked)
	if _, found, _ := config.Load(unchecked); found {
		t.Fatalf("an unchecked archive's settings were put in use:\n%s", out)
	}
	if _, err := os.Stat(filepath.Join(unchecked, settingsAside)); err != nil || !strings.Contains(out, settingsAside) {
		t.Fatalf("an unchecked archive's settings were not set aside and said (%v):\n%s", err, out)
	}

	plain := filepath.Join(t.TempDir(), "plain")
	mustRun(t, "backup", "-plaintext-ok", "-data", dir, "-to", plain)
	copied := filepath.Join(t.TempDir(), "copied")
	copyTree(t, plain, copied)
	restoredHas(copied)

	// Settings removed at the source are removed from the next backup, so a
	// restore does not bring back ones the server no longer runs with.
	if err := os.Remove(config.Path(dir)); err != nil {
		t.Fatal(err)
	}
	mustRun(t, "backup", "-plaintext-ok", "-data", dir, "-to", plain)
	if _, err := os.Stat(config.Path(plain)); !os.IsNotExist(err) {
		t.Fatalf("the backup kept settings its source no longer has (%v)", err)
	}
	mustRun(t, "backup", "-data", dir, "-to", archive, "-recipients-file", key+".pub")
	again := filepath.Join(t.TempDir(), "again")
	mustRun(t, "unpack", "-from", archive, "-identity", key, "-to", again)
	if _, err := os.Stat(config.Path(again)); !os.IsNotExist(err) {
		t.Fatalf("the archive brought back settings its source no longer has (%v)", err)
	}
}
