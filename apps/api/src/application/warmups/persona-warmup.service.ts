import path from "node:path";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { BrowserLifecycleService } from "../lifecycle/browser.lifecycle.service.js";
import { createLogger } from "./persona/core/logger.js";
import { CdpDriver } from "./persona/driver/cdp.js";
import type { Driver } from "./persona/driver/Driver.js";
import { runSession, type SessionResult } from "./persona/warmup/engine.js";
import { DEFAULT_PERSONA, loadPersonas, type Persona } from "./persona/warmup/persona.js";
import { compilePlan } from "./persona/warmup/plan.js";

/**
 * W — the owner's Multilogin warmup engine (C:\multilogin\mlxwarmup\mlx-warmup,
 * vendored under ./persona) running on QueuePilot profiles. Per visit:
 * Google-search arrival when possible → accept the cookie banner → log-normal
 * dwell → scroll bursts → 1–3 same-site clicks; never logs in, never adds to
 * cart, never fills forms. Personas are the engine's own JSON files.
 *
 * QueuePilot owns the lifecycle: a profile that isn't running is started
 * (and stopped again afterwards unless `keepRunning`), and the engine
 * attaches to that run's CDP port. Proxy auth is handled by QueuePilot's
 * relay, so the driver needs no proxy credentials. The record/replay recipes
 * in WarmupService remain the second warmup mode.
 */

export interface PersonaWarmupStatus {
  profileId: string;
  persona: string;
  state: "running" | "done" | "failed";
  sessionsPlanned: number;
  sessionsDone: number;
  visits: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  results: { visits: number; aborted: boolean; score: SessionResult["score"] }[];
}

export interface PersonaWarmupDeps {
  lifecycle: BrowserLifecycleService;
  /** Directories with persona JSON files (later wins on id clash). */
  personaDirs: string[];
  /** Tests inject a fake driver and an instant sleep. */
  driverFactory?: (browserUrl: string) => Promise<Driver> | Driver;
  sleep?: (ms: number) => Promise<void>;
}

export class PersonaWarmupService {
  private readonly status = new Map<string, PersonaWarmupStatus>();

  constructor(private readonly deps: PersonaWarmupDeps) {}

  personas(): Persona[] {
    const byId = new Map<string, Persona>([[DEFAULT_PERSONA.id, DEFAULT_PERSONA]]);
    for (const dir of this.deps.personaDirs) {
      try {
        for (const p of loadPersonas(dir)) byId.set(p.id, p);
      } catch {
        /* a missing or broken dir must not hide the others */
      }
    }
    return [...byId.values()];
  }

  statusOf(profileId: string): PersonaWarmupStatus | null {
    return this.status.get(profileId) ?? null;
  }

  /** Starts a warmup in the background; returns the initial status at once. */
  start(profileId: string, opts: { persona?: string; sessions?: number; keepRunning?: boolean } = {}): PersonaWarmupStatus {
    const current = this.status.get(profileId);
    if (current?.state === "running") {
      throw new DomainError(ErrorCodes.VALIDATION_FAILED, "a persona warmup is already running for this profile");
    }
    const persona = this.personas().find((p) => p.id === (opts.persona ?? DEFAULT_PERSONA.id));
    if (!persona) throw new DomainError(ErrorCodes.VALIDATION_FAILED, `unknown persona "${opts.persona}"`);
    const plan = compilePlan(persona, [{ targetId: profileId, kind: "browser" }], { immediate: true, days: 1 });
    const sessions = plan.sessions.slice(0, Math.max(1, Math.min(10, opts.sessions ?? 1)));
    const st: PersonaWarmupStatus = {
      profileId,
      persona: persona.id,
      state: "running",
      sessionsPlanned: sessions.length,
      sessionsDone: 0,
      visits: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      results: [],
    };
    this.status.set(profileId, st);
    void this.run(profileId, sessions, st, opts.keepRunning ?? false);
    return st;
  }

  private async run(
    profileId: string,
    sessions: ReturnType<typeof compilePlan>["sessions"],
    st: PersonaWarmupStatus,
    keepRunning: boolean,
  ): Promise<void> {
    const { lifecycle } = this.deps;
    const wasRunning = lifecycle.activeRun(profileId) !== null;
    let driver: Driver | null = null;
    try {
      const run = wasRunning ? lifecycle.activeRun(profileId)! : await lifecycle.start(profileId);
      if (!run.debugPort && !this.deps.driverFactory) throw new Error("the running profile exposes no debug port");
      const browserUrl = `http://127.0.0.1:${run.debugPort}`;
      const logger = createLogger({ component: "persona-warmup", profileId });
      driver = this.deps.driverFactory
        ? await this.deps.driverFactory(browserUrl)
        : await CdpDriver.connect({ browserUrl, logger });
      for (const session of sessions) {
        const r = await runSession(session, driver, {
          logger,
          searchEngine: session.searchEngine,
          ...(this.deps.sleep ? { sleep: (ms: number) => this.deps.sleep!(ms) } : {}),
        });
        st.sessionsDone++;
        st.visits += r.visits.length;
        st.results.push({ visits: r.visits.length, aborted: r.aborted, score: r.score });
      }
      st.state = "done";
    } catch (err) {
      st.state = "failed";
      st.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    } finally {
      try {
        await driver?.dispose();
      } catch {
        /* detach best-effort */
      }
      if (!wasRunning && !keepRunning) {
        try {
          await lifecycle.stop(profileId);
        } catch {
          /* stop best-effort */
        }
      }
      st.finishedAt = new Date().toISOString();
    }
  }
}

/** Persona dirs: the bundled examples, then the operator's `<dataDir>/personas`. */
export function personaDirsFor(dataDir: string, apiRoot: string): string[] {
  return [path.join(apiRoot, "personas"), path.join(dataDir, "personas")];
}
