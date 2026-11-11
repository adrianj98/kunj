import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct ConfigSchemaTests {
    private func fixture<T: Decodable>(_ name: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(contentsOf: responsesDir.appendingPathComponent("\(name).json")))
    }

    @Test func decodesTheSchemaFixture() throws {
        let schema: ConfigSchemaJson = try fixture("config_schema")
        #expect(schema.categories.first == ConfigCategoryJson(id: "general", title: "General"))
        let tmux = try #require(schema.settings.first { $0.key == "agent.tmux" })
        #expect(tmux.type == "boolean")
        #expect(tmux.default == .bool(true))
        #expect(tmux.category == "agent")
        #expect(schema.settings.first { $0.key == "jira.apiToken" }?.sensitive == true)
        #expect((schema.settings.first { $0.key == "preferences.branchSort" }?.options ?? []).count > 1)
        #expect(schema.settings.first { $0.key == "lsp.servers" }?.default == .object([:]))
        let ids = Set(schema.categories.map(\.id))
        #expect(schema.settings.allSatisfy { ids.contains($0.category) })
    }

    @Test func decodesTheListFixture() throws {
        let list: ConfigListJson = try fixture("config_list")
        #expect(list.global.at("agent.tmuxStatus") == .bool(false))
        #expect(list.local.at("preferences.pageSize") == .number(20))
        #expect(list.merged.at("no.such") == nil)
        #expect(list.global.at("agent.command.deeper") == nil)
    }

    @Test func anUnknownTypeAndExtraFieldsDecode() throws {
        let json = #"{"categories":[],"settings":[{"key":"a.b","category":"x","type":"duration","description":"d","default":null,"later":1}]}"#
        let schema = try JSONDecoder().decode(ConfigSchemaJson.self, from: Data(json.utf8))
        #expect(schema.settings[0].type == "duration")
        #expect(schema.settings[0].default == nil)  // a null default is no default
    }

    @Test func compactWritesWholeNumbersWithoutAFraction() {
        #expect(JSONValue.number(3).compact() == "3")
        #expect(JSONValue.number(-1).compact() == "-1")
        #expect(JSONValue.number(0.5).compact() == "0.5")
        #expect(JSONValue.bool(true).compact() == "true")
        #expect(JSONValue.object(["b": .number(1), "a": .array([.string("x")])]).compact() == #"{"a":["x"],"b":1}"#)
    }

    @Test func compactRoundTripsAwkwardStrings() {
        for s in ["true", "12", "", "a=b \"q\"\nline", "-x", "https://x/y", "日本 ✓"] {
            let v = JSONValue.string(s)
            #expect(JSONValue(json: v.compact()) == v)
        }
    }

    @Test func parsesFragmentsAndRefusesNonJSON() {
        #expect(JSONValue(json: "3") == .number(3))
        #expect(JSONValue(json: "true") == .bool(true))
        #expect(JSONValue(json: "1") == .number(1))
        #expect(JSONValue(json: "null") == .null)
        #expect(JSONValue(json: #"{"a":{"b":[1,"x",false]}}"#) == .object(["a": .object(["b": .array([.number(1), .string("x"), .bool(false)])])]))
        #expect(JSONValue(json: "{bad") == nil)
        #expect(JSONValue(json: "") == nil)
    }

    @Test func setJsonArgs() {
        #expect(configSetJsonArgs("agent.command", .string("true"), .global)
            == ["config", "--set-json", "agent.command=\"true\"", "--global"])
        #expect(configSetJsonArgs("preferences.pageSize", .number(-1), .repo(root: "/r", name: "r"))
            == ["config", "--set-json", "preferences.pageSize=-1"])
    }

    @Test func unsetArgsAndCwd() {
        #expect(configUnsetArgs("agent.tmux", .global) == ["config", "--unset", "agent.tmux", "--global"])
        #expect(configUnsetArgs("agent.tmux", .repo(root: "/r", name: "r")) == ["config", "--unset", "agent.tmux"])
        #expect(settingsCwd(.repo(root: "/r", name: "r"), home: "/h") == "/r")
        #expect(settingsCwd(.global, home: "/h") == "/h")
    }

    @Test func fakeKunjAnswersSchemaAndList() async throws {
        let cli = fakeKunjCLI()
        let schema: ConfigSchemaJson = try await cli.run(configSchemaArgs, cwd: NSTemporaryDirectory())
        let list: ConfigListJson = try await cli.run(configListArgs, cwd: NSTemporaryDirectory())
        #expect(schema.settings.count > 50)
        #expect(list.global.at("jira.apiToken") == .string("stored-token"))
    }
}
