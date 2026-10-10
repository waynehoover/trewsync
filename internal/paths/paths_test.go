package paths

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// contract is the part of protocol-fixtures.json this package answers to. The
// vectors come from scripts/protocol-vectors.py, not from this package, and
// the TypeScript client reads the same file (PLAN.md M0.5 task 6).
type contract struct {
	Constants struct {
		StagingMark     string `json:"stagingMark"`
		MaxPathBytes    int    `json:"maxPathBytes"`
		MaxSegmentBytes int    `json:"maxSegmentBytes"`
	} `json:"constants"`
	Fold struct {
		UnicodeVersion string `json:"unicodeVersion"`
		TableDigest    string `json:"tableDigest"`
		TableSize      int    `json:"tableSize"`
		Vectors        []struct {
			Input string `json:"input"`
			Fold  string `json:"fold"`
		} `json:"vectors"`
	} `json:"fold"`
	Paths struct {
		Cases []pathCase `json:"cases"`
	} `json:"paths"`
	Config struct {
		Cases []struct {
			Name     string  `json:"name"`
			Hex      string  `json:"hex"`
			IsConfig bool    `json:"isConfig"`
			Notes    *string `json:"notes"`
			Config   *string `json:"config"`
		} `json:"cases"`
	} `json:"config"`
	Collisions struct {
		Scenarios []scenario `json:"scenarios"`
	} `json:"collisions"`
	Formats struct {
		TextExtensions []string `json:"textExtensions"`
		Samples        []struct {
			Path         string `json:"path"`
			Syncable     bool   `json:"syncable"`
			ChunkingText bool   `json:"chunkingText"`
			Searchable   bool   `json:"searchable"`
			MCPReadable  bool   `json:"mcpReadable"`
			MCPEditable  bool   `json:"mcpEditable"`
		} `json:"samples"`
	} `json:"formats"`
}

type pathCase struct {
	Name   string  `json:"name"`
	Hex    string  `json:"hex"`
	Valid  bool    `json:"valid"`
	Reason *string `json:"reason"`
}

type scenario struct {
	Name string `json:"name"`
	Live []struct {
		Path   string `json:"path"`
		Folder bool   `json:"folder"`
	} `json:"live"`
	Op struct {
		Type   string `json:"type"`
		Path   string `json:"path"`
		Prev   string `json:"prev"`
		Folder bool   `json:"folder"`
	} `json:"op"`
	Expect string `json:"expect"`
}

func load(t *testing.T) contract {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "protocol-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var c contract
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	if len(c.Paths.Cases) < 20 || len(c.Collisions.Scenarios) < 15 || len(c.Fold.Vectors) < 10 {
		t.Fatalf("the contract sections are nearly empty (%d paths, %d scenarios, %d fold vectors), "+
			"which is not a contract; regenerate with scripts/protocol-vectors.py",
			len(c.Paths.Cases), len(c.Collisions.Scenarios), len(c.Fold.Vectors))
	}
	return c
}

func TestTheConstantsAreTheContracts(t *testing.T) {
	c := load(t)
	if StagingMark != c.Constants.StagingMark {
		t.Errorf("StagingMark is %q and the contract says %q", StagingMark, c.Constants.StagingMark)
	}
	if MaxSegmentBytes != c.Constants.MaxSegmentBytes {
		t.Errorf("MaxSegmentBytes is %d and the contract says %d", MaxSegmentBytes, c.Constants.MaxSegmentBytes)
	}
	if MaxPathBytes != c.Constants.MaxPathBytes {
		t.Errorf("MaxPathBytes is %d and the contract says %d", MaxPathBytes, c.Constants.MaxPathBytes)
	}
}

// The table's canonical form, as the generator and TypeScript compute it:
// "XXXX:YYYY ZZZZ\n", uppercase hex of at least four digits, by source.
func tableDigest(table map[rune]string) string {
	keys := make([]rune, 0, len(table))
	for r := range table {
		keys = append(keys, r)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	var b strings.Builder
	for _, r := range keys {
		var target []string
		for _, c := range table[r] {
			target = append(target, fmt.Sprintf("%04X", c))
		}
		fmt.Fprintf(&b, "%04X:%s\n", r, strings.Join(target, " "))
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:])
}

