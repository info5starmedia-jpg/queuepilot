import crypto from "node:crypto";
import type { SecretStore } from "../secrets/secret-store.js";

/**
 * Pinned extension ids (Fury 0.5.4 v2 semantics): the extension id is DERIVED
 * from an RSA key we generate per extension NAME, kept machine-side in the
 * SecretStore. Same name → same id across versions and across profiles, so
 * extension storage references stay valid. The key never ships in the repo;
 * on a new machine the same name mints a different id, which is correct —
 * storage is machine-local anyway.
 *
 * The algorithm is Chrome's own: id = the first 16 bytes of
 * SHA-256(subjectPublicKeyInfo DER), each byte rendered as two chars from
 * a-p (nibble a=0 … p=15).
 */

const ID_ALPHABET = "abcdefghijklmnop";

export interface PinnedExtensionKey {
  /** 32-char Chrome-style extension id. */
  id: string;
  /** PKCS#8 PEM, machine-bound in the SecretStore. */
  privateKeyPem: string;
  publicKeySpkiDer: Buffer;
}

function keyFor(name: string): string {
  return `extkey.${name}`;
}

/** Generate (or load) the pinned keypair for an extension name. */
export function pinnedExtensionKey(
  secrets: SecretStore,
  name: string,
): PinnedExtensionKey {
  const stored = secrets.get(keyFor(name));
  if (stored) {
    const parsed = JSON.parse(stored) as {
      privateKeyPem: string;
      publicKeySpkiDer: string;
    };
    return {
      id: extensionIdFromSpki(Buffer.from(parsed.publicKeySpkiDer, "base64")),
      privateKeyPem: parsed.privateKeyPem,
      publicKeySpkiDer: Buffer.from(parsed.publicKeySpkiDer, "base64"),
    };
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const spki = publicKey as Buffer;
  const privateKeyPem = privateKey as string;
  secrets.set(
    keyFor(name),
    JSON.stringify({
      privateKeyPem,
      publicKeySpkiDer: spki.toString("base64"),
    }),
  );
  return {
    id: extensionIdFromSpki(spki),
    privateKeyPem,
    publicKeySpkiDer: spki,
  };
}

/** Chrome's extension-id derivation from a subjectPublicKeyInfo DER. */
export function extensionIdFromSpki(spkiDer: Buffer): string {
  const digest = crypto.createHash("sha256").update(spkiDer).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    const b = digest[i]!;
    id += ID_ALPHABET[(b >> 4) & 0xf]! + ID_ALPHABET[b & 0xf]!;
  }
  return id;
}
