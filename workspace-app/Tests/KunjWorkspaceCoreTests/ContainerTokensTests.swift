import Foundation
import Testing
@testable import KunjWorkspaceCore

private func secrets(_ json: String) throws -> SecretListJson {
    try JSONDecoder().decode(SecretListJson.self, from: Data(json.utf8))
}

private func status(_ json: String) throws -> TokenStatusJson {
    try JSONDecoder().decode(TokenStatusJson.self, from: Data(json.utf8))
}

private let ghToken = #"{"secrets":[{"name":"GH_TOKEN","scope":"global","targets":["container"],"delivery":{"env":true},"updatedAt":"2026-10-24T00:00:00Z"}]}"#
private let claudeBoth = #"{"secrets":[{"name":"CLAUDE_CODE_OAUTH_TOKEN","scope":"global","targets":["host","container"],"delivery":{"env":true},"updatedAt":"2026-10-24T00:00:00Z"}]}"#
private let claudeHostOnly = #"{"secrets":[{"name":"CLAUDE_CODE_OAUTH_TOKEN","scope":"global","targets":["host"],"delivery":{"env":true},"updatedAt":"x"}]}"#

@Suite struct ContainerTokensTests {
    @Test func decodesTheCLIShapes() throws {
        let list = try secrets(#"{"secrets":[{"name":"A","scope":"branch","branch":"b","targets":["host"],"delivery":{"env":false,"file":".env"},"updatedAt":"x"}]}"#)
        #expect(list.secrets.count == 1)
        #expect(list.secrets[0].branch == "b")
        #expect(list.secrets[0].delivery.file == ".env")
        #expect(try status(#"{"github":{"source":"gh","enabled":true}}"#).github.source == "gh")
        #expect(try status(#"{"github":{"source":null,"enabled":false}}"#).github.source == nil)
    }

    @Test func githubTokenText() throws {
        let gh = try status(#"{"github":{"source":"gh","enabled":true}}"#)
        let env = try status(#"{"github":{"source":"env","enabled":true}}"#)
        let none = try status(#"{"github":{"source":null,"enabled":true}}"#)
        let off = try status(#"{"github":{"source":null,"enabled":false}}"#)
        let empty = try secrets(#"{"secrets":[]}"#)
        #expect(githubTokenSummary(status: gh, secrets: empty) == "From gh (your gh login)")
        #expect(githubTokenSummary(status: env, secrets: empty) == "From GH_TOKEN in your environment")
        #expect(githubTokenSummary(status: none, secrets: empty) == "None: run gh auth login, or set GH_TOKEN")
        #expect(githubTokenSummary(status: off, secrets: empty) == "None: set GH_TOKEN, or use gh's token")
        // a stored global container secret wins over everything
        #expect(githubTokenSummary(status: gh, secrets: try secrets(ghToken)) == "Stored secret")
        #expect(githubTokenSummary(status: nil, secrets: try secrets(ghToken)) == "Stored secret")
        // unknown status, nothing stored
        #expect(githubTokenSummary(status: nil, secrets: empty) == nil)
        #expect(githubTokenSummary(status: nil, secrets: nil) == nil)
    }

    @Test func storedSecretMustReachContainersAsEnv() throws {
        #expect(hasContainerSecret("CLAUDE_CODE_OAUTH_TOKEN", in: try secrets(claudeBoth)))
        #expect(!hasContainerSecret("CLAUDE_CODE_OAUTH_TOKEN", in: try secrets(claudeHostOnly)))
        #expect(!hasContainerSecret("GH_TOKEN", in: try secrets(claudeBoth)))
        let noEnv = #"{"secrets":[{"name":"GH_TOKEN","scope":"global","targets":["container"],"delivery":{"env":false},"updatedAt":"x"}]}"#
        #expect(!hasContainerSecret("GH_TOKEN", in: try secrets(noEnv)))
        let repo = #"{"secrets":[{"name":"GH_TOKEN","scope":"repo","targets":["container"],"delivery":{"env":true},"updatedAt":"x"}]}"#
        #expect(!hasContainerSecret("GH_TOKEN", in: try secrets(repo)))
    }

    @Test func claudeTokenText() throws {
        #expect(claudeTokenSummary(secrets: try secrets(claudeBoth)) == "Stored secret")
        #expect(claudeTokenSummary(secrets: try secrets(claudeHostOnly)) == "Not set")
        #expect(claudeTokenSummary(secrets: try secrets(#"{"secrets":[]}"#)) == "Not set")
        #expect(claudeTokenSummary(secrets: nil) == nil)
    }

    @Test func useGhTokenSetting() {
        #expect(KunjSetting.containerUseGhToken.rawValue == "container.useGhToken")
        #expect(KunjSetting.containerUseGhToken.defaultValue == true)
        #expect(configSetArgs(.containerUseGhToken, false) == ["config", "--set", "container.useGhToken=false", "--global"])
    }

    @Test func readAndRemoveArguments() {
        #expect(tokenStatusArgs == ["ct", "token", "status"])
        #expect(globalSecretListArgs == ["secret", "list", "--global"])
        #expect(claudeTokenRemoveArgs == ["secret", "rm", "CLAUDE_CODE_OAUTH_TOKEN", "--global"])
    }

    @Test func setupRunsKunjCtTokenSetup() {
        let cli = KunjCLI(command: "node /src/kunj/dist/index.js", path: "/login/bin:/usr/bin")
        let s = claudeTokenSetupSpec(cli: cli, env: testWorktree(), terminalEnv: ["HOME": "/Users/demo"])
        #expect(s.executable == "/usr/bin/env")
        #expect(s.arguments == ["node", "/src/kunj/dist/index.js", "ct", "token", "setup"])
        #expect(s.cwd == "/r/app")
        #expect(s.environment["PATH"] == "/login/bin:/usr/bin")
        #expect(s.title == "claude token")
        #expect(s.closeOnExitZero)
    }

    @Test func checkResultText() throws {
        func check(_ json: String) throws -> TokenCheckJson {
            try JSONDecoder().decode(TokenCheckJson.self, from: Data(json.utf8))
        }
        #expect(claudeTokenCheckText(try check(#"{"claude":{"source":"secret","valid":true,"message":"The token works"}}"#))
                == "✓ The token works")
        #expect(claudeTokenCheckText(try check(#"{"claude":{"source":"secret","valid":false,"message":"401 OAuth access token is invalid"}}"#))
                == "✗ 401 OAuth access token is invalid")
        #expect(claudeTokenCheckText(try check(#"{"claude":{"source":null,"valid":null,"message":"No Claude Code token for containers: run kunj ct token setup"}}"#))
                == "No Claude Code token for containers: run kunj ct token setup")
    }
}
