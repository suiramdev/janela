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

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;

  const before = text[index - 1];

  return before === " " || before === "/" || before === "-" || before === "_" || before === ".";
}

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
