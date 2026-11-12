import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/infrastructure/database.js";
import { ProxyRepository } from "../src/application/proxies/proxy.repository.js";
import { ProxyService, proxySecretKey } from "../src/application/proxies/proxy.service.js";
import {
  DpapiSecretStore,
  PlaintextSecretStore,
} from "../src/application/secrets/secret-store.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qp-secrets-"));
}

describe("PlaintextSecretStore (dev fallback)", () => {
  it("round-trips set/get and delete", () => {
    const store = new PlaintextSecretStore(tempDir());
    expect(store.get("proxy:x:password")).toBeNull();
    store.set("proxy:x:password", "s3cret");
    expect(store.get("proxy:x:password")).toBe("s3cret");
    store.delete("proxy:x:password");
    expect(store.get("proxy:x:password")).toBeNull();
  });
});

describe("DpapiSecretStore (Windows DPAPI)", () => {
  it.skipIf(process.platform !== "win32")("round-trips a secret through ProtectedData", () => {
    const store = new DpapiSecretStore({ QUEUEPILOT_DATA_DIR: tempDir() });
    store.set("proxy:dpapi-test:password", "p@ss w0rd!");
    expect(store.get("proxy:dpapi-test:password")).toBe("p@ss w0rd!");
    store.delete("proxy:dpapi-test:password");
    expect(store.get("proxy:dpapi-test:password")).toBeNull();
  });
});

describe("ProxyService secrets integration (P6)", () => {
  function makeService() {
    const db = openDatabase(":memory:");
    const repo = new ProxyRepository(db);
    const secrets = new PlaintextSecretStore(tempDir());
    return { db, repo, secrets, service: new ProxyService(repo, secrets) };
  }

  it("stores the password in the SecretStore, never the row", () => {
    const { repo, secrets, service } = makeService();
    const p = service.create({
      name: "us-east",
      type: "http",
      host: "1.2.3.4",
      port: 8080,
      username: "alice",
      password: "topsecret",
    });
    const row = repo.get(p.id)!;
    expect(row.password).toBeNull();
    expect(secrets.get(proxySecretKey(p.id))).toBe("topsecret");
    // Public shape still strips the password.
    expect("password" in p).toBe(false);
    // Hydrated (StoredProxy) view carries it for launch composition.
    expect(service.getStored(p.id).password).toBe("topsecret");
  });

  it("update can set and clear the secret independently", () => {
    const { secrets, service } = makeService();
    const p = service.create({
      name: "eu",
      type: "http",
      host: "9.9.9.9",
      port: 3128,
      password: "old",
    });
    service.update(p.id, { password: "new" });
    expect(service.getStored(p.id).password).toBe("new");
    service.update(p.id, { password: null });
    expect(service.getStored(p.id).password).toBeNull();
    expect(secrets.get(proxySecretKey(p.id))).toBeNull();
  });

  it("delete removes the secret blob with the row", () => {
    const { secrets, service } = makeService();
    const p = service.create({
      name: "tmp",
      type: "http",
      host: "5.5.5.5",
      port: 80,
      password: "gone",
    });
    service.delete(p.id);
    expect(secrets.get(proxySecretKey(p.id))).toBeNull();
  });

  it("lazily migrates a pre-P6 plaintext row into the store", () => {
    const { repo, secrets, service } = makeService();
    // Simulate a legacy row written before P6 (password in the column).
    const id = "11111111-2222-3333-4444-555555555555";
    const now = new Date().toISOString();
    repo.create({
      id,
      name: "legacy",
      type: "http",
      host: "7.7.7.7",
      port: 8080,
      username: null,
      password: "plaintext-era",
      timezone: null,
      providerId: null,
      createdAt: now,
      updatedAt: now,
    });
    const hydrated = service.getStored(id);
    expect(hydrated.password).toBe("plaintext-era");
    // The plaintext died on first read.
    expect(repo.get(id)!.password).toBeNull();
    expect(secrets.get(proxySecretKey(id))).toBe("plaintext-era");
  });

  it("without a SecretStore, legacy row behavior is unchanged", () => {
    const db = openDatabase(":memory:");
    const repo = new ProxyRepository(db);
    const service = new ProxyService(repo); // no secrets — tests/dev default
    const p = service.create({
      name: "plain",
      type: "http",
      host: "8.8.8.8",
      port: 8080,
      password: "in-row",
    });
    expect(repo.get(p.id)!.password).toBe("in-row");
    expect(service.getStored(p.id).password).toBe("in-row");
  });
});
