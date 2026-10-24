// One branch container in the panel. It looks and acts like a worktree row (it is another
// place the branch lives): click opens it in the editor (attached), with a terminal, the
// agent, its pull request and its ports a click away.

import AppKit
import SwiftUI

struct ContainerRow: View {
    let container: BranchContainer
    let repo: KnownRepo
    @Environment(AppStore.self) private var store
    @State private var hovering = false

    private var busy: Bool { store.busyContainers.contains(container.name) }
    private var branch: String { container.branch }

    var body: some View {
        HStack(spacing: 8) {
            if store.isSelecting {
                // Containers are removed one at a time, through kunj ct remove's own guard
                Image(systemName: "circle").foregroundStyle(.secondary).opacity(0.3).frame(width: 16)
            }
            icon
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(branch)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text("container").font(.caption2).foregroundStyle(.secondary)
                }
                if busy {
                    Text(container.isRunning ? "Working…" : "Starting…")
                        .font(.caption)
                        .foregroundStyle(Palette.open)
                } else if !details.isEmpty {
                    Text(details)
                        .font(.caption)
                        .foregroundStyle(container.agentWaiting ? Palette.pending : .secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            Spacer(minLength: 4)
            if let pr = container.pullRequest {
                PullRequestBadge(pr: pr)
            }
            if hovering && !store.isSelecting {
                inlineActions
            }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 8)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(busy ? Palette.open.opacity(0.18) : hovering ? Color.primary.opacity(0.08) : .clear)
        )
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture {
            guard !store.isSelecting else { return }
            store.openContainer(container, in: repo)
            MenuBarAnchor.closePanel()
        }
        .help(tooltip)
        .contextMenu { contextMenu }
        .opacity(container.isRunning ? 1 : 0.75)
    }

    // MARK: - Pieces

    @ViewBuilder private var icon: some View {
        if busy {
            ProgressView().controlSize(.mini)
        } else if container.agentWaiting {
            Image(systemName: "bell.badge").foregroundStyle(Palette.pending)
        } else if container.isRunning {
            Image(systemName: "shippingbox.fill").foregroundStyle(Palette.success)
        } else {
            Image(systemName: "shippingbox").foregroundStyle(.secondary)
        }
    }

    private var details: String {
        var parts: [String] = []
        if !container.isRunning { parts.append("stopped") }
        if container.agent.running == true { parts.append(container.agentWaiting ? "agent waiting" : "agent") }
        if container.workspace.dirty == true { parts.append("✎") }
        if let ahead = container.workspace.ahead, ahead > 0 { parts.append("↑\(ahead)") }
        if container.isRunning, !container.ports.isEmpty {
            parts.append(container.ports.map { ":\($0.host)" }.joined(separator: " "))
        }
        if container.blueprint?.stale == true { parts.append("blueprint stale") }
        return parts.joined(separator: "  ·  ")
    }

    private var tooltip: String {
        var lines = ["\(container.name) — \(container.state)", container.image]
        if let head = container.workspace.head {
            var text = "HEAD \(head)"
            if container.workspace.dirty == true { text += ", uncommitted changes" }
            if let ahead = container.workspace.ahead, ahead > 0 { text += ", \(ahead) commit(s) not on origin" }
            lines.append(text)
        }
        if let pr = container.pullRequest { lines.append("#\(pr.number) \(pr.title) — \(pr.displayState)") }
        lines += container.ports.map(\.label)
        if !container.services.isEmpty {
            lines.append("Services: " + container.services.map { "\($0.name) (\($0.state))" }.joined(separator: ", "))
        }
        return lines.joined(separator: "\n")
    }

    @ViewBuilder private var inlineActions: some View {
        HStack(spacing: 2) {
            IconButton(symbol: "macwindow.badge.plus", help: "Open in New Window") {
                store.openContainer(container, in: repo, newWindow: true)
                MenuBarAnchor.closePanel()
            }
            if container.isRunning {
                IconButton(symbol: "terminal", help: "Open Terminal in Container") {
                    store.runContainerCommand(["ct", "shell", branch], in: repo, title: "kunj-ct-\(branch)")
                    MenuBarAnchor.closePanel()
                }
            } else {
                IconButton(symbol: "play", help: "Start Container") {
                    store.runContainerCommand(["ct", "start", branch], in: repo, title: "kunj-ct-start-\(branch)")
                    MenuBarAnchor.closePanel()
                }
            }
            IconButton(symbol: "trash", help: "Remove Container…") {
                store.runContainerCommand(["ct", "remove", branch], in: repo, title: "kunj-ct-remove-\(branch)")
                MenuBarAnchor.closePanel()
            }
        }
    }

    @ViewBuilder private var contextMenu: some View {
        Button("Open") { store.openContainer(container, in: repo) }
        Button("Open in New Window") { store.openContainer(container, in: repo, newWindow: true) }
        Divider()
        if let pr = container.pullRequest {
            Button("Open Pull Request #\(pr.number)") { Launcher.openURL(pr.url) }
            Button("Copy Pull Request URL") { Launcher.copy(pr.url) }
            Divider()
        }
        Button("Start Agent") { store.runContainerCommand(["ct", "agent", branch], in: repo, title: "kunj-agent-\(branch)") }
        if container.isRunning {
            Button("Open Terminal") { store.runContainerCommand(["ct", "shell", branch], in: repo, title: "kunj-ct-\(branch)") }
            Button("Forward Ports Automatically") { store.autoForward(container, in: repo) }
            if !container.ports.isEmpty {
                Menu("Ports") {
                    ForEach(container.ports, id: \.self) { port in
                        Button(port.label) { Launcher.openURL("http://localhost:\(port.host)") }
                    }
                }
            }
        }
        Button("Copy Branch Name") { Launcher.copy(branch) }
        Button("Copy Container Name") { Launcher.copy(container.name) }
        Divider()
        if container.isRunning {
            Button("Stop") { store.stopContainer(container, in: repo) }
        } else {
            Button("Start") { store.runContainerCommand(["ct", "start", branch], in: repo, title: "kunj-ct-start-\(branch)") }
        }
        Button("Rebuild…") { store.runContainerCommand(["ct", "start", branch, "--rebuild"], in: repo, title: "kunj-ct-rebuild-\(branch)") }
        Divider()
        Button("Remove Container…", role: .destructive) {
            store.runContainerCommand(["ct", "remove", branch], in: repo, title: "kunj-ct-remove-\(branch)")
        }
    }
}
