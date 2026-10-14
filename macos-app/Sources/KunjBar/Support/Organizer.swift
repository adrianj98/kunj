// One Organize Windows run: find the worktrees' windows, give each worktree a
// desktop on the chosen screen, bring its windows there and tile them.

import AppKit
import KunjBarCore

final class Organizer {
    struct Outcome {
        var worktrees = 0
        var desktopsCreated = 0
        var windowsMoved = 0
        var windowsFailed = 0
        var remembered: [String: SpaceID]
        var screenName = ""
        var screenFellBack = false
        var wantedScreen = ""
    }

    private let log: (String) -> Void

    init(log: @escaping (String) -> Void) {
        self.log = log
    }

    func run(worktrees: [WorktreeRef], screenName wanted: String, layout: Layout, kinds: Set<WindowKind>,
             remembered: [String: SpaceID], terminalApps: [String]) throws -> Outcome {
        var outcome = Outcome(remembered: remembered, wantedScreen: wanted)

        // Screen
        let screens = NSScreen.screens
        let main = screens.first { $0.frame.origin == .zero } ?? screens[0]
        let resolved = resolveScreenName(wanted, available: screens.map(\.localizedName), main: main.localizedName)
        guard let screen = screens.first(where: { $0.localizedName == resolved.name }) else { throw MissionControl.Failure(step: "no screen") }
        outcome.screenName = resolved.name
        outcome.screenFellBack = resolved.fellBack
        guard let displayUUID = Spaces.displayUUID(of: screen) else { throw MissionControl.Failure(step: "no display id for \(screen.localizedName)") }
        log("organize: screen \(screen.localizedName)\(resolved.fellBack ? " (\(wanted) is not attached)" : ""), layout \(layout.rawValue), kinds \(kinds.map(\.rawValue).sorted())")

        // Windows, leaving out full-screen ones (each is its own Space, not a desktop)
        var displays = try Spaces.displays()
        let desktops = Set(displays.flatMap(\.spaces))
        let candidates = try discoverWindows(kinds: kinds, terminalApps: terminalApps, displays: displays, desktops: desktops)
        var spaceOf = try Spaces.space(of: candidates.map(\.0.id))
        let all = candidates.filter { spaceOf[$0.0.id].map(desktops.contains) ?? false }
        let elements = Dictionary(all.map { ($0.0.id, $0.1) }, uniquingKeysWith: { a, _ in a })
        let matched = matchWindows(all.map(\.0), worktrees: worktrees)
        log("organize: \(all.count) candidate windows (\(candidates.count - all.count) full-screen left alone), \(matched.values.map(\.count).reduce(0, +)) belong to \(matched.count) worktrees")
        let todo = worktrees.filter { matched[$0.path] != nil }
        if todo.isEmpty { return outcome }

        func screenSpaces() -> [SpaceID] { displays.first { $0.displayUUID == displayUUID }?.spaces ?? [] }
        // Desktops holding some listed worktree's windows, so another worktree cannot keep them
        var occupied: [SpaceID: String] = [:]
        for worktree in todo {
            for window in matched[worktree.path] ?? [] {
                if let space = spaceOf[window.id], occupied[space] == nil { occupied[space] = worktree.path }
            }
        }
        // Drop remembered desktops that no longer exist
        let existing = Set(displays.flatMap(\.spaces))
        outcome.remembered = outcome.remembered.filter { existing.contains($0.value) }

        var taken: Set<SpaceID> = []
        let visible = screen.visibleFrame
        let slotRects = slots(for: layout, kinds: kinds, in: visible)

        for worktree in todo {
            let windows = matched[worktree.path] ?? []
            let takenByOthers = taken.union(occupied.filter { $0.value != worktree.path }.keys)
            let choice = chooseDesktop(windows: windows, spaceOf: spaceOf, screenSpaces: screenSpaces(),
                                       remembered: outcome.remembered[worktree.path], takenSpaces: takenByOthers)
            let space: SpaceID
            switch choice {
            case .keep(let id):
                space = id
                log("organize: \(worktree.name) keeps desktop \(index(of: id))")
            case .remember(let id):
                space = id
                log("organize: \(worktree.name) goes to its remembered desktop \(index(of: id))")
            case .create:
                space = try MissionControl.addDesktop(on: screen)
                displays = try Spaces.displays()
                outcome.desktopsCreated += 1
                log("organize: \(worktree.name) gets new desktop \(index(of: space))")
            }
            taken.insert(space)
            outcome.remembered[worktree.path] = space
            try MissionControl.switchTo(space, on: screen)

            // Bring windows that are elsewhere
            for window in windows where spaceOf[window.id] != space {
                guard let element = elements[window.id] else { continue }
                do {
                    let onThisDisplay = screenSpaces().contains(spaceOf[window.id] ?? 0)
                    if !onThisDisplay {
                        // Another display: a frame on this screen puts it on this screen's current desktop
                        AXWindows.setFrame(element, cocoa: slotRects[window.kind] ?? visible)
                        try poll { (try? Spaces.space(of: [window.id]))?[window.id] == space }
                        log("organize: moved “\(window.title)” across displays")
                    } else {
                        AXWindows.raise(element, pid: window.pid)
                        try poll { (try? Spaces.displays())?.first { $0.displayUUID == displayUUID }?.current == spaceOf[window.id] }
                        try MissionControl.drag(window: window.id, title: window.title, to: space, on: screen)
                        try MissionControl.switchTo(space, on: screen)
                        log("organize: dragged “\(window.title)” to desktop \(index(of: space))")
                    }
                    spaceOf[window.id] = space
                    outcome.windowsMoved += 1
                } catch {
                    outcome.windowsFailed += 1
                    log("organize: could not move “\(window.title)”: \(error)")
                    _ = try? MissionControl.switchTo(space, on: screen)
                }
            }

            // Tile
            let present = windows.filter { spaceOf[$0.id] == space }
            for placement in placements(windows: present, slots: slotRects) where placement.needsMove {
                guard let element = elements[placement.window.id] else { continue }
                AXWindows.setFrame(element, cocoa: placement.slot)
                log("organize: placed “\(placement.window.title)” at \(Int(placement.slot.minX)),\(Int(placement.slot.minY)) \(Int(placement.slot.width))×\(Int(placement.slot.height))")
            }
            outcome.worktrees += 1
        }
        return outcome

        func index(of space: SpaceID) -> String {
            screenSpaces().firstIndex(of: space).map { String($0 + 1) } ?? "?"
        }
    }

