import Foundation

// ---- kunj resources --json: everything kunj manages, wherever it is

public struct ResourcesJson: Decodable, Equatable, Sendable {
    public var places: [Place]
    public var resources: [Resource]

    /// Where kunj looked: this Mac's Docker, a remote, or a coordinator's cloud. One that did not
    /// answer has `available` false, and what it holds is missing from `resources`, not gone.
    public struct Place: Decodable, Equatable, Sendable {
        public var name: String
        public var kind: String
        public var available: Bool
        public var message: String?
    }

    public struct Resource: Decodable, Equatable, Sendable {
        /// `machine`, `container`, `service`, `helper`, `volume`, `network`, `image`, `machine-image`, `cache-store`
        public var kind: String
        public var name: String
        public var place: String
        public var machine: String?
        public var repo: String?
        public var branch: String?
        public var state: String?
        public var detail: String?
        public var sizeBytes: Int64?
        public var createdAt: String?
    }
}

/// One line of the Resources window: a section title, or a resource with its cells ready to show.
public enum ResourceRow: Equatable, Sendable {
    case section(title: String, count: Int)
    case item(ResourceItem)
}

public struct ResourceItem: Equatable, Sendable {
    public var name: String
    /// `repo / branch`, either part left out when unknown
    public var owner: String
    public var state: String
    public var detail: String
    public var size: String
    /// The place, and the machine when it lives on one
    public var location: String
    /// Running, or a machine that is awake: drawn in the accent colour
    public var active: Bool
}

private let sectionTitles: [(kind: String, title: String)] = [
    ("machine", "Cloud machines"),
    ("container", "Containers"),
    ("service", "Services"),
    ("helper", "Firewall helpers"),
    ("volume", "Volumes"),
    ("network", "Networks"),
    ("image", "Images"),
    ("machine-image", "Machine images"),
    ("cache-store", "Cache stores"),
]

/// `github.com/acme/app` → `app`
public func repoShortName(_ id: String?) -> String {
    guard let id, !id.isEmpty else { return "" }
    return id.split(separator: "/").last.map(String.init) ?? id
}

public func formatBytes(_ bytes: Int64?) -> String {
    guard let bytes, bytes > 0 else { return "" }
    let mb = Double(bytes) / 1_048_576
    return mb >= 1024 ? String(format: "%.1f GB", mb / 1024) : "\(Int(mb.rounded())) MB"
}

/// The window's rows: sections in a fixed order (machines first), empty ones left out.
public func resourceRows(_ json: ResourcesJson) -> [ResourceRow] {
    var rows: [ResourceRow] = []
    for (kind, title) in sectionTitles {
        let items = json.resources.filter { $0.kind == kind }
        guard !items.isEmpty else { continue }
        rows.append(.section(title: title, count: items.count))
        for r in items {
            let owner = [repoShortName(r.repo), r.branch ?? ""].filter { !$0.isEmpty }.joined(separator: " / ")
            rows.append(.item(ResourceItem(
                name: r.name, owner: owner, state: r.state ?? "", detail: r.detail ?? "",
                size: formatBytes(r.sizeBytes),
                location: r.machine.map { "\(r.place) · \($0)" } ?? r.place,
                active: r.state == "running")))
        }
    }
    return rows
}

/// "3 cloud machines · 2 containers · 6 images": what the window's header says.
public func resourceSummary(_ json: ResourcesJson) -> String {
    let count = { (kind: String) in json.resources.filter { $0.kind == kind }.count }
    let parts: [(Int, String, String)] = [
        (count("machine"), "cloud machine", "cloud machines"),
        (count("container"), "container", "containers"),
        (count("volume"), "volume", "volumes"),
        (count("image") + count("machine-image"), "image", "images"),
    ]
    let text = parts.filter { $0.0 > 0 }.map { "\($0.0) \($0.0 == 1 ? $0.1 : $0.2)" }.joined(separator: " · ")
    return text.isEmpty ? "kunj manages nothing right now" : text
}

/// The places that did not answer, as one line each; empty when all did.
public func silentPlaces(_ json: ResourcesJson) -> [String] {
    json.places.filter { !$0.available }.map { "\($0.name) did not answer, so what it holds is not listed" }
}
