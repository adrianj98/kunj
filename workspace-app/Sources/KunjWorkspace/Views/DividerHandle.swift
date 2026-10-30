import AppKit

/// An invisible strip over a vertical hairline that drags it: the left-right resize cursor, and
/// `onDrag` with the distance from where the drag started (positive to the right). A double-click
/// asks for the standard width (`onReset`). Added after the views it covers so it is hit first.
final class DividerHandle: NSView {
    static let width: CGFloat = 8

    var onBegin: () -> Void = {}
    var onDrag: (CGFloat) -> Void = { _ in }
    var onEnd: () -> Void = {}
    var onReset: () -> Void = {}
    private var startX: CGFloat?

    init(label: String) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
        setAccessibilityRole(.splitter)
        setAccessibilityLabel(label)
        toolTip = "Drag to resize, double-click for the standard width"
    }
    required init?(coder: NSCoder) { fatalError() }

    // a terminal or the diff's web view under the strip sets its own cursor on mouse moves; the
    // tracking area's cursorUpdate puts this one back while the pointer is over the strip
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.cursorUpdate, .mouseMoved, .activeAlways, .inVisibleRect],
                                       owner: self))
    }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeLeftRight) }
    override func cursorUpdate(with event: NSEvent) { NSCursor.resizeLeftRight.set() }
    override func mouseMoved(with event: NSEvent) { NSCursor.resizeLeftRight.set() }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { startX = nil; onReset(); return }
        startX = event.locationInWindow.x
        onBegin()
    }

    override func mouseDragged(with event: NSEvent) {
        guard let startX else { return }
        NSCursor.resizeLeftRight.set()
        onDrag(event.locationInWindow.x - startX)
    }

    override func mouseUp(with event: NSEvent) {
        guard startX != nil else { return }
        startX = nil
        onEnd()
    }
}
