import AppKit
import KunjWorkspaceCore
import UniformTypeIdentifiers
import WebKit

/// Serves the bundled page under `kunj://app/`: `fonts/…` from `Resources/fonts`, everything else
/// from `Resources/web` (Monaco's `vs/`, `index.html`, `app.js`). `file://` would break Monaco's
/// AMD loader and its workers (opaque origin); a custom scheme gives the page a real origin
/// (spikes/native-ide Editor.swift). Nothing outside those two directories is served.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "kunj"
    let web: URL
    let fonts: URL

    init(resources: URL) {
        web = resources.appendingPathComponent("web").standardizedFileURL
        fonts = resources.appendingPathComponent("fonts").standardizedFileURL
    }

    /// `Contents/Resources` inside the app, or `workspace-app/Resources` for `swift run`.
    static func resources() -> URL {
        if let r = Bundle.main.resourceURL,
           FileManager.default.fileExists(atPath: r.appendingPathComponent("web/index.html").path) {
            return r
        }
        // Sources/KunjWorkspace/Editor/MonacoWebView.swift -> ../../../Resources
        return URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources")
    }

    func file(for url: URL) -> URL? {
        var rel = url.path
        while rel.hasPrefix("/") { rel.removeFirst() }
        if rel.isEmpty { rel = "index.html" }
        let (root, sub): (URL, String) = rel.hasPrefix("fonts/") ? (fonts, String(rel.dropFirst(6))) : (web, rel)
        let file = root.appendingPathComponent(sub).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/") else { return nil }
        return file
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, let file = file(for: url), let data = try? Data(contentsOf: file) else {
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
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

/// WKUserContentController retains its handlers; this keeps the view out of that cycle.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: MonacoWebView?
    init(_ target: MonacoWebView) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.received(message)
    }
}

/// One Monaco page in a WKWebView: `mode` "diff" (the Changes column) or "editor" (editor tabs).
/// Both share one process pool, so the two pages run in one WebKit content process. Calls queue
/// until the page posts `ready`; a crashed content process reloads the page and posts `ready` again
/// (`onMessage` sees it, so the owner can show its content again).
final class MonacoWebView: NSView, WKNavigationDelegate {
    static let processPool = WKProcessPool()

    let mode: String
    let webView: WKWebView
    private(set) var ready = false
    var onMessage: (([String: Any]) -> Void)?
    private var pending: [() -> Void] = []
    private let handler: AppSchemeHandler

    init(mode: String) {
        self.mode = mode
        handler = AppSchemeHandler(resources: AppSchemeHandler.resources())
        let config = WKWebViewConfiguration()
        config.processPool = Self.processPool
        config.setURLSchemeHandler(handler, forURLScheme: AppSchemeHandler.scheme)
        config.userContentController = WKUserContentController()
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 400), configuration: config)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        config.userContentController.add(WeakMessageHandler(self), name: "kunj")
        webView.navigationDelegate = self
        // No white flash before the page has painted the theme's background
        webView.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        webView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            webView.topAnchor.constraint(equalTo: topAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        load()
    }
    required init?(coder: NSCoder) { fatalError() }

    private func load() {
        ready = false
        webView.load(URLRequest(url: URL(string: "\(AppSchemeHandler.scheme)://app/index.html?mode=\(mode)")!))
    }

    fileprivate func received(_ message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        switch body["type"] as? String {
        case "ready":
            ready = true
            let queued = pending
            pending = []
            queued.forEach { $0() }
        case "error":
            log("monaco (\(mode)): \(body["message"] ?? "")")
        default:
            break
        }
        onMessage?(body)
    }

    /// Runs `f` now when the page is ready, else once it is.
    func whenReady(_ f: @escaping () -> Void) {
        if ready { f() } else { pending.append(f) }
    }

    /// Calls `window.kunj[fn](args)` once the page is ready and returns its (awaited) result; nil
    /// when it threw.
    @discardableResult
    func call(_ fn: String, _ args: [String: Any] = [:]) async -> Any? {
        await withCheckedContinuation { (done: CheckedContinuation<Any?, Never>) in
            whenReady {
                self.webView.callAsyncJavaScript(
                    "return await window.kunj[fn](args)", arguments: ["fn": fn, "args": args],
                    in: nil, in: .page
                ) { result in
                    switch result {
                    case .success(let value): done.resume(returning: value)
                    case .failure(let error):
                        log("monaco \(fn) failed: \(error)")
                        done.resume(returning: nil)
                    }
                }
            }
        }
    }

    /// The theme's tokens for the page's `setTheme`.
    static func tokens(_ theme: Theme) -> [String: Any] {
        let t = theme.tokens
        return [
            "dark": theme.isDark, "bg": t.bg, "raised": t.raised, "raised2": t.raised2, "border": t.border,
            "borderStrong": t.borderStrong, "text": t.text, "text2": t.text2, "muted": t.muted,
            "faintest": t.faintest, "green": t.green, "red": t.red, "addBg": t.addBg,
        ]
    }

    /// The page as an image (WKWebView is not drawn by cacheDisplay; --screenshot composites it).
    func snapshot(completion: @escaping (NSImage?) -> Void) {
        let config = WKSnapshotConfiguration()
        config.rect = webView.bounds
        webView.takeSnapshot(with: config) { image, error in
            if let error { log("monaco snapshot failed: \(error)") }
            completion(image)
        }
    }

    // MARK: WKNavigationDelegate

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log("monaco (\(mode)): web content process ended; reloading")
        load()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        log("monaco (\(mode)): navigation failed: \(error)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        log("monaco (\(mode)): navigation failed: \(error)")
    }

    /// Only the page itself; a link inside Monaco never navigates the view.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.request.url?.scheme == AppSchemeHandler.scheme ? .allow : .cancel)
    }
}
