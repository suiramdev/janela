import JanelaClient
import JanelaCore
import JanelaDesign
import JanelaTerminalUI
import SwiftUI

/// The main window: projects and sessions on the left, terminals on the right.
///
/// ## Structure
///
/// ```
/// ┌──────────────────┬────────────────────────────┐
/// │ ▸ scratch        │ ▸ agent  server  shell  +  │
/// │                  ├────────────────────────────┤
/// │ ▼ janela         │                │           │
/// │    • main        │    terminal    │ terminal  │
/// │    • fix/pty ●   │                │           │
/// │ ▸ api            │                │           │
/// └──────────────────┴────────────────────────────┘
///   projects collapse    tabs, then splits
///   sessions are buttons
/// ```
///
/// That is the entire application. There is no inspector, no bottom panel, no
/// activity bar, and adding one should require an argument that survives
/// docs/product.md § Non-goals.
///
/// ## What this view is looking at
///
/// A **mirror**. The sessions below live in `janelad`; these stores hold the last
/// state it sent. When the connection drops, the mirror is still rendered — marked
/// stale — because the terminals themselves are unaffected and the user's work is
/// still running. See docs/decisions/0015-daemon-owned-sessions.md.
public struct MainWindow: View {

    @Environment(ProjectStore.self) private var projects
    @Environment(SessionStore.self) private var sessions
    @Environment(DaemonConnection.self) private var connection

    public init() {}

    public var body: some View {
        @Bindable var sessions = sessions

        NavigationSplitView {
            Sidebar(selection: $sessions.selection)
                .navigationSplitViewColumnWidth(
                    min: Metrics.sidebarMinimumWidth,
                    ideal: Metrics.sidebarIdealWidth,
                    max: Metrics.sidebarMaximumWidth
                )
        } detail: {
            if let selection = sessions.selection {
                SessionDetail(sessionID: selection)
            } else {
                // An empty state that does one job: get you into a session.
                // Not a dashboard, not recent activity, not tips.
                ContentUnavailableView {
                    Label("No Session", systemImage: "square.split.2x1")
                } description: {
                    Text("Open a folder, or add a project to work on a branch.")
                } actions: {
                    Button("Open Folder…") {}
                        .buttonStyle(.borderedProminent)
                    Button("Add Project…") {}
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ConnectionBanner(status: connection.status)
        }
    }
}

/// Two levels, and never a third: standalone sessions, then collapsible projects
/// with their sessions inside.
///
/// Deliberately a `List` of buttons rather than an `OutlineGroup` over a recursive
/// type. The shape is fixed at two levels by
/// docs/decisions/0009-projects-sessions-terminals.md, and a recursive view would
/// quietly permit the thing that ADR forbids.
struct Sidebar: View {
    @Binding var selection: SessionID?

    var body: some View {
        // TODO: standalone sessions in an unlabelled top section, then one
        // DisclosureGroup per project bound to `Project.isExpanded`. Expanding must
        // not trigger any work — see docs/performance.md § Interaction.
        //
        // Session rows show status derived from `SessionStore.terminalStates`, which
        // is what the daemon reported. Never infer it locally.
        List(selection: $selection) {
            EmptyView()
        }
    }
}

/// Tab strip, split view, and the focused terminal.
struct SessionDetail: View {
    let sessionID: SessionID

    var body: some View {
        // TODO: tab strip over `session.layout.tabs`, then a recursive pane view
        // over `SessionLayout.Pane` with draggable dividers, then a TerminalSurface
        // per pane. Attaching a pane sends `attach`; the daemon replies with a full
        // repaint, so there is no separate "load scrollback" step.
        //
        // Divider drags must coalesce resizes — docs/performance.md § Rules of thumb.
        EmptyView()
    }
}

/// Shown only when the daemon is not answering.
///
/// Deliberately an inset rather than a modal: the user's terminals are still
/// running and their state is still on screen, so blocking the window would be a
/// lie about how bad the situation is.
struct ConnectionBanner: View {
    let status: DaemonConnection.Status

    var body: some View {
        switch status {
        case .connected, .idle:
            EmptyView()

        case .connecting, .reconnecting:
            // TODO: a thin, quiet strip. Reconnecting is routine and usually
            // resolves within a frame or two of the daemon restarting.
            EmptyView()

        case .refused:
            // TODO: the version-skew case, which needs a sentence and a button.
            // It must say what is still running and that restarting will close it,
            // then let the user choose. Never restart the daemon automatically —
            // docs/decisions/0017-daemon-lifecycle.md § Version skew and upgrades.
            EmptyView()
        }
    }
}
