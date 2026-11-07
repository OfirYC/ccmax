# Accedra integration implementation plan

> Execute natively using the executing-plans workflow, with a fresh whole-branch review.

**Goal:** Open a CCMAX PR integrating Accedra accounts and settled earnings at a 0.25× provider contract.
**Architecture:** Separate Accedra adapter; small provider/worker/UI branches reuse existing flows. Read-only Accedra daily statements provide the accounting boundary.
**Tech Stack:** Existing TypeScript, Fastify, React, Decimal.js, PGlite/Vitest; Go/PostgreSQL for the statement endpoint.
**Spec:** ../specs/2026-11-07-accedra-integration-design.md

## Global constraints

- Existing checkout remains untouched; no credentials in commits or PR text.
- Fixed HTTPS API base; key stays encrypted server-side.
- Contract 0.25×; account ownership follows successful exact-ID/email authorization.
- Only settled credit posting-day amounts enter billing; no lifetime/estimate substitution.

## Review focus

- Repeated job retries must not create duplicate upstream accounts.
- A completed authorization followed by a network failure must remain resumable.
- Multi-step attempts must not prematurely verify ownership or reuse codes.
- More than 500 earning events and Beijing-day boundaries must remain complete.
- API/UI capabilities must match actual supported endpoints and preserve existing platforms.

## Tasks

- [x] Add adapter contract tests; observe missing adapter fail; implement typed API/onboarding/statement adapter and provider hooks; verify targeted tests.
- [x] Add migration, privacy, worker/API regressions; observe failures; wire platform F, encrypted keys, idempotency, continuation, quote and unsupported capabilities; verify.
- [x] Reuse existing UI with F-specific credential labels and 0.25 default; document operator setup and exact settlement basis.
- [x] Implement/test the read-only statement endpoint independently in Accedra; confirm adapter fixtures match its actual response.
- [x] Run complete local tests, check/build, perform fresh review, push focused branches and open PRs. Keep any production key setup separate from source control.

## Execution record

- Baseline upstream 43d632a: all 366 tests in 27 files passed (79.69s).
- Existing local adapter was not copied. Native worktree tool cannot attach a second repository in this project; created an isolated Git worktree manually.

- Multi-step callbacks create a new attempt per authorization phase because oauth_code_claims permits one code per attempt.
- Complete sparse ledger days fill zero only for already eligible known bindings. Credited amounts are truncated to eight decimals before 0.25 gross-up to avoid rounding overpayment.
- Scoped bing@accedra.xyz provider provisioned at 0.25, internal destination 7, CCMAX origin restriction, no agent invites or withdrawal key scopes; secrets stored outside Git.

- Fresh whole-branch review found an OAuth lost-response/import race. Shared guarded inventory import now preserves OAuth completion for already owned accounts, whether previously verified or not, in both sync and daily billing paths. Regression demonstrated failure first; both recovery cases now pass. Independent reviewer reran 19 adapter/integration tests and found no remaining must-fix issues.

- Final complete suite: 385 tests in 29 files passed (82.40s). TypeScript check and production build passed. Live adapter read-only accounts and exact balance schema smoke passed. Supporting Accedra PR60 merged; production deployment queued behind other existing runner work.
