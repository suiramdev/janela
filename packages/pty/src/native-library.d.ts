/**
 * The native library is imported as a file, not as code.
 *
 * `bun build --compile` embeds an import carrying `{ type: "file" }` and hands
 * `dlopen` a `$bunfs` path at runtime, which is what lets `janelad` ship as one
 * file. TypeScript has no built-in shape for that, so the specifier is declared
 * here rather than weakened into a computed string the bundler cannot see.
 */
declare module "*.dylib" {
  const path: string;

  export default path;
}
