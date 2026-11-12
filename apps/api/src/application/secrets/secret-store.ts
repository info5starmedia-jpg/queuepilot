import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * SecretStore — the P6 port behind which proxy passwords (and later cookie
 * encryption keys) leave SQLite plaintext.
 *
 * Threat model, stated honestly: DPAPI CurrentUser protects secrets AT REST
 * against other users and against the DB file being copied elsewhere. It is
 * exactly Chrome's own os-crypt default model. It does NOT protect against
 * code running as the same user — nothing on this machine can, and claiming
 * otherwise would be a lie in the docs.
 *
 * The interface is synchronous on purpose: better-sqlite3 repositories are
 * synchronous, DPAPI round-trips are ~100 ms and happen on proxy CRUD — a
 * rare, human-paced operation. A sync port keeps the secret invisible to
 * async interleaving between read and use.
 */
export interface SecretStore {
  readonly kind: string;
  set(key: string, value: string): void;
  get(key: string): string | null;
  delete(key: string): void;
}

export class SecretStoreError extends Error {}

function secretsDir(env: NodeJS.ProcessEnv): string {
  return path.join(env.QUEUEPILOT_DATA_DIR ?? path.join(os.homedir(), ".queuepilot"), "secrets");
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/**
 * DPAPI via Windows' own ProtectedData, CurrentUser scope, through
 * powershell.exe. The plaintext travels as a base64 env var — never on the
 * command line, where a local process listing could read it. The protected
 * blob is stored base64; DPAPI owns the key, we own nothing secret.
 */
export class DpapiSecretStore implements SecretStore {
  readonly kind = "dpapi";
  private readonly dir: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.dir = secretsDir(env);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  set(key: string, value: string): void {
    const b64 = Buffer.from(value, "utf8").toString("base64");
    const out = this.run(
      "protect",
      key,
      `Add-Type -AssemblyName System.Security
$in = [Convert]::FromBase64String($env:QP_SECRET_B64)
$out = [System.Security.Cryptography.ProtectedData]::Protect($in, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($out)`,
      b64,
    );
    fs.writeFileSync(this.blobPath(key), out, "utf8");
  }

  get(key: string): string | null {
    const blob = this.readBlob(key);
    if (blob === null) return null;
    const plainB64 = this.run(
      "unprotect",
      key,
      `Add-Type -AssemblyName System.Security
$in = [Convert]::FromBase64String($env:QP_SECRET_B64)
$out = [System.Security.Cryptography.ProtectedData]::Unprotect($in, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($out)`,
      blob,
    );
    return Buffer.from(plainB64, "base64").toString("utf8");
  }

  delete(key: string): void {
    try {
      fs.rmSync(this.blobPath(key));
    } catch {
      /* absent is deleted */
    }
  }

  private blobPath(key: string): string {
    return path.join(this.dir, `${safeKey(key)}.dpapi`);
  }

  private readBlob(key: string): string | null {
    try {
      return fs.readFileSync(this.blobPath(key), "utf8").trim();
    } catch {
      return null;
    }
  }

  private run(op: string, key: string, script: string, b64: string): string {
    try {
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        {
          env: { ...process.env, QP_SECRET_B64: b64 },
          encoding: "utf8",
          timeout: 15_000,
          windowsHide: true,
        },
      );
      return out.trim();
    } catch (err) {
      throw new SecretStoreError(
        `dpapi ${op} failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Development fallback — stores secrets as files with a loud warning. Exists
 * ONLY so non-Windows development machines can run the suite. Selecting it
 * requires QUEUEPILOT_SECRET_STORE=plaintext; the factory never picks it
 * silently.
 */
export class PlaintextSecretStore implements SecretStore {
  readonly kind = "plaintext";
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  set(key: string, value: string): void {
    fs.writeFileSync(this.pathFor(key), value, "utf8");
  }

  get(key: string): string | null {
    try {
      return fs.readFileSync(this.pathFor(key), "utf8");
    } catch {
      return null;
    }
  }

  delete(key: string): void {
    try {
      fs.rmSync(this.pathFor(key));
    } catch {
      /* absent is deleted */
    }
  }

  private pathFor(key: string): string {
    return path.join(this.dir, `${safeKey(key)}.secret`);
  }
}

/**
 * Pick the store for this machine. Windows: DPAPI, always. Anywhere else:
 * plaintext ONLY when the operator explicitly asked for it — a silent
 * plaintext fallback on a shared machine would be the exact failure P6
 * exists to remove.
 */
export function createSecretStore(env: NodeJS.ProcessEnv = process.env): SecretStore {
  if (process.platform === "win32") return new DpapiSecretStore(env);
  if (env.QUEUEPILOT_SECRET_STORE === "plaintext") {
    console.warn(
      "[secrets] QUEUEPILOT_SECRET_STORE=plaintext — proxy passwords are NOT protected on this machine. Windows uses DPAPI instead.",
    );
    return new PlaintextSecretStore(secretsDir(env));
  }
  throw new SecretStoreError(
    "no SecretStore for this platform. Set QUEUEPILOT_SECRET_STORE=plaintext explicitly to accept unprotected secrets, or run on Windows (DPAPI).",
  );
}
