import Testing
@testable import KunjWorkspaceCore

@Suite struct VersionTests {
    @Test func parse() {
        #expect(SemVer("v1.2.3") == SemVer("1.2.3"))
        #expect(SemVer("1.2.3")?.major == 1)
        #expect(SemVer("1.2.3")?.patch == 3)
        #expect(SemVer("1.4.0-beta.1") == SemVer("1.4.0"))
        #expect(SemVer(" 1.3.2\n") == SemVer("1.3.2"))
        #expect(SemVer("garbage") == nil)
        #expect(SemVer("1.2") == nil)
        #expect(SemVer("") == nil)
    }

    @Test func ordering() {
        #expect(SemVer("1.2.9")! < SemVer("1.3.0")!)
        #expect(SemVer("1.10.0")! > SemVer("1.9.9")!)
        #expect(SemVer("2.0.0")! > SemVer("1.99.99")!)
    }

    @Test func minimumIs130() {
        #expect(MIN_KUNJ_VERSION == SemVer("1.3.0"))
    }

    @Test func devBuildAccepted() {
        #expect(checkVersion("1.0.0") == VersionCheck(ok: true, dev: true))
    }

    @Test func tooOld() {
        #expect(checkVersion("1.2.9", min: SemVer("1.3.0")!) == VersionCheck(ok: false, dev: false))
        #expect(checkVersion("1.2.0") == VersionCheck(ok: false, dev: false))
    }

    @Test func newEnough() {
        #expect(checkVersion("1.3.0") == VersionCheck(ok: true, dev: false))
        #expect(checkVersion("v1.4.2\n") == VersionCheck(ok: true, dev: false))
    }

    @Test func unparsableRefused() {
        #expect(checkVersion("command not found") == VersionCheck(ok: false, dev: false))
    }
}
