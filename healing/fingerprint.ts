import fs from 'fs';
import path from 'path';
import type { Locator } from '@playwright/test';

/** Scoring weights, summing to 1.00 so a perfect match scores 1.00. */
export const W_TEXT = 0.30;          // visible text
export const W_LABEL = 0.15;         // <label> text or aria-label
export const W_ID_NAME = 0.10;       // id / name attributes
export const W_CLASSES = 0.05;       // css classes
export const W_POSITION = 0.10;      // on-page position
export const W_NEARBY = 0.10;        // closest heading/label
export const W_TAG_ROLE_TYPE = 0.20; // structural kind of element

const DATA_DIR = path.join(__dirname, '..', 'data');
const FINGERPRINTS_FILE = path.join(DATA_DIR, 'fingerprints.json');

/** The attributes we remember about one element. */
export type Fingerprint = {
  tag: string;
  type: string;
  id: string;
  name: string;
  classes: string[];
  text: string;
  ariaLabel: string;
  role: string;
  labelText: string;
  placeholder: string;
  parentTag: string;
  nearbyText: string;
  box: { x: number; y: number; width: number; height: number };
};

/** Record an element's identifying attributes in a single browser round trip. */
export async function captureFingerprint(locator: Locator): Promise<Fingerprint> {
  return await locator.evaluate((el: Element) => {
    const htmlEl = el as HTMLElement;
    const input = el as HTMLInputElement;

    let labelText = '';
    if (input.id) {
      const lbl = document.querySelector(`label[for="${input.id}"]`);
      if (lbl) labelText = (lbl.textContent || '').trim();
    }
    if (!labelText) {
      const wrapping = el.closest('label');
      if (wrapping) labelText = (wrapping.textContent || '').trim();
    }

    // Walk up until a heading or label is found, to anchor the element in context.
    let nearbyText = '';
    let node: Element | null = el;
    while (node && !nearbyText) {
      const heading = node.parentElement?.querySelector('h1, h2, h3, label');
      if (heading) nearbyText = (heading.textContent || '').trim();
      node = node.parentElement;
    }

    const rect = htmlEl.getBoundingClientRect();

    return {
      tag: el.tagName.toLowerCase(),
      type: input.type || '',
      id: el.id || '',
      name: input.name || '',
      classes: Array.from(el.classList),
      text: (htmlEl.innerText || htmlEl.textContent || '').trim(),
      ariaLabel: el.getAttribute('aria-label') || '',
      role:
        el.getAttribute('role') ||
        (el.tagName === 'BUTTON'
          ? 'button'
          : el.tagName === 'A'
          ? 'link'
          : el.tagName === 'INPUT'
          ? input.type === 'password'
            ? 'textbox'
            : input.type === 'submit' || input.type === 'button'
            ? 'button'
            : 'textbox'
          : el.tagName === 'TEXTAREA'
          ? 'textbox'
          : ''),
      labelText,
      placeholder: input.placeholder || '',
      parentTag: el.parentElement ? el.parentElement.tagName.toLowerCase() : '',
      nearbyText,
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });
}

/** Read the whole fingerprint store, or an empty store if there is no file yet. */
export function loadFingerprints(): Record<string, Fingerprint> {
  if (!fs.existsSync(FINGERPRINTS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(FINGERPRINTS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Read one fingerprint by element key, e.g. "loginButton". */
export function loadFingerprint(key: string): Fingerprint | undefined {
  return loadFingerprints()[key];
}

/** Store or refresh one fingerprint under its element key. */
export function saveFingerprint(key: string, fp: Fingerprint): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const all = loadFingerprints();
  all[key] = fp;
  fs.writeFileSync(FINGERPRINTS_FILE, JSON.stringify(all, null, 2));
}

function equalText(a: string, b: string): number {
  const na = a.trim().toLowerCase().replace(/\s+/g, ' ');
  const nb = b.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  return na === nb ? 1 : 0;
}

/** Token overlap, so "login-btn" and "signin-btn" still share "btn". */
function tokenSimilarity(a: string, b: string): number {
  const split = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const ta = split(a);
  const tb = split(b);
  if (ta.length === 0 && tb.length === 0) return 1;
  if (ta.length === 0 || tb.length === 0) return 0;
  const shared = ta.filter((t) => tb.includes(t)).length;
  return shared / Math.max(ta.length, tb.length);
}

function classSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const shared = a.filter((c) => b.includes(c)).length;
  const union = new Set([...a, ...b]).size;
  return shared / union;
}

/** Full credit within 50px, fading to zero at 400px, so elements can be nudged. */
function positionSimilarity(a: Fingerprint['box'], b: Fingerprint['box']): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance <= 50) return 1;
  if (distance >= 400) return 0;
  return 1 - (distance - 50) / 350;
}

/** Weighted similarity from 0 to 1 between a stored fingerprint and a candidate. */
export function scoreCandidate(fingerprint: Fingerprint, candidate: Fingerprint): number {
  // A different tag or role is a different kind of element, never a heal target.
  if (fingerprint.tag !== candidate.tag) return 0;
  if (fingerprint.role !== candidate.role) return 0;

  const typeMatch = fingerprint.type === candidate.type ? 1 : 0;
  const structural = (1 + 1 + typeMatch) / 3;

  const labelScore = Math.max(
    equalText(fingerprint.labelText, candidate.labelText),
    equalText(fingerprint.ariaLabel, candidate.ariaLabel)
  );

  const idNameScore =
    (tokenSimilarity(fingerprint.id, candidate.id) +
      tokenSimilarity(fingerprint.name, candidate.name)) /
    2;

  return (
    W_TEXT * equalText(fingerprint.text, candidate.text) +
    W_LABEL * labelScore +
    W_ID_NAME * idNameScore +
    W_CLASSES * classSimilarity(fingerprint.classes, candidate.classes) +
    W_POSITION * positionSimilarity(fingerprint.box, candidate.box) +
    W_NEARBY * equalText(fingerprint.nearbyText, candidate.nearbyText) +
    W_TAG_ROLE_TYPE * structural
  );
}
