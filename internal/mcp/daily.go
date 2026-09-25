package mcp

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/waynehoover/trew/internal/notes"
	"github.com/waynehoover/trew/internal/paths"
	"github.com/waynehoover/trew/internal/store"
)

// The daily-note and template tools (plan/ideas.md, "Daily-note and template
// tools"): today_note, append_to_daily and create_from_template, on top of
// the same exclusive create and conditional rewrite create_note and
// append_note commit through. None needs a preview: each writes exactly what
// it says, a new note from a template or text added to one note, and an
// append commits only if the note is still the version it read.
//
// Obsidian keeps its daily-note settings in .obsidian/daily-notes.json and its
// template settings in .obsidian/templates.json, and a dot path never syncs,
// so the server cannot read them. The operator gives them to `trewd serve`
// instead (Conventions, from the -daily-* and -template* flags), and an agent
// may override the daily folder, format and template per call.

// Conventions are the vault's daily-note and template settings as the server
// holds them. The zero value is Obsidian's defaults: daily notes named
// YYYY-MM-DD in the vault's root with no template, templates in "Templates",
// {{date}} as YYYY-MM-DD and {{time}} as HH:mm, in the server's local time
// zone.
type Conventions struct {
	// DailyFolder is where daily notes are, "" for the vault's root.
	DailyFolder string
	// DailyFormat names a daily note: a moment.js date format
	// (notes.FormatDate), which may hold "/" to file notes in folders.
	DailyFormat string
	// DailyTemplate is the vault path of the note a new daily note is made
	// from, .md added when it has no extension; "" for an empty note.
	DailyTemplate string
	// TemplatesFolder is the folder create_from_template finds templates in.
	TemplatesFolder string
	// DateFormat and TimeFormat are what {{date}} and {{time}} write.
	DateFormat, TimeFormat string
	// Location is the time zone "today" and {{time}} are read in; nil is
	// the server's local zone.
	Location *time.Location
}

// SetConventions replaces the daily-note and template settings the tools use,
// from the next call on: what `trewd config set daily.*` does to a running
// server. The caller has checked them (Conventions.Check).
func (h *Handler) SetConventions(c Conventions) {
	h.convMu.Lock()
	h.conventions = c.withDefaults()
	h.convMu.Unlock()
}

// Conventions are the settings the tools use now.
func (h *Handler) Conventions() Conventions {
	h.convMu.Lock()
	defer h.convMu.Unlock()
	return h.conventions
}

// DefaultTemplatesFolder is where templates are when nothing says otherwise.
const DefaultTemplatesFolder = "Templates"

func (c Conventions) withDefaults() Conventions {
	if c.DailyFormat == "" {
		c.DailyFormat = notes.DefaultDailyFormat
	}
	if c.TemplatesFolder == "" {
		c.TemplatesFolder = DefaultTemplatesFolder
	}
	if c.DateFormat == "" {
		c.DateFormat = notes.DefaultDateFormat
	}
	if c.TimeFormat == "" {
		c.TimeFormat = notes.DefaultTimeFormat
	}
	if c.Location == nil {
		c.Location = time.Local
	}
	return c
}

// Check refuses settings the tools could never use, for `trewd serve` to
// report before it starts: a folder or template path the path rules refuse,
// or a date format notes.FormatDate cannot write, or one that names a daily
// note the path rules refuse.
func (c Conventions) Check() error { return c.CheckNamed(func(flag string) string { return flag }) }

// CheckNamed is Check with each setting named by name(flag): the flag, or
// the configuration key it came from.
func (c Conventions) CheckNamed(name func(flag string) string) error {
	c = c.withDefaults()
	for _, f := range []struct{ flag, value string }{{"-daily-folder", c.DailyFolder},
		{"-templates-folder", c.TemplatesFolder}, {"-daily-template", c.DailyTemplate}} {
		if f.value == "" {
			continue
		}
		if r := paths.Check(withNoteExtension(f.value)); r != "" {
			return fmt.Errorf("%s %q: %s: the server refuses this path", name(f.flag), f.value, r)
		}
	}
	for _, f := range []struct{ flag, value string }{{"-daily-format", c.DailyFormat},
		{"-template-date-format", c.DateFormat}, {"-template-time-format", c.TimeFormat}} {
		if err := notes.CheckDateFormat(f.value); err != nil {
			return fmt.Errorf("%s %q: %s", name(f.flag), f.value, toolError(err).Message)
		}
	}
	if _, err := c.dailyPath(time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)); err != nil {
		return fmt.Errorf("%s %q: %s", name("-daily-format"), c.DailyFormat, toolError(err).Message)
	}
	return nil
}

