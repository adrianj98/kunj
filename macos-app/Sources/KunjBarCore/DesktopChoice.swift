// Which desktop a worktree gets: the one its windows already share, the one
// remembered from an earlier run, or a new one.

public typealias SpaceID = UInt64

public enum DesktopChoice: Equatable, Sendable {
    case keep(SpaceID)
    case remember(SpaceID)
    case create
}

// `spaceOf` maps window id to desktop; `screenSpaces` are the chosen screen's desktops;
// `takenSpaces` are desktops already given to other worktrees in this run or holding
// another listed worktree's windows.
public func chooseDesktop(windows: [FoundWindow], spaceOf: [UInt32: SpaceID], screenSpaces: [SpaceID],
                          remembered: SpaceID?, takenSpaces: Set<SpaceID>) -> DesktopChoice {
    let spaces = Set(windows.map { spaceOf[$0.id] })
    if spaces.count == 1, let only = spaces.first, let space = only,
       screenSpaces.contains(space), !takenSpaces.contains(space) {
        return .keep(space)
    }
    if let remembered, screenSpaces.contains(remembered), !takenSpaces.contains(remembered) {
        return .remember(remembered)
    }
    return .create
}
