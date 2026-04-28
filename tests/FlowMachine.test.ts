import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { FlowMachine } from "../src/FlowMachine.js";
import { MemoryAdapter } from "../src/adapters/MemoryAdapter.js";
import {
  ExecutionNotFoundError,
  GuardRejectedError,
  InvalidFlowDefinitionError,
} from "../src/errors.js";
import { FLOW_END, type FlowDefinition } from "../src/types.js";
import { noopLogger } from "../src/utils/logger.js";

// -- Test fixtures ----------------------------------------------------------

interface Ctx {
  count: number;
  name?: string;
}

function makeFlow(
  overrides: Partial<FlowDefinition<Ctx>> = {},
): FlowDefinition<Ctx> {
  return {
    id: "test-flow",
    initial: "start",
    initialData: () => ({ count: 0 }),
    states: {
      start: {
        render: () => "start render",
        on: {
          next: {
            to: "middle",
            action: (ctx) => {
              ctx.data.count += 1;
            },
          },
          end: FLOW_END,
        },
      },
      middle: {
        render: () => "middle render",
        on: {
          next: "end",
          back: "start",
        },
      },
      end: {
        render: () => "end render",
        on: {
          done: FLOW_END,
        },
      },
    },
    ...overrides,
  };
}

function fakeUser(id = "user-1") {
  return { id };
}

function fakeInteraction(opts: { user?: { id: string } } = {}) {
  const repliedFlag = { value: false };
  const interaction = {
    user: opts.user ?? fakeUser(),
    channelId: "channel-1",
    guildId: "guild-1",
    deferred: false,
    get replied() {
      return repliedFlag.value;
    },
    isMessageComponent: () => false,
    isStringSelectMenu: () => false,
    isButton: () => false,
    isRepliable: () => true,
    type: 2,
    reply: vi.fn(async () => {
      repliedFlag.value = true;
    }),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
  };
  return interaction;
}

// -- Tests ------------------------------------------------------------------

describe("FlowMachine: definition validation", () => {
  it("rejects missing id", () => {
    expect(
      () =>
        new FlowMachine({
          definition: { id: "", initial: "x", states: { x: { render: () => "" } } },
          logger: noopLogger,
        }),
    ).toThrow(InvalidFlowDefinitionError);
  });

  it("rejects ids containing the customId separator", () => {
    expect(
      () =>
        new FlowMachine({
          definition: {
            id: "bad|name",
            initial: "x",
            states: { x: { render: () => "" } },
          },
          logger: noopLogger,
        }),
    ).toThrow(/must not contain/);
  });

  it("rejects an initial state that does not exist", () => {
    expect(
      () =>
        new FlowMachine({
          definition: {
            id: "f",
            initial: "missing",
            states: { other: { render: () => "" } },
          },
          logger: noopLogger,
        }),
    ).toThrow(/initial state/);
  });

  it("rejects states without a render function", () => {
    expect(
      () =>
        new FlowMachine({
          definition: {
            id: "f",
            initial: "x",
            states: { x: { render: undefined as never } },
          },
          logger: noopLogger,
        }),
    ).toThrow(/render\(\) function/);
  });
});

describe("FlowMachine: lifecycle", () => {
  it("starts a flow and persists the initial state", async () => {
    const storage = new MemoryAdapter();
    const machine = new FlowMachine({
      definition: makeFlow(),
      storage,
      logger: noopLogger,
    });
    const interaction = fakeInteraction();

    const ctx = await machine.start(interaction as never);
    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(ctx.state).toBe("start");
    expect(ctx.data.count).toBe(0);
    const stored = await storage.get(ctx.executionId);
    expect(stored?.state).toBe("start");
  });

  it("transitions on dispatch and runs the action callback", async () => {
    const storage = new MemoryAdapter();
    const machine = new FlowMachine({
      definition: makeFlow(),
      storage,
      logger: noopLogger,
    });
    const interaction = fakeInteraction();
    const ctx = await machine.start(interaction as never);

    const result = await machine.dispatch(ctx.executionId, "next");
    expect(result?.state).toBe("middle");
    expect(result?.data.count).toBe(1);
    expect(result?.history).toEqual(["start"]);
  });

  it("FLOW_END terminates the flow and deletes storage", async () => {
    const storage = new MemoryAdapter();
    const onComplete = vi.fn();
    const machine = new FlowMachine({
      definition: makeFlow({ onComplete }),
      storage,
      logger: noopLogger,
    });
    const interaction = fakeInteraction();
    const ctx = await machine.start(interaction as never);

    await machine.dispatch(ctx.executionId, "end");
    expect(onComplete).toHaveBeenCalledOnce();
    expect(await storage.get(ctx.executionId)).toBeNull();
  });

  it("dispatch throws ExecutionNotFoundError for unknown executions", async () => {
    const machine = new FlowMachine({
      definition: makeFlow(),
      logger: noopLogger,
    });
    await expect(machine.dispatch("nope", "next")).rejects.toBeInstanceOf(
      ExecutionNotFoundError,
    );
  });

  it("emits start, transition, complete events", async () => {
    const machine = new FlowMachine({
      definition: makeFlow(),
      logger: noopLogger,
    });
    const seen: string[] = [];
    machine.on("start", () => seen.push("start"));
    machine.on("transition", (_ctx, from, to, trigger) =>
      seen.push(`transition:${from}->${to}:${trigger}`),
    );
    machine.on("complete", () => seen.push("complete"));

    const interaction = fakeInteraction();
    const ctx = await machine.start(interaction as never);
    await machine.dispatch(ctx.executionId, "next");
    await machine.dispatch(ctx.executionId, "next");
    await machine.dispatch(ctx.executionId, "done");

    expect(seen).toEqual([
      "start",
      "transition:start->middle:next",
      "transition:middle->end:next",
      "complete",
    ]);
  });
});

