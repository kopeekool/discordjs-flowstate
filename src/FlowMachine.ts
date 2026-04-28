import { EventEmitter } from "node:events";
import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  InteractionType,
  MessageFlags,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";

import { MemoryAdapter } from "./adapters/MemoryAdapter.js";
import {
  buildButton,
  buildModal,
  buildSelect,
  rows,
  type ButtonOptions,
  type ModalOptions,
  type SelectOptions,
} from "./components/builders.js";
import {
  ExecutionNotFoundError,
  FlowStateError,
  GuardRejectedError,
  InvalidFlowDefinitionError,
  NotFlowOwnerError,
  UnknownStateError,
} from "./errors.js";
import {
  FLOW_END,
  type FlowContext,
  type FlowDefinition,
  type FlowEnd,
  type FlowInteraction,
  type FlowMachineEvents,
  type FlowSnapshot,
  type FlowTriggerName,
  type Middleware,
  type RenderOutput,
  type StartOptions,
  type StateDefinition,
  type StorageAdapter,
  type TransitionDefinition,
} from "./types.js";
import { decodeCustomId, isFlowstateCustomId } from "./utils/customId.js";
import { defaultLogger, type Logger } from "./utils/logger.js";
import { TimeoutRegistry } from "./utils/timeout.js";
import { shortId } from "./utils/uuid.js";

export interface FlowMachineOptions<TContext> {
  definition: FlowDefinition<TContext>;
  storage?: StorageAdapter;
  logger?: Logger;
  /** Middleware list, executed in declaration order. */
  middleware?: Middleware<TContext>[];
}

/**
 * The runtime engine that executes a {@link FlowDefinition}.
 *
 * Typical usage:
 * ```ts
 * const machine = new FlowMachine({ definition: onboarding });
 * machine.attach(client);
 * await machine.start(interaction);
 * ```
 */
export class FlowMachine<TContext = Record<string, unknown>> extends EventEmitter {
  public readonly id: string;
  public readonly definition: FlowDefinition<TContext>;

  private readonly storage: StorageAdapter;
  private readonly logger: Logger;
  private readonly middleware: Middleware<TContext>[];
  private readonly timeouts = new TimeoutRegistry();
  private readonly subFlows = new Map<string, FlowMachine<unknown>>();
  private attachedClient: Client | null = null;
  private boundHandler: ((interaction: Interaction) => void) | null = null;

  constructor(options: FlowMachineOptions<TContext>) {
    super();
    validateDefinition(options.definition);
    this.definition = options.definition;
    this.id = options.definition.id;
    this.storage = options.storage ?? new MemoryAdapter();
    this.logger = options.logger ?? defaultLogger;
    this.middleware = options.middleware ?? [];
  }

  // -- Type-narrow event accessors -----------------------------------------

