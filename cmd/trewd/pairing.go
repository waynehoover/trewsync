package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/waynehoover/trewsync/internal/fsync"
	"github.com/waynehoover/trewsync/internal/invite"
	"github.com/waynehoover/trewsync/internal/store"
)

// firstInviteFile is where `serve` writes the first device's invite, inside the
// data directory, unless -invite-out names somewhere else (plan/protocol.md,
// "Devices and invites").
const firstInviteFile = "first-invite"

// firstInviteLabel is the label the first device's invite carries in a listing.
const firstInviteLabel = "first device"

// FirstInviteTTL is how long the first device's invite lives: an hour, like
// every invite nobody chose a lifetime for. A server started and left alone
// for longer mints a fresh one on its next start, since the old one is then
// neither outstanding nor able to pair anything.
const FirstInviteTTL = time.Hour

// placeholderHost is what pairingHosts names when it can find no address a
// device could dial, so that nothing mints an invite pointing at it.
const placeholderHost = "<this-host>"

// inviteURLs is every server address an invite from this server can carry,
// canonical ws:// or wss://, in the order a person should try them.
//
// explicit is -url, and when it is given it is the whole answer: whoever typed
// it knows the name the devices reach, which is usually a tunnel's and not this
// machine's. Otherwise local (-localhost) is the loopback address with ws://,
// since nothing terminates TLS in front of a trial on one machine. Otherwise it
// is pairingHosts over the bound address, with wss://, which is what Basalt's
// pairing strings meant when they carried no scheme. None, when pairingHosts
// found nothing but its placeholder: an invite pointing at "<this-host>" is a
// string that fails when pasted, and the caller says what to do instead.
func inviteURLs(explicit, bound string, local bool) ([]string, error) {
	if explicit != "" {
		if err := checkInviteURL(explicit); err != nil {
			return nil, fmt.Errorf("-url %q: %w", explicit, err)
		}
		return []string{explicit}, nil
	}
	if local {
		return []string{"ws://" + bound}, nil
	}
	var out []string
	for _, host := range pairingHosts(bound) {
		if strings.HasPrefix(host, placeholderHost) {
			continue
		}
		u := "wss://" + host
		if checkInviteURL(u) == nil {
			out = append(out, u)
		}
	}
	return out, nil
}

// checkInviteURL refuses an address the invite codec would refuse, by asking
// the codec, so there is one definition of a canonical address.
func checkInviteURL(u string) error {
	_, err := invite.Format(invite.Invite{
		Token: make([]byte, invite.TokenBytes), URL: u, Vault: defaultVault,
	})
	return err
}

// boundAddr is the address to name in an invite: the host the operator asked
// to bind, with the port the kernel actually gave, which differs from the one
// asked for only when that was 0.
func boundAddr(asked string, ln net.Addr) string {
	host, _, err := net.SplitHostPort(asked)
	if err != nil {
		return ln.String()
	}
	_, port, err := net.SplitHostPort(ln.String())
	if err != nil {
		return asked
	}
	return net.JoinHostPort(host, port)
}

