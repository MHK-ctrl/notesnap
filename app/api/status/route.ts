/**
 * GET /api/status — what the public demo can still do, in public terms.
 *
 * The UI needs to tell a visitor *before* they upload a photo that the demo is
 * closed and why, rather than letting them spend a photo-sized upload to find
 * out. It reports today's demo spend, whether the shared store is reachable,
 * and whether the provider's own daily quota is known to be spent.
 *
 * Nothing secret is exposed: no keys, no env-var names beyond what is already in
 * the README, and no per-IP counters. A caller can see the demo's aggregate
 * budget, which is public information by design — it is the same number shown in
 * the UI. Per-IP counters are deliberately excluded so this endpoint can't be
 * used to probe an individual visitor's allowance.
 */

import { NextResponse } from "next/server";

import {
  getPerIpDailyMax,
  getSharedStore,
  isQuotaBreakerSet,
  readDemoBudgetStatus,
} from "@/lib/demo-quota";
import { nextPacificMidnight, secondsUntil } from "@/lib/pacific-time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Provider + model the circuit breaker is keyed by; mirrors the transcribe route. */
const DEMO_PROVIDER = "gemini";
const DEMO_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(): Promise<NextResponse> {
  const now = new Date();
  const resetsAt = nextPacificMidnight(now);
  const store = getSharedStore();

  const budget = await readDemoBudgetStatus(store, now);
  const breaker = store ? await isQuotaBreakerSet(store, DEMO_PROVIDER, DEMO_MODEL, now) : false;

  // "Available" means a visitor's own request would actually be served: the
  // shared store has to be reachable and the provider quota must not be spent.
  const available = budget.available && !breaker;

  return NextResponse.json(
    {
      demo: {
        available,
        used: budget.used,
        limit: budget.limit,
        remaining:
          budget.used === null ? null : Math.max(0, budget.limit - budget.used),
        resetsAt: new Date(resetsAt).toISOString(),
        perIpDailyLimit: getPerIpDailyMax(),
      },
      quota: {
        exhausted: breaker,
        resetsAt: new Date(resetsAt).toISOString(),
      },
      /** Seconds until the daily budget frees up, so clients need not do date math. */
      resetsInSeconds: secondsUntil(now.getTime(), resetsAt),
      sharedStoreConfigured: budget.available,
    },
    { headers: NO_STORE },
  );
}