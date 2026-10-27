// Loads one page in a WKWebView served from a custom scheme (as the workspace app does), waits for
// the page's `result` message, then records timings, the WebContent footprint and a screenshot.
//
//   MonacoVSCodeSpike --root <dir> --out <result.json> [--shot <png>] [--coi] [--theme-switches N]
//
// --coi adds COOP/COEP headers (cross-origin isolation) to every response.
import AppKit
import UniformTypeIdentifiers
import WebKit

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}
let root = URL(fileURLWithPath: arg("--root") ?? "web/dist").standardizedFileURL
let out = URL(fileURLWithPath: arg("--out") ?? "result.json")
let shot = arg("--shot").map { URL(fileURLWithPath: $0) }
let coi = CommandLine.arguments.contains("--coi")
let started = Date()

func runTool(_ path: String, _ args: [String]) -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    try? p.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return String(decoding: data, as: UTF8.self)
}

/// phys_footprint in MB via /usr/bin/footprint (spikes/native-ide Env.swift).
func footprintMB(_ pid: Int32) -> Double? {
    let out = runTool("/usr/bin/footprint", ["-p", String(pid)])
    guard let r = out.range(of: #"Footprint: ([0-9.]+) (KB|MB|GB)"#, options: .regularExpression) else { return nil }
    let parts = out[r].split(separator: " ")
    guard parts.count == 3, let v = Double(parts[1]) else { return nil }
    switch parts[2] { case "KB": return v / 1024; case "GB": return v * 1024; default: return v }
}

final class Handler: NSObject, WKURLSchemeHandler {
    var served: [String] = []
    var failed: [String] = []
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var rel = url.path
        while rel.hasPrefix("/") { rel.removeFirst() }
        let file = root.appendingPathComponent(rel.isEmpty ? "index.html" : rel).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            failed.append(rel)
            task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
            return
        }
        served.append(rel)
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        var headers = ["Content-Type": mime, "Content-Length": String(data.count), "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache"]
        if coi {
            headers["Cross-Origin-Opener-Policy"] = "same-origin"
            headers["Cross-Origin-Embedder-Policy"] = "require-corp"
            headers["Cross-Origin-Resource-Policy"] = "same-origin"
        }
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data)
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class Spike: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    let handler = Handler()
    var window: NSWindow!
    var webView: WKWebView!
    var consoleLines: [String] = []
    var activity: NSObjectProtocol?
    var workersCreated: [String] = []

    func applicationDidFinishLaunching(_ n: Notification) {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(handler, forURLScheme: "kunj")
        config.userContentController.add(self, name: "spike")
        // Console warnings and errors reach Swift too, so the report shows what the page complained about.
        config.userContentController.addUserScript(WKUserScript(source: """
            const OrigWorker = window.Worker;
            window.Worker = function (url, opts) {
              try { window.webkit.messageHandlers.spike.postMessage({ type: 'worker', url: String(url).split('/').pop().slice(0, 80) }) } catch (e) {}
              return new OrigWorker(url, opts);
            };
            window.Worker.prototype = OrigWorker.prototype;
            for (const level of ['warn', 'error']) {
              const orig = console[level];
              console[level] = (...a) => {
                try { window.webkit.messageHandlers.spike.postMessage({ type: 'console', level, text: a.map(String).join(' ').slice(0, 400) }) } catch (e) {}
                orig.apply(console, a);
              };
            }
            """, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 700), configuration: config)
        webView.navigationDelegate = self
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 1200, height: 700), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.contentView = webView
        // WebKit stops requestAnimationFrame for a hidden or occluded window, and Monaco draws its
        // lines in a frame callback (spikes/native-ide REPORT.md): keep the window on top and tell
        // WebKit not to track occlusion.
        let occlusion = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        if webView.responds(to: occlusion) { webView.perform(occlusion, with: false) }
        consoleLines.append("occlusion detection switch: \(webView.responds(to: occlusion))")
        window.level = .floating
        window.orderFrontRegardless()
        window.makeKeyAndOrderFront(nil)
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical], reason: "spike")
        NSApp.activate(ignoringOtherApps: true)
        webView.load(URLRequest(url: URL(string: "kunj://app/index.html")!))
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { self.finish(["ok": false, "errors": ["timeout: no result in 60 s"]]) }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { consoleLines.append("navigation failed: \(error)") }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { consoleLines.append("navigation failed: \(error)") }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { consoleLines.append("WebContent process terminated") }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        switch body["type"] as? String {
        case "worker": workersCreated.append(body["url"] as? String ?? "?")
        case "console": consoleLines.append("\(body["level"] ?? ""): \(body["text"] ?? "")")
        case "result":
            let page = body["result"] as? [String: Any] ?? [:]
            // Let workers and GC settle before measuring.
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.finish(page) }
        default: break
        }
    }

    var finished = false
    func finish(_ page: [String: Any]) {
        guard !finished else { return }
        finished = true
        let pid = (webView.value(forKey: "_webProcessIdentifier") as? NSNumber)?.int32Value
        var result: [String: Any] = [
            "root": root.path,
            "coi": coi,
            "page": page,
            "swiftWallMs": Int(Date().timeIntervalSince(started) * 1000),
            "webContentFootprintMB": pid.flatMap(footprintMB).map { (($0 * 10).rounded()) / 10 } ?? -1,
            "requests": handler.served.count,
            "failedRequests": handler.failed,
            "workersCreated": workersCreated,
            "console": Array(consoleLines.prefix(40)),
        ]
        if !(page["ok"] as? Bool ?? false) { result["ok"] = false }
        let write = {
            let data = try! JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
            try! data.write(to: out)
            print(String(decoding: data, as: UTF8.self))
            exit(0)
        }
        guard let shot else { write(); return }
        webView.takeSnapshot(with: nil) { image, _ in
            if let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
               let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: shot)
            }
            write()
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let spike = Spike()
app.delegate = spike
app.run()
