import Foundation

/// One unit on the wire.
///
/// Length-prefixed rather than delimited, because terminal payloads are arbitrary
/// bytes and there is no byte we could reserve as a separator.
///
/// ```text
/// ┌────────────┬─────────┬──────────────────────┐
/// │ length u32 │ kind u8 │ payload              │
/// │ big-endian │         │ JSON, or raw bytes   │
/// └────────────┴─────────┴──────────────────────┘
/// ```
///
/// `length` counts the payload only. See docs/decisions/0016-daemon-protocol.md.
public struct Frame: Hashable, Sendable {

    /// What the payload is, so a reader knows whether to decode it.
    ///
    /// Deliberately tiny. Control traffic is rare and small, so it pays JSON's cost
    /// for readability in logs; terminal traffic is the hot path and is never
    /// encoded at all. A third high-frequency kind would be a design smell worth an
    /// argument first.
    public enum Kind: UInt8, Hashable, Sendable, CaseIterable {

        /// A `Codable` control message, JSON-encoded.
        case control = 1

        /// Terminal input, client → daemon. Raw bytes.
        case input = 2

        /// Terminal output — repaint sequences, daemon → client. Raw bytes.
        case output = 3
    }

    public var kind: Kind
    public var payload: [UInt8]

    public init(kind: Kind, payload: [UInt8]) {
        self.kind = kind
        self.payload = payload
    }

    /// Largest payload we will accept, in bytes.
    ///
    /// An unbounded length prefix read off a socket is a memory-exhaustion bug
    /// waiting for a malformed first packet. 8 MB is far above any legitimate frame
    /// — a full repaint of a very large grid is well under 1 MB — and far below
    /// anything that would hurt.
    public static let maximumPayloadLength = 8 * 1024 * 1024

    /// Bytes of framing overhead ahead of every payload.
    public static let headerLength = 5
}

/// What went wrong reading a frame.
///
/// Every case here is fatal to the *connection* and to nothing else. A daemon that
/// dies because one client sent nonsense would take the user's terminals with it.
public enum FrameError: Error, Hashable, Sendable {

    /// `length` exceeded `Frame.maximumPayloadLength`.
    case payloadTooLarge(claimed: Int)

    /// The `kind` byte is not one we know. Not forward-compatible on purpose: a
    /// peer that speaks a kind we do not know has failed the handshake's job.
    case unknownKind(UInt8)

    /// The peer went away mid-frame.
    case truncated(expected: Int, received: Int)
}
