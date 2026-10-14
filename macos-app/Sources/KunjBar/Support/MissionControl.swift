// Creating desktops, switching to them and moving windows between them by
// driving Mission Control through the Accessibility API, the way a person does
// it. macOS has no public API for any of the three.
//
// Mission Control lives in the Dock process. Its tree, probed on macOS 26 with two
// displays, is:
//   AXGroup "mc" (title "Mission Control")
//     AXGroup "mc.display"                      one per screen, frame on that screen
//       AXGroup "mc.windows"                    thumbnails of the current desktop's windows
//         AXButton (title = window title)
//       AXGroup "mc.spaces" (title "Spaces Bar")
//         AXList "mc.spaces.list"
//           AXButton (title "Desktop 3", description "exit to Desktop 3")
//           AXButton (title "Slack", description "exit to full screen Slack")
//         AXButton "mc.spaces.add" (description "add desktop")
// Desktop numbers run across displays in Spaces-bar order. Elements are found by
// identifier and role, never by index, and every step polls for what it needs
// rather than sleeping a fixed time. Frames are in Accessibility coordinates
// (top-left of the primary screen).

import AppKit
import ApplicationServices
import KunjBarCore

enum MissionControl {
    struct Failure: Error, CustomStringConvertible {
        let step: String
        var description: String { step }
    }

    private static let timeout: TimeInterval = 3
    private static let dockElement: AXUIElement? = {
        NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first
            .map { AXUIElementCreateApplication($0.processIdentifier) }
    }()

    // MARK: - Open and close

