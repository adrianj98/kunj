// Renders sample worktree rows to PNG files, in light and dark mode, so the
// palette can be reviewed without screen access:
//
//   KUNJBAR_SNAPSHOT=/tmp/out .build/debug/KunjBar
//
// writes /tmp/out/rows-light.png and rows-dark.png and exits.

import AppKit
import SwiftUI

enum Snapshot {
    @MainActor
    static func runIfRequested() {
        guard let dir = ProcessInfo.processInfo.environment["KUNJBAR_SNAPSHOT"] else { return }
        let store = AppStore()
        let repo = KnownRepo(root: "/Users/me/src/app", gitCommonDir: "/Users/me/src/app/.git", name: "app", bare: false, hidden: nil, lastSeen: "", exists: true)
        let rows = sampleWorktrees()
        for scheme in [ColorScheme.light, .dark] {
            let view = VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(.secondary).frame(width: 10)
                    Text("app").font(.headline)
                    Text("\(rows.count)").font(.caption).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 8)
                .padding(.top, 8)
                ForEach(rows) { WorktreeRow(worktree: $0, repo: repo) }
            }
            .padding(6)
            .frame(width: 420)
            .background(Palette.panel)
            .environment(store)
            .environment(\.colorScheme, scheme)

            // NSColor-backed colours resolve against the current drawing appearance
            let appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)!
            appearance.performAsCurrentDrawingAppearance {
                let renderer = ImageRenderer(content: view)
                renderer.scale = 2
                if let image = renderer.nsImage, let tiff = image.tiffRepresentation,
                   let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                    let file = URL(fileURLWithPath: dir).appendingPathComponent("rows-\(scheme == .dark ? "dark" : "light").png")
                    try? png.write(to: file)
                }
            }
        }
        exit(0)
    }

    private static func sampleWorktrees() -> [Worktree] {
        func pr(_ n: Int, _ state: String, checks: String?, draft: Bool = false) -> String {
            """
            {"provider":"github","number":\(n),"title":"Sample PR","state":"\(state)","url":"https://example.test","draft":\(draft),
             "baseBranch":"main","headBranch":"x","reviewDecision":null,"checks":\(checks.map { "\"\($0)\"" } ?? "null"),"updatedAt":null}
            """
        }
        func wt(_ name: String, main: Bool = false, open: Bool = false, dirty: Int = 0, ahead: Int = 0, exists: Bool = true, pr: String? = nil) -> String {
            let session = open ? #"[{"id":"1","path":"/p","pid":1,"host":"h","editor":"vscode","label":"app"}]"# : "[]"
            return """
            {"path":"/Users/me/src/app/\(name)","name":"\(name)","head":"abc1234def","branch":"\(name)","detached":false,"bare":false,
             "locked":false,"lockedReason":null,"prunable":false,"prunableReason":null,"isMain":\(main),"exists":\(exists),
             "sessions":\(session),"status":{"dirty":\(dirty > 0),"changedFiles":\(dirty),"ahead":\(ahead),"behind":0,"upstream":"origin/\(name)"},
             "pullRequest":\(pr ?? "null")}
            """
        }
        let json = "[" + [
            wt("feature/checkout", open: true, dirty: 3, pr: pr(42, "open", checks: "failure")),
            wt("fix/login-timeout", open: true, ahead: 2, pr: pr(41, "open", checks: "success")),
            wt("main", main: true, pr: nil),
            wt("feature/search", dirty: 1, pr: pr(40, "open", checks: "pending")),
            wt("spike/new-api", pr: pr(39, "open", checks: nil, draft: true)),
            wt("chore/deps", pr: pr(38, "merged", checks: "success")),
            wt("old/experiment", exists: false, pr: pr(30, "closed", checks: nil)),
        ].joined(separator: ",") + "]"
        return (try? JSONDecoder().decode([Worktree].self, from: Data(json.utf8))) ?? []
    }
}
