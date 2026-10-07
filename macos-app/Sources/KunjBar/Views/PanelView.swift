// The menu bar panel: search, one collapsible section per repository, and a
// footer with add/refresh/settings.

import AppKit
import SwiftUI

struct PanelView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openWindow) private var openWindow
    @State private var query = ""
    @AppStorage(Pref.collapsedRepos) private var collapsedRaw = ""
    @AppStorage(Pref.onlyOpenWorktrees) private var onlyOpen = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
            Divider()
            footer
        }
        .frame(width: 420)
        .onAppear { store.refresh() }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Filter worktrees", text: $query)
                .textFieldStyle(.plain)
            if store.isRefreshing {
                ProgressView().controlSize(.small)
            }
            Toggle(isOn: $onlyOpen) {
                Label("Open only", systemImage: "macwindow")
            }
            .toggleStyle(.button)
            .controlSize(.small)
            .help("Only show worktrees that are open in an editor")
            IconButton(symbol: "arrow.clockwise", help: "Refresh (re-fetches pull requests)") { store.refresh(fresh: true) }
        }
        .padding(10)
    }

    // MARK: - Content

    @ViewBuilder private var content: some View {
        switch store.cliState {
        case .missing(let message):
            EmptyStateView(symbol: "terminal", title: "kunj CLI not found", message: message) {
                Button("Settings…") { show("settings") }
                Button("Retry") { store.refresh() }
            }
        case .unknown where store.repos.isEmpty:
            EmptyStateView(symbol: "hourglass", title: "Loading…", message: nil) { EmptyView() }
        default:
            if store.repos.isEmpty {
                EmptyStateView(
                    symbol: "folder.badge.plus",
                    title: "No repositories yet",
                    message: "Repositories appear here once kunj has run in them, or add one by hand."
                ) {
                    Button("Add Repository…") { addRepository() }
                }
            } else if onlyOpen && query.isEmpty && !store.repos.contains(where: { $0.worktrees.contains(where: \.isActive) }) {
                EmptyStateView(
                    symbol: "macwindow",
                    title: "No open worktrees",
                    message: "None of your worktrees is open in an editor right now."
                ) {
                    Button("Show All") { onlyOpen = false }
                }
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(sortedRepos) { state in
                            repoSection(state)
                        }
                    }
                    .padding(6)
                }
                .frame(maxHeight: 520)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder private func repoSection(_ state: RepoState) -> some View {
        let worktrees = filtered(state.worktrees)
        if !isFiltering || !worktrees.isEmpty {
            let collapsed = isCollapsed(state.repo) && !isFiltering
            HStack(spacing: 6) {
                Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 10)
                Text(state.repo.name).font(.headline)
                Text("\(state.worktrees.count)").font(.caption).foregroundStyle(.secondary)
                if state.error != nil {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .help(state.error ?? "")
                }
                Spacer()
                Menu {
                    repoMenu(state.repo)
                } label: {
                    Image(systemName: "ellipsis")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
            }
            .padding(.horizontal, 8)
            .padding(.top, 8)
            .padding(.bottom, 2)
            .contentShape(Rectangle())
            .onTapGesture { toggleCollapsed(state.repo) }
            .help(state.repo.root)

            if !collapsed {
                if let error = state.error, state.listing == nil {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 26)
                        .padding(.bottom, 4)
                }
                ForEach(worktrees) { worktree in
                    WorktreeRow(worktree: worktree, repo: state.repo)
                }
            }
        }
    }

    @ViewBuilder private func repoMenu(_ repo: KnownRepo) -> some View {
        Button("New Worktree…") { show("new-worktree", value: repo.root) }
        Button("Open Terminal") { Launcher.openTerminal(at: repo.root) }
        Button("Reveal in Finder") { Launcher.revealInFinder(repo.root) }
        Button("Copy Path") { Launcher.copy(repo.root) }
        Divider()
        Button("Prune Stale Worktrees") { store.prune(repo) }
        Divider()
        Button("Remove from List") { store.hideRepository(repo) }
    }

    // MARK: - Footer

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let flash = store.flash {
                HStack(alignment: .top) {
                    Text(flash)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .lineLimit(4)
                    Spacer()
                    Button {
                        store.flash = nil
                    } label: {
                        Image(systemName: "xmark").font(.caption2)
                    }
                    .buttonStyle(.borderless)
                }
            }
            HStack(spacing: 4) {
                Menu {
                    ForEach(store.repos) { state in
                        Button(state.repo.name) { show("new-worktree", value: state.repo.root) }
                    }
                } label: {
                    Label("New Worktree", systemImage: "plus")
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .disabled(store.repos.isEmpty)

                Spacer()
                if let last = store.lastRefresh {
                    Text(last, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .monospacedDigit()
                }
                Menu {
                    Button("Add Repository…") { addRepository() }
                    Button("Settings…") { show("settings") }
                    Button("Show Log") { show("log") }
                    Divider()
                    Button("Quit Kunj") { NSApp.terminate(nil) }
                } label: {
                    Image(systemName: "gearshape")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
            }
        }
        .padding(10)
    }

    // MARK: - Helpers

    // Filtering hides repositories with no match and expands collapsed ones
    private var isFiltering: Bool { onlyOpen || !query.trimmingCharacters(in: .whitespaces).isEmpty }

    // Repositories with a worktree open in an editor first, otherwise most recently used
    private var sortedRepos: [RepoState] {
        stableSorted(store.repos) { $0.worktrees.contains(where: \.isActive) && !$1.worktrees.contains(where: \.isActive) }
    }

    // Worktrees open in an editor first, in the CLI's order otherwise
    private func filtered(_ worktrees: [Worktree]) -> [Worktree] {
        var sorted = stableSorted(worktrees) { $0.isActive && !$1.isActive }
        if onlyOpen { sorted = sorted.filter(\.isActive) }
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return sorted }
        return sorted.filter { wt in
            [wt.name, wt.branch ?? "", wt.path, wt.pullRequest?.title ?? "", wt.pullRequest.map { "#\($0.number)" } ?? ""]
                .contains { $0.lowercased().contains(needle) }
        }
    }

    private var collapsed: Set<String> {
        Set(collapsedRaw.split(separator: "\n").map(String.init))
    }

    private func isCollapsed(_ repo: KnownRepo) -> Bool { collapsed.contains(repo.root) }

    private func toggleCollapsed(_ repo: KnownRepo) {
        var set = collapsed
        if set.contains(repo.root) { set.remove(repo.root) } else { set.insert(repo.root) }
        collapsedRaw = set.sorted().joined(separator: "\n")
    }

    private func show(_ id: String) {
        NSApp.activate(ignoringOtherApps: true)
        openWindow(id: id)
    }

    private func show(_ id: String, value: String) {
        NSApp.activate(ignoringOtherApps: true)
        openWindow(id: id, value: value)
    }

    private func addRepository() {
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Add"
        panel.message = "Choose git repositories (or any folder inside one)"
        if panel.runModal() == .OK {
            for url in panel.urls { store.addRepository(path: url.path) }
        }
    }
}

private func stableSorted<T>(_ items: [T], by areInIncreasingOrder: (T, T) -> Bool) -> [T] {
    items.enumerated()
        .sorted { a, b in
            if areInIncreasingOrder(a.element, b.element) { return true }
            if areInIncreasingOrder(b.element, a.element) { return false }
            return a.offset < b.offset
        }
        .map(\.element)
}

struct EmptyStateView<Actions: View>: View {
    let symbol: String
    let title: String
    let message: String?
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).font(.largeTitle).foregroundStyle(.secondary)
            Text(title).font(.headline)
            if let message {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            HStack { actions() }
        }
        .padding(24)
        .frame(maxWidth: .infinity)
    }
}
