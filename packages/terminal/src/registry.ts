import type { SessionID, TerminalID } from "@janela/core";

import type { LiveTerminal } from "./live-terminal.ts";

export interface TerminalRegistry {
  get(id: TerminalID): LiveTerminal | undefined;
  register(terminal: LiveTerminal): void;
  remove(id: TerminalID): void;
  inSession(id: SessionID): readonly LiveTerminal[];
  readonly liveCount: number;
  hangUpAll(): Promise<void>;
}

export function createTerminalRegistry(): TerminalRegistry {
  return new MapTerminalRegistry();
}

class MapTerminalRegistry implements TerminalRegistry {
  private readonly terminals = new Map<TerminalID, LiveTerminal>();

  get(id: TerminalID): LiveTerminal | undefined {
    return this.terminals.get(id);
  }

  register(terminal: LiveTerminal): void {
    if (this.terminals.has(terminal.id)) {
      throw new Error(`terminal ${terminal.id} is already registered`);
    }

    this.terminals.set(terminal.id, terminal);
  }

  remove(id: TerminalID): void {
    this.terminals.delete(id);
  }

  inSession(id: SessionID): readonly LiveTerminal[] {
    const found: LiveTerminal[] = [];

    for (const terminal of this.terminals.values()) {
      if (terminal.sessionID === id) {
        found.push(terminal);
      }
    }

    return found;
  }

  get liveCount(): number {
    let count = 0;

    for (const terminal of this.terminals.values()) {
      const { kind } = terminal.state;

      if (kind === "running" || kind === "needsAttention") {
        count += 1;
      }
    }

    return count;
  }

  async hangUpAll(): Promise<void> {
    await Promise.all([...this.terminals.values()].map((terminal) => terminal.stop()));
  }
}
