import Foundation
import Testing

@testable import JanelaCore

/// These tests pin down the product rule that worktrees are *provenance*, not a
/// separate kind of thing. If someone later adds a `Session.isWorktree` flag or
/// splits `Session` into two types, these fail — which is the point.
@Suite("Session backing")
struct SessionBackingTests {

    private func session(
        backing: Session.Backing,
        projectID: ProjectID? = nil
    ) -> Session {
        Session(
            projectID: projectID,
            name: "test",
            directory: URL(filePath: "/tmp/test"),
            backing: backing
        )
    }

    private func binding(ownership: WorktreeBinding.Ownership) -> WorktreeBinding {
        WorktreeBinding(
            branch: "feature/x",
            path: URL(filePath: "/tmp/wt"),
            ownership: ownership
        )
    }

    @Test("A standalone session has no project and no worktree")
    func standaloneFolder() {
        let subject = session(backing: .folder)
        #expect(subject.worktree == nil)
        #expect(subject.projectID == nil)
        #expect(subject.isStandalone)
        #expect(subject.ownsItsDirectory == false)
    }

    @Test("A simple session belongs to a project but never owns its directory")
    func projectDirectory() {
        let project = ProjectID()
        let subject = session(backing: .projectDirectory, projectID: project)
        #expect(subject.worktree == nil)
        #expect(subject.projectID == project)
        #expect(subject.isStandalone == false)
        // The project directory is the user's own checkout. Offering to delete it
        // would be catastrophic, and no code path may ever reach that offer.
        #expect(subject.ownsItsDirectory == false)
    }

    @Test("Both worktree ownerships expose their binding uniformly")
    func worktreeBindingIsUniform() {
        for ownership in [WorktreeBinding.Ownership.managed, .adopted] {
            let value = binding(ownership: ownership)
            let subject = session(backing: .worktree(value), projectID: ProjectID())
            #expect(subject.worktree == value)
            #expect(subject.worktree?.branch == "feature/x")
        }
    }

    @Test("Only Janela-created worktrees may be deleted from disk")
    func onlyManagedWorktreesAreOwned() {
        let project = ProjectID()

        #expect(
            session(backing: .worktree(binding(ownership: .managed)), projectID: project)
                .ownsItsDirectory)
        // An adopted worktree existed before us. Deleting it would be destroying
        // something we did not create.
        #expect(
            session(backing: .worktree(binding(ownership: .adopted)), projectID: project)
                .ownsItsDirectory == false)
        #expect(session(backing: .projectDirectory, projectID: project).ownsItsDirectory == false)
        #expect(session(backing: .folder).ownsItsDirectory == false)
    }

    @Test("A worktree records what .worktreeinclude copied, so deletion can name it")
    func includedPathsSurviveOnTheBinding() {
        var value = binding(ownership: .managed)
        value.includedPaths = [".env", "node_modules/"]

        let subject = session(backing: .worktree(value), projectID: ProjectID())

        // Recorded at creation rather than recomputed at deletion: the patterns may
        // have changed since, and an `.env` that exists nowhere else is not
        // recoverable from git.
        #expect(subject.worktree?.includedPaths == [".env", "node_modules/"])
    }
}

@Suite("Terminal state")
struct TerminalStateTests {

    @Test("Only running and attention-seeking terminals are live")
    func liveness() {
        #expect(TerminalState.running.isLive)
        #expect(TerminalState.needsAttention.isLive)
        #expect(TerminalState.idle.isLive == false)
        #expect(TerminalState.exited(code: 0).isLive == false)
        #expect(TerminalState.failed(message: "nope").isLive == false)
    }

    @Test("An automation terminal is distinguishable from one the user asked for")
    func automationRole() {
        #expect(TerminalRole.automation(.worktreeCreated).isAutomation)
        #expect(TerminalRole.user.isAutomation == false)
    }
}

@Suite("Session layout")
struct SessionLayoutTests {

    @Test("A new session's layout is one tab holding one terminal")
    func singleTerminal() {
        let terminal = TerminalID()
        let layout = SessionLayout(singleTerminal: terminal)

        #expect(layout.tabs.count == 1)
        #expect(layout.terminalIDs == [terminal])
        #expect(layout.focusedTab?.focusedTerminalID == terminal)
        #expect(layout.tabs[0].root.depth == 1)
    }

    @Test("A focused tab index out of range is clamped rather than trusted")
    func focusIsClamped() {
        let terminal = TerminalID()
        let tab = SessionLayout.Tab(root: .terminal(terminal), focusedTerminalID: terminal)

        // A persisted layout is a file we could in principle be handed in a bad
        // state. Clamping means opening the session always works.
        #expect(SessionLayout(tabs: [tab], focusedTabIndex: 7).focusedTabIndex == 0)
        #expect(SessionLayout(tabs: [tab], focusedTabIndex: -1).focusedTabIndex == 0)
        #expect(SessionLayout(tabs: [], focusedTabIndex: 3).focusedTab == nil)
    }

    @Test("A split tree reports every terminal it holds, left to right")
    func terminalsInTreeOrder() {
        let left = TerminalID()
        let topRight = TerminalID()
        let bottomRight = TerminalID()

        let root = SessionLayout.Pane.split(
            axis: .horizontal,
            fraction: 0.5,
            first: .terminal(left),
            second: .split(
                axis: .vertical,
                fraction: 0.5,
                first: .terminal(topRight),
                second: .terminal(bottomRight)
            )
        )

        #expect(root.terminalIDs == [left, topRight, bottomRight])
        #expect(root.depth == 3)
    }

    @Test("A layout round-trips through Codable with its tree intact")
    func codableRoundTrip() throws {
        let first = TerminalID()
        let second = TerminalID()
        let layout = SessionLayout(
            tabs: [
                SessionLayout.Tab(
                    title: "build",
                    root: .split(
                        axis: .horizontal, fraction: 0.6,
                        first: .terminal(first), second: .terminal(second)),
                    focusedTerminalID: second
                )
            ],
            focusedTabIndex: 0
        )

        let data = try JSONEncoder().encode(layout)
        let decoded = try JSONDecoder().decode(SessionLayout.self, from: data)

        // A layout that survives the algebra but not the database is still a bug
        // the user sees, on relaunch, having lost their arrangement.
        #expect(decoded == layout)
        #expect(decoded.terminalIDs == [first, second])
    }
}
