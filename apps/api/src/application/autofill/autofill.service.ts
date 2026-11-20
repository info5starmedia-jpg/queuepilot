import {
  DomainError,
  ErrorCodes,
  type PersonaCreditCard,
} from "@queuepilot/contracts";
import type { ProfileService } from "../profiles/profile.service.js";
import { personaFieldsOf } from "../profiles/persona-fields.js";
import { resolveCardForFill } from "../profiles/card-secrets.js";
import type { SecretStore } from "../secrets/secret-store.js";
import type { BrowserLifecycleService } from "../lifecycle/browser.lifecycle.service.js";
import { CdpConnection } from "../runtime/cdp/cdp-connection.js";
import {
  buildCardFillExpression,
  parseCardFillResult,
  type CardFillResult,
} from "./card-autofill.js";
import {
  buildAddressFillExpression,
  parseAddressFillResult,
  type AddressFillInput,
  type AddressFillResult,
} from "./address-autofill.js";
import { buildTypingExpression, parseTypingResult, type TypingResult } from "./typing.js";

/**
 * AutofillService — pushes persona data into the live page over CDP.
 *
 * Card autofill moves a named card set; address autofill moves the
 * profile's identity (name/email) plus the persona's phone/DOB/address.
 * Both travel INTO the page's inputs only; responses name which fields
 * were filled, never the values. Requires a running profile with a
 * reachable CDP endpoint and at least one page target.
 *
 * Card PANs are re-hydrated from the SecretStore at fill time (audit
 * v0.15.0) — the profile row only ever carries last4 + metadata.
 */
export class AutofillService {
  constructor(
    private readonly profiles: ProfileService,
    private readonly lifecycle: BrowserLifecycleService,
    private readonly secrets?: SecretStore,
  ) {}

  async fillCard(
    profileId: string,
    set: string,
    targetId?: string,
  ): Promise<{ profileId: string; set: string; targetId: string } & CardFillResult> {
    const profile = this.profiles.get(profileId);
    this.requireRunning(profileId);
    const card = this.cardSet(profileId, profile.extra, set);

    // P0 audit SEC-4: card fills run in an ISOLATED world — a hostile page
    // must not be able to swap setters/Function to read the card number.
    const { target, value } = await this.evaluateIsolatedOnPage(
      profileId,
      buildCardFillExpression(card),
      targetId,
    );
    const parsed = parseCardFillResult(value);
    if (!parsed) {
      throw new Error("autofill returned an unparseable result from the page");
    }
    return { profileId, set, targetId: target, ...parsed };
  }

  async fillAddress(
    profileId: string,
    targetId?: string,
  ): Promise<{ profileId: string; targetId: string } & AddressFillResult> {
    const profile = this.profiles.get(profileId);
    this.requireRunning(profileId);
    const input = this.addressInput(profile);
    if (!input) {
      throw new DomainError(
        ErrorCodes.CONFLICT,
        "profile has no address/identity data to autofill — set an address, phone, or email first",
      );
    }

    // P0 audit SEC-4: address/PII fills also run in the isolated world.
    const { target, value } = await this.evaluateIsolatedOnPage(
      profileId,
      buildAddressFillExpression(input),
      targetId,
    );
    const parsed = parseAddressFillResult(value);
    if (!parsed) {
      throw new Error("autofill returned an unparseable result from the page");
    }
    return { profileId, targetId: target, ...parsed };
  }

  /**
   * WPM typing simulation: types `text` into the page's FOCUSED editable
   * element keystroke by keystroke (see typing.ts for the delay model).
   * The evaluate may run long — the timeout scales with the expected
   * typing duration, bounded. The result reports typed/ms only, never the
   * text (it went INTO the page).
   */
  async typeText(
    profileId: string,
    text: string,
    wpm: number,
    targetId?: string,
  ): Promise<{ profileId: string; targetId: string } & TypingResult> {
    this.profiles.get(profileId);
    this.requireRunning(profileId);

    // Worst-case duration: slowest allowed jitter + punctuation pauses and
    // micro-pauses on every key, plus generous headroom.
    const worstMsPerKey = (60000 / (wpm * 5)) * 1.35 * 2.2 + 400;
    const timeoutMs = Math.min(Math.ceil(text.length * worstMsPerKey) + 10_000, 300_000);

    // P0 audit SEC-4: typed text runs in the isolated world too.
    const { target, value } = await this.evaluateIsolatedOnPage(
      profileId,
      buildTypingExpression(text, wpm),
      targetId,
      timeoutMs,
    );
    const parsed = parseTypingResult(value);
    if (!parsed) {
      throw new Error("typing returned an unparseable result from the page");
    }
    return { profileId, targetId: target, ...parsed };
  }

  /**
   * Identity + address data for the page. Name is always available (split
   * at the first space); email comes from the profile, phone/DOB/address
   * from the persona bag. Returns null when there is nothing worth filling
   * (no address AND no phone AND no email — a bare name is not an identity).
   */
  private addressInput(profile: {
    name: string;
    email: string | null;
    extra: Record<string, unknown>;
  }): AddressFillInput | null {
    const fields = personaFieldsOf(profile.extra);
    if (fields.address === null && fields.phone === null && profile.email === null) {
      return null;
    }
    const space = profile.name.indexOf(" ");
    const firstName = space > 0 ? profile.name.slice(0, space) : profile.name;
    const lastName = space > 0 ? profile.name.slice(space + 1).trim() || null : null;
    const addr = fields.address;
    return {
      firstName,
      lastName,
      email: profile.email,
      phone: fields.phone,
      dob: fields.dob,
      line1: addr?.line1 ?? null,
      line2: addr?.line2 ?? null,
      city: addr?.city ?? null,
      state: addr?.state ?? null,
      zip: addr?.zip ?? null,
    };
  }

