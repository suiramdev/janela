import Foundation
import JanelaSupport

/// Where the daemon listens, and who is allowed to talk to it.
///
/// Two unglamorous constraints shape everything here, and both are easy to get
/// wrong in a way that only fails on someone else's machine.
public enum DaemonEndpoint {

    /// Maximum bytes in `sockaddr_un.sun_path`, measured on macOS 26.2.
    ///
    /// This is why the socket does not live beside the database in Application
    /// Support: that path is already 73 bytes for a 15-character home directory and
    /// grows with the username, which leaves too little headroom. See
    /// docs/decisions/0016-daemon-protocol.md.
    public static let maximumPathLength = 104

    /// `~/.janela/run/janelad.sock` — 40 bytes for a typical home directory.
    ///
    /// - Returns: The socket path, guaranteed to fit in `sun_path`.
    /// - Throws: `UserFacingError` when the home directory is long enough that even
    ///   this path does not fit, which is a real if rare condition and a much better
    ///   failure than a truncated path silently connecting to the wrong place.
    public static func defaultSocketURL() throws -> URL {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: ".janela/run/janelad.sock")

        let byteCount = url.path(percentEncoded: false).utf8.count
        guard byteCount < maximumPathLength else {
            throw SocketPathTooLong(byteCount: byteCount)
        }
        return url
    }

    /// Mode for the directory containing the socket.
    ///
    /// The socket is a capability: anything that can connect can start processes as
    /// this user. `0700` on the directory is the primary defence, and the peer-uid
    /// check below is the second.
    public static let directoryMode: Int16 = 0o700

    // TODO: Verify the peer with getsockopt(SOL_LOCAL, LOCAL_PEERCRED) and reject
    // any connection whose `cr_uid` is not getuid(). `struct xucred` is 76 bytes on
    // macOS 26.2 and its `cr_version` must equal XUCRED_VERSION before any other
    // field is trusted. Record LOCAL_PEERPID for the log only — a pid is reusable
    // and must never be an authorisation input.
    //
    // This is not an escalation boundary (a process running as the user could
    // already run anything as the user), but it is the boundary that keeps a
    // different user on a shared Mac out. See docs/decisions/0016-daemon-protocol.md.
}

/// The home directory is long enough that even the short socket path does not fit.
///
/// Rare, and worth failing loudly for: a truncated `sun_path` does not error, it
/// silently addresses a *different* socket, which is a far worse outcome than not
/// starting.
struct SocketPathTooLong: UserFacingError {
    let byteCount: Int

    var summary: String {
        "Janela can't create its background service socket."
    }

    var reason: String? {
        """
        The socket path is \(byteCount) bytes and the system limit is \
        \(DaemonEndpoint.maximumPathLength).
        """
    }

    var recoverySuggestion: String? {
        "This can happen when your home directory path is unusually long."
    }
}
