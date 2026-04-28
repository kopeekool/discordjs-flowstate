import type { FlowSnapshot, StorageAdapter } from "../types.js";

/**
 * In-memory {@link StorageAdapter} suitable for tests and single-process bots.
 *
 * Snapshots are deep-cloned on read and write so callers can safely mutate the
 * objects they receive without corrupting the stored state. Optionally accepts
 * a TTL — entries older than the TTL are evicted on access.
 */
export class MemoryAdapter implements StorageAdapter {
  private readonly store = new Map<string, FlowSnapshot<unknown>>();
  private readonly ttlMs: number | null;

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? null;
  }

  async get<TContext>(
    executionId: string,
  ): Promise<FlowSnapshot<TContext> | null> {
    const snapshot = this.store.get(executionId) as
      | FlowSnapshot<TContext>
      | undefined;
    if (!snapshot) return null;
    if (this.ttlMs !== null && Date.now() - snapshot.updatedAt > this.ttlMs) {
      this.store.delete(executionId);
      return null;
    }
    return clone(snapshot);
  }

  async set<TContext>(snapshot: FlowSnapshot<TContext>): Promise<void> {
    this.store.set(snapshot.executionId, clone(snapshot));
  }

  async delete(executionId: string): Promise<void> {
    this.store.delete(executionId);
  }

  async list(): Promise<string[]> {
    return Array.from(this.store.keys());
  }

  async close(): Promise<void> {
    this.store.clear();
  }

  /** Test-only helper — total entries currently retained (including stale). */
  size(): number {
    return this.store.size;
  }
}

/**
 * Deep clone via structuredClone with a JSON fallback for very old runtimes.
 * The library targets Node ≥ 18 where structuredClone is always available; the
 * fallback exists purely for defensive embedding contexts (e.g. older
 * testing harnesses).
 */
function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
