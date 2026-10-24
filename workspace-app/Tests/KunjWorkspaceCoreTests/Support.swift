import Foundation
@testable import KunjWorkspaceCore

// Shared test support: fixture paths and the fake kunj CLI (Tests/Fixtures/fake-kunj).
// fakeKunjCLI() is a KunjCLI pointed at `fakeKunjPath`.

/// workspace-app/ (this file is workspace-app/Tests/KunjWorkspaceCoreTests/Support.swift)
let appRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()

/// The kunj repository (workspace-app's parent), for docs/workspace-app/design/tokens.json.
let repoRoot = appRoot.deletingLastPathComponent()

/// Tests/Fixtures
let fixturesDir = appRoot.appendingPathComponent("Tests/Fixtures")

/// Tests/Fixtures/responses: the canned `kunj … --json` outputs fake-kunj answers from.
let responsesDir = fixturesDir.appendingPathComponent("responses")

/// Tests/Fixtures/fake-kunj, an executable `sh` script standing in for kunj.
let fakeKunjPath = fixturesDir.appendingPathComponent("fake-kunj").path

/// The response file name (without `.json`) fake-kunj reads for `args`; the same rule as the
/// script's header: `--json` dropped, a leading `--` stripped, `/` → `-`, joined with `_`.
func fakeKunjResponseName(_ args: [String]) -> String {
    args.filter { $0 != "--json" }
        .map { a -> String in
            let s = a.hasPrefix("--") ? String(a.dropFirst(2)) : a
            return s.replacingOccurrences(of: "/", with: "-")
        }
        .joined(separator: "_")
}

/// A new empty directory under the system temp dir, removed by the OS eventually.
func tempDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("kunj-workspace-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// Runs fake-kunj directly (no KunjCLI) and returns its stdout and exit status. `environment`
/// is added to the test process's environment.
func runFakeKunj(_ args: [String], environment: [String: String] = [:], cwd: URL? = nil) throws
    -> (stdout: String, exit: Int32)
{
    let p = Process()
    p.executableURL = URL(fileURLWithPath: fakeKunjPath)
    p.arguments = args
    p.environment = ProcessInfo.processInfo.environment.merging(environment) { $1 }
    if let cwd { p.currentDirectoryURL = cwd }
    let out = Pipe()
    p.standardOutput = out
    p.standardInput = FileHandle.nullDevice
    try p.run()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (String(decoding: data, as: UTF8.self), p.terminationStatus)
}

/// A KunjCLI whose command is fake-kunj, with `environment` passed through `env K=V …` in the
/// command itself (so tests never change the test process's environment). `path` is what the
/// runner hands to the child as PATH; fake-kunj only needs the system tools.
func fakeKunjCLI(environment: [String: String] = [:], path: String = "/usr/bin:/bin") -> KunjCLI {
    KunjCLI(command: fakeKunjCommand(environment: environment), path: path)
}

/// The command string for fake-kunj with `environment` set (double quotes as splitArguments reads them).
func fakeKunjCommand(environment: [String: String] = [:]) -> String {
    let vars = environment.sorted { $0.key < $1.key }.map { "\"\($0.key)=\($0.value)\"" }
    return (vars.isEmpty ? [] : ["env"] + vars).joined(separator: " ")
        + (vars.isEmpty ? "" : " ") + "\"\(fakeKunjPath)\""
}
