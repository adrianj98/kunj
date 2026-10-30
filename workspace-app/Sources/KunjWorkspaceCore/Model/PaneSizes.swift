import Foundation

/// The widths the user dragged the window's dividers to: the sidebar, the Changes column's share
/// of the width it splits with the terminal column, the Files column and the Changes file list.
/// Saved as the user's preference; `fitted(windowWidth:…)` gives what fits the window right now,
/// so a narrow window squeezes the panes without losing the saved widths.
public struct PaneSizes: Codable, Equatable, Sendable {
    public var sidebar: Double
    /// The Changes column's share of the terminal and Changes columns' width (0.45 = 11:9).
    public var changesShare: Double
    public var files: Double
    public var fileList: Double

    public init(sidebar: Double, changesShare: Double, files: Double, fileList: Double) {
        self.sidebar = sidebar
        self.changesShare = changesShare
        self.files = files
        self.fileList = fileList
    }

    public static let standard = PaneSizes(
        sidebar: DesignTokens.Layout.sidebarWidth,
        changesShare: DesignTokens.Layout.paneSplit.1 / (DesignTokens.Layout.paneSplit.0 + DesignTokens.Layout.paneSplit.1),
        files: 260,
        fileList: DesignTokens.Layout.changesFileListWidth)

    public static let sidebarRange = 200.0...440.0
    public static let filesRange = 180.0...560.0
    public static let fileListRange = 120.0...400.0
    /// Neither the terminal column nor the Changes column gets narrower than this by a drag.
    public static let minColumn = 280.0
    /// The diff keeps at least this much of the Changes column beside the file list.
    public static let minDiff = 200.0

    /// The width the terminal and Changes columns share: the window less the sidebar, the Files
    /// column when open and their 1 px hairlines.
    public static func mainWidth(windowWidth: Double, sidebar: Double, files: Double?) -> Double {
        windowWidth - sidebar - 1 - (files.map { $0 + 1 } ?? 0)
    }

    /// What fits a window `windowWidth` wide: each width in its range, then the Files column and
    /// the sidebar given up (in that order, down to their minimums) until the columns between them
    /// have `2 × minColumn`, the split kept so both columns have `minColumn`, and the file list
    /// leaving `minDiff` for the diff.
    public func fitted(windowWidth: Double, filesOpen: Bool, changesOpen: Bool) -> PaneSizes {
        var s = self
        s.sidebar = s.sidebar.clamped(to: Self.sidebarRange)
        s.files = s.files.clamped(to: Self.filesRange)
        let need = 2 * Self.minColumn
        if filesOpen {
            let over = need - Self.mainWidth(windowWidth: windowWidth, sidebar: s.sidebar, files: s.files)
            if over > 0 { s.files = max(Self.filesRange.lowerBound, s.files - over) }
        }
        let over = need - Self.mainWidth(windowWidth: windowWidth, sidebar: s.sidebar, files: filesOpen ? s.files : nil)
        if over > 0 { s.sidebar = max(Self.sidebarRange.lowerBound, s.sidebar - over) }
        let main = Self.mainWidth(windowWidth: windowWidth, sidebar: s.sidebar, files: filesOpen ? s.files : nil)
        let edge = main > need ? Self.minColumn / main : 0.5
        s.changesShare = s.changesShare.clamped(to: max(0.1, edge)...min(0.9, 1 - edge))
        if changesOpen {
            let changes = s.changesShare * main
            s.fileList = s.fileList.clamped(to: Self.fileListRange.lowerBound...max(Self.fileListRange.lowerBound,
                                                                                     min(Self.fileListRange.upperBound, changes - Self.minDiff)))
        } else {
            s.fileList = s.fileList.clamped(to: Self.fileListRange)
        }
        return s
    }
}

extension Comparable {
    func clamped(to range: ClosedRange<Self>) -> Self { min(max(self, range.lowerBound), range.upperBound) }
}
