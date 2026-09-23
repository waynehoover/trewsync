// Package notes works on note content the way the TypeScript clients do: it
// chunks a note as a device would; it pages, searches, compares, and reads
// the tags and links of a note as Basalt's MCP tools did; and it works out the
// exact writes of those tools' mutations.
//
// Chunking. The server holds notes in plaintext, and from M5 it writes them
// too, for the MCP tools. A note the server writes has to be chunked exactly
// as a device would chunk the same bytes. A chunk's name is the SHA-256 of its
// raw bytes, so a boundary one byte away from where the client puts it gives
// the server and the device two different chunks for the same note, and
// nothing reports it: both sides still converge, they just stop deduplicating
// against each other. chunk.go is a port of client/src/core/chunk.ts, and
// chunk-fixtures.json at the repository root pins the two together.
//
// The MCP read side. Paging for read_note, the opaque continuation cursors,
// literal search within one note, line comparison for compare_versions, and
// the reading half of tags and links are ports of Basalt's TypeScript MCP
// (client/src/node/mcp-read.ts, mcp-inspect.ts, mcp-markdown.ts and
// mcp-links.ts), which stays in the tree as the oracle until these pass
// against it (PLAN.md section 2.1). The generator
// client/src/node/mcp-oracle.run.ts feeds a corpus through the TypeScript and
// records what it returns in mcp-fixtures.json; oracle_test.go holds this
// package to those outputs. Positions an agent sees are counted the way
// Basalt counted them, in UTF-16 code units: search columns, clip lengths,
// tag and link offsets. Budgets are counted in UTF-8 bytes, again as Basalt
// did. The two are never mixed within one rule, and every function says which
// it uses.
//
// The MCP write side. The bytes of an exact edit, an append and a prepend
// (EditNote, AppendNote, PrependNote), the source edits that add, remove or
// rename tags (ChangeTags), and the plan of a tag, move or delete operation
// (PlanTags, PlanMove, PlanDelete), with the comparison that tells an apply
// whether the plan passed back is the plan computed now (SamePlan), are ports
// of mcp-notes.ts, mcp-markdown.ts, mcp-operations.ts and mcp-batch.ts; the
// link rewrites a plan makes are ChangeLinks, from mcp-links.ts. A plan reads
// the vault through a View, which the tool layer backs with the store at one
// snapshot head. The same generator records what the TypeScript does to a
// corpus in mcp-fixtures.json's "edits", "changeTags", "plans" and "samePlan"
// sections, and oracle_write_test.go holds these functions to it. A planned
// change's base is the uid of the version it was planned from, where Basalt's
// was a digest of the file.
//
// Nothing here touches the store, the network or the clock.
package notes
