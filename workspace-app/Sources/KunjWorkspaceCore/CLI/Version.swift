import Foundation

/// A `major.minor.patch` version as `kunj -V` prints it. A leading `v` and surrounding
/// whitespace are accepted; a `-pre`/`+build` suffix is ignored (so `1.4.0-beta.1` == `1.4.0`).
public struct SemVer: Comparable, Hashable, CustomStringConvertible, Sendable {
    public let major: Int
    public let minor: Int
    public let patch: Int

    public init(major: Int, minor: Int, patch: Int) {
        self.major = major
        self.minor = minor
        self.patch = patch
    }

    public init?(_ s: String) {
        var text = Substring(s.trimmingCharacters(in: .whitespacesAndNewlines))
        if text.hasPrefix("v") { text = text.dropFirst() }
        if let cut = text.firstIndex(where: { $0 == "-" || $0 == "+" }) { text = text[..<cut] }
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var numbers: [Int] = []
        for p in parts {
            guard !p.isEmpty, p.allSatisfy(\.isASCII), p.allSatisfy(\.isNumber), let n = Int(p) else { return nil }
            numbers.append(n)
        }
        self.init(major: numbers[0], minor: numbers[1], patch: numbers[2])
    }

    public static func < (a: SemVer, b: SemVer) -> Bool {
        (a.major, a.minor, a.patch) < (b.major, b.minor, b.patch)
    }

    public var description: String { "\(major).\(minor).\(patch)" }
}

/// The oldest kunj whose JSON contract the app understands: the first release after v1.2.0.
public let MIN_KUNJ_VERSION = SemVer("1.3.0")!

/// `1.0.0` is what an `npm link`ed checkout reports (the release workflow rewrites package.json),
/// so it is accepted and shown as a dev build.
let DEV_KUNJ_VERSION = SemVer("1.0.0")!

public struct VersionCheck: Equatable, Sendable {
    public let ok: Bool
    public let dev: Bool

    public init(ok: Bool, dev: Bool) {
        self.ok = ok
        self.dev = dev
    }
}

/// Whether the version `kunj -V` printed is usable: at least `min`, or the dev build `1.0.0`.
/// Anything that does not parse is refused.
public func checkVersion(_ s: String, min: SemVer = MIN_KUNJ_VERSION) -> VersionCheck {
    guard let v = SemVer(s) else { return VersionCheck(ok: false, dev: false) }
    if v == DEV_KUNJ_VERSION { return VersionCheck(ok: true, dev: true) }
    return VersionCheck(ok: v >= min, dev: false)
}
