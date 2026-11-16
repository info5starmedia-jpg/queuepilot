import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TempProxyInputSchema } from "@queuepilot/contracts";
import type { BrowserLifecycleService } from "../application/lifecycle/browser.lifecycle.service.js";
import type { ProfileService } from "../application/profiles/profile.service.js";
import { AutofillService } from "../application/autofill/autofill.service.js";
import type { SecretStore } from "../application/secrets/secret-store.js";

const StartRunBodySchema = z
  .object({
    /**
     * Optional one-shot proxy for this launch only (Jancy-style temp proxy):
     * used by the engine for this run, never persisted, and the profile's own
     * proxy applies again at next start.
     */
    tempProxy: TempProxyInputSchema.nullish(),
  })
  .strict();

const BatchStartBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  /** Delay between starts (ms). A copy of the launch setting, passed per call. */
  staggerMs: z.number().int().min(0).max(60_000).default(0),
});

const BatchStopBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
});

/** Native run-control API (QueuePilot's own shape, not the compat surface). */
export function registerRunRoutes(
  app: FastifyInstance,
  lifecycle: BrowserLifecycleService,
  profiles: ProfileService,
  secrets?: SecretStore,
): void {
  const autofill = new AutofillService(profiles, lifecycle, secrets);

  /**
   * Credit-card autofill: pushes the named card set from the profile's extra
   * bag into the checkout page's inputs over CDP. The response names which
   * fields were filled — values never leave the machine in either direction.
   */
  app.post("/profiles/:id/autofill/card", async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        set: z.string().min(1).max(60),
        targetId: z.string().min(1).max(200).optional(),
      })
      .parse(req.body ?? {});
    return autofill.fillCard(id, body.set, body.targetId);
  });

  /**
   * Address/identity autofill: pushes the profile's name/email plus the
   * persona's phone/DOB/address into the page's inputs (and state selects)
   * over CDP. The response names which fields were filled — values never
   * leave the machine in either direction. 409 when the persona carries no
   * address/identity data at all.
   */
  app.post("/profiles/:id/autofill/address", async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        targetId: z.string().min(1).max(200).optional(),
      })
      .parse(req.body ?? {});
    return autofill.fillAddress(id, body.targetId);
  });

  /**
   * WPM typing simulation: types `text` into the page's FOCUSED editable
   * element keystroke by keystroke (per-key delay from `wpm`, human jitter).
   * One long-running CDP evaluate; the response reports typed count and
   * elapsed ms, never the text itself. `error: "no-focused-field"` in the
   * result when nothing editable has focus — nothing was typed.
   */
  app.post("/profiles/:id/autofill/type", async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        text: z.string().min(1).max(4000),
        wpm: z.number().int().min(20).max(400).default(60),
        targetId: z.string().min(1).max(200).optional(),
      })
      .parse(req.body ?? {});
    return autofill.typeText(id, body.text, body.wpm, body.targetId);
  });
  app.post("/profiles/:id/start", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = StartRunBodySchema.parse(req.body ?? {});
    const run = await lifecycle.start(id, {
      tempProxy: body.tempProxy ?? null,
    });
    return reply.code(201).send(run);
  });

  app.post("/profiles/:id/stop", async (req) => {
    const { id } = req.params as { id: string };
    const run = await lifecycle.stop(id);
    return { stopped: run !== null, run };
  });

  /**
   * Batch start (A2): sequential starts honoring the per-profile launch
   * mutex and the host capacity cap. One profile failing never aborts the
   * batch — its result row carries the error, same philosophy as the CSV
   * importer.
   */
  app.post("/profiles/batch-start", async (req) => {
    const body = BatchStartBodySchema.parse(req.body ?? {});
    const results: {
      id: string;
      status: "started" | "failed";
      run?: unknown;
      error?: { code: string; message: string };
    }[] = [];
    for (let i = 0; i < body.ids.length; i++) {
      if (i > 0 && body.staggerMs > 0) {
        await new Promise((r) => setTimeout(r, body.staggerMs));
      }
      const id = body.ids[i];
      if (id === undefined) continue; // unreachable: zod guarantees min(1) strings
      try {
        const run = await lifecycle.start(id, {});
        results.push({ id, status: "started", run });
      } catch (err) {
        results.push({
          id,
          status: "failed",
          error: {
            code: err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "INTERNAL",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
    return { results };
  });

  /** Batch stop — the mirror of batch-start: stop everything selected. */
  app.post("/profiles/batch-stop", async (req) => {
    const body = BatchStopBodySchema.parse(req.body ?? {});
    const results: {
      id: string;
      status: "stopped" | "failed";
      error?: { code: string; message: string };
    }[] = [];
    for (const id of body.ids) {
      try {
        await lifecycle.stop(id);
        results.push({ id, status: "stopped" }); // idempotent: already-stopped still counts
      } catch (err) {
        results.push({
          id,
          status: "failed",
          error: {
            code: err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "INTERNAL",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
    return { results };
  });

  app.get("/profiles/:id/run", async (req) => {
    const { id } = req.params as { id: string };
    return { run: lifecycle.activeRun(id) };
  });

  app.get("/profiles/:id/runs", async (req) => {
    const { id } = req.params as { id: string };
    return { runs: lifecycle.listRuns(id) };
  });

  /**
   * "Applies at next start" signal: drift between what the running engine
   * was launched with and the profile's current identity/proxy pointers.
   */
  app.get("/profiles/:id/drift", async (req) => {
    const { id } = req.params as { id: string };
    return { drift: lifecycle.identityDrift(id) };
  });

  /**
   * Attestation: what the live engine ACTUALLY materialized vs the launch
   * snapshot. verdict "match" | "mismatch" | "unattested" (no identity of
   * record); 501 ATTESTATION_UNSUPPORTED when the runtime can't probe.
   */
  app.get("/profiles/:id/attest", async (req) => {
    const { id } = req.params as { id: string };
    return lifecycle.attest(id);
  });

  /**
   * Egress diagnostics: the launch-time proxy chain, relay port, exit
   * address and WebRTC keys for the occupying run. Launch measurements
   * verbatim — never a live re-check. proxyUrl arrives credential-redacted.
   */
  app.get("/profiles/:id/egress", async (req) => {
    const { id } = req.params as { id: string };
    return lifecycle.egressDiagnostics(id);
  });
}
