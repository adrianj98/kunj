import Foundation

/// `kunj secret list --json`: names, scope, targets and delivery of the stored secrets, never values.
public struct SecretListJson: Decodable, Equatable, Sendable {
    public struct Entry: Decodable, Equatable, Sendable {
        public struct Delivery: Decodable, Equatable, Sendable {
            public var env: Bool
            public var file: String?
        }
        public var name: String
        public var scope: String
        public var branch: String?
        public var targets: [String]
        public var delivery: Delivery
        public var updatedAt: String
    }
    public var secrets: [Entry]
}

/// `kunj ct token status --json`: where a new container's GitHub token comes from (`env`, `gh` or
/// null) and whether `container.useGhToken` lets kunj ask gh.
public struct TokenStatusJson: Decodable, Equatable, Sendable {
    public struct GitHub: Decodable, Equatable, Sendable {
        public var source: String?
        public var enabled: Bool
    }
    public var github: GitHub
}

public let tokenStatusArgs = ["ct", "token", "status"]
public let globalSecretListArgs = ["secret", "list", "--global"]
public let claudeTokenName = "CLAUDE_CODE_OAUTH_TOKEN"
public let claudeTokenRemoveArgs = ["secret", "rm", claudeTokenName, "--global"]

/// A global secret named `name` that reaches containers as an environment variable.
public func hasContainerSecret(_ name: String, in list: SecretListJson) -> Bool {
    list.secrets.contains { $0.name == name && $0.scope == "global" && $0.targets.contains("container") && $0.delivery.env }
}

/// Settings' GitHub token line. A stored global container `GH_TOKEN` wins (kunj then does not ask
/// gh); nil when neither answer is known.
public func githubTokenSummary(status: TokenStatusJson?, secrets: SecretListJson?) -> String? {
    if let secrets, hasContainerSecret("GH_TOKEN", in: secrets) { return "Stored secret" }
    guard let github = status?.github else { return nil }
    switch github.source {
    case "gh": return "From gh (your gh login)"
    case "env": return "From GH_TOKEN in your environment"
    default: return github.enabled ? "None: run gh auth login, or set GH_TOKEN" : "None: set GH_TOKEN, or use gh's token"
    }
}

/// Settings' Claude Code token line; nil when the global secrets could not be read.
public func claudeTokenSummary(secrets: SecretListJson?) -> String? {
    guard let secrets else { return nil }
    return hasContainerSecret(claudeTokenName, in: secrets) ? "Stored secret" : "Not set"
}

/// `kunj ct token check --json`: one `claude -p` with the Claude Code token new containers get
/// (`source`: `secret`, `env` or null; `valid` null when there is none or it could not be checked).
public struct TokenCheckJson: Decodable, Equatable, Sendable {
    public struct Claude: Decodable, Equatable, Sendable {
        public var source: String?
        public var valid: Bool?
        public var message: String
    }
    public var claude: Claude
}

public let claudeTokenCheckArgs = ["ct", "token", "check"]

/// Settings' line under the Claude Code token after Test.
public func claudeTokenCheckText(_ check: TokenCheckJson) -> String {
    switch check.claude.valid {
    case true?: return "✓ " + check.claude.message
    case false?: return "✗ " + check.claude.message
    case nil: return check.claude.message
    }
}

/// The Set Up… action tab: `kunj ct token setup`, which runs `claude setup-token`, takes the token
/// from its output, checks it and stores it as the global container secret (it needs a terminal).
public func claudeTokenSetupSpec(cli: KunjCLI, env: Environment, terminalEnv: [String: String]) -> TerminalSpec {
    TerminalSpec(executable: "/usr/bin/env", arguments: cli.commandParts + ["ct", "token", "setup"],
                 cwd: env.repo.root,
                 environment: ShellEnvironment.terminalEnvironment(path: cli.path, base: terminalEnv),
                 title: "claude token", closeOnExitZero: true)
}
