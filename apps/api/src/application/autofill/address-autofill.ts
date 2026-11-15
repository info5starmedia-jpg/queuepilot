/**
 * The in-page half of address/identity autofill. Runs as ONE
 * Runtime.evaluate on the target page; returns which fields were filled —
 * never echoes values back.
 *
 * Detection is hint-based (name/id/placeholder/aria-label/autocomplete), the
 * same standard as card autofill — address forms vary wildly. Unlike
 * checkout, address forms put `state` (and sometimes country) in <select>
 * elements, so selects are matched and set too: an option whose value or
 * text matches the persona state wins (case-insensitive, abbreviation or
 * full-name, min length 2 so "ON" never matches an empty option).
 *
 * Values are set through the native value setter + bubbling input/change
 * events, the only approach that reliably wakes React/Vue controlled
 * components.
 */

/** Everything the page may be asked to fill; null = persona has no data. */
export interface AddressFillInput {
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  dob: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface AddressFillResult {
  /** Which of the identity/address fields were filled. */
  filled: string[];
  /** Which were expected (persona had the data) but no field matched. */
  missing: string[];
}

/** Build the fill expression. `input` is JSON-inlined; values never come back. */
export function buildAddressFillExpression(input: AddressFillInput): string {
  return `(() => {
  const data = ${JSON.stringify(input)};
  const fields = [];
  const filled = [];
  const missing = [];

  const hints = (el) =>
    [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.autocomplete]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  const isLive = (el) => !el.disabled && el.type !== "hidden";

  const inputs = [...document.querySelectorAll("input")].filter(isLive);
  const selects = [...document.querySelectorAll("select")].filter(isLive);
  const findInput = (patterns) =>
    inputs.find((el) => patterns.some((re) => re.test(hints(el))));

  const setInput = (el, v) => {
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

  // State (and country-style) <select>: an option whose value OR text
  // matches the persona value wins — case-insensitive, either direction,
  // min length 2 so abbreviations like "ON" work and empty options never do.
  const setSelect = (el, v) => {
    const want = v.trim().toLowerCase();
    const opt = [...el.options].find((o) => {
      const val = String(o.value ?? "").trim().toLowerCase();
      const text = String(o.text ?? "").trim().toLowerCase();
      if (want.length >= 2 && (val === want || text === want)) return true;
      if (want.length >= 2 && text.length >= 2 && (text.startsWith(want) || want.startsWith(text))) {
        return true;
      }
      return false;
    });
    if (!opt) return false;
    el.focus();
    el.value = opt.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
    return true;
  };

  const findStateSelect = () =>
    selects.find((el) => /\\b(state|province|region|county)\\b/.test(hints(el)));

  fields.push(
    ["firstName", data.firstName, () => {
      const el = findInput([/first.?name|given.?name|fname/]);
      if (!el) return false;
      setInput(el, data.firstName);
      return true;
    }],
    ["lastName", data.lastName, () => {
      const el = findInput([/last.?name|family.?name|surname|lname/]);
      if (!el) return false;
      setInput(el, data.lastName);
      return true;
    }],
    ["email", data.email, () => {
      const el = findInput([/email|e-mail/]);
      if (!el) return false;
      setInput(el, data.email);
      return true;
    }],
    ["phone", data.phone, () => {
      const el = findInput([/phone|mobile|tel|cell/]);
      if (!el) return false;
      setInput(el, data.phone);
      return true;
    }],
    ["dob", data.dob, () => {
      const el = findInput([/dob|birth|bday|date.?of.?birth/]);
      if (!el) return false;
      setInput(el, data.dob);
      return true;
    }],
    ["address1", data.line1, () => {
      const el = findInput([/address.?1|addr1|street|address(?!.?2)/]);
      if (!el) return false;
      setInput(el, data.line1);
      return true;
    }],
    ["address2", data.line2, () => {
      const el = findInput([/address.?2|addr2|suite|unit|apt|apartment/]);
      if (!el) return false;
      setInput(el, data.line2);
      return true;
    }],
    ["city", data.city, () => {
      const el = findInput([/city|town|locality/]);
      if (!el) return false;
      setInput(el, data.city);
      return true;
    }],
    ["state", data.state, () => {
      const sel = findStateSelect();
      if (sel && setSelect(sel, data.state)) return true;
      const el = findInput([/\\bstate\\b|province|region/]);
      if (!el) return false;
      setInput(el, data.state);
      return true;
    }],
    ["zip", data.zip, () => {
      const el = findInput([/zip|postal|postcode|pcode/]);
      if (!el) return false;
      setInput(el, data.zip);
      return true;
    }],
  );

  for (const [key, value, fill] of fields) {
    if (value === null || value === undefined || value === "") continue;
    if (fill()) filled.push(key);
    else missing.push(key);
  }
  return { filled, missing };
})()`;
}

/** Shape the evaluate result must come back with; null when unparseable. */
export function parseAddressFillResult(raw: unknown): AddressFillResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { filled?: unknown; missing?: unknown };
  if (!Array.isArray(r.filled) || !Array.isArray(r.missing)) return null;
  return {
    filled: r.filled.filter((x): x is string => typeof x === "string"),
    missing: r.missing.filter((x): x is string => typeof x === "string"),
  };
}
