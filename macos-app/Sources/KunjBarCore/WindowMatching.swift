// Which worktree a window belongs to, from its document path or its title.

import CoreGraphics
import Foundation

public struct FoundWindow: Hashable, Sendable {
    public let id: UInt32
    public let pid: pid_t
    public let kind: WindowKind
    public let title: String
    // The window's AXDocument as a path (Terminal sets it to the working directory)
    public let documentPath: String?
    // Cocoa coordinates
    public let frame: CGRect
    public let minimized: Bool

    public init(id: UInt32, pid: pid_t, kind: WindowKind, title: String, documentPath: String?, frame: CGRect, minimized: Bool) {
        self.id = id
        self.pid = pid
        self.kind = kind
        self.title = title
        self.documentPath = documentPath
        self.frame = frame
        self.minimized = minimized
    }
}

public struct WorktreeRef: Hashable, Sendable {
    public let path: String
    public let name: String

    public init(path: String, name: String) {
        self.path = path
        self.name = name
    }
}

// Windows per worktree path. A window lands in at most one bucket: its document path
// decides when it lies in a worktree (VS Code's is the open file, Terminal's the working
// directory), else its title; longer names are tried first so `feature-2` beats
// `feature`, and of two worktrees with the same name the first listed wins.
public func matchWindows(_ windows: [FoundWindow], worktrees: [WorktreeRef]) -> [String: [FoundWindow]] {
    let byLongestName = worktrees.enumerated().sorted {
        $0.element.name.count != $1.element.name.count
            ? $0.element.name.count > $1.element.name.count
            : $0.offset < $1.offset
    }.map(\.element)
    var result: [String: [FoundWindow]] = [:]
    for window in windows {
        let byDocument = window.documentPath.flatMap { document in
            byLongestName.first { document == $0.path || document.hasPrefix($0.path + "/") }
        }
        let owner = byDocument ?? byLongestName.first { titleMatches(window.title, name: $0.name) }
        if let owner { result[owner.path, default: []].append(window) }
    }
    return result
}

private let before: Set<Character> = ["/", " ", "—", "-", "[", "(", "\"", "“"]
private let after: Set<Character> = ["/", " ", "—", "]", ")", "\"", "”", ":"]

// `name` appears in the title as a whole component, not inside a longer word.
public func titleMatches(_ title: String, name: String) -> Bool {
    guard !name.isEmpty else { return false }
    var searchRange = title.startIndex..<title.endIndex
    while let range = title.range(of: name, range: searchRange) {
        let startsClean = range.lowerBound == title.startIndex || before.contains(title[title.index(before: range.lowerBound)])
        let endsClean = range.upperBound == title.endIndex || after.contains(title[range.upperBound])
        if startsClean && endsClean { return true }
        searchRange = title.index(after: range.lowerBound)..<title.endIndex
    }
    return false
}
