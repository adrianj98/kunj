import Testing
@testable import KunjWorkspaceCore

private func file(_ path: String, _ status: FileStatus = .modified) -> ChangedFile {
    ChangedFile(path: path, oldPath: nil, status: status, added: 1, deleted: 0)
}

@Suite struct ChangesListTests {
    @Test func displayNamesAreBasenamesUnlessTheyClash() {
        let files = [file("src/routes/index.ts"), file("src/index.ts"), file("src/routes/usage-rollup.ts"),
                     file("README.md")]
        #expect(changedFileDisplayNames(files) == ["routes/index.ts", "src/index.ts", "usage-rollup.ts", "README.md"])
    }

    @Test func clashingAtEveryDepthShowsTheWholePath() {
        let files = [file("a/x/index.ts"), file("b/x/index.ts")]
        #expect(changedFileDisplayNames(files) == ["a/x/index.ts", "b/x/index.ts"])
    }

    @Test func selectionKeepsThePathElseTheFirstFile() {
        let files = [file("a.ts"), file("b.ts")]
        #expect(selectedIndexAfterRefresh(previous: "b.ts", files: files) == 1)
        #expect(selectedIndexAfterRefresh(previous: "gone.ts", files: files) == 0)
        #expect(selectedIndexAfterRefresh(previous: nil, files: files) == 0)
        #expect(selectedIndexAfterRefresh(previous: "a.ts", files: []) == nil)
    }

    @Test func headerCountsText() {
        #expect(changesCountLabel(1) == "1 file")
        #expect(changesCountLabel(14) == "14 files")
        #expect(changesCountLabel(0) == "0 files")
    }
}
