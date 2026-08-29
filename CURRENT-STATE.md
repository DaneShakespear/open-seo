# OpenSEO Current State

Updated: 2026-08-28

## Status

Live and verified on Cloudflare Workers Free.

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
- Activated R2 and Zero Trust Free on the correct Cloudflare account after action-time approval. Current billable usage is `$0.00`, and Workers remains on the Free plan.
- Created the Alchemy Cloudflare OAuth profile for account `0edf373db8a2b7539986bed528fe8794` and bootstrapped Alchemy's remote state.
- Deployed OpenSEO to `https://open-seo-selfhost.dane-0ed.workers.dev` with telemetry disabled and Cloudflare Access limited to `dane@daneshakespear.com`.
- Verified an unauthenticated browser is stopped at Cloudflare Access and the signed-in Dane account reaches the OpenSEO dashboard.
- Verified live DataForSEO-backed domain data for `kre8media.com`.
- Completed a 10-page site audit: 10 pages crawled, 37 findings, and a 201 ms average response time.
- Completed a one-keyword, manual-only, top-10 mobile rank check. `kre8 media outdoor advertising` returned position 1 for `https://kre8media.com/`.
- Redeployed the Worker and verified D1, both KV namespaces, R2, both Workflows, the Access application, and its policy were retained as unchanged resources. The saved audit and rank result remained available after redeployment.
- Verified deployed bindings for D1, KV, OAuth KV, R2, three Durable Objects, and both Workflows. Two Cron triggers are registered: every five minutes and daily at 03:17.
- Migrated 223 unique SerpBear keywords and 31,525 historical snapshots into five recurring configurations for April Wray, Kre8Media national, Kre8Media Las Vegas, Luxury Limousines, and TSB Podiatry. Production now contains 224 tracked keywords including the original Kre8 verification keyword.
- Connected and live-verified Google Search Console and Google Analytics for all four projects. The selected properties are April Wray (`https://aprilwray.com/`, GA4 `481285353`), Kre8Media (`https://kre8media.com/`, GA4 `295777039`), Luxury Limousines (`https://luxurylimousineoflasvegas.com/`, GA4 `383845879`), and TSB Podiatry (`sc-domain:tsbpodiatry.com`, GA4 `529021811`).
- Completed a 50-page TSB Podiatry production audit with 66 findings and a 1,164 ms average response time.
- Corrected the imported Las Vegas location to DataForSEO's canonical `Las Vegas,Nevada,United States` value; the local Kre8 tracker then completed 19 of 19 keywords.
- Repaired the Infisical synthetic check so it validates the canonical `infrastructure` project instead of an obsolete four-project count; the live service and timer pass.

## Current Step

Resolve the Workers Free workflow subrequest limit for large rank trackers, then complete the SerpBear decommission gate. Future customization work starts from this fork and the native Mac development loop.

## Current Blockers

- No OpenSEO deployment blocker remains.
- Large rank trackers cannot complete on Workers Free. Cloudflare permits only 50 subrequests per Workflow instance on Free; both-device runs therefore stop after about 25 keywords. Scheduled and manual production proof reproduced the limit. SerpBear remains unavailable for new work, but its runtime is retained until an approved resolution passes all five tracker checks.
- Targeted Brain indexing remains pending because a callable Brain indexing tool was not available in this task.
- The shared Infisical machine-credential exposure remains an infrastructure hot issue; OpenSEO used already-loaded named environment values without printing them.

## Deployment Decisions

- Native Mac development; no Docker development loop.
- Dane-only Cloudflare deployment on `https://open-seo-selfhost.dane-0ed.workers.dev`.
- Workers Free remains active. R2 and Zero Trust Free are active with approved overage billing. Any Workers Paid upgrade still requires action-time approval.
- Use OAuth for Alchemy/Wrangler because the canonical stored Cloudflare API token is currently unreliable.

## Resume Command

Read `PLAN.md`, this file, the canonical Vault records `06-PROJECTS/OpenSEO.md` and `08-SYSTEMS/OpenSEO.md`, and `AGENTS.md`. Use `pnpm dev:agents` for native development and the documented temporary `.env.selfhost` pattern plus `pnpm deploy:selfhost --yes` for future deployments. Never commit deployment secrets.
