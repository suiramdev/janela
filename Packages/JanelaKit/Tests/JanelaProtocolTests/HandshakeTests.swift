import Foundation
import Testing

@testable import JanelaProtocol

/// The handshake decides what happens when an updated app meets a daemon from the
/// previous version — while that daemon is holding the user's live terminals.
///
/// Getting this wrong is the worst bug this system can have, so the rules are
/// pinned here rather than left to the implementation.
@Suite("Protocol handshake")
struct HandshakeTests {

    private func hello(version: Int, minimum: Int) -> Hello {
        Hello(protocolVersion: version, minimumSupported: minimum, clientName: "test")
    }

    @Test("A peer speaking the same version is compatible")
    func sameVersion() {
        let client = hello(version: 1, minimum: 1)
        let daemon = hello(version: 1, minimum: 1)
        #expect(client.isCompatible(with: daemon))
        #expect(daemon.isCompatible(with: client))
    }

    @Test("A newer client is compatible with an older daemon inside its range")
    func newerClientOlderDaemon() {
        // The routine case after an app update: the daemon is still on 1 and is
        // holding live terminals, and the new app can still speak 1.
        let client = hello(version: 2, minimum: 1)
        let daemon = hello(version: 1, minimum: 1)
        #expect(client.isCompatible(with: daemon))
        #expect(daemon.isCompatible(with: client))
    }

    @Test("A client that has dropped support for the daemon's version is incompatible")
    func rangesDoNotOverlap() {
        let client = hello(version: 3, minimum: 3)
        let daemon = hello(version: 1, minimum: 1)
        #expect(client.isCompatible(with: daemon) == false)
    }

    @Test("Compatibility is symmetric")
    func symmetry() {
        let cases = [(2, 1, 1, 1), (3, 3, 1, 1), (1, 1, 4, 2), (5, 2, 3, 1)]
        for (clientVersion, clientMinimum, daemonVersion, daemonMinimum) in cases {
            let client = hello(version: clientVersion, minimum: clientMinimum)
            let daemon = hello(version: daemonVersion, minimum: daemonMinimum)
            // If either side would refuse, both must — otherwise one peer starts
            // sending messages the other has already decided it cannot read.
            #expect(client.isCompatible(with: daemon) == daemon.isCompatible(with: client))
        }
    }

    @Test("The shipped version range is self-consistent")
    func shippedRange() {
        #expect(ProtocolVersion.minimumSupported <= ProtocolVersion.current)
    }

    @Test("A credential is absent over the local socket")
    func credentialIsOptional() {
        // v1 authenticates by peer uid, not by anything in the message. The field
        // exists so adding one later is not a breaking change.
        #expect(hello(version: 1, minimum: 1).credential == nil)
    }
}

@Suite("Protocol framing")
struct FrameTests {

    @Test("Frame bounds are stated on the type, not left to the reader")
    func bounds() {
        // An unbounded length prefix read off a socket is a memory-exhaustion bug
        // waiting for a malformed first packet.
        #expect(Frame.maximumPayloadLength == 8 * 1024 * 1024)
        #expect(Frame.headerLength == 5)
    }

    @Test("Every frame kind has a distinct wire value")
    func kindsAreDistinct() {
        let values = Frame.Kind.allCases.map(\.rawValue)
        #expect(Set(values).count == values.count)
        // Zero is deliberately unused, so an all-zero buffer is never a valid frame.
        #expect(values.allSatisfy { $0 != 0 })
    }

    @Test("Terminal payloads and control payloads are different kinds")
    func terminalTrafficIsNotControlTraffic() {
        // The hot path must never be JSON: base64 inside a control frame would
        // inflate output by a third and add two passes per frame.
        #expect(Frame.Kind.input != Frame.Kind.control)
        #expect(Frame.Kind.output != Frame.Kind.control)
    }
}
