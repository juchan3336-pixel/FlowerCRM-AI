# SEO Platform

Isolated Next.js App Router app for syncing existing Google Sheets collect/enrich output into Supabase, rendering public SEO pages, and linking orders to the configured flower order URL.

## Current MVP scope

- App Router TypeScript + Tailwind v4 app under `seo-platform/` only.
- Supabase migration foundation for places, SEO pages, AI generations, sync runs/errors, settings, RLS, indexes, checks, updated-at trigger, and a public-safe view.
- Fixture-backed public routes for area, funeral, hospital, and product SEO pages.
- Sitemap, robots, search verification metadata, and deterministic 100 funeral-page seed coverage.
- Admin read-only surfaces for dashboard, places, SEO pages, AI generation, sync, sitemap, and settings.
- No changes to existing `src/`, `collect/`, `enrich/`, `work/`, tests, or Sheet columns.

## Setup

```powershell
cd seo-platform
npm install
Copy-Item .env.example .env.local
npm run typecheck
npm run lint
npm run test
npm run build
```

## Environment safety

`SUPABASE_SERVICE_ROLE_KEY` is server-only by naming and import convention. Use it only from files that import `server-only`, server actions, route handlers, cron jobs, or CLI scripts. Never rename it to `NEXT_PUBLIC_*`.

## Environment variables

Copy `.env.example` to `.env.local` for local development. Vercel uses the same names in Project Settings > Environment Variables.

| Name | Visibility | Required for MVP build | Notes |
|---|---|---:|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Browser-safe public | No | Supabase project URL. Required when live Supabase reads/auth are wired. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser-safe public | No | Supabase anon key. RLS must remain enabled. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only secret | No | Use only in server-only sync/admin code. Never expose to client components or `NEXT_PUBLIC_*`. |
| `NEXT_PUBLIC_SITE_URL` | Public config | No | Optional override for the public SEO origin (sitemap, robots, canonical, OG, JSON-LD). When unset, Vercel deployments use the fixed public domain `https://place.xn--hq1bo4e93ri3lbmc.com` and local dev uses localhost. |
| `SEO_PLATFORM_SITE_URL` | Public config | No | App (admin/auth) origin default used by password-reset redirects. Public SEO surfaces no longer read this variable. |
| `SEO_PLATFORM_BRAND_NAME` | Public config | No | Brand name used by metadata/layout copy. |
| `SEO_PLATFORM_DEFAULT_ORDER_URL` | Public config | No | Default CTA target, for example the 팔도플라워.com order page. |
| `GOOGLE_SITE_VERIFICATION` | Public config | No | Google Search Console verification token. Leave blank until Search Console setup. |
| `NAVER_SITE_VERIFICATION` | Public config | No | Naver Search Advisor verification token. Leave blank until Search Advisor setup. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Server-only secret | No | Service-account JSON text used only by the manual Google Sheets sync action. Share the Sheet with this service account email. |
| `GOOGLE_SPREADSHEET_ID` | Server-only config | No | Existing CRM spreadsheet ID read by manual sync. |
| `GOOGLE_SHEET_NAME` | Server-only config | No | Defaults to `기업 DB`. |
| `GOOGLE_SHEET_RANGE` | Server-only config | No | Defaults to `A:M`, matching the existing Korean Sheet columns. |

Do not commit `.env.local`, service-account JSON, Supabase keys, or provider API keys.

## Supabase migration

Apply `supabase/migrations/202607030001_initial_foundation.sql` to a Supabase project. Public SEO reads must use `public.published_place_pages`; raw tables contain private fields such as `email`, `memo`, import payloads, and sync metadata.

Recommended setup:

1. Create a Supabase project.
2. Open SQL Editor and run `supabase/migrations/202607030001_initial_foundation.sql`.
3. Confirm RLS is enabled on raw tables.
4. Confirm public SEO reads use `public.published_place_pages`, not raw `places` or `seo_pages`.
5. Store `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in Vercel environment variables.

The current tests and build do not require live Supabase credentials.

## Vercel deployment

Set the Vercel project root directory to `seo-platform`.

Recommended settings:

- Framework preset: Next.js.
- Install command: `npm install`.
- Build command: `npm run build`.
- Output directory: leave as the Next.js default.
- Node.js version: 24 or newer.

Production environment checklist:

1. Public SEO origin is fixed in code (`PUBLIC_SEO_SITE_URL`, punycode of place.팔도플라워.com). Set `NEXT_PUBLIC_SITE_URL` only to override it.
2. Set `SEO_PLATFORM_DEFAULT_ORDER_URL` to the live 팔도플라워.com order URL or product landing page.
3. Add Supabase variables after the Supabase project is created.
4. Add search verification tokens only after creating Google Search Console and Naver Search Advisor properties.
5. Deploy and check `/robots.txt`, `/sitemap.xml`, one `/funeral/...` page, and `/admin`.

Admin routes are protected by the Supabase SSR proxy when `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are configured. In credential-free local/test builds, the guard no-ops so tests and static checks do not require live Supabase Auth.

## 100 funeral-page seed check

The deterministic seed generator creates 100 published funeral SEO records without live Supabase or Google Sheets access.

```powershell
npm run seed:test
```

This verifies:

- exactly 100 generated funeral records;
- unique slugs, paths, and canonical URLs;
- no private source fields such as phone, email, memo, import payload, sync metadata, or service-role tokens;
- all 100 generated funeral canonical URLs appear in the real sitemap output.

This is a test-mode backfill foundation. Live database backfill should reuse the same public-safe shape after Supabase write repositories are wired.

## Search console and Naver setup

Manual operator steps:

1. Deploy the app (public SEO origin resolves to `https://place.xn--hq1bo4e93ri3lbmc.com` on Vercel).
2. Create a Google Search Console URL-prefix or domain property.
3. Put the Google HTML meta token value in `GOOGLE_SITE_VERIFICATION` and redeploy.
4. Submit `https://place.xn--hq1bo4e93ri3lbmc.com/sitemap.xml` in Search Console.
5. Create a Naver Search Advisor site.
6. Put the Naver meta token value in `NAVER_SITE_VERIFICATION` and redeploy.
7. Submit the sitemap in Naver Search Advisor.

The app provides metadata support only. It does not automate account ownership verification or search-engine submission.

## Scripts

- `npm run dev` starts local Next.js.
- `npm run typecheck` runs strict TypeScript.
- `npm run lint` runs ESLint flat config.
- `npm run test` runs Vitest domain/schema tests.
- `npm run build` creates a production build.
- `npm run sync:test` runs the local fixture sync entry with an in-memory repository, proving first import, repeat idempotency, row-level errors, and SEO-field preservation without Supabase or Google credentials.
- `npm run seed:test` verifies deterministic 100 funeral-page generation and sitemap inclusion without Supabase or Google credentials.

## Manual Google Sheets sync

The `/admin/sync` page includes a server action that reads the existing Google Sheet and writes Sheet-owned fields into Supabase `places`, `sync_runs`, and `sync_errors`. It requires these production environment variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `GOOGLE_SPREADSHEET_ID`

Optional overrides are `GOOGLE_SHEET_NAME` and `GOOGLE_SHEET_RANGE`. The default range is `기업 DB!A:M`, matching the current CRM headers: 회사명, 업종, 세부업종, 지역, 주소, 대표전화, 홈페이지, 이메일, 출처URL, 수집일, 등급, 영업상태, 메모.

Normal tests and builds remain credential-free; missing sync credentials only disable the live manual action at runtime.
