import { randomUUID } from "node:crypto";
import {
  DomainError,
  ErrorCodes,
  type CreateProfileInput,
  type FingerprintPlatform,
  type Profile,
  type UpdateProfileInput,
} from "@queuepilot/contracts";
import type { ProfileRepository, FingerprintIdentityRepository } from "./profile.repository.js";
import { generateIdentity } from "./fingerprint-generator.js";
import type { ProxyRepository } from "../proxies/proxy.repository.js";

export class ProfileService {
  constructor(
    private readonly profiles: ProfileRepository,
    private readonly identities: FingerprintIdentityRepository,
    private readonly proxies: ProxyRepository,
  ) {}

  create(input: CreateProfileInput): Profile {
    if (input.proxyId && !this.proxies.get(input.proxyId)) {
      throw new DomainError(ErrorCodes.PROXY_NOT_FOUND, `proxy ${input.proxyId} not found`);
    }
    const now = new Date().toISOString();
    let identityId: string | null = null;
    if (input.generateFingerprint) {
      const identity = generateIdentity(input.platform ?? "windows");
      this.identities.create(identity);
      identityId = identity.id;
    }
    const profile: Profile = {
      id: randomUUID(),
      name: input.name,
      group: input.group ?? "default",
      proxyId: input.proxyId ?? null,
      identityId,
      status: "idle",
      notes: input.notes ?? "",
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.profiles.create(profile);
    return profile;
  }

  get(id: string): Profile {
    const p = this.profiles.get(id);
    if (!p) throw new DomainError(ErrorCodes.PROFILE_NOT_FOUND, `profile ${id} not found`);
    return p;
  }

  list(filter: { group?: string; query?: string } = {}): Profile[] {
    return this.profiles.list(filter);
  }

  update(id: string, input: UpdateProfileInput): Profile {
    const p = this.get(id);
    if (input.proxyId && !this.proxies.get(input.proxyId)) {
      throw new DomainError(ErrorCodes.PROXY_NOT_FOUND, `proxy ${input.proxyId} not found`);
    }
    const next: Profile = {
      ...p,
      name: input.name ?? p.name,
      group: input.group ?? p.group,
      proxyId: input.proxyId === undefined ? p.proxyId : input.proxyId,
      notes: input.notes ?? p.notes,
      tags: input.tags ?? p.tags,
      updatedAt: new Date().toISOString(),
    };
    this.profiles.update(next);
    return next;
  }

  /**
   * New identity, atomically re-pointed. The old identity row stays — it is
   * immutable history, and an open browser may still be presenting it.
   *
   * Edit-while-running is ALLOWED by design: the running engine keeps the
   * identity it was launched with (frozen in the run's launch snapshot), and
   * the drift signal tells the user the new identity "applies at next start".
   */
  regenerateFingerprint(id: string, platform?: FingerprintPlatform): Profile {
    const p = this.get(id);
    const current = p.identityId ? this.identities.get(p.identityId) : null;
    const identity = generateIdentity(
      platform ?? current?.platform ?? "windows",
      current?.timezone ?? "UTC",
      current?.locale ?? "en-US",
    );
    this.identities.create(identity);
    const next: Profile = { ...p, identityId: identity.id, updatedAt: new Date().toISOString() };
    this.profiles.update(next);
    return next;
  }

  delete(id: string): void {
    const p = this.get(id);
    if (p.status === "running") {
      throw new DomainError(ErrorCodes.CONFLICT, "stop the browser before deleting the profile");
    }
    this.profiles.delete(id);
  }
}
