package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/waynehoover/trewsync/internal/control"
	"github.com/waynehoover/trewsync/internal/store"
)

// cmdAudit prints what agents have done to the vault: every operation the
// store recorded (PLAN.md M5 task 2), with who made it, which tool, when by
// the server's clock, every path it changed with its versions before and
// after, and the versions it pinned against purge.
//
// It is how a person explains an agent's overnight run, so it answers from
// the log the running server is writing, through its control socket, and
// opens the store itself only when no server is running, exactly as
// `devices` does (PLAN.md section 2.3.1). Everything by default: a listing
// that hid the older operations unless asked would be describing the filter
// and not the vault (rule 7). -since narrows it.
//
// Nothing it prints is a credential or a note's body, because the log holds
// neither. Paths and labels are quoted, since a path is plaintext and one the
// policy refuses could otherwise forge a line of the report.
func cmdAudit(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("audit", flag.ContinueOnError)
	dataDir, vault := adminFlags(fs)
	sinceFlag := fs.String("since", "",
		"only operations committed since then: a duration back from now (24h, 7d) or a time (2026-09-23, RFC 3339); default all of them")
	asJSON := fs.Bool("json", false, "print the operations as JSON")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	since, err := parseSince(*sinceFlag, time.Now())
	if err != nil {
		return err
	}

	var ops []store.OperationRecord
	var page *control.Audit
	var after int64
	for {
		reply, err := administer(*dataDir, *vault, "read the audit", control.Request{Op: "audit", Since: since, After: after})
		if err != nil {
			return err
		}
		if err := refused(reply); err != nil {
			return err
		}
		if reply.Audit == nil {
			return errors.New("the server answered the audit with nothing")
		}
		page = reply.Audit
		var got []store.OperationRecord
		if err := json.Unmarshal(page.Operations, &got); err != nil {
			return err
		}
		ops = append(ops, got...)
		if !page.More || len(got) == 0 {
			break
		}
		after = got[len(got)-1].Seq
	}
	if ops == nil {
		ops = []store.OperationRecord{}
	}

	if *asJSON {
		b, err := json.MarshalIndent(struct {
			Vault      string                  `json:"vault"`
			Epoch      string                  `json:"epoch"`
			Since      int64                   `json:"since"`
			Operations []store.OperationRecord `json:"operations"`
		}{page.Vault, page.Epoch, since, ops}, "", "  ")
		if err != nil {
			return err
		}
		_, err = fmt.Fprintf(out, "%s\n", b)
		return err
	}

	window := "every one recorded"
	if since > 0 {
		window = "since " + stamp(since)
	}
	fmt.Fprintf(out, "%d agent operations on vault %q, %s\n", len(ops), page.Vault, window)
	for _, o := range ops {
		writeOperation(out, o, page.Epoch)
	}
	return nil
}

// writeOperation prints one operation: a line for the operation, a line for
// each path it changed, and a line for each version it pinned.
func writeOperation(out io.Writer, o store.OperationRecord, epoch string) {
	fmt.Fprintf(out, "\n%s  %s  %s  by %s  op %s\n", stamp(o.CommittedAt), o.Tool, o.Outcome, actorOf(o), o.ID)
	var notes []string
	if o.Undoes != "" {
		notes = append(notes, "undoes op "+o.Undoes)
	}
	if o.UndoneBy != "" {
		notes = append(notes, "undone by op "+o.UndoneBy)
	}
	if o.IdempotencyKey != "" {
		notes = append(notes, fmt.Sprintf("key %q", o.IdempotencyKey))
	}
	if o.ClientName != "" || o.ClientVersion != "" {
		notes = append(notes, fmt.Sprintf("client %q", strings.TrimSpace(o.ClientName+" "+o.ClientVersion)))
	}
	if o.SnapshotHead != nil {
		notes = append(notes, fmt.Sprintf("previewed at uid %d", *o.SnapshotHead))
	}
	if o.Epoch != epoch {
		// Its uids are the history before a restore, which the restored
		// store may have issued again to other versions.
		notes = append(notes, "before a restore: its uids are the old history's")
	}
	if len(notes) > 0 {
		fmt.Fprintf(out, "    %s\n", strings.Join(notes, ", "))
	}
	for _, p := range o.Paths {
		before := "new"
		if p.BeforeUID != nil {
			before = "uid " + strconv.FormatInt(*p.BeforeUID, 10)
		}
		what := "    %-6s %q  %s -> uid %d\n"
		if p.Role == "source" {
			what = "    %-6s %q  %s -> moved away at uid %d\n"
		}
		fmt.Fprintf(out, what, p.Role, p.Path, before, p.AfterUID)
	}
	if o.PathsTotal > len(o.Paths) {
		fmt.Fprintf(out, "    and %d more paths\n", o.PathsTotal-len(o.Paths))
	}
	for _, pin := range o.Pins {
		fmt.Fprintf(out, "    pinned uid %d until %s\n", pin.UID, stamp(pin.ExpiresAt))
	}
}

// stamp is a time in milliseconds as the audit prints it.
func stamp(ms int64) string { return time.UnixMilli(ms).UTC().Format(time.RFC3339) }

// parseSince reads -since: empty for everything, a duration back from now
// (Go's, or a whole number of days such as 7d, which Go's has no unit for),
// a date, or an RFC 3339 time. Milliseconds, and never in the future of now
// by accident of a sign: a negative duration is refused.
func parseSince(s string, now time.Time) (int64, error) {
	if s == "" {
		return 0, nil
	}
	if days, ok := strings.CutSuffix(s, "d"); ok {
		if n, err := strconv.Atoi(days); err == nil {
			if n < 0 {
				return 0, fmt.Errorf("-since %s: a duration back from now is not negative", s)
			}
			return now.Add(-time.Duration(n) * 24 * time.Hour).UnixMilli(), nil
		}
	}
	if d, err := time.ParseDuration(s); err == nil {
		if d < 0 {
			return 0, fmt.Errorf("-since %s: a duration back from now is not negative", s)
		}
		return now.Add(-d).UnixMilli(), nil
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04", "2006-01-02"} {
		if at, err := time.Parse(layout, s); err == nil {
			return at.UnixMilli(), nil
		}
	}
	return 0, fmt.Errorf("-since %q is neither a duration (24h, 7d) nor a time (2026-09-23, 2026-09-23T10:00:00Z)", s)
}