// formatInvites is one invite string per address, all carrying one token. A
// device redeems whichever it can reach, and the token then redeems nothing, so
// the strings it did not use die with it.
func formatInvites(token []byte, urls []string, vault string) ([]string, error) {
	out := make([]string, 0, len(urls))
	for _, u := range urls {
		s, err := invite.Format(invite.Invite{Token: token, URL: u, Vault: vault})
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, nil
}

// firstInvite is what `serve` did about the first device.
type firstInvite struct {
	// Written is true when an invite was minted and written to Path.
	Written   bool
	Path      string
	ExpiresAt time.Time
	// Paired is true when the vault already has a device, and Outstanding
	// when it has none but an invite that could still add one; either way
	// nothing was minted.
	Paired      bool
	Outstanding bool
	// NoAddress is true when there was nothing to mint for: no -url, and no
	// address of this machine a device could dial.
	NoAddress bool
}

// mintFirstInvite gives a store with no devices a way to get its first one
// (plan/protocol.md, "The first device").
//
// Only when the vault has no device and no invite outstanding. A restart inside
// the hour therefore leaves the invite already written alone, rather than
// replacing a string somebody may be halfway through pasting; a restart after
// it has expired mints a new one, because the old one can no longer pair
// anything and a server that said nothing would leave nobody able to pair.
//
// The string is written, at 0600 and atomically, to a file, and never to the
// log or to stdout, because a container log is not a private place and the
// string is a credential for the whole vault. If writing it fails the invite is
// cancelled again, so a token nobody holds does not stand in the way of the
// next start's.
func mintFirstInvite(st *store.Store, vault string, urls []string, path string, now time.Time) (firstInvite, error) {
	devices, err := st.Devices(vault)
	if err != nil {
		return firstInvite{}, err
	}
	if len(devices) > 0 {
		return firstInvite{Paired: true}, nil
	}
	outstanding, err := st.OutstandingInvites(vault, now.UnixMilli())
	if err != nil {
		return firstInvite{}, err
	}
	if outstanding > 0 {
		return firstInvite{Outstanding: true, Path: path}, nil
	}
	if len(urls) == 0 {
		return firstInvite{NoAddress: true}, nil
	}
	expires := now.Add(FirstInviteTTL)
	expiresAt := expires.UnixMilli()
	inv, err := st.CreateInvite(vault, firstInviteLabel, "", &expiresAt, now.UnixMilli())
	if err != nil {
		return firstInvite{}, err
	}
	lines, err := formatInvites(inv.Token, urls, vault)
	if err == nil {
		err = writeSecretFile(path, strings.Join(lines, "\n")+"\n")
	}
	if err != nil {
		if cerr := st.CancelInvite(vault, inv.ID, now.UnixMilli()); cerr != nil {
			return firstInvite{}, fmt.Errorf("%w (and the invite it was for could not be cancelled: %v)", err, cerr)
		}
		return firstInvite{}, fmt.Errorf("writing the first device's invite to %s: %w", path, err)
	}
	return firstInvite{Written: true, Path: path, ExpiresAt: expires}, nil
}

// printPairing says what the server is and how the next device joins it. It
// names the file an invite is in and never prints the invite.
func printPairing(out io.Writer, addr, vault string, first firstInvite) {
	fmt.Fprintf(out, "trewd %s listening on %s, serving vault %q\n", resolveVersion(version, moduleVersion()), addr, vault)
	fmt.Fprintln(out)
	switch {
	case first.Written:
		fmt.Fprintln(out, "No device is paired with this vault yet. The invite for the first one is in")
		fmt.Fprintf(out, "  %s\n", first.Path)
		fmt.Fprintf(out, "and works once, until %s. Paste a line from it into TrewSync on that device.\n",
			first.ExpiresAt.UTC().Format(time.RFC3339))
		fmt.Fprintln(out, "Each line names one address of this server; use the one the device can reach.")
	case first.Outstanding:
		fmt.Fprintln(out, "No device is paired with this vault yet, and an invite for one is still outstanding.")
		fmt.Fprintf(out, "If this server wrote it, it is in %s. `trewd invite` makes another.\n", first.Path)
	case first.NoAddress:
		fmt.Fprintln(out, "No device is paired with this vault yet, and this server cannot tell which address")
		fmt.Fprintln(out, "devices reach it at, so it wrote no invite. Start it with -url wss://your-host:port,")
		fmt.Fprintln(out, "the name TLS is terminated at, or run `trewd invite -url wss://your-host:port`.")
	default:
		fmt.Fprintln(out, "To add a device, run `trewd invite` on this server, or make an invite on a")
		fmt.Fprintln(out, "device that already has the vault.")
	}
}

// writeSecretFile writes a credential to a file atomically and durably, then
// proves it (S11). What it holds is an invite string, which adds a device to the
// vault, so this is worth more than an os.WriteFile.
//
//   - A temp file in the same directory, fsynced, then renamed over the target,
//     so a crash mid-write leaves either the old file or the new one, never
//     half of one. os.WriteFile truncates in place, and a crash there is the
//     truncation this exists to avoid.
//   - The directory is fsynced after the rename, or the name can be lost while
//     the bytes are durable.
//   - The mode is set explicitly to 0600 on the temp file, and the rename
//     replaces whatever was there, so a file an older copy left at 0644 does
//     not keep its mode.
//   - It is read back and checked, content and mode both. Rule 4: verify the
//     outcome, not the exit code.
func writeSecretFile(path, content string) error {
	dir := filepath.Dir(path)
	tmpName, err := stageSecretFile(dir, filepath.Base(path), content)
	if err != nil {
		return err
	}
	// Removed if anything below fails; a no-op once the rename has consumed it.
	defer os.Remove(tmpName)
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	if err := fsync.Dir(dir); err != nil {
		return err
	}
	return verifySecretFile(path, content)
}

// writeNewSecretFile writes a credential as writeSecretFile does, atomically,
// durably, at 0600 and read back, and never over a file that is already
// there. The staged temp file is hard-linked to the name rather than renamed
// over it: a link fails when the name exists, and the check is the kernel's,
// made at the moment the name is taken, so a file that appears between a
// caller's own check and this write is refused, not clobbered.
//
// A failure after the name was taken removes the file this call made, when it
// is still the one this call made, so an error leaves no copy of the secret
// behind.
func writeNewSecretFile(path, content string) error {
	dir := filepath.Dir(path)
	tmpName, err := stageSecretFile(dir, filepath.Base(path), content)
	if err != nil {
		return err
	}
	defer os.Remove(tmpName)
	if err := os.Link(tmpName, path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return fmt.Errorf("%s exists, and is not written over: choose another name, or remove it first", path)
		}
		return err
	}
	err = fsync.Dir(dir)
	if err == nil {
		err = verifySecretFile(path, content)
	}
	if err != nil {
		staged, serr := os.Stat(tmpName)
		landed, lerr := os.Stat(path)
		if serr == nil && lerr == nil && os.SameFile(staged, landed) {
			_ = os.Remove(path)
		}
		return err
	}
	return nil
}

// stageSecretFile writes content to a new temp file in dir at mode 0600 and
// fsyncs it, for writeSecretFile and writeNewSecretFile to put in place. It
// makes dir, at 0700, when it is missing. The caller removes the temp file.
func stageSecretFile(dir, base, content string) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(dir, "."+base+".*")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	fail := func(err error) (string, error) {
		tmp.Close()
		os.Remove(tmpName)
		return "", err
	}
	if err := tmp.Chmod(0o600); err != nil {
		return fail(err)
	}
	if _, err := tmp.WriteString(content); err != nil {
		return fail(err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return "", err
	}
	return tmpName, nil
}

// verifySecretFile proves a written credential: the bytes, and the mode, are
// what was intended. Rule 4: verify the outcome, not the exit code.
func verifySecretFile(path, content string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("verifying %s: %w", path, err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		return fmt.Errorf("%s has mode %o after writing, want 600", path, perm)
	}
	back, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("verifying %s: %w", path, err)
	}
	if string(back) != content {
		return fmt.Errorf("%s does not contain what was just written", path)
	}
	return nil
}
