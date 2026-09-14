import { log } from "@janela/support";
import type { Clipboard } from "@janela/ui";

/**
 * The desktop's half of `Clipboard`, on the web platform's own API.
 *
 * No Tauri plugin: `navigator.clipboard` is available to a WKWebView in a secure
 * context, which `tauri://` is, and a clipboard plugin would put the user's
 * copied text through a Rust command for nothing.
 *
 * Writing is allowed from a user gesture, which every call here is — a click on
 * a menu row. Reading is the one that can be refused, and WebKit is the engine
 * that refuses: a rejection answers `undefined`, so the terminal receives
 * nothing rather than a dialog.
 *
 * **Never logged: the text.** Both directions carry whatever the user copied —
 * a password out of a password manager as easily as a path — so the log records
 * that a read failed and how much text a write carried, never the text itself
 * (AGENTS.md § Non-negotiables 11).
 */
export function browserClipboard(): Clipboard {
  const clipboardLog = log("app");

  return {
    async copy(text: string): Promise<void> {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        clipboardLog.warning("clipboard write refused", { length: text.length });
      }
    },

    async paste(): Promise<string | undefined> {
      try {
        const text = await navigator.clipboard.readText();
        return text === "" ? undefined : text;
      } catch {
        clipboardLog.warning("clipboard read refused");
        return undefined;
      }
    },
  };
}
