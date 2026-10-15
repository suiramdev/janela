export type SearchOperator = "is" | "isNot";

export interface SearchFilterToken {
  readonly kind: "filter";
  readonly field: string;
  readonly operator: SearchOperator;
  readonly value: string;
}

export interface SearchTextToken {
  readonly kind: "text";
  readonly text: string;
}

export type SearchToken = SearchFilterToken | SearchTextToken;

export interface SearchValue {
  readonly value: string;
  readonly title: string;
}

export interface SearchField {
  readonly key: string;
  readonly title: string;
  readonly values: readonly SearchValue[];
  readonly isPerson: boolean;
  readonly takesMany: boolean;
}

export interface PendingFilter {
  readonly field: string;
  readonly operator: SearchOperator;
  readonly replacing: number | undefined;
}

export interface SearchState {
  readonly tokens: readonly SearchToken[];
  readonly draft: string;
  readonly pending: PendingFilter | undefined;
}

export type SearchSuggestion =
  | { readonly kind: "field"; readonly field: SearchField }
  | { readonly kind: "value"; readonly field: SearchField; readonly value: SearchValue }
  | { readonly kind: "text"; readonly text: string };

export const EMPTY_SEARCH: SearchState = { tokens: [], draft: "", pending: undefined };

export const SEARCH_OPERATOR_SYMBOL = {
  is: "=",
  isNot: "!=",
} as const satisfies Record<SearchOperator, string>;

export const SEARCH_OPERATOR_TITLE = {
  is: "is",
  isNot: "is not",
} as const satisfies Record<SearchOperator, string>;

const OPPOSITE_OPERATOR = {
  is: "isNot",
  isNot: "is",
} as const satisfies Record<SearchOperator, SearchOperator>;

const MATCHED_VALUE_LIMIT = 6;

const FIELD_PREFIX = /^\s*(-?)([^\s:]+):(.*)$/u;

export function searchQuery(state: SearchState): string {
  const words = state.tokens.flatMap((token) => (token.kind === "text" ? [token.text] : []));

  return (state.pending === undefined ? [...words, state.draft] : words).join(" ").trim();
}

export function searchFilters(state: SearchState): readonly SearchFilterToken[] {
  return state.tokens.filter((token) => token.kind === "filter");
}

export function isSearching(state: SearchState): boolean {
  return searchQuery(state) !== "" || searchFilters(state).length > 0;
}

export function searchFieldNamed(
  fields: readonly SearchField[],
  name: string,
): SearchField | undefined {
  const wanted = compact(name);

  return fields.find((field) => compact(field.key) === wanted || compact(field.title) === wanted);
}

export function searchValueTitle(fields: readonly SearchField[], token: SearchFilterToken): string {
  return (
    fields
      .find((field) => field.key === token.field)
      ?.values.find((candidate) => candidate.value === token.value)?.title ?? token.value
  );
}

export function searchFieldTitle(fields: readonly SearchField[], key: string): string {
  return fields.find((field) => field.key === key)?.title ?? key;
}

export function searchSuggestions(
  state: SearchState,
  fields: readonly SearchField[],
): readonly SearchSuggestion[] {
  const query = state.draft.trim().toLowerCase();

  if (state.pending !== undefined) {
    const { pending } = state;
    const field = fields.find((candidate) => candidate.key === pending.field);

    if (field === undefined) return [];

    return field.values
      .filter(
        (value) =>
          value.title.toLowerCase().includes(query) &&
          !isTaken(state.tokens, field.key, value.value, pending.replacing),
      )
      .map((value) => ({ kind: "value", field, value }));
  }

  const offered = fields.filter((field) => field.values.length > 0);

  const matchingFields: readonly SearchSuggestion[] = offered
    .filter(
      (field) =>
        query === "" ||
        field.title.toLowerCase().includes(query) ||
        field.key.toLowerCase().startsWith(query),
    )
    .map((field) => ({ kind: "field", field }));

  if (query === "") return matchingFields;

  const matchingValues: readonly SearchSuggestion[] = offered
    .flatMap((field) =>
      field.values
        .filter(
          (value) =>
            value.title.toLowerCase().includes(query) &&
            !isTaken(state.tokens, field.key, value.value, undefined),
        )
        .map((value) => ({ kind: "value" as const, field, value })),
    )
    .slice(0, MATCHED_VALUE_LIMIT);

  return [...matchingFields, ...matchingValues, { kind: "text", text: state.draft.trim() }];
}

