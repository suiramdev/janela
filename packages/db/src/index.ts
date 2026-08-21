/**
 * `@janela/db` — layer 3, daemon side. The on-disk metadata store.
 *
 * Owns the schema, its migrations, and the mapping between rows and
 * `@janela/core` values. Contains no business rules: what it means to delete a
 * session lives in `@janela/session`, and this package only knows that deleting
 * one cascades to its terminals.
 *
 * The only package permitted to import `@prisma/client` or `bun:sqlite`.
 */

export * from "./adapter.ts";
export * from "./database.ts";
export * from "./repositories.ts";
