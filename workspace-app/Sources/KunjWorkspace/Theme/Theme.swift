import AppKit
import KunjWorkspaceCore

typealias ThemeTokens = DesignTokens.ThemeTokens

extension NSColor {
    /// A token hex string (`#rrggbb`); magenta when it does not parse, so a bad token shows.
    convenience init(token: String, alpha: CGFloat? = nil) {
        let c = parseHex(token) ?? RGBA(r: 1, g: 0, b: 1, a: 1)
        self.init(srgbRed: c.r, green: c.g, blue: c.b, alpha: alpha ?? c.a)
    }
}

/// NSColor and NSFont from the design tokens. Every colour a view draws comes from here.
struct Theme {
    let tokens: ThemeTokens

    func color(_ key: KeyPath<ThemeTokens, String>, alpha: CGFloat? = nil) -> NSColor {
        NSColor(token: tokens[keyPath: key], alpha: alpha)
    }

    var isDark: Bool { tokens.name != DesignTokens.light.name }
    var appearance: NSAppearance? { NSAppearance(named: isDark ? .darkAqua : .aqua) }

    /// Inter by PostScript name (`Inter-Regular`, `-Medium`, `-SemiBold`), else the system font.
    static func sans(_ size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
        let suffix: String
        switch weight {
        case .semibold, .bold, .heavy, .black: suffix = "SemiBold"
        case .medium: suffix = "Medium"
        default: suffix = "Regular"
        }
        return NSFont(name: "\(DesignTokens.Fonts.sans)-\(suffix)", size: size) ?? .systemFont(ofSize: size, weight: weight)
    }

    /// JetBrains Mono by PostScript name (`JetBrainsMono-Regular`, `-Medium`), else the system mono font.
    static func mono(_ size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
        let suffix = weight == .regular || weight == .light || weight == .thin ? "Regular" : "Medium"
        return NSFont(name: "\(DesignTokens.Fonts.mono)-\(suffix)", size: size)
            ?? .monospacedSystemFont(ofSize: size, weight: weight)
    }
}

/// `auto` follows the system appearance (light ↔ warm); the others are fixed.
enum ThemeChoice: String, CaseIterable {
    case auto, warm, light, graphite

    var title: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
}

/// The current theme: the `theme` user default, resolved against the system appearance for `auto`.
final class ThemeManager {
    static let shared = ThemeManager()

    private static let defaultsKey = "theme"
    private(set) var current: Theme
    /// Called on the main thread whenever `current` changes.
    var onChange: [(Theme) -> Void] = []
    private var observation: NSKeyValueObservation?

    var choice: ThemeChoice {
        get { ThemeChoice(rawValue: UserDefaults.standard.string(forKey: Self.defaultsKey) ?? "") ?? .auto }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: Self.defaultsKey)
            update()
        }
    }

    private init() {
        current = Theme(tokens: DesignTokens.warm)
        current = resolve()
        observation = NSApp?.observe(\.effectiveAppearance, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.update() }
        }
    }

    /// A theme for this run only, not saved (`--demo` renders warm, the reference mockup, unless
    /// `-theme <name>` is given).
    var override: ThemeChoice? { didSet { update() } }

    private func resolve() -> Theme {
        switch override ?? choice {
        case .warm: return Theme(tokens: DesignTokens.warm)
        case .light: return Theme(tokens: DesignTokens.light)
        case .graphite: return Theme(tokens: DesignTokens.graphite)
        case .auto:
            let dark = NSApp?.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) != .aqua
            return Theme(tokens: dark ? DesignTokens.warm : DesignTokens.light)
        }
    }

    private func update() {
        let next = resolve()
        guard next.tokens != current.tokens else { return }
        current = next
        for f in onChange { f(next) }
    }
}
