/**
 * The in-page half of WPM typing simulation. Runs as ONE async
 * Runtime.evaluate (awaitPromise) on the target page: types the text into
 * the FOCUSED editable element keystroke by keystroke, with per-key delays
 * derived from the requested words-per-minute plus human jitter.
 *
 * Why one evaluate instead of driving Input.dispatchKeyEvent from the API:
 * the same values-in/page-out-only discipline as the other autofill actions,
 * no dependence on OS-level focus (works on headless targets too), and the
 * page's own event handlers see a realistic input/change sequence through
 * the native value setter — the only approach that wakes React/Vue
 * controlled components.
 *
 * Delay model: WPM assumes 5 chars per word, so base ms/keystroke =
 * 60000 / (wpm * 5). Jitter is ±35% per key; keys after a space or comma
 * pause ~2.2x (finger repositioning); a random 120–400 ms micro-pause lands
 * after every 8–25 keystrokes. The result reports how many characters were
 * typed and how long it took — never the text itself (it already went IN).
 */

export interface TypingResult {
  /** Characters actually typed. */
  typed: number;
  /** Wall-clock ms the typing took. */
  ms: number;
  /** Set when there was no editable focused element — nothing was typed. */
  error: string | null;
}

export const TYPING_DEFAULT_WPM = 60;
export const TYPING_MIN_WPM = 20;
export const TYPING_MAX_WPM = 400;

/** Build the typing expression. `text` is JSON-inlined. */
export function buildTypingExpression(text: string, wpm: number): string {
  return `(async () => {
  const text = ${JSON.stringify(text)};
  const wpm = ${JSON.stringify(wpm)};
  const el = document.activeElement;
  const editable =
    el &&
    (el.tagName === "INPUT" || el.tagName === "TEXTAREA"
      ? el.type !== "hidden" && !el.disabled && !el.readOnly
      : el.isContentEditable);
  if (!editable) {
    return { typed: 0, ms: 0, error: "no-focused-field" };
  }

  const isText = el.tagName === "TEXTAREA";
  const setter =
    isText || el.tagName === "INPUT"
      ? Object.getOwnPropertyDescriptor(
          isText
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype,
          "value",
        ).set
      : null;
  const setVal = (v) => {
    if (setter) {
      setter.set.call(el, v);
    } else {
      el.textContent = v; // contenteditable and exotic inputs
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  // 5 chars per word; ±35% jitter; punctuation pause; occasional micro-pause.
  const base = 60000 / (wpm * 5);
  const rand = (a, b) => a + Math.random() * (b - a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const started = Date.now();
  let current = el.value ?? el.textContent ?? "";
  for (const ch of text) {
    current = current + ch;
    setVal(current);
    let delay = base * rand(0.65, 1.35);
    if (ch === " " || ch === "," || ch === ".") delay *= 2.2;
    if (Math.random() < 0.06) delay += rand(120, 400);
    await sleep(delay);
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { typed: text.length, ms: Date.now() - started, error: null };
})()`;
}

/** Shape the evaluate result must come back with; null when unparseable. */
export function parseTypingResult(raw: unknown): TypingResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { typed?: unknown; ms?: unknown; error?: unknown };
  if (typeof r.typed !== "number" || typeof r.ms !== "number") return null;
  return {
    typed: r.typed,
    ms: r.ms,
    error: typeof r.error === "string" ? r.error : null,
  };
}
