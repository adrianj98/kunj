import CoreGraphics
import Testing
@testable import KunjBarCore

private func window(_ id: UInt32) -> FoundWindow {
    FoundWindow(id: id, pid: 1, kind: .editor, title: "", documentPath: nil,
                frame: CGRect(x: 0, y: 0, width: 100, height: 100), minimized: false)
}

private let screen: [SpaceID] = [5, 7, 9]

@Test func windowsTogetherOnAFreeDesktopOfTheScreenAreKept() {
    let c = chooseDesktop(windows: [window(1), window(2)], spaceOf: [1: 7, 2: 7],
                          screenSpaces: screen, remembered: 9, takenSpaces: [])
    #expect(c == .keep(7))
}

@Test func windowsSpreadOverDesktopsUseTheRememberedOne() {
    let c = chooseDesktop(windows: [window(1), window(2)], spaceOf: [1: 7, 2: 8],
                          screenSpaces: screen, remembered: 9, takenSpaces: [])
    #expect(c == .remember(9))
}

@Test func aTakenDesktopIsNotKept() {
    #expect(chooseDesktop(windows: [window(1)], spaceOf: [1: 7], screenSpaces: screen,
                          remembered: 9, takenSpaces: [7]) == .remember(9))
    #expect(chooseDesktop(windows: [window(1)], spaceOf: [1: 7], screenSpaces: screen,
                          remembered: nil, takenSpaces: [7]) == .create)
}

@Test func aDesktopOnAnotherDisplayIsNotKept() {
    #expect(chooseDesktop(windows: [window(1)], spaceOf: [1: 42], screenSpaces: screen,
                          remembered: nil, takenSpaces: []) == .create)
}

@Test func aRememberedDesktopThatIsGoneMeansCreate() {
    #expect(chooseDesktop(windows: [window(1), window(2)], spaceOf: [1: 7, 2: 8], screenSpaces: screen,
                          remembered: 99, takenSpaces: []) == .create)
}

@Test func aRememberedDesktopThatIsTakenMeansCreate() {
    #expect(chooseDesktop(windows: [window(1), window(2)], spaceOf: [1: 7, 2: 8], screenSpaces: screen,
                          remembered: 9, takenSpaces: [9]) == .create)
}

@Test func aWindowWithNoKnownSpaceIsNotKept() {
    #expect(chooseDesktop(windows: [window(1), window(2)], spaceOf: [1: 7], screenSpaces: screen,
                          remembered: nil, takenSpaces: []) == .create)
}
