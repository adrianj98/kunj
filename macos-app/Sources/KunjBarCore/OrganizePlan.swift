// The pure parts of an Organize run: which screen, and where each window goes.

import CoreGraphics

// The display to use: the wanted one when attached, else the main screen.
public func resolveScreenName(_ wanted: String, available: [String], main: String) -> (name: String, fellBack: Bool) {
    if wanted.isEmpty { return (main, false) }
    if available.contains(wanted) { return (wanted, false) }
    return (main, true)
}

public struct Placement: Equatable, Sendable {
    public let window: FoundWindow
    public let slot: CGRect
    public let needsMove: Bool
}

// A placement per window whose kind has a slot; windows already within tolerance stay.
public func placements(windows: [FoundWindow], slots: [WindowKind: CGRect]) -> [Placement] {
    windows.compactMap { window in
        guard let slot = slots[window.kind] else { return nil }
        return Placement(window: window, slot: slot, needsMove: !fits(window.frame, slot))
    }
}

// Where a worktree's windows go. Editors and terminals each take their half when both
// are present. With only one kind, a lone window fills the screen and two or more take
// turns on the two halves, so a pair always sits side by side. Disabled kinds are left out.
public func arrange(windows: [FoundWindow], layout: Layout, kinds: Set<WindowKind>, in visible: CGRect) -> [Placement] {
    let included = windows.filter { kinds.contains($0.kind) }
    let present = Set(included.map(\.kind))
    if present.count == 2 {
        return placements(windows: included, slots: slots(for: layout, kinds: present, in: visible))
    }
    if included.count < 2 {
        return placements(windows: included, slots: slots(for: layout, kinds: present, in: visible))
    }
    let halves = slots(for: layout, kinds: [.editor, .terminal], in: visible)
    let order: [CGRect] = [halves[.editor]!, halves[.terminal]!]
    return included.enumerated().map { i, window in
        let slot = order[i % 2]
        return Placement(window: window, slot: slot, needsMove: !fits(window.frame, slot))
    }
}
