// Which desktops of a display Organize Windows may remove afterwards: those no
// window is on. A window listed on several spaces is on every desktop (assigned to
// all desktops) and keeps none of them alive; the current desktop always stays.

public func emptyDesktops(_ desktops: [SpaceID], current: SpaceID, windowSpaces: [[SpaceID]]) -> [SpaceID] {
    let occupied = Set(windowSpaces.filter { $0.count == 1 }.flatMap { $0 })
    return desktops.filter { $0 != current && !occupied.contains($0) }
}
