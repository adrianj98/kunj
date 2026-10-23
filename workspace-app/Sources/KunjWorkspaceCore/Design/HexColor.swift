import Foundation

/// A colour as 0...1 components, parsed from the token hex strings.
public struct RGBA: Equatable, Sendable {
    public let r: Double
    public let g: Double
    public let b: Double
    public let a: Double

    public init(r: Double, g: Double, b: Double, a: Double) {
        self.r = r
        self.g = g
        self.b = b
        self.a = a
    }
}

/// Parses `#rgb`, `#rrggbb` and `#rrggbbaa`; nil for anything else.
public func parseHex(_ s: String) -> RGBA? {
    guard s.hasPrefix("#") else { return nil }
    var hex = String(s.dropFirst())
    guard hex.allSatisfy(\.isHexDigit) else { return nil }
    if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
    guard hex.count == 6 || hex.count == 8, let v = UInt64(hex, radix: 16) else { return nil }
    let comps = hex.count == 8 ? [v >> 24, v >> 16, v >> 8, v] : [v >> 16, v >> 8, v, 255]
    let d = comps.map { Double($0 & 0xff) / 255 }
    return RGBA(r: d[0], g: d[1], b: d[2], a: d[3])
}
