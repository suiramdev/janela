import { CORNER_RADIUS, GRID_UNIT, MOTION } from "@janela/design";
import type { CSSProperties } from "react";

/**
 * Hoisted style objects.
 *
 * Every one of these is module-level rather than inline, and that is not a style
 * preference: `react-perf/jsx-no-new-object-as-prop` is an error in this repo, so
 * `style={{ … }}` at a call site does not compile. Hoisting also means a settings
 * pane re-render does not allocate a new object per element.
 *
 * These are literals over `@janela/design`'s tokens rather than new tokens. The
 * bar for adding a token is "used in at least two places, or it encodes a decision
 * someone would otherwise get wrong" — settings-pane padding is neither, and
 * `@janela/design` is another issue's package this wave.
 */

/** Semantic colours, as `var()` references. Resolved by `@janela/design`'s CSS. */
export const FAILURE_COLOR = "var(--janela-failure)";
export const ATTENTION_COLOR = "var(--janela-attention)";
export const RUNNING_COLOR = "var(--janela-running)";

export const WINDOW: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  height: "100%",
};

export const TAB_STRIP: CSSProperties = {
  display: "flex",
  gap: GRID_UNIT,
  padding: GRID_UNIT * 2,
  borderBottom: "1px solid rgb(0 0 0 / 0.12)",
};

export const TAB: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: GRID_UNIT / 2,
  padding: GRID_UNIT * 1.5,
  minWidth: 68,
  border: "none",
  borderRadius: CORNER_RADIUS.small,
  background: "transparent",
  font: "inherit",
  fontSize: 11,
  // Reduced motion is honoured by the token, not by a branch here: a component
  // that animates unconditionally is a bug, not a flourish.
  transitionDuration: `${MOTION.fast}ms`,
  transitionProperty: "background-color",
};

export const TAB_SELECTED: CSSProperties = {
  ...TAB,
  background: "rgb(0 0 0 / 0.08)",
};

export const PANE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: GRID_UNIT * 4,
  padding: GRID_UNIT * 4,
  overflowY: "auto",
  minHeight: 0,
};

export const SECTION: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: GRID_UNIT * 2,
  border: "none",
  margin: 0,
  padding: 0,
};

export const SECTION_HEADING: CSSProperties = {
  padding: 0,
  fontSize: 13,
  fontWeight: 600,
};

export const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: GRID_UNIT * 2,
};

export const FIELD: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: GRID_UNIT,
};

export const FIELD_LABEL: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
};

export const HINT: CSSProperties = {
  margin: 0,
  fontSize: 11,
  opacity: 0.7,
};

/** A hint pushed to the right of its row: a chord, a status. */
export const TRAILING_HINT: CSSProperties = {
  ...HINT,
  marginLeft: "auto",
};

/**
 * The scrim behind a sheet.
 *
 * Fixed rather than absolute: the sheet covers the window, including the sidebar,
 * because while it is open it owns the keyboard.
 */
export const SHEET_SCRIM: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  paddingTop: GRID_UNIT * 12,
};

/** The dismiss target behind the sheet: the whole window, and nothing visible. */
export const SHEET_SCRIM_BUTTON: CSSProperties = {
  position: "absolute",
  inset: 0,
  border: "none",
  padding: 0,
  background: "rgb(0 0 0 / 0.35)",
};

export const SHEET_BODY: CSSProperties = {
  position: "relative",
  border: "none",
  padding: 0,
  color: "inherit",
  minWidth: 420,
  maxWidth: "80vw",
  maxHeight: "80vh",
  overflowY: "auto",
  borderRadius: CORNER_RADIUS.medium,
  background: "Canvas",
  boxShadow: "0 12px 32px rgb(0 0 0 / 0.35)",
};

export const VIOLATION: CSSProperties = {
  margin: 0,
  fontSize: 11,
  color: FAILURE_COLOR,
};

export const INPUT: CSSProperties = {
  padding: GRID_UNIT,
  borderRadius: CORNER_RADIUS.small,
  border: "1px solid rgb(0 0 0 / 0.2)",
  font: "inherit",
  fontSize: 12,
};

export const ARGUMENT_INPUT: CSSProperties = {
  ...INPUT,
  flex: 1,
  fontFamily: "ui-monospace, monospace",
};

export const BUTTON: CSSProperties = {
  padding: `${GRID_UNIT}px ${GRID_UNIT * 2}px`,
  borderRadius: CORNER_RADIUS.small,
  border: "1px solid rgb(0 0 0 / 0.2)",
  background: "transparent",
  font: "inherit",
  fontSize: 12,
};

export const DESTRUCTIVE_BUTTON: CSSProperties = {
  ...BUTTON,
  borderColor: FAILURE_COLOR,
  color: FAILURE_COLOR,
};

export const LIST: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: GRID_UNIT / 2,
  margin: 0,
  padding: 0,
  listStyle: "none",
};

export const LIST_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: GRID_UNIT * 2,
  width: "100%",
  padding: GRID_UNIT,
  borderRadius: CORNER_RADIUS.small,
  border: "none",
  background: "transparent",
  font: "inherit",
  fontSize: 12,
  textAlign: "left",
};

export const LIST_ROW_SELECTED: CSSProperties = {
  ...LIST_ROW,
  background: "rgb(0 0 0 / 0.08)",
};

export const UNAVAILABLE_ROW: CSSProperties = {
  ...LIST_ROW,
  opacity: 0.55,
};

export const PICKER: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: GRID_UNIT / 2,
  padding: GRID_UNIT,
  borderRadius: CORNER_RADIUS.medium,
  minWidth: 240,
  outline: "none",
};

export const COST: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: GRID_UNIT * 2,
  padding: GRID_UNIT * 2,
  borderRadius: CORNER_RADIUS.small,
  border: `1px solid ${FAILURE_COLOR}`,
};

export const COST_SENTENCE: CSSProperties = {
  margin: 0,
  fontSize: 12,
};
