package config

import (
	"os"
	"strings"
	"testing"
)

// TestTheFileRoundTripsAndRefusesWhatItDoesNotKnow: every key set is read
// back as set, the file is 0600, and a key this build does not know is an
// error naming it, never ignored.
func TestTheFileRoundTripsAndRefusesWhatItDoesNotKnow(t *testing.T) {
	dir := t.TempDir()
	var f File
	values := map[string]string{}
	for i, k := range Keys {
		v := "value" + string(rune('a'+i))
		switch k.Name {
		case "git_export.enabled":
			v = "true"
		case "git_export.lfs_threshold":
			v = "2MiB"
		case "git_export.quiet":
			v = "90s"
		}
		if err := k.Set(&f, v); err != nil {
			t.Fatalf("%s: %v", k.Name, err)
		}
		values[k.Name] = v
	}
	if err := Save(dir, f); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(Path(dir))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the file is %v (%v)", info, err)
	}
	g, found, err := Load(dir)
	if err != nil || !found {
		t.Fatalf("reading it back: %v", err)
	}
	for _, k := range Keys {
		got, ok := k.Get(&g)
		want := values[k.Name]
		if k.Path {
			ok = ok && strings.HasSuffix(got, "/"+want)
		} else if k.Name == "git_export.lfs_threshold" {
			ok = ok && got == "2097152"
		} else {
			ok = ok && got == want
		}
		if !ok {
			t.Errorf("%s reads back as %q", k.Name, got)
		}
		k.Unset(&g)
		if _, set := k.Get(&g); set {
			t.Errorf("%s is still set after unset", k.Name)
		}
	}
	if err := os.WriteFile(Path(dir), []byte(`{"git_export": {"remot": "x"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Load(dir); err == nil || !strings.Contains(err.Error(), "remot") {
		t.Fatalf("a misspelt key: %v", err)
	}
	if _, found, err := Load(t.TempDir()); found || err != nil {
		t.Fatalf("no file: found %v, %v", found, err)
	}
}

func TestEveryKeyHasItsOwnFlag(t *testing.T) {
	seen := map[string]bool{}
	for _, k := range Keys {
		if k.Flag == "" || seen[k.Flag] || k.Help == "" || k.Default == "" {
			t.Errorf("%s: flag %q, help %q, default %q", k.Name, k.Flag, k.Help, k.Default)
		}
		seen[k.Flag] = true
	}
	for _, bad := range []string{"-1", "1 TB", "x"} {
		if _, err := ParseSize(bad); err == nil {
			t.Errorf("%q is a size", bad)
		}
	}
}
