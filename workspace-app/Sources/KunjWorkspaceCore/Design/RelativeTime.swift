import Foundation

/// The sidebar's relative time: `now` (under 45 s, or in the future), `2m`, `1h`, `3d`, `2w`, `3mo`, `2y`.
public func relativeTime(_ date: Date, now: Date = Date()) -> String {
    let s = now.timeIntervalSince(date)
    if s < 45 { return "now" }
    let minutes = max(1, Int((s / 60).rounded()))
    if minutes < 60 { return "\(minutes)m" }
    let hours = Int(s / 3600)
    if hours < 24 { return "\(hours)h" }
    let days = Int(s / 86400)
    if days < 14 { return "\(days)d" }
    if days < 60 { return "\(days / 7)w" }
    if days < 365 { return "\(days / 30)mo" }
    return "\(days / 365)y"
}

/// The status bar's uptime: `5m`, `2h 14m`, `3d 1h`.
public func uptime(since date: Date, now: Date = Date()) -> String {
    let s = max(0, Int(now.timeIntervalSince(date)))
    let days = s / 86400, hours = (s % 86400) / 3600, minutes = (s % 3600) / 60
    if days > 0 { return "\(days)d \(hours)h" }
    if hours > 0 { return "\(hours)h \(minutes)m" }
    return "\(minutes)m"
}
