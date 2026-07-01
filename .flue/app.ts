/**
 * Flue app entry — registers an Anthropic-compatible gateway as the
 * "anthropic" provider, then exposes a Hono app with the flue router.
 *
 * Reads baseUrl/authToken from env so the same code works against real
 * Anthropic (env unset) or an internal proxy (env set).
 */
import { registerProvider } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

if (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_AUTH_TOKEN) {
  // Internal gateway — treat ANTHROPIC_AUTH_TOKEN as the api key for the
  // "anthropic" provider. Flue's model specifier (`anthropic/claude-sonnet-4-6`)
  // routes here unchanged.
  registerProvider('anthropic', {
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
  });
}

const app = new Hono();
app.route('/', flue());

export default app;