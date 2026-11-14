import { describe, expect, it } from "vitest";
import {
  currentSms,
  looksLikeSpec,
  mergePersonaFields,
  nextSmsIndex,
  personaFieldValue,
  personaFieldsOf,
} from "../src/application/profiles/persona-fields.js";

describe("personaFieldsOf", () => {
  it("returns defaults for an empty or missing bag", () => {
    expect(personaFieldsOf(null)).toEqual({
      address: null,
      dob: null,
      phone: null,
      smsNumbers: [],
      passcodes: [],
      free: {},
    });
    expect(personaFieldsOf({})).toEqual(personaFieldsOf(null));
  });

  it("reads provider-imported shapes verbatim", () => {
    const fields = personaFieldsOf({
      address: { line1: "1 Main St", line2: null, city: "Toronto", state: "ON", zip: "M5V" },
      dob: "1990-01-01",
      phone: "+1 416 555 0100",
      smsNumbers: [{ label: "SMS Number", number: "4165550100", countryCode: null }],
      passcodes: ["ABC123"],
      free: { "Free 1": "vip" },
    });
    expect(fields.address?.city).toBe("Toronto");
    expect(fields.smsNumbers).toHaveLength(1);
    expect(fields.passcodes).toEqual(["ABC123"]);
    expect(fields.free["Free 1"]).toBe("vip");
  });

  it("malformed bag degrades to defaults instead of crashing", () => {
    const fields = personaFieldsOf({
      smsNumbers: "not-an-array",
      passcodes: [42],
      free: ["nope"],
    });
    expect(fields.smsNumbers).toEqual([]);
    expect(fields.passcodes).toEqual([]);
    expect(fields.free).toEqual({});
  });

  it("does not choke on unknown extra keys", () => {
    const fields = personaFieldsOf({ tabColor: "#fff", sites: { "*": "password=static:x" } });
    expect(fields.phone).toBeNull();
  });
});

describe("mergePersonaFields", () => {
  it("merges only the keys present and preserves the rest of the bag", () => {
    const merged = mergePersonaFields(
      { tabColor: "#fff", phone: "old", favorite: true },
      { phone: "new", passcodes: ["P1"] },
    );
    expect(merged.tabColor).toBe("#fff");
    expect(merged.favorite).toBe(true);
    expect(merged.phone).toBe("new");
    expect(merged.passcodes).toEqual(["P1"]);
  });

  it("rejects an empty patch", () => {
    expect(() => mergePersonaFields({}, {})).toThrow(/at least one field/);
  });

  it("rejects oversized values", () => {
    expect(() => mergePersonaFields({}, { phone: "x".repeat(41) })).toThrow();
    expect(() =>
      mergePersonaFields({}, { smsNumbers: [{ number: "1", label: "x".repeat(61) }] }),
    ).toThrow();
  });
});

describe("SMS cycling", () => {
  const fields = personaFieldsOf({
    smsNumbers: [
      { label: "SMS Number", number: "111", countryCode: null },
      { label: "SMS Number 2", number: "222", countryCode: "44" },
      { label: "SMS Number 3", number: "333", countryCode: "1" },
    ],
  });

  it("selects index modulo length, defaulting to 0", () => {
    expect(currentSms(fields, 0)?.number.number).toBe("111");
    expect(currentSms(fields, 1)?.number.number).toBe("222");
    expect(currentSms(fields, 3)?.number.number).toBe("111");
    expect(currentSms(fields, -1)?.number.number).toBe("333");
  });

  it("nextSmsIndex increments whatever the bag holds", () => {
    expect(nextSmsIndex(null)).toBe(1);
    expect(nextSmsIndex({ smsIndex: 4 })).toBe(5);
    expect(nextSmsIndex({ smsIndex: "garbage" })).toBe(1);
  });

  it("no numbers → null, never a crash", () => {
    expect(currentSms(personaFieldsOf({}), 0)).toBeNull();
  });
});

describe("well-known field values", () => {
  it("reads extra.fields, ignoring empty and non-string values", () => {
    const extra = {
      fields: { password: "hunter2", smscode: "", emailcode: 42, othercode: "webhook:x" },
    };
    expect(personaFieldValue(extra, "password")).toBe("hunter2");
    expect(personaFieldValue(extra, "smscode")).toBeNull();
    expect(personaFieldValue(extra, "emailcode")).toBeNull();
    expect(personaFieldValue(extra, "othercode")).toBe("webhook:x");
    expect(personaFieldValue({}, "password")).toBeNull();
  });
});

describe("looksLikeSpec", () => {
  const registered = new Set(["static", "env", "webhook", "gmail", "imap"]);

  it("matches registered name: prefix", () => {
    expect(looksLikeSpec("static:hello", registered)).toBe(true);
    expect(looksLikeSpec("gmail:work", registered)).toBe(true);
  });

  it("passes literals through, even ones containing ':'", () => {
    expect(looksLikeSpec("hunter2", registered)).toBe(false);
    expect(looksLikeSpec("pass:word", registered)).toBe(false);
  });

  it("ignores unknown resolver names", () => {
    expect(looksLikeSpec("textchest:abc", registered)).toBe(false);
  });
});
