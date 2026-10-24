import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct ActionSpecTests {
    @Test func containerActionPlans() {
        let box = testContainer()
        let stopped = testContainer(running: false)
        #expect(actionPlan(.ctStart, env: stopped, worktreeOfSameBranch: nil)
            == .terminal(args: ["ct", "start", "feature/x"], title: "ct start", cwd: nil))
        #expect(actionPlan(.ctStop, env: box, worktreeOfSameBranch: nil) == .run(args: ["ct", "stop", "feature/x"]))
        #expect(actionPlan(.ctRemove(force: false), env: box, worktreeOfSameBranch: nil)
            == .terminal(args: ["ct", "remove", "feature/x"], title: "ct remove", cwd: nil))
        #expect(actionPlan(.ctRemove(force: true), env: box, worktreeOfSameBranch: nil)
            == .terminal(args: ["ct", "remove", "feature/x", "--force"], title: "ct remove", cwd: nil))
        #expect(actionPlan(.ctRebuild, env: box, worktreeOfSameBranch: nil)
            == .terminal(args: ["ct", "start", "feature/x", "--rebuild"], title: "ct start", cwd: nil))
        #expect(actionPlan(.ctOpen, env: stopped, worktreeOfSameBranch: nil) == .run(args: ["ct", "open", "feature/x"]))
        #expect(actionPlan(.prune, env: box, worktreeOfSameBranch: nil)
            == .terminal(args: ["ct", "prune"], title: "ct prune", cwd: nil))
        #expect(actionPlan(.openPort(3000), env: box, worktreeOfSameBranch: nil) == .external(url: "http://localhost:3000"))
        #expect(actionPlan(.copyPath, env: box, worktreeOfSameBranch: nil) == .local("kunj-app-feature-x-1a2b"))
    }

    @Test func containerStateGatesStartAndStop() {
        #expect(actionPlan(.ctStart, env: testContainer(), worktreeOfSameBranch: nil)
            == .disabled(reason: "The container is running"))
        #expect(actionPlan(.ctStop, env: testContainer(running: false), worktreeOfSameBranch: nil)
            == .disabled(reason: "The container is stopped"))
    }

    @Test func worktreeActionPlans() {
        let tree = testWorktree()
        #expect(actionPlan(.worktreeOpen, env: tree, worktreeOfSameBranch: nil) == .run(args: ["worktree", "open", "/w/feat"]))
        #expect(actionPlan(.worktreeRemove(force: false), env: tree, worktreeOfSameBranch: nil)
            == .terminal(args: ["worktree", "remove", "/w/feat"], title: "worktree remove", cwd: nil))
        #expect(actionPlan(.worktreeRemove(force: true), env: tree, worktreeOfSameBranch: nil)
            == .terminal(args: ["worktree", "remove", "/w/feat", "--force"], title: "worktree remove", cwd: nil))
        #expect(actionPlan(.copyPath, env: tree, worktreeOfSameBranch: nil) == .local("/w/feat"))
        #expect(actionPlan(.revealInFinder, env: tree, worktreeOfSameBranch: nil) == .local("/w/feat"))
        #expect(actionPlan(.prune, env: tree, worktreeOfSameBranch: nil)
            == .terminal(args: ["ct", "prune"], title: "ct prune", cwd: nil))
    }

    @Test func kindMismatchesAreDisabled() {
        if case .disabled = actionPlan(.ctStop, env: testWorktree(), worktreeOfSameBranch: nil) {} else { Issue.record("ctStop on a worktree") }
        if case .disabled = actionPlan(.worktreeRemove(force: false), env: testContainer(), worktreeOfSameBranch: nil) {} else { Issue.record("worktreeRemove on a container") }
        if case .disabled = actionPlan(.revealInFinder, env: testContainer(), worktreeOfSameBranch: nil) {} else { Issue.record("reveal on a container") }
    }

    @Test func mainAndMissingWorktrees() {
        if case .disabled = actionPlan(.worktreeRemove(force: false), env: testWorktree(isMain: true), worktreeOfSameBranch: nil) {} else { Issue.record("removing the main worktree") }
        if case .disabled = actionPlan(.worktreeOpen, env: testWorktree(exists: false), worktreeOfSameBranch: nil) {} else { Issue.record("opening a missing worktree") }
        #expect(actionPlan(.worktreeRemove(force: false), env: testWorktree(exists: false), worktreeOfSameBranch: nil)
            == .terminal(args: ["worktree", "remove", "/w/feat"], title: "worktree remove", cwd: nil))
    }

    @Test func createPR() {
        #expect(actionPlan(.createPR, env: testWorktree(), worktreeOfSameBranch: nil)
            == .terminal(args: ["pr"], title: "pr", cwd: "/w/feat"))
        #expect(actionPlan(.createPR, env: testContainer(), worktreeOfSameBranch: nil)
            == .disabled(reason: "Create PRs from a worktree of this branch"))
        #expect(actionPlan(.createPR, env: testContainer(), worktreeOfSameBranch: testWorktree(path: "/w/other"))
            == .terminal(args: ["pr"], title: "pr", cwd: "/w/other"))
        if case .disabled = actionPlan(.createPR, env: testContainer(), worktreeOfSameBranch: testWorktree(exists: false)) {} else { Issue.record("PR from a missing worktree") }
        if case .disabled = actionPlan(.createPR, env: testWorktree(exists: false), worktreeOfSameBranch: nil) {} else { Issue.record("PR in a missing worktree") }
    }

    @Test func newSessionPlans() {
        #expect(newSessionPlan(NewSessionRequest(repo: testRepo, branch: "feature/y", base: "develop", kind: .worktree, startAgent: false))
            == .terminal(args: ["worktree", "add", "feature/y", "-c", "--base", "develop"], title: "worktree add", cwd: nil))
        #expect(newSessionPlan(NewSessionRequest(repo: testRepo, branch: "feature/y", base: nil, kind: .worktree, startAgent: true))
            == .terminal(args: ["worktree", "add", "feature/y", "-c"], title: "worktree add", cwd: nil))
        #expect(newSessionPlan(NewSessionRequest(repo: testRepo, branch: "feature/y", base: nil, kind: .container, startAgent: false))
            == .terminal(args: ["ct", "start", "feature/y", "-c"], title: "ct start", cwd: nil))
        #expect(newSessionPlan(NewSessionRequest(repo: testRepo, branch: "feature/y", base: "main", kind: .container, startAgent: false))
            == .terminal(args: ["ct", "start", "feature/y", "-c", "--base", "main"], title: "ct start", cwd: nil))
        #expect(newSessionPlan(NewSessionRequest(repo: testRepo, branch: "feature/y", base: "  ", kind: .container, startAgent: false))
            == .terminal(args: ["ct", "start", "feature/y", "-c"], title: "ct start", cwd: nil))
    }

    @Test func branchNameValidation() {
        for good in ["feature/x", "fix-1", "a.b", "chore/bun_upgrade"] { #expect(isValidBranchName(good), "\(good)") }
        for bad in ["", "a b", "a..b", "a~1", "a^", "a:b", "a?", "a*", "a[", "-x", "a/", "/a", "a.lock", "a//b", "a\\b", "@", "a@{b", ".a", "a/.b", "a."] {
            #expect(!isValidBranchName(bad), "\(bad)")
        }
    }
}
