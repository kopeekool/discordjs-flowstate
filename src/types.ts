import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Interaction as DiscordInteraction,
  InteractionReplyOptions,
  InteractionUpdateOptions,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  User,
} from "discord.js";

/**
 * Any interaction that can drive a flow forward.
 *
 * NOTE: We intentionally enumerate the concrete narrow types instead of using
 * the broader `MessageComponentInteraction` base — discord.js's exported
 * `Interaction` union is itself a union of these narrow types, so widening
 * here would break assignability at every call site that funnels back into
 * discord.js helpers.
 */
export type FlowInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

/**
 * The set of trigger names emitted when the user interacts with a rendered state.
 *
 * - `enter`     — fired implicitly the first time a state is entered
 * - `timeout`   — fired when the per-state timeout elapses
 * - `<custom>`  — anything matching a button `customId` suffix or your own dispatched event
 */
export type FlowTriggerName = "enter" | "timeout" | (string & {});

/**
 * Output produced by a state's `render()` function. Anything renderable by
 * discord.js — a plain string, an embed payload, components, attachments — is
 * accepted. The runner adapts these to either `reply`, `editReply`, or `update`
 * depending on the lifecycle of the interaction.
 */
export type RenderOutput =
  | string
  | (Omit<InteractionReplyOptions, "flags"> & InteractionUpdateOptions);

/**
 * Per-execution context handed to every render/transition/guard hook. Generic
 * `TContext` lets the consumer attach strongly-typed data to the running flow
 * (e.g. partial form values, RPG state, scoring).
 */
export interface FlowContext<TContext = Record<string, unknown>> {
  /** Stable identifier for this execution of the flow. */
  readonly executionId: string;
  /** Identifier of the parent flow definition. */
  readonly flowId: string;
  /** The Discord user that owns this flow. */
  readonly user: User;
  /** Channel id (if any) where the flow was started. */
  readonly channelId: string | null;
  /** Guild id (if any) where the flow was started. */
  readonly guildId: string | null;
  /** The current state name. */
  state: string;
  /** Mutable per-execution data. Persisted by the storage adapter. */
  data: TContext;
  /** History of visited states (oldest → newest). Useful for back navigation. */
  readonly history: string[];
  /** When this flow execution was created. */
  readonly createdAt: number;
  /** Last time this flow was advanced. */
  updatedAt: number;
  /** Most recent interaction object — only available inside hooks. */
  interaction?: FlowInteraction;
  /** Last input value extracted from the interaction (button id suffix, modal value, select value). */
  input?: string;
  /** Optional metadata bag merged in by middleware. */
  meta: Record<string, unknown>;
}

/**
 * Function signature for `state.render()`. Receives the running context and
 * returns either a payload or a Promise of one.
 */
export type RenderFn<TContext> = (
  ctx: FlowContext<TContext>,
) => RenderOutput | Promise<RenderOutput>;

/**
 * Guard function — returning `false` (or a Promise of `false`) will block the
 * transition. Useful for permission checks, validation, etc.
 */
export type GuardFn<TContext> = (
  ctx: FlowContext<TContext>,
) => boolean | Promise<boolean>;

/**
 * Action callback that fires when entering or exiting a state.
 */
export type ActionFn<TContext> = (
  ctx: FlowContext<TContext>,
) => void | Promise<void>;

/**
 * The terminal name. When a transition resolves to this value, the flow ends
 * and is purged from storage.
 */
export const FLOW_END = "__flowstate_end__" as const;
export type FlowEnd = typeof FLOW_END;

/**
 * Single transition definition. `to` may be a static state name, the special
 * `FLOW_END` sentinel, or a function that computes the next state from the
 * context.
 */
export interface TransitionDefinition<TContext> {
  to:
    | string
    | FlowEnd
    | ((ctx: FlowContext<TContext>) => string | FlowEnd | Promise<string | FlowEnd>);
  guard?: GuardFn<TContext>;
  /** Optional action that runs *after* guard passes but *before* the new state's `enter`. */
  action?: ActionFn<TContext>;
}

/**
 * Definition of a single state in a flow.
 */