// withNoteExtension is p, with .md added when it ends in neither .md nor
// .txt, as Obsidian names a template or a daily note.
func withNoteExtension(p string) string {
	lower := strings.ToLower(p)
	if strings.HasSuffix(lower, ".md") || strings.HasSuffix(lower, ".txt") {
		return p
	}
	return p + ".md"
}

func joinVault(folder, name string) string {
	if folder == "" {
		return name
	}
	return folder + "/" + name
}

// dailyPath is the daily note of day: the folder, and the day in the format,
// as a Markdown note.
func (c Conventions) dailyPath(day time.Time) (string, error) {
	name, err := notes.FormatDate(day, c.DailyFormat)
	if err != nil {
		return "", err
	}
	path := joinVault(c.DailyFolder, name+".md")
	if te := newNotePath(path, "the daily note's path"); te != nil {
		return "", te
	}
	return path, nil
}

// newNotePath is the check args.writable makes of a path a call creates, for
// a path the server computes: the path rules, an editable format, and not a
// reserved name.
func newNotePath(p, what string) *ToolError {
	switch r := paths.Check(p); {
	case r == paths.ReasonStaging:
		return &ToolError{Code: "reserved_name", Message: what + " holds " + paths.StagingMark}
	case r != "":
		return &ToolError{Code: "badpath", Message: what + ": " + string(r) + ": the server refuses this path"}
	case !paths.MCPEditable(p):
		return &ToolError{Code: "unsupported_format", Message: what + " is not a Markdown or plain-text note"}
	case paths.ConflictCopy(p):
		return &ToolError{Code: "reserved_name", Message: what + " is shaped like a conflict copy"}
	}
	return nil
}

// dailyArgs are the arguments today_note and append_to_daily share: the day,
// and the conventions overridden for this call.
type dailyArgs struct {
	conv Conventions
	day  time.Time
	path string
}

func (c *call) dailyArgs(a *args) (dailyArgs, *ToolError) {
	d := dailyArgs{conv: c.h.Conventions()}
	date, _ := a.text("date", 32)
	if folder, present := a.text("folder", paths.MaxPathBytes); present {
		if folder != "" {
			if r := paths.Check(folder); r != "" {
				a.refuse(&ToolError{Code: "badpath", Message: "folder: " + string(r) + ": the server refuses this path"})
			}
		}
		d.conv.DailyFolder = folder
	}
	if format, present := a.text("format", notes.MaxFormatBytes); present {
		d.conv.DailyFormat = format
	}
	if template, present := a.text("template", paths.MaxPathBytes); present {
		d.conv.DailyTemplate = template
	}
	if a.fail != nil {
		return d, nil
	}
	if err := notes.CheckDateFormat(d.conv.DailyFormat); err != nil {
		return d, toolError(err)
	}
	day, err := notes.ParseDay(date, c.h.now(), d.conv.Location)
	if err != nil {
		return d, toolError(err)
	}
	d.day = day
	if d.path, err = d.conv.dailyPath(day); err != nil {
		return d, toolError(err)
	}
	return d, nil
}

// dailyTemplate is the vault path of d's template, or "".
func (d dailyArgs) template() string {
	if d.conv.DailyTemplate == "" {
		return ""
	}
	return withNoteExtension(d.conv.DailyTemplate)
}

// templateText is the template note at path, as text: a live note an agent
// may read, at most 1 MiB, in UTF-8.
func (c *call) templateText(path, what string) (string, error) {
	if r := paths.Check(path); r != "" {
		return "", &ToolError{Code: "badpath", Message: what + ": " + string(r) + ": the server refuses this path"}
	}
	if err := c.readable(path); err != nil {
		return "", err
	}
	e, err := c.headNote(path)
	if err != nil {
		var te *ToolError
		if errors.As(err, &te) && te.Code == "not_found" {
			return "", &ToolError{Code: "not_found", Message: what + " is not a note in the vault", Path: path}
		}
		return "", err
	}
	b, err := c.versionBytes(e)
	if err != nil {
		return "", err
	}
	return notes.DecodeNote(b)
}