    static func open() throws {
        if (try? missionControlGroup()) != nil { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-b", "com.apple.exposelauncher"]
        try? process.run()
        process.waitUntilExit()
        try poll("Mission Control did not open") { (try? missionControlGroup()) != nil }
        // The Spaces bar is drawn a moment after the group appears, then slides into place
        try poll("Mission Control's Spaces bar did not appear") { find(identifier: "mc.spaces.list", under: (try? missionControlGroup())!) != nil }
        var last: CGRect?
        try poll("Mission Control's Spaces bar did not settle") {
            let now = (try? missionControlGroup()).flatMap { find(identifier: "mc.spaces.list", under: $0) }.flatMap(frame(of:))
            defer { last = now }
            usleep(150_000)
            return now != nil && now == last
        }
    }

    static func close() {
        guard (try? missionControlGroup()) != nil else { return }
        postKey(53) // Escape
        _ = try? poll("Mission Control did not close") { (try? missionControlGroup()) == nil }
    }

    // MARK: - Desktops

    static func addDesktop(on screen: NSScreen) throws -> SpaceID {
        let uuid = try displayUUID(of: screen)
        let before = try spaces(ofDisplay: uuid)
        try open()
        defer { close() }
        let bar = try spacesBar(on: screen)
        guard let add = find(identifier: "mc.spaces.add", under: bar) else { throw Failure(step: "no add-desktop button on \(screen.localizedName)") }
        var after = before
        try pressUntil(add, "no desktop appeared after pressing +") {
            after = (try? spaces(ofDisplay: uuid)) ?? before
            return after.count == before.count + 1
        }
        guard let new = after.last else { throw Failure(step: "new desktop not listed") }
        return new
    }

    // Switch a screen to any of its spaces, a desktop or a full-screen app.
    static func switchTo(_ space: SpaceID, on screen: NSScreen) throws {
        let uuid = try displayUUID(of: screen)
        if try current(ofDisplay: uuid) == space { return }
        guard let index = try display(uuid).allSpaces.firstIndex(of: space) else { throw Failure(step: "space \(space) is not on \(screen.localizedName)") }
        var lastError: Error?
        for _ in 0..<2 {
            do {
                try open()
                let buttons = try spaceButtons(on: screen)
                guard index < buttons.count else { throw Failure(step: "space \(index + 1) has no button (\(buttons.count) shown)") }
                try pressUntil(buttons[index], "switching to space \(index + 1) did not take") { (try? current(ofDisplay: uuid)) == space }
                close()
                return
            } catch {
                lastError = error
                close()
            }
        }
        throw lastError ?? Failure(step: "could not switch")
    }

    // Drag the thumbnail of a window on the current desktop onto another desktop's
    // button. The window must be on its display's current desktop to have a thumbnail.
    static func drag(window: UInt32, title: String, frame windowFrame: CGRect, to space: SpaceID, on screen: NSScreen) throws {
        let uuid = try displayUUID(of: screen)
        guard let index = try display(uuid).allSpaces.firstIndex(of: space) else { throw Failure(step: "desktop \(space) is not on \(screen.localizedName)") }
        try open()
        defer { close() }
        let buttons = try spaceButtons(on: screen)
        guard index < buttons.count, let target = frame(of: buttons[index]) else { throw Failure(step: "desktop \(index + 1) has no button") }
        guard let thumbnail = try windowThumbnail(window: window, title: title, frame: windowFrame, on: screen), let from = frame(of: thumbnail) else {
            throw Failure(step: "no thumbnail for “\(title)” in Mission Control")
        }
        dragMouse(from: CGPoint(x: from.midX, y: from.midY), to: CGPoint(x: target.midX, y: target.midY))
        try poll("“\(title)” did not land on desktop \(index + 1)") { (try? Spaces.space(of: [window]))?[window] == space }
    }

    // MARK: - Tree

    private static func missionControlGroup() throws -> AXUIElement {
        guard let dock = dockElement else { throw Failure(step: "Dock is not running") }
        guard let group = find(identifier: "mc", under: dock, depth: 2) else { throw Failure(step: "Mission Control is not open") }
        return group
    }

    private static func displayGroup(on screen: NSScreen) throws -> AXUIElement {
        let mc = try missionControlGroup()
        let displays = children(of: mc).filter { identifier(of: $0) == "mc.display" }
        let primaryHeight = AXWindows.primaryHeight
        let onScreen = displays.first { display in
            guard let f = frame(of: display) else { return false }
            return screen.frame.contains(CGPoint(x: f.midX, y: primaryHeight - f.midY))
        }
        guard let display = onScreen ?? (displays.count == 1 ? displays.first : nil) else {
            throw Failure(step: "no Mission Control display group on \(screen.localizedName) (\(displays.count) groups)")
        }
        return display
    }

    private static func spacesBar(on screen: NSScreen) throws -> AXUIElement {
        guard let bar = find(identifier: "mc.spaces", under: try displayGroup(on: screen)) else { throw Failure(step: "no Spaces bar on \(screen.localizedName)") }
        return bar
    }

    // One button per space, desktops and full-screen apps alike, in bar order
    private static func spaceButtons(on screen: NSScreen) throws -> [AXUIElement] {
        let bar = try spacesBar(on: screen)
        guard let list = find(identifier: "mc.spaces.list", under: bar) else { throw Failure(step: "no desktop list on \(screen.localizedName)") }
        return children(of: list).filter { role(of: $0) == kAXButtonRole }
    }

    // The thumbnail of a window on the screen's current desktop: by window id when the
    // thumbnail exposes one, else by title, and of several with the same title the one
    // laid out nearest the window's own position (the window's frame is in Accessibility
    // coordinates, like the thumbnails').
    private static func windowThumbnail(window: UInt32, title: String, frame windowFrame: CGRect, on screen: NSScreen) throws -> AXUIElement? {
        let display = try displayGroup(on: screen)
        guard let area = find(identifier: "mc.windows", under: display, depth: 1) else { return nil }
        let candidates = children(of: area).filter { role(of: $0) == kAXButtonRole }
        if let byID = candidates.first(where: { $0.windowID == window }) { return byID }
        guard !title.isEmpty else { return nil }
        let titled = candidates.filter { title == self.title(of: $0) || title == description(of: $0) }
        if titled.count <= 1 { return titled.first }
        let primaryHeight = AXWindows.primaryHeight
        let screenAX = CGRect(x: screen.frame.minX, y: primaryHeight - screen.frame.maxY, width: screen.frame.width, height: screen.frame.height)
        let frames = titled.map { frame(of: $0) ?? .zero }
        guard let areaFrame = frame(of: area), let index = nearestThumbnail(to: windowFrame, in: screenAX, among: frames, within: areaFrame) else { return titled.first }
        return titled[index]
    }

    // MARK: - Events

    // Press through Accessibility first; when that changes nothing, click the element
    // with the mouse the way a person would (Mission Control ignores some presses).
    private static func pressUntil(_ element: AXUIElement, _ failure: String, _ condition: () -> Bool) throws {
        hover(element)
        AXUIElementPerformAction(element, kAXPressAction as CFString)
        if (try? poll(failure, condition, timeout: 1.5)) != nil { return }
        guard let f = frame(of: element) else { throw Failure(step: failure) }
        click(CGPoint(x: f.midX, y: f.midY))
        if (try? poll(failure, condition)) != nil { return }
        click(CGPoint(x: f.midX, y: f.midY))
        try poll(failure, condition)
    }

    private static func click(_ p: CGPoint) {
        for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
            CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
            usleep(60_000)
        }
    }

