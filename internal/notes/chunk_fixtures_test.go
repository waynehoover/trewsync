package notes

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

// The chunker, pinned against the TypeScript one across the language boundary
// (PLAN M0.5 task 5).
//
// chunk-fixtures.json at the repository root holds two corpora, and each
// language checks the other's. Corpus A is cut by chunkBytes in
// client/src/core/chunk.ts and written by chunk-fixtures.run.ts; the tests here
// regenerate every input and cut it with ChunkBytes. Corpus B is defined below,
// cut by ChunkBytes and written by
//
//	go test ./internal/notes -run TestChunkFixtures -update
//
// and client/src/core/chunk-fixtures.test.ts cuts it with chunkBytes. Passing
// one's own vectors proves nothing, so the direction that matters here is A.

var update = flag.Bool("update", false, "rewrite corpusB in chunk-fixtures.json with the cuts ChunkBytes makes")

var fixturePath = filepath.Join("..", "..", "chunk-fixtures.json")

// sizesJSON is ChunkSizes as the fixture file spells it.
type sizesJSON struct {
	Min int `json:"min"`
	Avg int `json:"avg"`
	Max int `json:"max"`
}

func (s sizesJSON) sizes() ChunkSizes { return ChunkSizes{Min: s.Min, Avg: s.Avg, Max: s.Max} }

func toJSON(s ChunkSizes) sizesJSON { return sizesJSON{Min: s.Min, Avg: s.Avg, Max: s.Max} }

// generatorJSON describes an input instead of carrying it. The fields are in
// the order the TypeScript writer puts them, so that both write one format.
type generatorJSON struct {
	Kind   string   `json:"kind"`
	Length int      `json:"length"`
	Seed   string   `json:"seed,omitempty"`
	Text   string   `json:"text,omitempty"`
	Hex    string   `json:"hex,omitempty"`
	Pieces []string `json:"pieces,omitempty"`
}

// entryJSON is one fixture entry: an input, how to cut it, and where it is cut.
type entryJSON struct {
	Name        string        `json:"name"`
	Why         string        `json:"why"`
	Generator   generatorJSON `json:"generator"`
	Sizes       sizesJSON     `json:"sizes"`
	IsUTF8      bool          `json:"isUtf8"`
	InputSha256 string        `json:"inputSha256"`
	Cuts        []int         `json:"cuts"`
	Names       []string      `json:"names"`
}

// corpusJSON is one direction's entries, with who cut them and who checks them.
type corpusJSON struct {
	ProducedBy string      `json:"producedBy"`
	Regenerate string      `json:"regenerate"`
	CheckedBy  string      `json:"checkedBy"`
	Entries    []entryJSON `json:"entries"`
}

// fixtureDoc is the file's sections, in the order both writers put them. A
// section this does not know fails the decode rather than being dropped.
type fixtureDoc struct {
	Note       json.RawMessage `json:"note,omitempty"`
	Generators json.RawMessage `json:"generators,omitempty"`
	CorpusA    json.RawMessage `json:"corpusA,omitempty"`
	CorpusB    json.RawMessage `json:"corpusB,omitempty"`
	SizesForV1 json.RawMessage `json:"sizesForV1,omitempty"`
	IsTextPath json.RawMessage `json:"isTextPath,omitempty"`
}

func decodeStrict(raw []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func readDoc(t testing.TB) fixtureDoc {
	t.Helper()
	raw, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read %s: %v", fixturePath, err)
	}
	var doc fixtureDoc
	if err := decodeStrict(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", fixturePath, err)
	}
	return doc
}

func loadCorpus(t testing.TB, which string) corpusJSON {
	t.Helper()
	doc := readDoc(t)
	raw := map[string]json.RawMessage{"corpusA": doc.CorpusA, "corpusB": doc.CorpusB}[which]
	if len(raw) == 0 {
		t.Fatalf("%s has no %s section", fixturePath, which)
	}
	var c corpusJSON
	if err := decodeStrict(raw, &c); err != nil {
		t.Fatalf("parse %s: %v", which, err)
	}
	if len(c.Entries) < 20 {
		t.Fatalf("%s has %d entries, which is not a contract", which, len(c.Entries))
	}
	return c
}

// sha256Ctr is the sha256-ctr stream: SHA-256 of the seed followed by a
// big-endian 32-bit counter, one 32-byte block per counter value, in order.
type sha256Ctr struct {
	input   []byte
	counter uint32
	block   [sha256.Size]byte
	at      int
}

func newSha256Ctr(seed string) *sha256Ctr {
	c := &sha256Ctr{input: make([]byte, len(seed)+4), at: sha256.Size}
	copy(c.input, seed)
	return c
}

func (c *sha256Ctr) refill() {
	binary.BigEndian.PutUint32(c.input[len(c.input)-4:], c.counter)
	c.counter++
	c.block = sha256.Sum256(c.input)
	c.at = 0
}

func (c *sha256Ctr) next() byte {
	if c.at == sha256.Size {
		c.refill()
	}
	b := c.block[c.at]
	c.at++
	return b
}

func (c *sha256Ctr) read(out []byte) {
	for len(out) > 0 {
		if c.at == sha256.Size {
			c.refill()
		}
		n := copy(out, c.block[c.at:])
		c.at += n
		out = out[n:]
	}
}

