// Content of the open worktree switcher panel (see Support/Switcher.swift).

import SwiftUI

struct SwitcherView: View {
    let model: SwitcherModel
    let choose: (Int) -> Void
    // Snapshots: ImageRenderer draws nothing inside a ScrollView
    var scrolls = true
    @Environment(AppStore.self) private var store

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "macwindow").foregroundStyle(.secondary)
                Text("Open worktrees").font(.headline)
                Spacer()
                if store.isRefreshing { ProgressView().controlSize(.small) }
                Text("↑↓ to pick, ↩ to open, esc to close")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            Divider()
            if model.items.isEmpty {
                Text(store.lastRefresh == nil ? "Loading…" : "No worktree is open in an editor")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)
            } else if !scrolls {
                list
            } else {
                ScrollViewReader { proxy in
                    ScrollView { list }
                        .frame(maxHeight: 420)
                        .fixedSize(horizontal: false, vertical: true)
                        .onChange(of: model.selection) { _, index in proxy.scrollTo(index) }
                }
            }
        }
        .frame(width: 480)
        .background(Palette.panel)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.primary.opacity(0.12)))
    }

    private var list: some View {
        VStack(spacing: 2) {
            ForEach(Array(model.items.enumerated()), id: \.element.worktree.path) { index, item in
                row(item.repo, item.worktree, selected: index == model.selection)
                    .id(index)
                    .onHover { if $0 { model.selection = index } }
                    .onTapGesture { choose(index) }
            }
        }
        .padding(6)
    }

    private func row(_ repo: KnownRepo, _ worktree: Worktree, selected: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: worktree.isMain ? "house" : "arrow.triangle.branch")
                .frame(width: 16)
                .foregroundStyle(selected ? Color.white : Palette.open)
            VStack(alignment: .leading, spacing: 1) {
                Text(worktree.name)
                    .fontWeight(.semibold)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text([repo.name, worktree.branch == worktree.name ? nil : worktree.branch].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(selected ? Color.white.opacity(0.8) : .secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 4)
            if let pr = worktree.pullRequest {
                Text(pr.badge)
                    .font(.caption)
                    .foregroundStyle(selected ? Color.white.opacity(0.8) : .secondary)
            }
        }
        .foregroundStyle(selected ? Color.white : Color.primary)
        .padding(.vertical, 6)
        .padding(.horizontal, 10)
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Color.accentColor : Color.clear))
        .contentShape(Rectangle())
    }
}
