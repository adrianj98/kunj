import Foundation

// LSP's base protocol: `Content-Length: <n>\r\n\r\n<n bytes of JSON>` (docs/specs/language-servers.md).

/// One message with its header, ready to write to a server's stdin.
public func lspFrame(_ body: Data) -> Data {
    var out = Data("Content-Length: \(body.count)\r\n\r\n".utf8)
    out.append(body)
    return out
}

/// Splits a server's stdout into message bodies: a frame may arrive in pieces, and several in one read.
public struct LspFrameReader: Sendable {
    private var buffer = Data()
    /// Largest message accepted (a bigger Content-Length is treated as garbage and dropped).
    public static let maxBody = 64 * 1024 * 1024

    public init() {}

    public mutating func append(_ data: Data) { buffer.append(data) }

    /// The next complete body, or nil when more bytes are needed.
    public mutating func next() -> Data? {
        let separator = Data("\r\n\r\n".utf8)
        while true {
            guard let end = buffer.range(of: separator) else { return nil }
            let header = String(decoding: buffer[buffer.startIndex..<end.lowerBound], as: UTF8.self)
            var length: Int?
            for line in header.split(separator: "\r\n") {
                let parts = line.split(separator: ":", maxSplits: 1)
                if parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" {
                    length = Int(parts[1].trimmingCharacters(in: .whitespaces))
                }
            }
            guard let n = length, n >= 0, n <= Self.maxBody else {
                // not a header we understand: drop it and look for the next one
                buffer.removeSubrange(buffer.startIndex..<end.upperBound)
                continue
            }
            let bodyStart = end.upperBound
            guard buffer.distance(from: bodyStart, to: buffer.endIndex) >= n else { return nil }
            let bodyEnd = buffer.index(bodyStart, offsetBy: n)
            let body = Data(buffer[bodyStart..<bodyEnd])
            buffer.removeSubrange(buffer.startIndex..<bodyEnd)
            return body
        }
    }
}
