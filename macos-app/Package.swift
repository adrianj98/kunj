// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "KunjBar",
    platforms: [.macOS(.v14)],
    targets: [
        // Pure decisions (slot geometry, window matching, desktop choice), testable without a session
        .target(
            name: "KunjBarCore",
            path: "Sources/KunjBarCore"
        ),
        .executableTarget(
            name: "KunjBar",
            dependencies: ["KunjBarCore"],
            path: "Sources/KunjBar"
        ),
        .testTarget(
            name: "KunjBarCoreTests",
            dependencies: ["KunjBarCore"],
            path: "Tests/KunjBarCoreTests"
        ),
    ]
)
