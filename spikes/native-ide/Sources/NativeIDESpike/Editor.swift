import AppKit
import WebKit
import UniformTypeIdentifiers

/// Serves the bundled web root under spike://app/. file:// would break Monaco's AMD loader
/// and its workers (opaque origin); a custom scheme gives the page a real origin.
final class SpikeSchemeHandler: NSObject, WKURLSchemeHandler {
    let root: URL
    private(set) var served = 0
    private(set) var failed: [String] = []

    init(root: URL) { self.root = root }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var rel = url.path
        if rel.hasPrefix("/") { rel.removeFirst() }
        if rel.isEmpty { rel = "index.html" }
        let file = root.appendingPathComponent(rel).standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path), let data = try? Data(contentsOf: file) else {
            failed.append(rel)
            task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
            return
        }
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let headers = [
            "Content-Type": mime,
            "Content-Length": String(data.count),
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache",
        ]
        let resp = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
        served += 1
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

/// The one WKWebView of the window, hosting Monaco's diff editor.
final class EditorController: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let webView: WKWebView
    let handler: SpikeSchemeHandler
    let createdAtMs: Double
    private(set) var ready = false
    private(set) var messages: [[String: Any]] = []
    var onMessage: (([String: Any]) -> Void)?
    private var pending: [() -> Void] = []

    static func webRoot() -> URL {
        if let r = Bundle.main.resourceURL?.appendingPathComponent("web"),
           FileManager.default.fileExists(atPath: r.appendingPathComponent("index.html").path) {
            return r
        }
        // swift run: Sources/NativeIDESpike/Editor.swift -> ../../Resources/web
        return URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Resources/web")
    }

    override init() {
        createdAtMs = nowMs()
        handler = SpikeSchemeHandler(root: EditorController.webRoot())
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(handler, forURLScheme: "spike")
        let ucc = WKUserContentController()
        config.userContentController = ucc
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: config)
        super.init()
        ucc.add(self, name: "spike")
        webView.navigationDelegate = self
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        webView.load(URLRequest(url: URL(string: "spike://app/index.html" + (ProcessInfo.processInfo.environment["SPIKE_WEB_QUERY"] ?? ""))!))
    }

    var webContentPid: Int32? {
        (webView.value(forKey: "_webProcessIdentifier") as? NSNumber)?.int32Value
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard var m = message.body as? [String: Any] else { return }
        m["swiftMs"] = nowMs() - createdAtMs
        messages.append(m)
        if m["type"] as? String == "ready" {
            ready = true
            let p = pending
            pending = []
            p.forEach { $0() }
        }
        if let t = m["type"] as? String, t == "error" || t == "console" { log("web \(m)") }
        onMessage?(m)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        log("web navigation failed: \(error)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        log("web provisional navigation failed: \(error)")
    }

    func whenReady(_ f: @escaping () -> Void) {
        if ready { f() } else { pending.append(f) }
    }

    /// Sends {original, modified, language}; completion gets the page's diffRendered message.
    func showDiff(original: String, modified: String, language: String,
                  completion: (([String: Any]?) -> Void)? = nil) {
        whenReady {
            self.webView.callAsyncJavaScript(
                "return await window.showDiff(original, modified, language)",
                arguments: ["original": original, "modified": modified, "language": language],
                in: nil, in: .page
            ) { result in
                switch result {
                case .success(let v): completion?(v as? [String: Any])
                case .failure(let e): log("showDiff failed: \(e)"); completion?(nil)
                }
            }
        }
    }

    func eval(_ js: String, completion: @escaping (Any?) -> Void) {
        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
            switch r {
            case .success(let v): completion(v)
            case .failure(let e): log("eval failed: \(e)"); completion(nil)
            }
        }
    }
}