func TestTheFoldTableIsTheOneTheContractPins(t *testing.T) {
	c := load(t)
	if got := tableDigest(foldTable); got != c.Fold.TableDigest || got != FoldTableDigest {
		t.Fatalf("the fold table digests to %s; the contract pins %s and the generated file says %s",
			got, c.Fold.TableDigest, FoldTableDigest)
	}
	if len(foldTable) != c.Fold.TableSize {
		t.Errorf("the fold table has %d entries and the contract %d", len(foldTable), c.Fold.TableSize)
	}
	if FoldTableUnicodeVersion != c.Fold.UnicodeVersion {
		t.Errorf("the table is Unicode %s and the contract %s", FoldTableUnicodeVersion, c.Fold.UnicodeVersion)
	}
}

func TestFoldAgreesWithTheReference(t *testing.T) {
	for _, v := range load(t).Fold.Vectors {
		if got := Fold(v.Input); got != v.Fold {
			t.Errorf("Fold(%+q) = %+q, the reference says %+q", v.Input, got, v.Fold)
		}
	}
}

func pathVerdict(c pathCase) (got, want Reason, err error) {
	raw, err := hex.DecodeString(c.Hex)
	if err != nil {
		return "", "", err
	}
	if c.Reason != nil {
		want = Reason(*c.Reason)
	}
	return Check(string(raw)), want, nil
}

func TestEveryPathGetsTheReferenceVerdictAndReason(t *testing.T) {
	for _, c := range load(t).Paths.Cases {
		got, want, err := pathVerdict(c)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		if (want == "") != c.Valid {
			t.Fatalf("%s: the fixture says valid=%v with reason %q", c.Name, c.Valid, want)
		}
		if got != want {
			t.Errorf("%s: Check gives %q, the reference %q", c.Name, got, want)
		}
	}
}

// Protocol 3's settings rule, and the notes rule beside it on the same paths:
// a session of protocol 1 or 2 is held to the second, so a settings path has
// to keep failing it for the reason it always did.
func TestEveryConfigPathGetsTheReferenceVerdicts(t *testing.T) {
	cases := load(t).Config.Cases
	if len(cases) < 30 {
		t.Fatalf("only %d settings cases; regenerate with scripts/protocol-vectors.py", len(cases))
	}
	reason := func(r *string) Reason {
		if r == nil {
			return ""
		}
		return Reason(*r)
	}
	for _, c := range cases {
		raw, err := hex.DecodeString(c.Hex)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		p := string(raw)
		if got := IsConfig(p); got != c.IsConfig {
			t.Errorf("%s: IsConfig(%q) is %v, the reference %v", c.Name, p, got, c.IsConfig)
		}
		if got, want := Check(p), reason(c.Notes); got != want {
			t.Errorf("%s: Check(%q) gives %q, the reference %q", c.Name, p, got, want)
		}
		if got, want := CheckConfig(p), reason(c.Config); got != want {
			t.Errorf("%s: CheckConfig(%q) gives %q, the reference %q", c.Name, p, got, want)
		}
	}
}

func liveAndOp(s scenario) ([]Live, Op) {
	live := make([]Live, len(s.Live))
	for i, e := range s.Live {
		live[i] = Live{Path: e.Path, Folder: e.Folder}
	}
	return live, Op{Path: s.Op.Path, Prev: s.Op.Prev, Move: s.Op.Type == "move", Folder: s.Op.Folder}
}

func collides(s scenario) bool { return Collides(liveAndOp(s)) }

// Each scenario's verdict is one of three, and the two references between them
// give exactly one: `stale` for a folder made a file while something is in it
// (T58), judged first, and otherwise `collision` or `ok`.
func TestEveryCollisionScenarioGetsTheReferenceVerdict(t *testing.T) {
	stale := 0
	for _, s := range load(t).Collisions.Scenarios {
		if s.Op.Type != "create" && s.Op.Type != "move" {
			t.Fatalf("%s: unknown op type %q", s.Name, s.Op.Type)
		}
		switch s.Expect {
		case "ok", "collision":
		case "stale":
			stale++
		default:
			t.Fatalf("%s: unknown verdict %q", s.Name, s.Expect)
		}
		if got := FolderNotEmpty(liveAndOp(s)); got != (s.Expect == "stale") {
			t.Errorf("%s: FolderNotEmpty = %v, the reference says %s", s.Name, got, s.Expect)
		}
		if got := collides(s); s.Expect != "stale" && got != (s.Expect == "collision") {
			t.Errorf("%s: Collides = %v, the reference says %s", s.Name, got, s.Expect)
		}
	}
	if stale == 0 {
		t.Fatal("no scenario says stale, so FolderNotEmpty was held to nothing")
	}
}

