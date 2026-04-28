# Examples

Each example is a runnable TypeScript file. Set `DISCORD_TOKEN` and run:

```bash
pnpm tsx examples/onboarding.ts
```

Register the matching slash command (`/onboard`, `/quiz`, `/ticket`) on your
guild using your favorite registration script. The flow library itself does
not register commands — it only handles their lifecycle once invoked.

| File              | Demonstrates                                              |
| ----------------- | --------------------------------------------------------- |
| `onboarding.ts`   | Modals, select menus, button flows, owner-only states     |
| `quiz.ts`         | Dynamic transitions, scoring, timeouts                    |
| `ticket.ts`       | Sub-flow composition (`flow:<id>` transitions)            |
