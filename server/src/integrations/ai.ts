import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { setting } from '../modules/settings/service.js';

/**
 * One way to ask an AI model for structured data, whichever provider the administrator chose in
 * Settings (Anthropic Claude or Groq). Every answer is validated against the zod schema here; the
 * callers treat it as advisory and people confirm it.
 */
export type AiProvider = 'anthropic' | 'groq';
export type AiPart = { kind: 'image'; mime: 'image/jpeg' | 'image/png' | 'image/webp'; data: string } | { kind: 'pdf'; data: string } | { kind: 'text'; text: string };
export type AiResult<T> =
  | { status: 'OK'; data: T; provider: AiProvider; model: string; usage?: { inputTokens: number; outputTokens: number } }
  | { status: 'REFUSED' | 'INVALID' | 'TRUNCATED'; message: string; provider: AiProvider; model: string; usage?: { inputTokens: number; outputTokens: number } };

/** Thrown for problems reaching the provider (credentials, rate limits, network, unsupported input). */
export class AiError extends Error {}


export function activeAi(): { provider: AiProvider; model: string } | null {
  const chosen = setting('AI_PROVIDER') as AiProvider | undefined;
  const has = { anthropic: Boolean(setting('ANTHROPIC_API_KEY')), groq: Boolean(setting('GROQ_API_KEY')) };
  const provider = chosen ? (has[chosen] ? chosen : null) : has.anthropic ? 'anthropic' : has.groq ? 'groq' : null;
  if (!provider) return null;
  return { provider, model: provider === 'anthropic' ? setting('FORM_EXTRACTION_MODEL') ?? 'claude-opus-5-5' : setting('GROQ_MODEL') ?? 'meta-llama/llama-4-scout-17b-16e-instruct' };
}
export const aiEnabled = () => activeAi() !== null;
/** Groq's chat API takes images and text but not PDF documents. */
export const aiReadsPdf = () => activeAi()?.provider === 'anthropic';
export const aiLabel = () => {
  const a = activeAi();
  return a ? `${a.provider === 'anthropic' ? 'Anthropic' : 'Groq'} · ${a.model}` : null;
};

let anthropic: { key: string; client: Anthropic } | undefined;
function anthropicClient(key: string) {
  if (anthropic?.key !== key) anthropic = { key, client: new Anthropic({ apiKey: key, timeout: 180_000, maxRetries: 2 }) };
  return anthropic.client;
}

export async function aiExtract<S extends z.ZodType>(opts: { system: string; parts: AiPart[]; schema: S; maxTokens?: number; effort?: 'low' | 'medium' | 'high' }): Promise<AiResult<z.infer<S>>> {
  const ai = activeAi();
  if (!ai) throw new AiError('AI reading is not set up. Add an Anthropic or Groq API key under Settings → AI reading.');
  return ai.provider === 'anthropic' ? viaAnthropic(ai.model, opts) : viaGroq(ai.model, opts);
}

async function viaAnthropic<S extends z.ZodType>(model: string, opts: { system: string; parts: AiPart[]; schema: S; maxTokens?: number; effort?: 'low' | 'medium' | 'high' }): Promise<AiResult<z.infer<S>>> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = opts.parts.map((p) =>
    p.kind === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data } }
      : p.kind === 'image'
        ? { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }
        : { type: 'text', text: p.text }
  );
  try {
    const params = {
      model,
      max_tokens: opts.maxTokens ?? 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default' as const,
      output_config: { effort: opts.effort ?? 'high', format: betaZodOutputFormat(opts.schema) },
      system: opts.system,
      messages: [{ role: 'user' as const, content }]
    };
    const client = anthropicClient(setting('ANTHROPIC_API_KEY')!);
    // Long answers are streamed so the request does not hit HTTP timeouts.
    const msg = params.max_tokens > 16000 ? await client.beta.messages.stream(params).finalMessage() : await client.beta.messages.parse(params);
    const usage = { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens };
    const base = { provider: 'anthropic' as const, model: msg.model ?? model, usage };
    if (msg.stop_reason === 'refusal') return { ...base, status: 'REFUSED', message: 'The AI model declined this request.' };
    if (msg.stop_reason === 'max_tokens') return { ...base, status: 'TRUNCATED', message: 'The answer was too long and was cut off.' };
    if (!msg.parsed_output) return { ...base, status: 'INVALID', message: 'The AI response could not be read as structured data.' };
    return { ...base, status: 'OK', data: msg.parsed_output as z.infer<S> };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new AiError('The Anthropic API key is invalid.');
    if (err instanceof Anthropic.RateLimitError) throw new AiError('The AI service is busy; try again shortly.');
    if (err instanceof Anthropic.APIError) {
      logger.warn({ status: err.status }, 'Anthropic request failed');
      throw new AiError(`The AI service returned an error (${err.status ?? 'network'}).`);
    }
    throw err;
  }
}

