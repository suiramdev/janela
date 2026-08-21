/**
 * Prisma 7 moved the datasource URL out of `schema.prisma` and into here.
 *
 * The path is the same one ADR 0005 chose and for the same reason: the database is
 * daemon-private, it is not in a sandbox container because Janela is not
 * sandboxed, and it is inspectable with `sqlite3` when diagnosing a user's
 * problem.
 *
 * Note this file configures the *CLI* — migrations and generation. The running
 * daemon passes its own adapter to the client constructor and never reads this.
 */
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    // A developer's own store, overridden in CI and in tests by a temporary path.
    url: process.env["JANELA_DATABASE_URL"] ?? "file:./janela.sqlite",
  },
});
