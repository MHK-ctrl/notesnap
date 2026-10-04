# 📸 NoteSnap

**Snap a photo of handwritten notes — notebook, whiteboard, sticky note — and get clean, editable, paste-ready text in seconds.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Next.js 15](https://img.shields.io/badge/Next.js-15-black.svg)](https://nextjs.org)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMHK-ctrl%2Fnotesnap&env=GEMINI_API_KEY&envDescription=Your%20own%20Google%20AI%20Studio%20Gemini%20API%20key%20%28free%20tier%2C%20server-side%20only%2C%20never%20exposed%20to%20the%20browser%29&envLink=https%3A%2F%2Faistudio.google.com%2Fapikey&project-name=notesnap&repository-name=notesnap)

![NoteSnap upload screen](docs/screenshot.png)

![NoteSnap result screen](docs/screenshot-result-stubbed.png)

<sub>Both images are real captures of this app at a 390px mobile viewport. The first is
the upload screen. The second shows the result screen with a **stubbed transcription** —
the OCR response was mocked so the capture could be taken without an OCR key — and
it carries a visible label saying so. Read it as a UI sample, not as an OCR result; a GIF
of a real snap → text run is the next upgrade here.</sub>

> ### 🔑 Each deployer brings their own OCR key
>
> This repository ships **no API key** and never will. OCR requests count against
> whoever owns the key, so **you run NoteSnap against your own account**. The
> shortest path is a free Gemini API key from Google AI Studio — no credit card —
> see [Get a free Gemini key](#get-a-free-gemini-api-key-no-credit-card).
> Already have Google Cloud Vision? Point `GOOGLE_VISION_API_KEY` at it instead:
> [Alternative: Google Cloud Vision key](#alternative-google-cloud-vision-key).

> ### 🔍 Live demo
>
> **<https://notesnap-theta.vercel.app>** — the UI, the camera input, the
> browser-side resizing and every validation check run for real there.
>
> <sub>The hosted demo runs a real Gemini key on the free tier, so uploads
> transcribe for real. Two honest caveats: quota is shared by everyone who uses
> the link, so it is capped at 10 requests/minute per IP and can hit Gemini's
> per-project daily limit; and on the free tier Google may use submitted images
> to improve its products — don't scan anything sensitive here. Use your own
> deployment (below) with your own key for anything private.</sub>

---

## Features

- 📷 **Camera or gallery** — the primary input opens the rear camera directly on phones, with a second input for existing photos.
- 🖼️ **Preview before you send** — you see the exact photo that will be uploaded, plus its size and dimensions.
- 🗜️ **Compressed in the browser** — images are capped at 2200px on the longest edge and re-encoded at high JPEG quality before upload, which cuts upload time and upload payload size.
- ✍️ **Handwriting-focused OCR** — Google's Gemini API (free tier, no credit card) or Cloud Vision `DOCUMENT_TEXT_DETECTION`, behind one server-side adapter.
- ✏️ **Editable result** — fix OCR mistakes in a plain textarea before you use the text.
- 📋 **Copy in one tap** — with a "Copied!" confirmation.
- 🔁 **Re-transcribe** — run the same photo through OCR again without re-taking it.
- 🔄 **Start over** — clears the photo, the text and any errors.
- 🚦 **Clear states** — loading, and human-readable errors for wrong type, oversized file, blank page, OCR failure and missing credentials.
- 🔒 **No auto-correct** — NoteSnap shows literally what OCR read. It never silently "fixes" your words.
- 📱 **Mobile-first and accessible** — labelled controls, keyboard-friendly, live regions for status updates, visible focus rings.

## How it works

```text
 ┌─────────────────────────── browser ───────────────────────────┐
 │ 1. <input type="file" accept="image/*" capture="environment"> │
 │ 2. preview the photo  (object URL, stays on your device)      │
 │ 3. resize to max 2200px + re-encode as JPEG (canvas)          │
 │ 4. POST multipart/form-data ──────────────────────────────────┼──┐
 └───────────────────────────────────────────────────────────────┘  │
                                                                    ▼
 ┌─────────────────────────── server (Vercel) ─────────────────────────┐
 │ 5. /api/transcribe  → rate limit → re-validate type & size (≤10MB)  │
 │ 6. OCR provider: Gemini (free tier) or Cloud Vision, by env key     │
 │    (key read from process.env, server-side only)                    │
 │ 7. return the literal text                                          │
 └─────────────────────────────────────────────────────────────────────┘
                                                                    │
 ┌─────────────────────────── browser ────────────────────────────────┐
 │ 8. editable textarea → copy / re-transcribe / start over           │
 └────────────────────────────────────────────────────────────────────┘
```

- The OCR call lives in exactly one place: `app/api/transcribe/route.ts` → `lib/vision.ts`.
- `lib/vision.ts` is marked `server-only`, so a client component importing it fails the **build** instead of leaking a key.
- Two engines ship today — Gemini (free tier) and Cloud Vision — picked by which key you configure. Want a different OCR engine? Reimplement `transcribeImage()` in `lib/vision.ts` and nothing else has to change.

## Privacy

- Your image is sent to Google (the Gemini API or Cloud Vision, depending on which key is configured) for processing, then discarded. **NoteSnap does not store your photos or your text** — no database, no blob storage, no upload log.
- The preview and the OCR result live only in your browser tab's memory. Closing the tab loses both.
- Nothing is written to disk on the server; the image is held in memory for the duration of one request.
- The only third party involved is Google, under [Google Cloud's terms](https://cloud.google.com/terms) and — for Gemini — [the Gemini API terms](https://ai.google.dev/gemini-api/terms).
- **Gemini free tier: read this before you scan anything sensitive.** Every request is sent with `store: false`, so Google does not retain the Interaction server-side after the response. That is the opposite of the usual "saved to your activity" default, but it is **not** the same as "never used": Google's published data-handling terms say content submitted on the Gemini API **free tier may be used to improve Google's products** (the paid tier is the tier that opts out). For medical, legal, financial or otherwise confidential notes, use Cloud Vision with billing — or a paid Gemini tier — or swap in another engine in `lib/vision.ts`.

## Quick start (local)

```bash
git clone https://github.com/MHK-ctrl/notesnap.git
cd notesnap
npm install

cp .env.example .env.local      # then paste your key into GEMINI_API_KEY (free) — or GOOGLE_VISION_API_KEY

npm run dev                     # http://localhost:3000
```

Requirements: **Node.js 20 or newer** and npm.

> `navigator.clipboard` needs a secure context. `http://localhost` counts as secure,
> so copy works in local development.

## Get a free Gemini API key (no credit card)

This is the setup the app recommends: a Gemini API key from Google AI Studio
runs on a free tier that needs no Cloud Billing account and no credit card.
Two minutes:

1. **Open the API keys page** — <https://aistudio.google.com/apikey> and sign in with any Google account. (Cloud Billing problems on your account don't block this: the free tier never touches Cloud Billing.)
2. **Create the key** — **Create API key**, then pick a project (AI Studio offers to create one for you).
3. **Copy it** into `.env.local`:

   ```bash
   GEMINI_API_KEY=AIza...your-key...
   ```

4. **Restart the dev server** — the key is read per request, but Next.js only loads `.env.local` at startup.

By default the adapter calls a current Flash model (`gemini-3.8-flash` at the
time of writing). Override it with `GEMINI_MODEL` if that model isn't in your
project's free tier or you want a different trade-off:

```bash
GEMINI_MODEL=gemini-3.5-flash-lite    # cheaper/faster, weaker on messy handwriting
```

Smaller models work, but they read messy handwriting less reliably — if results
get worse, try a larger Flash model before suspecting your photos.

**Free-tier limits are per project**, not per key: requests per minute, tokens
per minute and requests per day, varying by model. **Requests per day reset at
midnight US Pacific.** See the live numbers at
<https://ai.google.dev/gemini-api/docs/rate-limits>, and your own project's
actual usage in AI Studio under *Dashboard → Usage*. Every key you create in the
same project draws on the same quota. NoteSnap's own limiter (10/minute per IP)
usually bites first. On the free tier Google may use submitted content to
improve its products — see [Privacy](#privacy).

## Alternative: Google Cloud Vision key

Already have a Google Cloud project with billing? Vision's
`DOCUMENT_TEXT_DETECTION` is still a first-class engine and needs no code
changes: the adapter picks Cloud Vision whenever `GOOGLE_VISION_API_KEY` is set
(it wins over a Gemini key when both are present).

Vision's REST API accepts an API key, so there is no SDK and no service-account
JSON to manage. About five minutes:

1. **Create a project** — <https://console.cloud.google.com/projectcreate>. This project is **yours**: NoteSnap ships no Google Cloud resources, there is no shared "notesnap" project to join, and the name is arbitrary (`notesnap-dev` is a fine choice).

   Then find your **Project ID** — it's the small grey ID next to the project's name in the picker (<https://console.cloud.google.com/projectselector2/home/dashboard>), something like `notesnap-dev-482113`. Every console link below accepts `?project=<that-ID>`, and it's what you'd hand to a helper. The project ID is not a secret; the API key is.
2. **Enable the Cloud Vision API** — <https://console.cloud.google.com/apis/library/vision.googleapis.com>, select your project, click **Enable**. (OCR requests fail with `403` until this is done.)
3. **Make sure billing is on** — <https://console.cloud.google.com/billing>. Vision has a free monthly tier, but Google requires a billing account on the project. See [Cost & limits](#cost--limits).
4. **Create the key** — <https://console.cloud.google.com/apis/credentials> → **Create credentials** → **API key**.
5. **Restrict the key (recommended)** — in the key's settings, under *API restrictions*, choose **Restrict key** → **Cloud Vision API**. It's a server-side key; there is no need to add HTTP referrer restrictions.
6. **Copy the key** into `.env.local`:

   ```bash
   GOOGLE_VISION_API_KEY=AIza...your-key...
   ```

7. **Restart the dev server.** The key is read per request, but Next.js only loads `.env.local` at startup.

If you'd rather use a service account (`GOOGLE_APPLICATION_CREDENTIALS`) with a
scoped IAM role, that's a better fit for production workloads — you'd exchange the
JSON for an OAuth access token inside `lib/vision.ts`. The API-key path is the
shortest path from clone to working OCR.

## Deploy to Vercel

### One click

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMHK-ctrl%2Fnotesnap&env=GEMINI_API_KEY&envDescription=Your%20own%20Google%20AI%20Studio%20Gemini%20API%20key%20%28free%20tier%2C%20server-side%20only%2C%20never%20exposed%20to%20the%20browser%29&envLink=https%3A%2F%2Faistudio.google.com%2Fapikey&project-name=notesnap&repository-name=notesnap)

Vercel asks for `GEMINI_API_KEY` during setup and keeps it server-side.

### From the CLI

```bash
npm i -g vercel
vercel login
vercel link            # create/link the project
vercel env add GEMINI_API_KEY production   # paste your key when prompted
vercel env add GEMINI_API_KEY preview      # optional, for preview builds
vercel --prod
```

### Manual steps in the dashboard

1. **Add the project** — *Add New… → Project*, import your fork of `notesnap`.
2. **Add the environment variable** — *Settings → Environment Variables*: name `GEMINI_API_KEY` (or `GOOGLE_VISION_API_KEY`), value = your key, environments = Production (and Preview if you want preview deploys to work).
3. **Redeploy** — env changes only apply to new deployments.
4. **Verify** — open the deployment URL on your phone, take a photo, and watch for text.

### Environment variables (all of them)

| Variable | Required | What it does |
| --- | --- | --- |
| `GEMINI_API_KEY` | **Yes** | Free-tier Gemini key from Google AI Studio. Server-side only — never prefix it with `NEXT_PUBLIC_`. |
| `GOOGLE_VISION_API_KEY` | **Yes** | Cloud Vision key. Wins over `GEMINI_API_KEY` when both are set. |
| `GEMINI_MODEL` | No | Gemini model override, e.g. `gemini-3.5-flash-lite` (default: a current Flash model, `gemini-3.8-flash` at the time of writing). |
| `UPSTASH_REDIS_REST_URL` | Recommended | Shared rate-limit and demo-budget store. Without it, the public demo has no cross-instance counting. |
| `UPSTASH_REDIS_REST_TOKEN` | Recommended | REST token paired with that URL. |
| `RATE_LIMIT_MAX` | No | Requests allowed per client per window (default `10`). |
| `RATE_LIMIT_WINDOW_MS` | No | Window length in milliseconds (default `60000`). |
| `DEMO_DAILY_MAX` | No | Total demo transcriptions per Pacific day (default `100`). |
| `PER_IP_DAILY_MAX` | No | Transcriptions one visitor may make per Pacific day (default `10`). |

\* One OCR key is required — `GEMINI_API_KEY` (free) or `GOOGLE_VISION_API_KEY`.

```bash
# add the shared limiter to an existing deployment
vercel env add UPSTASH_REDIS_REST_URL production     # https://your-db.upstash.io
vercel env add UPSTASH_REDIS_REST_TOKEN production   # paste the REST token when prompted
vercel --prod                                        # env changes need a new deployment
```

## The demo budget: why a public free-tier demo needs quotas

A free Gemini key is per **project**, not per app or per key, and its daily limit
resets at **midnight Pacific**. Note these are **per project and per model** —
check your actual numbers at
<https://ai.google.dev/gemini-api/docs/rate-limits> or in AI Studio under
*Dashboard → Usage*.

On a publicly reachable deployment that creates one specific failure: any
visitor can spend the maintainer's whole daily budget, and after that every
visitor gets an error until the reset. The app used to do exactly that — it would
hand out requests until Google started refusing them.

NoteSnap now meters the demo budget itself, in Upstash Redis so every serverless
instance shares one set of counters:

| Guard | Default | Scope |
| --- | --- | --- |
| Per-IP burst | 10 / 60s | demo **and** bring-your-own-key requests |
| Per-IP daily | 10 per Pacific day | demo requests only |
| Global daily | 100 per Pacific day | demo requests only |

**Set `DEMO_DAILY_MAX` below your project's actual requests-per-day.** The point
is for NoteSnap to stop serving requests *before* Google starts refusing them, so
visitors see "the demo is done for today" instead of an error.

**There is no universally safe cap value.** Google's limits are per project *and*
per model, differ between free and paid tiers, and change. Read your own number:

- AI Studio → *Dashboard → Usage* (your project's real consumption)
- <https://ai.google.dev/gemini-api/docs/rate-limits> (published tiers)
- The API itself — a rejected response names the metric, e.g.
  `quotaMetric: GenerateRequestsPerDay`. NoteSnap logs that field when it sees
  one, so you can set the cap from evidence rather than a guess.

Leave a margin (roughly 20–30% below your limit) so the demo closes cleanly
before Google starts refusing requests, rather than mid-traffic.

The default of 100 is an orientation value, not a recommendation: set it from
your own project's number.

**If Redis is unreachable the demo fails closed** with `503 demo_unavailable`.
That is deliberate: quietly falling back to per-instance memory would let a
Redis blip hand out unmetered requests and burn the project's quota invisibly.
Point people at their own key instead. `GET /api/status` reports the same state
the UI shows, with no secrets.

### How provider failures are classified

A 429 is not automatically "the day is over". NoteSnap decides in a fixed order,
most-trustworthy signal first:

1. **Structured details** — a `quotaMetric` naming a per-day limit
   (`GenerateRequestsPerDay`) is machine-readable evidence of daily exhaustion.
2. **Narrow message patterns** — only phrases that explicitly say *per day*.
3. **A valid `RetryInfo` / `Retry-After`** — the provider said when to come
   back, so exactly that wait is used.
4. **Otherwise: transient**, with a short shared cooldown.

That last rule is the important one. An **ambiguous 429 never locks the app for
a day** — it triggers a brief, shared cooldown (bounded, default 15s, hard cap
2 minutes) during which every serverless instance backs off together. Being
wrong in that direction costs seconds; being wrong the other way would take the
demo down for a full day over a transient blip.

Two breakers are tracked separately in Redis, and `/api/status` exposes the
current one as `provider.state`:

| `provider.state` | Meaning | `resetsAt` / `retryAfterSeconds` |
| --- | --- | --- |
| `ready` | No breaker, no throttle | — |
| `daily_quota_exhausted` | Confirmed per-day quota rejection | `resetsAt` = next midnight Pacific |
| `temporarily_throttled` | Short-lived rate limiting | `retryAfterSeconds` = wait to use |
| `unknown` | No shared store, so state can't be read | — |

`unknown` is deliberate: with no store the app cannot know, and claiming `ready`
would be a claim it cannot support. The UI says "the demo can't confirm the
provider's state" rather than implying everything is fine.

### Accounting: reserve on attempt, refund on confirmed failure

A demo request reserves budget before the provider call, and refunds it only when
the provider **clearly refused** (invalid key, disabled API, daily quota spent).
Ambiguous outcomes — timeouts, dropped connections, a 5xx after the bytes were
sent — are **not** refunded, because the provider may still have counted them.
Refunds use a single atomic decrement clamped at zero, so concurrent refunds
cannot lose updates or drive a counter negative.

### Legitimate ways to add capacity

- **Wait for the reset** — free, at midnight Pacific.
- **Enable billing** — a paid Gemini tier, billed to you.
- **Bring your own key** — the UI has a key field; your request spends *your*
  quota and skips the demo budget entirely.
- **Self-host** — your deployment, your quota, no shared counters.
- **Cloud Vision** — a separate product with a separate quota
  (~1,000 free images/month), but it requires Cloud Billing.

> **Do not create extra Google projects or keys to evade a quota.** Google's APIs
> Terms of Service prohibit circumventing documented rate and quota limits, so
> farming quota across projects is not a workaround — it's a violation.

## Bring your own key (works even when the demo is closed)

The UI has an optional key field. When filled, that request is billed to **your**
Gemini quota and skips the demo's daily budget and circuit breaker entirely — so
a shared demo stays useful after its own quota is spent, without anyone creating
extra Google projects to farm quota.

> **Your key is sent to this app's server for this request only; it is not
> stored.** It is held in memory for one request, never written to disk or
> Redis, never logged (upstream error text is scrubbed of it), never saved to
> localStorage or a cookie, and discarded when you clear the field or close the
> tab. Self-host for full privacy.

Bring-your-own-key requests still pass the light per-IP burst limit, which keeps
the deployment from being used as an open proxy. For anything confidential,
self-host instead, so the image never touches someone else's server.

## Shared rate limiting (Upstash Redis)

A rate limiter that lives in one process's memory can't protect a serverless app:
Vercel runs several instances, each with its own counter. `lib/rate-limit.ts`
therefore uses [@upstash/ratelimit](https://github.com/upstash/ratelimit) with a
sliding window over Upstash Redis, so all instances share one counter.

**Setup (no code changes needed):**

1. Create a database at <https://console.upstash.com> — **Create Database**, pick a
   region close to your users, Redis type is fine.
2. On the database page, copy the **REST URL** and the **REST TOKEN**.
3. Add both to your environment (locally in `.env.local`; on Vercel via the
   commands above or *Settings → Environment Variables*).
4. Redeploy and check which limiter answered:

   ```bash
   curl -s -D - -o /dev/null -F "image=@note.jpg" https://your-app.vercel.app/api/transcribe \
     | grep -i x-ratelimit-mode
   # X-RateLimit-Mode: shared
   ```

**Free tier:** Upstash's free plan is 500,000 commands/month, 256 MB storage and
10 GB bandwidth (as published in 2026 — see
<https://upstash.com/pricing/redis> for the current numbers). One rate-limit check
is a couple of commands, so the free tier covers far more traffic than a demo
gets; the limit that will bite first is the OCR provider's own quota — Gemini's
free-tier daily requests, or Vision's ~1,000 free images a month.

**Behaviour when Redis fails:** the route logs
`shared rate limiter unavailable`, serves the request anyway, and reports
`X-RateLimit-Mode: instance` — a public demo stays usable during an Upstash
outage, at the cost of degraded limiting until it recovers. If you'd rather fail
closed, throw from `checkRateLimit` instead of falling through in
`lib/rate-limit.ts`.

## Cost & limits

**Gemini free tier (default):** free of charge and no credit card, capped by
per-project rate limits (requests per minute and per day, varying by model) —
current numbers at <https://ai.google.dev/gemini-api/docs/rate-limits>. A
personal demo fits inside it comfortably, and NoteSnap's own limiter (10/min per
IP) keeps a public URL inside it too.

**Cloud Vision (alternative):** the first **~1,000 feature-units per month are
free**, after which **DOCUMENT_TEXT_DETECTION is roughly $1.50 per 1,000
images**; a Cloud Billing account is required on the project even for the free
tier. See <https://cloud.google.com/vision/pricing> for the current numbers.

> **Prices and free tiers change.** The links above are the source of truth —
> check them before sizing a deployment.

Built-in limits to protect a public demo:

| Guard | Default | Where |
| --- | --- | --- |
| Max upload size | 10 MB | `lib/validation.ts` (client *and* server) |
| Photos resized before upload | longest edge 2200px | `lib/image.ts` (browser) |
| Requests per client IP | 10 / 60s | `lib/rate-limit.ts` — Upstash sliding window, per-instance fallback |

**About the rate limiter:** with `UPSTASH_REDIS_REST_URL` and `_TOKEN` set, counters
live in Redis and every serverless instance shares them, so the limit is real
protection rather than a speed bump (see
[Shared rate limiting](#shared-rate-limiting-upstash-redis)). Without those vars the
route falls back to a per-instance counter and logs a warning in production — the
`X-RateLimit-Mode` response header always tells you which mode answered.

If you use Cloud Vision (or upgrade to a paid Gemini tier), add a **budget
alert** in Google Cloud billing so you hear about traffic spikes before your card
does.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `missing_credentials` on every request | No OCR key is set where the app runs | Local: put `GEMINI_API_KEY` (or `GOOGLE_VISION_API_KEY`) in `.env.local` and restart `npm run dev`. Vercel: add it under *Settings → Environment Variables* and **redeploy**. |
| `invalid_credentials` | The key is wrong, deleted or revoked | Gemini: create a fresh key at <https://aistudio.google.com/apikey>. Cloud Vision: re-check the key under *API restrictions* and confirm Vision shows **Enabled** for its project. |
| `api_not_enabled` | The OCR API isn't enabled on the project that owns the key | Cloud Vision: open <https://console.cloud.google.com/apis/library/vision.googleapis.com> **with that project selected** and click **Enable**. Gemini: enable the Generative Language API on that project, or create a fresh AI Studio key. |
| `billing_not_enabled` | A Cloud Vision project has no usable billing account | Add billing to it (required even for Vision's free monthly tier), or switch to a free Gemini key. See [Cost & limits](#cost--limits). |
| `403 PERMISSION_DENIED` in logs | Cloud Vision: billing isn't enabled, or the key is restricted to a different API | Enable billing on the project; in the key's *API restrictions*, allow **Cloud Vision API**. |
| `no_text` (422) | The OCR engine found no handwriting | Fill the frame with the page, avoid glare and shadows, keep the phone parallel to the paper, use black ink on light paper. |
| Photo looks squashed or unreadable after resizing | Very wide/tall source image | Retake it square-on; the app caps the longest edge at 2200px but never crops. |
| HEIC photos from an iPhone fail | Your browser can't decode HEIC for compression, so the original is sent | Safari handles HEIC; if it still fails, set *Settings → Camera → Formats → Most Compatible*, or export as JPEG. |
| Copy button says "Press Ctrl/Cmd + C" | Non-secure origin — the clipboard API is blocked | Serve over HTTPS (Vercel does this) or use `localhost`. |
| `rate_limited` (429) | More than 10 transcriptions in a minute from one IP | Wait a minute, or raise `RATE_LIMIT_MAX`. |
| `demo_budget_exhausted` (429) | The demo's shared daily budget is spent (per-IP or global) | Waits for midnight Pacific. Add your own key in the UI, self-host, or raise `DEMO_DAILY_MAX` **if** your provider limit allows it. |
| `provider_quota_exhausted` (429) | Google's per-project **daily** quota for this key is spent (confirmed via a per-day `quotaMetric` or an explicit per-day message) | Wait for the midnight-Pacific reset, enable billing, or bring your own key. |
| `provider_busy` (429) | The provider is **temporarily** throttling — an ambiguous 429, or one carrying a `Retry-After` | Wait the `Retry-After` seconds and retry. Nothing is lost; this is not a daily limit. |
| `demo_unavailable` (503) | The shared Upstash store is unreachable, so the demo can't track its budget | Check the Upstash database is active and both env vars are set for **Production**. The demo fails closed on purpose rather than serving unmetered requests. |
| Quota errors (`429`, `ocr_failed`) | Gemini free-tier requests/day exhausted, or Cloud Vision rate limiting | Wait for the quota to reset (Gemini daily quotas reset at midnight US Pacific), raise your own limits, or upgrade the provider tier. |
| `X-RateLimit-Mode: instance` in production | Upstash env vars are missing, so the limiter is per-instance only | Add `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (see [Shared rate limiting](#shared-rate-limiting-upstash-redis)) and redeploy. |
| Logs say "shared rate limiter unavailable" | Redis was unreachable; the route kept serving on the per-instance fallback | Check the Upstash database is active and the REST token is correct for **both** Production and Preview environments. |
| `413 too_large` | Photo is over 10 MB | Lower the camera resolution, or raise `MAX_FILE_BYTES` in `lib/validation.ts`. |
| Everything works locally, fails on Vercel | Env var added after the last deploy | Redeploy — environment variables are read at runtime, but only new deployments pick them up. |

## Development

```bash
npm run dev        # dev server
npm run build      # production build
npm run lint       # ESLint (including Next.js rules)
npm run typecheck  # tsc --noEmit
npm test           # Vitest unit tests
```

The suite covers the shared validation rules, the image-resize math, both rate
limiter modes (the Upstash wiring is mocked, so no account is needed), the OCR
wrapper (both providers, with an injected `fetch`), the daily-budget accounting
(atomic caps, Pacific day keying, fail-closed behaviour), bring-your-own-key
parsing and redaction, and the API routes' happy and failure paths —
**no Google, Vercel or Upstash credentials required**.

To check real recognition against a deployment, run the fixture script. It posts
an image with known text and diffs the transcription line by line:

```bash
node scripts/ocr-fixture.mjs https://your-app.vercel.app \
  --image /path/to/notes.png \
  --expect "line one|line two"

# Use your own quota instead of the demo's:
X_NOTESNAP_USER_KEY=AIza... node scripts/ocr-fixture.mjs https://your-app.vercel.app
```

Exit code 0 means every expected line matched; 1 means a mismatch; 2 means the
request itself failed.

## Project structure

```text
app/page.tsx                    main UI and state machine
app/layout.tsx                  metadata + root layout
app/globals.css                 Tailwind entry and base styles
app/api/transcribe/route.ts     server-only OCR endpoint (validation, rate limit, error mapping)
components/PhotoUpload.tsx      camera/file input, drag & drop, preview
components/TranscriptEditor.tsx editable result + copy / re-transcribe / start over
lib/image.ts                    browser-side resize + re-encode
lib/vision.ts                   OCR wrapper — Gemini + Cloud Vision (server-only)
lib/validation.ts               file type + size checks (shared client/server)
lib/rate-limit.ts               rate limiter: Upstash sliding window + per-instance fallback
lib/demo-quota.ts               shared daily demo budget + quota circuit breaker
lib/pacific-time.ts             Pacific day keys and reset times for daily quotas
lib/user-key.ts                 bring-your-own-key header parsing + redaction
app/api/status/route.ts         public demo budget/quota status (no secrets)
components/DemoStatus.tsx       remaining-budget banner + BYOK key field
scripts/ocr-fixture.mjs         posts a known image to a live deployment and diffs the result
tests/                          Vitest unit tests
```

## Security notes

- The API key is read from `process.env` on the server and is never sent to the browser. Nothing is prefixed with `NEXT_PUBLIC_`.
- `lib/vision.ts` imports `server-only`, turning any accidental client import into a build error.
- Uploads are validated on the server as well as the client: image MIME types only, 10 MB max, empty-file rejection.
- `.env.local` and `.env*.local` are gitignored; `.env.example` contains placeholders only.
- Rate limiting exists so a public demo can't burn through a deployer's quota (see the caveat above).
- Found a security issue? Please open a private security advisory rather than a public issue.

## Contributing

Contributions are welcome — especially handwriting cases that come out wrong.

1. Fork the repo and branch off `main`.
2. `npm install && npm test && npm run lint && npm run build` should all pass.
3. Keep the OCR call inside `lib/vision.ts`, keep TypeScript strict, and add a test for behaviour you change.
4. Open a PR describing the before/after. Screenshots of a bad transcription help a lot.

Good first issues: a "Download as .txt" button, per-line confidence highlighting,
an Upstash-backed rate limiter, and language hints for non-English handwriting.

## License

[MIT](./LICENSE) — use it, fork it, ship it. Attribution is welcome but not required.
