/**
 * The read side of a PTY.
 *
 * ## Bytes may never be dropped
 *
 * A terminal stream is stateful. Dropping bytes does not lose a line of output, it
 * truncates an escape sequence and desynchronises the parser — colours stick, the
 * cursor lands in the wrong place, the alternate screen never exits. So "shed load
 * when we fall behind" is not available to us.
 *
 * The correct mechanism is to **stop reading**. Past the high-water mark the
 * native reader stops asking the PTY for more; the kernel's PTY buffer fills, and
 * the child blocks in `write(2)` exactly as it would against a slow physical
 * terminal. That is the behaviour every well-behaved CLI already handles. Reading
 * resumes once the backlog drains to the low-water mark.
 *
 * ## What changed with the runtime, and what did not
 *
 * The rules did not change. Where they live did: the platform read channel and its
 * water marks became a dedicated OS thread inside the Rust cdylib (see
 * `native/src/lib.rs`), because a blocking read must not occupy the JavaScript event
 * loop. The three rules that survive verbatim:
 *
 * 1. **Read on a dedicated thread**, never on the runtime's own.
 * 2. **Close the file descriptor from the thread that reads it, never from
 *    another.** Closing it from outside while a read is pending blocks the caller
 *    indefinitely on Darwin. This was measured during the migration spike, and it
 *    is a long-known hazard of closing a descriptor out from under a reader.
 * 3. **Drain once per frame, in large chunks.** This is not a compromise, it is
 *    the design: the emulator only needs bytes once per frame, and feeding it in
 *    large coalesced writes is what makes ≥100 MB/s reachable at all. Measured:
 *    8 KB writes sustain ~6 MB/s into the emulator, 1 MB writes sustain ~140 MB/s.
 *    See docs/performance.md § Terminal throughput.
 *
 * @see docs/decisions/0021-pty-native-layer.md
 * @see docs/decisions/0003-concurrency-model.md
 */

/**
 * Per-read request size inside the native reader.
 *
 * Mirrored by `READ_SIZE` in `native/src/lib.rs`; the ABI carries no sizes, so
 * the two are kept in step by hand and pinned from the test side.
 */
export const READ_SIZE = 128 * 1024;

/**
 * How much one drain can move. One buffer per terminal, allocated at spawn.
 *
 * Derived from three measured numbers rather than picked. The emulator's curve is
 * flat past 1 MB — 8 KB writes sustain ~6 MB/s, 64 KB ~32 MB/s, 1 MB ~140 MB/s —
 * so a smaller buffer buys nothing but lost throughput and a larger one buys
 * nothing at all. At the 133 MB/s the native reader sustains, one
 * `COALESCING_WINDOW_MS` frame *is* 1.06 MB, so the buffer is sized to the thing
 * it does. And the per-live-terminal memory budget is 8 MB for everything
 * including scrollback (docs/performance.md § Memory), which an 8 MB drain buffer
 * would spend on its own before the ring or a single line of history.
 *
 * The consequence is written into `PseudoTerminal.drain`: when the ring holds
 * more than this, a drain takes a buffer's worth and leaves the rest. Nothing is
 * dropped — the native side notifies its reader after every non-empty drain, so
 * the next frame gets the next megabyte.
 */
export const DRAIN_BUFFER_SIZE = 1024 * 1024;

/**
 * How long to accumulate before the daemon drains. One frame at 120 Hz.
 *
 * Lives here so it can be tuned against a benchmark rather than argued about.
 */
export const COALESCING_WINDOW_MS = 8;

/**
 * A drained chunk of PTY output.
 *
 * A `Uint8Array` view into a reusable buffer, not a copy: this is allocated once
 * per terminal and reused every frame, because allocating per drain is allocating
 * per frame on the hot path. **The view is only valid until the next drain** —
 * anything that needs to keep the bytes must copy them, and the emulator does not
 * need to.
 */
export type TerminalBytes = Uint8Array;
