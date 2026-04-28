/**
 * Example: a 3-step onboarding wizard.
 *
 * - Step 1 collects the user's name via a modal.
 * - Step 2 lets them pick a favorite color via a select menu.
 * - Step 3 confirms with a Save / Cancel button pair.
 *
 * Run with `tsx examples/onboarding.ts` after setting `DISCORD_TOKEN`.
 */

import {
  ButtonStyle,
  Client,
  GatewayIntentBits,
  TextInputStyle,
} from "discord.js";

import { FLOW_END, FlowMachine, MemoryAdapter } from "../src/index.js";

interface OnboardCtx {
  name?: string;
  favoriteColor?: string;
}

const onboarding = new FlowMachine<OnboardCtx>({
  storage: new MemoryAdapter({ ttlMs: 5 * 60_000 }),
  definition: {
    id: "onboarding",
    initial: "welcome",
    initialData: () => ({}),
    defaultTimeoutMs: 60_000,

    states: {
      welcome: {
        render: (ctx) => ({
          content: `Welcome, ${ctx.user.username}! Let's set up your profile.`,
          components: onboarding.rows(
            onboarding.button(ctx, {
              trigger: "begin",
              label: "Begin setup",
              style: ButtonStyle.Primary,
            }),
            onboarding.button(ctx, {
              trigger: "cancel",
              label: "Cancel",
              style: ButtonStyle.Secondary,
            }),
          ),
        }),
        on: {
          begin: "askName",
          cancel: FLOW_END,
        },
      },

      askName: {
        ownerOnly: true,
        render: (ctx) => ({
          content: "Click below to share your name.",
          components: onboarding.rows(
            onboarding.button(ctx, {
              trigger: "openNameModal",
              label: "Enter your name",
              style: ButtonStyle.Primary,
            }),
          ),
        }),
        enter: async (ctx) => {
          // The button itself opens a modal; the modal's submission is what
          // advances the flow. We do the modal show inside the trigger handler
          // by using transition action.
          ctx.meta.opened = false;
        },
        on: {
          openNameModal: {
            to: "askName",
            action: async (ctx) => {
              const modal = onboarding.modal(ctx, {
                trigger: "submitName",
                title: "Your name",
                fields: [
                  {
                    customId: "name",
                    label: "Display name",
                    style: TextInputStyle.Short,
                    placeholder: "Ada Lovelace",
                    minLength: 1,
                    maxLength: 64,
                  },
                ],
              });
              if (
                ctx.interaction &&
                "showModal" in ctx.interaction &&
                typeof ctx.interaction.showModal === "function"
              ) {
                await ctx.interaction.showModal(modal);
              }
            },
          },
          submitName: {
            to: "pickColor",
            action: (ctx) => {
              const fields = JSON.parse(ctx.input ?? "{}") as { name?: string };
              ctx.data.name = fields.name?.trim();
            },
            guard: (ctx) => {
              const fields = JSON.parse(ctx.input ?? "{}") as { name?: string };
              return Boolean(fields.name?.trim());
            },
          },
        },
      },

      pickColor: {
        ownerOnly: true,
        render: (ctx) => ({
          content: `Hi ${ctx.data.name}! Pick your favorite color:`,
          components: onboarding.rows(
            onboarding.select(ctx, {
              trigger: "chooseColor",
              placeholder: "Select a color",
              options: [
                { label: "Crimson", value: "crimson" },
                { label: "Forest", value: "forest" },
                { label: "Indigo", value: "indigo" },
                { label: "Sunset", value: "sunset" },
              ],
            }),
          ),
        }),
        on: {
          chooseColor: {
            to: "confirm",
            action: (ctx) => {
              ctx.data.favoriteColor = ctx.input;
            },
          },
        },
      },

      confirm: {
        ownerOnly: true,
        render: (ctx) => ({
          content: `Confirm:\n• Name: **${ctx.data.name}**\n• Color: **${ctx.data.favoriteColor}**`,
          components: onboarding.rows(
            onboarding.button(ctx, {
              trigger: "save",
              label: "Save",
              style: ButtonStyle.Success,
            }),
            onboarding.button(ctx, {
              trigger: "back",
              label: "Back",
              style: ButtonStyle.Secondary,
            }),
          ),
        }),
        on: {
          save: FLOW_END,
          back: "pickColor",
        },
      },
    },

    onComplete: (ctx) => {
      console.error(
        `[onboarding] Completed for ${ctx.user.id}: ${JSON.stringify(ctx.data)}`,
      );
    },
  },
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
onboarding.attach(client);

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "onboard") {
    await onboarding.start(interaction);
  }
});

client.login(process.env.DISCORD_TOKEN);
