/**
 * Writes corpus A of chunk-fixtures.json: the cuts this side's chunkBytes
 * makes, for Go to check its own chunker against.
 *
 *     cd client && bun run src/core/chunk-fixtures.run.ts
 *
 * Every other section of the file is left as it was. Corpus B is Go's to
 * write (`go test ./internal/notes -run TestChunkFixtures -update`), and the
 * two rewrite the file in one format, so neither regeneration shows up as a
 * change to the other's half.
 *
 * A change here is a change to what every vault's chunks are called, unless it
 * only adds cases. Run the Go tests after it: they are what find out whether
 * the two chunkers still agree.
 */

import { FIXTURE_PATH, corpusA, writeCorpusA } from "./chunk-fixtures.ts";

const corpus = corpusA();
writeCorpusA(corpus);
const chunks = corpus.entries.reduce((n, e) => n + e.cuts.length, 0);
console.log(
  `corpus A: ${corpus.entries.length} entries, ${chunks} chunks, written to ${FIXTURE_PATH}`,
);
