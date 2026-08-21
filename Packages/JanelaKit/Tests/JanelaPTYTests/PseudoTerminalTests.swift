import Darwin
import Foundation
import Testing

@testable import JanelaPTY

/// These tests run against real pseudo-terminals and real child processes.
///
/// There is no way to mock this layer usefully: the whole point of `openpty` →
/// `fork` → `login_tty` → `execve` is the kernel state it produces — a session, a
/// controlling terminal, a foreground process group — and a fake would only prove
/// our assumptions. So every test here spawns something and looks at what happened.
@Suite("Pseudo-terminal spawn")
struct PseudoTerminalTests {

    // MARK: Harness

    /// Reads from a non-blocking descriptor until `isSatisfied` accepts the bytes
    /// seen so far, or the deadline passes.
    ///
    /// - Parameters:
    ///   - descriptor: The controller descriptor, which is `O_NONBLOCK`.
    ///   - timeout: How long to keep polling before giving up.
    ///   - isSatisfied: Called with everything read so far after each successful read.
    /// - Returns: Every byte read, whether or not the predicate was satisfied.
    private func drain(
        _ descriptor: Int32,
        timeout: Duration = .seconds(5),
        until isSatisfied: ([UInt8]) -> Bool = { _ in false }
    ) async -> [UInt8] {
        var collected: [UInt8] = []
        var chunk = [UInt8](repeating: 0, count: 4096)
        let deadline = ContinuousClock.now + timeout

        while ContinuousClock.now < deadline {
            let count = chunk.withUnsafeMutableBytes { buffer in
                read(descriptor, buffer.baseAddress, buffer.count)
            }
            if count > 0 {
                collected.append(contentsOf: chunk[0..<count])
                if isSatisfied(collected) { return collected }
                continue
            }
            // 0 is EOF on a PTY whose child has gone; EAGAIN just means "not yet".
            if count == 0 { return collected }
            if errno != EAGAIN && errno != EINTR { return collected }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return collected
    }

    private func text(_ bytes: [UInt8]) -> String {
        String(decoding: bytes, as: UTF8.self)
    }

    private func configuration(
        _ path: String,
        _ arguments: String...,
        size: TerminalSize = .default
    ) -> PseudoTerminal.Configuration {
        PseudoTerminal.Configuration(
            executableURL: URL(fileURLWithPath: path),
            arguments: [path] + arguments,
            workingDirectory: URL(fileURLWithPath: "/tmp"),
            environment: ["TERM": "xterm-256color", "PATH": "/usr/bin:/bin"],
            initialSize: size
        )
    }

    /// True while the process exists at all — including as a zombie we have not
    /// reaped. `kill(_:0)` is the portable liveness probe.
    private func processExists(_ pid: pid_t) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }

    // MARK: Spawning

    @Test("A spawned child's output arrives and its exit code is reported")
    func spawnAndExit() async throws {
        let terminal = try PseudoTerminal(configuration: configuration("/bin/echo", "hello"))
        let output = await drain(await terminal.controllerDescriptor) {
            self.text($0).contains("hello")
        }
        #expect(text(output).contains("hello"))

        let code = await terminal.waitForExit()
        #expect(code == 0)
        await terminal.terminate()
    }

    @Test("A child on a PTY gets a controlling terminal and its own session")
    func controllingTerminal() async throws {
        // Without a controlling terminal `tty` prints "not a tty" and exits 1, and
        // every TUI we care about misbehaves in ways that are much harder to see.
        let terminal = try PseudoTerminal(configuration: configuration("/usr/bin/tty"))
        let output = await drain(await terminal.controllerDescriptor) {
            self.text($0).contains("/dev/")
        }
        #expect(text(output).contains("/dev/ttys"))
        #expect(await terminal.waitForExit() == 0)
        await terminal.terminate()
    }

    @Test("A nonexistent executable fails to start rather than looking alive")
    func execFailureReachesTheParent() async {
        let missing = "/nonexistent/janela-should-not-exist"
        var failure: PseudoTerminal.Failure?
        do {
            _ = try PseudoTerminal(configuration: configuration(missing))
        } catch {
            failure = error
        }
        // A terminal that looks alive and stays empty is the failure mode this
        // guards: the error has to cross the fork boundary back to the parent.
        guard case .couldNotStart(let path, let code) = failure else {
            Issue.record("expected couldNotStart, got \(String(describing: failure))")
            return
        }
        #expect(path == missing)
        #expect(code == ENOENT)
    }

    @Test("The initial window size reaches the child")
    func initialSize() async throws {
        let terminal = try PseudoTerminal(
            configuration: configuration(
                "/bin/stty", "size", size: TerminalSize(columns: 132, rows: 43)))
        let output = await drain(await terminal.controllerDescriptor) {
            self.text($0).contains("43 132")
        }
        #expect(text(output).contains("43 132"))
        await terminal.terminate()
    }

    // MARK: Input and output

    @Test("Bytes written to the child come back through the terminal")
    func roundTrip() async throws {
        let terminal = try PseudoTerminal(configuration: configuration("/bin/cat"))
        let descriptor = await terminal.controllerDescriptor

        try await terminal.write(Array("ping\n".utf8))
        let output = await drain(descriptor) { self.text($0).contains("ping") }
        #expect(text(output).contains("ping"))

        await terminal.terminate()
        #expect(await terminal.isRunning == false)
    }

