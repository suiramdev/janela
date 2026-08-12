import Foundation
import Testing

@testable import JanelaCore

/// These tests pin down the product rule that worktrees are *provenance*, not a
/// separate kind of thing. If someone later adds a `Workspace.isWorktree` flag or
/// splits `Workspace` into two types, these fail — which is the point.
@Suite("Workspace origin")
struct WorkspaceOriginTests {

    private func workspace(origin: Workspace.Origin) -> Workspace {
        Workspace(name: "test", directory: URL(filePath: "/tmp/test"), origin: origin)
    }

    @Test("A plain folder has no repository and no worktree")
    func plainFolder() {
        let subject = workspace(origin: .folder)
        #expect(subject.worktree == nil)
        #expect(subject.repositoryID == nil)
        #expect(subject.ownsItsDirectory == false)
    }

    @Test("Both worktree flavours expose their binding uniformly")
    func worktreeBindingIsUniform() {
        let repository = RepositoryID()
        let binding = WorktreeBinding(
            repositoryID: repository,
            branch: "feature/x",
            path: URL(filePath: "/tmp/wt")
        )

        for origin in [Workspace.Origin.managedWorktree(binding), .adoptedWorktree(binding)] {
            let subject = workspace(origin: origin)
            #expect(subject.worktree == binding)
            #expect(subject.repositoryID == repository)
        }
    }

    @Test("Only Janela-created worktrees may be deleted from disk")
    func onlyManagedWorktreesAreOwned() {
        let binding = WorktreeBinding(
            repositoryID: RepositoryID(),
            branch: "main",
            path: URL(filePath: "/tmp/wt")
        )

        #expect(workspace(origin: .managedWorktree(binding)).ownsItsDirectory)
        // An adopted worktree existed before us. Deleting it would be destroying
        // something we did not create.
        #expect(workspace(origin: .adoptedWorktree(binding)).ownsItsDirectory == false)
        #expect(workspace(origin: .folder).ownsItsDirectory == false)
    }
}

@Suite("Session state")
struct SessionStateTests {

    @Test("Only running and attention-seeking sessions are live")
    func liveness() {
        #expect(SessionState.running.isLive)
        #expect(SessionState.needsAttention.isLive)
        #expect(SessionState.idle.isLive == false)
        #expect(SessionState.exited(code: 0).isLive == false)
        #expect(SessionState.failed(message: "nope").isLive == false)
    }
}
