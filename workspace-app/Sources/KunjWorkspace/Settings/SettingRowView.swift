import AppKit
import KunjWorkspaceCore

/// A text box that ends editing on ⌘Return (Return adds a line).
private final class CommitTextView: NSTextView {
    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command), event.keyCode == 36 || event.keyCode == 76 {
            window?.makeFirstResponder(nil)
        } else {
            super.keyDown(with: event)
        }
    }
}

/// One setting in the Settings window: its title and control, then `key · source`, a Reset
/// button when the value is set in the scope shown, the description and, after a refused change,
/// the error. The control is chosen by `SettingRow.control`; a change is handed to `onChange` as a
/// JSON value and the window writes it with `kunj config --set-json`.
@MainActor
final class SettingRowView: NSView, NSTextFieldDelegate, NSTextViewDelegate {
    private(set) var row: SettingRow
    /// A valid new value for the setting.
    var onChange: (JSONValue) -> Void = { _ in }
    var onReset: () -> Void = {}

    private let title: NSTextField
    private let caption = makeLabel("", font: Theme.mono(DesignTokens.TypeScale.hint), color: .clear)
    private let resetButton = NSButton(title: "Reset", target: nil, action: nil)
    private let descriptionLabel = NSTextField(wrappingLabelWithString: "")
    private let noteLabel = NSTextField(wrappingLabelWithString: "")
    private let errorLabel = NSTextField(wrappingLabelWithString: "")
    private let separator = FillView(.clear)
    private var checkbox: NSButton?
    private var popup: NSPopUpButton?
    private var field: NSTextField?
    private var textView: NSTextView?
    private var textScroll: NSScrollView?
    /// The secure field was typed in since it got focus.
    private var secretEdited = false
    private var sourceText = ""
    private var enabled = true

