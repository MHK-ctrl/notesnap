/**
 * Demo availability banner and bring-your-own-key field.
 *
 * Two jobs, both about being honest about capacity:
 *
 * 1. Tell a visitor *before* they upload that the shared demo is out of budget,
 *    and when it refreshes. Finding out by uploading wastes their photo and,
 *    on a public link, everyone else's quota too.
 * 2. Offer the way out — their own free key — which costs the maintainer nothing
 *    because it spends the visitor's own provider quota.
 *
 * The key field is deliberately uncontrolled-in-storage: the value is held in
 * React state for the life of the tab and sent per request in a header. It is
 * never written to localStorage or a cookie, and is cleared when the visitor
 * clears it or closes the tab.
 */

"use client";

/** Mirrors `ProviderState` in `lib/vision.ts`. */
type ProviderState =
  | "ready"
  | "daily_quota_exhausted"
  | "temporarily_throttled"
  | "unknown";

interface DemoStatusPanelProps {
  /** Remaining demo transcriptions today, or null when unknown. */
  remaining: number | null;
  /** The whole-demo daily cap. */
  limit: number;
  /** True when the demo can serve a request right now. */
  available: boolean;
  /** What the OCR provider is currently doing. */
  providerState: ProviderState;
  /** Seconds to wait out a temporary throttle; 0 otherwise. */
  retryAfterSeconds: number;
  /** Seconds until the daily budget refreshes. */
  resetsInSeconds: number;
  /** The visitor's own key. Memory only — never persisted. */
  userKey: string;
  onUserKeyChange: (value: string) => void;
}

/**
 * Formats the wait until the daily budget refreshes.
 *
 * An unknown or already-elapsed value reports "soon" rather than inventing a
 * duration: on the reset boundary the true wait is under a minute, and guessing
 * "0m" would read as a bug.
 */
function formatCountdown(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "soon";

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours <= 0) return `${Math.max(1, minutes)}m`;
  return `${hours}h ${minutes}m`;
}

export default function DemoStatusPanel({
  remaining,
  limit,
  available,
  providerState,
  retryAfterSeconds,
  resetsInSeconds,
  userKey,
  onUserKeyChange,
}: DemoStatusPanelProps) {
  const countdown = formatCountdown(resetsInSeconds);
  const usingOwnKey = userKey.trim().length > 0;

  return (
    <section
      aria-labelledby="demo-status-heading"
      className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm sm:p-5"
    >
      <h2 id="demo-status-heading" className="text-sm font-semibold text-slate-900">
        Demo quota
      </h2>

      {providerState === "daily_quota_exhausted" ? (
        <p className="text-slate-700">
          <strong>Daily free quota used up.</strong> Google&rsquo;s per-day limit for this
          demo&rsquo;s key is spent, so it resets in <strong>{countdown}</strong> (midnight
          Pacific). Your photo is fine — there is just no provider budget left today. Add your
          own free key below to keep going.
        </p>
      ) : providerState === "temporarily_throttled" ? (
        <p className="text-slate-700">
          <strong>The OCR provider is busy</strong> and rate limiting requests right now.
          Retrying in about{" "}
          <strong>{formatCountdown(retryAfterSeconds || resetsInSeconds)}</strong> should work —
          this is a short pause, not a daily limit, so nothing is lost.
        </p>
      ) : providerState === "unknown" ? (
        <p className="text-slate-700">
          The demo can&rsquo;t confirm the provider&rsquo;s state right now, so it&rsquo;s pausing
          new uploads rather than spending quota it can&rsquo;t track. Add your own free key
          below to keep going.
        </p>
      ) : available ? (
        <p className="text-slate-700">
          {remaining === null ? (
            <>This demo&rsquo;s daily allowance is shared by everyone using the link.</>
          ) : (
            <>
              <strong>{remaining}</strong> of {limit} demo transcriptions left today, shared by
              everyone using this link. Resets in {countdown} (midnight Pacific).
            </>
          )}
        </p>
      ) : (
        <p className="text-slate-700">
          The demo can&rsquo;t confirm its remaining quota right now, so it&rsquo;s pausing new
          uploads rather than spending quota it can&rsquo;t track. Add your own free key below to
          keep going.
        </p>
      )}

      <div className="space-y-2">
        <label htmlFor="user-key" className="block font-medium text-slate-900">
          Use your own free Gemini key (optional)
        </label>
        <input
          id="user-key"
          name="user-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={userKey}
          onChange={(event) => onUserKeyChange(event.target.value)}
          placeholder="AIza..."
          aria-describedby="user-key-warning"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
        <p id="user-key-warning" className="text-xs leading-relaxed text-slate-600">
          Your key is sent to this app&rsquo;s server for this request only; it is not stored, not
          logged, and not saved in your browser. It does bypass the demo&rsquo;s daily budget,
          since the request is billed to your own quota. Self-host for full privacy.
        </p>
        {usingOwnKey ? (
          <p className="text-xs font-medium text-emerald-700">
            Using your own key — this request won&rsquo;t count against the demo&rsquo;s budget.
          </p>
        ) : (
          <p className="text-xs text-slate-600">
            Get a free key at{" "}
            <a
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium text-slate-800 underline underline-offset-2 hover:text-slate-950"
            >
              Google AI Studio
            </a>{" "}
            — no credit card required.
          </p>
        )}
      </div>
    </section>
  );
}