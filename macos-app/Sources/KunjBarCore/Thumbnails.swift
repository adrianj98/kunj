// Picking a window's thumbnail in Mission Control when several share its title.

import CoreGraphics

// Mission Control lays thumbnails out roughly where their windows sit on the screen,
// so the thumbnail whose position within the thumbnail area is nearest the window's
// position within the screen is the window's. Both rects use the same coordinate
// system. Returns the index into `thumbnails`, or nil when there are none.
public func nearestThumbnail(to window: CGRect, in screen: CGRect, among thumbnails: [CGRect], within area: CGRect) -> Int? {
    guard !thumbnails.isEmpty, screen.width > 0, screen.height > 0, area.width > 0, area.height > 0 else { return thumbnails.isEmpty ? nil : 0 }
    let target = CGPoint(x: (window.midX - screen.minX) / screen.width, y: (window.midY - screen.minY) / screen.height)
    let distances = thumbnails.map { t -> CGFloat in
        let p = CGPoint(x: (t.midX - area.minX) / area.width, y: (t.midY - area.minY) / area.height)
        return (p.x - target.x) * (p.x - target.x) + (p.y - target.y) * (p.y - target.y)
    }
    return distances.indices.min { distances[$0] < distances[$1] }
}
