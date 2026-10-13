import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(__dirname, '..', 'data');
const REPORT_FILE = path.join(DATA_DIR, 'healing-report.json');

/** One healing event. A suggestion only - test code is never edited. */
export type HealingEntry = {
  timestamp: string;
  testTitle: string;
  elementKey: string;
  oldSelector: string;
  suggestedNewSelector: string;
  score: number;
  /** "fingerprint" = scored locally; "llm" = the local model broke the tie. */
  method: 'fingerprint' | 'llm';
  /** The model's explanation, set only when method is "llm". */
  reason?: string;
};

/** Append one entry to data/healing-report.json, creating the file if needed. */
export function appendHealing(entry: HealingEntry): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  let entries: HealingEntry[] = [];
  if (fs.existsSync(REPORT_FILE)) {
    try {
      entries = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
    } catch {
      entries = []; // a corrupt report must not fail the test run
    }
  }

  entries.push(entry);
  fs.writeFileSync(REPORT_FILE, JSON.stringify(entries, null, 2));
}
