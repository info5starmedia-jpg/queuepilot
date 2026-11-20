import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CookieThinger, globRe, matchCookieCsv, parseThinger, type CookieOps } from "../src/application/cookies/cookie-thinger-file.js";
import type { CookieRecord } from "../src/application/cookies/cookie-thinger.js";

/** J5 — the cookie-thinger file: groups, actions, lists 1–5 and $1–$5, cookies-for-profiles CSV. */

const ck = (name: string, domain: string, value = "v"): CookieRecord => ({ name, value, domain, path: "/", expires: 0, secure: true, httpOnly: false, browserContextId: null });

function fakeProfile(initial: CookieRecord[]): CookieOps & { jar: CookieRecord[] } {
  const jar = [...initial];
  const re = (p?: string) => (p ? globRe(p) : /.*/);
  return {
    jar,
    list: async () => [...jar],
    clear: async (f) => {
      const keep = jar.filter((c) => !(re(f.name).test(c.name) && re(f.domain).test(c.domain.replace(/^\./, ""))));
      const n = jar.length - keep.length;
      jar.splice(0, jar.length, ...keep);
      return n;
    },
    set: async (c) => void jar.push(c),
  };
}

function setup(file: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-"));
  const store = new Map<string, string>();
  const thinger = new CookieThinger({
    dataDir: dir,
    secrets: { get: (k: string) => store.get(k) ?? null, set: (k: string, v: string) => void store.set(k, v), delete: (k: string) => void store.delete(k) } as never,
  });
  thinger.save(file);
  return { thinger, store };
}

describe("cookie-thinger file", () => {
  it("parses groups and every action, with per-line errors", () => {
    const f = parseThinger(`; c\n[group 1]\ndel sess* shop.com\ndelall *.tm.com\ncopy 2 id *.a.com\ncopyall $1 a.com\ndcopy 3 b.com\npaste 2\nlclear 2\nladd 1 n d.com some value\nlupdate 1\nlcopy 1 $5\n[group 11]\nbogus x\ndel only\n[group 2]\ncopy 9 a b`);
    expect(f.groups.get(1)!.map((x) => x.action.op)).toEqual(["del", "delall", "copy", "copyall", "dcopy", "paste", "lclear", "ladd", "lupdate", "lcopy"]);
    expect(f.groups.get(1)![7]!.action).toMatchObject({ op: "ladd", value: "some value" });
    expect(f.errors.map((e) => e.line)).toEqual([13, 14, 15, 17]);
  });

  it("del / delall remove, copy / copyall / dcopy fill lists, paste sets them into another profile", async () => {
    const { thinger } = setup(`[group 1]\ncopy 1 sid *.shop.com\ncopyall 2 other.com\n[group 2]\ndcopy 3 move.com\n[group 3]\npaste 1\npaste 2\npaste 3\n[group 4]\ndel sid shop.com\ndelall other.com`);
    const a = fakeProfile([ck("sid", ".shop.com", "S1"), ck("junk", ".shop.com"), ck("o", "other.com"), ck("m", "move.com")]);
    expect((await thinger.run(1, a)).copied).toBe(2); // sid + other.com's o? copy 1 sid → 1, copyall 2 other.com → 1
    const s2 = await thinger.run(2, a);
    expect(s2).toMatchObject({ copied: 1, deleted: 1 });
    expect(a.jar.map((c) => c.name).sort()).toEqual(["junk", "o", "sid"]); // m moved out
    const b = fakeProfile([]);
    expect((await thinger.run(3, b)).pasted).toBe(3);
    expect(b.jar.map((c) => c.name).sort()).toEqual(["m", "o", "sid"]);
    const s4 = await thinger.run(4, a);
    expect(s4.deleted).toBe(2);
    expect(a.jar.map((c) => c.name)).toEqual(["junk"]);
  });

  it("lists: ladd, lupdate refreshes values, lcopy, lclear; $-lists persist in the secret store, 1–5 do not", async () => {
    const { thinger, store } = setup(`[group 1]\nladd $1 sid shop.com stale\nladd 1 tmp shop.com x\n[group 2]\nlupdate $1\n[group 3]\nlcopy $1 2\nlclear 1`);
    const p = fakeProfile([ck("sid", "shop.com", "FRESH")]);
    await thinger.run(1, p);
    expect([...store.keys()]).toEqual(["cookielist.$1"]);
    expect(thinger.getList("1")).toHaveLength(1);
    await thinger.run(2, p);
    expect(thinger.getList("$1")[0]!.value).toBe("FRESH");
    await thinger.run(3, p);
    expect(thinger.getList("2")[0]!.value).toBe("FRESH");
    expect(thinger.getList("1")).toEqual([]);
    // status exposes counts only
    expect(JSON.stringify(thinger.status())).not.toContain("FRESH");
  });

  it("a failing action is reported and the rest of the group still runs; a missing group is an error", async () => {
    const { thinger } = setup(`[group 1]\ndel a b.com\ndelall c.com`);
    const p = fakeProfile([ck("x", "c.com")]);
    let calls = 0;
    const ops: CookieOps = { ...p, clear: async (f) => { if (calls++ === 0) throw new Error("boom"); return p.clear(f); } };
    const r = await thinger.run(1, ops);
    expect(r.errors).toEqual(["line 2: boom"]);
    expect(r.deleted).toBe(1);
    expect((await thinger.run(7, p)).errors[0]).toMatch(/not in the file/);
  });

  it("refuses a file with errors", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-"));
    const t = new CookieThinger({ dataDir: dir, secrets: {} as never });
    expect(() => t.save("[group 1]\nnope")).toThrow(/line 2/);
  });
});

describe("cookies-for-profiles CSV", () => {
  const profiles = [
    { id: "p1", name: "Ann", group: "TM", email: "ann@x.com" },
    { id: "p2", name: "Bob", group: "AXS", email: "bob@x.com" },
  ];
  it("matches Group + Profile first, then Email, and counts the rest", () => {
    const csv = `group,profile,email,name,value,domain\nTM,Ann,,sid,1,.tm.com\n,,BOB@x.com,sid,2,.tm.com\nXX,Nobody,,sid,3,.tm.com\nTM,Ann,,"a,b",4,.tm.com\n`;
    const { byProfile, unmatched } = matchCookieCsv(csv, profiles);
    expect(byProfile.get("p1")!.map((c) => c.name)).toEqual(["sid", "a,b"]);
    expect(byProfile.get("p2")![0]!.value).toBe("2");
    expect(unmatched).toBe(1);
  });
});