  override on<E extends keyof FlowMachineEvents<TContext>>(
    event: E,
    listener: FlowMachineEvents<TContext>[E],
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override off<E extends keyof FlowMachineEvents<TContext>>(
    event: E,
    listener: FlowMachineEvents<TContext>[E],
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  override emit<E extends keyof FlowMachineEvents<TContext>>(
    event: E,
    ...args: Parameters<FlowMachineEvents<TContext>[E]>
  ): boolean {
    return super.emit(event, ...args);
  }

  // -- Sub-flow registration -----------------------------------------------

  /**
   * Register a child {@link FlowMachine}. When a state's transition resolves
   * to `flow:<childId>`, the runner will yield to that machine. Sub-flows
   * inherit the same storage adapter unless they declare their own.
   */
  registerSubFlow(child: FlowMachine<unknown>): void {
    this.subFlows.set(child.id, child);
  }

  // -- Component builders --------------------------------------------------

  /** Helper used inside `render()` to create a flowstate-routed button. */
  button(ctx: FlowContext<TContext>, options: ButtonOptions) {
    return buildButton(this.id, ctx.executionId, options);
  }

  /** Helper used inside `render()` to create a flowstate-routed string select. */
  select(ctx: FlowContext<TContext>, options: SelectOptions) {
    return buildSelect(this.id, ctx.executionId, options);
  }

  /** Helper used inside `render()` to create a flowstate-routed modal. */
  modal(ctx: FlowContext<TContext>, options: ModalOptions) {
    return buildModal(this.id, ctx.executionId, options);
  }

  /** Re-exported `rows` helper for convenience. */
  rows = rows;

  // -- Lifecycle: client attachment ----------------------------------------

  /**
   * Attach the machine to a discord.js Client. The machine subscribes to
   * `interactionCreate` and silently ignores any interaction whose customId
   * was not produced by this flow.
   */
  attach(client: Client): this {
    if (this.attachedClient) {
      throw new FlowStateError(
        "ALREADY_ATTACHED",
        `Flow "${this.id}" is already attached to a client. Call detach() first.`,
      );
    }
    this.attachedClient = client;
    this.boundHandler = (interaction: Interaction): void => {
      void this.route(interaction).catch((err) => {
        this.logger.error("Unhandled error during routing", { err });
        this.emit("error", err, null);
      });
    };
    client.on("interactionCreate", this.boundHandler);
    return this;
  }

  /**
   * Detach the machine from its client and cancel every pending timeout. Safe
   * to call multiple times.
   */
  async detach(): Promise<void> {
    if (this.attachedClient && this.boundHandler) {
      this.attachedClient.off("interactionCreate", this.boundHandler);
    }
    this.attachedClient = null;
    this.boundHandler = null;
    this.timeouts.cancelAll();
    if (typeof this.storage.close === "function") {
      await this.storage.close();
    }
  }

  // -- Public API: starting a flow -----------------------------------------

  /**
   * Begin a new flow execution in response to a slash command (or any other
   * repliable interaction). The initial state is rendered as the reply.
   */
  async start(
    interaction: ChatInputCommandInteraction | MessageComponentInteraction,
    options: StartOptions<TContext> = {},
  ): Promise<FlowContext<TContext>> {
    const initialData = resolveInitialData<TContext>(this.definition, options.data);
    const ctx: FlowContext<TContext> = {
      executionId: options.executionId ?? shortId(),
      flowId: this.id,
      user: interaction.user,
      channelId: interaction.channelId ?? null,
      guildId: interaction.guildId ?? null,
      state: this.definition.initial,
      data: initialData,
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      meta: { ...(options.meta ?? {}) },
      interaction: interaction as FlowInteraction,
    };

    await this.persist(ctx);
    this.emit("start", ctx);

    try {
      await this.runEnter(ctx);
      const payload = await this.renderState(ctx);
      await replyOrFollowUp(interaction, payload, options.ephemeral ?? true);
      this.scheduleTimeout(ctx);
    } catch (err) {
      await this.handleError(err, ctx);
    }

    return ctx;
  }

  /**
   * Manually advance an in-flight execution. You usually don't need this —
   * `attach()` automatically handles routing. Useful when integrating with a
   * custom event source (e.g. message reactions, scheduled jobs).
   */
  async dispatch(
    executionId: string,
    trigger: FlowTriggerName,
    interaction?: FlowInteraction,
    input?: string,
  ): Promise<FlowContext<TContext> | null> {
    const snapshot = await this.storage.get<TContext>(executionId);
    if (!snapshot) throw new ExecutionNotFoundError(executionId);

    const ctx = hydrateContext(snapshot, interaction, input);
    await this.transition(ctx, trigger);
    return ctx;
  }

  // -- Internal: routing ---------------------------------------------------

  private async route(interaction: Interaction): Promise<void> {
    const customId = extractCustomId(interaction);
    if (!customId || !isFlowstateCustomId(customId)) return;

    const decoded = decodeCustomId(customId);
    if (!decoded || decoded.flowId !== this.id) return;

    let snapshot: FlowSnapshot<TContext> | null;
    try {
      snapshot = await this.storage.get<TContext>(decoded.executionId);
    } catch (err) {
      this.logger.error("Storage adapter failed during routing", { err });
      this.emit("error", err, null);
      return;
    }

    if (!snapshot) {
      // Execution expired — let the user know without crashing the bot.
      await safeRespond(
        interaction,
        "This interaction has expired. Please run the command again.",
      );
      return;
    }

    const stateDef = this.definition.states[snapshot.state];
    if (stateDef?.ownerOnly && interaction.user.id !== snapshot.userId) {
      await safeRespond(interaction, "Only the original user can use this.");
      return;
    }

    const input = extractInput(interaction);
    const ctx = hydrateContext(
      snapshot,
      interaction as FlowInteraction,
      input,
    );

    try {
      await this.transition(ctx, decoded.trigger);
    } catch (err) {
      await this.handleError(err, ctx);
    }
  }

  // -- Internal: transition pipeline ---------------------------------------

  private async transition(
    ctx: FlowContext<TContext>,
    trigger: FlowTriggerName,
  ): Promise<void> {
    const runChain = this.composeMiddleware(async () => {
      const fromState = ctx.state;
      const stateDef = this.definition.states[fromState];
      if (!stateDef) throw new UnknownStateError(this.id, fromState);

      const transition = resolveTransition(stateDef, trigger);
      if (!transition) {
        // No transition configured for this trigger — re-render the same state
        // so the interaction doesn't appear to have done nothing. We *also*
        // ack the interaction first to avoid the "interaction failed" flash.
        await acknowledge(ctx.interaction);
        return;
      }

      if (transition.guard) {
        const ok = await transition.guard(ctx);
        if (!ok) throw new GuardRejectedError(fromState, trigger);
      }

      const nextState = await resolveTo(transition.to, ctx);

      if (nextState === FLOW_END) {
        await this.runExit(ctx);
        if (transition.action) await transition.action(ctx);
        await this.complete(ctx);
        return;
      }

      // Sub-flow handoff via `flow:<childId>` syntax.
      if (typeof nextState === "string" && nextState.startsWith("flow:")) {
        const childId = nextState.slice("flow:".length);
        const child = this.subFlows.get(childId);
        if (!child) {
          throw new FlowStateError(
            "UNKNOWN_SUBFLOW",
            `Flow "${this.id}" tried to transition into unknown sub-flow "${childId}".`,
          );
        }
        await this.runExit(ctx);
        if (transition.action) await transition.action(ctx);
        if (ctx.interaction) {
          await child.start(
            ctx.interaction as ChatInputCommandInteraction,
            { data: ctx.data as never, meta: ctx.meta },
          );
        }
        await this.storage.delete(ctx.executionId);
        return;
      }

      if (!this.definition.states[nextState]) {
        throw new UnknownStateError(this.id, nextState);
      }

      await this.runExit(ctx);
      if (transition.action) await transition.action(ctx);

      ctx.history.push(fromState);
      ctx.state = nextState;
      ctx.updatedAt = Date.now();

      await this.runEnter(ctx);
      await this.persist(ctx);
      const payload = await this.renderState(ctx);
      await applyUpdate(ctx.interaction, payload);
      this.scheduleTimeout(ctx);

      this.emit("transition", ctx, fromState, nextState, trigger);
    });

    await runChain(ctx);
  }

  private composeMiddleware(
    final: (ctx: FlowContext<TContext>) => Promise<void>,
  ): (ctx: FlowContext<TContext>) => Promise<void> {
    return (ctx) => {
      let index = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= index) {
          throw new FlowStateError(
            "MIDDLEWARE_NEXT_CALLED_TWICE",
            "next() called multiple times in middleware.",
          );
        }
        index = i;
        const fn = this.middleware[i];
        if (!fn) {
          await final(ctx);
          return;
        }
        await fn(ctx, () => dispatch(i + 1));
      };
      return dispatch(0);
    };
  }

