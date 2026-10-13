import { test, type Locator, type Page } from '@playwright/test';
import {
  captureFingerprint,
  loadFingerprint,
  saveFingerprint,
  scoreCandidate,
  type Fingerprint,
} from './fingerprint';
import { appendHealing } from './report';
import { askLlmToPick, llmConfig, MAX_CANDIDATES_SENT } from './llm';

const ORIGINAL_TIMEOUT_MS = 3000;

/** Minimum similarity before a candidate is trusted. */
export const HEAL_THRESHOLD = 0.7;

/** Minimum lead the best candidate must have over the runner-up. */
export const AMBIGUITY_MARGIN = 0.1;

/** Below this, nothing on the page resembles the element and the LLM is not asked. */
export const LLM_MIN_SCORE = 0.4;

/** Minimum confidence before the LLM's choice is acted on. */
export const LLM_MIN_CONFIDENCE = 0.8;

function llmEnabled(): boolean {
  return (process.env.SELF_HEAL_LLM || '').toLowerCase() !== 'off';
}

const CLICK_CANDIDATE_SELECTOR =
  'button, a, input[type=submit], input[type=button], [role=button]';
const FILL_CANDIDATE_SELECTOR = 'input, textarea';

type Candidate = {
  locator: Locator;
  fingerprint: Fingerprint;
  score: number;
};

