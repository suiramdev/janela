import type { Logger } from "@janela/support";

/**
 * The default when a caller injects no logger.
 *
 * Discarding is the right default for the same reason `nullLogSink` is: a library
 * that logs during import must not decide the format for a process that has not
 * asked for one. Internal on purpose — the composition root injects the real one.
 */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  notice: () => {},
  warning: () => {},
  error: () => {},
};
