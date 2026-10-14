import CoreGraphics
import Testing
@testable import KunjBarCore

// Mission Control lays thumbnails out roughly where their windows are, so of
// several thumbnails with the same title the one nearest the window's relative
// position is the window's.
@Test func theThumbnailNearestTheWindowsRelativePositionWins() {
    let screen = CGRect(x: 0, y: 0, width: 2000, height: 1000)
    let group = CGRect(x: 100, y: 100, width: 1000, height: 500)
    let window = CGRect(x: 1500, y: 200, width: 400, height: 300)   // right side of the screen
    let left = CGRect(x: 150, y: 200, width: 200, height: 150)
    let right = CGRect(x: 850, y: 200, width: 200, height: 150)
    #expect(nearestThumbnail(to: window, in: screen, among: [left, right], within: group) == 1)
    #expect(nearestThumbnail(to: window, in: screen, among: [right, left], within: group) == 0)
}

@Test func noThumbnailsMeansNoPick() {
    let r = CGRect(x: 0, y: 0, width: 10, height: 10)
    #expect(nearestThumbnail(to: r, in: r, among: [], within: r) == nil)
}
