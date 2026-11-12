import AppKit

/// The menu a ⌘-clicked terminal link shows when several files have its name (`token.ts:33` with
/// two `token.ts`): one item per file (nearest the root first, at most 20), at the pointer.
@MainActor
final class FileMenu: NSObject {
    static let limit = 20
    private let paths: [String]
    private let line: Int?
    private let onChoose: (String) -> Void

    init(paths: [String], line: Int?, onChoose: @escaping (String) -> Void) {
        self.paths = Array(paths.prefix(Self.limit))
        self.line = line
        self.onChoose = onChoose
    }

    /// `point` in screen coordinates.
    func show(at point: NSPoint) {
        let menu = NSMenu(title: "Open file")
        menu.autoenablesItems = false
        let header = NSMenuItem(title: "Several files match", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        for (i, path) in paths.enumerated() {
            let item = NSMenuItem(title: line.map { "\(path):\($0)" } ?? path, action: #selector(chose(_:)), keyEquivalent: "")
            item.target = self
            item.tag = i
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: point, in: nil)
    }

    @objc private func chose(_ item: NSMenuItem) {
        guard paths.indices.contains(item.tag) else { return }
        onChoose(paths[item.tag])
    }
}
