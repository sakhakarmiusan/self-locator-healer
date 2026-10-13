# Self-healing locators in Playwright (no LLM)

A tiny learning project: a plain login page plus Playwright tests that survive
locator changes by matching **element fingerprints** instead of only selectors.

## Run

One-time setup:

```bash
npm install
npx playwright install chromium
```

**Start the site server yourself** (terminal 1 — leave it running):

```bash
npm run site        # same as: node site-server.js
```

It serves `site/` on http://localhost:3000. Stop it with Ctrl+C.

Then run the tests (terminal 2):

```bash
npm test            # headless
npm run test:headed # watch it in a browser
npm run report:heal # print data/healing-report.json
```

Playwright does **not** start or stop the site server — `playwright.config.ts`
has no `webServer` block on purpose. If the server is not running, the tests
fail with `net::ERR_CONNECTION_REFUSED`.

## Debug mode

The site server must already be running (`npm run site`) for all of these.

```bash
npm run test:debug   # Playwright Inspector: step through, headed, timeouts off
npm run test:ui      # UI mode: watch, time-travel, DOM snapshot per step
```

`--debug` opens the **Playwright Inspector**: the browser is visible, the run
pauses before the first action, and you step with *Step over* / *Resume*. It
also disables the test timeout, so you can sit on a breakpoint as long as you
like. `--ui` opens **UI mode**, which is usually the nicer one for this project
— you get a snapshot of the page at every step, so you can see exactly what the
login page looked like when healing kicked in.

Useful variations (all work with `npx playwright test`):

```bash
# debug ONE test. Easiest and least surprising: point at its line number.
npx playwright test --debug tests/login.spec.ts:9    # valid login
npx playwright test --debug tests/login.spec.ts:19   # invalid login

# -g also works, but it is a substring match - "valid login" also matches
# "invalid login", so pick a phrase unique to the one test you want.
npx playwright test --debug -g "goes to the dashboard"

# pause at a chosen point instead of the start: add await page.pause()
# inside the test, then run headed
npx playwright test --headed

# log every Playwright API call - handy for seeing which locator actually failed
DEBUG=pw:api npx playwright test

# keep a trace, then open it after the run
npx playwright test --trace on
npx playwright show-trace test-results/<folder>/trace.zip
```

### Debugging the healing itself

The healing modules print to stdout, and those lines show up in the Inspector's
terminal as usual:

- `🤔 Unclear match ... Asking <model>` — the LLM fallback was triggered
- `🩹 HEALED "<key>" ... Method: fingerprint | llm` — which path healed it
- `Healing refused: ...` — the scores that caused the refusal

Two things to expect while stepping:

- The original selector still has its own 3 s wait (`ORIGINAL_TIMEOUT_MS`), so a
  broken locator takes ~3 s to fall through to healing even in debug mode.
  `--debug` removes the *test* timeout, not this one.
- Stepping through a heal still writes to `data/fingerprints.json` and
  `data/healing-report.json`. If you are experimenting, delete
  `data/healing-report.json` between runs to keep it readable.

## How healing works

`smartClick` / `smartFill` first try the original selector (3s timeout).
If it fails, they load the saved fingerprint for that element key, fingerprint
every visible candidate on the page, and score each one (0–1) on text, label,
id/name, classes, position, nearby text and tag/role/type.

Healing happens only if **all** of these hold:

- top score >= `HEAL_THRESHOLD` (0.70)
- top score − second score >= `AMBIGUITY_MARGIN` (0.10)
- exactly one candidate is above the threshold
- that candidate is visible and enabled

A candidate whose tag or role differs from the fingerprint is rejected outright.
If the checks fail, the test throws an error starting with `Healing refused:`,
so genuinely missing elements still fail the test.

**Healing never edits your test code or selectors** — it only logs a suggestion.

## Try breaking a locator

Edit `site/login.html` by hand and re-run `npm test`:

- change `id="login-btn"` to `id="signin-btn"` → healing kicks in
- rename a class, change the placeholder, move a field up or down
- delete the Log in button entirely → the test fails with `Healing refused:`

## LLM fallback (local Ollama)

When fingerprint scoring is *unclear*, a local Ollama model gets a second
opinion. It is a fallback only — a clear fingerprint match never calls it.

### Setup

```bash
brew install ollama        # or https://ollama.com/download
ollama pull qwen2.5:7b     # the default model (one time, ~4.7 GB)
```

Start it yourself when you want the LLM fallback (terminal 3):

```bash
ollama serve               # serves on :11434, Ctrl+C to stop
```

Nothing starts Ollama automatically. If it is not running, unclear cases fail
with `Healing refused: LLM unavailable`, which is the intended safe behavior.
To run without it at all, use `SELF_HEAL_LLM=off npm test`.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server. Point at a wrong port to test the outage path. |
| `OLLAMA_MODEL` | `qwen2.5:7b` | Which local model to ask. |
| `SELF_HEAL_LLM` | (unset = on) | Set to `off` to skip the LLM step entirely. |

```bash
SELF_HEAL_LLM=off npm test              # fingerprint-only
OLLAMA_MODEL=qwen2.5vl:3b npm test      # different local model
```

### When the LLM is used

The LLM is asked **only** when fingerprint healing failed *and* one of these holds:

- the top score sits in the grey band `0.40 <= score < 0.70` (plausible, not convincing), or
- the top two candidates are within `AMBIGUITY_MARGIN` (0.10) of each other.

A top score below `LLM_MIN_SCORE` (0.40), or no candidates at all (e.g. the
element was deleted), refuses immediately — the model is never asked to invent
a match.

### What is sent

Only the saved fingerprint and the **top 5 candidate fingerprints** as compact
JSON (tag, type, id, name, classes, text, aria-label, role, label, placeholder,
nearby text, rounded position). **The page HTML is never sent.**
The reply is constrained by a JSON schema to
`{ "index": number|null, "confidence": 0..1, "reason": string }`,
with `stream: false`, `temperature: 0` and a 30 s timeout.

### What the LLM is *not* allowed to do

Its pick is a suggestion, not an override. The choice is accepted only if:

- the index is valid, and `confidence >= 0.80`, **and**
- it passes the same safety checks as any heal: same tag and role, the locator
  resolves to exactly one element, no indistinguishable twin candidate, visible,
  and enabled.

Anything else throws `Healing refused:` including the model's own reason.
If Ollama is unreachable or times out, the test fails with
`Healing refused: LLM unavailable` — an unavailable model never means "go ahead".
Entries healed this way appear in the report with `"method": "llm"` and a `reason`.

## Where data lives

- `data/fingerprints.json` — the learned fingerprint per element key
  (`usernameInput`, `passwordInput`, `loginButton`). Refreshed on every
  successful action.
- `data/healing-report.json` — one entry per heal: timestamp, test title,
  element key, old selector, suggested new selector, score, method.
