import type { Fingerprint } from './fingerprint';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const LLM_TIMEOUT_MS = 30_000;

/** How many candidates are described to the model. */
export const MAX_CANDIDATES_SENT = 5;

/** The model's answer. `index` is null when no candidate is clearly the same element. */
export type LlmPick = {
  index: number | null;
  confidence: number;
  reason: string;
};

/** Passed to Ollama's `format` field so the reply is valid JSON, not prose. */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    index: { type: ['integer', 'null'] },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['index', 'confidence', 'reason'],
};

const SYSTEM_PROMPT =
  'You match a saved UI element fingerprint to a list of candidate elements on a changed web page. ' +
  'Reply with the index of the candidate that is the SAME element the fingerprint describes. ' +
  'Return index null if no candidate is clearly the same element. Never guess: ' +
  'if you are unsure, return null with a low confidence. ' +
  'confidence is your certainty from 0 to 1. Keep reason under 25 words.';

function compact(fp: Fingerprint) {
  return {
    tag: fp.tag,
    type: fp.type,
    id: fp.id,
    name: fp.name,
    classes: fp.classes,
    text: fp.text,
    ariaLabel: fp.ariaLabel,
    role: fp.role,
    labelText: fp.labelText,
    placeholder: fp.placeholder,
    nearbyText: fp.nearbyText,
    position: { x: Math.round(fp.box.x), y: Math.round(fp.box.y) },
  };
}

/**
 * Ask the local model which candidate matches the fingerprint. Only fingerprints
 * are sent, never page HTML. Throws if Ollama is unreachable or answers unusably;
 * the caller turns that into a refusal.
 */
export async function askLlmToPick(
  fingerprint: Fingerprint,
  candidates: Fingerprint[]
): Promise<LlmPick> {
  const shortlist = candidates.slice(0, MAX_CANDIDATES_SENT);

  const userPrompt = JSON.stringify({
    savedFingerprint: compact(fingerprint),
    candidates: shortlist.map((c, index) => ({ index, ...compact(c) })),
  });

  // fetch has no built-in timeout, so enforce one.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        format: RESPONSE_SCHEMA,
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
  } catch (err) {
    const why = (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message;
    throw new Error(`Ollama at ${OLLAMA_URL} (model ${OLLAMA_MODEL}): ${why}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`Ollama at ${OLLAMA_URL}: HTTP ${response.status}`);
  }

  const body = (await response.json()) as { message?: { content?: string } };
  const content = body.message?.content;
  if (!content) {
    throw new Error(`Ollama at ${OLLAMA_URL}: empty response`);
  }

  let parsed: LlmPick;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Ollama returned unparsable JSON: ${content.slice(0, 200)}`);
  }

  // Normalise: the model may still return a float index or a non-numeric confidence.
  const index =
    typeof parsed.index === 'number' && Number.isFinite(parsed.index)
      ? Math.trunc(parsed.index)
      : null;

  return {
    index,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };
}

/** Exposed so log and error messages can name the server and model in use. */
export const llmConfig = { url: OLLAMA_URL, model: OLLAMA_MODEL };
