// The open worktree switcher: a global shortcut shows a panel in the middle
// of the screen listing the worktrees open in an editor; ↑/↓ pick one, ↩ or
// a click brings it to the front, ⎋ or clicking elsewhere dismisses it.

import AppKit
import Observation
import SwiftUI

@MainActor
@Observable
final class SwitcherModel {
    var selection = 0
    var items: [(repo: KnownRepo, worktree: Worktree)] = []
}

@MainActor
final class Switcher {
    static let shared = Switcher()

    private var store: AppStore?
    private var hotKey: HotKey?
    private var registered: (enabled: Bool, shortcut: Shortcut)?
    private var panel: SwitcherPanel?
    private let model = SwitcherModel()
    private var defaultsObserver: NSObjectProtocol?
    private var observation = false

    func install(store: AppStore) {
        guard self.store == nil else { return }
        self.store = store
        registerHotKey()
        defaultsObserver = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.registerHotKey() }
        }
    }

    // Set by the Settings shortcut recorder so the current shortcut can be pressed while recording
    var suspended = false {
        didSet { registered = nil; registerHotKey() }
    }

    private func registerHotKey() {
        let defaults = UserDefaults.standard
        let wanted = (enabled: defaults.kunjSwitcherEnabled && !suspended, shortcut: defaults.kunjSwitcherShortcut)
        if let registered, registered.enabled == wanted.enabled, registered.shortcut == wanted.shortcut { return }
        hotKey?.unregister()
        hotKey = nil
        registered = wanted
        guard wanted.enabled else { return }
        hotKey = HotKey(wanted.shortcut) { [weak self] in self?.toggle() }
        if hotKey == nil {
            store?.flash = "\(wanted.shortcut.display) is already used by another app; pick another shortcut in Settings"
        }
    }

    func toggle() {
        if let panel, panel.isVisible { hide() } else { show() }
    }

    func show() {
        guard let store else { return }
        store.refresh()
        updateItems()
        model.selection = 0
        let panel = self.panel ?? makePanel(store: store)
        self.panel = panel
        panel.center(on: NSScreen.screenWithMouse ?? NSScreen.main)
        panel.makeKeyAndOrderFront(nil)
        observeStore()
    }

    func hide() {
        panel?.orderOut(nil)
    }

    // Keep the list in step with the store while the panel is up (the
    // listing arrives a moment after the shortcut when the refresh finishes)
    private func observeStore() {
        guard !observation, let store else { return }
        observation = true
        withObservationTracking {
            _ = store.repos
        } onChange: {
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.observation = false
                guard self.panel?.isVisible == true else { return }
                self.updateItems()
                self.observeStore()
            }
        }
    }

    private func updateItems() {
        guard let store else { return }
        let selected = model.items.indices.contains(model.selection) ? model.items[model.selection].worktree.path : nil
        model.items = store.repos.flatMap { state in
            state.worktrees.filter(\.isActive).map { (repo: state.repo, worktree: $0) }
        }
        model.selection = model.items.firstIndex { $0.worktree.path == selected } ?? min(model.selection, max(model.items.count - 1, 0))
    }

    private func makePanel(store: AppStore) -> SwitcherPanel {
        let panel = SwitcherPanel()
        let view = SwitcherView(model: model, choose: { [weak self] index in self?.choose(index) })
            .environment(store)
        let host = NSHostingController(rootView: view)
        host.sizingOptions = .preferredContentSize
        panel.contentViewController = host
        panel.onKey = { [weak self] key in self?.handle(key) ?? false }
        return panel
    }

    private func handle(_ key: SwitcherPanel.Key) -> Bool {
        switch key {
        case .up:
            if !model.items.isEmpty { model.selection = (model.selection - 1 + model.items.count) % model.items.count }
        case .down:
            if !model.items.isEmpty { model.selection = (model.selection + 1) % model.items.count }
        case .enter:
            choose(model.selection)
        case .escape:
            hide()
        }
        return true
    }

    private func choose(_ index: Int) {
        guard let store, model.items.indices.contains(index) else { return }
        let item = model.items[index]
        hide()
        store.open(item.worktree, in: item.repo)
    }
}

// Borderless panel that takes the keyboard without activating the app, on
// whichever desktop (or full-screen space) is current
final class SwitcherPanel: NSPanel {
    enum Key { case up, down, enter, escape }

    var onKey: ((Key) -> Bool)?
    private var centre: NSPoint?

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 480, height: 200),
                   styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
                   backing: .buffered, defer: true)
        isFloatingPanel = true
        level = .modalPanel
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        NotificationCenter.default.addObserver(forName: NSWindow.didResizeNotification, object: self, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.recentre() }
        }
        NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: self, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.orderOut(nil) }
        }
    }

    override var canBecomeKey: Bool { true }

    func center(on screen: NSScreen?) {
        guard let screen else { return }
        let frame = screen.visibleFrame
        // A little above the middle, like Spotlight
        centre = NSPoint(x: frame.midX, y: frame.midY + frame.height * 0.1)
        recentre()
    }

    // The list grows and shrinks; keep it centred where it was shown
    private func recentre() {
        guard let centre else { return }
        let size = frame.size
        setFrameOrigin(NSPoint(x: (centre.x - size.width / 2).rounded(), y: (centre.y - size.height / 2).rounded()))
    }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown {
            let key: Key?
            switch Int(event.keyCode) {
            case 126: key = .up              // kVK_UpArrow
            case 125: key = .down            // kVK_DownArrow
            case 36, 76: key = .enter        // kVK_Return, kVK_ANSI_KeypadEnter
            case 53: key = .escape           // kVK_Escape
            default: key = nil
            }
            if let key, onKey?(key) == true { return }
        }
        super.sendEvent(event)
    }
}

extension NSScreen {
    static var screenWithMouse: NSScreen? {
        let mouse = NSEvent.mouseLocation
        return screens.first { NSMouseInRect(mouse, $0.frame, false) }
    }
}
