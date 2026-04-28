/**
 * Tracks per-execution timeouts. Centralized so we can clear all pending
 * timers when the machine is detached (avoids open-handle leaks in tests and
 * graceful-shutdown scenarios).
 */
export class TimeoutRegistry {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  /**
   * Schedule (or replace) a timeout for the given execution. Calling this
   * twice for the same id cancels the previous timer.
   */
  schedule(executionId: string, ms: number, callback: () => void): void {
    this.cancel(executionId);
    const timer = setTimeout(() => {
      this.timers.delete(executionId);
      try {
        callback();
      } catch {
        // The callback is responsible for its own error handling — we swallow
        // here so an uncaught exception doesn't crash the host process.
      }
    }, ms);
    // Don't keep the event loop alive just because of a pending flow timeout.
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(executionId, timer);
  }

  cancel(executionId: string): void {
    const existing = this.timers.get(executionId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(executionId);
    }
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  size(): number {
    return this.timers.size;
  }
}
