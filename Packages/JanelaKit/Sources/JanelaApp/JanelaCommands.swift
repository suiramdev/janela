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
/// Anything the user can do here must also be reachable without the mouse, and
/// anything reachable only through a menu is a feature we have half-shipped.
struct JanelaCommands: Commands {

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Workspace…") {}
                .keyboardShortcut("n", modifiers: .command)

            Button("New Session") {}
                .keyboardShortcut("t", modifiers: .command)

            Divider()

            Button("Open Folder…") {}
                .keyboardShortcut("o", modifiers: .command)
        }

        CommandMenu("Workspace") {
            // ⌘⇧O is the one shortcut worth spending: it is how you get anywhere
            // without touching the sidebar, and it is the app's fastest path.
            Button("Go to Workspace…") {}
                .keyboardShortcut("o", modifiers: [.command, .shift])

            Button("New Branch Workspace…") {}
                .keyboardShortcut("b", modifiers: [.command, .shift])

            Divider()

            Button("Reveal in Finder") {}
            Button("Open in Terminal") {}
        }

        CommandMenu("Session") {
            Button("Restart Session") {}
                .keyboardShortcut("r", modifiers: [.command, .shift])
            Button("Clear Scrollback") {}
                .keyboardShortcut("k", modifiers: [.command, .shift])

            Divider()

            Button("Next Session") {}
                .keyboardShortcut("]", modifiers: [.command, .shift])
            Button("Previous Session") {}
                .keyboardShortcut("[", modifiers: [.command, .shift])
        }
    }
}

/// Settings. One window, three tabs, and a strong bias against growing a fourth.
struct SettingsWindow: View {
    var body: some View {
        TabView {
            Tab("General", systemImage: "gearshape") { EmptyView() }
            Tab("Terminal", systemImage: "terminal") { EmptyView() }
            Tab("Profiles", systemImage: "sparkles") { EmptyView() }
        }
        .frame(width: 520, height: 380)
    }
}
