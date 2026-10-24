import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct FileAccessTests {
    @Test func readWriteWorktree() async throws {
        let dir = try tempDirectory()
        let env = diffTestEnvironment(path: dir.path)
        let files = FileAccess(cli: fakeKunjCLI())

        try await files.write(env: env, path: "src/a.ts", content: "let a = 1\n")
        #expect(try await files.read(env: env, path: "src/a.ts") == "let a = 1\n")
        try await files.write(env: env, path: "src/a.ts", content: "let a = 2\n")
        #expect(try await files.read(env: env, path: "src/a.ts") == "let a = 2\n")

        for bad in ["../x", "/etc/passwd", "src/../../x", "", "."] {
            await #expect(throws: FileAccessError.badPath) { _ = try await files.read(env: env, path: bad) }
            await #expect(throws: FileAccessError.badPath) { try await files.write(env: env, path: bad, content: "") }
        }
        await #expect(throws: FileAccessError.notFound) { _ = try await files.read(env: env, path: "missing.txt") }
    }

    @Test func writeKeepsTheFileMode() async throws {
        let dir = try tempDirectory()
        let script = dir.appendingPathComponent("run.sh")
        try "#!/bin/sh\n".write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        try await FileAccess(cli: fakeKunjCLI()).write(env: diffTestEnvironment(path: dir.path), path: "run.sh",
                                                       content: "#!/bin/sh\necho hi\n")
        let mode = try FileManager.default.attributesOfItem(atPath: script.path)[.posixPermissions] as? Int
        #expect(mode == 0o755)
    }

    @Test func containerGoesThroughKunjCtFile() async throws {
        let dir = try tempDirectory()
        let stdinLog = dir.appendingPathComponent("stdin.txt")
        let callLog = dir.appendingPathComponent("calls.txt")
        // Records what kunj got on stdin, then answers as fake-kunj
        let wrapper = dir.appendingPathComponent("kunj-wrapper")
        try "#!/bin/sh\ncat > \"$STDIN_LOG\"\nexec \"\(fakeKunjPath)\" \"$@\"\n"
            .write(to: wrapper, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: wrapper.path)
        let cli = KunjCLI(command: "env \"STDIN_LOG=\(stdinLog.path)\" \"FAKE_KUNJ_LOG=\(callLog.path)\" \"\(wrapper.path)\"",
                          path: "/usr/bin:/bin")
        let env = diffTestEnvironment(kind: .container, branch: "feature/x", path: dir.path)
        let files = FileAccess(cli: cli)

        #expect(try await files.read(env: env, path: "src/a.ts") == "export const a = 1;\n")
        try await files.write(env: env, path: "src/a.ts", content: "export const a = 2;\n")
        #expect(try String(contentsOf: stdinLog, encoding: .utf8) == "export const a = 2;\n")
        let calls = try String(contentsOf: callLog, encoding: .utf8).split(separator: "\n").map {
            String($0.split(separator: "\t", maxSplits: 1)[1])
        }
        #expect(calls == ["ct file read feature/x src/a.ts --json", "ct file write feature/x src/a.ts --json"])
        await #expect(throws: FileAccessError.badPath) { _ = try await files.read(env: env, path: "../x") }
    }

    @Test func containerErrorsMapToFileAccessErrors() async throws {
        let dir = try tempDirectory()
        try #"{"error":{"code":"not-found","message":"No such file: /workspace/gone.ts"}}"#
            .write(to: dir.appendingPathComponent("ct_file_read_feature-x_gone.ts.json"), atomically: true, encoding: .utf8)
        try #"{"error":{"code":"bad-path","message":"outside /workspace"}}"#
            .write(to: dir.appendingPathComponent("ct_file_read_feature-x_link.json"), atomically: true, encoding: .utf8)
        let files = FileAccess(cli: fakeKunjCLI(environment: ["FAKE_KUNJ_RESPONSES": dir.path]))
        let env = diffTestEnvironment(kind: .container, branch: "feature/x", path: dir.path)
        await #expect(throws: FileAccessError.notFound) { _ = try await files.read(env: env, path: "gone.ts") }
        await #expect(throws: FileAccessError.badPath) { _ = try await files.read(env: env, path: "link") }
    }

    @Test func digestIsStable() {
        #expect(digest("a") == digest("a"))
        #expect(digest("a") != digest("b"))
        #expect(digest("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        #expect(FileAccess(cli: fakeKunjCLI()).digest("abc") == digest("abc"))
    }
}
