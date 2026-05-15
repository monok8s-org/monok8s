package output_test

import (
	"bytes"
	"strings"
	"testing"

	"github.com/monok8s/monok8s/apps/cli/internal/output"
)

type row struct {
	Name string
	Age  int
}

// TestPrint_TypedSlice exercises the reflect-based slice walk in
// printTable. Before the reflect change, output.Print only ranged over
// []any; typed slices like []row fell through to the default branch
// and printed as a single JSON blob. The reflect path makes typed
// slices iterate per-element through the Row callback.
func TestPrint_TypedSlice(t *testing.T) {
	var buf bytes.Buffer
	err := output.Print(&buf, "table", []row{{"alice", 30}, {"bob", 25}},
		output.Columns("NAME", "AGE"),
		output.Row(func(r any) []string {
			x := r.(row)
			return []string{x.Name, intStr(x.Age)}
		}),
	)
	if err != nil {
		t.Fatalf("Print returned error: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"NAME", "AGE", "alice", "bob", "30", "25"} {
		if !strings.Contains(out, want) {
			t.Errorf("expected %q in output, got:\n%s", want, out)
		}
	}
}

// TestPrint_AnySlice keeps the original []any code path working.
func TestPrint_AnySlice(t *testing.T) {
	var buf bytes.Buffer
	err := output.Print(&buf, "table", []any{row{"alice", 30}},
		output.Columns("NAME", "AGE"),
		output.Row(func(r any) []string {
			x := r.(row)
			return []string{x.Name, intStr(x.Age)}
		}),
	)
	if err != nil {
		t.Fatalf("Print returned error: %v", err)
	}
	if !strings.Contains(buf.String(), "alice") {
		t.Errorf("expected alice in output, got: %q", buf.String())
	}
}

func intStr(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	if neg {
		digits = append([]byte{'-'}, digits...)
	}
	return string(digits)
}