interface GroqResponse { model?: string; choices?: { message?: { content?: string | null }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } }

async function viaGroq<S extends z.ZodType>(model: string, opts: { system: string; parts: AiPart[]; schema: S; maxTokens?: number }): Promise<AiResult<z.infer<S>>> {
  if (opts.parts.some((p) => p.kind === 'pdf')) throw new AiError('Groq cannot read PDF files. Upload a photo (JPEG, PNG or WebP) instead, paste the text, or switch AI reading to Anthropic in Settings.');
  const jsonSchema = JSON.stringify(z.toJSONSchema(opts.schema));
  const hasImage = opts.parts.some((p) => p.kind === 'image');
  const userContent = hasImage
    ? opts.parts.map((p) => (p.kind === 'image' ? { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } } : { type: 'text', text: (p as { text: string }).text }))
    : opts.parts.map((p) => (p as { text: string }).text).join('\n\n');
  let res: Response;
  try {
    res = await fetch(`${env.GROQ_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${setting('GROQ_API_KEY')}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model,
        temperature: 0,
        max_completion_tokens: Math.min(opts.maxTokens ?? 8192, 8192),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${opts.system}\n\nAnswer with one JSON object only, matching this JSON Schema exactly:\n${jsonSchema}` },
          { role: 'user', content: userContent }
        ]
      })
    });
  } catch (err) {
    throw new AiError(`Could not reach Groq (${(err as Error).message}).`);
  }
  const body = (await res.json().catch(() => ({}))) as GroqResponse;
  if (res.status === 401 || res.status === 403) throw new AiError('The Groq API key is invalid.');
  if (res.status === 429) throw new AiError('Groq is busy or the rate limit was reached; try again shortly.');
  if (!res.ok) {
    logger.warn({ status: res.status }, 'Groq request failed');
    throw new AiError(`Groq returned an error (${res.status})${body.error?.message ? `: ${body.error.message.slice(0, 200)}` : ''}.`);
  }
  const usage = { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 };
  const base = { provider: 'groq' as const, model: body.model ?? model, usage };
  const choice = body.choices?.[0];
  if (choice?.finish_reason === 'length') return { ...base, status: 'TRUNCATED', message: 'The answer was too long and was cut off.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(choice?.message?.content ?? '');
  } catch {
    return { ...base, status: 'INVALID', message: 'The AI response was not valid JSON.' };
  }
  const checked = opts.schema.safeParse(parsed);
  if (!checked.success) return { ...base, status: 'INVALID', message: 'The AI response did not match the expected structure.' };
  return { ...base, status: 'OK', data: checked.data as z.infer<S> };
}

/** Settings → Test: a tiny request to check the key and model. */
export async function testAi() {
  const r = await aiExtract({ system: 'You are a connectivity check.', parts: [{ kind: 'text', text: 'Reply with ok set to true.' }], schema: z.object({ ok: z.boolean() }), maxTokens: 2000, effort: 'low' });
  if (r.status !== 'OK') throw new AiError(r.message);
  return aiLabel();
}
