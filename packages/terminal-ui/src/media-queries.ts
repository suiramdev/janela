export function mediaQueryLists(queries: readonly string[]): readonly MediaQueryList[] {
  const media: ((query: string) => MediaQueryList) | undefined = globalThis.matchMedia;

  return media === undefined ? [] : queries.map(media);
}

export function mediaMatches(query: string): boolean {
  const [list] = mediaQueryLists([query]);

  return list?.matches === true;
}
