import type { Frame } from "./frame.ts";

export interface MessageTransport {
  incoming(): AsyncIterable<Frame>;

  send(frame: Frame): Promise<void>;

  close(): Promise<void>;
}
