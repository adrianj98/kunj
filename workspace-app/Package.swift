// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "KunjWorkspace",
    platforms: [.macOS(.v14)],
    dependencies: [
        // Exact release 1.20.0, fetched and patched by scripts/prepare-swiftterm.sh
        // (scripts/test.sh and scripts/bundle.sh run it first).
        .package(path: "vendor/SwiftTerm"),
    ],
    targets: [
        // Everything testable without a window: Foundation only.
        .target(
            name: "KunjWorkspaceCore",
            path: "Sources/KunjWorkspaceCore"
        ),
        .executableTarget(
            name: "KunjWorkspace",
            dependencies: ["KunjWorkspaceCore", "SwiftTerm"],
            path: "Sources/KunjWorkspace"
        ),
        .testTarget(
            name: "KunjWorkspaceCoreTests",
            // SwiftTerm only for the check that a terminal's child inherits no descriptor of the app
            dependencies: ["KunjWorkspaceCore", "SwiftTerm"],
            path: "Tests/KunjWorkspaceCoreTests"
        ),
    ],
    swiftLanguageVersions: [.v5]
)
