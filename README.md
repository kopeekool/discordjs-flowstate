# discordjs-flowstate

> Composable, type-safe finite state machines for orchestrating multi-step Discord interactions on top of [discord.js](https://discord.js.org) v14+.

[![npm version](https://img.shields.io/npm/v/discordjs-flowstate.svg)](https://www.npmjs.com/package/discordjs-flowstate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)

**Flowstate** lets you describe wizards, quizzes, onboarding flows, RPG encounters, ticket systems, and any other multi-step Discord interaction as a single declarative state machine — instead of stitching together listeners by hand.

```ts
const onboarding = new FlowMachine({
  definition: {
    id: "onboarding",
    initial: "welcome",
    states: {
      welcome: {
        render: (ctx) => ({
          content: `Welcome ${ctx.user.username}!`,
          components: onboarding.rows(
            onboarding.button(ctx, { trigger: "begin", label: "Begin" }),
          ),
        }),
        on: { begin: "askName" },
      },
      askName: { /* ... */ },
    },
  },
});

onboarding.attach(client);
```

That's the entire integration. No `interactionCreate` listeners, no manual `customId` parsing, no homegrown state map keyed by user id — the machine takes care of it.

---

## Table of Contents

- [Why?](#why)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Concepts](#concepts)
  - [Flow definitions](#flow-definitions)
  - [States](#states)
  - [Transitions](#transitions)
  - [Context](#context)
  - [Triggers](#triggers)
- [Component helpers](#component-helpers)
- [Persistence](#persistence)
- [Timeouts](#timeouts)
- [Guards & owner-only states](#guards--owner-only-states)
- [Middleware](#middleware)
- [Sub-flows](#sub-flows)
- [Events](#events)
- [Error handling](#error-handling)
- [TypeScript](#typescript)
- [API reference](#api-reference)
- [FAQ](#faq)
- [Comparison](#comparison)
- [License](#license)

---

## Why?

Building anything more complex than a single command/response in discord.js means manually tracking:

- which user is in which step
- which `customId` belongs to which interaction
- when to expire stale collectors
- how to roll back when a step fails
- how to persist progress so a bot restart doesn't lose work

Most bots end up with a homegrown soup of `Collection<userId, Step>` maps and growing `interactionCreate` switch statements. **Flowstate** replaces all of that with a single declarative description of your flow:

- **Declarative.** States and transitions in one object. Read top-to-bottom.
- **Type-safe.** Per-flow context is strongly typed end-to-end.
- **Pluggable persistence.** Memory adapter shipped; bring your own (Redis, Postgres) by implementing one interface.
- **Built-in component routing.** Buttons, modals, and select menus are wired automatically — no manual `customId` parsing.
- **Per-state timeouts.** Auto-transition when the user disappears mid-flow.
- **Composable.** Sub-flows let large bots split logic across teams.
- **Production friendly.** No singletons, no globals, no hidden state. Detach cleanly. Tested with strict TS.

---

## Installation

```bash
npm install discordjs-flowstate discord.js
# or
pnpm add discordjs-flowstate discord.js
# or
yarn add discordjs-flowstate discord.js
```

**Requirements:** Node.js ≥ 18, discord.js ≥ 14.14, TypeScript ≥ 5 (optional but recommended).

---

## Quick start

```ts
import { Client, GatewayIntentBits, ButtonStyle } from "discord.js";
import { FLOW_END, FlowMachine } from "discordjs-flowstate";

interface Ctx {
  count: number;
}

const counter = new FlowMachine<Ctx>({
  definition: {
    id: "counter",
    initial: "show",
    initialData: () => ({ count: 0 }),
    states: {
      show: {
        render: (ctx) => ({
          content: `Count: **${ctx.data.count}**`,
          components: counter.rows(
            counter.button(ctx, {
              trigger: "inc",
              label: "+1",
              style: ButtonStyle.Primary,
            }),
            counter.button(ctx, {
              trigger: "stop",
              label: "Stop",
              style: ButtonStyle.Danger,
            }),
          ),
        }),
        on: {
          inc: {
            to: "show",
            action: (ctx) => {
              ctx.data.count += 1;
            },
          },
          stop: FLOW_END,
        },
      },
    },
  },
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
counter.attach(client);

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === "count") {
    await counter.start(interaction);
  }
});

await client.login(process.env.DISCORD_TOKEN);
```

That's a complete, production-ready interactive counter — including persistence, owner-only enforcement (opt-in), timeout cleanup, and graceful cancellation.

---

## Concepts

### Flow definitions

A flow is a plain object passed to `new FlowMachine({ definition })`:

```ts
const def: FlowDefinition<MyCtx> = {
  id: "my-flow",            // unique — used in component customIds
  initial: "start",         // first state to render
  initialData: () => ({}),  // factory for ctx.data on each new execution
  defaultTimeoutMs: 60_000, // applied to states without their own timeoutMs
  states: { /* ... */ },
  onComplete: (ctx) => { /* fired once when flow ends */ },
  onError: (err, ctx) => { /* central error sink */ },
};
```

### States

A state is a render function plus optional metadata:

```ts
welcome: {
  render: (ctx) => "Hi there!",          // string OR a discord.js reply payload
  enter: async (ctx) => { /* ... */ },   // fires on entering this state
  exit:  async (ctx) => { /* ... */ },   // fires on leaving
  timeoutMs: 30_000,                     // overrides defaultTimeoutMs
  ownerOnly: true,                       // only the starting user may interact
  on: { /* triggers => transitions */ },
}
```

`render()` returns either a string, or any discord.js [`InteractionReplyOptions`](https://discord.js.org/docs/packages/discord.js/main/InteractionReplyOptions:Interface) / [`InteractionUpdateOptions`](https://discord.js.org/docs/packages/discord.js/main/InteractionUpdateOptions:Interface) payload — embeds, components, attachments, content, all welcome.

### Transitions

The `on` map declares what trigger names the state responds to and where they go:

```ts
on: {
  next: "review",                       // shorthand: just a target state name
  cancel: FLOW_END,                     // ends the flow
  save: {                               // full form
    to: "thanks",
    guard: (ctx) => ctx.data.acceptedTos === true,
    action: async (ctx) => persist(ctx.data),
  },
  retry: {
    // dynamic transitions — compute the target from context
    to: (ctx) => (ctx.data.attempts >= 3 ? "lockedOut" : "askPin"),
  },
}
```

Special trigger names:

| Trigger   | When fired                                                              |
| --------- | ----------------------------------------------------------------------- |
| `enter`   | Implicitly on entering the state. Use to auto-advance immediately.      |
| `timeout` | When the per-state timeout elapses without user input.                  |

Special transition targets:

| Target             | Behavior                                                                       |
| ------------------ | ------------------------------------------------------------------------------ |
| `FLOW_END`         | Ends the flow, deletes storage, fires `onComplete`.                            |
| `"flow:<id>"`      | Hands control to a registered sub-flow (see [Sub-flows](#sub-flows)).          |
| Any other string   | The name of the next state.                                                    |

### Context

Every render, transition, and middleware receives a `FlowContext`:

```ts
interface FlowContext<TContext> {
  executionId: string;           // unique per running flow
  flowId: string;                // matches definition.id
  user: User;                    // the user who started this flow
  channelId: string | null;
  guildId:   string | null;
  state: string;                 // the current state name
  data: TContext;                // your typed payload — persisted between steps
  history: string[];             // visited states, oldest first
  createdAt: number;
  updatedAt: number;
  interaction?: Interaction;     // available inside hooks
  input?: string;                // the raw input that triggered this transition
  meta: Record<string, unknown>; // free-form bag for middleware
}
```

`ctx.data` is the place to stash everything your flow accumulates — partially-filled forms, scores, RPG inventories. It survives across transitions because it's serialized by the storage adapter.

### Triggers

A trigger is a string that names "what just happened." When the user clicks a button created via `machine.button(ctx, { trigger: "next", ... })`, the runner dispatches `next`. When they submit a select menu created via `machine.select(ctx, { trigger: "pick" })`, it dispatches `pick`.

Triggers don't have to be Discord events — you can dispatch them from anywhere via `machine.dispatch(executionId, "fromCron")` to integrate with reactions, scheduled jobs, etc.

---

## Component helpers

Use the helpers off your `FlowMachine` instance to build flowstate-aware components without manually encoding `customId`s:

```ts
render: (ctx) => ({
  content: "Pick one:",
  components: machine.rows(
    machine.button(ctx, { trigger: "yes", label: "Yes",  style: ButtonStyle.Success }),
    machine.button(ctx, { trigger: "no",  label: "No",   style: ButtonStyle.Danger  }),
    machine.select(ctx, {
      trigger: "color",
      placeholder: "Choose a color",
      options: [
        { label: "Red",   value: "red"   },
        { label: "Blue",  value: "blue"  },
      ],
    }),
  ),
}),
```

`rows()` packs buttons (max 5 per row) and selects (one per row) into the correct `ActionRow` layout automatically.

For modals:

```ts
const modal = machine.modal(ctx, {
  trigger: "submitName",
  title: "Your name",
  fields: [
    { customId: "name", label: "Name", placeholder: "Ada Lovelace" },
  ],
});
await ctx.interaction.showModal(modal);
```

When the user submits, the runner dispatches the `submitName` trigger and exposes the submitted fields as a JSON string in `ctx.input`.

---

## Persistence

Flowstate ships with a `MemoryAdapter` for tests and single-process bots:

```ts
import { MemoryAdapter } from "discordjs-flowstate";

new FlowMachine({
  storage: new MemoryAdapter({ ttlMs: 5 * 60_000 }), // optional TTL
  definition,
});
```

To plug in Redis, Postgres, or anything else, implement `StorageAdapter`:

```ts
interface StorageAdapter {
  get<T>(executionId: string): Promise<FlowSnapshot<T> | null>;
  set<T>(snapshot: FlowSnapshot<T>): Promise<void>;
  delete(executionId: string): Promise<void>;
  list?(): Promise<string[]>;
  close?(): Promise<void>;
}
```

Snapshots are plain JSON-serializable objects. Example Redis adapter sketch:

```ts
class RedisAdapter implements StorageAdapter {
  constructor(private redis: Redis, private prefix = "flowstate:") {}

  async get<T>(id: string) {
    const raw = await this.redis.get(this.prefix + id);
    return raw ? (JSON.parse(raw) as FlowSnapshot<T>) : null;
  }
  async set(snap: FlowSnapshot) {
    await this.redis.set(this.prefix + snap.executionId, JSON.stringify(snap), "EX", 3600);
  }
  async delete(id: string) {
    await this.redis.del(this.prefix + id);
  }
}
```

---

## Timeouts

Per-state timeouts auto-fire the `timeout` trigger when the user disappears mid-flow:

```ts
askPin: {
  timeoutMs: 30_000,
  render: (ctx) => "Enter your PIN within 30 seconds.",
  on: {
    submit: "verifyPin",
    timeout: "expired", // fired automatically after 30s without input
  },
},
expired: {
  render: () => "Sorry, you took too long.",
  on: { enter: FLOW_END },
},
```

If a state has a timeout but no `timeout` trigger handler, the flow simply ends and storage is cleaned up — no leaks.

Timers are `unref()`'d so they don't keep the Node process alive on shutdown, and `machine.detach()` cancels every pending timer.

---

## Guards & owner-only states

Add a guard to block transitions until a precondition is met:

```ts
on: {
  submit: {
    to: "thanks",
    guard: async (ctx) => {
      const isAdmin = await checkAdmin(ctx.user.id);
      return isAdmin;
    },
  },
},
```

If the guard returns `false`, the transition is rejected and a `GuardRejectedError` is reported via `onError` and surfaced to the user as an ephemeral message.

For the common case of "only the user who started this flow may continue," set `ownerOnly: true` on the state — flowstate handles the comparison for you and politely informs other users that the interaction isn't theirs.

---

## Middleware

Middleware runs around every transition. Use it for logging, metrics, locale resolution, and rate-limiting:

```ts
new FlowMachine({
  definition,
  middleware: [
    async (ctx, next) => {
      const start = Date.now();
      await next();
      logger.info("flow.transition", {
        flowId: ctx.flowId,
        state: ctx.state,
        ms: Date.now() - start,
      });
    },
    async (ctx, next) => {
      ctx.meta.locale = await loadLocale(ctx.user.id);
      await next();
    },
  ],
});
```

Middleware is composed in declaration order (just like Express/Koa). Throwing aborts the transition and surfaces the error via `onError`.

---

## Sub-flows

Compose large bots out of small machines. Register a child flow on the parent and reference it from any transition with the `flow:<childId>` syntax:

```ts
const billingFlow = new FlowMachine({ /* ... */ });
const root = new FlowMachine({
  definition: {
    id: "ticket",
    initial: "menu",
    states: {
      menu: {
        render: (ctx) => ({ /* ... */ }),
        on: {
          billing: "flow:billing",
          bug: "bugAck",
        },
      },
      bugAck: { render: () => "Thanks!", on: { enter: FLOW_END } },
    },
  },
});

root.registerSubFlow(billingFlow);
```

When the user clicks the **Billing** button, the parent flow exits cleanly and the billing flow takes over. Each sub-flow can be developed and deployed by a separate team — they share nothing but the storage adapter (if you choose).

---

## Events

`FlowMachine` extends `EventEmitter`. Subscribe for observability:

```ts
machine.on("start",      (ctx)                   => log("flow.start",      ctx));
machine.on("transition", (ctx, from, to, trig)   => log("flow.transition", { from, to, trig }));
machine.on("complete",   (ctx)                   => log("flow.complete",   ctx));
machine.on("timeout",    (ctx)                   => log("flow.timeout",    ctx));
machine.on("error",      (err, ctx)              => log("flow.error",      err));
```

Event handlers are read-only — they receive snapshots, not mutable references.

---

## Error handling

There are three layers, in order:

1. **Definition validation.** Bad definitions throw `InvalidFlowDefinitionError` synchronously at construction.
2. **Per-flow `onError`.** Catches everything that happens during a transition. Use it to surface user-friendly messages, capture telemetry, or roll back.
3. **`error` event + `Logger`.** Library-level errors that aren't tied to a single execution are emitted on the machine and logged via the configured `Logger`.

Built-in error classes:

| Class                          | When thrown                                                   |
| ------------------------------ | ------------------------------------------------------------- |
| `FlowStateError`               | Base class for every error this library throws.               |
| `InvalidFlowDefinitionError`   | Definition fails validation at construction.                  |
| `UnknownStateError`            | A transition references a state that doesn't exist.           |
| `ExecutionNotFoundError`       | `dispatch()` called for an expired/unknown execution id.      |
| `GuardRejectedError`           | A transition guard returned `false`.                          |
| `NotFlowOwnerError`            | A non-owner attempted to advance an `ownerOnly` state.        |

---

## TypeScript

Pass the context type as the first generic parameter and it propagates through every hook:

```ts
interface OrderCtx {
  productId?: string;
  quantity?: number;
}

const checkout = new FlowMachine<OrderCtx>({
  definition: {
    id: "checkout",
    initial: "pickProduct",
    initialData: () => ({}),
    states: {
      pickProduct: {
        render: (ctx) => /* ctx.data: OrderCtx */ "Pick one",
        on: {
          choose: {
            to: "pickQuantity",
            action: (ctx) => {
              // ctx.data is fully typed
              ctx.data.productId = ctx.input;
            },
          },
        },
      },
      // ...
    },
  },
});
```

The library is published with `.d.ts` declarations and source maps; nothing else to install.

---

## API reference

### `class FlowMachine<TContext>`

| Member                                                                  | Description                                                                  |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `new FlowMachine({ definition, storage?, logger?, middleware? })`       | Construct the machine.                                                       |
| `attach(client: Client)`                                                | Subscribe to `interactionCreate`. Returns `this`.                            |
| `detach(): Promise<void>`                                               | Unsubscribe and cancel pending timeouts. Closes the storage adapter.         |
| `start(interaction, options?): Promise<FlowContext>`                    | Begin a new execution and reply with the initial state.                      |
| `dispatch(executionId, trigger, interaction?, input?)`                  | Manually advance an execution.                                               |
| `registerSubFlow(child)`                                                | Register a child flow targetable via `flow:<childId>`.                       |
| `button(ctx, options)` / `select(ctx, options)` / `modal(ctx, options)` | Build flowstate-routed components.                                           |
| `rows(...components)`                                                   | Pack components into action rows.                                            |
| `on(event, listener)` / `off(event, listener)`                          | Subscribe to lifecycle events.                                               |

### `class MemoryAdapter`

In-memory `StorageAdapter`. Optional `ttlMs` evicts stale entries on access.

### Constants

- `FLOW_END` — the sentinel transition target that ends the flow.

### Functions

- `encodeCustomId(flowId, executionId, trigger)` / `decodeCustomId(id)` / `isFlowstateCustomId(id)` — exported for advanced cases (e.g. integrating with an existing component dispatcher).
- `buildButton`, `buildSelect`, `buildModal`, `rows` — same builders the machine uses internally.

---

## FAQ

**Does this replace discord.js's collectors?**
For multi-step flows, yes. Collectors are still great for one-off "wait for the next reaction" interactions; flowstate is for longer journeys that need persistence and structure.

**What about discord.js v15?**
Once v15 is released and stable, support will be added in a minor release. The library only depends on stable v14 surfaces, so the upgrade should be small.

**Can I run this in a serverless environment?**
Yes — supply a remote `StorageAdapter` (Redis, Dynamo, Postgres) and the machine is fully stateless across processes. The shipped `MemoryAdapter` is for single-process bots only.

**Does it handle command registration?**
No, by design. Slash command registration belongs in your bot's bootstrap, not in a flow library. Use whatever registration script you already have.

**Does it support DM flows?**
Yes — flows work in DMs and guilds identically. `ctx.guildId` will be `null` in DMs.

---

## Comparison

|                                | discord.js (vanilla) | discord-akairo | discord.js-pages | **discordjs-flowstate** |
| ------------------------------ | :------------------: | :------------: | :--------------: | :---------------------: |
| Multi-step interaction flows   |          ❌          |       ⚠️       |        ❌        |          ✅             |
| Declarative state machine      |          ❌          |       ❌       |        ❌        |          ✅             |
| Built-in component routing     |          ❌          |       ⚠️       |        ✅        |          ✅             |
| Pluggable persistence          |          ❌          |       ❌       |        ❌        |          ✅             |
| Per-state timeouts             |          ⚠️          |       ❌       |        ⚠️        |          ✅             |
| Sub-flow composition           |          ❌          |       ❌       |        ❌        |          ✅             |
| Type-safe per-flow context     |          ❌          |       ⚠️       |        ❌        |          ✅             |
| Middleware                     |          ❌          |       ⚠️       |        ❌        |          ✅             |

---

## License

[MIT](./LICENSE) © KopeeKool Studio
