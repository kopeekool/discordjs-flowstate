/**
 * Example: a 3-question scored quiz with timeouts.
 *
 * Demonstrates dynamic transitions (computed `to`), per-state timeouts that
 * gracefully end the quiz, and FLOW_END with a final score render.
 */

import { ButtonStyle, Client, GatewayIntentBits } from "discord.js";

import { FLOW_END, FlowMachine } from "../src/index.js";

interface QuizCtx {
  index: number;
  score: number;
  answers: string[];
}

const QUESTIONS = [
  {
    prompt: "What does FSM stand for?",
    options: [
      { label: "Finite State Machine", value: "fsm", correct: true },
      { label: "Free Software Movement", value: "fs", correct: false },
      { label: "First Server Manager", value: "fsm2", correct: false },
    ],
  },
  {
    prompt: "Which discord.js version introduced slash commands?",
    options: [
      { label: "v12", value: "12", correct: false },
      { label: "v13", value: "13", correct: true },
      { label: "v14", value: "14", correct: false },
    ],
  },
  {
    prompt: "Maximum length of a component customId?",
    options: [
      { label: "32", value: "32", correct: false },
      { label: "100", value: "100", correct: true },
      { label: "256", value: "256", correct: false },
    ],
  },
];

const quiz = new FlowMachine<QuizCtx>({
  definition: {
    id: "quiz",
    initial: "ask",
    initialData: () => ({ index: 0, score: 0, answers: [] }),
    defaultTimeoutMs: 30_000,

    states: {
      ask: {
        ownerOnly: true,
        timeoutMs: 20_000,
        render: (ctx) => {
          const q = QUESTIONS[ctx.data.index]!;
          return {
            content: `**Question ${ctx.data.index + 1}/${QUESTIONS.length}**\n${q.prompt}`,
            components: quiz.rows(
              ...q.options.map((opt) =>
                quiz.button(ctx, {
                  trigger: `answer:${opt.value}`,
                  label: opt.label,
                  style: ButtonStyle.Secondary,
                }),
              ),
            ),
          };
        },
        on: {
          // Dynamic transition: compute the next state based on remaining questions.
          ...Object.fromEntries(
            QUESTIONS.flatMap((q, qIdx) =>
              q.options.map((opt) => [
                `answer:${opt.value}`,
                {
                  to: (ctx) =>
                    ctx.data.index + 1 >= QUESTIONS.length ? "result" : "ask",
                  action: (ctx) => {
                    ctx.data.answers.push(opt.value);
                    if (ctx.data.index === qIdx && opt.correct) {
                      ctx.data.score += 1;
                    }
                    ctx.data.index += 1;
                  },
                },
              ]),
            ),
          ),
          timeout: "result",
        },
      },

      result: {
        render: (ctx) => ({
          content: `You scored **${ctx.data.score}/${QUESTIONS.length}**.`,
          components: quiz.rows(
            quiz.button(ctx, {
              trigger: "done",
              label: "Close",
              style: ButtonStyle.Primary,
            }),
          ),
        }),
        on: { done: FLOW_END },
      },
    },
  },
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
quiz.attach(client);

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "quiz") {
    await quiz.start(interaction);
  }
});

client.login(process.env.DISCORD_TOKEN);
