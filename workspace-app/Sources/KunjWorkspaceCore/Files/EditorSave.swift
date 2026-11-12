import Foundation

/// What saving an editor tab does, decided from the file as it is on disk now.
public enum SaveDecision: Equatable, Sendable {
    /// The file is as it was when the tab opened it: write.
    case write
    /// The file already holds exactly the content being saved: nothing to write.
    case alreadySaved
    /// The file changed (or was deleted) since the tab opened it: ask before overwriting.
    case conflict(deleted: Bool)
}

/// `onDisk` is the file's text now, nil when it is gone; `openedDigest` the digest of the text the
/// tab opened (or last saved); `content` what is being saved.
public func saveDecision(onDisk: String?, openedDigest: String, content: String) -> SaveDecision {
    guard let onDisk else { return .conflict(deleted: true) }
    let now = digest(onDisk)
    if now == openedDigest { return .write }
    if now == digest(content) { return .alreadySaved }
    return .conflict(deleted: false)
}

/// What saving without a person to ask does (save on focus loss): a conflict is left unsaved, the
/// tab stays dirty and the next ⌘S asks.
public func savesUnattended(_ decision: SaveDecision) -> Bool {
    if case .conflict = decision { return false }
    return true
}

/// Whether an editor tab takes the file's text from disk again: only a tab without unsaved edits,
/// when the file differs from what it opened (or last saved) and can still be edited here.
public func reloadsFromDisk(onDisk: String, openedDigest: String, dirty: Bool) -> Bool {
    !dirty && digest(onDisk) != openedDigest && editorRefusal(onDisk) == nil
}

/// An editor tab's pill title: the file name.
public func editorTabTitle(_ path: String) -> String {
    path.split(separator: "/").last.map(String.init) ?? path
}

/// The largest file an editor tab opens (Monaco slows down well before this; the text also crosses
/// into the web view as one string).
public let maxEditableBytes = 5 * 1024 * 1024

/// Why a file's text cannot be edited in a tab (nil: it can). A NUL byte means a binary file, and a
/// U+FFFD a file that was not UTF-8 (Latin-1, UTF-16): `FileAccess` and `kunj ct file read` decode
/// lossily, so saving either would corrupt it. (A UTF-8 file that really contains U+FFFD is refused
/// too; better than writing replacement characters over someone's bytes.)
public func editorRefusal(_ text: String) -> String? {
    if text.utf8.count > maxEditableBytes { return "This file is too large to edit here (over 5 MB)" }
    if text.utf8.contains(0) { return "This looks like a binary file" }
    if text.unicodeScalars.contains("\u{FFFD}") { return "This file is not UTF-8 text" }
    return nil
}
