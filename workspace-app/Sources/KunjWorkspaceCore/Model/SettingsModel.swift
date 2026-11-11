import Foundation

// The Settings window's rows, worked out from `kunj config --schema` and `kunj config --list`
// for one scope (docs/specs/workspace-settings.md). No AppKit: the window only draws these.

/// Where a row's value comes from.
public enum SettingSource: Equatable, Sendable {
    case `default`, global, repo
}

/// The control a row gets, decided from the setting's type and the value it holds.
public enum SettingControl: Equatable, Sendable {
    case checkbox
    case popup([String])
    case number
    case text
    /// A credential: never shown, only replaced.
    case secret
    /// A list of strings, one per line.
    case lines
    /// Anything else, edited as JSON text.
    case json
}

public struct SettingRow: Equatable, Sendable, Identifiable {
    public var id: String { key }
    public var key: String
    public var title: String
    public var description: String
    public var category: String
    public var control: SettingControl
    /// The value in effect in this scope; nil only when the setting has no default either.
    public var value: JSONValue?
    public var source: SettingSource
    /// The value is in the file of the scope shown, so Reset is offered.
    public var isSetInScope: Bool
}

public struct SettingsModel: Equatable, Sendable {
    public let schema: ConfigSchemaJson
    public let scope: SettingsScope
    private var global: JSONValue
    private var local: JSONValue

    /// `list.merged` is not used: it is kunj's merge for the directory the command ran in, and
    /// the window shows each file's own values.
    public init(schema: ConfigSchemaJson, list: ConfigListJson, scope: SettingsScope) {
        self.schema = schema
        self.scope = scope
        self.global = list.global
        self.local = scope == .global ? .object([:]) : list.local
    }

    public var categories: [ConfigCategoryJson] { schema.categories }

    public func row(_ setting: ConfigSettingJson) -> SettingRow {
        let inLocal = scope == .global ? nil : local.at(setting.key)
        let inGlobal = global.at(setting.key)
        let value: JSONValue?
        let source: SettingSource
        if let inLocal {
            value = inLocal
            source = .repo
        } else if let inGlobal {
            value = inGlobal
            source = .global
        } else {
            value = setting.default
            source = .default
        }
        return SettingRow(
            key: setting.key, title: settingTitle(setting.key), description: setting.description,
            category: setting.category, control: settingControl(setting, value: value), value: value, source: source,
            isSetInScope: scope == .global ? inGlobal != nil : inLocal != nil)
    }

    public func row(for key: String) -> SettingRow? {
        schema.settings.first { $0.key == key }.map(row)
    }

    /// The rows of a category, in the schema's order.
    public func rows(in category: String) -> [SettingRow] {
        schema.settings.filter { $0.category == category }.map(row)
    }

    /// Rows whose key, title or description contains `text` (case-insensitive); none for empty text.
    public func search(_ text: String) -> [SettingRow] {
        let needle = text.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return [] }
        return schema.settings.map(row).filter {
            $0.key.lowercased().contains(needle) || $0.title.lowercased().contains(needle)
                || $0.description.lowercased().contains(needle)
        }
    }

    /// The model after a write in this scope: `value` set, or nil after an unset.
    public func replacing(_ key: String, with value: JSONValue?) -> SettingsModel {
        var copy = self
        if scope == .global {
            copy.global = Self.edit(global, key, value)
        } else {
            copy.local = Self.edit(local, key, value)
        }
        return copy
    }

    private static func edit(_ root: JSONValue, _ key: String, _ value: JSONValue?) -> JSONValue {
        func go(_ node: JSONValue, _ parts: ArraySlice<String>) -> JSONValue? {
            var object: [String: JSONValue] = [:]
            if case .object(let o) = node { object = o }
            guard let head = parts.first else { return value }
            let child = go(object[head] ?? .object([:]), parts.dropFirst())
            if let child {
                object[head] = child
            } else {
                object[head] = nil
            }
            // an unset removes the parents it leaves empty, as kunj does
            return object.isEmpty && value == nil ? nil : .object(object)
        }
        return go(root, ArraySlice(key.split(separator: ".").map(String.init))) ?? .object([:])
    }
}

