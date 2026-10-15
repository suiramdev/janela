import { describe, expect, test } from "bun:test";

import {
  cancelPendingFilter,
  chooseSearchSuggestion,
  editSearchToken,
  EMPTY_SEARCH,
  eraseSearchBackward,
  isSearching,
  removeSearchToken,
  searchQuery,
  searchSuggestions,
  searchValueTitle,
  toggleSearchOperator,
  togglePendingOperator,
  typeSearchDraft,
  type SearchField,
  type SearchFilterToken,
  type SearchState,
  type SearchSuggestion,
} from "./filtered-search.ts";

function field(key: string, values: readonly string[], takesMany = false): SearchField {
  return {
    key,
    title: `${key.charAt(0).toUpperCase()}${key.slice(1)}`,
    values: values.map((value) => ({ value, title: value })),
    isPerson: false,
    takesMany,
  };
}

const fields: readonly SearchField[] = [
  field("author", ["ada", "marius"]),
  field("label", ["bug", "ui"], true),
  field("platform", []),
];

const filter = (
  key: string,
  value: string,
  operator: SearchFilterToken["operator"] = "is",
): SearchFilterToken => ({ kind: "filter", field: key, operator, value });

const describeSuggestion = (suggestion: SearchSuggestion): string => {
  if (suggestion.kind === "field") return `field ${suggestion.field.key}`;

  if (suggestion.kind === "text") return `text ${suggestion.text}`;

  return `${suggestion.field.key} = ${suggestion.value.value}`;
};

const suggested = (state: SearchState): readonly string[] =>
  searchSuggestions(state, fields).map(describeSuggestion);

const typed = (draft: string, state: SearchState = EMPTY_SEARCH): SearchState =>
  typeSearchDraft(state, fields, draft);

const pick = (state: SearchState, index: number): SearchState => {
  const suggestion = searchSuggestions(state, fields)[index];

  if (suggestion === undefined) throw new Error(`no suggestion at ${index}`);

  return chooseSearchSuggestion(state, fields, suggestion);
};

describe("suggestions", () => {
  test("an empty field offers every filter that has something to pick", () => {
    expect(suggested(EMPTY_SEARCH)).toEqual(["field author", "field label"]);
  });

  test("typing offers the matching filter, matching values, then the text itself", () => {
    expect(suggested(typed("Auth"))).toEqual(["field author", "text Auth"]);
    expect(suggested(typed("a"))).toEqual([
      "field author",
      "field label",
      "author = ada",
      "author = marius",
      "text a",
    ]);
  });

  test("a chosen filter lists its values, searched as you type, less those already chosen", () => {
    const pending = pick(typed("auth"), 0);

    expect(pending.pending).toEqual({ field: "author", operator: "is", replacing: undefined });
    expect(suggested(pending)).toEqual(["author = ada", "author = marius"]);
    expect(suggested(typed("MAR", pending))).toEqual(["author = marius"]);

    const labelled = { ...EMPTY_SEARCH, tokens: [filter("label", "bug")] };

    expect(suggested(pick(labelled, 1))).toEqual(["label = ui"]);
  });

  test("a field: prefix chooses the filter without the menu, and a leading - negates it", () => {
    expect(typed("label:u").pending).toEqual({
      field: "label",
      operator: "is",
      replacing: undefined,
    });

    expect(typed("label:u").draft).toBe("u");
    expect(typed("-author:").pending?.operator).toBe("isNot");
    expect(typed("http://example.com").pending).toBeUndefined();
  });
});

describe("tokens", () => {
  test("choosing a value turns the filter into a chip and empties the field", () => {
    const chosen = pick(typed("ma", pick(EMPTY_SEARCH, 0)), 0);

    expect(chosen).toEqual({ tokens: [filter("author", "marius")], draft: "", pending: undefined });
    expect(isSearching(chosen)).toBe(true);
  });

  test("a field that takes one value replaces its chip; one that takes many adds", () => {
    const authors = { ...EMPTY_SEARCH, tokens: [filter("author", "ada"), filter("label", "bug")] };

    expect(pick(typed("author:marius", authors), 0).tokens).toEqual([
      filter("label", "bug"),
      filter("author", "marius"),
    ]);

    expect(pick(typed("label:", authors), 0).tokens).toHaveLength(3);
  });

  test("free text becomes a chip of its own, and both kinds feed the query", () => {
    const state = pick(typed("fix login"), 0);

    expect(state.tokens).toEqual([{ kind: "text", text: "fix login" }]);
    expect(searchQuery(typed("crash", state))).toBe("fix login crash");
    expect(searchQuery(typed("author:ma", state))).toBe("fix login");
  });

  test("backspace at the start drops the pending filter first, then the last chip", () => {
    const state = { ...EMPTY_SEARCH, tokens: [filter("author", "ada"), filter("label", "ui")] };
    const pending = pick(state, 1);

    expect(eraseSearchBackward(pending)).toEqual(state);
    expect(eraseSearchBackward(state).tokens).toEqual([filter("author", "ada")]);
    expect(eraseSearchBackward(EMPTY_SEARCH)).toEqual(EMPTY_SEARCH);
  });

  test("a chip edits in place: its value is chosen again, its operator flips", () => {
    const state = { ...EMPTY_SEARCH, tokens: [filter("author", "ada"), filter("label", "ui")] };
    const editing = editSearchToken(state, 0);

    expect(editing.pending).toEqual({ field: "author", operator: "is", replacing: 0 });
    expect(suggested(editing)).toEqual(["author = ada", "author = marius"]);
    expect(pick(editing, 1).tokens).toEqual([filter("author", "marius"), filter("label", "ui")]);
    expect(cancelPendingFilter(editing)).toEqual(state);
    expect(toggleSearchOperator(state, fields, 1).tokens).toEqual([
      filter("author", "ada"),
      filter("label", "ui", "isNot"),
    ]);

    expect(togglePendingOperator(editing).pending?.operator).toBe("isNot");
  });

  test("a text chip goes back into the field to be edited", () => {
    const state = { ...EMPTY_SEARCH, tokens: [{ kind: "text" as const, text: "crash" }] };

    expect(editSearchToken(state, 0)).toEqual({ ...EMPTY_SEARCH, draft: "crash" });
    expect(removeSearchToken(state, 0)).toEqual(EMPTY_SEARCH);
  });

  test("a chip names its value by title, or by the raw value once it is no longer offered", () => {
    expect(searchValueTitle(fields, filter("author", "ada"))).toBe("ada");
    expect(searchValueTitle(fields, filter("author", "grace"))).toBe("grace");
  });
});