  // -- Internal: rendering -------------------------------------------------

  private async renderState(ctx: FlowContext<TContext>): Promise<RenderOutput> {
    const stateDef = this.definition.states[ctx.state];
    if (!stateDef) throw new UnknownStateError(this.id, ctx.state);
    return stateDef.render(ctx);
  }

  private async runEnter(ctx: FlowContext<TContext>): Promise<void> {
    const stateDef = this.definition.states[ctx.state];
    if (stateDef?.enter) await stateDef.enter(ctx);
  }

  private async runExit(ctx: FlowContext<TContext>): Promise<void> {
    const stateDef = this.definition.states[ctx.state];
    if (stateDef?.exit) await stateDef.exit(ctx);
  }

  // -- Internal: persistence + timeouts ------------------------------------

  private async persist(ctx: FlowContext<TContext>): Promise<void> {
    const snapshot: FlowSnapshot<TContext> = {
      executionId: ctx.executionId,
      flowId: ctx.flowId,
      state: ctx.state,
      data: ctx.data,
      history: ctx.history,
      userId: ctx.user.id,
      channelId: ctx.channelId,
      guildId: ctx.guildId,
      createdAt: ctx.createdAt,
      updatedAt: ctx.updatedAt,
      meta: ctx.meta,
    };
    await this.storage.set(snapshot);
  }