// generate makes the input a generator describes, and refuses a description it
// does not fully understand.
func generate(g generatorJSON) ([]byte, error) {
	if g.Length < 0 {
		return nil, fmt.Errorf("length %d is not a byte count", g.Length)
	}
	switch g.Kind {
	case "sha256-ctr":
		if g.Seed == "" || g.Text != "" || g.Hex != "" || g.Pieces != nil {
			return nil, errors.New("a sha256-ctr generator takes a seed and nothing else")
		}
		out := make([]byte, g.Length)
		newSha256Ctr(g.Seed).read(out)
		return out, nil

	case "repeat":
		if g.Seed != "" || g.Pieces != nil || (g.Text == "") == (g.Hex == "") {
			return nil, errors.New("a repeat generator takes a text or a hex unit, one of them")
		}
		unit := []byte(g.Text)
		if g.Hex != "" {
			var err error
			if unit, err = hex.DecodeString(g.Hex); err != nil || hex.EncodeToString(unit) != g.Hex {
				return nil, fmt.Errorf("hex %q is not lowercase byte pairs", g.Hex)
			}
		}
		return bytes.Repeat(unit, g.Length/len(unit)+1)[:g.Length], nil

	case "mixed":
		if g.Seed == "" || g.Text != "" || g.Hex != "" || len(g.Pieces) == 0 {
			return nil, errors.New("a mixed generator takes a seed and pieces")
		}
		longest := 0
		for _, p := range g.Pieces {
			if p == "" {
				return nil, errors.New("a piece is a non-empty string")
			}
			longest = max(longest, len(p))
		}
		random := newSha256Ctr(g.Seed)
		out := make([]byte, 0, g.Length+longest)
		for len(out) < g.Length {
			// Two bytes per draw, high byte first.
			hi := random.next()
			lo := random.next()
			out = append(out, g.Pieces[(int(hi)<<8|int(lo))%len(g.Pieces)]...)
		}
		return out[:g.Length], nil
	}
	return nil, fmt.Errorf("no generator called %q", g.Kind)
}

// inputs remembers generated inputs, so that the several tests reading one
// corpus make each of its twenty-odd megabytes once.
var inputs sync.Map

func input(t testing.TB, g generatorJSON) []byte {
	t.Helper()
	key, err := json.Marshal(g)
	if err != nil {
		t.Fatal(err)
	}
	if data, ok := inputs.Load(string(key)); ok {
		return data.([]byte)
	}
	data, err := generate(g)
	if err != nil {
		t.Fatalf("generate %s: %v", key, err)
	}
	inputs.Store(string(key), data)
	return data
}

