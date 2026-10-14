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
            let user = spaces.compactMap { space -> SpaceID? in
                guard (space["type"] as? NSNumber)?.intValue == 0, let id = space["ManagedSpaceID"] as? NSNumber else { return nil }
                return id.uint64Value
            }
            return DisplaySpaces(displayUUID: uuid, current: current.uint64Value, spaces: user)
        }
    }

    // The desktop each window is on; windows on no desktop (or unknown) are absent.
    static func space(of windowIDs: [UInt32]) throws -> [UInt32: SpaceID] {
        let copy = try symbol("CGSCopySpacesForWindows", as: CopySpacesForWindows.self)
        let cid = try connection()
        var result: [UInt32: SpaceID] = [:]
        for id in windowIDs {
            guard let spaces = copy(cid, 7, [NSNumber(value: id)] as CFArray)?.takeRetainedValue() as? [NSNumber],
                  let first = spaces.first else { continue }
            result[id] = first.uint64Value
        }
        return result
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
