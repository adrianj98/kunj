import Testing
@testable import KunjBarCore

@Test func desktopsWithoutWindowsAreEmpty() {
    #expect(emptyDesktops([1, 2, 3, 4], current: 1, windowSpaces: [[2], [2], [4]]) == [3])
}

@Test func theCurrentDesktopIsNeverRemoved() {
    #expect(emptyDesktops([1, 2], current: 2, windowSpaces: []) == [1])
}

@Test func windowsOnEveryDesktopDoNotKeepThemAlive() {
    // A window shown on all desktops (assigned to all, or a sticky panel) lists several spaces
    #expect(emptyDesktops([1, 2, 3], current: 1, windowSpaces: [[1, 2, 3], [3]]) == [2])
}

@Test func spacesOfOtherDisplaysAreIgnored() {
    #expect(emptyDesktops([1, 2], current: 1, windowSpaces: [[9]]) == [2])
}