    @Test("A large write is delivered whole despite partial writes and EAGAIN")
    func largeWriteSurvivesBackPressure() async throws {
        // A PTY's input buffer is a few kilobytes, so a payload this size cannot go
        // out in one `write`: the descriptor is non-blocking, so the tail comes back
        // as EAGAIN and has to be buffered and flushed on writability. Dropping it
        // would silently lose the user's keystrokes.
        let terminal = try PseudoTerminal(configuration: configuration("/bin/cat"))
        let descriptor = await terminal.controllerDescriptor

        let line = String(repeating: "j", count: 63) + "\n"
        let payload = Array(String(repeating: line, count: 4096).utf8)  // 256 KiB
        try await terminal.write(payload)

        // `cat` echoes its input back, and the terminal layer inserts a carriage
        // return before each newline, so count the payload's own characters.
        let output = await drain(descriptor, timeout: .seconds(20)) {
            $0.count(where: { $0 == UInt8(ascii: "j") }) >= 63 * 4096
        }
        #expect(output.count(where: { $0 == UInt8(ascii: "j") }) >= 63 * 4096)

        await terminal.terminate()
    }

    @Test("Writing after the child is gone reports that it is not running")
    func writeAfterTerminate() async throws {
        let terminal = try PseudoTerminal(configuration: configuration("/bin/cat"))
        await terminal.terminate()
        await #expect(throws: PseudoTerminal.Failure.notRunning) {
            try await terminal.write(Array("ignored".utf8))
        }
    }

    @Test("Pending input is bounded rather than growing without limit")
    func pendingInputIsBounded() async throws {
        // `sleep` never reads, so everything past the kernel's buffer stays pending.
        // Terminal output is effectively infinite and so is a wedged child's input
        // backlog; the bound is what keeps the daemon's memory finite.
        let terminal = try PseudoTerminal(configuration: configuration("/bin/sleep", "30"))
        let oversize = [UInt8](repeating: UInt8(ascii: "x"), count: PseudoTerminal.maximumPendingInput + 1)
        await #expect(throws: PseudoTerminal.Failure.inputBufferFull) {
            try await terminal.write(oversize)
        }
        await terminal.terminate()
    }

    // MARK: Resize

    @Test("Resizing delivers SIGWINCH to the child")
    func resizeSignalsTheChild() async throws {
        let script = "trap 'echo GOT-WINCH' WINCH; echo ready; while true; do sleep 0.05; done"
        let terminal = try PseudoTerminal(configuration: configuration("/bin/sh", "-c", script))
        let descriptor = await terminal.controllerDescriptor

        // Wait for the trap to be installed — resizing before that races.
        let ready = await drain(descriptor, timeout: .seconds(5)) { self.text($0).contains("ready") }
        #expect(text(ready).contains("ready"))

        try await terminal.resize(to: TerminalSize(columns: 100, rows: 30))
        let signalled = await drain(descriptor, timeout: .seconds(5)) {
            self.text($0).contains("GOT-WINCH")
        }
        #expect(text(signalled).contains("GOT-WINCH"))

        await terminal.terminate()
    }

    @Test("A resize is visible to a program that asks the terminal its size")
    func resizeUpdatesTheKernelState() async throws {
        let terminal = try PseudoTerminal(configuration: configuration("/bin/sh", "-c", "cat"))
        try await terminal.resize(to: TerminalSize(columns: 120, rows: 40))

        var size = winsize()
        let result = ioctl(await terminal.controllerDescriptor, UInt(TIOCGWINSZ), &size)
        #expect(result == 0)
        #expect(size.ws_col == 120)
        #expect(size.ws_row == 40)

        await terminal.terminate()
    }

    // MARK: Signals and teardown

    @Test("Killing the terminal reaches a grandchild, not just the direct child")
    func signalReachesTheProcessGroup() async throws {
        // A shell that backgrounds a long sleep is the shape that matters: an agent
        // that spawns a build. Signalling only the direct child leaves the build
        // running, holding the worktree and the user's CPU.
        let script = "sleep 300 & echo GRANDCHILD:$!; wait"
        let terminal = try PseudoTerminal(configuration: configuration("/bin/sh", "-c", script))
        let output = await drain(await terminal.controllerDescriptor) {
            self.text($0).contains("GRANDCHILD:")
        }

        let reported = text(output)
            .split(separator: "GRANDCHILD:").last?
            .prefix(while: \.isNumber)
        let grandchild = pid_t(reported.flatMap { pid_t($0) } ?? -1)
        #expect(grandchild > 0)

        try await terminal.signal(SIGKILL)
        var deadline = 200
        while processExists(grandchild) && deadline > 0 {
            try? await Task.sleep(for: .milliseconds(10))
            deadline -= 1
        }
        #expect(processExists(grandchild) == false)

        await terminal.terminate()
    }

    @Test("Teardown closes the descriptor, reaps the child, and is idempotent")
    func teardownIsIdempotent() async throws {
        let terminal = try PseudoTerminal(configuration: configuration("/bin/cat"))
        let descriptor = await terminal.controllerDescriptor
        let child = await terminal.processIdentifier

        await terminal.terminate()
        await terminal.terminate()

        #expect(await terminal.isRunning == false)
        // A closed descriptor is the contract: the daemon must not leak one per
        // terminal, and nothing may read from it after teardown.
        #expect(fcntl(descriptor, F_GETFD) == -1)
        #expect(processExists(child) == false)
    }

    @Test("A child that exits on a signal reports a signal-shaped exit code")
    func signalledExitCode() async throws {
        let terminal = try PseudoTerminal(configuration: configuration("/bin/sleep", "30"))
        try await terminal.signal(SIGTERM)
        let code = await terminal.waitForExit()
        #expect(code == 128 + SIGTERM)
        await terminal.terminate()
    }
}
