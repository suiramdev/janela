import SwiftUI

/// Menu bar commands and their key equivalents.
///
/// ## Principle
///
/// Every shortcut here must be one a terminal user will not miss. The terminal
/// owns the keyboard: Ctrl-anything belongs to the running program, and ⌘K, ⌘L,
/// ⌘D and friends are contested. We take the small set macOS users expect from a
/// document app and leave the rest alone.
///
/// This is also why splits and tabs are `⌘`-based and never `Ctrl`-based: `Ctrl-b`
/// and `Ctrl-a` belong to tmux and screen, and a user running either inside Janela
/// must not have to think about which layer ate their keystroke. See
/// docs/decisions/0010-terminal-layout.md.
///
/// Anything the user can do here must also be reachable without the mouse, and
/// anything reachable only through a menu is a feature we have half-shipped.
struct JanelaCommands: Commands {

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Session") {}
                .keyboardShortcut("n", modifiers: .command)

            Button("New Terminal") {}
                .keyboardShortcut("t", modifiers: .command)

            Divider()

            Button("Open Folder…") {}
                .keyboardShortcut("o", modifiers: .command)

            Button("Add Project…") {}
                .keyboardShortcut("o", modifiers: [.command, .option])
        }

        CommandMenu("Session") {
            // ⌘⇧O is the one shortcut worth spending: it is how you get anywhere
            // without touching the sidebar, and it is the app's fastest path.
            Button("Go to Session…") {}
                .keyboardShortcut("o", modifiers: [.command, .shift])

            Button("New Branch Session…") {}
                .keyboardShortcut("b", modifiers: [.command, .shift])

            Divider()

            Button("Next Session") {}
                .keyboardShortcut("]", modifiers: [.command, .shift])
            Button("Previous Session") {}
                .keyboardShortcut("[", modifiers: [.command, .shift])

            Divider()

            Button("Reveal in Finder") {}
            Button("Open in Terminal") {}
        }

        CommandMenu("Terminal") {
            Button("Split Right") {}
                .keyboardShortcut("d", modifiers: .command)
            Button("Split Down") {}
                .keyboardShortcut("d", modifiers: [.command, .shift])

            Divider()

            // ⌘⌥arrow moves focus between panes. Plain arrows, and anything with
            // Ctrl, belong to the program running in the terminal.
            Button("Focus Pane Left") {}
                .keyboardShortcut(.leftArrow, modifiers: [.command, .option])
            Button("Focus Pane Right") {}
                .keyboardShortcut(.rightArrow, modifiers: [.command, .option])
            Button("Focus Pane Up") {}
                .keyboardShortcut(.upArrow, modifiers: [.command, .option])
            Button("Focus Pane Down") {}
                .keyboardShortcut(.downArrow, modifiers: [.command, .option])

            Divider()

            Button("Restart Terminal") {}
                .keyboardShortcut("r", modifiers: [.command, .shift])
            Button("Clear Scrollback") {}
                .keyboardShortcut("k", modifiers: [.command, .shift])
        }
    }
}

/// Settings. One window, four tabs, and a strong bias against growing a fifth.
///
/// Note there is no "Projects" tab: a project's settings belong to that project
/// and are edited from its row in the sidebar, not in a global list. Automation
/// commands in particular are per-project by design — see
/// docs/decisions/0014-project-automation.md.
struct SettingsWindow: View {
    var body: some View {
        TabView {
            Tab("General", systemImage: "gearshape") { EmptyView() }
            Tab("Terminal", systemImage: "terminal") { EmptyView() }
            Tab("Profiles", systemImage: "sparkles") { EmptyView() }
            Tab("Notifications", systemImage: "bell") { EmptyView() }
        }
        .frame(width: 520, height: 380)
    }
}
