/**
 * A migration is imported as text, not read from disk.
 *
 * `bun build --compile` embeds an import carrying `{ type: "text" }` into the
 * binary, so `janelad` migrates a user's database with no `prisma/` directory
 * beside it. Reading the file at runtime would work under `bun run` and fail in
 * the shipped daemon, which is the worst possible place to find out. TypeScript
 * has no built-in shape for that import, so the specifier is declared here.
 */
declare module "*.sql" {
  const text: string;
  export default text;
}
