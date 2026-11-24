// What a line of `kunj events --json` (`EventJson` in src/lib/json-types.ts) means for the panel:
// refresh or nothing. The stream itself is in KunjBar/CLI/EventStream.swift.

import Foundation

public enum EventReaction: Equatable, Sendable {
    case ignore
    /// List the repositories again (debounced by the caller)
    case refresh
}

/// The reaction to one NDJSON line. `afterRestart` is true when the line comes from a stream
/// that replaced an earlier one, whose `hello` must refresh because events from the gap are lost.
public func eventReaction(line: String, afterRestart: Bool) -> EventReaction {
    guard let data = line.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = object["type"] as? String else { return .ignore }
    switch type {
    case "hello":
        return afterRestart ? .refresh : .ignore
    case "container":
        // Every kunj container on the daemon is reported; one of a repository not watched has no repo
        return object["repo"] is [String: Any] ? .refresh : .ignore
    case "git", "forwards", "agent", "backend":
        return .refresh
    default:
        // `repos` is covered by the repos.json watcher, whose refresh restarts the stream only when
        // the set of repositories changed (`kunj worktree list` rewrites the file for `lastSeen`);
        // `sessions` is covered by the worktree-sessions.json watcher; unknown types are newer than this app
        return .ignore
    }
}
