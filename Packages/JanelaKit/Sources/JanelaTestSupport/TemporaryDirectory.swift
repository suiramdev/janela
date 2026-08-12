import Foundation

/// A directory that deletes itself when it goes out of scope.
///
/// Tests that touch the filesystem must use this. A test that writes to a fixed
/// path is a test that fails when run in parallel, and `swift test` runs in
/// parallel by default.
public final class TemporaryDirectory: @unchecked Sendable {

    public let url: URL

    public init(function: String = #function) throws {
        let name = "janela-tests-\(function.prefix(40))-\(UUID().uuidString.prefix(8))"
            .replacingOccurrences(of: "/", with: "-")
        url = URL(filePath: NSTemporaryDirectory()).appending(path: name)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    deinit {
        try? FileManager.default.removeItem(at: url)
    }

    public func appending(_ component: String) -> URL {
        url.appending(path: component)
    }
}
