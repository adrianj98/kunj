import AppKit
import KunjWorkspaceCore

/// One editor tab of the left column: a file of an environment (a path relative to the worktree or
/// to `/workspace`) open in the shared editor page (`MonacoWebView(mode: "editor")`, one Monaco
/// model per tab, keyed by `id`). Swift holds the path; the page only ever sends the id back, so
/// nothing in a web view can steer a read or a write.
@MainActor
final class EditorTab: WorkspaceTab {
    /// `"<envId>#editor#<n>"`
    let id: String
    /// Changes when the worktree checks out another branch (`TabRegistry.move`).
    var env: Environment
    let path: String
    let kind = TabKind.editor
    var title: String
    var envId: String { env.id }
    /// The text differs from what was opened or last saved (the page's `dirty` message).
    var dirty = false
    /// Digest of the text opened or last saved: the file on disk is compared with it before a save.
    private(set) var openedDigest = ""
    /// The file's text reached the page.
    private(set) var loaded = false
    var running: Bool { true }

    private let access: FileAccess
    private let page: MonacoWebView
    /// A spot to show once the file reached the page (a search match opened before it loaded).
    private var pendingReveal: (line: Int, column: Int, length: Int)?

    init(id: String, env: Environment, path: String, access: FileAccess, page: MonacoWebView) {
        self.id = id
        self.env = env
        self.path = path
        self.access = access
        self.page = page
        title = editorTabTitle(path)
    }

    enum EditorError: Error, CustomStringConvertible {
        case refused(String)
        case pageFailed
        var description: String {
            switch self {
            case .refused(let reason): return reason
            case .pageFailed: return "The editor did not respond"
            }
        }
    }

    /// Reads the file and gives it to the page (also after the page reloaded, which loses its models).
    func load() async throws {
        let text = try await access.read(env: env, path: path)
        if let reason = editorRefusal(text) { throw EditorError.refused(reason) }
        guard await page.call("openFile", ["id": id, "content": text, "language": "", "path": path]) != nil else {
            throw EditorError.pageFailed
        }
        openedDigest = digest(text)
        seenModified = modified
        dirty = false
        loaded = true
        if let spot = pendingReveal {
            pendingReveal = nil
            reveal(line: spot.line, column: spot.column, length: spot.length)
        }
    }

    /// Shows this tab's file at `line`, with the match (`length` characters from `column`) selected;
    /// before the file loaded, once it has.
    func reveal(line: Int, column: Int, length: Int) {
        guard loaded else { pendingReveal = (line, column, length); return }
        Task { await page.call("revealLine", ["id": id, "line": line, "column": column, "length": length]) }
    }

    /// Shows this tab's file in the page.
    func show() {
        guard loaded else { return }
        Task { await page.call("showFile", ["id": id]) }
    }

    /// Removes the file's model from the page.
    func discard() {
        loaded = false
        Task { await page.call("closeFile", ["id": id]) }
    }

    /// The file's modification time when it was last compared with the tab (a worktree's file only).
    private var seenModified: Date?
    private var reloading = false
    private var saving = false

    /// The file's modification time; nil in a container (its files are not on this Mac) or when gone.
    private var modified: Date? {
        guard env.kind != .container, let root = env.path else { return nil }
        return (try? FileManager.default.attributesOfItem(atPath: root + "/" + path))?[.modificationDate] as? Date
    }

