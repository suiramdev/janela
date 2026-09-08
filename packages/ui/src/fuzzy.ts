/**
 * The matcher behind both type-to-find lists.
 *
 * One implementation, because the jump list and the command palette must agree
 * about what "matching" means: a user who learns that `jan pt` finds `fix/pty` in
 * `janela` should not have to learn a second rule for the palette.
 *
 * Deliberately small. There are tens of sessions and twenty-odd commands, and the
 * ranking only has to be *sensible* — a proper Smith-Waterman would be more code
 * defending a difference nobody can see at this size.
 */

/**
 * How well `query` matches `text`, or `undefined` when it does not.
 *
 * A case-insensitive subsequence match, scored so that matches at the start of a
 * word and runs of consecutive characters win — which is what makes an acronym
 * (`gts` → "Go to Session…") and a prefix (`fix` → `fix/pty`) both behave.
 *
 * Greedy, left to right, with no backtracking: the first position that can match
 * is taken. That can pick a worse alignment than an exhaustive search would, and
 * at this size the difference is invisible.
 *
 * An empty query matches everything with score `0`, which leaves the caller's
 * tie-break in charge of the order.
 */
export function fuzzyScore(query: string, text: string): number | undefined {
  const needle = query.toLowerCase();
  if (needle.length === 0) return 0;
  const haystack = text.toLowerCase();

  let score = 0;
  let at = 0;
  let previous = -2;

  for (const character of needle) {
    const found = haystack.indexOf(character, at);
    if (found === -1) return undefined;

    if (found === previous + 1) score += 2;
    else if (isWordStart(haystack, found)) score += 3;
    else score += 1;

    previous = found;
    at = found + 1;
  }
  return score;
}

/** A character that begins a word, for scoring: index 0 or after a separator. */
function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text[index - 1];
  return before === " " || before === "/" || before === "-" || before === "_" || before === ".";
}

/**
 * The items that match, best first.
 *
 * `tieBreak` decides between equal scores, and therefore decides the whole order
 * for an empty query — which is the case the user sees most, since the list is
 * open before they have typed anything.
 */
export function rankBy<Item>(
  query: string,
  items: readonly Item[],
  textOf: (item: Item) => string,
  tieBreak: (left: Item, right: Item) => number,
): readonly Item[] {
  const scored: { readonly item: Item; readonly score: number }[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, textOf(item));
    if (score !== undefined) scored.push({ item, score });
  }
  scored.sort((left, right) =>
    left.score === right.score ? tieBreak(left.item, right.item) : right.score - left.score,
  );
  return scored.map((entry) => entry.item);
}
