// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "NativeIDESpike",
    platforms: [.macOS(.v14)],
    dependencies: [
        // exact release 1.20.0, fetched and patched by scripts/prepare-swiftterm.sh
        .package(path: "vendor/SwiftTerm"),
    ],
    targets: [
        .executableTarget(
            name: "NativeIDESpike",
            dependencies: ["SwiftTerm"],
            path: "Sources/NativeIDESpike"
        ),
    ]
)
