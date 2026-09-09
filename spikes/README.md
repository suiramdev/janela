# Spikes

Throwaway code that proved the migration's three risky claims before the repository
was committed to them. **Not built, not linted, not tested, and not shipped** —
`spikes/` is excluded from oxlint, oxfmt and the layering gate.

Kept because the shipped architecture rests on the decisions they settled, and a
measurement with no reproducible method is an assertion. The numbers they
produced are quoted in [`../docs/architecture.md`](../docs/architecture.md) and
[`../docs/performance.md`](../docs/performance.md). Each was run on macOS 26.2,
Apple silicon, Bun 1.3.14.

Delete any of these once the real implementation replaces it and carries its own
tests.

---

## `pty-bun-ffi/` — can Bun host a PTY?

The riskiest question, because a JavaScript runtime cannot give a child a
controlling terminal.

`native/src/lib.rs` is a working `openpty` → `fork` → `login_tty` → `execve`
implementation with a reader thread and high/low water marks. **It is the reference
for `packages/pty/native/`** — port it rather than starting over.

```bash
cd native && cargo build --release && cd ..
bun run job-control.ts     # ctty, Ctrl-C, exit codes, teardown
bun run throughput.ts      # yes flood, back-pressure, neighbour isolation
bun run compiled-embed.ts  # after: bun build --compile --outfile x compiled-embed.ts
```

Results:

| Property | Result |
| --- | --- |
| Controlling terminal | `tty` reports `/dev/ttys*`; login shell sources the profile |
| `TIOCSWINSZ` + `SIGWINCH` | `tput cols`/`lines` reflect a resize |
| Full-screen TUI | `vim` enters/leaves the alternate screen and edits a real file |
| Ctrl-C | writing `0x03` interrupts the foreground job via the line discipline |
| Exit codes | `0`, `7`, `143` for a `SIGTERM` death |
| Teardown | `SIGHUP` to the group kills grandchildren; `close()` returns in 0.4 ms |
| Throughput | **133 MB/s** under `yes`, ~4 MB bounded memory, 1.7 ms worst timer lag |
| Compiled | the dylib is **embedded** by `bun build --compile`; runs from an empty dir |

The teardown finding cost the most: **closing the PTY fd from a thread other than
the reader hangs the caller on Darwin.** The first version of this spike hung rather
than failed. The reader thread owns the close.

Also evaluated and rejected here: `node-pty` (ships `spawn-helper` without the
executable bit, and reads returned nothing under Bun) and `bun-pty` (round-trips
argv through `shell_words`, string-only API, 4 KB polled reads, no water marks).

---

## `emulator-xterm/` — is `@xterm/headless` fast enough, and is attach correct?

```bash
bun run round-trip.ts   # serialize → replay → compare buffers, cell by cell
bun run throughput.ts   # parser throughput against write size
```

Two findings:

**Attach is correct.** Coloured, cursor-positioned content round-tripped through
`@xterm/addon-serialize` into a second emulator produced an identical buffer, in 143
bytes. Repeated for a 100×30 alternate-screen TUI with the cursor left mid-screen:
identical, 1802 bytes, cursor position and buffer type preserved.

**Throughput depends on how you feed it, far more than on the library:**

| Write size | Sustained |
| --- | --- |
| 8 KB | ~6 MB/s |
| 64 KB | ~32 MB/s |
| 1 MB | ~140 MB/s |

A factor of twenty across chunk size. This is why "drain once per frame in one large
call" is a rule in `packages/pty/src/byte-stream.ts` rather than a tuning note.

---

## `db-prisma-bun/` — does Prisma survive `bun build --compile`?

```bash
bunx prisma migrate dev   # needs a supported Node — see .node-version
bun run query.ts            # real queries, cascade rules
bun run combined-daemon.ts  # PTY + emulator + Prisma in one process
```

`combined-daemon.ts` is the whole daemon in miniature and the most useful of the
three: a real PTY feeding a real emulator, serialised for attach, alongside real
Prisma persistence — then compiled to a single 69 MB binary and run from an empty
directory.

Findings: the first-party `better-sqlite3` adapter is unusable under Bun, the
libsql adapter works uncompiled and dies compiled on a missing native addon, and
`bun:sqlite` works end to end. Also: Prisma's CLI runs on Node and rejects
unsupported versions, which is why `.node-version` exists.

Note this spike uses the third-party `prisma-adapter-bun-sqlite` to prove the path.
`@janela/db` implements its own adapter over `bun:sqlite`, because surviving
`bun build --compile` is the constraint that decided the driver.
