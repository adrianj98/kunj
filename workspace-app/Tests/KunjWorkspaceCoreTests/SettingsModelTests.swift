import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct SettingsModelTests {
    private let repo = SettingsScope.repo(root: "/r", name: "kunj")

    private func setting(_ key: String, _ type: String, _ def: JSONValue? = nil, options: [String]? = nil,
                         sensitive: Bool? = nil, description: String = "") -> ConfigSettingJson {
        ConfigSettingJson(key: key, category: String(key.split(separator: ".")[0]), type: type,
                          description: description, default: def, options: options, sensitive: sensitive)
    }

    private func model(_ settings: [ConfigSettingJson], global: String = "{}", local: String = "{}",
                       merged: String = "{}", scope: SettingsScope = .global) -> SettingsModel {
        let categories = settings.map(\.category).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        return SettingsModel(
            schema: ConfigSchemaJson(categories: categories.map { ConfigCategoryJson(id: $0, title: $0) }, settings: settings),
            list: ConfigListJson(global: JSONValue(json: global)!, local: JSONValue(json: local)!, merged: JSONValue(json: merged)!),
            scope: scope)
    }

    private var tmux: ConfigSettingJson { setting("agent.tmux", "boolean", .bool(true), description: "Run agents in a tmux session") }

    @Test func globalScopeReadsGlobalThenDefault() {
        let set = model([tmux], global: #"{"agent":{"tmux":false}}"#, local: #"{"agent":{"tmux":true}}"#).row(for: "agent.tmux")!
        #expect(set.value == .bool(false))
        #expect(set.source == .global)
        #expect(set.isSetInScope)
        let unset = model([tmux]).row(for: "agent.tmux")!
        #expect(unset.value == .bool(true))
        #expect(unset.source == .default)
        #expect(!unset.isSetInScope)
    }

    @Test func repoScopeReadsLocalThenGlobalThenDefault() {
        let local = model([tmux], global: #"{"agent":{"tmux":true}}"#, local: #"{"agent":{"tmux":false}}"#, scope: repo).row(for: "agent.tmux")!
        #expect(local.value == .bool(false))
        #expect(local.source == .repo)
        #expect(local.isSetInScope)
        let global = model([tmux], global: #"{"agent":{"tmux":false}}"#, scope: repo).row(for: "agent.tmux")!
        #expect(global.value == .bool(false))
        #expect(global.source == .global)
        #expect(!global.isSetInScope)
        #expect(model([tmux], scope: repo).row(for: "agent.tmux")!.source == .default)
    }

    @Test func mergedIsIgnored() {
        let row = model([tmux], merged: #"{"agent":{"tmux":false}}"#, scope: repo).row(for: "agent.tmux")!
        #expect(row.value == .bool(true))
        #expect(row.source == .default)
    }

    @Test func controlPerType() {
        #expect(settingControl(tmux, value: .bool(false)) == .checkbox)
        #expect(settingControl(setting("p.sort", "enum", options: ["a", "b"]), value: .string("a")) == .popup(["a", "b"]))
        #expect(settingControl(setting("p.size", "number"), value: .number(3)) == .number)
        #expect(settingControl(setting("a.command", "string"), value: .string("x")) == .text)
        #expect(settingControl(setting("j.token", "string", sensitive: true), value: .string("x")) == .secret)
        #expect(settingControl(setting("j.token", "string", sensitive: true), value: nil) == .secret)
        #expect(settingControl(setting("c.env", "array"), value: .array([.string("A")])) == .lines)
        #expect(settingControl(setting("c.env", "array"), value: .array([])) == .lines)
        #expect(settingControl(setting("c.files", "array"), value: .array([.object([:])])) == .json)
        #expect(settingControl(setting("l.servers", "object"), value: .object([:])) == .json)
        #expect(settingControl(setting("x.y", "duration"), value: .string("1m")) == .json)
    }

    @Test func mismatchedValueBecomesJSON() {
        #expect(settingControl(tmux, value: .string("yes")) == .json)
        #expect(settingControl(setting("a.command", "string"), value: .object([:])) == .json)
        #expect(settingControl(setting("p.size", "number"), value: .string("3")) == .json)
        #expect(settingControl(setting("p.sort", "enum", options: ["a"]), value: .bool(true)) == .json)
        #expect(settingControl(tmux, value: .null) == .json)
        // and such a row can be shown without trouble
        let row = model([tmux], global: #"{"agent":{"tmux":"yes"}}"#).row(for: "agent.tmux")!
        #expect(settingText(row) == "\"yes\"")
    }

    @Test func enumKeepsAnUnknownStoredValue() {
        #expect(settingControl(setting("p.sort", "enum", options: ["a", "b"]), value: .string("c")) == .popup(["a", "b", "c"]))
    }

    @Test func hooksArrayValueIsJSON() {
        #expect(settingControl(setting("hooks.pre-commit", "string"), value: .array([.string("a"), .string("b")])) == .json)
    }

    @Test func titles() {
        #expect(settingTitle("agent.tmux") == "Run agents in tmux")
        #expect(settingTitle("agent.antigravityCommand") == "Antigravity command")
        #expect(settingTitle("ai.awsRegion") == "AWS region")
        #expect(settingTitle("hooks.pre-commit") == "Pre commit")
        #expect(settingTitle("preferences.showOnlyWIP") == "Show only WIP")
        #expect(settingTitle("lsp.idleStopMinutes.cold") == "Idle stop minutes cold")
        #expect(settingTitle("container.network.allow") == "Network allow")
        #expect(settingTitle("jira.baseUrl") == "Base URL")
    }

    @Test func everyFixtureSettingHasADistinctTitleInItsCategory() throws {
        let schema = try JSONDecoder().decode(ConfigSchemaJson.self, from: Data(contentsOf: responsesDir.appendingPathComponent("config_schema.json")))
        for category in schema.categories {
            let titles = schema.settings.filter { $0.category == category.id }.map { settingTitle($0.key) }
            #expect(Set(titles).count == titles.count, "duplicate titles in \(category.id): \(titles)")
            #expect(titles.allSatisfy { !$0.isEmpty })
        }
    }

    @Test func textRoundTrips() {
        let env = model([setting("container.env", "array", .array([]))], global: #"{"container":{"env":["A,B","C"]}}"#).row(for: "container.env")!
        #expect(settingText(env) == "A,B\nC")
        #expect(settingValue(from: "A,B\n\n  C  \n", for: .lines) == .success(.array([.string("A,B"), .string("C")])))
        #expect(settingValue(from: "", for: .lines) == .success(.array([])))
        #expect(settingValue(from: "", for: .text) == .success(.string("")))
        #expect(settingValue(from: "12", for: .text) == .success(.string("12")))
        #expect(settingValue(from: " true ", for: .text) == .success(.string(" true ")))
        let size = model([setting("p.size", "number", .number(15))]).row(for: "p.size")!
        #expect(settingText(size) == "15")
    }

    @Test func numberInput() {
        #expect(settingValue(from: " 3 ", for: .number) == .success(.number(3)))
        #expect(settingValue(from: "-0.5", for: .number) == .success(.number(-0.5)))
        #expect(settingValue(from: "abc", for: .number) == .failure(.notANumber))
        #expect(settingValue(from: "", for: .number) == .failure(.notANumber))
        #expect(settingValue(from: "1e999", for: .number) == .failure(.notANumber))
        #expect(settingValue(from: "nan", for: .number) == .failure(.notANumber))
    }

    @Test func jsonInput() {
        #expect(settingValue(from: "{bad", for: .json) == .failure(.notJSON))
        #expect(settingValue(from: #"{"a":1}"#, for: .json) == .success(.object(["a": .number(1)])))
        let servers = model([setting("lsp.servers", "object", .object([:]))], global: #"{"lsp":{"servers":{"go":{"command":"gopls"}}}}"#).row(for: "lsp.servers")!
        #expect(settingValue(from: settingText(servers), for: .json) == .success(servers.value!))
    }

    @Test func secretNeverShowsAndUntouchedWritesNothing() {
        let token = setting("jira.apiToken", "string", .string(""), sensitive: true)
        let row = model([token], global: #"{"jira":{"apiToken":"s3cret"}}"#).row(for: "jira.apiToken")!
        #expect(row.control == .secret)
        #expect(settingText(row) == "")
        #expect(secretIsSet(row))
        #expect(!secretIsSet(model([token]).row(for: "jira.apiToken")!))
        #expect(secretChange(typed: "", edited: false) == nil)
        #expect(secretChange(typed: "leftover", edited: false) == nil)
        #expect(secretChange(typed: "", edited: true) == .string(""))
        #expect(secretChange(typed: "new", edited: true) == .string("new"))
    }

    @Test func searchMatchesKeyTitleAndDescription() {
        let m = model([tmux, setting("agent.tmuxStatus", "boolean", .bool(false)), setting("agent.command", "string", .string("claude"), description: "What a tab runs")])
        #expect(m.search("tmux").map(\.key) == ["agent.tmux", "agent.tmuxStatus"])
        #expect(m.search("TMUX").count == 2)
        #expect(m.search("status line").map(\.key) == ["agent.tmuxStatus"])
        #expect(m.search("tab runs").map(\.key) == ["agent.command"])
        #expect(m.search("").isEmpty)
        #expect(m.search("   ").isEmpty)
    }

    @Test func replacingUpdatesValueAndSource() {
        var m = model([tmux, setting("lsp.idleStopMinutes.cold", "number", .number(15))], global: #"{"stale":{"x":1}}"#)
        m = m.replacing("agent.tmux", with: .bool(false))
        #expect(m.row(for: "agent.tmux")!.value == .bool(false))
        #expect(m.row(for: "agent.tmux")!.source == .global)
        #expect(m.row(for: "agent.tmux")!.isSetInScope)
        m = m.replacing("lsp.idleStopMinutes.cold", with: .number(3))
        #expect(m.row(for: "lsp.idleStopMinutes.cold")!.value == .number(3))
        m = m.replacing("agent.tmux", with: nil).replacing("lsp.idleStopMinutes.cold", with: nil)
        #expect(m.row(for: "agent.tmux")!.source == .default)
        #expect(m.row(for: "agent.tmux")!.value == .bool(true))
        #expect(m.row(for: "lsp.idleStopMinutes.cold")!.value == .number(15))
        // unsetting something that was never set changes nothing
        #expect(m.replacing("agent.tmux", with: nil) == m)
    }

    @Test func replacingInARepositoryLeavesGlobalAlone() {
        var m = model([tmux], global: #"{"agent":{"tmux":false}}"#, scope: repo)
        m = m.replacing("agent.tmux", with: .bool(true))
        #expect(m.row(for: "agent.tmux")!.source == .repo)
        m = m.replacing("agent.tmux", with: nil)
        #expect(m.row(for: "agent.tmux")!.source == .global)
        #expect(m.row(for: "agent.tmux")!.value == .bool(false))
    }

    @Test func rowsKeepSchemaOrderWithinACategory() {
        let m = model([setting("agent.b", "string"), setting("other.x", "string"), setting("agent.a", "string")])
        #expect(m.rows(in: "agent").map(\.key) == ["agent.b", "agent.a"])
        #expect(m.categories.map(\.id) == ["agent", "other"])
    }

    @Test func sourceCaptions() {
        let m = model([tmux], global: #"{"agent":{"tmux":false}}"#, local: #"{"agent":{"tmux":true}}"#, scope: repo)
        #expect(sourceCaption(m.row(for: "agent.tmux")!, scope: repo) == "kunj")
        #expect(sourceCaption(model([tmux], global: #"{"agent":{"tmux":false}}"#).row(for: "agent.tmux")!, scope: .global) == "Global")
        #expect(sourceCaption(model([tmux]).row(for: "agent.tmux")!, scope: .global) == "default")
    }

    @Test func writeErrorsNeverCarryTheValue() {
        let fallback = KunjCLIError(code: .commandFailed, message: #"kunj config --set-json jira.apiToken="s3cret" --global exited with code 1"#)
        #expect(settingWriteMessage(fallback, key: "jira.apiToken") == "kunj could not save jira.apiToken.")
        let own = KunjCLIError(code: .commandFailed, message: "agent.tmux must be true or false.")
        #expect(settingWriteMessage(own, key: "agent.tmux") == "agent.tmux must be true or false.")
    }

    @Test func anOlderKunjIsRecognised() {
        #expect(isSchemaUnsupported(KunjCLIError(code: .commandFailed, message: "error: unknown option '--schema'")))
        #expect(!isSchemaUnsupported(KunjCLIError(code: .commandFailed, message: "timed out")))
    }
}
