import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct PaneSizesTests {
    @Test func theStandardSizesAreTheDesignsAndFitAWideWindow() {
        let s = PaneSizes.standard
        #expect(s.sidebar == 272 && s.fileList == 196 && s.files == 260)
        #expect(abs(s.changesShare - 0.45) < 0.0001)
        #expect(s.fitted(windowWidth: 1440, filesOpen: true, changesOpen: true) == s)
    }

    @Test func eachWidthStaysInItsRange() {
        let s = PaneSizes(sidebar: 50, changesShare: 0.99, files: 2000, fileList: 10)
            .fitted(windowWidth: 4000, filesOpen: true, changesOpen: true)
        #expect(s.sidebar == 200 && s.files == 560 && s.fileList == 120)
        #expect(s.changesShare == 0.9)
    }

    @Test func aNarrowWindowGivesUpTheFilesColumnThenTheSidebar() {
        let wide = PaneSizes(sidebar: 440, changesShare: 0.45, files: 560, fileList: 196)
        // 1000 - 440 - 1 - 561 leaves nothing for the columns: Files goes to 180, then the sidebar shrinks
        let s = wide.fitted(windowWidth: 1000, filesOpen: true, changesOpen: true)
        #expect(s.files == 180)
        #expect(PaneSizes.mainWidth(windowWidth: 1000, sidebar: s.sidebar, files: s.files) >= 560 || s.sidebar == 200)
        // closed, the Files column takes nothing and the sidebar keeps its width
        #expect(wide.fitted(windowWidth: 1200, filesOpen: false, changesOpen: true).sidebar == 440)
    }

    @Test func theSplitLeavesBothColumnsTheirMinimum() {
        let main = PaneSizes.mainWidth(windowWidth: 1440, sidebar: 272, files: nil)
        let left = PaneSizes(sidebar: 272, changesShare: 0.05, files: 260, fileList: 196)
            .fitted(windowWidth: 1440, filesOpen: false, changesOpen: true)
        #expect(abs(left.changesShare * main - PaneSizes.minColumn) < 0.001)
        let right = PaneSizes(sidebar: 272, changesShare: 0.95, files: 260, fileList: 196)
            .fitted(windowWidth: 1440, filesOpen: false, changesOpen: true)
        #expect(abs((1 - right.changesShare) * main - PaneSizes.minColumn) < 0.001)
    }

    @Test func theFileListLeavesRoomForTheDiff() {
        // the Changes column is 0.3 × 1167 = 350 wide: the list may take 150
        let s = PaneSizes(sidebar: 272, changesShare: 0.3, files: 260, fileList: 400)
            .fitted(windowWidth: 1440, filesOpen: false, changesOpen: true)
        let changes = s.changesShare * PaneSizes.mainWidth(windowWidth: 1440, sidebar: 272, files: nil)
        #expect(abs(s.fileList - (changes - PaneSizes.minDiff)) < 0.001)
    }

    @Test func theSizesRoundTripThroughJSON() throws {
        let s = PaneSizes(sidebar: 300, changesShare: 0.5, files: 320, fileList: 220)
        #expect(try JSONDecoder().decode(PaneSizes.self, from: JSONEncoder().encode(s)) == s)
    }
}
