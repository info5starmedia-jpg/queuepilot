import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { ResolverRegistry, registerBuiltinResolvers } from "../src/application/resolvers/resolver-registry.js";
import { registerImapResolver, type ImapConnect } from "../src/application/resolvers/imap-resolver.js";
import { EmailAccountService } from "../src/application/email/email-account.service.js";
import { openTestDatabase } from "../src/infrastructure/database.js";
import { makeTestContext, MapSecretStore } from "./helpers.js";

/**
 * Email accounts (Settings → Integrations): several Gmail/IMAP mailboxes,
 * app password write-only in the SecretStore, a login test, and
 * `imap:you@gmail.com` resolving through the stored account.
 */

/** Scripted IMAP server: LOGIN accepts only `user`/`pass`, SEARCH finds one message. */
function fakeImap(user: string, pass: string, body = "code 482913"): Promise<{ port: number; logins: string[]; close: () => Promise<void> }> {
  const logins: string[] = [];
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.write("* OK ready\r\n");
      socket.on("data", (buf: Buffer) => {
        const line = buf.toString("utf8").trimEnd();
        const tag = line.split(" ")[0] ?? "qp0";
        if (line.includes("CAPABILITY")) socket.write(`${tag} OK done\r\n`);
        else if (line.includes("LOGIN")) {
          logins.push(line.slice(line.indexOf("LOGIN") + 6));
          socket.write(line.includes(`"${user}" "${pass}"`) ? `${tag} OK in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        } else if (line.includes("SELECT")) socket.write(`* 1 EXISTS\r\n${tag} OK selected\r\n`);
        else if (line.includes("SEARCH")) socket.write(`* SEARCH 3\r\n${tag} OK\r\n`);
        else if (line.includes("FETCH")) socket.write(`* 3 FETCH (BODY[TEXT] {${body.length}}\r\n${body}\r\n)\r\n${tag} OK\r\n`);
        else if (line.includes("LOGOUT")) {
          socket.write(`* BYE\r\n${tag} OK\r\n`);
          socket.end();
        } else socket.write(`${tag} BAD\r\n`);
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: (server.address() as AddressInfo).port, logins, close: () => new Promise((r) => server.close(() => r())) }),
    );
  });
}

/** Route every connect to the fake server, whatever host the account names. */
function connectTo(port: number): ImapConnect {
  return () =>
    new Promise((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1", () =>
        resolve({
          write: (l) => s.write(l),
          end: () => s.end(),
          onData: (cb) => s.on("data", (d: Buffer) => cb(d.toString("utf8"))),
          onClose: (cb) => s.on("close", cb),
          onError: (cb) => s.on("error", cb),
        }),
      );
      s.once("error", reject);
    });
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

describe("email accounts API", () => {
  it("adds several accounts, never returns the password, and removes them with their secret", async () => {
    const ctx = makeTestContext();
    const a = await ctx.app.inject({ method: "POST", url: "/email-accounts", payload: { email: "One@Gmail.com", appPassword: "abcd efgh ijkl mnop" } });
    const b = await ctx.app.inject({ method: "POST", url: "/email-accounts", payload: { email: "two@example.org", appPassword: "s3cret", host: "mail.example.org", port: 143 } });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ email: "one@gmail.com", host: "imap.gmail.com", port: 993, tls: true, hasPassword: true });

    const list = await ctx.app.inject({ method: "GET", url: "/email-accounts" });
    expect(list.json().accounts.map((x: { email: string }) => x.email)).toEqual(["one@gmail.com", "two@example.org"]);
    for (const res of [a, b, list]) {
      expect(res.body).not.toContain("abcd");
      expect(res.body).not.toContain("s3cret");
    }
    // Gmail app passwords are stored without the display spaces.
    expect(ctx.secrets.get(`email.${a.json().id}.password`)).toBe("abcdefghijklmnop");

    const del = await ctx.app.inject({ method: "DELETE", url: `/email-accounts/${a.json().id}` });
    expect(del.statusCode).toBe(204);
    expect(ctx.secrets.get(`email.${a.json().id}.password`)).toBeNull();
    expect((await ctx.app.inject({ method: "GET", url: "/email-accounts" })).json().accounts).toHaveLength(1);
    expect((await ctx.app.inject({ method: "DELETE", url: `/email-accounts/${a.json().id}` })).statusCode).toBe(404);
  });

  it("refuses duplicates and bad input", async () => {
    const ctx = makeTestContext();
    await ctx.app.inject({ method: "POST", url: "/email-accounts", payload: { email: "x@gmail.com", appPassword: "p" } });
    const dup = await ctx.app.inject({ method: "POST", url: "/email-accounts", payload: { email: "X@gmail.com", appPassword: "q" } });
    expect(dup.statusCode).toBe(409);
    for (const payload of [
      { email: "not-an-email", appPassword: "p" },
      { email: "y@gmail.com" },
      { email: "y@gmail.com", appPassword: "p", host: "bad host!" },
      { email: "y@gmail.com", appPassword: "p", port: 70000 },
    ]) {
      expect((await ctx.app.inject({ method: "POST", url: "/email-accounts", payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe("email account login test + resolver", () => {
  it("Test logs in with the stored password and reports a refusal without echoing it", async () => {
    const srv = await fakeImap("me@gmail.com", "rightpass");
    closers.push(srv.close);
    const svc = new EmailAccountService(openTestDatabase(), new MapSecretStore(), connectTo(srv.port));
    const good = svc.create({ email: "me@gmail.com", appPassword: "rightpass" });
    const bad = svc.create({ email: "other@gmail.com", appPassword: "wrongpass" });

    expect(await svc.test(good.id)).toEqual({ ok: true, error: null });
    const refused = await svc.test(bad.id);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/login refused/i);
    expect(refused.error).not.toContain("wrongpass");
  });

  it("imap:you@gmail.com resolves through the stored account; unknown accounts say so", async () => {
    const srv = await fakeImap("me@gmail.com", "rightpass", "Your code is 771204");
    closers.push(srv.close);
    const svc = new EmailAccountService(openTestDatabase(), new MapSecretStore());
    svc.create({ email: "me@gmail.com", appPassword: "rightpass" });
    const reg = new ResolverRegistry();
    registerBuiltinResolvers(reg);
    registerImapResolver(reg, { accounts: svc, connect: connectTo(srv.port) });

    expect(await reg.resolve("imap:me@gmail.com", {})).toBe("Your code is 771204");
    expect(await reg.resolve('imap:me@gmail.com?query=UNSEEN FROM "x"', {})).toBe("Your code is 771204");
    expect(srv.logins.at(-1)).toBe('"me@gmail.com" "rightpass"');
    expect(await reg.resolve("imap:nobody@gmail.com", {})).toMatch(/^#NO ACCOUNT nobody@gmail\.com is not added/);
  });
});
