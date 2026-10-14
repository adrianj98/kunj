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
