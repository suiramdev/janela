import Darwin
import Foundation
import JanelaSupport

/// A chunk of bytes read from a PTY.
///
/// Deliberately a `ContiguousArray<UInt8>` rather than `Data`: we allocate one of
/// these per read and `Data`'s bridging machinery is measurable when a build log
/// is scrolling at tens of MB/s.
public typealias TerminalBytes = ContiguousArray<UInt8>

/// The read side of a PTY, delivered as a back-pressured async sequence.
///
/// ## Bytes may never be dropped
///
/// A terminal stream is stateful. Dropping bytes does not lose a line of output,
/// it truncates an escape sequence and desynchronises the parser — colours stick,
/// the cursor lands in the wrong place, the alternate screen never exits. So
/// "shed load when we fall behind" is not available to us.
///
/// The correct mechanism is to **stop reading**. When the pending buffer passes
/// the high-water mark we do not re-arm the PTY read; the kernel's PTY buffer
/// fills, and the child blocks in `write(2)` exactly as it would against a slow
/// physical terminal. That is the behaviour every well-behaved CLI already
/// handles. We resume re-arming once the buffer drains to the low-water mark.
///
/// ## Rules this type enforces
///
/// 1. **Read on a dedicated `DispatchIO` channel**, not the cooperative pool. A
///    blocking read must never occupy a Swift concurrency thread.
/// 2. **Exactly one successor read per completed read operation.** `DispatchIO`
///    calls its handler repeatedly for one operation (partial deliveries with
///    `done == false`, then a final `done == true`). Re-arming on every
///    invocation multiplies the read chains and piles up hundreds of MB of
///    in-flight reads under a fast producer.
/// 3. **Close the file descriptor in the channel's cleanup handler, never
///    before.** Closing early produces `BUG IN CLIENT OF LIBDISPATCH: Unexpected
///    EV_VANISHED` — a real crash class in an app with many sessions.
/// 4. **Parse off the main actor.** Deliveries go to a per-session serial queue;
///    we cross to the main actor only to mark dirty regions, at most once per
///    frame.
/// 5. **Time-slice the drain.** Yield after `drainTimeSlice` and reschedule, so
///    one flooding session cannot starve the UI or the other sessions.
///
/// See docs/performance.md § Terminal throughput for the budgets these serve, and
/// docs/research/terminal-stack.md for the primary sources behind each rule.
public struct TerminalByteStream: AsyncSequence, Sendable {
    public typealias Element = TerminalBytes

    /// Stop re-arming the PTY read once this much undelivered data is buffered.
    public static let highWaterMark = 4 * 1024 * 1024

    /// Resume reading once the backlog drops back to this.
    public static let lowWaterMark = 1 * 1024 * 1024

    /// Per-read request size. Large enough that a flood is a handful of syscalls,
    /// small enough that an interactive keystroke echo is not delayed.
    public static let readSize = 128 * 1024

    /// How long to accumulate reads before delivering. One frame at 120 Hz; the
    /// value lives here so it can be tuned against a benchmark rather than argued
    /// about.
    public static let coalescingWindow: Duration = .milliseconds(8)

    /// Maximum time spent draining into the emulator before yielding.
    public static let drainTimeSlice: Duration = .milliseconds(4)

    public func makeAsyncIterator() -> AsyncIterator {
        AsyncIterator()
    }

    public struct AsyncIterator: AsyncIteratorProtocol {
        public mutating func next() async -> TerminalBytes? { nil }
    }
}
