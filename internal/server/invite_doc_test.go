package server

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

// The invite lifetime is stated in several docs: the README quickstart, the
// agent runbook, the headless client's README, the server, plugin and security
// guides, the two command references, the protocol doc and the protocol spec.
// Each is right for its reader, so they stay, but a change to either constant
// used to mean ten hand edits and no way to know one was missed. Read the docs
// here instead, so a miss fails the build.
//
// Deliberately a scan and not one parsed row: the risk is the sentence
// nobody remembered, which only a sweep of every mention can catch. Four of
// these docs still said ten minutes after the code said an hour, because this
// list did not name them.

var docDuration = regexp.MustCompile(`(?i)\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|thirty)[\s-]+(second|minute|hour|day)s?\b`)

// phrasesFor gives the ways a duration is legitimately written in prose.
func phrasesFor(d time.Duration) map[string]bool {
	words := map[int]string{1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
		6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten", 30: "thirty"}
	ok := map[string]bool{}
	add := func(n int, unit string) {
		ok[fmt.Sprintf("%d %s", n, unit)] = true
		ok[fmt.Sprintf("%d %ss", n, unit)] = true
		if w, has := words[n]; has {
			ok[fmt.Sprintf("%s %s", w, unit)] = true
			ok[fmt.Sprintf("%s %ss", w, unit)] = true
		}
	}
	if m := int(d.Minutes()); m > 0 && m < 60 {
		add(m, "minute")
	}
	if h := int(d.Hours()); h > 0 {
		add(h, "hour")
	}
	return ok
}

type docUnit struct {
	text string
	line int
}

// docUnits splits markdown into the spans a sentence can occupy: one per
// table row, one per paragraph everywhere else.
func docUnits(body string) []docUnit {
	var units []docUnit
	var para []string
	start := 0
	flush := func() {
		if len(para) > 0 {
			units = append(units, docUnit{strings.Join(para, " "), start})
			para = nil
		}
	}
	for n, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			flush()
			continue
		}
		if strings.HasPrefix(trimmed, "|") {
			flush()
			units = append(units, docUnit{line, n + 1})
			continue
		}
		if len(para) == 0 {
			start = n + 1
		}
		para = append(para, trimmed)
	}
	flush()
	return units
}

func TestI23TheDocsStateTheInviteLifetimeTheCodeUses(t *testing.T) {
	allowed := map[string]bool{}
	for phrase := range phrasesFor(DefaultInviteTTL) {
		allowed[phrase] = true
	}
	for phrase := range phrasesFor(MaxInviteTTL) {
		allowed[phrase] = true
	}

	// plan/protocol.md is the spec the constants come from; every other entry
	// is a doc a person or an agent reads the lifetime from.
	docs := []string{"../../README.md", "../../llm.md", "../../client/README.md",
		"../../plan/protocol.md", "../../docs/server.md", "../../docs/server-reference.md",
		"../../docs/plugin.md", "../../docs/cli-reference.md", "../../docs/security.md",
		"../../docs/protocol.md"}

	for _, path := range docs {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Skipf("%s not beside the source: %v", path, err)
		}
		// Named by its path from the repository root: two of these are
		// README.md, and a failure has to say which.
		name := strings.TrimPrefix(path, "../../")
		mentions := 0
		// Prose wraps, so a sentence is only whole at paragraph scale, but a
		// table row must stay its own unit or the hello timeout two rows up
		// reads as an invite lifetime.
		for _, unit := range docUnits(string(body)) {
			if !strings.Contains(strings.ToLower(unit.text), "invite") {
				continue
			}
			for _, m := range docDuration.FindAllStringSubmatch(unit.text, -1) {
				said := strings.ToLower(strings.ReplaceAll(m[0], "-", " "))
				said = strings.Join(strings.Fields(said), " ")
				mentions++
				if !allowed[said] {
					t.Errorf("%s:%d says an invite lasts %q, but the code says %v by default and %v at most\n\t%s",
						name, unit.line, said, DefaultInviteTTL, MaxInviteTTL, strings.TrimSpace(unit.text))
				}
			}
		}
		// Without this the test passes for a doc that stopped saying it, and
		// a count over the whole set would let one doc's second mention
		// cover for another's missing one.
		if mentions == 0 {
			t.Errorf("%s never states the invite lifetime; it is on this list because it should", name)
		}
	}
}
