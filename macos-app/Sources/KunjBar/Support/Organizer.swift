// One Organize Windows run: find the worktrees' windows, pair them up two per
// desktop on the chosen screen, bring each pair there and tile it.

import AppKit
import KunjBarCore

final class Organizer {
    struct Outcome {
        var desktops = 0
        var windows = 0
        var groupsFailed = 0
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

        // Windows on any desktop or full-screen space (a Terminal tab has no space of its own)
        var displays = try Spaces.displays()
        var desktops = Set(displays.flatMap(\.spaces))
        let candidates = try discoverWindows(kinds: kinds, terminalApps: terminalApps, displays: displays)
        var spaceOf = try Spaces.space(of: candidates.map(\.0.id))
        let all = candidates.filter { spaceOf[$0.0.id] != nil }
        let elements = Dictionary(all.map { ($0.0.id, $0.1) }, uniquingKeysWith: { a, _ in a })
        let matched = matchWindows(all.map(\.0), worktrees: worktrees)
        let entries = worktreeEntries(matched: matched, worktrees: worktrees, windows: all.map(\.0))
        log("organize: \(all.count) candidate windows, \(matched.values.map(\.count).reduce(0, +)) belong to \(matched.count) worktrees, \(entries.count - matched.count) editor windows of other folders")
        if entries.isEmpty { return outcome }

        // Full-screen windows come back to a desktop first
        for (_, windows) in entries {
            for window in windows where !desktops.contains(spaceOf[window.id] ?? 0) {
                guard let element = elements[window.id] else { continue }
                AXWindows.exitFullScreen(element)
                if (try? poll(timeout: 6) {
                    if let space = (try? Spaces.space(of: [window.id]))?[window.id], desktops.contains(space) { spaceOf[window.id] = space; return true }
                    return false
                }) != nil {
                    log("organize: took “\(window.title)” out of full screen")
                } else {
                    log("organize: “\(window.title)” did not leave full screen")
                }
            }
        }
        displays = try Spaces.displays()
        desktops = Set(displays.flatMap(\.spaces))

        func screenSpaces() -> [SpaceID] { displays.first { $0.displayUUID == displayUUID }?.spaces ?? [] }
        let groups = groupWindows(entries)
        func name(_ group: WindowGroup) -> String { group.worktrees.map(\.name).joined(separator: " + ") }

        // Desktops holding some group's windows, so another group cannot keep them
        var occupied: [SpaceID: Int] = [:]
        for (i, group) in groups.enumerated() {
            for window in group.windows {
                if let space = spaceOf[window.id], occupied[space] == nil { occupied[space] = i }
            }
        }
        // Drop remembered desktops that no longer exist
        let existing = Set(displays.flatMap(\.spaces))
        outcome.remembered = outcome.remembered.filter { existing.contains($0.value) }

        var taken: Set<SpaceID> = []
        let visible = screen.visibleFrame
        let halves = slots(for: layout, kinds: [.editor, .terminal], in: visible)

