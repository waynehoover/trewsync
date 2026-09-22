package notes

// CompareCells is the work cap on the line comparison: a longest-common-
// subsequence table larger than this many cells is not built, and the whole
// differing region becomes one coarse change.
const CompareCells = 1_000_000

// HunkUnits is how much of a change's old and new text a compare_versions
// page carries, in UTF-16 code units.
const HunkUnits = 2048

// ComparePageBytes is compare_versions' page budget, in bytes of the
// serialised changes.
const ComparePageBytes = 128 * 1024

// Change is one differing run of lines: OldLines lines of the earlier version
// starting at FromLine replaced by NewLines lines of the later one starting at
// ToLine, both 1-based. Old and New are those lines verbatim, terminators kept,
// so applying the changes in reverse order to the earlier text reproduces the
// later text exactly.
type Change struct {
	FromLine int
	ToLine   int
	Old      string
	New      string
	OldLines int
	NewLines int
}

// Comparison is every change between two versions, in order.
type Comparison struct {
	Changes []Change
	// Coarse reports that the differing region was too large to compare line
	// by line and is reported as one change.
	Coarse bool
}

// CompareLines is Basalt's compareText. Lines are split as Page splits them.
// The common prefix and suffix are trimmed first; if the remaining region
// needs a table of more than CompareCells cells it is one coarse change,
// otherwise a longest common subsequence decides the changes.
//
// The work cap is deterministic on purpose: mcp-inspect.ts notes that a timed
// diff could choose different hunks on the next page for identical input, and
// pages are addressed by change index.
func CompareLines(before, after string) Comparison {
	a, b := splitLines(before), splitLines(after)
	start, endA, endB := 0, len(a), len(b)
	for start < endA && start < endB && a[start] == b[start] {
		start++
	}
	for endA > start && endB > start && a[endA-1] == b[endB-1] {
		endA--
		endB--
	}
	var changes []Change
	add := func(i, j int, old, next []string) {
		if len(old) == 0 && len(next) == 0 {
			return
		}
		changes = append(changes, Change{
			FromLine: i + 1,
			ToLine:   j + 1,
			Old:      joinLines(old),
			New:      joinLines(next),
			OldLines: len(old),
			NewLines: len(next),
		})
	}
	height, width := endA-start+1, endB-start+1
	if height*width > CompareCells {
		add(start, start, a[start:endA], b[start:endB])
		return Comparison{Changes: changes, Coarse: true}
	}
	table := make([]uint32, height*width)
	for i := height - 2; i >= 0; i-- {
		for j := width - 2; j >= 0; j-- {
			if a[start+i] == b[start+j] {
				table[i*width+j] = table[(i+1)*width+j+1] + 1
			} else {
				table[i*width+j] = max(table[(i+1)*width+j], table[i*width+j+1])
			}
		}
	}
	i, j, from, to := 0, 0, 0, 0
	var old, next []string
	for i < height-1 || j < width-1 {
		switch {
		case i < height-1 && j < width-1 && a[start+i] == b[start+j]:
			add(start+from, start+to, old, next)
			old, next = nil, nil
			i++
			j++
			from, to = i, j
		case i < height-1 && (j == width-1 || table[(i+1)*width+j] >= table[i*width+j+1]):
			old = append(old, a[start+i])
			i++
		default:
			next = append(next, b[start+j])
			j++
		}
	}
	add(start+from, start+to, old, next)
	return Comparison{Changes: changes}
}

func joinLines(lines []string) string {
	n := 0
	for _, l := range lines {
		n += len(l)
	}
	b := make([]byte, 0, n)
	for _, l := range lines {
		b = append(b, l...)
	}
	return string(b)
}

// ChangeRow is a change as a compare_versions page carries it: Old and New
// clipped to HunkUnits, and Clipped set when either was.
type ChangeRow struct {
	Change
	Clipped bool
}

// ComparePage is one page of a comparison's changes.
type ComparePage struct {
	Changes []ChangeRow
	// NextAfter is the index of the first change the next page starts at, or
	// -1 when this page reaches the end.
	NextAfter int
	// Complete reports that this page reaches the last change.
	Complete bool
}

// PageChanges is the page loop of Basalt's compareVersions: from change index
// after, at most limit changes, stopping before the serialised rows would
// exceed ComparePageBytes. The size of a row is measured as JavaScript
// serialised it, so page boundaries fall where Basalt's did.
func PageChanges(c Comparison, after, limit int) ComparePage {
	page := ComparePage{NextAfter: -1}
	used, index := 0, after
	for ; index < len(c.Changes) && len(page.Changes) < limit; index++ {
		row := c.Changes[index]
		old, next := clipUnits(row.Old, HunkUnits), clipUnits(row.New, HunkUnits)
		out := ChangeRow{Change: row, Clipped: len(old) != len(row.Old) || len(next) != len(row.New)}
		out.Old, out.New = old, next
		size := changeRowSize(out)
		if used+size > ComparePageBytes {
			break
		}
		used += size
		page.Changes = append(page.Changes, out)
	}
	if index < len(c.Changes) {
		page.NextAfter = index
	}
	page.Complete = index >= len(c.Changes)
	return page
}

// changeRowSize is Buffer.byteLength(JSON.stringify(row)) for the object
// {fromLine, toLine, old, new, oldLines, newLines, clipped}.
func changeRowSize(r ChangeRow) int {
	return len(`{"fromLine":,"toLine":,"old":,"new":,"oldLines":,"newLines":,"clipped":}`) +
		jsIntSize(r.FromLine) + jsIntSize(r.ToLine) + jsStringSize(r.Old) + jsStringSize(r.New) +
		jsIntSize(r.OldLines) + jsIntSize(r.NewLines) + jsBoolSize(r.Clipped)
}