// dailyBody is a new daily note's text: its template filled for its day, or
// nothing.
func (c *call) dailyBody(d dailyArgs) (string, error) {
	tpl := d.template()
	if tpl == "" {
		return "", nil
	}
	source, err := c.templateText(tpl, "the daily template")
	if err != nil {
		return "", err
	}
	return notes.RenderTemplate(source, c.templateValues(d.conv, d.path, d.day))
}

func (c *call) templateValues(conv Conventions, path string, date time.Time) notes.Template {
	now := c.h.now().In(conv.Location)
	return notes.Template{Title: notes.Title(path), Date: date, Now: now, DateFormat: conv.DateFormat,
		TimeFormat: conv.TimeFormat}
}

// dailyFacts are what today_note and append_to_daily say under trusted
// besides a commit's facts: the note's path and day, the conventions that
// named it, and whether this call made it.
type dailyFacts struct {
	Path     string `json:"path"`
	Date     string `json:"date"`
	Folder   string `json:"folder"`
	Format   string `json:"format"`
	Template string `json:"template"`
	Created  bool   `json:"created"`
}

func (d dailyArgs) facts(created bool) dailyFacts {
	return dailyFacts{Path: d.path, Date: d.day.Format("2006-01-02"), Folder: d.conv.DailyFolder,
		Format: d.conv.DailyFormat, Template: d.template(), Created: created}
}

func (d dailyArgs) render(created bool) func(store.OpResult) (any, any) {
	return func(r store.OpResult) (any, any) {
		return struct {
			CommitFacts
			dailyFacts
		}{committedFacts(r), d.facts(created)}, entries{entryRows(r)}
	}
}

func dailyTools() []*Tool {
	dailyProps := func(props map[string]schema) map[string]schema {
		props["date"] = textProp(32, "the day: YYYY-MM-DD, today, yesterday or tomorrow, in the server's time zone; today by default")
		props["folder"] = textProp(paths.MaxPathBytes, "the daily notes' folder for this call, \"\" for the vault's "+
			"root; the server's setting by default")
		props["format"] = textProp(notes.MaxFormatBytes, "the daily note's name as a moment.js date format for this "+
			"call, such as YYYY-MM-DD; the server's setting by default")
		props["template"] = textProp(paths.MaxPathBytes, "the vault path of the note a new daily note is made "+
			"from, for this call; the server's setting by default")
		props["epoch"] = optionalEpochProp
		props["idempotencyKey"] = keyProp
		return props
	}
	return []*Tool{
		{
			Name: "today_note", Title: "Today's daily note", Scope: store.ScopeWrite, Additive: true,
			Description: "Find a day's daily note by the vault's daily-note settings (folder, date format, " +
				"template), which the server holds because Obsidian's never sync. It says the note's path and, " +
				"when it exists, its uid to read it or pass as base. With create, a missing note is created from " +
				"the daily template, with {{date}} as that day; an existing one is never changed." + resultSentence,
			Input: object(nil, dailyProps(map[string]schema{
				"create": boolProp("create the note if it does not exist, false by default"),
			})),
			Run: todayNote,
		},
		{
			Name: "append_to_daily", Title: "Append to a daily note", Scope: store.ScopeWrite, Additive: true,
			Description: "Add text to a day's daily note, on lines of its own, creating the note from the daily " +
				"template first unless create is false. With heading, the text goes at the end of that heading's " +
				"section, before the next heading of the same or a higher level: heading is one ATX heading line " +
				"exactly as the note has it, no_match if it has none and ambiguous_edit if it has several. No base " +
				"is needed: the text is added to the version the server reads, and committed only if that is " +
				"still the note's head (stale otherwise, and nothing is written)." + resultSentence,
			Input: object([]string{"text"}, dailyProps(map[string]schema{
				"text":    textProp(notes.InputBytes, "the text to add, at most 64 KiB, written as given"),
				"heading": textProp(1024, "an ATX heading line of the note, such as \"## Log\", to add the text under"),
				"create":  boolProp("create the note from the daily template when it does not exist, true by default"),
				"base":    intProp(1, maxSafe, "optional: refuse with stale unless the note's head is this uid"),
			})),
			Run: appendToDaily,
		},
		{
			Name: "create_from_template", Title: "Create a note from a template", Scope: store.ScopeWrite,
			Additive: true,
			Description: "Create a note at a path that holds nothing from a template: a note in the templates " +
				"folder, named with or without .md. Obsidian's {{title}}, {{date}}, {{time}}, {{date:FORMAT}} and " +
				"{{time:FORMAT}} are filled in, and {{name}} for each of variables; any other {{...}} is left as " +
				"it is. It never replaces anything: an occupied path is refused with exists." + resultSentence,
			Input: object([]string{"template", "path"}, map[string]schema{
				"template": textProp(paths.MaxPathBytes, "the template's name within the templates folder"),
				"path":     textProp(paths.MaxPathBytes, "the new note's path in the vault, ending .md or .txt"),
				"variables": schema{"type": "object", "maxProperties": maxVariables,
					"propertyNames":        schema{"pattern": notes.VariableName.String()},
					"additionalProperties": schema{"type": "string", "maxLength": notes.EditBytes},
					"description":          "values for {{name}} placeholders, other than date, time and title"},
				"epoch":          optionalEpochProp,
				"idempotencyKey": keyProp,
			}),
			Run: createFromTemplate,
		},
	}
}