    init(row: SettingRow) {
        self.row = row
        title = makeLabel(row.title, font: Theme.sans(DesignTokens.TypeScale.body), color: .clear)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityLabel(row.title)

        let control = makeControl()
        let wide = textScroll != nil
        resetButton.bezelStyle = .inline
        resetButton.controlSize = .small
        resetButton.target = self
        resetButton.action = #selector(resetClicked)
        resetButton.toolTip = "Remove this value, so the one below it applies"
        resetButton.setAccessibilityLabel("Reset \(row.title)")
        for l in [descriptionLabel, noteLabel, errorLabel] {
            l.font = Theme.sans(DesignTokens.TypeScale.caption)
            l.isSelectable = false
            l.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        }
        errorLabel.isSelectable = true
        errorLabel.isHidden = true
        noteLabel.isHidden = true
        title.setContentHuggingPriority(.defaultLow, for: .horizontal)
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        caption.setContentHuggingPriority(.defaultLow, for: .horizontal)
        caption.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        caption.lineBreakMode = .byTruncatingMiddle

        let head = NSStackView(views: wide ? [title] : [title, control])
        head.orientation = .horizontal
        head.alignment = .centerY
        head.spacing = 12
        head.distribution = .fill
        let meta = NSStackView(views: [caption, resetButton])
        meta.orientation = .horizontal
        meta.alignment = .centerY
        meta.spacing = 8
        let stack = NSStackView(views: [head] + (wide ? [control] : []) + [meta, descriptionLabel, noteLabel, errorLabel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        addSubview(separator)
        var constraints = [
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            head.widthAnchor.constraint(equalTo: stack.widthAnchor),
            meta.widthAnchor.constraint(equalTo: stack.widthAnchor),
            descriptionLabel.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor),
            noteLabel.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor),
            errorLabel.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor),
            separator.leadingAnchor.constraint(equalTo: leadingAnchor),
            separator.trailingAnchor.constraint(equalTo: trailingAnchor),
            separator.bottomAnchor.constraint(equalTo: bottomAnchor),
            separator.heightAnchor.constraint(equalToConstant: 1),
        ]
        if wide {
            constraints += [control.widthAnchor.constraint(equalTo: stack.widthAnchor), control.heightAnchor.constraint(equalToConstant: 84)]
        } else if field != nil {
            constraints.append(control.widthAnchor.constraint(equalToConstant: 280))
        }
        NSLayoutConstraint.activate(constraints)
        update(row, sourceText: "", enabled: true, note: nil)
        apply(ThemeManager.shared.current)
    }
    required init?(coder: NSCoder) { fatalError() }

    private func makeControl() -> NSView {
        switch row.control {
        case .checkbox:
            let b = NSButton(checkboxWithTitle: "", target: self, action: #selector(checkboxClicked))
            b.setAccessibilityLabel(row.title)
            checkbox = b
            return b
        case .popup(let options):
            let p = NSPopUpButton()
            p.addItems(withTitles: options)
            p.target = self
            p.action = #selector(popupChosen)
            p.setAccessibilityLabel(row.title)
            popup = p
            return p
        case .number, .text, .secret:
            let f: NSTextField = row.control == .secret ? NSSecureTextField() : NSTextField()
            f.font = Theme.mono(12)
            f.delegate = self
            f.lineBreakMode = .byTruncatingTail
            f.cell?.isScrollable = true
            f.translatesAutoresizingMaskIntoConstraints = false
            f.setAccessibilityLabel(row.title)
            field = f
            return f
        case .lines, .json:
            let t = CommitTextView()
            t.font = Theme.mono(12)
            t.isRichText = false
            t.isAutomaticQuoteSubstitutionEnabled = false
            t.isAutomaticDashSubstitutionEnabled = false
            t.isAutomaticSpellingCorrectionEnabled = false
            t.isAutomaticTextReplacementEnabled = false
            t.allowsUndo = true
            t.delegate = self
            t.isVerticallyResizable = true
            t.autoresizingMask = [.width]
            t.textContainerInset = NSSize(width: 4, height: 4)
            t.setAccessibilityLabel(row.title)
            let s = NSScrollView()
            s.documentView = t
            s.hasVerticalScroller = true
            s.borderType = .bezelBorder
            s.translatesAutoresizingMaskIntoConstraints = false
            textView = t
            textScroll = s
            return s
        }
    }

    /// The row is being typed in: a reload must not replace its text.
    var isEditing: Bool {
        if let field, field.currentEditor() != nil { return true }
        if let textView, window?.firstResponder === textView { return true }
        return false
    }

    /// Shows `row` (after a write, a reset or a reload). The text of a control being edited is left alone.
    func update(_ row: SettingRow, sourceText: String, enabled: Bool, note: String?) {
        self.row = row
        self.sourceText = sourceText
        self.enabled = enabled
        caption.stringValue = sourceText.isEmpty ? row.key : "\(row.key) · \(sourceText)"
        descriptionLabel.stringValue = row.description
        descriptionLabel.isHidden = row.description.isEmpty
        noteLabel.stringValue = note ?? ""
        noteLabel.isHidden = note == nil
        resetButton.isHidden = !row.isSetInScope
        resetButton.isEnabled = enabled
        if let checkbox {
            checkbox.state = row.value == .bool(true) ? .on : .off
            checkbox.isEnabled = enabled
        }
        if let popup {
            if case .string(let s) = row.value {
                if popup.itemTitles.contains(s) { popup.selectItem(withTitle: s) } else { popup.addItem(withTitle: s); popup.selectItem(withTitle: s) }
            }
            popup.isEnabled = enabled
        }
        if let field {
            field.isEnabled = enabled
            if row.control == .secret {
                field.placeholderString = secretIsSet(row) ? "Set (type to replace)" : "Not set"
                if field.currentEditor() == nil { field.stringValue = "" }
            } else if field.currentEditor() == nil {
                field.stringValue = settingText(row)
            }
        }
        if let textView {
            textView.isEditable = enabled
            if window?.firstResponder !== textView { textView.string = settingText(row) }
        }
    }

    func show(error: String?) {
        errorLabel.stringValue = error ?? ""
        errorLabel.isHidden = error == nil
    }

    func apply(_ t: Theme) {
        title.textColor = t.color(\.text)
        caption.textColor = t.color(\.faint)
        descriptionLabel.textColor = t.color(\.muted)
        noteLabel.textColor = t.color(\.muted)
        errorLabel.textColor = t.color(\.red)
        separator.color = t.color(\.border)
        textView?.textColor = t.color(\.text)
        textView?.backgroundColor = t.color(\.raised)
        textView?.insertionPointColor = t.color(\.text)
    }

    // MARK: changes

    @objc private func checkboxClicked() {
        show(error: nil)
        onChange(.bool(checkbox?.state == .on))
    }

    @objc private func popupChosen() {
        guard let value = popup?.titleOfSelectedItem else { return }
        show(error: nil)
        onChange(.string(value))
    }

    @objc private func resetClicked() {
        show(error: nil)
        // drop what is being typed: the reset value replaces it
        if isEditing { window?.makeFirstResponder(nil) }
        secretEdited = false
        onReset()
    }

    func controlTextDidChange(_ obj: Notification) {
        if row.control == .secret { secretEdited = true }
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        guard let field else { return }
        if row.control == .secret {
            let change = secretChange(typed: field.stringValue, edited: secretEdited)
            secretEdited = false
            field.stringValue = ""
            if let change {
                show(error: nil)
                onChange(change)
            }
            return
        }
        commit(text: field.stringValue)
    }

    func textDidEndEditing(_ notification: Notification) {
        commit(text: textView?.string ?? "")
    }

    private func commit(text: String) {
        guard text != settingText(row) else { show(error: nil); return }
        switch settingValue(from: text, for: row.control) {
        case .success(let value):
            show(error: nil)
            onChange(value)
        case .failure(.notANumber):
            show(error: "Not a number")
        case .failure(.notJSON):
            show(error: "Not valid JSON")
        }
    }
}
