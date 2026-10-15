// Which desktops (Spaces) each display has and which desktop a window is on, read
// through SkyLight's private but widely used functions (Rectangle, AltTab and
// Hammerspoon read the same ones). Read-only: creating and switching desktops is
// done through Mission Control, see MissionControl.swift.

import AppKit
import KunjBarCore

enum Spaces {
    struct DisplaySpaces {
        let displayUUID: String
        let current: SpaceID
        // User desktops in Spaces-bar order (full-screen apps' spaces left out)
        let spaces: [SpaceID]
        // Every space in Spaces-bar order, one per button in Mission Control
        let allSpaces: [SpaceID]
    }

    struct MissingSymbol: Error, CustomStringConvertible {
        let name: String
        var description: String { "SkyLight symbol \(name) is missing" }
    }

    private typealias MainConnectionID = @convention(c) () -> Int32
    private typealias CopyManagedDisplaySpaces = @convention(c) (Int32) -> Unmanaged<CFArray>?
    private typealias CopySpacesForWindows = @convention(c) (Int32, Int32, CFArray) -> Unmanaged<CFArray>?

    private static let handle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)

    private static func symbol<T>(_ name: String, as type: T.Type) throws -> T {
        guard let handle, let pointer = dlsym(handle, name) else { throw MissingSymbol(name: name) }
        return unsafeBitCast(pointer, to: type)
    }

    private static func connection() throws -> Int32 {
        try symbol("CGSMainConnectionID", as: MainConnectionID.self)()
    }

    static func displays() throws -> [DisplaySpaces] {
        let copy = try symbol("CGSCopyManagedDisplaySpaces", as: CopyManagedDisplaySpaces.self)
        guard let raw = copy(try connection())?.takeRetainedValue() as? [[String: Any]] else { return [] }
        return raw.compactMap { display in
            guard let uuid = display["Display Identifier"] as? String,
                  let current = (display["Current Space"] as? [String: Any])?["ManagedSpaceID"] as? NSNumber,
                  let spaces = display["Spaces"] as? [[String: Any]] else { return nil }
            let all = spaces.compactMap { space -> (SpaceID, Int)? in
                guard let id = space["ManagedSpaceID"] as? NSNumber else { return nil }
                return (id.uint64Value, (space["type"] as? NSNumber)?.intValue ?? -1)
            }
            return DisplaySpaces(displayUUID: uuid, current: current.uint64Value,
                                 spaces: all.filter { $0.1 == 0 }.map(\.0), allSpaces: all.map(\.0))
        }
    }

    // The desktop each window is on; windows on no desktop (or unknown) are absent.
    static func space(of windowIDs: [UInt32]) throws -> [UInt32: SpaceID] {
        try spaces(of: windowIDs).compactMapValues(\.first)
    }

    // Every space each window is on (several for a window assigned to all desktops).
    static func spaces(of windowIDs: [UInt32]) throws -> [UInt32: [SpaceID]] {
        let copy = try symbol("CGSCopySpacesForWindows", as: CopySpacesForWindows.self)
        let cid = try connection()
        var result: [UInt32: [SpaceID]] = [:]
        for id in windowIDs {
            guard let spaces = copy(cid, 7, [NSNumber(value: id)] as CFArray)?.takeRetainedValue() as? [NSNumber],
                  !spaces.isEmpty else { continue }
            result[id] = spaces.map(\.uint64Value)
        }
        return result
    }

    // The spaces of every ordinary (layer 0) window of every app, minimized and
    // off-screen ones included, so a desktop holding anything at all counts as used.
    static func spacesOfAllWindows() throws -> [[SpaceID]] {
        let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let ids = info.compactMap { window -> UInt32? in
            guard (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 else { return nil }
            return (window[kCGWindowNumber as String] as? NSNumber)?.uint32Value
        }
        return Array(try spaces(of: ids).values)
    }

    static func displayUUID(of screen: NSScreen) -> String? {
        guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
              let uuid = CGDisplayCreateUUIDFromDisplayID(number.uint32Value)?.takeRetainedValue() else { return nil }
        return CFUUIDCreateString(nil, uuid) as String
    }

    // The screen whose display UUID matches, when it is attached.
    static func screen(forDisplayUUID uuid: String) -> NSScreen? {
        NSScreen.screens.first { displayUUID(of: $0) == uuid }
    }
}