// What the fixtures leave out of FolderNotEmpty: a note under another spelling
// of the folder keeps it a folder on a disk that folds case, a move to another
// name leaves the folder where it was and is the collision rule's to judge,
// and writing a folder as a folder, or a file as a file, changes no kind.
func TestFolderNotEmptyFollowsTheFold(t *testing.T) {
	live := []Live{{Path: "x", Folder: true}, {Path: "X/a.md"}}
	for _, c := range []struct {
		op   Op
		want bool
	}{
		{Op{Path: "x"}, true},
		{Op{Path: "X", Prev: "x", Move: true}, true},
		{Op{Path: "y", Prev: "x", Move: true}, false},
		{Op{Path: "x", Folder: true}, false},
		{Op{Path: "X/a.md"}, false},
	} {
		if got := FolderNotEmpty(live, c.op); got != c.want {
			t.Errorf("FolderNotEmpty(%+v) = %v, want %v", c.op, got, c.want)
		}
	}
}

func TestTheFormatPoliciesAgreeWithTheReference(t *testing.T) {
	c := load(t)
	if strings.Join(TextExtensions, ",") != strings.Join(c.Formats.TextExtensions, ",") {
		t.Fatalf("TextExtensions is %v and the contract %v", TextExtensions, c.Formats.TextExtensions)
	}
	for _, s := range c.Formats.Samples {
		for _, check := range []struct {
			policy    string
			got, want bool
		}{
			{"syncable", Syncable(s.Path), s.Syncable},
			{"chunkingText", ChunkingText(s.Path), s.ChunkingText},
			{"searchable", Searchable(s.Path), s.Searchable},
			{"mcpReadable", MCPReadable(s.Path), s.MCPReadable},
			{"mcpEditable", MCPEditable(s.Path), s.MCPEditable},
		} {
			if check.got != check.want {
				t.Errorf("%s(%q) = %v, the reference says %v", check.policy, s.Path, check.got, check.want)
			}
		}
	}
}

// A corrupted vector must fail on the consuming side (PLAN.md M0.5). If the
// comparisons above could not tell a wrong expectation from a right one, they
// would pass whatever the fixture said.
func TestACorruptedVectorIsCaught(t *testing.T) {
	c := load(t)

	p := c.Paths.Cases[len(c.Paths.Cases)-1]
	wrong := "empty"
	if p.Reason != nil && *p.Reason == wrong {
		wrong = "utf8"
	}
	p.Reason = &wrong
	if got, want, _ := pathVerdict(p); got == want {
		t.Errorf("a path case whose reason was changed to %q still matched", wrong)
	}

	s := c.Collisions.Scenarios[0]
	flipped := s.Expect == "collision"
	if collides(s) == !flipped {
		t.Errorf("a collision scenario with its expectation flipped still matched")
	}

	v := c.Fold.Vectors[0]
	if Fold(v.Input) == v.Fold+"x" {
		t.Errorf("a fold vector with a changed result still matched")
	}
	if tableDigest(map[rune]string{'A': "b"}) == c.Fold.TableDigest {
		t.Errorf("a different table produced the pinned digest")
	}
}

// The conflict-copy name is the engine's (conflictOriginal in
// client/src/core/conflicts.ts), including the cases its own test pins.
func TestConflictCopyNamesAreTheEnginesShape(t *testing.T) {
	for p, want := range map[string]bool{
		"n (Conflicted copy phone 202609101200).md":           true,
		"n (Conflicted copy phone 202609101200) 2.md":         true,
		"README (Conflicted copy phone.v2 202609101200)":      true,
		"a/b (Conflicted copy Claude-on-Mac 202609171130).md": true,
		// Named after the author of the copy's bytes: a token's label as the
		// engine makes it safe, spaces, brackets and all (2026-09-23).
		"From the Mac (Conflicted copy Claude on Mac 202609230941).md": true,
		"n (Conflicted copy Claude-Mac- work 202609230941) 2.md":       true,
		"n (Conflicted copy Claude (work) 202609230941).md":            true,
		"n (Conflicted copy  202609230941).md":                         false,
		"n (restored 42).md":                                           false,
		"n (Conflicted copy phone 2026091012).md":                      false,
		"n (Conflicted copy a/b 202609101200).md":                      false,
		"n (Conflicted copy phone 202609101200)x":                      false,
		"Conflicted copy phone 202609101200.md":                        false,
		"n (Conflicted copy phone ٢٠٢٦٠٩١٠١٢٠٠).md":                    false,
	} {
		if got := ConflictCopy(p); got != want {
			t.Errorf("ConflictCopy(%q) = %v, want %v", p, got, want)
		}
	}
}
