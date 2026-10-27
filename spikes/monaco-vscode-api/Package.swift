// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "MonacoVSCodeSpike",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "MonacoVSCodeSpike", path: "Sources/MonacoVSCodeSpike"),
    ]
)
