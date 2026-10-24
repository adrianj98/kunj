import Foundation
import KunjWorkspaceCore

/// Keeps `~/.kunj/<repo>/workspace.json` in step with the open tabs and the environments'
/// `lastActivity`: an environment's tabs are restored the first time it is selected in a session
/// (once it can run them), and saved on every change of its tabs after that, never before, so a
/// stopped container selected before it starts keeps its saved tabs. `lastActivity` is bumped when
/// a listing shows the environment changed and when one of its tabs gets input.
@MainActor
final class LayoutKeeper {
    let layouts: LayoutStore
    /// The environment of an id, from the store.
    var environment: (String) -> Environment? = { _ in nil }
    /// The tabs of an environment, in order, and the active one (the registry's).
    var tabs: (String) -> (tabs: [SavedTab], active: Int?) = { _ in ([], nil) }
    /// Opens a restored tab (a refused spec opens nothing); called in the saved order.
    var open: (Environment, SavedTab) -> Void = { _, _ in }
    /// Makes the environment's `index`th tab active once its tabs are restored.
    var activate: (String, Int) -> Void = { _, _ in }
    /// A `lastActivity` changed (the sidebar refreshes its times).
    var onActivity: () -> Void = {}

    /// Environments whose saved tabs were restored (or that had none) in this session.
    private var restored: Set<String> = []
    private var tracker = ActivityTracker()
    private var lastInputBump: [String: Date] = [:]
    /// Input bumps closer together than this are dropped: the sidebar shows `now` for 45 s anyway.
    private static let inputBumpInterval: TimeInterval = 5

    init(layouts: LayoutStore = LayoutStore()) {
        self.layouts = layouts
    }

    func lastActivity(_ envId: String) -> Date? {
        guard let env = environment(envId) else { return nil }
        return layouts.layout(repo: env.repo.dirName).branches[key(env)]?.lastActivity
    }

    /// The environment was selected (or the store changed while it is): restores its saved tabs
    /// the first time it can run them.
    func selected(_ env: Environment?) {
        guard let env, !restored.contains(env.id) else { return }
        guard let entry = layouts.layout(repo: env.repo.dirName).branches[key(env)] else {
            restored.insert(env.id)
            return
        }
        guard let plan = restorePlan(entry, env: env, kinds: [.shell, .agent, .editor]) else { return }
        restored.insert(env.id)
        let before = tabs(env.id).tabs.count
        for tab in plan.tabs { open(env, tab) }
        if let active = plan.active, before + active < tabs(env.id).tabs.count {
            activate(env.id, before + active)
        }
        log("restored \(plan.tabs.count) tab(s) in \(env.id)")
        tabsChanged(env.id)
    }

    /// The registry's tabs of `envId` changed: saved once the environment was restored.
    func tabsChanged(_ envId: String) {
        guard restored.contains(envId), let env = environment(envId) else { return }
        let open = tabs(envId)
        let saved = tabsToSave(open.tabs, active: open.active)
        let entry = layouts.layout(repo: env.repo.dirName).branches[key(env)]
        guard entry?.tabs != saved.tabs || entry?.active != saved.active else { return }
        layouts.update(repo: env.repo.dirName, key: key(env)) {
            $0.tabs = saved.tabs
            $0.active = saved.active
        }
    }

    /// A listing: environments whose state changed since the last one are active now.
    func listed(_ repos: [RepoEnvironments]) {
        let changed = tracker.changed(repos)
        guard !changed.isEmpty else { return }
        let now = Date()
        for id in changed { bump(id, now: now) }
        onActivity()
    }

    /// A tab of `envId` got input (a key press, a paste).
    func input(_ envId: String) {
        let now = Date()
        if let last = lastInputBump[envId], now.timeIntervalSince(last) < Self.inputBumpInterval { return }
        lastInputBump[envId] = now
        bump(envId, now: now)
        onActivity()
    }

    /// Writes pending changes now (the app is quitting).
    func flush() {
        layouts.flush()
    }

    private func bump(_ envId: String, now: Date) {
        guard let env = environment(envId) else { return }
        layouts.update(repo: env.repo.dirName, key: key(env)) { $0.lastActivity = now }
    }

    private func key(_ env: Environment) -> String {
        layoutKey(kind: env.kind, branch: env.branch)
    }
}
