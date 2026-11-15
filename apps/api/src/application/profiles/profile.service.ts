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
import { hostPrimaryDisplay } from "./host-display.js";
import {
  currentSms,
  mergePersonaFields,
  nextSmsIndex,
  personaFieldsOf,
} from "./persona-fields.js";
import type { UpdatePersonaInput } from "@queuepilot/contracts";
import type { ProxyRepository } from "../proxies/proxy.repository.js";
import {
  maskProxyEntry,
  profileProxyEntries,
  nextProxyIndex,
  type MaskedProxyEntry,
} from "./profile-proxies.js";

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
      const identity = generateIdentity(
        input.platform ?? "windows",
        input.timezone ?? "UTC",
        input.locale ?? "en-US",
        undefined,
        hostPrimaryDisplay(),
      );
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
      email: input.email ?? null,
      providerId: null,
      providerKey: null,
      extra: {},
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

  /** Folder-tab aggregates (v0.14.16): every group + total/running counts. */
  groups(): { group: string; total: number; running: number }[] {
    return this.profiles.groups();
  }

  /**
   * Rename a group (v0.14.17 console group actions). Refuses to merge into an
   * existing group (409 CONFLICT) — a rename that silently swallows another
   * folder would be data loss by another name.
   */
  renameGroup(from: string, to: string): { renamed: number } {
    if (!from.trim() || !to.trim()) {
      throw new DomainError(ErrorCodes.VALIDATION_FAILED, "group names must be non-empty");
    }
    if (from === to) return { renamed: 0 };
    if (this.profiles.groupExists(to)) {
      throw new DomainError(
        ErrorCodes.CONFLICT,
        `group "${to}" already exists — move profiles into it instead`,
      );
    }
    const renamed = this.profiles.renameGroup(from, to);
    if (renamed === 0) {
      throw new DomainError(ErrorCodes.PROFILE_NOT_FOUND, `group "${from}" not found`);
    }
    return { renamed };
  }

  /** Move profiles into an existing group (v0.14.17). Returns rows moved. */
  moveToGroup(ids: string[], group: string): { moved: number } {
    let moved = 0;
    for (const id of ids) {
      const p = this.get(id); // 404s on unknown ids — a move is all-or-nothing per id
      this.profiles.update({ ...p, group });
      moved++;
    }
    return { moved };
  }

  /**
   * Clone a profile (v0.14.19, Jancy's clone). Copies name (+" copy" unless
   * one is given), group, email, notes, tags, proxy link and the persona
   * bag; generates a FRESH fingerprint identity — two clones sharing one
   * identity would be a linkage a detector could follow. The provider
   * linkage does NOT travel: provider upsert keys must stay 1:1 with their
   * source row.
   */
  clone(id: string, name?: string): Profile {
    const src = this.get(id);
    const current = src.identityId ? this.identities.get(src.identityId) : null;
    const identity = generateIdentity(
      current?.platform ?? "windows",
      current?.timezone ?? "UTC",
      current?.locale ?? "en-US",
      undefined,
      hostPrimaryDisplay(),
    );
    this.identities.create(identity);
    const now = new Date().toISOString();
    const profile: Profile = {
      ...src,
      id: randomUUID(),
      name: name?.trim() ? name.trim() : `${src.name} copy`,
      identityId: identity.id,
      status: "idle",
      providerId: null,
      providerKey: null,
      extra: { ...src.extra },
      createdAt: now,
      updatedAt: now,
    };
    this.profiles.create(profile);
    return profile;
  }

  update(id: string, input: UpdateProfileInput): Profile {
    const p = this.get(id);
    if (input.proxyId && !this.proxies.get(input.proxyId)) {
      throw new DomainError(ErrorCodes.PROXY_NOT_FOUND, `proxy ${input.proxyId} not found`);
    }
    const next: Profile = {
      ...p,
      name: input.name ?? p.name,
      email: input.email === undefined ? p.email : input.email,
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
      undefined,
      hostPrimaryDisplay(),
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

  /**
   * Typed merge of the Jancy 2FA/persona columns (address/DOB/phone/SMS/
   * passcodes/Free). Only the keys present in `input` change; the rest of the
   * extra bag rides through untouched.
   */
  updatePersona(id: string, input: unknown): Profile {
    const p = this.get(id);
    const extra = mergePersonaFields(p.extra, input as UpdatePersonaInput);
    const next: Profile = { ...p, extra, updatedAt: new Date().toISOString() };
    this.profiles.update(next);
    return next;
  }

  /**
   * Jancy SMS cycling: advance `extra.smsIndex` by one (wrapping is handled
   * at read time) and return the newly current number. Refuses loudly when
   * the profile has no SMS numbers — cycling nothing is a caller bug, not a
   * silent no-op.
   */
  rotateSms(id: string): { index: number; total: number; number: string; label: string; countryCode: string | null } {
    const p = this.get(id);
    const fields = personaFieldsOf(p.extra);
    const current = currentSms(fields, nextSmsIndex(p.extra));
    if (!current) {
      throw new DomainError(
        ErrorCodes.CONFLICT,
        "profile has no SMS numbers to cycle",
      );
    }
    const next: Profile = {
      ...p,
      extra: { ...(p.extra ?? {}), smsIndex: nextSmsIndex(p.extra) },
      updatedAt: new Date().toISOString(),
    };
    this.profiles.update(next);
    return {
      index: current.index,
      total: current.total,
      number: current.number.number,
      label: current.number.label,
      countryCode: current.number.countryCode,
    };
  }

  /**
   * Jancy proxy-list cycling: advance `extra.proxyIndex` by one (wrapping is
   * handled at read time) and return the newly current entry, MASKED. Refuses
   * loudly when the list is empty — cycling nothing is a caller bug.
   */
  rotateProxy(id: string): {
    index: number;
    total: number;
    current: MaskedProxyEntry;
  } {
    const p = this.get(id);
    const entries = profileProxyEntries(p.extra);
    if (entries.length === 0) {
      throw new DomainError(
        ErrorCodes.CONFLICT,
        "profile has no proxy list to cycle",
      );
    }
    const index = (nextProxyIndex(p.extra) % entries.length + entries.length) % entries.length;
    const next: Profile = {
      ...p,
      extra: { ...(p.extra ?? {}), proxyIndex: nextProxyIndex(p.extra) },
      updatedAt: new Date().toISOString(),
    };
    this.profiles.update(next);
    return { index, total: entries.length, current: maskProxyEntry(entries[index]!) };
  }
}
