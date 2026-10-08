package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/waynehoover/trewsync/internal/control"
	"github.com/waynehoover/trewsync/internal/doctor"
)

// doctorStorage is the mount-table reading doctor and serve use, a seam for
// the tests that put a data directory on storage they cannot mount.
var doctorStorage = doctor.StorageOf

// doctorSpace, when set, stands in for the data volume's free and total
// bytes, for the tests that fill a disk they cannot fill. Nil otherwise.
var doctorSpace func(dir string) (free, total int64)

// cmdDoctor diagnoses a data directory (PLAN.md M5.5) and changes nothing:
// every check internal/doctor runs, each with its status and, when it is not
// ok, what to do. It exits non-zero when any finding needs somebody to act,
// so a timer or a monitor can run it and alert on the status alone.
func cmdDoctor(ctx context.Context, args []string, out io.Writer) error {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	dataDir := dataFlags(fs)
	vault := fs.String("vault", defaultVault, "the vault the server serves")
	url := fs.String("url", "", "the address devices reach the server at, whose /health doctor asks "+
		"(default: the running server's own addresses)")
	sample := fs.Int("sample", doctor.DefaultSample, "how many chunk references to read and hash")
	deep := fs.Bool("deep", false, "read and hash every chunk reference, as trewd verify -deep does")
	var accept stringList
	fs.Var(&accept, "accept", "a check whose warning the operator has accepted, repeatable ("+
		strings.Join(doctor.Checks, ", ")+")")
	asJSON := fs.Bool("json", false, "print the report as JSON")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	accepted := map[string]bool{}
	for _, a := range accept {
		known := false
		for _, c := range doctor.Checks {
			known = known || c == a
		}
		if !known {
			return fmt.Errorf("-accept %q is not a check; the checks are %s", a, strings.Join(doctor.Checks, ", "))
		}
		accepted[a] = true
	}

	rep := doctor.Run(ctx, doctor.Options{
		DataDir: *dataDir, Vault: *vault, URL: *url, Sample: *sample, Deep: *deep, Accept: accepted,
		Storage: doctorStorage, Space: doctorSpace,
	})
	if *asJSON {
		b, err := json.MarshalIndent(rep, "", "  ")
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "%s\n", b)
	} else {
		writeDoctor(out, rep)
	}
	if n := rep.Actionable(); n > 0 {
		return fmt.Errorf("%d of %d checks need attention", n, len(rep.Findings))
	}
	return nil
}

// writeDoctor prints a report: a line per check, its detail indented under
// it, and its remedy after an arrow.
func writeDoctor(out io.Writer, rep doctor.Report) {
	fmt.Fprintf(out, "trewd doctor: %s, vault %q, %s\n", rep.DataDir, rep.Vault,
		time.UnixMilli(rep.At).UTC().Format(time.RFC3339))
	for _, f := range rep.Findings {
		fmt.Fprintf(out, "\n%-8s %-10s %s\n", strings.ToUpper(string(f.Status)), f.Check, f.Summary)
		for _, d := range f.Detail {
			fmt.Fprintf(out, "%19s %s\n", "", d)
		}
		if f.Remedy != "" && f.Status != doctor.OK {
			fmt.Fprintf(out, "%19s -> %s\n", "", f.Remedy)
		}
	}
	if s := rep.Sizes; s != nil {
		fmt.Fprintf(out, "\nsizes: database %s, write-ahead log %s, search index %s, %d bodies %s, %s free of %s\n",
			humanBytes(s.Database), humanBytes(s.WAL), humanBytes(s.Index), s.Bodies, humanBytes(s.BodyBytes),
			humanBytes(s.FreeBytes), humanBytes(s.TotalBytes))
	}
	n := rep.Actionable()
	fmt.Fprintln(out)
	switch n {
	case 0:
		fmt.Fprintln(out, "Nothing needs attention. doctor changed nothing.")
	case 1:
		fmt.Fprintln(out, "1 check needs attention. doctor changed nothing.")
	default:
		fmt.Fprintf(out, "%d checks need attention. doctor changed nothing.\n", n)
	}
}

// status is the control socket's status, for `trewd doctor`: what the running
// server knows that its data directory does not.
func (o *operator) status() control.Reply {
	health, err := json.Marshal(healthOf(o.srv.Store()))
	if err != nil {
		return control.Refused(control.CodeInternal, err.Error())
	}
	devices, err := o.srv.Delivery(o.vault)
	if err != nil {
		return control.Refused(control.CodeInternal, err.Error())
	}
	dj, err := json.Marshal(devices)
	if err != nil {
		return control.Refused(control.CodeInternal, err.Error())
	}
	mj, err := json.Marshal(o.srv.Snapshot())
	if err != nil {
		return control.Refused(control.CodeInternal, err.Error())
	}
	s := &control.Status{Vault: o.vault, Version: o.srv.Version(), StartedAt: o.started.UnixMilli(),
		URLs: nonNilList(o.urls), Health: health, Devices: dj, Metrics: mj}
	if o.index != nil {
		if s.Index, err = json.Marshal(o.index.Status()); err != nil {
			return control.Refused(control.CodeInternal, err.Error())
		}
	}
	if o.export != nil {
		if s.GitExport, err = json.Marshal(o.export.Status()); err != nil {
			return control.Refused(control.CodeInternal, err.Error())
		}
	}
	return control.Reply{Status: s}
}