    private static func hover(_ element: AXUIElement) {
        guard let f = frame(of: element) else { return }
        let p = CGPoint(x: f.midX, y: f.midY)
        CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(150_000)
    }

    private static func dragMouse(from: CGPoint, to: CGPoint) {
        func post(_ type: CGEventType, _ p: CGPoint) {
            CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
            usleep(40_000)
        }
        post(.mouseMoved, from)
        post(.leftMouseDown, from)
        let steps = 8
        for i in 1...steps {
            let t = CGFloat(i) / CGFloat(steps)
            post(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
        }
        usleep(200_000)
        post(.leftMouseUp, to)
    }

    private static func postKey(_ keyCode: CGKeyCode) {
        CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true)?.post(tap: .cghidEventTap)
        CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)?.post(tap: .cghidEventTap)
    }

    // MARK: - Spaces helpers

    private static func displayUUID(of screen: NSScreen) throws -> String {
        guard let uuid = Spaces.displayUUID(of: screen) else { throw Failure(step: "no display id for \(screen.localizedName)") }
        return uuid
    }

    private static func display(_ uuid: String) throws -> Spaces.DisplaySpaces {
        guard let display = try Spaces.displays().first(where: { $0.displayUUID == uuid }) else { throw Failure(step: "display \(uuid) has no desktops") }
        return display
    }

    private static func spaces(ofDisplay uuid: String) throws -> [SpaceID] { try display(uuid).spaces }
    private static func current(ofDisplay uuid: String) throws -> SpaceID { try display(uuid).current }

    private static func poll(_ failure: String, _ condition: () -> Bool, timeout: TimeInterval = timeout) throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            usleep(100_000)
        }
        throw Failure(step: failure)
    }

    // MARK: - AX helpers

    static func find(identifier wanted: String, under element: AXUIElement, depth: Int = 6) -> AXUIElement? {
        if identifier(of: element) == wanted { return element }
        guard depth > 0 else { return nil }
        for child in children(of: element) {
            if let found = find(identifier: wanted, under: child, depth: depth - 1) { return found }
        }
        return nil
    }

    static func descendants(of element: AXUIElement, depth: Int) -> [AXUIElement] {
        guard depth > 0 else { return [] }
        return children(of: element).flatMap { [$0] + descendants(of: $0, depth: depth - 1) }
    }

    static func children(of element: AXUIElement) -> [AXUIElement] { attribute(element, kAXChildrenAttribute) ?? [] }
    static func identifier(of element: AXUIElement) -> String? { attribute(element, kAXIdentifierAttribute) }
    static func role(of element: AXUIElement) -> String? { attribute(element, kAXRoleAttribute) }
    static func description(of element: AXUIElement) -> String? { attribute(element, kAXDescriptionAttribute) }
    static func title(of element: AXUIElement) -> String? { attribute(element, kAXTitleAttribute) }

    // Screen-space frame (top-left origin), as the Accessibility API reports it
    static func frame(of element: AXUIElement) -> CGRect? {
        guard let positionValue: AXValue = attribute(element, kAXPositionAttribute),
              let sizeValue: AXValue = attribute(element, kAXSizeAttribute) else { return nil }
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &position), AXValueGetValue(sizeValue, .cgSize, &size) else { return nil }
        return CGRect(origin: position, size: size)
    }

    private static func attribute<T>(_ element: AXUIElement, _ name: String) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value as? T
    }
}

@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ out: UnsafeMutablePointer<CGWindowID>) -> AXError

private extension AXUIElement {
    var windowID: CGWindowID? {
        var id: CGWindowID = 0
        return _AXUIElementGetWindow(self, &id) == .success ? id : nil
    }
}