export function typeSearchDraft(
  state: SearchState,
  fields: readonly SearchField[],
  draft: string,
): SearchState {
  if (state.pending !== undefined) return { ...state, draft };

  const prefix = FIELD_PREFIX.exec(draft);
  const field = prefix?.[2] === undefined ? undefined : searchFieldNamed(fields, prefix[2]);

  if (prefix === null || field === undefined) return { ...state, draft };

  return {
    ...state,
    draft: (prefix[3] ?? "").trimStart(),
    pending: {
      field: field.key,
      operator: prefix[1] === "-" ? "isNot" : "is",
      replacing: undefined,
    },
  };
}

export function chooseSearchSuggestion(
  state: SearchState,
  fields: readonly SearchField[],
  suggestion: SearchSuggestion,
): SearchState {
  if (suggestion.kind === "field") {
    return {
      ...state,
      draft: "",
      pending: { field: suggestion.field.key, operator: "is", replacing: undefined },
    };
  }

  if (suggestion.kind === "text") {
    return {
      tokens: suggestion.text === "" ? state.tokens : [...state.tokens, suggestion],
      draft: "",
      pending: undefined,
    };
  }

  const token: SearchFilterToken = {
    kind: "filter",
    field: suggestion.field.key,
    operator: state.pending?.operator ?? "is",
    value: suggestion.value.value,
  };

  return {
    tokens: placeFilter(state.tokens, fields, token, state.pending?.replacing),
    draft: "",
    pending: undefined,
  };
}

export function removeSearchToken(state: SearchState, index: number): SearchState {
  return {
    ...state,
    tokens: state.tokens.filter((_token, position) => position !== index),
    pending: undefined,
  };
}

export function eraseSearchBackward(state: SearchState): SearchState {
  if (state.pending !== undefined) return { ...state, draft: "", pending: undefined };

  return { ...state, tokens: state.tokens.slice(0, -1) };
}

export function editSearchToken(state: SearchState, index: number): SearchState {
  const token = state.tokens[index];

  if (token === undefined) return state;

  if (token.kind === "text") {
    return { ...removeSearchToken(state, index), draft: token.text };
  }

  return {
    ...state,
    draft: "",
    pending: { field: token.field, operator: token.operator, replacing: index },
  };
}

export function toggleSearchOperator(
  state: SearchState,
  fields: readonly SearchField[],
  index: number,
): SearchState {
  const token = state.tokens[index];

  if (token?.kind !== "filter") return state;

  const flipped = { ...token, operator: OPPOSITE_OPERATOR[token.operator] };

  return { ...state, tokens: placeFilter(state.tokens, fields, flipped, index) };
}

export function togglePendingOperator(state: SearchState): SearchState {
  if (state.pending === undefined) return state;

  return {
    ...state,
    pending: { ...state.pending, operator: OPPOSITE_OPERATOR[state.pending.operator] },
  };
}

export function cancelPendingFilter(state: SearchState): SearchState {
  if (state.pending === undefined) return state;

  return { ...state, draft: "", pending: undefined };
}

function placeFilter(
  tokens: readonly SearchToken[],
  fields: readonly SearchField[],
  token: SearchFilterToken,
  replacing: number | undefined,
): readonly SearchToken[] {
  const takesMany = fields.find((field) => field.key === token.field)?.takesMany ?? true;
  const at = replacing ?? tokens.length;
  const placed = replacing === undefined ? [...tokens, token] : tokens.with(replacing, token);

  return placed.filter(
    (existing, position) => position === at || !overrides(token, existing, takesMany),
  );
}

function overrides(token: SearchFilterToken, existing: SearchToken, takesMany: boolean): boolean {
  if (existing.kind !== "filter" || existing.field !== token.field) return false;

  if (existing.value === token.value) return true;

  return !takesMany && existing.operator === "is" && token.operator === "is";
}

function isTaken(
  tokens: readonly SearchToken[],
  field: string,
  value: string,
  replacing: number | undefined,
): boolean {
  return tokens.some(
    (token, position) =>
      position !== replacing &&
      token.kind === "filter" &&
      token.field === field &&
      token.value === value,
  );
}

function compact(name: string): string {
  return name.toLowerCase().replaceAll(/\s+/gu, "");
}
