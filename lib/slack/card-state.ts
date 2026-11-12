import { z } from 'zod';

// Slack's own copy of a message. A card has an `actions` block while it shows buttons.
const slackMessageSchema = z.object({
  blocks: z.array(z.object({ type: z.string(), elements: z.array(z.object({ action_id: z.string().optional() })).optional() })).optional(),
});

const actionIds = (raw: unknown): string[] | null => {
  const parsed = slackMessageSchema.safeParse(raw);
  if (!parsed.success) return null;
  return (parsed.data.blocks ?? [])
    .filter((block) => block.type === 'actions')
    .flatMap((block) => block.elements ?? [])
    .map((e) => e.action_id ?? '');
};

/** True when a raw Slack message still shows buttons. Anything unreadable counts as closed. */
export function hasButtons(raw: unknown): boolean {
  const parsed = slackMessageSchema.safeParse(raw);
  return parsed.success && (parsed.data.blocks ?? []).some((block) => block.type === 'actions');
}

/** True when a raw Slack message still shows the button with this action id. */
export function hasButton(raw: unknown, actionId: string): boolean {
  return actionIds(raw)?.includes(actionId) ?? false;
}
