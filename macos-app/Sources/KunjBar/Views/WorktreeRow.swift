// One worktree in the panel: icon, name, badges, inline actions and a
// context menu with everything the VS Code extension offers.

import AppKit
import SwiftUI

struct WorktreeRow: View {
    let worktree: Worktree
    let repo: KnownRepo
    @Environment(AppStore.self) private var store
    @AppStorage(Pref.showPath) private var showPath = false
    @State private var hovering = false

    private var busy: Bool { store.busyWorktrees.contains(worktree.path) }

    var body: some View {
        HStack(spacing: 8) {
            icon
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(worktree.name)
                        .fontWeight(worktree.isActive ? .semibold : .regular)
                        .foregroundStyle(worktree.isActive ? Palette.open : Color.primary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if worktree.isMain {
                        Text("main").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                if busy {
                    Text("Opening…")
                        .font(.caption)
                        .foregroundStyle(Palette.open)
                } else if worktree.isActive {
                    HStack(spacing: 4) {
                        Circle().fill(Palette.open).frame(width: 6, height: 6)
                        Text(openIn)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                if !details.isEmpty {
                    Text(details)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            Spacer(minLength: 4)
            if busy {
                ProgressView().controlSize(.small)
            }
            if let pr = worktree.pullRequest {
                PullRequestBadge(pr: pr)
            }
            if hovering {
                inlineActions
            }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 8)
        .background(background)
        .contentShape(Rectangle())
        .animation(.easeOut(duration: 0.12), value: busy)
        .onHover { hovering = $0 }
        .onTapGesture { store.open(worktree, in: repo) }
        .help(tooltip)
        .contextMenu { contextMenu }
        .opacity(worktree.exists ? 1 : 0.6)
    }

    // MARK: - Pieces

    // Every row shares the same hover highlight; worktrees open in an editor
    // add a bar in the "open" blue rather than a card of their own
    @ViewBuilder private var background: some View {
        RoundedRectangle(cornerRadius: 6)
            .fill(busy ? Palette.open.opacity(0.18) : hovering ? Color.primary.opacity(0.08) : .clear)
            .overlay(alignment: .leading) {
                if worktree.isActive {
                    Capsule().fill(Palette.open).frame(width: 3).padding(.vertical, 4)
                }
            }
    }

    private var openIn: String {
        let names = worktree.sessions.map(\.displayName)
        return names.count == 1 ? "Open in \(names[0])" : "Open in \(names.count) windows: \(names.joined(separator: ", "))"
    }

    @ViewBuilder private var icon: some View {
        if !worktree.exists || worktree.prunable {
            Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
        } else if worktree.isActive {
            Image(systemName: "macwindow").foregroundStyle(Palette.open).fontWeight(.semibold)
        } else if worktree.locked {
            Image(systemName: "lock")
        } else if worktree.detached {
            Image(systemName: "smallcircle.filled.circle")
        } else {
            Image(systemName: worktree.isMain ? "externaldrive" : "arrow.triangle.branch")
                .foregroundStyle(.secondary)
        }
    }

    private var details: String {
        var parts: [String] = []
        if let status = worktree.status {
            if status.dirty { parts.append("✎ \(status.changedFiles)") }
            var sync: [String] = []
            if let ahead = status.ahead, ahead > 0 { sync.append("↑\(ahead)") }
            if let behind = status.behind, behind > 0 { sync.append("↓\(behind)") }
            if !sync.isEmpty { parts.append(sync.joined(separator: " ")) }
        }
        if !worktree.exists { parts.append("missing") } else if worktree.prunable { parts.append("prunable") }
        if worktree.locked { parts.append("locked") }
        if worktree.detached, let head = worktree.head { parts.append("detached \(head.prefix(7))") }
        if showPath { parts.append(shortenHome(worktree.path)) }
        return parts.joined(separator: "  ·  ")
    }

    private var tooltip: String {
        var lines = [worktree.path]
        if let head = worktree.head { lines.append("HEAD \(head.prefix(10))\(worktree.detached ? " (detached)" : "")") }
        if let status = worktree.status {
            var text = status.dirty ? "\(status.changedFiles) uncommitted change(s)" : "clean"
            if let upstream = status.upstream { text += ", upstream \(upstream) (↑\(status.ahead ?? 0) ↓\(status.behind ?? 0))" }
            lines.append(text)
        }
        if let pr = worktree.pullRequest {
            var bits = [pr.displayState]
            if let checks = pr.checks { bits.append("checks \(checks)") }
            if let review = pr.reviewDecision { bits.append(review.lowercased().replacingOccurrences(of: "_", with: " ")) }
            lines.append("#\(pr.number) \(pr.title) — \(bits.joined(separator: ", "))")
        }
        for session in worktree.sessions {
            lines.append("Open in \(session.displayName) on \(session.host) (pid \(session.pid))")
        }
        if worktree.locked { lines.append("Locked\(worktree.lockedReason.map { ": \($0)" } ?? "")") }
        if worktree.prunable { lines.append("Prunable\(worktree.prunableReason.map { ": \($0)" } ?? "")") }
        return lines.joined(separator: "\n")
    }

    @ViewBuilder private var inlineActions: some View {
        HStack(spacing: 2) {
            if worktree.exists {
                IconButton(symbol: "macwindow.badge.plus", help: "Open in New Window") { store.open(worktree, in: repo, newWindow: true) }
                IconButton(symbol: "terminal", help: "Open Terminal") { Launcher.openTerminal(at: worktree.path) }
            }
            if !worktree.isMain {
                IconButton(symbol: "trash", help: "Remove Worktree…") { store.remove(worktree, in: repo) }
            }
        }
    }

    @ViewBuilder private var contextMenu: some View {
        if worktree.exists {
            Button("Open") { store.open(worktree, in: repo) }
            Button("Open in New Window") { store.open(worktree, in: repo, newWindow: true) }
            Divider()
        }
        if let pr = worktree.pullRequest {
            Button("Open Pull Request #\(pr.number)") { Launcher.openURL(pr.url) }
            Button("Copy Pull Request URL") { Launcher.copy(pr.url) }
            Divider()
        } else if worktree.branch != nil && worktree.exists {
            Button("Find Pull Request") { store.openPullRequest(worktree, in: repo) }
            Button("Create Pull Request…") { store.createPullRequest(worktree) }
            Divider()
        }
        if worktree.exists {
            Button("Open Terminal") { Launcher.openTerminal(at: worktree.path) }
            Button("Reveal in Finder") { Launcher.revealInFinder(worktree.path) }
        }
        Button("Copy Path") { Launcher.copy(worktree.path) }
        if let branch = worktree.branch {
            Button("Copy Branch Name") { Launcher.copy(branch) }
        }
        if !worktree.isMain {
            Divider()
            Button("Remove Worktree…", role: .destructive) { store.remove(worktree, in: repo) }
        }
    }
}

struct PullRequestBadge: View {
    let pr: PullRequest

    var body: some View {
        Button {
            Launcher.openURL(pr.url)
        } label: {
            Text(pr.badge)
                .font(.caption.weight(.semibold).monospacedDigit())
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background {
                    if let fill { Capsule().fill(fill) } else { Capsule().strokeBorder(Color.secondary) }
                }
                .foregroundStyle(fill == nil ? Color.primary : Color.white)
        }
        .buttonStyle(.plain)
        .help("#\(pr.number) \(pr.title)")
    }

    // Solid fills with white text; nil draws an outline instead
    private var fill: Color? {
        switch pr.state {
        case "merged": return Palette.merged
        case "closed": return nil
        default:
            if pr.draft { return nil }
            switch pr.checks {
            case "failure": return Palette.failure
            case "pending": return Palette.pending
            default: return Palette.success
            }
        }
    }
}

struct IconButton: View {
    let symbol: String
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .frame(width: 20, height: 18)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .help(help)
    }
}

func shortenHome(_ path: String) -> String {
    let home = NSHomeDirectory()
    if path == home || path.hasPrefix(home + "/") { return "~" + path.dropFirst(home.count) }
    return path
}

// The panel's few colours. Everything else is .primary/.secondary so it
// follows the system. Each colour keeps at least 4.5:1 contrast for its use:
// `open` as text on the window background (darker in light mode, lighter in
// dark mode), the badge fills under white text in both modes.
enum Palette {
    // Solid panel background: white in light mode, near-black in dark mode,
    // instead of the translucent menu material that lets the desktop through
    static let panel = Color(nsColor: .textBackgroundColor)
    static let open = adaptive(light: (0.00, 0.35, 0.80), dark: (0.40, 0.67, 1.00))
    static let success = Color(red: 0.10, green: 0.50, blue: 0.22)
    static let failure = Color(red: 0.78, green: 0.15, blue: 0.15)
    static let pending = Color(red: 0.62, green: 0.36, blue: 0.00)
    static let merged = Color(red: 0.47, green: 0.27, blue: 0.80)

    private static func adaptive(light: (CGFloat, CGFloat, CGFloat), dark: (CGFloat, CGFloat, CGFloat)) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            let c = isDark ? dark : light
            return NSColor(srgbRed: c.0, green: c.1, blue: c.2, alpha: 1)
        })
    }
}
