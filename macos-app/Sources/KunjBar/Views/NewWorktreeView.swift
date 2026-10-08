// "New Worktree" window: check out an existing branch or create a new one
// (from the repo default, fetched from origin, unless told otherwise), then
// optionally open it in the editor.

import SwiftUI

struct NewWorktreeView: View {
    let repoRoot: String
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    enum Mode: String, CaseIterable { case new = "New branch", existing = "Existing branch" }

    @State private var mode: Mode = .new
    @State private var branches: [BranchListResult.Branch] = []
    @State private var loadingBranches = true
    @State private var newBranch = ""
    @State private var existingBranch = ""
    @State private var base = ""
    @State private var fromOrigin = true
    @State private var customPath = ""
    @State private var working = false
    @State private var error: String?
    @State private var created: AddWorktreeResult.Created?
    // What the CLI printed while creating (progress, git and hook output)
    @State private var output = ""

    private var repoState: RepoState? { store.repos.first { $0.repo.root == repoRoot } }
    private var repoName: String { repoState?.repo.name ?? (repoRoot as NSString).lastPathComponent }

    // Branches that are not already checked out in a worktree
    private var availableBranches: [BranchListResult.Branch] {
        let checkedOut = Set(repoState?.worktrees.compactMap(\.branch) ?? [])
        return branches.filter { !checkedOut.contains($0.name) }
    }

    private var branchName: String {
        (mode == .new ? newBranch : existingBranch).trimmingCharacters(in: .whitespaces)
    }

    var body: some View {
        Group {
            if let created {
                createdView(created)
            } else {
                form
            }
        }
        .padding(20)
        .frame(width: 460)
        .task { await loadBranches() }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("New worktree in \(repoName)").font(.title3.weight(.semibold))

            Picker("", selection: $mode) {
                ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            Form {
                if mode == .new {
                    TextField("Branch name", text: $newBranch, prompt: Text("feature/my-change"))
                    Picker("Base", selection: $base) {
                        Text("Repository default").tag("")
                        ForEach(branches, id: \.name) { Text($0.name).tag($0.name) }
                    }
                    Toggle("Fetch the base from origin", isOn: $fromOrigin)
                } else {
                    Picker("Branch", selection: $existingBranch) {
                        if availableBranches.isEmpty {
                            Text(loadingBranches ? "Loading…" : "No branches without a worktree").tag("")
                        }
                        ForEach(availableBranches, id: \.name) { branch in
                            Text(branch.lastActivity.map { "\(branch.name)  (\($0))" } ?? branch.name).tag(branch.name)
                        }
                    }
                }
                TextField("Folder", text: $customPath, prompt: Text("Default location"))
            }
            .formStyle(.columns)

            if working || !output.isEmpty {
                OutputView(text: output)
            }

            if let error {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                if working { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Create") { Task { await create() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(branchName.isEmpty || working)
            }
        }
    }

    private func createdView(_ created: AddWorktreeResult.Created) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Worktree created", systemImage: "checkmark.circle.fill")
                .font(.title3.weight(.semibold))
                .foregroundStyle(.green)
            Text(created.path)
                .font(.callout.monospaced())
                .textSelection(.enabled)
            if !output.isEmpty {
                OutputView(text: output)
            }
            HStack {
                Button("Open Terminal") {
                    Launcher.openTerminal(at: created.path)
                    dismiss()
                }
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Open in Editor") {
                    if let repo = repoState?.repo, let wt = repoState?.worktrees.first(where: { $0.path == created.path }) {
                        store.open(wt, in: repo)
                    } else {
                        Task { try? await store.cli.openWorktree(repo: repoRoot, worktreePath: created.path, newWindow: false) }
                    }
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
    }

    private func loadBranches() async {
        loadingBranches = true
        defer { loadingBranches = false }
        do {
            branches = try await store.cli.listBranches(repo: repoRoot)
            if existingBranch.isEmpty { existingBranch = availableBranches.first?.name ?? "" }
        } catch {
            self.error = "Could not list branches: \(error.localizedDescription)"
        }
    }

    private func create() async {
        working = true
        error = nil
        output = "$ kunj worktree add \(branchName)\n"
        defer { working = false }
        do {
            let result = try await store.cli.addWorktree(
                repo: repoRoot,
                branch: branchName,
                path: customPath.trimmingCharacters(in: .whitespaces),
                newBranch: mode == .new,
                base: mode == .new ? base : nil,
                fromOrigin: fromOrigin,
                onOutput: { chunk in Task { @MainActor in output += chunk } }
            )
            created = result.worktree
            store.refresh()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// A terminal-like box that shows CLI output and follows it as it grows
struct OutputView: View {
    let text: String

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(text.isEmpty ? " " : text)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(Color(white: 0.9))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                Color.clear.frame(height: 1).id("end")
            }
            .frame(height: 140)
            .background(Color.black.opacity(0.85), in: RoundedRectangle(cornerRadius: 6))
            .onChange(of: text) { proxy.scrollTo("end", anchor: .bottom) }
        }
    }
}
