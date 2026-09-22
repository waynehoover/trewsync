/**
 * Whether a merge left markup a reader will still open.
 *
 * This began life in `markup.test.ts` as a measuring instrument, and its
 * comment there said plainly that it was deliberately not production code:
 * `.svg`, `.xml` and `.csv` were measured not to produce malformed merges, so
 * declining to gate them was the finding and this only had to make that
 * finding checkable.
 *
 * The measurement was conditional on something it did not say. It was taken
 * with the coarse diff, and when I28 made the diff exact for ordinary notes
 * the same corpus went from zero malformed merges in 20,923 to one. A finer
 * diff merges more, and merging more is only safe where a broken result would
 * be noticed. So the instrument becomes the gate, which is what lets markup
 * merge as finely as prose (I31).
 *
 * A scanner rather than a parser: tags balanced, one root, comments and CDATA
 * and processing instructions and DOCTYPE skipped, attribute values
 * quote-aware. It does not check entities, namespaces or the DTD, and it does
 * not need to: what it is asked is whether a merge unbalanced the tags, which
 * is the whole of the failure it exists for.
 *
 * `markup.test.ts` still asserts its own cases against it before measuring
 * anything with it, and now imports it from here, so the corpus is judging the
 * same thing the engine judges. Two copies would be a corpus that proves a
 * property about code nothing runs.
 */
export function wellFormedMarkup(text: string): boolean {
  const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;
  const stack: string[] = [];
  let roots = 0;
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    i = lt + 1;
    if (text.startsWith("!--", i)) {
      const end = text.indexOf("-->", i + 3);
      if (end < 0) return false;
      i = end + 3;
      continue;
    }
    if (text.startsWith("![CDATA[", i)) {
      const end = text.indexOf("]]>", i + 8);
      if (end < 0) return false;
      i = end + 3;
      continue;
    }
    if (text.startsWith("?", i)) {
      const end = text.indexOf("?>", i + 1);
      if (end < 0) return false;
      i = end + 2;
      continue;
    }
    if (text.startsWith("!", i)) {
      // DOCTYPE, whose internal subset is bracketed and may hold a `>`.
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        const c = text[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      if (j >= text.length) return false;
      i = j + 1;
      continue;
    }
    const closing = text[i] === "/";
    if (closing) i++;
    NAME.lastIndex = i;
    const named = NAME.exec(text);
    if (named === null) return false;
    const name = named[0];
    i = NAME.lastIndex;
    let selfClosing = false;
    let closed = false;
    while (i < text.length) {
      const c = text[i];
      if (c === '"' || c === "'") {
        const end = text.indexOf(c, i + 1);
        if (end < 0) return false;
        i = end + 1;
        continue;
      }
      if (c === "<") return false; // a `<` inside a tag is never well formed
      if (c === "/") {
        selfClosing = true;
        i++;
        continue;
      }
      if (c === ">") {
        i++;
        closed = true;
        break;
      }
      if (selfClosing) return false; // a `/` anywhere but before the `>`
      i++;
    }
    if (!closed) return false;
    if (closing) {
      if (selfClosing) return false;
      if (stack.pop() !== name) return false;
      if (stack.length === 0) roots++;
    } else if (!selfClosing) {
      stack.push(name);
    } else if (stack.length === 0) roots++;
  }
  return stack.length === 0 && roots === 1;
}

/** Which extensions get that gate. `.csv` is not markup and has its own answer. */
const MARKUP_EXTENSIONS = new Set(["svg", "xml", "xhtml", "html", "htm"]);

/**
 * Whether a path is markup this can judge.
 *
 * By extension, like `looksLikeJson`, because the decision is made before the
 * merge and a path is what the engine has. `.csv` is deliberately absent: it
 * was measured to break its row shape rather than its structure, and in every
 * one of those 600 cases each row of the result is a row one of the two
 * devices wrote. A ragged table is a file every reader still opens.
 */
export function looksLikeMarkupPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return MARKUP_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}
