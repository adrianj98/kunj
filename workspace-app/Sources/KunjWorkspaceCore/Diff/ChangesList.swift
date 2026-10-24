import Foundation

/// The Changes column's row names: a file's basename, or as many trailing path components as it
/// takes to tell it from every other file with the same basename (`routes/index.ts` beside
/// `src/index.ts`), up to the whole path.
public func changedFileDisplayNames(_ files: [ChangedFile]) -> [String] {
    let parts = files.map { $0.path.split(separator: "/").map(String.init) }
    var depth = parts.map { _ in 1 }
    func name(_ i: Int) -> String { parts[i].suffix(depth[i]).joined(separator: "/") }
    var changed = true
    while changed {
        changed = false
        var byName: [String: [Int]] = [:]
        for i in parts.indices { byName[name(i), default: []].append(i) }
        for group in byName.values where group.count > 1 {
            for i in group where depth[i] < parts[i].count {
                depth[i] += 1
                changed = true
            }
        }
    }
    return parts.indices.map { parts[$0].isEmpty ? files[$0].path : name($0) }
}

/// The row to select after the list was reloaded: the previously selected path when it is still
/// listed, else the first file; nil for an empty list.
public func selectedIndexAfterRefresh(previous: String?, files: [ChangedFile]) -> Int? {
    guard !files.isEmpty else { return nil }
    if let previous, let i = files.firstIndex(where: { $0.path == previous }) { return i }
    return 0
}

/// `1 file`, `14 files`.
public func changesCountLabel(_ n: Int) -> String {
    n == 1 ? "1 file" : "\(n) files"
}