/// The control for a setting holding `value`. A value whose JSON type is not the setting's (a
/// config file edited by hand) gets the JSON box, so it can be seen and fixed.
public func settingControl(_ setting: ConfigSettingJson, value: JSONValue?) -> SettingControl {
    switch (setting.type, value) {
    case ("boolean", .bool), ("boolean", nil):
        return .checkbox
    case ("enum", .string(let s)):
        let options = setting.options ?? []
        return .popup(options.contains(s) ? options : options + [s])
    case ("enum", nil):
        return .popup(setting.options ?? [])
    case ("number", .number), ("number", nil):
        return .number
    case ("string", .string), ("string", nil):
        return setting.sensitive == true ? .secret : .text
    case ("array", .array(let items)):
        return items.allSatisfy { if case .string = $0 { return true } else { return false } } ? .lines : .json
    case ("array", nil):
        return .lines
    default:
        return .json
    }
}

private let settingTitles: [String: String] = [
    "agent.tmux": "Run agents in tmux",
    "agent.tmuxStatus": "Show tmux status line",
    "container.useGhToken": "Use gh's GitHub token",
]

private let settingAcronyms: [String: String] = [
    "pr": "PR", "ai": "AI", "aws": "AWS", "gh": "GitHub", "url": "URL", "wip": "WIP", "lsp": "LSP",
    "cpus": "CPUs", "mcp": "MCP", "api": "API", "id": "ID", "ms": "(ms)",
]

/// A row's title: the key's last part in words (`agent.antigravityCommand` → "Antigravity command").
/// A last part shared by several keys keeps the part before it (`lsp.idleStopMinutes.cold` →
/// "Idle stop minutes cold").
public func settingTitle(_ key: String) -> String {
    if let fixed = settingTitles[key] { return fixed }
    let parts = key.split(separator: ".").map(String.init)
    let tail = parts.count > 2 ? parts.dropFirst().joined(separator: "-") : (parts.last ?? key)
    var words: [String] = []
    var current = ""
    for ch in tail {
        if ch == "-" || ch == "_" {
            if !current.isEmpty { words.append(current) }
            current = ""
        } else if ch.isUppercase, let last = current.last, !last.isUppercase {
            words.append(current)
            current = String(ch)
        } else {
            current.append(ch)
        }
    }
    if !current.isEmpty { words.append(current) }
    return words.enumerated().map { i, word in
        let lower = word.lowercased()
        if let acronym = settingAcronyms[lower] { return acronym }
        return i == 0 ? lower.prefix(1).uppercased() + lower.dropFirst() : lower
    }.joined(separator: " ")
}

/// "default", "Global" or the repository's name: where the row's value comes from.
public func sourceCaption(_ row: SettingRow, scope: SettingsScope) -> String {
    switch row.source {
    case .default: return "default"
    case .global: return "Global"
    case .repo:
        if case .repo(_, let name) = scope { return name }
        return "repository"
    }
}

/// What a text-like control shows for the row. A secret shows nothing, ever.
public func settingText(_ row: SettingRow) -> String {
    guard let value = row.value else { return "" }
    switch row.control {
    case .secret:
        return ""
    case .text:
        if case .string(let s) = value { return s }
        return value.compact()
    case .lines:
        guard case .array(let items) = value else { return value.pretty() }
        return items.map { if case .string(let s) = $0 { return s } else { return $0.compact() } }.joined(separator: "\n")
    case .json:
        return value.pretty()
    case .number, .checkbox, .popup:
        if case .string(let s) = value { return s }
        return value.compact()
    }
}

/// A secret row has a value stored (the field's placeholder says "Set").
public func secretIsSet(_ row: SettingRow) -> Bool {
    if case .string(let s) = row.value { return !s.isEmpty }
    return false
}

public enum SettingInputError: Error, Equatable {
    case notANumber, notJSON
}

/// The value a text-like control's text stands for.
public func settingValue(from text: String, for control: SettingControl) -> Result<JSONValue, SettingInputError> {
    switch control {
    case .number:
        guard let n = Double(text.trimmingCharacters(in: .whitespacesAndNewlines)), n.isFinite else { return .failure(.notANumber) }
        return .success(.number(n))
    case .lines:
        let items = text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return .success(.array(items.map(JSONValue.string)))
    case .json:
        guard let value = JSONValue(json: text) else { return .failure(.notJSON) }
        return .success(value)
    case .text, .secret, .checkbox, .popup:
        return .success(.string(text))
    }
}

/// What a secure field writes when it loses focus: nothing unless the user typed in it, so
/// clicking through never replaces a stored token with the empty string.
public func secretChange(typed: String, edited: Bool) -> JSONValue? {
    edited ? .string(typed) : nil
}