describe("FlowMachine: guards", () => {
  it("blocks transitions when guard returns false", async () => {
    const definition = makeFlow();
    definition.states["start"]!.on = {
      next: { to: "middle", guard: () => false },
    };
    const machine = new FlowMachine({ definition, logger: noopLogger });
    const interaction = fakeInteraction();
    const ctx = await machine.start(interaction as never);

    await expect(
      machine.dispatch(ctx.executionId, "next"),
    ).rejects.toBeInstanceOf(GuardRejectedError);
  });

  it("allows transitions when guard returns true", async () => {
    const definition = makeFlow();
    definition.states["start"]!.on = {
      next: { to: "middle", guard: async () => true },
    };
    const machine = new FlowMachine({ definition, logger: noopLogger });
    const interaction = fakeInteraction();
    const ctx = await machine.start(interaction as never);

    const result = await machine.dispatch(ctx.executionId, "next");
    expect(result?.state).toBe("middle");
  });
});

describe("FlowMachine: middleware", () => {
  it("runs middleware in order around transitions", async () => {
    const order: string[] = [];
    const machine = new FlowMachine({
      definition: makeFlow(),
      logger: noopLogger,
      middleware: [
        async (_ctx, next) => {
          order.push("a:before");
          await next();
          order.push("a:after");
        },
        async (_ctx, next) => {
          order.push("b:before");
          await next();
          order.push("b:after");
        },
      ],
    });
    const interaction = fakeInteraction();
    const ctx = await machine.start(interaction as never);
    await machine.dispatch(ctx.executionId, "next");
    expect(order).toEqual(["a:before", "b:before", "b:after", "a:after"]);
  });

  it("aborts the transition when middleware throws", async () => {
    const machine = new FlowMachine({
      definition: makeFlow(),
      logger: noopLogger,
      middleware: [
        async () => {
          throw new Error("nope");
        },
      ],
    });
    const interaction = fakeInteraction();
    const ctx = await machine.start(interaction as never);

    await expect(
      machine.dispatch(ctx.executionId, "next"),
    ).rejects.toThrow("nope");
  });
});

describe("FlowMachine: dynamic transitions", () => {
  it("supports computed `to` resolvers", async () => {
    const definition: FlowDefinition<Ctx> = {
      id: "dyn",
      initial: "a",
      initialData: () => ({ count: 5 }),
      states: {
        a: {
          render: () => "a",
          on: {
            go: {
              to: (ctx) => (ctx.data.count > 3 ? "high" : "low"),
            },
          },
        },
        high: { render: () => "high" },
        low: { render: () => "low" },
      },
    };
    const machine = new FlowMachine({ definition, logger: noopLogger });
    const interaction = fakeInteraction();
    const ctx = await machine.start(interaction as never);
    const out = await machine.dispatch(ctx.executionId, "go");
    expect(out?.state).toBe("high");
  });
});

describe("FlowMachine: timeouts", () => {
  it("fires the timeout trigger after the configured ms", async () => {
    vi.useFakeTimers();
    const definition: FlowDefinition<Ctx> = {
      id: "to",
      initial: "wait",
      initialData: () => ({ count: 0 }),
      states: {
        wait: {
          render: () => "waiting",
          timeoutMs: 500,
          on: { timeout: "expired" },
        },
        expired: {
          render: () => "expired",
        },
      },
    };
    const storage = new MemoryAdapter();
    const machine = new FlowMachine({
      definition,
      storage,
      logger: noopLogger,
    });
    const interaction = fakeInteraction();
    const ctx = await machine.start(interaction as never);

    await vi.advanceTimersByTimeAsync(600);
    // Allow the fired callback's promise chain to resolve.
    await Promise.resolve();
    await Promise.resolve();
    const after = await storage.get(ctx.executionId);
    expect(after?.state).toBe("expired");
    vi.useRealTimers();
  });
});

describe("FlowMachine: attach/detach", () => {
  it("subscribes and unsubscribes from interactionCreate", async () => {
    const machine = new FlowMachine({
      definition: makeFlow(),
      logger: noopLogger,
    });
    const client = new EventEmitter() as unknown as Parameters<
      typeof machine.attach
    >[0];
    machine.attach(client);
    expect((client as unknown as EventEmitter).listenerCount("interactionCreate")).toBe(
      1,
    );
    await machine.detach();
    expect((client as unknown as EventEmitter).listenerCount("interactionCreate")).toBe(
      0,
    );
  });

  it("rejects double-attach", () => {
    const machine = new FlowMachine({
      definition: makeFlow(),
      logger: noopLogger,
    });
    const client = new EventEmitter() as unknown as Parameters<
      typeof machine.attach
    >[0];
    machine.attach(client);
    expect(() => machine.attach(client)).toThrow(/already attached/);
  });
});