// maxVariables bounds a template's variables, each value at most
// notes.EditBytes, all of them within notes.InputBytes.
const maxVariables = 32

func todayNote(c *call, a *args) outcome {
	d, te := c.dailyArgs(a)
	create := a.boolean("create", false)
	epoch := a.epoch(false)
	key := a.idempotencyKey()
	if err := a.finish(); err != nil {
		return c.failWrite(err)
	}
	if te != nil {
		return c.failWrite(te)
	}
	if !create {
		obs, err := c.observe()
		if err != nil {
			return c.failWrite(err)
		}
		return c.dailyLookup(d, obs)
	}
	m, o, done := c.begin(a, key, epoch, d.path, d.template())
	if done {
		return o
	}
	e, state, _, err := c.h.st.EntryAsOf(c.h.vault, d.path, 0)
	switch {
	case err != nil:
		return m.failed(err)
	case state == store.PathLive && e.Folder:
		uid := e.UID
		return m.fail(&ToolError{Code: "exists", Message: "a folder is at the daily note's path", Path: d.path, CurrentUID: &uid})
	case state == store.PathLive:
		obs, err := c.observe()
		if err != nil {
			return m.failed(err)
		}
		return c.dailyLookup(d, obs)
	}
	body, err := c.dailyBody(d)
	if err != nil {
		return m.failed(err)
	}
	content, err := notes.NoteContent(body)
	if err != nil {
		return m.failed(err)
	}
	return m.createWith(d.path, content, d.render(true))
}

// dailyLookup is today_note's answer without a write: where the note is, and
// what is there.
func (c *call) dailyLookup(d dailyArgs, obs Observed) outcome {
	out := struct {
		dailyFacts
		Exists bool   `json:"exists"`
		UID    *int64 `json:"uid"`
		Size   *int64 `json:"size,omitempty"`
		Observed
	}{dailyFacts: d.facts(false), Observed: obs}
	e, state, _, err := c.h.st.EntryAsOf(c.h.vault, d.path, 0)
	if err != nil {
		return c.failWrite(err)
	}
	if state == store.PathLive && !e.Folder {
		uid, size := e.UID, e.Size
		out.Exists, out.UID, out.Size = true, &uid, &size
	}
	return c.ok(out, nil)
}

