import AppKit
import KunjWorkspaceCore

/// The menu go to declaration shows when several lines could declare the word: one item per
/// candidate (`path:line` over the line's text, best first, at most 20), at the pointer.
@MainActor
final class DefinitionMenu: NSObject {
    static let limit = 20
    private let candidates: [DefinitionCandidate]
    private let onChoose: (DefinitionCandidate) -> Void
    private let word: String

    init(word: String, candidates: [DefinitionCandidate], onChoose: @escaping (DefinitionCandidate) -> Void) {
        self.word = word
        self.candidates = Array(candidates.prefix(Self.limit))
        self.onChoose = onChoose
    }

    /// `point` in screen coordinates.
    func show(at point: NSPoint) {
        let menu = NSMenu(title: "Declarations of \(word)")
        menu.autoenablesItems = false
        let header = NSMenuItem(title: "Declarations of \(word)", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        for (i, c) in candidates.enumerated() {
            let item = NSMenuItem(title: "\(c.path):\(c.line)", action: #selector(chose(_:)), keyEquivalent: "")
            item.target = self
            item.tag = i
            let text = c.text.count > 80 ? String(c.text.prefix(80)) + "…" : c.text
            let title = NSMutableAttributedString(string: "\(c.path):\(c.line)\n",
                                                  attributes: [.font: NSFont.menuFont(ofSize: 0)])
            title.append(NSAttributedString(string: text, attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular),
                .foregroundColor: NSColor.secondaryLabelColor,
            ]))
            item.attributedTitle = title
            item.toolTip = c.text
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: point, in: nil)
    }

    @objc private func chose(_ item: NSMenuItem) {
        guard candidates.indices.contains(item.tag) else { return }
        onChoose(candidates[item.tag])
    }
}
