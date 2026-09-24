/**
 * Translation endpoints.
 *
 * The Android client calls this instead of any provider directly, so no provider
 * key is ever embedded in an APK. The request runs through the same AUTO router
 * as the rest of the studio, which means FREE_ONLY and provider failover apply
 * here too.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate, HttpError } from '../middleware/validate.ts';
import { requireAuth } from '../middleware/auth.ts';
import { aiRouter } from '../services/aiProvider.ts';
import { logger, redact } from '../lib/logger.ts';

const router = Router();

/** Guard rails so a runaway client cannot burn the free quota with one request. */
const MAX_TEXT_LENGTH = 4000;

const requestSchema = z.object({
  text: z.string().min(1, 'text must not be empty').max(MAX_TEXT_LENGTH, `text must be at most ${MAX_TEXT_LENGTH} characters`),
  /** BCP-47-ish language name or code; free-form because providers accept both. */
  source: z.string().min(1).max(64).optional(),
  target: z.string().min(1).max(64).optional(),
  /** Optional register/context hint, e.g. "chat message". */
  context: z.string().max(200).optional(),
});

/**
 * Language names are passed straight into the prompt. They are user input, so
 * they are stripped of the characters that would let a caller rewrite the
 * instructions rather than describe a language.
 */
function safeLanguage(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const cleaned = value.replace(/[\r\n"`\\]/g, ' ').trim().slice(0, 64);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function buildPrompt(text: string, source: string, target: string, context?: string): string {
  const lines = [
    `Translate the text between the markers from ${source} into ${target}.`,
    'Output only the translation. Do not add explanations, quotes, notes or alternatives.',
    'Preserve the original meaning, tone, punctuation and emoji.',
    'Keep proper nouns, numbers and URLs unchanged.',
  ];
  if (context) lines.push(`Context: ${context}.`);
  lines.push('<<<TEXT', text, 'TEXT>>>');
  return lines.join('\n');
}

/**
 * Providers sometimes wrap the answer in quotes or prefix it with a label even
 * when told not to. The translation is the content, so unwrap the common cases
 * rather than shipping `"Bonjour"` or `Translation: Bonjour` to the phone.
 */
export function cleanTranslation(raw: string): string {
  let out = raw.trim();
  out = out.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  out = out.replace(/^(translation|traduction|translated text)\s*:\s*/i, '').trim();
  const pairs: Array<[string, string]> = [['"', '"'], ['“', '”'], ["'", "'"], ['«', '»']];
  for (const [open, close] of pairs) {
    if (out.length >= 2 && out.startsWith(open) && out.endsWith(close)) {
      out = out.slice(open.length, out.length - close.length).trim();
    }
  }
  return out;
}

router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const body = validate(requestSchema, req.body);
  const source = safeLanguage(body.source, 'auto-detected language');
  const target = safeLanguage(body.target, 'English');

  const outcome = await aiRouter.chat('auto', {
    messages: [
      { role: 'system', content: 'You are a translation engine. You reply with the translation only.' },
      { role: 'user', content: buildPrompt(body.text, source, target, body.context) },
    ],
    temperature: 0,
    // Translation length tracks the input; the cap only stops a runaway answer.
    maxTokens: Math.min(2048, Math.max(256, body.text.length * 2)),
    timeoutMs: 30_000,
  });

  if (!outcome.ok) {
    // A provider failure is reported as a failure. It is never answered with the
    // source text dressed up as a translation.
    logger.warn('translation failed', { kind: outcome.kind, attempts: outcome.attempts.length });
    res.status(502).json({
      ok: false,
      error: 'translation_failed',
      kind: outcome.kind,
      // The per-provider trail is what makes a failed translation debuggable:
      // which providers were tried, and what each answered.
      attempts: outcome.attempts.map((a) => ({
        provider: a.provider,
        model: a.model,
        outcome: a.outcome,
        status: a.status ?? null,
        kind: a.kind ?? null,
      })),
      message: redact(outcome.message).slice(0, 300),
    });
    return;
  }

  const translation = cleanTranslation(outcome.content);
  if (translation.length === 0) {
    throw new HttpError(502, 'the provider returned no translation', 'empty_translation');
  }

  res.json({
    ok: true,
    translation,
    source,
    target,
    provider: outcome.provider,
    model: outcome.model,
    failoverFrom: outcome.failoverFrom ?? null,
    usage: outcome.usage,
  });
}));

export default router;
