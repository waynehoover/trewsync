// Package notes works on note content the way the TypeScript clients do: it
// chunks a note as a device would, and it pages, searches, compares, and reads
// the tags and links of a note as Basalt's MCP tools did.
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
// Nothing here touches the store, the network or the clock.
package notes