export interface StateDefinition<TContext> {
  /** Renders the message payload presented to the user when this state is active. */
  render: RenderFn<TContext>;
  /** Map of trigger name → transition. */
  on?: Record<FlowTriggerName, TransitionDefinition<TContext> | string | FlowEnd>;
  /** Fired when the state is entered (after any incoming transition action). */
  enter?: ActionFn<TContext>;
  /** Fired when the state is exited. */
  exit?: ActionFn<TContext>;
  /** Per-state timeout in milliseconds. When elapsed, the `timeout` trigger fires. */
  timeoutMs?: number;
  /** When `true`, the state can only be advanced by the same user who started the flow. */
  ownerOnly?: boolean;
}

/**
 * Top-level definition handed to `new FlowMachine(...)`.
 */
export interface FlowDefinition<TContext = Record<string, unknown>> {
  /** Unique identifier — used as the prefix for all generated component ids. */
  id: string;
  /** Initial state name. Must exist as a key in `states`. */
  initial: string;
  /** Default initial value for `ctx.data`. May be a function for per-execution copies. */
  initialData?: TContext | (() => TContext);
  /** Map of state name → definition. */
  states: Record<string, StateDefinition<TContext>>;
  /** Fired exactly once per execution, after the flow ends naturally or via `FLOW_END`. */
  onComplete?: ActionFn<TContext>;
  /** Fired when an unhandled error occurs while advancing the flow. */
  onError?: (
    error: unknown,
    ctx: FlowContext<TContext>,
  ) => void | Promise<void>;
  /** Default per-state timeout. Overridden by `state.timeoutMs`. */
  defaultTimeoutMs?: number;
}

/**
 * Lightweight serialization-friendly snapshot used by storage adapters.
 */
export interface FlowSnapshot<TContext = Record<string, unknown>> {
  executionId: string;
  flowId: string;
  state: string;
  data: TContext;
  history: string[];
  userId: string;
  channelId: string | null;
  guildId: string | null;
  createdAt: number;
  updatedAt: number;
  meta: Record<string, unknown>;
}

/**
 * Storage adapter contract. Implement this to plug in Redis, Postgres, etc.
 * The shipped {@link MemoryAdapter} satisfies the interface for testing and
 * single-process bots.
 */
export interface StorageAdapter {
  get<TContext>(executionId: string): Promise<FlowSnapshot<TContext> | null>;
  set<TContext>(snapshot: FlowSnapshot<TContext>): Promise<void>;
  delete(executionId: string): Promise<void>;
  /** Optional: list active executions for diagnostics / GC. */
  list?(): Promise<string[]>;
  /** Optional: called when the machine is detached, useful for closing connections. */
  close?(): Promise<void>;
}

/**
 * Middleware function. Runs before every transition. Throwing aborts the
 * transition and surfaces the error via `onError`.
 */
export type Middleware<TContext = Record<string, unknown>> = (
  ctx: FlowContext<TContext>,
  next: () => Promise<void>,
) => Promise<void>;

/**
 * Events emitted by {@link FlowMachine}. All payloads are read-only snapshots.
 */
export interface FlowMachineEvents<TContext = Record<string, unknown>> {
  start: (ctx: FlowContext<TContext>) => void;
  transition: (
    ctx: FlowContext<TContext>,
    from: string,
    to: string,
    trigger: FlowTriggerName,
  ) => void;
  complete: (ctx: FlowContext<TContext>) => void;
  timeout: (ctx: FlowContext<TContext>) => void;
  error: (error: unknown, ctx: FlowContext<TContext> | null) => void;
}

/**
 * Options accepted by {@link FlowMachine.start}.
 */
export interface StartOptions<TContext = Record<string, unknown>> {
  data?: Partial<TContext>;
  meta?: Record<string, unknown>;
  /** Override the executionId (default: random uuid). */
  executionId?: string;
  /** Reply ephemerally for the initial render. Default: `true`. */
  ephemeral?: boolean;
}

/**
 * Internal — describes how a customId is encoded so the machine can route an
 * incoming interaction back to its execution.
 */
export interface DecodedCustomId {
  flowId: string;
  executionId: string;
  trigger: string;
}

/**
 * Re-exported `Interaction` for convenience in user code.
 */
export type Interaction = DiscordInteraction;
