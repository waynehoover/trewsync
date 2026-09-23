package main

import (
	"net"
	"strings"
	"testing"
)

// pairingHosts, which the first invite and `trewd invite` both name their
// addresses from. A bind address is not an address: a wildcard is replaced by
// this machine's interfaces, never by the wildcard, loopback or a link-local
// address, and an explicit address is already the answer. When nothing can be
// found it says so with the placeholder, which inviteURLs then refuses to put
// in an invite.
func TestPairingHostsNamesAddressesADeviceCanDial(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:3003", ":3003", "[::]:3003"} {
		hosts := pairingHosts(addr)
		if len(hosts) == 0 {
			t.Fatalf("%s: no hosts at all, not even the placeholder", addr)
		}
		for _, h := range hosts {
			if strings.HasPrefix(h, placeholderHost) {
				continue
			}
			host, port, err := net.SplitHostPort(h)
			if err != nil || port != "3003" {
				t.Fatalf("%s gave %q, which is not host:3003", addr, h)
			}
			ip := net.ParseIP(host)
			if ip == nil || ip.IsUnspecified() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				t.Errorf("%s gave %q, which another device cannot dial", addr, h)
			}
		}
	}
	for _, addr := range []string{"vault.example.ts.net:3003", "192.0.2.7:8443", "[2001:db8::1]:3003"} {
		if got := pairingHosts(addr); len(got) != 1 || got[0] != addr {
			t.Errorf("an explicit %s became %v", addr, got)
		}
	}
	if got := pairingHosts("not an address"); len(got) != 1 || got[0] != "not an address" {
		t.Errorf("an address that does not split came back as %v", got)
	}
	if urls, err := inviteURLs("", placeholderHost+":3003", false); err != nil || len(urls) != 0 {
		t.Errorf("the placeholder became invite addresses %v (%v)", urls, err)
	}
}
