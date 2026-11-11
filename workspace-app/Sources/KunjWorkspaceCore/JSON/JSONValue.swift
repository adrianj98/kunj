import Foundation

/// Any JSON value: what a kunj setting can hold (`kunj config --list --json`, the schema's defaults).
public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else {
            self = .object(try c.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    /// The text as JSON (a bare `3`, `"x"` or `true` too); nil when it is not JSON.
    public init?(json: String) {
        guard let data = json.data(using: .utf8),
              let any = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
              let value = JSONValue(any: any)
        else { return nil }
        self = value
    }

    private init?(any: Any) {
        switch any {
        case is NSNull:
            self = .null
        case let n as NSNumber:
            // JSONSerialization gives booleans as the CFBoolean singletons
            if CFGetTypeID(n) == CFBooleanGetTypeID() {
                self = .bool(n.boolValue)
            } else {
                guard n.doubleValue.isFinite else { return nil }
                self = .number(n.doubleValue)
            }
        case let s as String:
            self = .string(s)
        case let a as [Any]:
            var out: [JSONValue] = []
            for item in a {
                guard let v = JSONValue(any: item) else { return nil }
                out.append(v)
            }
            self = .array(out)
        case let o as [String: Any]:
            var out: [String: JSONValue] = [:]
            for (k, item) in o {
                guard let v = JSONValue(any: item) else { return nil }
                out[k] = v
            }
            self = .object(out)
        default:
            return nil
        }
    }

    private var any: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let b): return b
        case .number(let n):
            // A whole number prints as 3, not 3.0
            if n.isFinite, n == n.rounded(), abs(n) < 9_007_199_254_740_992 { return Int64(n) }
            return n
        case .string(let s): return s
        case .array(let a): return a.map(\.any)
        case .object(let o): return o.mapValues(\.any)
        }
    }

    private func text(_ options: JSONSerialization.WritingOptions) -> String {
        if case .number(let n) = self, !n.isFinite { return "null" }
        guard let data = try? JSONSerialization.data(withJSONObject: any, options: options.union([.fragmentsAllowed, .sortedKeys, .withoutEscapingSlashes])),
              let s = String(data: data, encoding: .utf8)
        else { return "null" }
        return s
    }

    /// One line, keys sorted: what `kunj config --set-json` is given.
    public func compact() -> String { text([]) }

    /// Indented, keys sorted: what a JSON text box shows.
    public func pretty() -> String { text([.prettyPrinted]) }

    /// The value at a dotted key (`agent.tmux`) through nested objects.
    public func at(_ dottedKey: String) -> JSONValue? {
        var current = self
        for part in dottedKey.split(separator: ".", omittingEmptySubsequences: false) {
            guard case .object(let o) = current, let next = o[String(part)] else { return nil }
            current = next
        }
        return current
    }
}
