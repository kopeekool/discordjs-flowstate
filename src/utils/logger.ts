/* eslint-disable no-console */

/**
 * Tiny structured logger. Library code never calls `console.log` directly so
 * users can easily silence or redirect output by passing their own logger
 * (anything matching the {@link Logger} shape) into `new FlowMachine({ logger })`.
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Default logger emits to stderr with a `[flowstate]` prefix. Disabled at
 * `debug` level unless `DEBUG` env var contains `flowstate`.
 */
export const defaultLogger: Logger = {
  debug(message, meta) {
    if (!/\bflowstate\b/.test(process.env.DEBUG ?? "")) return;
    console.error(`[flowstate] DEBUG ${message}`, meta ?? "");
  },
  info(message, meta) {
    console.error(`[flowstate] INFO  ${message}`, meta ?? "");
  },
  warn(message, meta) {
    console.error(`[flowstate] WARN  ${message}`, meta ?? "");
  },
  error(message, meta) {
    console.error(`[flowstate] ERROR ${message}`, meta ?? "");
  },
};
