# Combined Withdrawable Funds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Include confirmed downstream team funding in the existing withdrawable balance and withdrawal flow without recording it as personal profit.

**Architecture:** Add a separate append-only team-fund ledger and record how much of each withdrawal uses team funding. The API combines personal and team ledgers into one withdrawable amount, while database guards and reconciliation keep both sources independently auditable. A migration backfills team funding from existing confirmed invoices, so historical pending team obligations become withdrawable immediately.

**Tech Stack:** TypeScript, Fastify, PostgreSQL/PGlite, React, Vitest

**Spec:** Conversation request: use one existing withdrawable balance and withdrawal action for personal profit plus confirmed team-payment funds.

## Global Constraints

- Keep one user-facing withdrawable balance and one withdrawal workflow.
- Preserve internal distinction between personal profit and team-payment funds.
- Backfill existing confirmed invoice downstream amounts without manual data reconciliation.
- Prevent duplicate credits, holds, releases, and withdrawals.
- Preserve the existing provisional-snapshot reconciliation workflow; this PR does not manufacture the missing $146.50 invoice.

## Review Focus

- Existing confirmed invoices receive exactly one backfilled team-funding credit.
- A withdrawal spanning personal and team funds cannot exceed their combined available amount.
- A rejected mixed withdrawal restores each source exactly once.
- A later personal loss cannot be hidden by team funds when reviewing the personal portion of a pending withdrawal.
- Re-running migrations or invoice confirmation cannot duplicate team funding.

---

### Task 1: Team-fund ledger and combined withdrawal accounting

**Files:**
- Modify: `server/schema.sql`
- Modify: `server/migrations.ts`
- Modify: `server/db.ts`
- Modify: `server/billing.ts`
- Modify: `server/financial-integrity.ts`
- Modify: `server/finance-audit.ts`
- Test: `server/finance.test.ts`
- Test: `server/migration.test.ts`

**Interfaces:**
- Produces: `balance(db, userId)` returning one combined `available` amount backed by personal and team ledgers.
- Produces: withdrawal rows with immutable `team_amount_usd` allocation.
- Produces: append-only `team_fund_ledger` entries sourced by confirmed invoices and withdrawals.

- [ ] **Step 1: Write failing finance tests** proving a confirmed `$70` gross invoice (`$40` profit + `$30` downstream) exposes `$70` through the existing balance and supports a mixed withdrawal/rejection without duplicate restoration.
- [ ] **Step 2: Run `npm test -- server/finance.test.ts`** and verify failure because only `$40` is currently withdrawable.
- [ ] **Step 3: Implement the team-fund ledger, withdrawal allocation, source guards, and wallet reconciliation.**
- [ ] **Step 4: Run `npm test -- server/finance.test.ts`** and verify the focused suite passes.
- [ ] **Step 5: Write and run a migration regression test** proving a v20-style confirmed invoice is backfilled exactly once across repeated `migrate()` calls.
- [ ] **Step 6: Update financial-audit reporting to distinguish personal profit from combined withdrawable funds and run `npm test -- server/finance.test.ts server/migration.test.ts`.**
- [ ] **Step 7: Commit the backend and migration change.**

### Task 2: Present the combined balance accurately

**Files:**
- Modify: `src/pages/Finance.tsx`
- Modify: `src/locales/en.json`
- Modify: `src/locales/hi.json`
- Modify: `src/locales/vi.json`
- Modify: `docs/FINANCIAL_AUDIT.md`

**Interfaces:**
- Consumes: the combined `balance.available` and team-fund breakdown produced by Task 1.
- Produces: one withdrawable card and one withdrawal action whose copy states that funded team payables are included.

- [ ] **Step 1: Update the finance-page labels and explanatory copy** without adding a second withdrawal action.
- [ ] **Step 2: Run `npm run check` and `npm run build`.**
- [ ] **Step 3: Run the full `npm test` suite.**
- [ ] **Step 4: Commit the UI/documentation change.**
