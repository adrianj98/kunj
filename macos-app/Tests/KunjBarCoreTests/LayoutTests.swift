import CoreGraphics
import Testing
@testable import KunjBarCore

private let visible = CGRect(x: 0, y: 30, width: 1000, height: 600)
private let both: Set<WindowKind> = [.editor, .terminal]

@Test func layoutHasThreeCases() {
    #expect(Layout.allCases.count == 3)
}

@Test func editorLeftSplitsTheScreenInHalves() {
    let s = slots(for: .editorLeft, kinds: both, in: visible)
    #expect(s[.editor] == CGRect(x: 0, y: 30, width: 500, height: 600))
    #expect(s[.terminal] == CGRect(x: 500, y: 30, width: 500, height: 600))
}

@Test func editorRightMirrorsEditorLeft() {
    let s = slots(for: .editorRight, kinds: both, in: visible)
    #expect(s[.editor] == CGRect(x: 500, y: 30, width: 500, height: 600))
    #expect(s[.terminal] == CGRect(x: 0, y: 30, width: 500, height: 600))
}

@Test func editorAboveStacksEditorOnTop() {
    let s = slots(for: .editorAbove, kinds: both, in: visible)
    #expect(s[.editor] == CGRect(x: 0, y: 330, width: 1000, height: 300))
    #expect(s[.terminal] == CGRect(x: 0, y: 30, width: 1000, height: 300))
}

@Test func aSingleKindFillsTheScreen() {
    let s = slots(for: .editorLeft, kinds: [.terminal], in: visible)
    #expect(s[.terminal] == visible)
    #expect(s[.editor] == nil)
}

@Test func noKindsMeansNoSlots() {
    #expect(slots(for: .editorLeft, kinds: [], in: visible).isEmpty)
}

// Terminal windows snap to whole character cells, so a window up to a cell short
// of its slot is still in place.
@Test func fitsAllowsACharacterCellOfSlack() {
    let slot = CGRect(x: 0, y: 30, width: 500, height: 600)
    #expect(fits(slot, slot))
    #expect(fits(CGRect(x: 3, y: 30, width: 490, height: 585), slot))
    #expect(!fits(CGRect(x: 20, y: 30, width: 480, height: 600), slot))
}

@Test func axFrameFlipsYFromThePrimaryScreensTop() {
    let f = axFrame(CGRect(x: 0, y: 30, width: 500, height: 600), primaryHeight: 900)
    #expect(f.origin == CGPoint(x: 0, y: 270))
    #expect(f.size == CGSize(width: 500, height: 600))
}
