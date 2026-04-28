/**
 * Example: a simple support-ticket triage flow demonstrating sub-flows.
 *
 * - Root flow asks the user to choose a category.
 * - Each category transitions into a sub-flow specialized for that category.
 *
 * This is the cleanest way to keep large bots organized — each support team
 * owns its own FlowMachine.
 */

import { ButtonStyle, Client, GatewayIntentBits } from "discord.js";

import { FLOW_END, FlowMachine } from "../src/index.js";

interface RootCtx {
  category?: "billing" | "bug" | "feature";
}

interface BillingCtx {
  invoiceId?: string;
}

const billingFlow = new FlowMachine<BillingCtx>({
  definition: {
    id: "billing",
    initial: "askInvoice",
    initialData: () => ({}),
    states: {
      askInvoice: {
        render: (ctx) => ({
          content: "Please share your invoice id.",
          components: billingFlow.rows(
            billingFlow.button(ctx, {
              trigger: "done",
              label: "I don't have one",
              style: ButtonStyle.Secondary,
            }),
          ),
        }),
        on: { done: FLOW_END },
      },
    },
  },
});

const root = new FlowMachine<RootCtx>({
  definition: {
    id: "ticket",
    initial: "menu",
    initialData: () => ({}),
    states: {
      menu: {
        render: (ctx) => ({
          content: "What do you need help with?",
          components: root.rows(
            root.button(ctx, {
              trigger: "billing",
              label: "Billing",
              style: ButtonStyle.Primary,
            }),
            root.button(ctx, {
              trigger: "bug",
              label: "Report a bug",
              style: ButtonStyle.Danger,
            }),
            root.button(ctx, {
              trigger: "feature",
              label: "Feature request",
              style: ButtonStyle.Success,
            }),
          ),
        }),
        on: {
          billing: "flow:billing", // hand off to the billing sub-flow
          bug: "bugAck",
          feature: "featureAck",
        },
      },
      bugAck: {
        render: () => "Thanks — please describe the bug in this channel.",
        on: { enter: FLOW_END },
      },
      featureAck: {
        render: () => "Awesome — drop your idea below and we'll review it.",
        on: { enter: FLOW_END },
      },
    },
  },
});

root.registerSubFlow(billingFlow as FlowMachine<unknown>);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
root.attach(client);
billingFlow.attach(client);

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "ticket") {
    await root.start(interaction);
  }
});

client.login(process.env.DISCORD_TOKEN);
