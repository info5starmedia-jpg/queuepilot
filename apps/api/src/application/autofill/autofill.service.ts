import {
  DomainError,
  ErrorCodes,
  type PersonaCreditCard,
} from "@queuepilot/contracts";
import type { ProfileService } from "../profiles/profile.service.js";
import { personaFieldsOf } from "../profiles/persona-fields.js";
import type { BrowserLifecycleService } from "../lifecycle/browser.lifecycle.service.js";
import { CdpConnection } from "../runtime/cdp/cdp-connection.js";
import {
  buildCardFillExpression,
  parseCardFillResult,
  type CardFillResult,
} from "./card-autofill.js";

/**
 * AutofillService — pushes persona data into the live page over CDP.
 *
 * Card autofill is the first action: full PANs move from the profile's extra
 * bag straight into the page's inputs; the response names which fields were
 * filled, never the values. Requires a running profile with a reachable CDP
 * endpoint and at least one page target.
 */
export class AutofillService {
  constructor(
    private readonly profiles: ProfileService,
    private readonly lifecycle: BrowserLifecycleService,
  ) {}

  async fillCard(
    profileId: string,
    set: string,
    targetId?: string,
  ): Promise<{ profileId: string; set: string; targetId: string } & CardFillResult> {
    const profile = this.profiles.get(profileId);
    const run = this.lifecycle.activeRun(profileId);
    if (!run || run.status !== "running" || !run.wsEndpoint) {
      throw new DomainError(
        ErrorCodes.PROFILE_NOT_RUNNING,
        `profile ${profileId} is not running — start it before autofill`,
      );
    }
    const card = this.cardSet(profile, set);

    const conn = await CdpConnection.connect(run.wsEndpoint);
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
            expression: buildCardFillExpression(card),
            returnByValue: true,
            awaitPromise: true,
            timeout: 10_000,
          },
          15_000,
          attached.sessionId,
        );
        if (r.exceptionDetails) {
          throw new Error(
            r.exceptionDetails.exception?.description ??
              r.exceptionDetails.text ??
              "autofill evaluation failed",
          );
        }
        const parsed = parseCardFillResult(r.result?.value);
        if (!parsed) {
          throw new Error("autofill returned an unparseable result from the page");
        }
        return { profileId, set, targetId: target, ...parsed };
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
    profile: { extra: Record<string, unknown> },
    set: string,
  ): PersonaCreditCard {
    const cards = personaFieldsOf(profile.extra).creditCards;
    const card = cards.find((c) => c.set === set);
    if (!card) {
      throw new DomainError(
        ErrorCodes.CONFLICT,
        `profile has no credit-card set named "${set}"`,
      );
    }
    return card;
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