    /// Takes the file's text from disk again when it changed there and the tab has no unsaved
    /// edits (an agent or a `git checkout` rewrote it), keeping the cursor and scroll position.
    /// `ifTouched`: only when the modification time moved since the last look (the 2 s check of
    /// the tab on screen, which must not read the file each time); a container's file has none.
    func reloadIfChanged(ifTouched: Bool = false) async {
        guard loaded, !dirty, !reloading, !saving else { return }
        let stamp = modified
        if ifTouched, stamp == nil || stamp == seenModified { return }
        reloading = true
        defer { reloading = false }
        guard let text = try? await access.read(env: env, path: path) else { return }
        seenModified = stamp
        guard loaded, !saving, reloadsFromDisk(onDisk: text, openedDigest: openedDigest, dirty: dirty) else { return }
        // the page refuses when an edit arrived meanwhile; a language server hears of the new text
        // from the page, like any edit
        guard await page.call("reloadFile", ["id": id, "content": text]) as? Bool == true else { return }
        openedDigest = digest(text)
        log("reloaded \(path) in \(env.id): it changed on disk")
    }

    /// Saves the page's text. The file is read again first: when it changed on disk since it was
    /// opened (and does not already hold this text), an alert asks before overwriting it. Returns
    /// false when nothing was saved (cancelled or failed; a failure shows an alert). Not
    /// `interactive` (save on focus loss): nobody is asked, so a conflict or a failure leaves the
    /// tab unsaved, and the next ⌘S asks.
    func save(interactive: Bool = true) async -> Bool {
        guard loaded else { return false }
        if saving {
            // ⌘S while a save on focus loss is under way: saved again after it, with what was typed since
            if interactive { saveAgain = true }
            return false
        }
        saving = true
        defer { saving = false }
        var saved = await write(interactive: interactive)
        while saveAgain {
            saveAgain = false
            saved = await write(interactive: true)
        }
        return saved
    }
    private var saveAgain = false

    /// A save nobody asked for must not write now: the tab was closed meanwhile, or an alert is up
    /// (the close, quit and close-session prompts ask what to do with this very text, and opening
    /// one is itself a loss of focus).
    private var unattendedSaveHeld: Bool { !loaded || NSApp.modalWindow != nil }

    private func write(interactive: Bool) async -> Bool {
        guard loaded else { return false }
        do {
            guard let result = await page.call("getContent", ["id": id]) as? [String: Any],
                  let content = result["content"] as? String, let version = result["version"]
            else { throw EditorError.pageFailed }
            let onDisk: String?
            do {
                onDisk = try await access.read(env: env, path: path)
            } catch FileAccessError.notFound {
                onDisk = nil
            }
            let decision = saveDecision(onDisk: onDisk, openedDigest: openedDigest, content: content)
            guard loaded else { return false } // closed while the file was read
            guard interactive || savesUnattended(decision) else {
                log("not saved on focus loss: \(path) in \(env.id) changed on disk")
                return false
            }
            guard interactive || !unattendedSaveHeld else { return false }
            switch decision {
            case .conflict(let deleted):
                guard confirmOverwrite(deleted: deleted) else { return false }
                try await access.write(env: env, path: path, content: content)
            case .write:
                try await access.write(env: env, path: path, content: content)
            case .alreadySaved:
                break
            }
            openedDigest = digest(content)
            seenModified = modified
            await page.call("markSaved", ["id": id, "version": version])
            log("saved \(path) in \(env.id)")
            return true
        } catch {
            guard interactive else {
                log("not saved on focus loss: \(path) in \(env.id): \(error)")
                return false
            }
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = "\(title) was not saved"
            alert.informativeText = Self.message(error)
            alert.runModal()
            return false
        }
    }

    private func confirmOverwrite(deleted: Bool) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = deleted ? "The file was deleted on disk" : "The file changed on disk"
        alert.informativeText = deleted
            ? "\(path) was deleted after you opened it. Saving creates it again with your text."
            : "\(path) changed after you opened it. Overwrite it with your text?"
        alert.addButton(withTitle: deleted ? "Save" : "Overwrite")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    /// The text for an error from reading or writing a file.
    static func message(_ error: Error) -> String {
        switch error {
        case let e as FileAccessError: return e == .notFound ? "The file is gone" : "That path cannot be used"
        case let e as KunjCLIError: return e.message
        case let e as EditorError: return e.description
        default: return error.localizedDescription
        }
    }
}
