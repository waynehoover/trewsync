package notes

import (
	"encoding/json"
	"os"
	"testing"
)

// TestEvalHidden writes MarkdownHidden for the notes in $EVAL_IN to
// $EVAL_OUT. A debugging aid for minimising divergences from micromark.
func TestEvalHidden(t *testing.T) {
	in, out := os.Getenv("EVAL_IN"), os.Getenv("EVAL_OUT")
	if in == "" || out == "" {
		t.Skip("EVAL_IN and EVAL_OUT not set")
	}
	raw, err := os.ReadFile(in)
	if err != nil {
		t.Fatal(err)
	}
	var inputs []string
	if err := json.Unmarshal(raw, &inputs); err != nil {
		t.Fatal(err)
	}
	results := make([][2][][2]int, len(inputs))
	for i, s := range inputs {
		for j, p := range []bool{false, true} {
			for _, r := range MarkdownHidden(s, 0, p) {
				results[i][j] = append(results[i][j], [2]int{r.Start, r.End})
			}
		}
	}
	b, _ := json.Marshal(results)
	if err := os.WriteFile(out, b, 0o644); err != nil {
		t.Fatal(err)
	}
}
