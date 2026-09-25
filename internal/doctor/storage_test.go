package doctor

import (
	"strings"
	"testing"
)

const containerWithVolume = `overlay / overlay rw,relatime,lowerdir=/var/lib/docker/l/A 0 0
proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
tmpfs /dev tmpfs rw,nosuid,size=65536k,mode=755 0 0
/dev/sda1 /data ext4 rw,relatime 0 0
/dev/sda1 /etc/hosts ext4 rw,relatime 0 0
`

func TestTheLongestCoveringMountWins(t *testing.T) {
	mounts, err := parseMounts(strings.NewReader(containerWithVolume))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ path, point, fsType string }{
		{"/data", "/data", "ext4"},
		{"/data/vault/trew.db", "/data", "ext4"},
		{"/database", "/", "overlay"}, // a sibling that shares a prefix is not under /data
		{"/srv/trew", "/", "overlay"},
		{"/dev/shm", "/dev", "tmpfs"},
	} {
		point, fsType, _ := mountOf(c.path, mounts)
		if point != c.point || fsType != c.fsType {
			t.Errorf("%s: on %s (%s), want %s (%s)", c.path, point, fsType, c.point, c.fsType)
		}
	}
}

func TestALaterMountAtTheSamePointIsTheOneOnTop(t *testing.T) {
	mounts, _ := parseMounts(strings.NewReader("/dev/sda1 /data ext4 rw 0 0\ntmpfs /data tmpfs rw 0 0\n"))
	if _, fsType, _ := mountOf("/data/x", mounts); fsType != "tmpfs" {
		t.Fatalf("the stacked mount was not the one found: %s", fsType)
	}
}

func TestEveryOctalEscapeInAMountPointIsDecoded(t *testing.T) {
	for in, want := range map[string]string{
		`/mnt/my\040vault`:   "/mnt/my vault",
		`/mnt/tab\011here`:   "/mnt/tab\there",
		`/mnt/back\134slash`: `/mnt/back\slash`,
		`/mnt/caf\303\251`:   "/mnt/caf\u00e9",
		`/mnt/not\8escape`:   `/mnt/not\8escape`,
		`/mnt/short\04`:      `/mnt/short\04`,
		`/plain`:             "/plain",
	} {
		if got := unescapeOctal(in); got != want {
			t.Errorf("unescapeOctal(%q) = %q, want %q", in, got, want)
		}
	}
	mounts, _ := parseMounts(strings.NewReader(`/dev/sdb1 /mnt/my\040vault ext4 rw 0 0` + "\n"))
	if point, _, _ := mountOf("/mnt/my vault/data", mounts); point != "/mnt/my vault" {
		t.Fatalf("a mount point with a space was not matched: %q", point)
	}
}

func TestWhatCountsAsEphemeral(t *testing.T) {
	for _, c := range []struct {
		fsType    string
		container bool
		want      bool
	}{
		{"tmpfs", false, true}, // lost at the next reboot, container or not
		{"ramfs", true, true},
		{"overlay", true, true}, // a container's own layer: lost on replacement
		{"overlay", false, false},
		{"ext4", true, false},
		{"zfs", false, false},
		{"", false, false}, // nothing known: nothing claimed
	} {
		if got := ephemeral(c.fsType, c.container); got != c.want {
			t.Errorf("%s in container=%v: ephemeral=%v, want %v", c.fsType, c.container, got, c.want)
		}
	}
}

func TestStorageOfAnswersOnEveryPlatform(t *testing.T) {
	s, err := StorageOf(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if s.Dir == "" {
		t.Fatal("no directory reported")
	}
}
