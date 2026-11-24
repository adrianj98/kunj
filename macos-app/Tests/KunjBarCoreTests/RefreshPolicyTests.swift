import Testing
@testable import KunjBarCore

@Test func closedPanelRefreshesSlowly() {
    #expect(RefreshPolicy.timerInterval(setting: 60, panelOpen: true) == 60)
    #expect(RefreshPolicy.timerInterval(setting: 60, panelOpen: false) == 300)
    #expect(RefreshPolicy.timerInterval(setting: 600, panelOpen: false) == 600)
    #expect(RefreshPolicy.timerInterval(setting: 5, panelOpen: true) == 10)
}

@Test func neverMeansNoTimerOpenOrClosed() {
    #expect(RefreshPolicy.timerInterval(setting: 0, panelOpen: true) == nil)
    #expect(RefreshPolicy.timerInterval(setting: 0, panelOpen: false) == nil)
}

@Test func containersAndEventsOnlyWithThePanelOpen() {
    #expect(RefreshPolicy.includeContainers(setting: true, panelOpen: true))
    #expect(!RefreshPolicy.includeContainers(setting: true, panelOpen: false))
    #expect(!RefreshPolicy.includeContainers(setting: false, panelOpen: true))
    #expect(RefreshPolicy.reactsToEvents(panelOpen: true))
    #expect(!RefreshPolicy.reactsToEvents(panelOpen: false))
}

@Test func watchedRootsAreTheVisibleExistingRepositories() {
    let roots = watchedRoots([
        (root: "/a", hidden: false, exists: true),
        (root: "/hidden", hidden: true, exists: true),
        (root: "/gone", hidden: false, exists: false),
        (root: "/b", hidden: false, exists: true),
    ])
    #expect(roots == ["/a", "/b"])
    // Same set in another order: no restart
    #expect(roots == watchedRoots([(root: "/b", hidden: false, exists: true), (root: "/a", hidden: false, exists: true)]))
}

@Test func streamArgumentsNameTheRepositories() {
    #expect(eventStreamArguments(roots: []) == ["events", "--json"])
    #expect(eventStreamArguments(roots: ["/b", "/a"]) == ["events", "--json", "--repo", "/a", "/b"])
}