    // Accessibility only lists the windows on each display's current desktop. Collect
    // those, and while the window server knows of more, visit the other desktops of
    // each display (switching back afterwards) and collect there too.
    private func discoverWindows(kinds: Set<WindowKind>, terminalApps: [String], displays: [Spaces.DisplaySpaces],
                                 desktops: Set<SpaceID>) throws -> [(FoundWindow, AXUIElement)] {
        let apps = AXWindows.candidateApps(terminalApps: terminalApps).filter { kinds.contains($0.value) }
        var found: [CGWindowID: (FoundWindow, AXUIElement)] = [:]
        func collect() {
            for (window, element) in AXWindows.visibleWindows(of: apps) where found[window.id] == nil { found[window.id] = (window, element) }
        }
        collect()
        // Only windows on desktops matter; full-screen spaces are never visited
        let wanted = AXWindows.allWindowIDs(of: apps)
        let spaceOf = try Spaces.space(of: Array(wanted))
        var missing = wanted.filter { desktops.contains(spaceOf[$0] ?? 0) && found[$0] == nil }
        if !missing.isEmpty { log("organize: \(missing.count) windows are on other desktops, visiting them") }
        for display in displays where !missing.isEmpty {
            guard let screen = Spaces.screen(forDisplayUUID: display.displayUUID) else { continue }
            let toVisit = display.spaces.filter { space in space != display.current && missing.contains { spaceOf[$0] == space } }
            for space in toVisit {
                try MissionControl.switchTo(space, on: screen)
                collect()
                missing = missing.filter { found[$0] == nil }
                if missing.isEmpty { break }
            }
            if !toVisit.isEmpty { try MissionControl.switchTo(display.current, on: screen) }
        }
        return Array(found.values).sorted { $0.0.id < $1.0.id }
    }

    private func poll(_ condition: () -> Bool) throws {
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            if condition() { return }
            usleep(100_000)
        }
        throw MissionControl.Failure(step: "timed out waiting for a window to move")
    }
}
