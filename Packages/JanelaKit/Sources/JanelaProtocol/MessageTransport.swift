import Foundation

/// A bidirectional stream of frames.
///
/// The one abstraction that makes a remote client possible without redesigning the
/// protocol. A Unix domain socket implements it today; a TLS connection implements
/// it later, and nothing above this type learns which.
///
/// This is deliberately the *only* speculative generality in the protocol layer —
/// see docs/decisions/0016-daemon-protocol.md, which is honest about that being a
/// cost rather than pretending it is free.
public protocol MessageTransport: Sendable {

    /// Frames as they arrive, in order.
    ///
    /// The sequence finishes when the peer disconnects cleanly, and throws when it
    /// does not. Both are ordinary outcomes: a client quitting is not an error, and
    /// a client crashing is not fatal to anyone else.
    var incoming: AsyncThrowingStream<Frame, any Error> { get }

    /// Sends one frame.
    ///
    /// Back-pressure is the implementation's business, and it must be bounded:
    /// a stalled peer may not grow a queue without limit, and dropping *coalesced
    /// repaints* is safe in a way dropping terminal input never is. See
    /// docs/performance.md § Terminal throughput.
    func send(_ frame: Frame) async throws

    /// Closes the connection. Idempotent.
    func close() async
}

/// Turns messages into frames and back.
///
/// Free functions rather than methods on the message types, because the encoding is
/// a property of the *protocol version*, not of the message. When version 2 encodes
/// control frames differently, this is the only place that changes.
public enum MessageCoder {

    /// JSON, for the reason given in ADR 0016: control traffic is rare and small,
    /// and a frame you can read in a log is worth more than the bytes it costs.
    public static func encode(_ message: ClientMessage) throws -> Frame {
        Frame(kind: .control, payload: [UInt8](try JSONEncoder().encode(message)))
    }

    public static func encode(_ message: DaemonMessage) throws -> Frame {
        Frame(kind: .control, payload: [UInt8](try JSONEncoder().encode(message)))
    }

    public static func decodeClientMessage(_ frame: Frame) throws -> ClientMessage {
        try JSONDecoder().decode(ClientMessage.self, from: Data(frame.payload))
    }

    public static func decodeDaemonMessage(_ frame: Frame) throws -> DaemonMessage {
        try JSONDecoder().decode(DaemonMessage.self, from: Data(frame.payload))
    }

    // TODO: `input` and `output` frames bypass this entirely — they carry raw bytes
    // with the terminal id in a small fixed-width header, because base64 inside
    // JSON would inflate the hot path by a third and add two passes per frame.
    // Encode that header here so both sides agree in one place.
}
