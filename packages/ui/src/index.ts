/**
 * `@janela/ui` — layer 8, client side. Views and presentation state.
 *
 * Note what is absent from its dependencies: git, PTY, the database, the emulator
 * and the brain are all daemon-side and are not linked here. **The client cannot
 * spawn a process** — the capability is not discouraged, it is not present.
 *
 * Reaches no further than `@janela/client`. A view that wants a fact the mirror does
 * not carry needs a protocol message, not a shortcut.
 */

// ---- The sidebar: the only navigation there is.
export * from "./app-sidebar.tsx";
export * from "./project-icon.tsx";
export * from "./sidebar-actions.ts";
export * from "./sidebar-filter.ts";
export * from "./command-dispatch.ts";
export * from "./context-menu-region.tsx";
export * from "./menu-rows.ts";
export * from "./command-palette.tsx";
export * from "./commands.ts";
export * from "./confirmation.ts";
export * from "./confirmation-dialog.tsx";
export * from "./connection-banner.tsx";
export * from "./fuzzy.ts";
export * from "./jump-list.tsx";
export * from "./layout-edits.ts";
export * from "./main-window.tsx";
export * from "./new-branch-sheet.tsx";
export * from "./new-session-sheet.tsx";
export * from "./find-surface.tsx";
export * from "./sheets.tsx";
export * from "./sidebar-model.ts";
export * from "./view-state.ts";
// The window's own shape, including where macOS draws its controls — which
// `apps/desktop` has to configure to match.
export * from "./window-chrome.tsx";

// ---- Launch profiles and the settings surface (#38).
export * from "./argv-editor.tsx";
export * from "./automation-editing.ts";
export * from "./background-service.ts";
export * from "./controls.tsx";
export * from "./global-settings.ts";
export * from "./profile-editing.ts";
export * from "./profile-icons.tsx";
export * from "./project-settings.tsx";
export * from "./settings-draft.ts";
export * from "./settings-general.tsx";
export * from "./settings-notifications.tsx";
export * from "./settings-profiles.tsx";
export * from "./settings-terminal.tsx";
export * from "./settings-window.tsx";
