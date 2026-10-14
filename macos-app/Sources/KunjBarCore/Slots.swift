// Where each kind of window goes on a screen. Cocoa coordinates (origin at the
// bottom left) in and out; axFrame converts for the Accessibility API.

import CoreGraphics

public enum WindowKind: String, CaseIterable, Codable, Sendable {
    case editor
    case terminal
}

// The slot for each enabled kind. One kind fills the visible area; two split it in
// exact halves along the layout's axis.
public func slots(for layout: Layout, kinds: Set<WindowKind>, in visible: CGRect) -> [WindowKind: CGRect] {
    if kinds.isEmpty { return [:] }
    if kinds.count == 1 { return [kinds.first!: visible] }
    let (editor, terminal): (CGRect, CGRect)
    switch layout {
    case .editorLeft:
        (editor, terminal) = visible.divided(atDistance: visible.width / 2, from: .minXEdge)
    case .editorRight:
        (terminal, editor) = visible.divided(atDistance: visible.width / 2, from: .minXEdge)
    case .editorAbove:
        (editor, terminal) = visible.divided(atDistance: visible.height / 2, from: .maxYEdge)
    }
    return [.editor: editor, .terminal: terminal]
}

// Whether a window frame is already close enough to its slot to leave alone.
public func fits(_ frame: CGRect, _ slot: CGRect, tolerance: CGFloat = 4) -> Bool {
    abs(frame.minX - slot.minX) <= tolerance
        && abs(frame.minY - slot.minY) <= tolerance
        && abs(frame.maxX - slot.maxX) <= tolerance
        && abs(frame.maxY - slot.maxY) <= tolerance
}

// Accessibility positions are measured from the top-left of the primary screen.
public func axFrame(_ cocoa: CGRect, primaryHeight: CGFloat) -> (origin: CGPoint, size: CGSize) {
    (CGPoint(x: cocoa.minX, y: primaryHeight - cocoa.maxY), cocoa.size)
}
