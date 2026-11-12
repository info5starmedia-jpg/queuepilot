import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";

/**
 * Session bundle — the P5/roaming foundation (AliasMode "session bundle
 * export/import", parity §2 P1): an encrypted, passphrase-protected archive
 * of a profile's session state (cookies today; storage/extensions later).
 *
 * Local-first stays the default: a bundle is something the OPERATOR exports
 * and carries — to another machine, to a teammate, to cold storage. No
 * server, no account, no phone-home. The future team sync server would move
 * these same bundles between machines; the format doesn't change when that
 * lands.
 *
 * Crypto, chosen plainly: PBKDF2-SHA256 (310k iterations) derives a 256-bit
 * key from the passphrase; AES-256-GCM encrypts and authenticates the
 * payload. Wrong passphrase and tampered bytes both fail GCM authentication
 * — there is no oracle distinguishing them, and neither yields plaintext.
 * Node's crypto only; no new dependencies.
 */

export const BUNDLE_FORMAT = "queuepilot-session-bundle";
export const BUNDLE_VERSION = 1;
const KDF_ITERATIONS = 310_000;

/** A cookie in transport shape (CDP Network.Cookie compatible subset). */
export interface BundleCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
}

export interface SessionBundleManifest {
  format: typeof BUNDLE_FORMAT;
  version: number;
  profileName: string;
  engineKind: string;
  exportedAt: string;
  cookieCount: number;
}

/** Envelope: header plaintext (format/version for future migrations), body ciphertext. */
interface BundleEnvelope {
  format: typeof BUNDLE_FORMAT;
  version: number;
  kdf: { algo: "PBKDF2-SHA256"; iterations: number; salt: string };
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface SessionBundlePayload {
  manifest: SessionBundleManifest;
  cookies: BundleCookie[];
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, KDF_ITERATIONS, 32, "sha256");
}

/** Seal a payload into an encrypted bundle (bytes suitable for a .qpbundle file). */
export function createSessionBundle(
  passphrase: string,
  manifest: Omit<SessionBundleManifest, "format" | "version" | "cookieCount">,
  cookies: BundleCookie[],
): Buffer {
  const payload: SessionBundlePayload = {
    manifest: {
      ...manifest,
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      cookieCount: cookies.length,
    },
    cookies,
  };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: BundleEnvelope = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    kdf: { algo: "PBKDF2-SHA256", iterations: KDF_ITERATIONS, salt: salt.toString("base64") },
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

/**
 * Open a bundle. Throws DomainError(BUNDLE_INVALID) for every failure mode —
 * wrong passphrase, tampered bytes, foreign format — with no way to tell
 * them apart, which is the property an encrypted container must have.
 */
export function openSessionBundle(passphrase: string, bundle: Buffer): SessionBundlePayload {
  let envelope: BundleEnvelope;
  try {
    envelope = JSON.parse(bundle.toString("utf8")) as BundleEnvelope;
  } catch {
    throw new DomainError(ErrorCodes.BUNDLE_INVALID, "not a QueuePilot session bundle");
  }
  if (envelope.format !== BUNDLE_FORMAT || envelope.version !== BUNDLE_VERSION) {
    throw new DomainError(
      ErrorCodes.BUNDLE_INVALID,
      `unsupported bundle (format=${String(envelope.format)} version=${String(envelope.version)})`,
    );
  }
  let payload: SessionBundlePayload;
  try {
    const key = deriveKey(passphrase, Buffer.from(envelope.kdf.salt, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    payload = JSON.parse(plaintext.toString("utf8")) as SessionBundlePayload;
  } catch {
    throw new DomainError(
      ErrorCodes.BUNDLE_INVALID,
      "bundle failed authentication — wrong passphrase or corrupted file",
    );
  }
  if (payload.manifest.format !== BUNDLE_FORMAT) {
    throw new DomainError(ErrorCodes.BUNDLE_INVALID, "bundle payload self-check failed");
  }
  return payload;
}
