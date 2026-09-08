/**
 * xterm ships its own stylesheet, and its renderer does not work without it.
 *
 * The import lives in `xterm-rendering.ts` — the module that already owns the
 * library — rather than in the app's global stylesheet, so the dependency and the
 * thing that needs it stay in the same package. TypeScript has no notion of a
 * stylesheet module, hence this declaration.
 */
declare module "@xterm/xterm/css/xterm.css";
