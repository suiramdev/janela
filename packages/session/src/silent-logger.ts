import type { Logger } from "@janela/support";

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  notice: () => {},
  warning: () => {},
  error: () => {},
};
