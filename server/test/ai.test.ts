import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as z from 'zod/v4';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { activeAi, AiError, aiExtract, aiReadsPdf } from '../src/integrations/ai.js';

// Local stand-in for Groq's OpenAI-compatible chat API (no real calls in tests).
let stub: http.Server;
const seen: { body?: Record<string, unknown>; auth?: string } = {};
let reply: { status: number; body: unknown } = { status: 200, body: {} };
const mutable = env as unknown as Record<string, unknown>;

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      seen.body = JSON.parse(b);
      seen.auth = req.headers.authorization;
      res.statusCode = reply.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  mutable.GROQ_BASE_URL = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/openai/v1`;
  mutable.GROQ_API_KEY = 'gsk_test';
  mutable.ANTHROPIC_API_KEY = undefined;
  mutable.AI_PROVIDER = 'groq';
});
afterAll(() => {
  stub.close();
  for (const k of ['GROQ_API_KEY', 'AI_PROVIDER']) mutable[k] = undefined;
});

const schema = z.object({ total: z.number().int(), legible: z.boolean() });
const ok = (content: string, finish = 'stop') => ({ status: 200, body: { model: 'meta-llama/llama-4-scout-17b-16e-instruct', choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 900, completion_tokens: 40 } } });

describe('Groq as the AI provider', () => {
  it('is chosen in settings and cannot read PDFs', () => {
    expect(activeAi()).toEqual({ provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct' });
    expect(aiReadsPdf()).toBe(false);
  });

  it('sends the image and schema, and validates the JSON answer', async () => {
    reply = ok('{"total": 412, "legible": true}');
    const r = await aiExtract({ system: 'Read the form.', parts: [{ kind: 'image', mime: 'image/png', data: 'aGVsbG8=' }, { kind: 'text', text: 'Station 001' }], schema });
    expect(r).toMatchObject({ status: 'OK', provider: 'groq', data: { total: 412, legible: true }, usage: { inputTokens: 900, outputTokens: 40 } });
    expect(seen.auth).toBe('Bearer gsk_test');
    const msgs = seen.body!.messages as { role: string; content: unknown }[];
    expect(msgs[0]!.content).toContain('JSON Schema');
    expect(msgs[1]!.content).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }, { type: 'text', text: 'Station 001' }]);
    expect(seen.body!.response_format).toEqual({ type: 'json_object' });
    expect(seen.body!.temperature).toBe(0);
  });

  it('rejects answers that do not match the schema, invalid JSON and cut-off answers', async () => {
    reply = ok('{"total": "four hundred", "legible": true}');
    expect((await aiExtract({ system: 's', parts: [{ kind: 'text', text: 't' }], schema })).status).toBe('INVALID');
    reply = ok('not json');
    expect((await aiExtract({ system: 's', parts: [{ kind: 'text', text: 't' }], schema })).status).toBe('INVALID');
    reply = ok('{"total": 1', 'length');
    expect((await aiExtract({ system: 's', parts: [{ kind: 'text', text: 't' }], schema })).status).toBe('TRUNCATED');
  });

  it('explains bad keys, rate limits and PDF input', async () => {
    reply = { status: 401, body: { error: { message: 'Invalid API Key' } } };
    await expect(aiExtract({ system: 's', parts: [{ kind: 'text', text: 't' }], schema })).rejects.toThrow('Groq API key is invalid');
    reply = { status: 429, body: {} };
    await expect(aiExtract({ system: 's', parts: [{ kind: 'text', text: 't' }], schema })).rejects.toThrow(/rate limit/);
    await expect(aiExtract({ system: 's', parts: [{ kind: 'pdf', data: 'JVBERi0=' }], schema })).rejects.toBeInstanceOf(AiError);
  });

  it('is off when the chosen provider has no key', () => {
    mutable.GROQ_API_KEY = undefined;
    expect(activeAi()).toBeNull();
    mutable.GROQ_API_KEY = 'gsk_test';
  });
});
