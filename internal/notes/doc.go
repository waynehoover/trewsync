// Package notes holds the pure functions the MCP tools apply to a note's
// text: paging for read_note, the opaque continuation cursors, literal search
// within one note, line comparison for compare_versions, and the read side of
// tags and links.
//
// Each is a port of Basalt's TypeScript MCP (client/src/cli/mcp-read.ts,
// mcp-inspect.ts, mcp-markdown.ts and mcp-links.ts), which stays in the tree as
// the oracle until these pass against it (PLAN.md section 2.1). The generator
// client/src/cli/mcp-oracle.run.ts feeds a corpus through the TypeScript and
// records what it returns in mcp-fixtures.json; oracle_test.go holds this
// package to those outputs.
//
// Positions an agent sees are counted the way Basalt counted them, in UTF-16
// code units: search columns, clip lengths, tag and link offsets. Budgets are
// counted in UTF-8 bytes, again as Basalt did. The two are never mixed within
// one rule, and every function says which it uses.
//
// Nothing here touches the store, the network or the clock.
package notes
