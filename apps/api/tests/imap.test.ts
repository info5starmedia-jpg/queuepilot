import { describe, expect, it, afterEach } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { ResolverRegistry, registerBuiltinResolvers } from "../src/application/resolvers/resolver-registry.js";
import { registerImapResolver } from "../src/application/resolvers/imap-resolver.js";
import type { AliasStore } from "../src/application/resolvers/token-aliases.js";

/** Minimal scripted IMAP server: answers CAPABILITY/LOGIN/SELECT/SEARCH/FETCH
 *  from a canned message, LOGOUT closes. Enough to prove the resolver's wire
 *  behavior without network. */
function fakeImapServer(messageBody: string | null): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.write("* OK fake imap ready\r\n");
      socket.on("data", (buf: Buffer) => {
        const line = buf.toString("utf8").trimEnd();
        const tag = line.split(" ")[0] ?? "qp0";
        if (line.includes("CAPABILITY")) {
          socket.write(`${tag} OK CAPABILITY done\r\n`);
        } else if (line.includes("LOGIN")) {
          if (line.includes("baduser")) socket.write(`${tag} NO auth failed\r\n`);
          else socket.write(`${tag} OK logged in\r\n`);
        } else if (line.includes("SELECT")) {
          socket.write("* 1 EXISTS\r\n" + `${tag} OK selected\r\n`);
        } else if (line.includes("SEARCH")) {
          if (messageBody === null) socket.write("* SEARCH\r\n" + `${tag} OK searched\r\n`);
          else socket.write("* SEARCH 7\r\n" + `${tag} OK searched\r\n`);
        } else if (line.includes("FETCH")) {
          if (messageBody === null || messageBody === "") {
            socket.write("* 7 FETCH (BODY[TEXT] {0}\r\n\r\n)\r\n" + `${tag} OK fetched\r\n`);
          } else {
            socket.write(
              `* 7 FETCH (BODY[TEXT] {${messageBody.length}}\r\n${messageBody}\r\n)\r\n` +
                `${tag} OK fetched\r\n`,
            );
          }
        } else if (line.includes("LOGOUT")) {
          socket.write("* BYE\r\n" + `${tag} OK bye\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} BAD unknown\r\n`);
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

let servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

function makeReg() {
  const reg = new ResolverRegistry();
  registerBuiltinResolvers(reg);
  registerImapResolver(reg);
  return reg;
}

describe("imap resolver", () => {
  it("fetches the newest matching message body (gmail app-password path)", async () => {
    const srv = await fakeImapServer("Your Ticketmaster code is 482913");
    servers.push(srv);
    const reg = makeReg();
    const v = await reg.resolve(
      `imap://127.0.0.1:${srv.port}?tls=false&user=me%40gmail.com&pass=apppass&query=UNSEEN`,
      {},
    );
    expect(v).toBe("Your Ticketmaster code is 482913");
  });

  it("substitutes @aliases for credentials and maps missing alias to #NO ACCOUNT", async () => {
    const srv = await fakeImapServer("code 111222");
    servers.push(srv);
    const reg = makeReg();
    const aliases: AliasStore = {
      set: () => {}, remove: () => {}, list: () => [],
      get: (a) => (a === "mail-user" ? "me@gmail.com" : a === "mail-pass" ? "apppass" : null),
    };
    const v = await reg.resolve(
      `imap://127.0.0.1:${srv.port}?tls=false&user=@mail-user&pass=@mail-pass`,
      {},
      aliases,
    );
    expect(v).toBe("code 111222");

    const missing = await reg.resolve(
      `imap://127.0.0.1:${srv.port}?tls=false&user=@nope&pass=x`,
      {},
      aliases,
    );
    expect(missing).toMatch(/^#NO ACCOUNT/);
  });

  it("no matching message is #NO PASSWORD, server NO on LOGIN is #NO ACCOUNT", async () => {
    const empty = await fakeImapServer(null);
    servers.push(empty);
    const reg = makeReg();
    const v = await reg.resolve(
      `imap://127.0.0.1:${empty.port}?tls=false&user=u&pass=p`,
      {},
    );
    expect(v).toBe("#NO PASSWORD no matching message");

    const denied = await fakeImapServer("x");
    servers.push(denied);
    const reg2 = makeReg();
    const bad = await reg2.resolve(
      `imap://127.0.0.1:${denied.port}?tls=false&user=baduser&pass=p`,
      {},
    );
    expect(bad).toMatch(/^#NO ACCOUNT/);
  });

  it("a malformed spec is #BAD ALIAS, never a throw", async () => {
    const reg = makeReg();
    expect(await reg.resolve("imap:garbage", {})).toMatch(/^#BAD ALIAS/);
  });
});