        for (i, group) in groups.enumerated() {
            let windows = group.windows
            let takenByOthers = taken.union(occupied.filter { $0.value != i }.keys)
            // A pair's desktop is the one remembered for its first worktree
            let remembered = group.worktrees.lazy.compactMap { outcome.remembered[$0.path] }.first
            let choice = chooseDesktop(windows: windows, spaceOf: spaceOf, screenSpaces: screenSpaces(),
                                       remembered: remembered, takenSpaces: takenByOthers)
            // A pair whose desktop cannot be made or reached is skipped, not the whole run,
            // so what was done so far (and which desktop is whose) is kept
            let space: SpaceID
            do {
                switch choice {
                case .keep(let id):
                    space = id
                    log("organize: \(name(group)) keeps desktop \(index(of: id))")
                case .remember(let id):
                    space = id
                    log("organize: \(name(group)) goes to its remembered desktop \(index(of: id))")
                case .create:
                    space = try MissionControl.addDesktop(on: screen)
                    displays = try Spaces.displays()
                    outcome.desktopsCreated += 1
                    log("organize: \(name(group)) gets new desktop \(index(of: space))")
                }
                taken.insert(space)
                for worktree in group.worktrees { outcome.remembered[worktree.path] = space }
                try MissionControl.switchTo(space, on: screen)
            } catch {
                outcome.groupsFailed += 1
                log("organize: skipping \(name(group)): \(error)")
                continue
            }

            // Bring windows that are elsewhere
            for window in windows where spaceOf[window.id] != space {
                guard let element = elements[window.id] else { continue }
                do {
                    let onThisDisplay = screenSpaces().contains(spaceOf[window.id] ?? 0)
                    if !onThisDisplay {
                        // Another display: a frame on this screen puts it on this screen's current desktop
                        AXWindows.setFrame(element, cocoa: halves[window.kind] ?? visible)
                        try poll { (try? Spaces.space(of: [window.id]))?[window.id] == space }
                        log("organize: moved “\(window.title)” across displays")
                    } else {
                        AXWindows.raise(element, pid: window.pid)
                        try poll { (try? Spaces.displays())?.first { $0.displayUUID == displayUUID }?.current == spaceOf[window.id] }
                        guard let current = AXWindows.frame(of: element) else { throw MissionControl.Failure(step: "window has no frame") }
                        try MissionControl.drag(window: window.id, title: window.title, frame: axRect(current), to: space, on: screen)
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
            for placement in arrange(windows: present, layout: layout, kinds: kinds, in: visible) where placement.needsMove {
                guard let element = elements[placement.window.id] else { continue }
                AXWindows.setFrame(element, cocoa: placement.slot)
                log("organize: placed “\(placement.window.title)” at \(Int(placement.slot.minX)),\(Int(placement.slot.minY)) \(Int(placement.slot.width))×\(Int(placement.slot.height))")
            }
            outcome.desktops += 1
            outcome.windows += present.count
        }
        return outcome

        func index(of space: SpaceID) -> String {
            screenSpaces().firstIndex(of: space).map { String($0 + 1) } ?? "?"
        }
    }

    private func axRect(_ cocoa: CGRect) -> CGRect {
        let f = axFrame(cocoa, primaryHeight: AXWindows.primaryHeight)
        return CGRect(origin: f.origin, size: f.size)
    }

    // Accessibility only lists the windows on each display's current space. Collect
    // those, and while the window server knows of more, visit the other spaces of each
    // display (desktops and full-screen apps, switching back afterwards) and collect there.
    private func discoverWindows(kinds: Set<WindowKind>, terminalApps: [String],
                                 displays: [Spaces.DisplaySpaces]) throws -> [(FoundWindow, AXUIElement)] {
        let apps = AXWindows.candidateApps(terminalApps: terminalApps).filter { kinds.contains($0.value) }
        var found: [CGWindowID: (FoundWindow, AXUIElement)] = [:]
        func collect() {
            for (window, element) in AXWindows.visibleWindows(of: apps) where found[window.id] == nil { found[window.id] = (window, element) }
        }
        collect()
        // Only windows with a space of their own matter (a Terminal tab has none)
        let wanted = AXWindows.allWindowIDs(of: apps)
        let spaceOf = try Spaces.space(of: Array(wanted))
        let known = Set(displays.flatMap(\.allSpaces))
        var missing = wanted.filter { known.contains(spaceOf[$0] ?? 0) && found[$0] == nil }
        if !missing.isEmpty { log("organize: \(missing.count) windows are on other spaces, visiting them") }
        for display in displays where !missing.isEmpty {
            guard let screen = Spaces.screen(forDisplayUUID: display.displayUUID) else { continue }
            let toVisit = display.allSpaces.filter { space in space != display.current && missing.contains { spaceOf[$0] == space } }
            if toVisit.isEmpty { continue }
            defer { _ = try? MissionControl.switchTo(display.current, on: screen) }
            for space in toVisit {
                try MissionControl.switchTo(space, on: screen)
                collect()
                missing = missing.filter { found[$0] == nil }
                if missing.isEmpty { break }
            }
        }
        return Array(found.values).sorted { $0.0.id < $1.0.id }
    }

    private func poll(timeout: TimeInterval = 3, _ condition: () -> Bool) throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            usleep(100_000)
        }
        throw MissionControl.Failure(step: "timed out waiting for a window to move")
    }
}