  private scheduleTimeout(ctx: FlowContext<TContext>): void {
    const stateDef = this.definition.states[ctx.state];
    const ms = stateDef?.timeoutMs ?? this.definition.defaultTimeoutMs;
    if (!ms || ms <= 0) {
      this.timeouts.cancel(ctx.executionId);
      return;
    }
    this.timeouts.schedule(ctx.executionId, ms, () => {
      void this.handleTimeout(ctx.executionId).catch((err) => {
        this.logger.error("Timeout handler crashed", { err });
        this.emit("error", err, null);
      });
    });
  }

  private async handleTimeout(executionId: string): Promise<void> {
    const snapshot = await this.storage.get<TContext>(executionId);
    if (!snapshot) return;
    const ctx = hydrateContext(snapshot);
    this.emit("timeout", ctx);
    try {
      await this.transition(ctx, "timeout");
    } catch (err) {
      // Timeout transitions are commonly absent — silently end the flow when
      // there's no handler so we don't leak storage entries.
      if (err instanceof UnknownStateError || err instanceof FlowStateError) {
        await this.complete(ctx);
        return;
      }
      throw err;
    }
  }

  private async complete(ctx: FlowContext<TContext>): Promise<void> {
    this.timeouts.cancel(ctx.executionId);
    await this.storage.delete(ctx.executionId);
    if (this.definition.onComplete) {
      try {
        await this.definition.onComplete(ctx);
      } catch (err) {
        this.logger.error("onComplete handler threw", { err });
      }
    }
    this.emit("complete", ctx);
  }

  // -- Internal: error handling --------------------------------------------

  private async handleError(
    err: unknown,
    ctx: FlowContext<TContext>,
  ): Promise<void> {
    this.logger.error("Flow error", {
      flowId: this.id,
      executionId: ctx.executionId,
      state: ctx.state,
      err,
    });
    this.emit("error", err, ctx);
    if (this.definition.onError) {
      try {
        await this.definition.onError(err, ctx);
      } catch (handlerErr) {
        this.logger.error("onError handler itself threw", { handlerErr });
      }
    }
    if (err instanceof NotFlowOwnerError || err instanceof GuardRejectedError) {
      await safeRespond(ctx.interaction, err.message);
    }
  }
}

// -- Local helpers ----------------------------------------------------------

function validateDefinition<TContext>(def: FlowDefinition<TContext>): void {
  if (!def.id) {
    throw new InvalidFlowDefinitionError("Flow definition is missing an `id`.");
  }
  if (def.id.includes("|")) {
    throw new InvalidFlowDefinitionError(
      `Flow id "${def.id}" must not contain the "|" character.`,
    );
  }
  if (!def.initial) {
    throw new InvalidFlowDefinitionError(
      `Flow "${def.id}" is missing an \`initial\` state.`,
    );
  }
  if (!def.states[def.initial]) {
    throw new InvalidFlowDefinitionError(
      `Flow "${def.id}" initial state "${def.initial}" is not defined.`,
    );
  }
  for (const [name, state] of Object.entries(def.states)) {
    if (typeof state.render !== "function") {
      throw new InvalidFlowDefinitionError(
        `State "${name}" in flow "${def.id}" must define a render() function.`,
      );
    }
  }
}

function resolveInitialData<TContext>(
  def: FlowDefinition<TContext>,
  override: Partial<TContext> | undefined,
): TContext {
  const base =
    typeof def.initialData === "function"
      ? (def.initialData as () => TContext)()
      : (def.initialData ?? ({} as TContext));
  return { ...base, ...(override ?? {}) } as TContext;
}

function resolveTransition<TContext>(
  state: StateDefinition<TContext>,
  trigger: FlowTriggerName,
): TransitionDefinition<TContext> | null {
  const raw = state.on?.[trigger];
  if (!raw) return null;
  // FLOW_END is a string literal so it falls into the typeof === "string"
  // branch and is preserved verbatim — `transition()` checks for it explicitly.
  if (typeof raw === "string") return { to: raw };
  return raw;
}

async function resolveTo<TContext>(
  to: TransitionDefinition<TContext>["to"],
  ctx: FlowContext<TContext>,
): Promise<string | FlowEnd> {
  if (typeof to === "function") return to(ctx);
  return to;
}