/** Fingerprint and score every visible candidate, best first. */
async function collectCandidates(
  page: Page,
  selector: string,
  fingerprint: Fingerprint
): Promise<Candidate[]> {
  const all = page.locator(selector);
  const count = await all.count();
  const candidates: Candidate[] = [];

  for (let i = 0; i < count; i++) {
    const locator = all.nth(i);
    if (!(await locator.isVisible())) continue;
    const candidateFp = await captureFingerprint(locator);
    candidates.push({
      locator,
      fingerprint: candidateFp,
      score: scoreCandidate(fingerprint, candidateFp),
    });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

/** Build a selector a developer could paste into the test: unique #id, then role, then text. */
async function suggestSelector(page: Page, candidate: Candidate): Promise<string> {
  const fp = candidate.fingerprint;

  if (fp.id) {
    const sameId = await page.locator(`#${fp.id}`).count().catch(() => 0);
    if (sameId === 1) return `#${fp.id}`;
  }

  const accessibleName = fp.ariaLabel || fp.labelText || fp.text;
  if (fp.role && accessibleName) {
    return `getByRole('${fp.role}', { name: '${accessibleName}' })`;
  }

  if (fp.text) return `getByText('${fp.text}')`;

  return fp.tag;
}

/** Returns a reason string if the candidate is unsafe to act on, or null if it is safe. */
async function safetyCheck(
  fingerprint: Fingerprint,
  chosen: Candidate,
  allCandidates: Candidate[]
): Promise<string | null> {
  const fp = chosen.fingerprint;

  if (fp.tag !== fingerprint.tag) return `tag changed (${fingerprint.tag} -> ${fp.tag})`;
  if (fp.role !== fingerprint.role) return `role changed (${fingerprint.role} -> ${fp.role})`;
  if ((await chosen.locator.count()) !== 1) return 'locator does not resolve to exactly one element';

  const twins = allCandidates.filter(
    (c) =>
      c !== chosen &&
      c.fingerprint.tag === fp.tag &&
      c.fingerprint.role === fp.role &&
      c.fingerprint.text === fp.text &&
      c.fingerprint.id === fp.id
  );
  if (twins.length > 0) return 'another candidate is indistinguishable from this one';

  if (!(await chosen.locator.isVisible())) return 'element is not visible';
  if (!(await chosen.locator.isEnabled())) return 'element is not enabled';

  return null;
}

function describeTop(candidates: Candidate[]): string {
  if (candidates.length === 0) return '  (no candidate elements found on the page)';
  return candidates
    .slice(0, 3)
    .map((c, i) => {
      const fp = c.fingerprint;
      const label = fp.text || fp.labelText || fp.placeholder || fp.id || fp.tag;
      return `  ${i + 1}. <${fp.tag}> "${label}" id="${fp.id}" score=${c.score.toFixed(3)}`;
    })
    .join('\n');
}

/**
 * Try the original selector; if it is broken, heal by fingerprint, then by LLM
 * as a last resort. Healing only logs a suggestion - it never edits the test.
 */
async function smartAction(
  page: Page,
  key: string,
  selector: string,
  candidateSelector: string,
  action: (locator: Locator) => Promise<void>
): Promise<void> {
  try {
    const original = page.locator(selector);
    await original.waitFor({ state: 'visible', timeout: ORIGINAL_TIMEOUT_MS });
    // Capture before acting: a click may navigate away and detach the element.
    saveFingerprint(key, await captureFingerprint(original));
    await action(original);
    return;
  } catch (originalError) {
    const fingerprint = loadFingerprint(key);
    if (!fingerprint) throw originalError;

    const candidates = await collectCandidates(page, candidateSelector, fingerprint);
    const best = candidates[0];
    const runnerUp = candidates[1];

    const aboveThreshold = candidates.filter((c) => c.score >= HEAL_THRESHOLD);
    const topScore = best ? best.score : 0;
    const secondScore = runnerUp ? runnerUp.score : 0;
    const margin = topScore - secondScore;

    const confident = topScore >= HEAL_THRESHOLD;
    const unambiguous = margin >= AMBIGUITY_MARGIN;
    const exactlyOne = aboveThreshold.length === 1;
    const usable = best ? (await best.locator.isVisible()) && (await best.locator.isEnabled()) : false;
    const fingerprintOk = confident && unambiguous && exactlyOne && usable;

    const refusal =
      `Healing refused: no confident match for element "${key}" (original selector: ${selector}).\n` +
      `Checks -> topScore=${topScore.toFixed(3)} (need >= ${HEAL_THRESHOLD}), ` +
      `margin=${margin.toFixed(3)} (need >= ${AMBIGUITY_MARGIN}), ` +
      `matchesAboveThreshold=${aboveThreshold.length} (need exactly 1), ` +
      `visibleAndEnabled=${usable}.\n` +
      `Top candidates:\n${describeTop(candidates)}`;

    let chosen: Candidate;
    let method: 'fingerprint' | 'llm' = 'fingerprint';
    let reason: string | undefined;

    if (fingerprintOk) {
      chosen = best;
    } else {
      // The LLM is worth asking only when the score is plausible but not
      // convincing, or the top two are too close to separate.
      const inGreyBand = topScore >= LLM_MIN_SCORE && topScore < HEAL_THRESHOLD;
      const tooClose =
        candidates.length >= 2 && topScore >= LLM_MIN_SCORE && margin < AMBIGUITY_MARGIN;
      const unclear = candidates.length > 0 && (inGreyBand || tooClose);

      if (!unclear) {
        throw new Error(
          `${refusal}\nLLM fallback not applicable (topScore below ${LLM_MIN_SCORE} or no candidates).`
        );
      }
      if (!llmEnabled()) {
        throw new Error(`${refusal}\nLLM fallback disabled via SELF_HEAL_LLM=off.`);
      }

      console.log(
        `\n🤔 Unclear match for "${key}" (topScore ${topScore.toFixed(3)}, margin ${margin.toFixed(3)}).` +
          ` Asking ${llmConfig.model} at ${llmConfig.url}...`
      );

      let pick;
      try {
        pick = await askLlmToPick(fingerprint, candidates.map((c) => c.fingerprint));
      } catch (llmError) {
        // An unreachable model means refuse, never proceed.
        throw new Error(
          `Healing refused: LLM unavailable - ${(llmError as Error).message}\n${refusal}`
        );
      }

      const sentCount = Math.min(candidates.length, MAX_CANDIDATES_SENT);
      const indexValid =
        pick.index !== null &&
        Number.isInteger(pick.index) &&
        pick.index >= 0 &&
        pick.index < sentCount;

      if (!indexValid) {
        throw new Error(
          `${refusal}\nLLM declined to pick (index=${pick.index}, confidence=${pick.confidence}). ` +
            `LLM reason: ${pick.reason}`
        );
      }
      if (pick.confidence < LLM_MIN_CONFIDENCE) {
        throw new Error(
          `${refusal}\nLLM confidence ${pick.confidence} is below ${LLM_MIN_CONFIDENCE}. ` +
            `LLM reason: ${pick.reason}`
        );
      }

      // The model suggests; the safety checks still decide.
      const llmChoice = candidates[pick.index as number];
      const problem = await safetyCheck(fingerprint, llmChoice, candidates);
      if (problem) {
        throw new Error(
          `${refusal}\nLLM picked candidate ${pick.index} but it failed a safety check: ${problem}. ` +
            `LLM reason: ${pick.reason}`
        );
      }

      chosen = llmChoice;
      method = 'llm';
      reason = pick.reason;
    }

    // Build the suggestion before acting, since the action may navigate away.
    const suggested = await suggestSelector(page, chosen);
    await action(chosen.locator);

    appendHealing({
      timestamp: new Date().toISOString(),
      testTitle: test.info().title,
      elementKey: key,
      oldSelector: selector,
      suggestedNewSelector: suggested,
      score: Number(chosen.score.toFixed(3)),
      method,
      ...(reason ? { reason } : {}),
    });

    console.log(
      `\n🩹 HEALED "${key}": original selector "${selector}" no longer matches.\n` +
        `   Method: ${method}${method === 'llm' ? ` (${llmConfig.model})` : ''} (score ${chosen.score.toFixed(3)}).\n` +
        (reason ? `   LLM reason: ${reason}\n` : '') +
        `   Suggested new selector: ${suggested}\n` +
        `   Test code was NOT changed - update it yourself. See data/healing-report.json.\n`
    );

    saveFingerprint(key, chosen.fingerprint);
  }
}

/** Click an element, healing the locator if the selector broke. */
export async function smartClick(page: Page, key: string, selector: string): Promise<void> {
  await smartAction(page, key, selector, CLICK_CANDIDATE_SELECTOR, (l) => l.click());
}

/** Fill an input, healing the locator if the selector broke. */
export async function smartFill(
  page: Page,
  key: string,
  selector: string,
  value: string
): Promise<void> {
  await smartAction(page, key, selector, FILL_CANDIDATE_SELECTOR, (l) => l.fill(value));
}
