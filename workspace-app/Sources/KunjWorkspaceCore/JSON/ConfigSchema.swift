import Foundation

// Mirrors of `kunj config`'s JSON for the Settings window (docs/specs/workspace-settings.md):
// `--schema` (ConfigSchemaJson), `--list` (ConfigListJson), `--set-json` (ConfigSetJson) and
// `--unset` (ConfigUnsetJson) in src/lib/json-types.ts. Unknown fields are ignored.

public struct ConfigCategoryJson: Decodable, Equatable, Sendable {
    public var id: String
    public var title: String

    public init(id: String, title: String) {
        self.id = id
        self.title = title
    }
}

public struct ConfigSettingJson: Decodable, Equatable, Sendable {
    public var key: String
    public var category: String
    /// boolean, number, string, enum, array, object; anything else is treated as JSON.
    public var type: String
    public var description: String
    public var `default`: JSONValue?
    public var detailedDescription: String?
    public var options: [String]?
    public var sensitive: Bool?

    public init(key: String, category: String, type: String, description: String = "", default: JSONValue? = nil,
                detailedDescription: String? = nil, options: [String]? = nil, sensitive: Bool? = nil) {
        self.key = key
        self.category = category
        self.type = type
        self.description = description
        self.default = `default`
        self.detailedDescription = detailedDescription
        self.options = options
        self.sensitive = sensitive
    }
}

public struct ConfigSchemaJson: Decodable, Equatable, Sendable {
    public var categories: [ConfigCategoryJson]
    public var settings: [ConfigSettingJson]

    public init(categories: [ConfigCategoryJson], settings: [ConfigSettingJson]) {
        self.categories = categories
        self.settings = settings
    }
}

/// `kunj config --list --json`: the two files as they are, and kunj's merge of them with the defaults.
public struct ConfigListJson: Decodable, Equatable, Sendable {
    public var global: JSONValue
    public var local: JSONValue
    public var merged: JSONValue

    public init(global: JSONValue = .object([:]), local: JSONValue = .object([:]), merged: JSONValue = .object([:])) {
        self.global = global
        self.local = local
        self.merged = merged
    }
}

public struct ConfigSetJson: Decodable, Equatable, Sendable {
    public var key: String
    public var value: JSONValue
    public var scope: String
}

public struct ConfigUnsetJson: Decodable, Equatable, Sendable {
    public var key: String
    public var scope: String
    public var removed: Bool
}

/// Which config file Settings shows and writes: the global one, or one repository's.
public enum SettingsScope: Equatable, Sendable {
    case global
    case repo(root: String, name: String)
}

/// `kunj config --schema` (run with `--json`; needs no repository).
public let configSchemaArgs = ["config", "--schema"]

/// `kunj config --list` (run with `--json`, in `settingsCwd`).
public let configListArgs = ["config", "--list"]

/// `kunj config --set-json <key>=<json> [--global]`: one argument, so a value that starts with
/// `-` is never read as an option.
public func configSetJsonArgs(_ key: String, _ value: JSONValue, _ scope: SettingsScope) -> [String] {
    ["config", "--set-json", "\(key)=\(value.compact())"] + (scope == .global ? ["--global"] : [])
}

/// `kunj config --unset <key> [--global]`.
public func configUnsetArgs(_ key: String, _ scope: SettingsScope) -> [String] {
    ["config", "--unset", key] + (scope == .global ? ["--global"] : [])
}

/// Where the config commands of a scope run: the home directory for the global config, the
/// repository root for a repository's.
public func settingsCwd(_ scope: SettingsScope, home: String) -> String {
    switch scope {
    case .global: return home
    case .repo(let root, _): return root
    }
}