function hydrateContext<TContext>(
  snapshot: FlowSnapshot<TContext>,
  interaction?: FlowInteraction,
  input?: string,
): FlowContext<TContext> {
  return {
    executionId: snapshot.executionId,
    flowId: snapshot.flowId,
    state: snapshot.state,
    data: snapshot.data,
    history: snapshot.history,
    user: (interaction?.user ?? { id: snapshot.userId }) as FlowContext<TContext>["user"],
    channelId: snapshot.channelId,
    guildId: snapshot.guildId,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    meta: snapshot.meta,
    interaction,
    input,
  };
}

function extractCustomId(interaction: Interaction): string | null {
  if (interaction.isMessageComponent()) return interaction.customId;
  if (interaction.type === InteractionType.ModalSubmit) {
    return (interaction as ModalSubmitInteraction).customId;
  }
  return null;
}

function extractInput(interaction: Interaction): string | undefined {
  if (interaction.isStringSelectMenu()) {
    return (interaction as StringSelectMenuInteraction).values.join(",");
  }
  if (interaction.isButton()) {
    return (interaction as ButtonInteraction).customId;
  }
  if (interaction.type === InteractionType.ModalSubmit) {
    const modal = interaction as ModalSubmitInteraction;
    const fields: Record<string, string> = {};
    // discord.js v14 exposes `fields.fields` as a Collection<string, ModalActionRowComponent>.
    // We iterate it instead of the deprecated/typed-narrowed `components` getter so
    // we work across the v14.0 → v14.26+ surface (which split modal layouts into
    // ActionRowModalData | LabelModalData unions).
    const collection = (
      modal.fields as unknown as {
        fields?: Map<string, { customId: string; value: string }>;
      }
    ).fields;
    if (collection) {
      for (const [, component] of collection) {
        fields[component.customId] = component.value;
      }
    }
    return JSON.stringify(fields);
  }
  return undefined;
}

async function replyOrFollowUp(
  interaction: ChatInputCommandInteraction | MessageComponentInteraction,
  payload: RenderOutput,
  ephemeral: boolean,
): Promise<void> {
  const reply = normalizeReplyPayload(payload, ephemeral);
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(reply);
  } else {
    await interaction.reply(reply);
  }
}

async function applyUpdate(
  interaction: FlowInteraction | undefined,
  payload: RenderOutput,
): Promise<void> {
  if (!interaction) return;
  const updatePayload = normalizeUpdatePayload(payload);
  if (interaction.isMessageComponent()) {
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(updatePayload);
    } else {
      await interaction.update(updatePayload);
    }
    return;
  }
  if (interaction.type === InteractionType.ModalSubmit) {
    const modal = interaction as ModalSubmitInteraction;
    if (modal.replied || modal.deferred) {
      await modal.editReply(updatePayload);
    } else {
      await modal.reply({ ...normalizeReplyPayload(payload, true) });
    }
    return;
  }
  // Slash command fallback: edit the original reply.
  if ("editReply" in interaction && typeof interaction.editReply === "function") {
    await interaction.editReply(updatePayload);
  }
}

function normalizeReplyPayload(
  payload: RenderOutput,
  ephemeral: boolean,
  // The reply payload union is intentionally widened — discord.js's Reply,
  // Follow-up, and Modal-reply payloads share the same fields but TypeScript's
  // generic message-flag types reject literal unions across them. We surface
  // the broadest assignable shape so the caller can pass the result directly
  // into reply() / followUp() / showModal().
): Record<string, unknown> {
  const base: Record<string, unknown> =
    typeof payload === "string" ? { content: payload } : { ...payload };
  if (ephemeral) base.flags = MessageFlags.Ephemeral;
  return base;
}

function normalizeUpdatePayload(payload: RenderOutput): Parameters<
  MessageComponentInteraction["update"]
>[0] {
  if (typeof payload === "string") return { content: payload, components: [] };
  return payload;
}

async function acknowledge(interaction?: FlowInteraction): Promise<void> {
  if (!interaction) return;
  if (interaction.isMessageComponent() && !interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate().catch(() => undefined);
  }
}

async function safeRespond(
  interaction: Interaction | undefined,
  message: string,
): Promise<void> {
  if (!interaction) return;
  if (
    !interaction.isRepliable ||
    typeof (interaction as { isRepliable?: () => boolean }).isRepliable !== "function"
  ) {
    return;
  }
  if (!interaction.isRepliable()) return;
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: message, flags: 64 });
    } else {
      await interaction.reply({ content: message, flags: 64 });
    }
  } catch {
    // Last-resort safety: never let UI feedback crash the runtime.
  }
}
