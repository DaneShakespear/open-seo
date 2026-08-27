# OpenSEO Implementation Plan

Canonical Vault record: `/Users/daneshakespear/Obsidian Vault/! BRAIN VAULT/06-PROJECTS/OpenSEO.md`

## Decisions

- This repository is Dane's fork of `every-app/open-seo`.
- Develop natively on the Mac with Corepack, the repository-pinned pnpm version, Vite, local D1, and `pnpm dev:agents`.
- Do not use Docker for development.
- Deploy the persistent Dane-only instance through OpenSEO's Cloudflare self-host path.
- Use the generated `workers.dev` hostname initially and Cloudflare Access with only Dane allowed.
- Start on Workers Free. R2 activation and any Workers Paid upgrade require action-time approval.
- Retrieve credentials from Infisical at runtime. Never commit or print them.

## Sequence

1. Install dependencies and configure ignored local development environment values.
2. Apply local D1 migrations.
3. Run tests, type checks, build checks, and a local browser smoke test.
4. Authenticate Alchemy/Wrangler with OAuth and bootstrap its Cloudflare state store.
5. Configure the ignored self-host environment file and deploy.
6. Verify Cloudflare Access, health, DataForSEO, a site audit, rank checking, persistence, scheduled resources, and billing state.
7. Update `CURRENT-STATE.md` and the canonical Vault/registry records.

## Acceptance

- Local development works without Docker.
- The application builds, tests, type-checks, and runs.
- Unauthorized users are blocked from the deployed instance; Dane can sign in.
- A real DataForSEO request, site audit, and rank check complete.
- Cloudflare data and scheduled resources survive redeployment.
- No unapproved subscription or unexpected charge is created.

