import { describe, expect, it } from "vitest";
import {
  parseCookies,
  parseJsonCookies,
  parseNetscapeCookies,
  serializeCookies,
  serializeJsonCookies,
  serializeNetscapeCookies,
} from "../src/application/cookies/cookie-formats.js";
import type { CookieRecord } from "../src/application/cookies/cookie-thinger.js";

const COOKIES: CookieRecord[] = [
  {
    name: "session",
    value: "abc=def",
    domain: ".shop.example",
    path: "/",
    expires: 1893456000,
    secure: true,
    httpOnly: true,
    browserContextId: null,
  },
  {
    name: "pref",
    value: "dark",
    domain: "example.com",
    path: "/ui",
    expires: 0,
    secure: false,
    httpOnly: false,
    browserContextId: null,
  },
];

describe("netscape format", () => {
  it("serializes and parses back losslessly (round trip)", () => {
    const text = serializeNetscapeCookies(COOKIES);
    expect(text.startsWith("# Netscape HTTP Cookie File")).toBe(true);
    expect(text).toContain("#HttpOnly_.shop.example");
    const parsed = parseNetscapeCookies(text);
    expect(parsed).toEqual(COOKIES);
  });

  it("parses the curl/httpOnly convention and skips comments", () => {
    const text = [
      "# Netscape HTTP Cookie File",
      "# a comment",
      ".example.com\tTRUE\t/\tFALSE\t1893456000\tsid\txyz",
      "#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\tsec\ttop",
    ].join("\n");
    const parsed = parseNetscapeCookies(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ name: "sid", value: "xyz", domain: ".example.com", secure: false, httpOnly: false });
    expect(parsed[1]).toMatchObject({ name: "sec", value: "top", httpOnly: true, secure: true });
  });

  it("throws a line-numbered error on malformed input", () => {
    expect(() => parseNetscapeCookies("not-a-cookie-line")).toThrow(/line 1/);
  });

  it("throws on a bad expires field", () => {
    expect(() =>
      parseNetscapeCookies(".example.com\tTRUE\t/\tFALSE\tsoon\ta\tb"),
    ).toThrow(/expires/);
  });
});

describe("json format", () => {
  it("serializes and parses back losslessly (round trip)", () => {
    const text = serializeJsonCookies(COOKIES);
    expect(JSON.parse(text)).toHaveLength(2);
    expect(parseJsonCookies(text)).toEqual(COOKIES);
  });

  it("accepts missing optional fields with defaults", () => {
    const parsed = parseJsonCookies(
      JSON.stringify([{ name: "a", value: "1", domain: "x.example" }]),
    );
    expect(parsed[0]).toMatchObject({ path: "/", expires: 0, secure: false, httpOnly: false });
  });

  it("rejects non-arrays and entries missing required fields", () => {
    expect(() => parseJsonCookies("{}")).toThrow(/array/);
    expect(() => parseJsonCookies("[{\"value\":\"1\"}]")).toThrow(/name/);
    expect(() => parseJsonCookies("[{\"name\":\"a\",\"value\":\"1\"}]")).toThrow(/domain/);
    expect(() => parseJsonCookies("not json")).toThrow(/parse/);
  });
});

describe("format dispatch", () => {
  it("parseCookies/serializeCookies route by format", () => {
    expect(parseCookies("json", serializeCookies("json", COOKIES))).toEqual(COOKIES);
    expect(parseCookies("netscape", serializeCookies("netscape", COOKIES))).toEqual(COOKIES);
  });
});
