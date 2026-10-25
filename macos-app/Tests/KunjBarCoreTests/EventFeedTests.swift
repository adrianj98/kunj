import Testing
@testable import KunjBarCore

@Test func changesRefresh() {
    for line in [
        #"{"at":"t","type":"container","repo":{"name":"r","root":"/r"},"branch":"b","container":"kunj-r-b","action":"die"}"#,
        #"{"at":"t","type":"agent","session":"kunj-r-b","running":false}"#,
        #"{"at":"t","type":"git","repo":{"name":"r","root":"/r"}}"#,
        #"{"at":"t","type":"forwards"}"#,
        #"{"at":"t","type":"backend","status":"available"}"#,
    ] {
        #expect(eventReaction(line: line, afterRestart: false) == .refresh)
    }
}

@Test func containersOfOtherRepositoriesAreIgnored() {
    let line = #"{"at":"t","type":"container","repo":null,"branch":"b","container":"kunj-other-b","action":"start"}"#
    #expect(eventReaction(line: line, afterRestart: false) == .ignore)
}

@Test func helloRefreshesOnlyAfterARestart() {
    let hello = #"{"at":"t","type":"hello","version":"1.4.0","repos":2}"#
    #expect(eventReaction(line: hello, afterRestart: false) == .ignore)
    #expect(eventReaction(line: hello, afterRestart: true) == .refresh)
}

@Test func aNewRepositoryRestartsTheStream() {
    #expect(eventReaction(line: #"{"at":"t","type":"repos"}"#, afterRestart: false) == .restartStream)
}

@Test func sessionsUnknownTypesAndNoiseAreIgnored() {
    #expect(eventReaction(line: #"{"at":"t","type":"sessions"}"#, afterRestart: false) == .ignore)
    #expect(eventReaction(line: #"{"at":"t","type":"something-new"}"#, afterRestart: false) == .ignore)
    #expect(eventReaction(line: #"{"error":{"code":"error","message":"x"}}"#, afterRestart: false) == .ignore)
    #expect(eventReaction(line: "not json", afterRestart: false) == .ignore)
    #expect(eventReaction(line: "", afterRestart: false) == .ignore)
}
