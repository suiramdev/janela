import JanelaCore
import JanelaDesign
import JanelaTerminal
import JanelaWorkspace
import SwiftUI

/// The main window: workspaces on the left, terminals on the right.
///
/// ## Structure
///
/// ```
/// ┌────────────┬──────────────────────────────┐
/// │ Workspaces │ ▸ tab  tab  tab           +  │
/// │  • janela  ├──────────────────────────────┤
/// │  • api ●   │                              │
/// │  • docs    │        terminal              │
/// │            │                              │
/// └────────────┴──────────────────────────────┘
/// ```
///
/// That is the entire application. There is no inspector, no bottom panel, no
/// activity bar, and adding one should require an argument that survives
/// docs/product.md § Non-goals.
public struct WorkspaceWindow: View {

    @Environment(WorkspaceStore.self) private var store
    @Environment(SessionRegistry.self) private var sessions

    public init() {}

    public var body: some View {
        @Bindable var store = store

        NavigationSplitView {
            WorkspaceSidebar(selection: $store.selection)
                .navigationSplitViewColumnWidth(
                    min: Metrics.sidebarMinimumWidth,
                    ideal: Metrics.sidebarIdealWidth,
                    max: Metrics.sidebarMaximumWidth
                )
        } detail: {
            if let selection = store.selection {
                WorkspaceDetail(workspaceID: selection)
            } else {
                // An empty state that does one job: get you into a workspace.
                // Not a dashboard, not recent activity, not tips.
                ContentUnavailableView {
                    Label("No Workspace", systemImage: "square.split.2x1")
                } description: {
                    Text("Open a folder or repository to get started.")
                } actions: {
                    Button("Open Folder…") {}
                        .buttonStyle(.borderedProminent)
                }
            }
        }
    }
}

/// The workspace list. Flat, searchable, keyboard-navigable.
struct WorkspaceSidebar: View {
    @Binding var selection: WorkspaceID?

    var body: some View {
        // TODO: List of workspaces grouped only by pinned/unpinned.
        // Deliberately not a tree — see docs/product.md.
        List(selection: $selection) {
            EmptyView()
        }
    }
}

/// Tab strip plus the focused terminal.
struct WorkspaceDetail: View {
    let workspaceID: WorkspaceID

    var body: some View {
        // TODO: SessionTabStrip + TerminalView for the focused session.
        EmptyView()
    }
}
