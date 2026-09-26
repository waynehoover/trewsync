package mcp

import (
	"net/http"
	"strings"
	"testing"

	"github.com/waynehoover/trewsync/internal/store"
)

// No credential travels in a URL, where proxies and access logs keep it
// (threat model C6, plan/research/README.md section 5): /mcp with any query
// string at all is not the endpoint, and is answered as a path that is not
// there, before the credential is looked at, even when the query holds a
// valid token and the header holds it too.
func TestAQueryStringIsNeverTheEndpoint(t *testing.T) {
	r := newRig(t)
	token, _ := r.token(store.ScopeRead)
	for _, q := range []string{"?token=" + token, "?access_token=" + token, "?", "?x=1"} {
		req, err := http.NewRequest(http.MethodPost, r.url+q, strings.NewReader(toolCall("vault_status")))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Mcp-Protocol-Version", Version20251125)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("POST /mcp%s answered %d", q, resp.StatusCode)
		}
	}
}