func nameOf(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// observation is where something cut an input, and the names of the chunks.
type observation struct {
	cuts  []int
	names []string
}

// observeChunkBytes cuts data with ChunkBytes and reads the result back, taking
// the names from the chunks' own bytes, so that a chunk holding the wrong bytes
// fails even when its offsets are right.
func observeChunkBytes(data []byte, sizes ChunkSizes, isUTF8 bool) (observation, error) {
	o := observation{cuts: []int{}, names: []string{}}
	end := 0
	for _, c := range ChunkBytes(data, sizes, isUTF8) {
		if c.Offset != end {
			return o, fmt.Errorf("a chunk starts at %d, not at %d", c.Offset, end)
		}
		if len(c.Bytes) == 0 {
			return o, fmt.Errorf("an empty chunk at %d", c.Offset)
		}
		end = c.Offset + len(c.Bytes)
		o.cuts = append(o.cuts, end)
		o.names = append(o.names, nameOf(c.Bytes))
	}
	if end != len(data) {
		return o, fmt.Errorf("the chunks cover %d of %d bytes", end, len(data))
	}
	return o, nil
}

// differences says where two lists first part, if they do.
func differences[T comparable](what string, fixture, here []T) []string {
	var out []string
	if len(fixture) != len(here) {
		out = append(out, fmt.Sprintf("%d %ss in the fixture, %d here", len(fixture), what, len(here)))
	}
	for i := range min(len(fixture), len(here)) {
		if fixture[i] != here[i] {
			out = append(out, fmt.Sprintf("%s %d: the fixture says %v, this side %v", what, i, fixture[i], here[i]))
			break
		}
	}
	return out
}

// checkEntry is everything wrong with an entry as Go sees it. Empty means Go
// regenerates the same input and cuts it in the same places into the same
// chunks. It is the one check every corpus test uses, including the one that
// proves a corrupted vector fails it.
func checkEntry(e entryJSON) []string {
	data, err := generate(e.Generator)
	if err != nil {
		return []string{"the generator: " + err.Error()}
	}
	var problems []string
	if got := nameOf(data); got != e.InputSha256 {
		problems = append(problems, fmt.Sprintf(
			"the generator does not reproduce the input: %d bytes hashing to %s, not %s", len(data), got, e.InputSha256))
	}
	o, err := observeChunkBytes(data, e.Sizes.sizes(), e.IsUTF8)
	if err != nil {
		return append(problems, err.Error())
	}
	problems = append(problems, differences("cut", e.Cuts, o.cuts)...)
	return append(problems, differences("name", e.Names, o.names)...)
}

// TestChunkFixturesCorpusAFromTypeScript is the check that matters: cut points
// TypeScript's chunkBytes produced, reproduced by ChunkBytes to the byte.
func TestChunkFixturesCorpusAFromTypeScript(t *testing.T) {
	c := loadCorpus(t, "corpusA")
	if !strings.HasPrefix(c.ProducedBy, "TypeScript") {
		t.Fatalf("corpusA says it was produced by %q; checking Go against Go proves nothing", c.ProducedBy)
	}
	for _, e := range c.Entries {
		t.Run(e.Name, func(t *testing.T) {
			for _, p := range checkEntry(e) {
				t.Error(p)
			}
		})
	}
}

// caseDef is one corpus B case before its cuts are known.
type caseDef struct {
	name, why string
	generator generatorJSON
	sizes     ChunkSizes
	isUTF8    bool
	// expectCuts, when not nil, is what a case exists to pin: the generator
	// refuses to write a corpus in which the case no longer does it.
	expectCuts []int
}

func ctr(seed string, n int) generatorJSON {
	return generatorJSON{Kind: "sha256-ctr", Length: n, Seed: seed}
}

func rep(text string, n int) generatorJSON {
	return generatorJSON{Kind: "repeat", Length: n, Text: text}
}

func repHex(unit string, n int) generatorJSON {
	return generatorJSON{Kind: "repeat", Length: n, Hex: unit}
}

func mix(seed string, n int, pieces []string) generatorJSON {
	return generatorJSON{Kind: "mixed", Length: n, Seed: seed, Pieces: pieces}
}

// Invisible characters are built from code points, so the source says which
// ones they are.
var (
	nbsp = string(rune(0xa0))
	zwj  = string(rune(0x200d))
	vs16 = string(rune(0xfe0f))
)

// proseB is corpus B's text: a different mix from corpus A's, with Greek,
// Cyrillic, Hebrew, Arabic, Turkish and Vietnamese two- and three-byte text,
// Chinese, Korean, Hindi and Thai, a ligature, a no-break space, emoji with a
// variation selector and a zero-width joiner, a flag, a hieroglyph, HTML that a
// careless JSON writer would escape, and three kinds of line break.
var proseB = []string{
	"lorem ", "ipsum ", "dolor ", "sit ", "amet ", "[[a link]] ", "#tag ", "> ", "<br>", "&amp; ", "|",
	"Ελληνικά ", "русский ", "עברית ", "العربية ", "Türkçe ", "tiếng Việt ", "ﬁ", "¶",
	"中文字符", "한국어", "हिन्दी ", "ไทย ", "…", nbsp,
	"😀", "🏳" + vs16 + zwj + "🌈", "𝕏", "🀄", "🇯🇵", "𓂀 ",
	"\r\n", "\n", "\n\n", "\t", "  ",
}

// oneLineB is proseB with every line break and tab taken out.
var oneLineB = slices.DeleteFunc(slices.Clone(proseB), func(p string) bool {
	return strings.ContainsAny(p, "\r\n\t")
})

// denseB is almost nothing but multi-byte characters, for sizes that cut
// constantly.
var denseB = []string{"𓂀", "🀄", "😀", "中", "ह", "ж", "é", "b", " "}

const mib = 1 << 20

var (
	// fillOnly has a maximum under the window: the hash never rolls.
	fillOnly = ChunkSizes{Min: 1, Avg: 4, Max: 30}
	// windowEdge tests boundaries at 47 and 48 bytes, while the hash is still
	// filling, and from 49, once it rolls.
	windowEdge = ChunkSizes{Min: 47, Avg: 2, Max: 55}
	// rewind has a minimum under four: bytes a trim gives back are tested for
	// a boundary again as the next chunk opens.
	rewind = ChunkSizes{Min: 1, Avg: 2, Max: 7}
	// tiny cuts malformed input every few bytes.
	tiny = ChunkSizes{Min: 5, Avg: 9, Max: 40}
	// scaled is TextSizesFor(30000), whose maximum is not a power of two.
	scaled = TextSizesFor(30000)
)

// forcedAt is what protocol 1's SizesFor gives under a ceiling of n, for n
// from 192 up: every cut forced at n.
func forcedAt(n int) ChunkSizes { return ChunkSizes{Min: n, Avg: n, Max: n} }

// corpusBCases is corpus B. Cut here, checked by TypeScript.
//
// Changing a case changes the fixture: rerun with -update, run the TypeScript
// test, and commit both. TestChunkFixturesCoverWhatTheySay holds this corpus to
// the same list of cases as corpus A, so a case that goes should be replaced by
// one doing the same job.
var corpusBCases = []caseDef{
	{name: "b-empty", why: "No bytes and no chunks.",
		generator: mix("corpus B tiny", 0, proseB), sizes: TextSizes, isUTF8: true, expectCuts: []int{}},
	{name: "b-one-byte", why: "One byte of text, which may be the first byte of a longer character.",
		generator: mix("corpus B tiny", 1, proseB), sizes: TextSizes, isUTF8: true, expectCuts: []int{1}},
	{name: "b-window-minus-one", why: "One byte short of a full window.",
		generator: mix("corpus B tiny", Window-1, proseB), sizes: TextSizes, isUTF8: true, expectCuts: []int{Window - 1}},
	{name: "b-window", why: "Exactly one window.",
		generator: mix("corpus B tiny", Window, proseB), sizes: TextSizes, isUTF8: true, expectCuts: []int{Window}},
	{name: "b-window-plus-one", why: "One byte past a window, the first that rolls.",
		generator: mix("corpus B tiny", Window+1, proseB), sizes: TextSizes, isUTF8: true, expectCuts: []int{Window + 1}},
	{name: "b-fill-phase-only", why: "A maximum under the window over incompressible bytes: every cut decided while the hash is filling.",
		generator: ctr("corpus B fill", 48), sizes: fillOnly, isUTF8: false},
	{name: "b-window-edge", why: "Boundaries tested at 47 and 48 bytes, before the roll, and from 49, after it, in text that is trimmed too.",
		generator: mix("corpus B edge", 700, proseB), sizes: windowEdge, isUTF8: true},
	{name: "b-rewind-retests-carried-bytes", why: "A minimum under four with dense multi-byte text: trimmed bytes are hashed and tested again as the next chunk opens.",
		generator: mix("corpus B rewind", 70, denseB), sizes: rewind, isUTF8: true},
	{name: "b-text-floor-sizes", why: "Multilingual prose at the floor text sizes, which TextSizesFor gives a 9 KB note.",
		generator: mix("corpus B prose", 9000, proseB), sizes: TextSizesFor(9000), isUTF8: true},
	{name: "b-text-rounds-down-at-50175", why: "Text sizes for 50175 bytes, where the average's quotient is just under 3.5: 1536.",
		generator: mix("corpus B rounding", 50175, proseB), sizes: TextSizesFor(50175), isUTF8: true},
	{name: "b-text-rounds-up-at-50176", why: "Text sizes for 50176 bytes, where the quotient is exactly 3.5 and rounds up: 2048.",
		generator: mix("corpus B rounding", 50176, proseB), sizes: TextSizesFor(50176), isUTF8: true},
	{name: "b-text-scaled-2560", why: "Text sizes scaled to a 100 KB note.",
		generator: mix("corpus B long note", 100_000, proseB), sizes: TextSizesFor(100_000), isUTF8: true},
	{name: "b-one-long-line", why: "26 KB of multilingual text with no line break in it.",
		generator: mix("corpus B one line", 26_000, oneLineB), sizes: TextSizesFor(26_000), isUTF8: true},
	{name: "b-text-on-the-byte-path", why: "Multilingual text with isUtf8 false: a cut may split a character, in the same place on both sides.",
		generator: mix("corpus B bytes", 10_000, proseB), sizes: TextSizes, isUTF8: false},
	{name: "b-binary", why: "Incompressible bytes at binary sizes.",
		generator: ctr("corpus B attachment", 5*mib/2), sizes: BinarySizes, isUTF8: false},
	{name: "b-binary-on-the-utf8-path", why: "Arbitrary bytes at binary sizes with isUtf8 true: malformed input decides every trim.",
		generator: ctr("corpus B odd note", 3*mib/2+3), sizes: BinarySizes, isUTF8: true},
	{name: "b-text-over-4-mib", why: "A .md over TEXT_AS_BINARY_ABOVE holding arbitrary bytes: binary sizes, UTF-8 rule kept, as the engine chunks it.",
		generator: ctr("corpus B huge note", TextAsBinaryAbove+1), sizes: SizesFor(TextAsBinaryAbove+1, true, mib), isUTF8: true},
	{name: "b-at-max-scaled-text", why: "Input exactly at a scaled maximum of 6144, with no boundary in it: one forced cut at the end.",
		generator: rep("x", scaled.Max), sizes: scaled, isUTF8: true, expectCuts: []int{scaled.Max}},
	{name: "b-max-plus-one-scaled-text", why: "One byte over that maximum.",
		generator: rep("x", scaled.Max+1), sizes: scaled, isUTF8: true, expectCuts: []int{scaled.Max, scaled.Max + 1}},
	{name: "b-at-max-ends-in-a-character", why: "Input exactly at max ending three bytes into a four-byte character: the forced cut backs off, and the three bytes are the remainder.",
		generator: rep("b😀", scaled.Max), sizes: scaled, isUTF8: true, expectCuts: []int{scaled.Max - 3, scaled.Max}},
	{name: "b-at-max-binary", why: "A raw chunk of exactly chunkMax: zero bytes, whose hash is zero, never end a chunk early.",
		generator: repHex("00", mib), sizes: BinarySizes, isUTF8: false, expectCuts: []int{mib}},
	{name: "b-max-plus-one-binary", why: "One byte over chunkMax.",
		generator: repHex("00", mib+1), sizes: BinarySizes, isUTF8: false, expectCuts: []int{mib, mib + 1}},
	{name: "b-forced-one-byte-into-4-byte-chars", why: "Every cut forced at 193 through four-byte characters: each lands one byte into one.",
		generator: rep("𓂀", 1000), sizes: forcedAt(193), isUTF8: true},
	{name: "b-forced-two-bytes-into-4-byte-chars", why: "Forced at 194: each lands two bytes into a four-byte character.",
		generator: rep("𓂀", 1000), sizes: forcedAt(194), isUTF8: true},
	{name: "b-forced-three-bytes-into-4-byte-chars", why: "Forced at 195: each lands three bytes into a four-byte character.",
		generator: rep("𓂀", 1000), sizes: forcedAt(195), isUTF8: true},
	{name: "b-forced-into-mixed-text", why: "Every cut forced at 192 through multilingual text, landing in characters of every width.",
		generator: mix("corpus B forced", 3000, proseB), sizes: forcedAt(192), isUTF8: true},
	{name: "b-remainder-ends-mid-character", why: "The input ends two bytes into a four-byte character. The last chunk is the remainder and is never trimmed.",
		generator: rep("𓂀", 1002), sizes: TextSizes, isUTF8: true},
	{name: "b-malformed-surrogates", why: "Encoded surrogates on the UTF-8 path: three-byte shapes to the trim.",
		generator: repHex("eda080edbfbf", 150), sizes: tiny, isUTF8: true},
	{name: "b-malformed-long-leads", why: "The five- and six-byte leads of old UTF-8, 0xF8 and 0xFC, which the trim reads as single bytes.",
		generator: repHex("f888808080fc8480808080", 220), sizes: tiny, isUTF8: true},
	{name: "b-malformed-truncations", why: "Two-, three- and four-byte characters each missing their last byte, between ASCII.",
		generator: repHex("c3e282f09f9841", 210), sizes: tiny, isUTF8: true},
}

// corpusB cuts corpus B with ChunkBytes.
func corpusB(t testing.TB) corpusJSON {
	t.Helper()
	entries := make([]entryJSON, 0, len(corpusBCases))
	for _, d := range corpusBCases {
		data := input(t, d.generator)
		o, err := observeChunkBytes(data, d.sizes, d.isUTF8)
		if err != nil {
			t.Fatalf("%s: %v", d.name, err)
		}
		if d.expectCuts != nil && !slices.Equal(d.expectCuts, o.cuts) {
			t.Fatalf("%s exists to pin cuts %v, and they are %v", d.name, d.expectCuts, o.cuts)
		}
		entries = append(entries, entryJSON{
			Name:        d.name,
			Why:         d.why,
			Generator:   d.generator,
			Sizes:       toJSON(d.sizes),
			IsUTF8:      d.isUTF8,
			InputSha256: nameOf(data),
			Cuts:        o.cuts,
			Names:       o.names,
		})
	}
	return corpusJSON{
		ProducedBy: "Go: ChunkBytes in internal/notes/chunk.go",
		Regenerate: "go test ./internal/notes -run TestChunkFixtures -update",
		CheckedBy:  "TypeScript: cd client && bunx vitest run src/core/chunk-fixtures.test.ts",
		Entries:    entries,
	}
}

// encodeJSON writes v as the TypeScript writer does, JSON.stringify(v, null,
// 2) plus a newline, when indent is set: two spaces, one value per line, and no
// HTML escaping, which Go does by default and JavaScript never does.
func encodeJSON(v any, indent bool) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if indent {
		enc.SetIndent("", "  ")
	}
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

// writeCorpusB replaces corpus B in the fixture file and leaves every other
// section as it was.
func writeCorpusB(t testing.TB, c corpusJSON) {
	t.Helper()
	doc := readDoc(t)
	raw, err := encodeJSON(c, false)
	if err != nil {
		t.Fatal(err)
	}
	doc.CorpusB = bytes.TrimRight(raw, "\n")
	out, err := encodeJSON(doc, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fixturePath, out, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote corpus B, %d entries, to %s", len(c.Entries), fixturePath)
}

// TestChunkFixturesCorpusBIsWhatGoCuts keeps corpus B current: the definitions
// above, cut by ChunkBytes today, are what the file says. With -update it
// writes them first.
func TestChunkFixturesCorpusBIsWhatGoCuts(t *testing.T) {
	want := corpusB(t)
	if *update {
		writeCorpusB(t, want)
	}
	got := loadCorpus(t, "corpusB")
	const regenerate = "regenerate with go test ./internal/notes -run TestChunkFixtures -update"
	if got.ProducedBy != want.ProducedBy || got.Regenerate != want.Regenerate || got.CheckedBy != want.CheckedBy {
		t.Errorf("the corpus B header is stale; %s", regenerate)
	}
	if len(got.Entries) != len(want.Entries) {
		t.Fatalf("the file has %d corpus B entries and the code %d; %s", len(got.Entries), len(want.Entries), regenerate)
	}
	for i := range want.Entries {
		if !reflect.DeepEqual(got.Entries[i], want.Entries[i]) {
			t.Errorf("corpus B entry %d (%s) is not what ChunkBytes cuts today; %s", i, want.Entries[i].Name, regenerate)
		}
	}
}

// cloneEntry copies an entry deeply enough to corrupt without touching the
// original.
func cloneEntry(e entryJSON) entryJSON {
	e.Cuts = slices.Clone(e.Cuts)
	e.Names = slices.Clone(e.Names)
	e.Generator.Pieces = slices.Clone(e.Generator.Pieces)
	return e
}

// TestChunkFixturesCatchACorruptedVector proves the check is not vacuous: a
// vector from corpus A with one thing changed, in memory, fails checkEntry,
// and says where.
func TestChunkFixturesCatchACorruptedVector(t *testing.T) {
	c := loadCorpus(t, "corpusA")
	i := slices.IndexFunc(c.Entries, func(e entryJSON) bool { return len(e.Cuts) >= 3 && e.Generator.Seed != "" })
	if i < 0 {
		t.Fatal("corpus A has no entry with three chunks and a seed to corrupt")
	}
	victim := c.Entries[i]
	if problems := checkEntry(victim); len(problems) != 0 {
		t.Fatalf("%s fails before it is corrupted: %v", victim.Name, problems)
	}

	for _, tc := range []struct {
		what    string
		corrupt func(e *entryJSON)
		want    string
	}{
		{"one expected offset a byte later", func(e *entryJSON) { e.Cuts[0]++ }, "cut 0:"},
		{"one expected offset a byte earlier", func(e *entryJSON) { e.Cuts[1]-- }, "cut 1:"},
		{"the last offset dropped", func(e *entryJSON) { e.Cuts = e.Cuts[:len(e.Cuts)-1] }, "cuts in the fixture"},
		{"one expected name changed", func(e *entryJSON) {
			b := []byte(e.Names[1])
			b[0] = "0123456789abcdef"[(strings.IndexByte("0123456789abcdef", b[0])+1)%16]
			e.Names[1] = string(b)
		}, "name 1:"},
		{"the generator's seed changed", func(e *entryJSON) { e.Generator.Seed += "!" }, "does not reproduce the input"},
	} {
		bad := cloneEntry(victim)
		tc.corrupt(&bad)
		problems := checkEntry(bad)
		if len(problems) == 0 {
			t.Errorf("%s with %s passes the check", victim.Name, tc.what)
			continue
		}
		if joined := strings.Join(problems, "; "); !strings.Contains(joined, tc.want) {
			t.Errorf("%s: %s was caught, but the report %q does not say %q", victim.Name, tc.what, joined, tc.want)
		}
	}
	if problems := checkEntry(victim); len(problems) != 0 {
		t.Fatalf("corrupting a copy changed the original: %v", problems)
	}
}

// isText reports whether data is valid UTF-8 apart from a character its
// generator cut off at the very end, which truncating text to a byte length
// does as often as not.
func isText(data []byte) bool {
	return utf8.Valid(data[:trimIncompleteCharacter(data, 0, len(data))])
}

// claimsOf lists what an entry demonstrably covers, read off its input, sizes
// and cuts rather than off its name or description.
func claimsOf(e entryJSON, data []byte) []string {
	var claims []string
	s := e.Sizes.sizes()
	n := len(data)
	cuts := e.Cuts
	text := isText(data)
	switch n {
	case 0, 1, Window - 1, Window, Window + 1:
		claims = append(claims, fmt.Sprintf("an input of %d bytes", n))
	}
	if s == TextSizes && len(cuts) >= 2 {
		claims = append(claims, "several chunks at the floor text sizes")
	}
	if s == TextSizesFor(int64(n)) && s != TextSizes && len(cuts) >= 2 {
		claims = append(claims, "several chunks at text sizes scaled to the file")
	}
	if s == BinarySizes && len(cuts) >= 2 {
		claims = append(claims, "several chunks at binary sizes")
	}
	if n == s.Max && slices.Equal(cuts, []int{s.Max}) {
		claims = append(claims, "an input exactly at max, cut once at its end")
	}
	if n == s.Max+1 && slices.Equal(cuts, []int{s.Max, s.Max + 1}) {
		claims = append(claims, "an input one byte over max")
	}
	if n > TextAsBinaryAbove && s == SizesFor(int64(n), true, mib) && e.IsUTF8 && len(cuts) >= 2 {
		claims = append(claims, "a text file over 4 MiB chunked with binary sizes")
	}
	// With Min equal to Max every cut is forced at Max, so a chunk that ends
	// short of it was backed off. When the byte it ends before opens a
	// four-byte character straddling Max, that is a forced cut landing that
	// many bytes into the character.
	if e.IsUTF8 && s.Min == s.Max {
		start := 0
		for _, c := range cuts[:max(len(cuts)-1, 0)] {
			if depth := start + s.Max - c; depth >= 1 && depth <= 3 && data[c]&0xf8 == 0xf0 {
				claims = append(claims, fmt.Sprintf("a forced cut %d byte(s) into a four-byte character", depth))
			}
			start = c
		}
	}
	if e.IsUTF8 && !text && len(cuts) >= 2 {
		claims = append(claims, "malformed UTF-8 on the UTF-8 path")
	}
	if !e.IsUTF8 && text && slices.ContainsFunc(cuts[:max(len(cuts)-1, 0)], func(c int) bool { return data[c]&0xc0 == 0x80 }) {
		claims = append(claims, "a character split on the byte path")
	}
	if text && bytes.Contains(data, []byte("\r\n")) && len(cuts) >= 2 {
		claims = append(claims, "text with CRLF line breaks")
	}
	if e.Generator.Kind == "mixed" && text && bytes.IndexByte(data, '\n') < 0 && n > 2*s.Max {
		claims = append(claims, "a multilingual line longer than two chunks")
	}
	if s.Min < Window && len(cuts) >= 3 {
		claims = append(claims, "boundaries decided while the hash is still filling")
	}
	if e.IsUTF8 && s.Min < 4 && len(cuts) >= 10 {
		claims = append(claims, "a minimum under four, where trimmed bytes are tested again")
	}
	if e.IsUTF8 && len(cuts) > 0 {
		last := 0
		if len(cuts) > 1 {
			last = cuts[len(cuts)-2]
		}
		if trimIncompleteCharacter(data, last, n) < n {
			claims = append(claims, "a remainder that ends mid-character and is kept whole")
		}
	}
	slices.Sort(claims)
	return slices.Compact(claims)
}

// TestChunkFixturesCoverWhatTheySay holds each corpus to the cases PLAN M0.5
// task 5 names, and a few more, so that regenerating one cannot quietly drop
// the case that would have caught a disagreement.
func TestChunkFixturesCoverWhatTheySay(t *testing.T) {
	required := []string{
		"an input of 0 bytes",
		"an input of 1 bytes",
		fmt.Sprintf("an input of %d bytes", Window-1),
		fmt.Sprintf("an input of %d bytes", Window),
		fmt.Sprintf("an input of %d bytes", Window+1),
		"several chunks at the floor text sizes",
		"several chunks at text sizes scaled to the file",
		"several chunks at binary sizes",
		"an input exactly at max, cut once at its end",
		"an input one byte over max",
		"a forced cut 1 byte(s) into a four-byte character",
		"a forced cut 2 byte(s) into a four-byte character",
		"a forced cut 3 byte(s) into a four-byte character",
		"a text file over 4 MiB chunked with binary sizes",
		"malformed UTF-8 on the UTF-8 path",
		"a character split on the byte path",
		"text with CRLF line breaks",
		"a multilingual line longer than two chunks",
		"boundaries decided while the hash is still filling",
		"a minimum under four, where trimmed bytes are tested again",
		"a remainder that ends mid-character and is kept whole",
	}
	for _, which := range []string{"corpusA", "corpusB"} {
		t.Run(which, func(t *testing.T) {
			c := loadCorpus(t, which)
			covered := map[string][]string{}
			for _, e := range c.Entries {
				for _, claim := range claimsOf(e, input(t, e.Generator)) {
					covered[claim] = append(covered[claim], e.Name)
				}
			}
			for _, claim := range required {
				if len(covered[claim]) == 0 {
					t.Errorf("%s no longer covers %s", which, claim)
					continue
				}
				t.Logf("%s: %s", claim, strings.Join(covered[claim], ", "))
			}
		})
	}
}

// mutation is one plausible way to port chunk.ts wrong.
type mutation int

const (
	faithful mutation = iota
	signedRemainder
	residueZero
	rollOneByteLate
	noHashReset
	windowHashEverywhere
	forcedCutPastMax
	noTrim
	extendOverCharacter
	noRewind
	trimRemainder
)

// mutantCuts is ChunkBytes rewritten with one switchable defect, to measure the
// corpora rather than to test ChunkBytes: each mutation is a mistake a port
// could make and still pass most sensible tests. With faithful it must cut
// every entry exactly as the fixture says, or its mutants prove nothing.
func mutantCuts(data []byte, s ChunkSizes, isUTF8 bool, m mutation) []int {
	cuts := []int{}
	pPowW := uint32(1)
	for range Window - 1 {
		pPowW *= prime
	}
	start := 0
	var hash uint32
	for pos := 0; pos < len(data); pos++ {
		b := uint32(data[pos])
		roll := pos >= start+Window
		if m == rollOneByteLate {
			roll = pos > start+Window
		}
		switch {
		case m == windowHashEverywhere:
			// A hash of the Window bytes ending here, wherever this chunk
			// began: the natural sliding window, which never restarts.
			hash = 0
			for _, x := range data[max(0, pos-Window+1) : pos+1] {
				hash = hash*prime + uint32(x)
			}
		case roll:
			hash -= uint32(data[pos-Window]) * pPowW
			hash = hash*prime + b
		default:
			hash = hash*prime + b
		}

		var hit bool
		switch m {
		case signedRemainder:
			// hash % avg without the `>>> 0`, as a signed 32-bit value.
			hit = s.Avg > 0 && int32(hash)%int32(s.Avg) == boundaryResidue
		case residueZero:
			hit = s.Avg > 0 && uint64(hash)%uint64(s.Avg) == 0
		default:
			hit = atBoundary(hash, s.Avg)
		}
		size := pos - start + 1
		forced := size >= s.Max
		if m == forcedCutPastMax {
			forced = size > s.Max
		}
		if !forced && !(size >= s.Min && hit) {
			continue
		}

		end := pos + 1
		if isUTF8 {
			switch m {
			case noTrim:
			case extendOverCharacter:
				// Keep the character whole by finishing it instead.
				if lead := trimIncompleteCharacter(data, start, end); lead < end {
					end = min(lead+sequenceLength(data[lead]), len(data))
				}
			default:
				end = trimIncompleteCharacter(data, start, end)
			}
		}
		cuts = append(cuts, end)
		start = end
		if m != noHashReset {
			hash = 0
		}
		if m != noRewind {
			pos = end - 1
		}
	}
	if start < len(data) {
		if m == trimRemainder && isUTF8 {
			if end := trimIncompleteCharacter(data, start, len(data)); end < len(data) {
				cuts = append(cuts, end)
			}
		}
		cuts = append(cuts, len(data))
	}
	return cuts
}

// sequenceLength is how long trimIncompleteCharacter takes a sequence opened by
// b to be.
func sequenceLength(b byte) int {
	switch {
	case b&0xe0 == 0xc0:
		return 2
	case b&0xf0 == 0xe0:
		return 3
	case b&0xf8 == 0xf0:
		return 4
	}
	return 1
}

// TestChunkFixturesCatchPortingMistakes shows both corpora have teeth: every
// mistake in the list moves at least one cut in each, so a port making it
// could not pass. Corpus A catching them is what stops a Go port that is wrong
// in these ways; corpus B catching them is what makes the TypeScript side's
// check of it worth running.
func TestChunkFixturesCatchPortingMistakes(t *testing.T) {
	mistakes := []struct {
		m    mutation
		what string
	}{
		{signedRemainder, "reading the hash as signed before the remainder"},
		{residueZero, "the wrong residue"},
		{rollOneByteLate, "starting to roll one byte late"},
		{noHashReset, "not restarting the hash at a cut"},
		{windowHashEverywhere, "a sliding window that ignores where the chunk began"},
		{forcedCutPastMax, "forcing the cut one byte past max"},
		{noTrim, "ignoring UTF-8"},
		{extendOverCharacter, "finishing a character instead of backing off it"},
		{noRewind, "not rehashing the bytes a trim gave back"},
		{trimRemainder, "trimming the last chunk too"},
	}
	for _, which := range []string{"corpusA", "corpusB"} {
		t.Run(which, func(t *testing.T) {
			c := loadCorpus(t, which)
			for _, e := range c.Entries {
				if got := mutantCuts(input(t, e.Generator), e.Sizes.sizes(), e.IsUTF8, faithful); !slices.Equal(got, e.Cuts) {
					t.Fatalf("the faithful rewrite disagrees with %s, so its mutants would prove nothing", e.Name)
				}
			}
			for _, mistake := range mistakes {
				i := slices.IndexFunc(c.Entries, func(e entryJSON) bool {
					return !slices.Equal(mutantCuts(input(t, e.Generator), e.Sizes.sizes(), e.IsUTF8, mistake.m), e.Cuts)
				})
				if i < 0 {
					t.Errorf("no entry in %s catches %s", which, mistake.what)
					continue
				}
				t.Logf("%s catches %s first at %s", which, mistake.what, c.Entries[i].Name)
			}
		})
	}
}

// TestSizesForV1Fixtures checks SizesFor against the sizesForV1 table in
// chunk-fixtures.json, which was computed from the protocol 1 rule's statement
// rather than from either implementation.
//
// The TypeScript side adopts these cases in M2 task 2, when sizesFor drops
// SEAL_OVERHEAD. Until then chunk-fixtures.test.ts checks them against its
// sizesFor with the overhead handed back.
func TestSizesForV1Fixtures(t *testing.T) {
	var table struct {
		Note  []string `json:"note"`
		Cases []struct {
			Name           string    `json:"name"`
			Size           int64     `json:"size"`
			IsText         bool      `json:"isText"`
			ServerChunkMax int64     `json:"serverChunkMax"`
			Expected       sizesJSON `json:"expected"`
		} `json:"cases"`
	}
	if err := decodeStrict(readDoc(t).SizesForV1, &table); err != nil {
		t.Fatalf("parse sizesForV1: %v", err)
	}
	if len(table.Cases) < 20 {
		t.Fatalf("sizesForV1 has only %d cases", len(table.Cases))
	}
	for _, c := range table.Cases {
		if got := SizesFor(c.Size, c.IsText, c.ServerChunkMax); got != c.Expected.sizes() {
			t.Errorf("%s: SizesFor(%d, %v, %d) = %+v, want %+v", c.Name, c.Size, c.IsText, c.ServerChunkMax, got, c.Expected.sizes())
		}
	}
}

// TestIsTextPathFixtures checks IsTextPath against the cases looksLikeText is
// checked against, and the extension list against the one chunk.ts exports.
func TestIsTextPathFixtures(t *testing.T) {
	var table struct {
		Note           []string `json:"note"`
		TextExtensions []string `json:"textExtensions"`
		Cases          []struct {
			Path   string `json:"path"`
			IsText bool   `json:"isText"`
		} `json:"cases"`
	}
	if err := decodeStrict(readDoc(t).IsTextPath, &table); err != nil {
		t.Fatalf("parse isTextPath: %v", err)
	}
	ours := make([]string, 0, len(textExtensions))
	for ext := range textExtensions {
		ours = append(ours, ext)
	}
	slices.Sort(ours)
	theirs := slices.Sorted(slices.Values(table.TextExtensions))
	if !slices.Equal(ours, theirs) {
		t.Errorf("Go lists %v and the fixture %v", ours, theirs)
	}
	for _, c := range table.Cases {
		if got := IsTextPath(c.Path); got != c.IsText {
			t.Errorf("IsTextPath(%q) = %v, want %v", c.Path, got, c.IsText)
		}
	}
}
