# OpenSEO Current State

Updated: 2026-08-27

## Status

Implementation in progress.

## Completed

- Canonical project and infrastructure-audit plans filed in the Brain Vault.
- Botserver location corrected to the Kre8Media office.
- GitHub fork created at `DaneShakespear/open-seo`.
- Fork cloned to `/Users/daneshakespear/Workspace/Infrastructure/open-seo`.
- `origin` points to Dane's fork and `upstream` points to `every-app/open-seo`.
- Corepack is enabled and the repository-pinned pnpm `10.30.1` dependency install completed without changing the lockfile.
- All 43 local D1 migrations applied successfully.
- The full test suite passed: 133 files and 1,113 tests.
- Type checking and the production build passed.
- Native `pnpm dev:agents` served `http://open-seo.localhost:1355`; the dashboard rendered in a real browser and `/api/health` returned HTTP 200 with local auth and D1 healthy.
- The working DataForSEO credential pair on botserver was verified against the provider, converted to OpenSEO's required Basic-auth value, and added to the canonical Infisical `infrastructure / prod /` root as `DATAFORSEO_API_KEY` without printing or committing it.
- The canonical Infisical `OPENROUTER_API_KEY` entry was verified and is eligible for runtime injection.
- A live DataForSEO account request succeeded and reported a positive balance.
- Fixed an upstream initialization-order defect in `scripts/dataforseo-account-usage.ts` exposed by the live provider check; the utility now completes normally.

## Current Step

Obtain action-time approval for the Cloudflare OAuth profile and, if the account does not already have it enabled, R2 activation. Then run Alchemy bootstrap and deploy the self-host stack.

## Current Blockers

- Alchemy has no local OAuth profile yet. Creating it is the next external access change.
- R2 status is not yet verified. Enabling R2 can require adding a payment method even while usage remains inside the free allowance, so activation requires action-time approval.
- Cloudflare deployment, Access verification, real site audit, rank check, persistence across redeployment, and billing verification remain pending until those two boundaries are resolved.

## Deployment Decisions

- Native Mac development; no Docker development loop.
- Dane-only Cloudflare deployment on the generated `workers.dev` hostname.
- Workers Free first; R2 or paid-plan actions require action-time approval.
- Use OAuth for Alchemy/Wrangler because the canonical stored Cloudflare API token is currently unreliable.

## Resume Command

Read `PLAN.md`, this file, the canonical Vault record `06-PROJECTS/OpenSEO.md`, and `AGENTS.md`, then continue from the first incomplete acceptance condition.
