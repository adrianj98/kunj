// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "KunjBar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "KunjBar",
            path: "Sources/KunjBar"
        ),
    ]
)
