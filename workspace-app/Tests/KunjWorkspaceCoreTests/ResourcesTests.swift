import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct ResourcesTests {
    private func decode(_ text: String) throws -> ResourcesJson {
        try JSONDecoder().decode(ResourcesJson.self, from: Data(text.utf8))
    }

    private let listing = #"""
    {"places":[{"name":"This Mac","kind":"docker","available":true},
               {"name":"machines","kind":"cloud","available":true,"provider":"gce"},
               {"name":"box","kind":"remote","available":false,"message":"unreachable"}],
     "resources":[
      {"kind":"machine","name":"kunj-app-a-111111","place":"machines","repo":"github.com/acme/app","branch":"a","state":"running","detail":"e2-standard-2","createdAt":"2026-11-17T10:00:00Z"},
      {"kind":"machine","name":"kunj-app-b-222222","place":"machines","repo":"github.com/acme/app","branch":"b","state":"suspended","detail":"e2-standard-2"},
      {"kind":"container","name":"kunj-app-a-111111","place":"machines","machine":"kunj-app-a-111111","repo":"github.com/acme/app","branch":"a","state":"running","detail":"kunj-blueprint-app:abc"},
      {"kind":"volume","name":"kunj-app-cache-db-123456","place":"This Mac","repo":"github.com/acme/app","detail":"cache db"},
      {"kind":"image","name":"kunj-blueprint-app:abc","place":"This Mac","repo":"github.com/acme/app","detail":"blueprint snapshot","sizeBytes":1739461754},
      {"kind":"machine-image","name":"kunj-app-img-1","place":"machines","repo":"github.com/acme/app","detail":"golden image"},
      {"kind":"cache-store","name":"gs://my-cache","place":"machines","detail":"bucket for caches"}
     ]}
    """#

    @Test func rowsAreSectionsInAFixedOrderWithReadyCells() throws {
        let rows = resourceRows(try decode(listing))
        let titles = rows.compactMap { row -> String? in
            if case .section(let title, let count) = row { return "\(title) \(count)" }
            return nil
        }
        #expect(titles == ["Cloud machines 2", "Containers 1", "Volumes 1", "Images 1", "Machine images 1", "Cache stores 1"])
        guard case .item(let machine) = rows[1], case .item(let container) = rows[4], case .item(let image) = rows[8] else {
            Issue.record("unexpected row order")
            return
        }
        #expect(machine == ResourceItem(name: "kunj-app-a-111111", owner: "app / a", state: "running", detail: "e2-standard-2",
                                        size: "", location: "machines", active: true))
        #expect(container.location == "machines · kunj-app-a-111111")
        #expect(image.size == "1.6 GB")
        #expect(image.owner == "app")
    }

    @Test func summaryAndSilentPlaces() throws {
        let json = try decode(listing)
        #expect(resourceSummary(json) == "2 cloud machines · 1 container · 1 volume · 2 images")
        #expect(silentPlaces(json) == ["box did not answer, so what it holds is not listed"])
        let empty = try decode(#"{"places":[{"name":"This Mac","kind":"docker","available":true}],"resources":[]}"#)
        #expect(resourceSummary(empty) == "kunj manages nothing right now")
        #expect(resourceRows(empty).isEmpty)
        #expect(formatBytes(36_700_160) == "35 MB")
        #expect(repoShortName("github.com/acme/app") == "app")
    }
}
