import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { MemoryAdapter } from "../src/adapters/MemoryAdapter.js";
import type { FlowSnapshot } from "../src/types.js";

function makeSnapshot(
  overrides: Partial<FlowSnapshot<{ x: number }>> = {},
): FlowSnapshot<{ x: number }> {
  return {
    executionId: "exec-1",
    flowId: "flow",
    state: "start",
    data: { x: 1 },
    history: [],
    userId: "user-1",
    channelId: null,
    guildId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    meta: {},
    ...overrides,
  };
}

describe("MemoryAdapter", () => {
  it("stores and retrieves snapshots", async () => {
    const adapter = new MemoryAdapter();
    const snap = makeSnapshot();
    await adapter.set(snap);
    const got = await adapter.get<{ x: number }>(snap.executionId);
    expect(got).toEqual(snap);
  });

  it("returns null for missing entries", async () => {
    const adapter = new MemoryAdapter();
    expect(await adapter.get("missing")).toBeNull();
  });

  it("returns deep clones (caller mutation does not affect store)", async () => {
    const adapter = new MemoryAdapter();
    const snap = makeSnapshot();
    await adapter.set(snap);

    const got = await adapter.get<{ x: number }>(snap.executionId);
    if (!got) throw new Error("expected snapshot");
    got.data.x = 999;

    const reread = await adapter.get<{ x: number }>(snap.executionId);
    expect(reread?.data.x).toBe(1);
  });

  it("evicts entries past their TTL", async () => {
    vi.useFakeTimers();
    const adapter = new MemoryAdapter({ ttlMs: 1000 });
    await adapter.set(makeSnapshot());
    vi.advanceTimersByTime(2000);
    expect(await adapter.get("exec-1")).toBeNull();
    expect(adapter.size()).toBe(0);
  });

  it("delete removes entries", async () => {
    const adapter = new MemoryAdapter();
    await adapter.set(makeSnapshot());
    await adapter.delete("exec-1");
    expect(await adapter.get("exec-1")).toBeNull();
  });

  it("list returns all execution ids", async () => {
    const adapter = new MemoryAdapter();
    await adapter.set(makeSnapshot({ executionId: "a" }));
    await adapter.set(makeSnapshot({ executionId: "b" }));
    expect((await adapter.list()).sort()).toEqual(["a", "b"]);
  });

  it("close clears the store", async () => {
    const adapter = new MemoryAdapter();
    await adapter.set(makeSnapshot());
    await adapter.close();
    expect(adapter.size()).toBe(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useRealTimers();
  });
});
