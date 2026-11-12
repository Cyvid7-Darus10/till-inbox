import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts'],
      // Glue around Slack, the model and Airwallex's MCP client. The flow they plug into is tested
      // with fakes; the glue itself is covered by the live runs described in the README.
      exclude: ['lib/slack/bot.ts', 'lib/slack/cards.tsx', 'lib/agent/**', 'lib/airwallex/session.ts', 'lib/airwallex/payments.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
