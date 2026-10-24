import CryptoKit
import Foundation

public enum FileAccessError: Error, Equatable {
    /// Absolute, empty, or with a `..` component (or kunj's `bad-path`)
    case badPath
    /// No such file, a worktree that is gone, or kunj's `not-found`
    case notFound
}

/// Reads and writes an environment's files by their path relative to its root: the worktree on
/// disk, or `/workspace` of a branch container through `kunj ct file read|write` (which runs as the
/// sandbox user and checks the path again). The path always comes from Swift (the diff list or an
/// open tab), never from a web view.
public struct FileAccess: Sendable {
    public let cli: KunjCLI

    public init(cli: KunjCLI) {
        self.cli = cli
    }

    public func read(env: Environment, path: String) async throws -> String {
        let path = try checkedPath(path)
        switch env.kind {
        case .worktree:
            let url = try worktreeURL(env, path)
            // Only a regular file (a symlink to one is followed): a fifo blocks and a device never ends
            let type = (try? FileManager.default.attributesOfItem(atPath: url.resolvingSymlinksInPath().path))?[.type]
            guard type as? FileAttributeType == .typeRegular else { throw FileAccessError.notFound }
            let data: Data
            do {
                data = try Data(contentsOf: url)
            } catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {
                throw FileAccessError.notFound
            } catch let error as CocoaError where error.code == .fileReadUnknown {
                // A directory, or the file vanished between the listing and the read
                throw FileAccessError.notFound
            }
            return String(decoding: data, as: UTF8.self)
        case .container:
            do {
                let result: FileReadJson = try await cli.run(["ct", "file", "read", env.branch, path], cwd: env.repo.root)
                return result.content
            } catch let error as KunjCLIError {
                throw mapped(error)
            }
        }
    }

    /// Writes `content` atomically. In a worktree a symlink is written through (the link stays a
    /// link), missing directories are created and an existing file keeps its mode.
    public func write(env: Environment, path: String, content: String) async throws {
        let path = try checkedPath(path)
        switch env.kind {
        case .worktree:
            let url = try worktreeURL(env, path).resolvingSymlinksInPath()
            let fm = FileManager.default
            let mode = (try? fm.attributesOfItem(atPath: url.path))?[.posixPermissions]
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(content.utf8).write(to: url, options: .atomic)
            if let mode { try? fm.setAttributes([.posixPermissions: mode], ofItemAtPath: url.path) }
        case .container:
            do {
                let _: FileWriteJson = try await cli.run(["ct", "file", "write", env.branch, path], cwd: env.repo.root,
                                                         stdin: Data(content.utf8))
            } catch let error as KunjCLIError {
                throw mapped(error)
            }
        }
    }

    /// SHA-256 of the text as hex: what an editor tab compares to see that the file changed on disk.
    public func digest(_ s: String) -> String {
        KunjWorkspaceCore.digest(s)
    }

    private func worktreeURL(_ env: Environment, _ path: String) throws -> URL {
        guard env.exists, let root = env.path else { throw FileAccessError.notFound }
        return URL(fileURLWithPath: root).appendingPathComponent(path)
    }

    private func mapped(_ error: KunjCLIError) -> Error {
        switch error.kunjCode {
        case "not-found": return FileAccessError.notFound
        case "bad-path": return FileAccessError.badPath
        default: return error
        }
    }
}

/// SHA-256 hex of `s`'s UTF-8 bytes.
public func digest(_ s: String) -> String {
    SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
}

/// A path relative to the environment's root with no `..` (and no NUL); `./a` becomes `a`.
func checkedPath(_ path: String) throws -> String {
    guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\0") else {
        throw FileAccessError.badPath
    }
    let parts = path.split(separator: "/", omittingEmptySubsequences: true).filter { $0 != "." }
    guard !parts.isEmpty, !parts.contains("..") else { throw FileAccessError.badPath }
    return parts.joined(separator: "/")
}