  /**
   * J4: run one expression in an ISOLATED world of the page (own globals and
   * prototypes: a hostile page can't swap Function/String/value setters to
   * read what is filled). Shares the DOM only.
   */
  async evaluateIsolated(profileId: string, expression: string, targetId?: string, timeoutMs = 120_000): Promise<unknown> {
    return (await this.evaluateIsolatedOnPage(profileId, expression, targetId, timeoutMs)).value;
  }

  /** Isolated-world variant of evaluateOnPage — same contract, safe world. */
  private async evaluateIsolatedOnPage(
    profileId: string,
    expression: string,
    targetId?: string,
    timeoutMs = 120_000,
  ): Promise<{ target: string; value: unknown }> {
    this.requireRunning(profileId);
    const run = this.lifecycle.activeRun(profileId);
    const conn = await CdpConnection.connect(run!.wsEndpoint!);
    try {
      const target = await this.pickPageTarget(conn, targetId);
      const { sessionId } = await conn.call<{ sessionId: string }>("Target.attachToTarget", { targetId: target, flatten: true });
      try {
        const tree = await conn.call<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, 10_000, sessionId);
        const world = await conn.call<{ executionContextId: number }>(
          "Page.createIsolatedWorld",
          { frameId: tree.frameTree.frame.id, worldName: "qp-autofill", grantUniveralAccess: false },
          10_000,
          sessionId,
        );
        const r = await conn.call<{ result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>(
          "Runtime.evaluate",
          { expression, contextId: world.executionContextId, returnByValue: true, awaitPromise: true, timeout: timeoutMs },
          timeoutMs + 5_000,
          sessionId,
        );
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "autofill evaluation failed");
        return { target, value: r.result?.value };
      } finally {
        await conn.call("Target.detachFromTarget", { sessionId }, 5_000).catch(() => {});
      }
    } finally {
      conn.close();
    }
  }

  /** J4: run one page expression on the profile's page (the map engine's entry point). */
  async evaluate(profileId: string, expression: string, targetId?: string, timeoutMs?: number): Promise<unknown> {
    this.requireRunning(profileId);
    return (await this.evaluateOnPage(profileId, expression, targetId, timeoutMs)).value;
  }

  private requireRunning(profileId: string): void {
    const run = this.lifecycle.activeRun(profileId);
    if (!run || run.status !== "running" || !run.wsEndpoint) {
      throw new DomainError(
        ErrorCodes.PROFILE_NOT_RUNNING,
        `profile ${profileId} is not running — start it before autofill`,
      );
    }
  }

  /**
   * Shared CDP plumbing: connect to the run's endpoint, pick (or honor) the
   * page target, attach, evaluate one expression, detach. Returns the
   * target id and the raw by-value result for the caller to parse.
   */
  private async evaluateOnPage(
    profileId: string,
    expression: string,
    targetId?: string,
    timeoutMs = 15_000,
  ): Promise<{ target: string; value: unknown }> {
    const run = this.lifecycle.activeRun(profileId);
    const conn = await CdpConnection.connect(run!.wsEndpoint!);
    try {
      const target = await this.pickPageTarget(conn, targetId);
      const attached = await conn.call<{ sessionId: string }>("Target.attachToTarget", {
        targetId: target,
        flatten: true,
      });
      try {
        const r = await conn.call<{
          result?: { value?: unknown };
          exceptionDetails?: { exception?: { description?: string }; text?: string };
        }>(
          "Runtime.evaluate",
          {
            expression,
            returnByValue: true,
            awaitPromise: true,
            timeout: timeoutMs,
          },
          timeoutMs + 5_000,
          attached.sessionId,
        );
        if (r.exceptionDetails) {
          throw new Error(
            r.exceptionDetails.exception?.description ??
              r.exceptionDetails.text ??
              "autofill evaluation failed",
          );
        }
        return { target, value: r.result?.value };
      } finally {
        await conn
          .call("Target.detachFromTarget", { sessionId: attached.sessionId }, 5_000)
          .catch(() => {});
      }
    } finally {
      conn.close();
    }
  }

  private cardSet(
    profileId: string,
    extra: Record<string, unknown>,
    set: string,
  ): PersonaCreditCard {
    return resolveCardForFill(profileId, extra, set, this.secrets);
  }

  private async pickPageTarget(conn: CdpConnection, targetId?: string): Promise<string> {
    if (targetId) return targetId;
    const r = await conn.call<{ targetInfos?: { targetId: string; type: string }[] }>(
      "Target.getTargets",
      {},
      10_000,
    );
    const page = (r.targetInfos ?? []).find((t) => t.type === "page");
    if (!page) {
      throw new DomainError(
        ErrorCodes.NO_FILL_TARGET,
        "no page target to autofill — open a tab first",
      );
    }
    return page.targetId;
  }
}
