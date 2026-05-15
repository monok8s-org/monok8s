package output

import (
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"strings"

	"gopkg.in/yaml.v3"
)

// Option configures table output.
type Option func(*tableConfig)

type tableConfig struct {
	columns []string
	rowFn   func(any) []string
}

// Columns sets the column headers for table output.
func Columns(cols ...string) Option {
	return func(tc *tableConfig) { tc.columns = cols }
}

// Row sets the function that converts a row value to column strings.
func Row(fn func(any) []string) Option {
	return func(tc *tableConfig) { tc.rowFn = fn }
}

// Print writes data to w in the requested format.
// For "table" format, opts must include Columns() and Row().
// For "json"/"yaml", data is marshalled directly.
func Print(w io.Writer, format string, data any, opts ...Option) error {
	switch format {
	case "json":
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		return enc.Encode(data)

	case "yaml":
		return yaml.NewEncoder(w).Encode(data)

	default: // "table"
		tc := &tableConfig{}
		for _, o := range opts {
			o(tc)
		}
		if tc.rowFn == nil || len(tc.columns) == 0 {
			// Fall back to JSON for types without table config.
			enc := json.NewEncoder(w)
			enc.SetIndent("", "  ")
			return enc.Encode(data)
		}
		return printTable(w, data, tc)
	}
}

func printTable(w io.Writer, data any, tc *tableConfig) error {
	var rows [][]string
	rv := reflect.ValueOf(data)
	if rv.Kind() == reflect.Slice {
		for i := 0; i < rv.Len(); i++ {
			rows = append(rows, tc.rowFn(rv.Index(i).Interface()))
		}
	} else {
		rows = append(rows, tc.rowFn(data))
	}

	// Compute column widths.
	widths := make([]int, len(tc.columns))
	for i, col := range tc.columns {
		widths[i] = len(col)
	}
	for _, row := range rows {
		for i, cell := range row {
			if i < len(widths) && len(cell) > widths[i] {
				widths[i] = len(cell)
			}
		}
	}

	// Print header.
	printRow(w, tc.columns, widths)
	printSeparator(w, widths)

	// Print rows.
	for _, row := range rows {
		printRow(w, row, widths)
	}

	if len(rows) == 0 {
		fmt.Fprintln(w, "No results.")
	}
	return nil
}

func printRow(w io.Writer, cells []string, widths []int) {
	parts := make([]string, len(cells))
	for i, cell := range cells {
		if i < len(widths) {
			parts[i] = fmt.Sprintf("%-*s", widths[i], cell)
		} else {
			parts[i] = cell
		}
	}
	fmt.Fprintln(w, strings.Join(parts, "  "))
}

func printSeparator(w io.Writer, widths []int) {
	parts := make([]string, len(widths))
	for i, w := range widths {
		parts[i] = strings.Repeat("-", w)
	}
	fmt.Fprintln(w, strings.Join(parts, "  "))
}
