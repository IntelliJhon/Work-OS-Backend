import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';

/**
 * The Claude API client for Work OS's AI features (group summaries, the WhatsApp "Work OS AI" answers).
 * Requests that Claude's safety checks decline are re-run server-side on Anthropic's recommended fallback model.
 */

let client: Anthropic | null = null;

export const claudeAvailable = () => !!env.ANTHROPIC_API_KEY;

export function claude(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
  return client;
}

/** Fields every Work OS request carries: the model and the refusal fallback */
export const claudeDefaults = () => ({
  model: env.CLAUDE_MODEL,
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default' as const,
});

/** The answer's text blocks joined, or '' (also when Claude declined) */
export function replyText(message: Anthropic.Beta.BetaMessage): string {
  if (message.stop_reason === 'refusal') return '';
  return message.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('').trim();
}