func appendToDaily(c *call, a *args) outcome {
	d, te := c.dailyArgs(a)
	t, hasText := a.text("text", notes.InputBytes)
	heading, hasHeading := a.text("heading", 1024)
	create := a.boolean("create", true)
	base := a.uid("base", false)
	epoch := a.epoch(base != 0)
	key := a.idempotencyKey()
	if err := a.finish(); err != nil {
		return c.failWrite(err)
	}
	if te != nil {
		return c.failWrite(te)
	}
	if !hasText {
		return c.failWrite(invalidArguments("text is required"))
	}
	if hasHeading {
		if err := notes.CheckHeading(heading); err != nil {
			return c.failWrite(err)
		}
	}
	change := func(b []byte) (notes.Revision, error) {
		if hasHeading {
			return notes.AppendUnderHeading(b, heading, t)
		}
		return notes.AppendLines(b, t)
	}
	m, o, done := c.begin(a, key, epoch, d.path, d.template())
	if done {
		return o
	}
	e, state, movedAt, err := c.h.st.EntryAsOf(c.h.vault, d.path, 0)
	if err != nil {
		return m.failed(err)
	}
	current := e.UID
	if state == store.PathMoved {
		current = movedAt
	}
	switch {
	case base != 0 && base != current:
		return m.fail(&ToolError{Code: "stale", Message: "the note changed since that base; read it again and reconsider",
			Path: d.path, CurrentUID: &current})
	case state == store.PathLive && e.Folder:
		return m.fail(&ToolError{Code: "exists", Message: "a folder is at the daily note's path", Path: d.path,
			CurrentUID: &current})
	case state == store.PathLive:
		return m.rewriteWith(d.path, e.UID, change, d.render(false))
	case !create:
		return m.fail(&ToolError{Code: "not_found", Message: "the day has no daily note, and create is false", Path: d.path})
	case base != 0:
		return m.fail(&ToolError{Code: "stale", Message: "the note named by base is no longer there", Path: d.path,
			CurrentUID: &current})
	}
	body, err := c.dailyBody(d)
	if err != nil {
		return m.failed(err)
	}
	rev, err := change([]byte(body))
	if err != nil {
		return m.failed(err)
	}
	return m.createWith(d.path, rev.Bytes, d.render(true))
}

// variables is a template's variables: an object of at most maxVariables
// strings, each named as notes.VariableName allows and none of date, time or
// title, each value text(notes.EditBytes), all of them within
// notes.InputBytes.
func (a *args) variables(key string) map[string]string {
	raw := a.take(key)
	if raw == nil {
		return nil
	}
	if raw[0] != '{' {
		a.refuse(invalidArguments(key + " must be an object of strings"))
		return nil
	}
	fields, err := objectFields(raw)
	if err != nil {
		a.refuse(invalidArguments(key + " is not a valid object: " + err.Error()))
		return nil
	}
	if len(fields) > maxVariables {
		a.refuse(invalidArguments(fmt.Sprintf("%s holds at most %d variables", key, maxVariables)))
		return nil
	}
	out := map[string]string{}
	total := 0
	for name, value := range fields {
		where := key + "." + name
		if !notes.VariableName.MatchString(name) {
			a.refuse(invalidArguments(key + ": a variable's name is 1 to 64 letters, digits, _ or -"))
			return nil
		}
		if notes.ReservedVariable(name) {
			a.refuse(invalidArguments(where + ": date, time and title are filled by the server"))
			return nil
		}
		s, te := jsonText(value)
		if te != nil {
			te.Message = where + ": " + te.Message
			a.refuse(te)
			return nil
		}
		if len(s) > notes.EditBytes {
			a.refuse(&ToolError{Code: "input_too_large", Message: fmt.Sprintf("%s is %d bytes, and at most %d are accepted",
				where, len(s), notes.EditBytes)})
			return nil
		}
		total += len(s)
		out[name] = s
	}
	if total > notes.InputBytes {
		a.refuse(&ToolError{Code: "input_too_large", Message: key + " holds more than 64 KiB of text"})
		return nil
	}
	return out
}

func createFromTemplate(c *call, a *args) outcome {
	name, hasName := a.text("template", paths.MaxPathBytes)
	path := a.writable("path", true, newNote)
	vars := a.variables("variables")
	epoch := a.epoch(false)
	key := a.idempotencyKey()
	if err := a.finish(); err != nil {
		return c.failWrite(err)
	}
	if !hasName || name == "" {
		return c.failWrite(invalidArguments("template is required"))
	}
	conv := c.h.Conventions()
	tpl := joinVault(conv.TemplatesFolder, withNoteExtension(strings.TrimPrefix(name, conv.TemplatesFolder+"/")))
	m, o, done := c.begin(a, key, epoch, path, tpl)
	if done {
		return o
	}
	source, err := c.templateText(tpl, "the template")
	if err != nil {
		return m.failed(err)
	}
	values := c.templateValues(conv, path, c.h.now().In(conv.Location))
	values.Variables = vars
	body, err := notes.RenderTemplate(source, values)
	if err != nil {
		return m.failed(err)
	}
	content, err := notes.NoteContent(body)
	if err != nil {
		return m.failed(err)
	}
	return m.createWith(path, content, func(r store.OpResult) (any, any) {
		return struct {
			CommitFacts
			Path     string `json:"path"`
			Template string `json:"template"`
		}{committedFacts(r), path, tpl}, entries{entryRows(r)}
	})
}
