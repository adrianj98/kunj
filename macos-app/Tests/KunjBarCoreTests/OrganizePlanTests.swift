import CoreGraphics
import Testing
@testable import KunjBarCore

@Test func aWantedScreenThatIsAttachedIsUsed() {
    let r = resolveScreenName("LS32R75", available: ["Built-in Retina Display", "LS32R75"], main: "Built-in Retina Display")
    #expect(r.name == "LS32R75")
    #expect(!r.fellBack)
}

@Test func anEmptyScreenSettingMeansTheMainScreen() {
    let r = resolveScreenName("", available: ["Built-in Retina Display", "LS32R75"], main: "Built-in Retina Display")
    #expect(r.name == "Built-in Retina Display")
    #expect(!r.fellBack)
}

@Test func anUnpluggedScreenFallsBackToTheMainScreen() {
    let r = resolveScreenName("LS32R75", available: ["Built-in Retina Display"], main: "Built-in Retina Display")
    #expect(r.name == "Built-in Retina Display")
    #expect(r.fellBack)
}

private func window(_ id: UInt32, _ kind: WindowKind, _ frame: CGRect) -> FoundWindow {
    FoundWindow(id: id, pid: 1, kind: kind, title: "", documentPath: nil, frame: frame, minimized: false)
}

private let editorSlot = CGRect(x: 0, y: 30, width: 500, height: 600)
private let terminalSlot = CGRect(x: 500, y: 30, width: 500, height: 600)

@Test func aWindowAlreadyInItsSlotNeedsNoMove() {
    let fitting = window(1, .editor, CGRect(x: 2, y: 30, width: 498, height: 600))
    let off = window(2, .terminal, CGRect(x: 520, y: 30, width: 480, height: 600))
    let p = placements(windows: [fitting, off], slots: [.editor: editorSlot, .terminal: terminalSlot])
    #expect(p.map(\.needsMove) == [false, true])
    #expect(p.map(\.slot) == [editorSlot, terminalSlot])
}

@Test func twoWindowsOfOneKindShareTheSlot() {
    let a = window(1, .terminal, CGRect(x: 0, y: 0, width: 10, height: 10))
    let b = window(2, .terminal, CGRect(x: 0, y: 0, width: 10, height: 10))
    let p = placements(windows: [a, b], slots: [.terminal: terminalSlot])
    #expect(p.count == 2)
    #expect(p.allSatisfy { $0.slot == terminalSlot && $0.needsMove })
}

@Test func aWindowOfADisabledKindGetsNoPlacement() {
    let a = window(1, .terminal, CGRect(x: 0, y: 0, width: 10, height: 10))
    #expect(placements(windows: [a], slots: [.editor: editorSlot]).isEmpty)
}

private let visible = CGRect(x: 0, y: 30, width: 1000, height: 600)

@Test func twoEditorsAndNoTerminalTakeOneHalfEach() {
    let a = window(1, .editor, CGRect(x: 0, y: 0, width: 10, height: 10))
    let b = window(2, .editor, CGRect(x: 0, y: 0, width: 10, height: 10))
    let p = arrange(windows: [a, b], layout: .editorLeft, kinds: [.editor, .terminal], in: visible)
    #expect(p.map(\.slot) == [editorSlot, terminalSlot])
}

@Test func threeTerminalsAlternateHalves() {
    let ws = (1...3).map { window(UInt32($0), .terminal, CGRect(x: 0, y: 0, width: 10, height: 10)) }
    let p = arrange(windows: ws, layout: .editorLeft, kinds: [.editor, .terminal], in: visible)
    #expect(p.map(\.slot) == [editorSlot, terminalSlot, editorSlot])
}

@Test func aLoneWindowTakesItsOwnHalf() {
    let t = window(1, .terminal, CGRect(x: 0, y: 0, width: 10, height: 10))
    #expect(arrange(windows: [t], layout: .editorLeft, kinds: [.editor, .terminal], in: visible).map(\.slot) == [terminalSlot])
    let e = window(2, .editor, CGRect(x: 0, y: 0, width: 10, height: 10))
    #expect(arrange(windows: [e], layout: .editorLeft, kinds: [.editor, .terminal], in: visible).map(\.slot) == [editorSlot])
}

@Test func editorAndTerminalKeepTheirOwnHalves() {
    let e = window(1, .editor, CGRect(x: 0, y: 0, width: 10, height: 10))
    let t = window(2, .terminal, CGRect(x: 0, y: 0, width: 10, height: 10))
    let e2 = window(3, .editor, CGRect(x: 0, y: 0, width: 10, height: 10))
    let p = arrange(windows: [t, e, e2], layout: .editorLeft, kinds: [.editor, .terminal], in: visible)
    #expect(p.map(\.slot) == [terminalSlot, editorSlot, editorSlot])
}

@Test func aDisabledKindIsLeftOutOfTheArrangement() {
    let e = window(1, .editor, CGRect(x: 0, y: 0, width: 10, height: 10))
    let t = window(2, .terminal, CGRect(x: 0, y: 0, width: 10, height: 10))
    let p = arrange(windows: [e, t], layout: .editorLeft, kinds: [.editor], in: visible)
    #expect(p.map(\.window.id) == [1])
    #expect(p.map(\.slot) == [editorSlot])
}
