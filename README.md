# PageTest

Instant six-point health check for any URL. Built for **pagetest.revenuagency.io**.

Each report scores:

1. **Speed** — Lighthouse performance, LCP, CLS, TBT (desktop + mobile).
2. **Content** — Clarity of copy and value proposition.
3. **Digestibility** — Visual hierarchy, layout, scannability.
4. **CRO** — Calls to action, forms, conversion friction.
5. **Above the fold** — What's communicated in the first viewport.
6. **Mobile layout** — How the page behaves on a phone.

Speed comes from the **Google PageSpeed Insights API** (real Lighthouse runs on Google's servers). The four judgment scores come from **Claude** (Sonnet 4.5) with the page text + above-the-fold screenshots as input.

---

## Quick start (local)

```bash
# 1. Install deps
npm install

# 2. Create env file
cp .env.example .env.local
#    edit .env.local — set ANTHROPIC_API_KEY (required)
#                      set PAGESPEED_API_KEY (optional but recommended)

# 3. Run dev server
npm run dev
# open http://localhost:3000
```

### Environment variables

| Var | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Get one at https://console.anthropic.com |
| `PAGESPEED_API_KEY` | recommended | Without it PSI is heavily rate-limited. Free key at https://developers.google.com/speed/docs/insights/v5/get-started |

---

## Deploy to Vercel

This project is a vanilla Next.js 14 app — it deploys to Vercel with zero config.

### One-time setup

1. Push this folder to a Git repo (GitHub / GitLab / Bitbucket).
2. In Vercel, click **Add New → Project** and import the repo.
3. Framework preset: **Next.js** (auto-detected). Build command and output dir: default.
4. Under **Environment Variables**, add:
   - `ANTHROPIC_API_KEY`
   - `PAGESPEED_API_KEY`
5. Click **Deploy**. First deploy takes ~1 minute.

### Connect `pagetest.revenuagency.io`

In Vercel: **Project → Settings → Domains → Add** → enter `pagetest.revenuagency.io`.
Vercel will show you a DNS record to create — either:

- a `CNAME` record on `pagetest` pointing to `cname.vercel-dns.com`, **or**
- an `A` record on `pagetest` pointing to `76.76.21.21`.

Add it in your DNS host for `revenuagency.io` (Cloudflare, Namecheap, GoDaddy etc.).
Once DNS propagates (usually < 5 minutes) Vercel auto-issues an SSL cert.

### Function timeout

The `/api/analyze` route can take 30–60 seconds because Lighthouse does a real render. The route exports `maxDuration = 90` so Vercel allows up to 90 s. On Vercel's free Hobby plan the cap is 60 s — if you hit it, upgrade to Pro (or split the work into two requests).

---

## How it works

```
              ┌────────────────────────────────────────────────┐
   Browser ─▶ │  POST /api/analyze   {"url":"https://..."}    │
              └─────────────────────┬──────────────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
      PSI (desktop)          PSI (mobile)          fetch HTML
      ──────────────         ──────────────         ───────────
      perf score             perf score             extract:
      LCP/CLS/TBT            LCP                    - title / meta
      above-the-fold         above-the-fold         - body text
      screenshot             screenshot             - structure
                                    │
                                    ▼
                      Claude (sonnet-4-5, multimodal)
                      ─────────────────────────────────
                       text + structure + both shots →
                       scores for content / digestibility /
                       cro / aboveTheFold / mobile
                                    │
                                    ▼
                      Combine → JSON → render score cards
```

### Files of interest

- `app/page.tsx` — the single-page UI
- `app/api/analyze/route.ts` — the orchestration endpoint
- `lib/pagespeed.ts` — Google PSI wrapper
- `lib/fetchPage.ts` — server-side HTML fetcher + structural parser
- `lib/claude.ts` — Anthropic API call + JSON parsing
- `lib/types.ts` — shared types between server and client

---

## Tuning

Want to change the rubric or the way Claude scores things? Edit `SYSTEM_PROMPT` in `lib/claude.ts`. The shape of the JSON response is enforced by `parseChecks` — if you add a new field, update `lib/types.ts` and the UI in `app/page.tsx`.

Want a different model? Change `MODEL` at the top of `lib/claude.ts`.

---

## Cost

Each analysis runs:

- **2 PageSpeed calls** — free (with API key, generous quota; without, ~25k/day shared).
- **1 Claude call** — Sonnet 4.5 with two screenshots + ~12 KB of text. Roughly **$0.03–$0.05 per analysis** at current pricing.

---

## License

Proprietary — Revenu Agency.
