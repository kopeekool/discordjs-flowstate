/**
 * discordjs-flowstate
 * -------------------
 * Composable, type-safe finite state machines for orchestrating multi-step
 * Discord interactions on top of discord.js v14+.
 *
 * @example
 * ```ts
 * import { Client, GatewayIntentBits } from "discord.js";
 * import { FlowMachine, FLOW_END } from "discordjs-flowstate";
 *
 * const onboarding = new FlowMachine<{ name?: string }>({
 *   definition: {
 *     id: "onboarding",
 *     initial: "welcome",
 *     states: {
 *       welcome: {
 *         render: (ctx) => ({
 *           content: "Welcome! Tell us your name.",
 *           components: onboarding.rows(
 *             onboarding.button(ctx, { trigger: "name", label: "Set name" }),
 *           ),
 *         }),
 *         on: { name: "askName" },
 *       },
 *       askName: {
 *         render: (ctx) => ({
 *           content: `Got it, ${ctx.data.name ?? "friend"}! All set.`,
 *         }),
 *         on: { enter: FLOW_END },
 *       },
 *     },
 *   },
 * });
 *
 * const client = new Client({ intents: [GatewayIntentBits.Guilds] });
 * onboarding.attach(client);
 * ```
 */

export { FlowMachine } from "./FlowMachine.js";
export type { FlowMachineOptions } from "./FlowMachine.js";

export {
  FLOW_END,
  type FlowContext,
  type FlowDefinition,
  type FlowEnd,
  type FlowInteraction,
  type FlowMachineEvents,
  type FlowSnapshot,
  type FlowTriggerName,
  type GuardFn,
  type ActionFn,
  type Middleware,
  type RenderFn,
  type RenderOutput,
  type StartOptions,
  type StateDefinition,
  type StorageAdapter,
  type TransitionDefinition,
} from "./types.js";

export {
  FlowStateError,
  ExecutionNotFoundError,
  GuardRejectedError,
  InvalidFlowDefinitionError,
  NotFlowOwnerError,
  UnknownStateError,
} from "./errors.js";

export { MemoryAdapter } from "./adapters/MemoryAdapter.js";

export {
  buildButton,
  buildSelect,
  buildModal,
  rows,
  type ButtonOptions,
  type SelectOptions,
  type ModalOptions,
  type ModalFieldOptions,
} from "./components/builders.js";

export {
  encodeCustomId,
  decodeCustomId,
  isFlowstateCustomId,
} from "./utils/customId.js";

export { defaultLogger, noopLogger, type Logger } from "./utils/logger.js";
