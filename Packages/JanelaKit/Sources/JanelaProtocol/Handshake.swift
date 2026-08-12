import Foundation

/// The first frame on every connection, in both directions.
///
/// Nothing else is accepted until this is exchanged. The daemon may be older or
/// newer than the client — after an app update it is routinely older, and it is
/// holding the user's live terminals while being so.
///
/// See docs/decisions/0016-daemon-protocol.md.
public struct Hello: Hashable, Sendable, Codable {

    /// Incremented on any breaking change to messages or framing.
    public var protocolVersion: Int

    /// Oldest version this peer can still speak. The overlap of the two ranges
    /// decides whether the connection proceeds.
    public var minimumSupported: Int

    /// "Janela.app", "janela-cli". Shown to the user when explaining what is
    /// connected, and logged. Never used for authorisation.
    public var clientName: String

    /// Unused over the local socket, where the OS vouches for the peer. Present
    /// from v1 because adding a field to a shipped protocol is a breaking change
    /// and this one costs nothing to carry.
    public var credential: Credential?

    public init(
        protocolVersion: Int = ProtocolVersion.current,
        minimumSupported: Int = ProtocolVersion.minimumSupported,
        clientName: String,
        credential: Credential? = nil
    ) {
        self.protocolVersion = protocolVersion
        self.minimumSupported = minimumSupported
        self.clientName = clientName
        self.credential = credential
    }

    /// Whether this peer can talk to one advertising `other`.
    public func isCompatible(with other: Hello) -> Bool {
        minimumSupported <= other.protocolVersion && other.minimumSupported <= protocolVersion
    }
}

/// Proof of identity for transports the operating system cannot vouch for.
///
/// Empty in v1 — the Unix socket authenticates by peer uid, which is stronger than
/// anything we would invent. A network transport must populate this, and must not
/// be allowed to reuse "the OS vouched for the peer".
public enum Credential: Hashable, Sendable, Codable {
    case bearerToken(String)
}

public enum ProtocolVersion {

    /// Bump on any breaking change. There is no minor version: a change is either
    /// compatible, in which case it needs no number, or it is not.
    public static let current = 1

    /// Oldest version we still accept. Equal to `current` until there is a second
    /// version to be compatible with.
    public static let minimumSupported = 1
}

/// Why a connection was refused.
///
/// Refusal never terminates the daemon or its terminals. The client explains the
/// situation and offers a restart; see docs/decisions/0017-daemon-lifecycle.md.
public enum HandshakeRefusal: Error, Hashable, Sendable, Codable {

    /// No overlap between the two version ranges. Carries the daemon's range so the
    /// client can say "the running service is older" rather than "handshake failed".
    case incompatibleVersion(daemonSupports: ClosedRange<Int>)

    /// The peer's uid is not ours. Logged with the pid, never explained to the peer
    /// in detail.
    case unauthorized

    /// A frame arrived before the handshake completed.
    case protocolViolation
}
