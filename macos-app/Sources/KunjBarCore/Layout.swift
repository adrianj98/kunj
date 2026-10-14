// How Organize Windows splits a screen between a worktree's editor and terminal windows.

public enum Layout: String, CaseIterable, Codable, Sendable {
    case editorLeft
    case editorRight
    case editorAbove
}
