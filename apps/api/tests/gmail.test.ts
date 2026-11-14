import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ResolverRegistry } from "../src/application/resolvers/resolver-registry.js";
import { registerGmailResolver } from "../src/application/resolvers/gmail-resolver.js";
import {
  GoogleAuthService,
  GMAIL_SCOPE,
} from "../src/application/google/google-auth.service.js";
import { MapSecretStore } from "./helpers.js";

function makeReg(secrets: MapSecretStore) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-gmail-"));
  const google = new GoogleAuthService({
    secrets,
    dataDir: dir,
    clientId: "cid",
    clientSecret: "cs",
    redirectUri: "http://127.0.0.1:0/cb",
  });
  const reg = new ResolverRegistry();
  registerGmailResolver(reg, google);
  return { reg, google, dir };
}

function seedToken(secrets: MapSecretStore, account: string): void {
  secrets.set(
    `google.oauth.${account}`,
    JSON.stringify({
      accessToken: "tok",
      refreshToken: "r",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scope: GMAIL_SCOPE,
    }),
  );
}

const MIME = (plain: string | null, html: string | null = null) => ({
  payload: {
    mimeType: "multipart/alternative",
    parts: [
      plain !== null
        ? { mimeType: "text/plain", body: { data: Buffer.from(plain).toString("base64url") } }
        : null,
      html !== null
        ? { mimeType: "text/html", body: { data: Buffer.from(html).toString("base64url") } }
        : null,
    ].filter(Boolean),
  },
});

describe("gmail resolver", () => {
  it("lists newest matching message and returns its text/plain body", async () => {
    const secrets = new MapSecretStore();
    seedToken(secrets, "main@gmail.com");
    const { reg } = makeReg(secrets);
    const seen: string[] = [];
    const fakeFetch = (async (url: string) => {
      seen.push(String(url));
      if (String(url).includes("/messages?")) {
        return new Response(JSON.stringify({ messages: [{ id: "m1" }] }));
      }
      return new Response(JSON.stringify(MIME("Your code is 918273")));
    }) as typeof fetch;
    const v = await reg.resolve("gmail:main@gmail.com?query=is:unseen", { fetch: fakeFetch });
    expect(v).toBe("Your code is 918273");
    expect(seen[0]).toContain("q=is%3Aunseen");
    expect(seen[1]).toContain("/messages/m1");
  });

  it("falls back to stripped HTML when no plain part exists", async () => {
    const secrets = new MapSecretStore();
    seedToken(secrets, "a");
    const { reg } = makeReg(secrets);
    const fakeFetch = (async (url: string) =>
      String(url).includes("/messages?")
        ? new Response(JSON.stringify({ messages: [{ id: "m9" }] }))
        : new Response(
            JSON.stringify(
              MIME(null, "<html><body><p>Code:&nbsp;<b>445566</b></p><style>x{}</style></body></html>"),
            ),
          )) as typeof fetch;
    const v = await reg.resolve("gmail:a", { fetch: fakeFetch });
    expect(v).toContain("445566");
    expect(v).not.toContain("<");
  });

  it("no messages is #NO PASSWORD, 401 is #NO ACCOUNT", async () => {
    const secrets = new MapSecretStore();
    seedToken(secrets, "a");
    const { reg } = makeReg(secrets);
    const none = (async () =>
      new Response(JSON.stringify({ messages: [] }))) as typeof fetch;
    expect(await reg.resolve("gmail:a", { fetch: none })).toBe(
      "#NO PASSWORD no matching message",
    );

    const denied = (async () => new Response("no", { status: 401 })) as typeof fetch;
    expect(await reg.resolve("gmail:a", { fetch: denied })).toBe("#NO ACCOUNT");
  });

  it("unconnected account is #NO ACCOUNT, bad spec is #BAD ALIAS", async () => {
    const secrets = new MapSecretStore();
    const { reg } = makeReg(secrets);
    const v = await reg.resolve("gmail:ghost", {});
    expect(v).toBe("#NO ACCOUNT ghost");
    expect(await reg.resolve("gmail:", {})).toMatch(/^#BAD ALIAS/);
  });
});
