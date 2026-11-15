import type { PersonaCreditCard } from "@queuepilot/contracts";

/**
 * The in-page half of card autofill. Runs as ONE Runtime.evaluate on the
 * checkout page; returns which fields were filled — never echoes values back.
 *
 * Field detection is hint-based (name/id/placeholder/aria-label/autocomplete),
 * the standard for checkout forms whose markup varies wildly. Values are set
 * through the native input value setter + bubbling input/change events, the
 * only approach that reliably wakes React/Vue controlled components.
 */

export interface CardFillResult {
  /** Which of number/expiry/cvv/name were filled. */
  filled: string[];
  /** Which were expected (card had the data) but no field matched. */
  missing: string[];
}

/** Build the fill expression. `card` is JSON-inlined; values never come back. */
export function buildCardFillExpression(card: PersonaCreditCard): string {
  return `(() => {
  const card = ${JSON.stringify(card)};
  const inputs = [...document.querySelectorAll("input")].filter(
    (el) => el.type !== "hidden" && !el.disabled,
  );
  const hints = (el) =>
    [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.autocomplete]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  const find = (patterns) =>
    inputs.find((el) => patterns.some((re) => re.test(hints(el))));

  const setVal = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    el.focus();
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
  };

  // Adapt the stored expiry (MM/YY or MM/YYYY) to what the field asks for.
  const expiryFor = (el, exp) => {
    if (!exp) return exp;
    const m = /^(\\d{1,2})\\/(\\d{2}|\\d{4})$/.exec(exp.trim());
    if (!m) return exp;
    const mm = m[1].padStart(2, "0");
    const yy = m[2];
    const max = el.maxLength > 0 ? el.maxLength : Infinity;
    if (yy.length === 4 && max <= 5) return mm + "/" + yy.slice(-2);
    if (yy.length === 2 && max >= 7) return mm + "/20" + yy;
    return mm + "/" + yy;
  };

  const fields = [
    ["number", card.number, find([/cc-?number|card.?number|cardno|cardnum|^(cc)?number$/])],
    ["expiry", card.expDate, find([/cc-?exp|expiry|expires|expir|exp.?date/])],
    ["cvv", card.cvv, find([/cc-?csc|cvv|cvc|cvn|sec.?code|cid$/])],
    ["name", card.name, find([/cc-?name|name.?on.?card|card.?holder|ccfull name/])],
  ];

  const filled = [];
  const missing = [];
  for (const [key, value, el] of fields) {
    if (value === null || value === undefined || value === "") continue;
    if (!el) {
      missing.push(key);
      continue;
    }
    setVal(el, key === "expiry" ? expiryFor(el, value) : value);
    filled.push(key);
  }
  return { filled, missing };
})()`;
}

/** Shape the evaluate result must come back with; null when unparseable. */
export function parseCardFillResult(raw: unknown): CardFillResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { filled?: unknown; missing?: unknown };
  if (!Array.isArray(r.filled) || !Array.isArray(r.missing)) return null;
  return {
    filled: r.filled.filter((x): x is string => typeof x === "string"),
    missing: r.missing.filter((x): x is string => typeof x === "string"),
  };
}
