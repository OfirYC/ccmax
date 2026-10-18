import type { DB } from './db.js';
import { PROVIDER_KEYS } from './providers.js';

export async function extendProviders(tx: DB) {
  // Existing deployments retain their connections, rates and financial history.
  // New platform prices require an explicit contract; never copy another rate.
  const allowed=PROVIDER_KEYS.map(p=>`'${p}'`).join(',');
  for(const table of ['connections','rates']) {
    await tx.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_provider_check`);
    await tx.query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_provider_check CHECK(provider IN (${allowed}))`);
  }
}

// Each query is one SQL statement, including function bodies. This works in
// PostgreSQL and PGlite without splitting procedural SQL on semicolons.
export async function hardenSchema(tx: DB) {
  await tx.query('ALTER TABLE accounts ADD COLUMN ownership_verified boolean NOT NULL DEFAULT false');
  await tx.query(`UPDATE accounts a SET ownership_verified=true WHERE owner_id IS NOT NULL AND EXISTS(
    SELECT 1 FROM audits x WHERE x.target_id=a.id AND (x.action='account.assign' OR (x.action='account.submitted' AND x.actor_id=a.owner_id)))`);
  await tx.query('ALTER TABLE withdrawals ADD COLUMN idempotency_key text');
  await tx.query('CREATE UNIQUE INDEX withdrawals_idempotency ON withdrawals(user_id,idempotency_key)');
  await tx.query('ALTER TABLE jobs ADD COLUMN subject_id text');
  await tx.query('ALTER TABLE jobs ADD COLUMN request_hash text');
  await tx.query(`CREATE UNIQUE INDEX jobs_one_submission ON jobs(connection_id,subject_id)
    WHERE subject_id IS NOT NULL AND kind IN ('oauth_start','oauth_exchange','import_rt') AND state IN ('queued','running')`);
  await tx.query(`ALTER TABLE ledger ADD CONSTRAINT ledger_direction CHECK(
    kind='settlement' OR (kind='withdrawal_hold' AND amount_usd<0) OR (kind='withdrawal_release' AND amount_usd>0))`);
  await tx.query('ALTER TABLE usage_days ADD CONSTRAINT usage_root_rate_range CHECK(root_rate>=0 AND root_rate<=1)');
  await tx.query(`CREATE FUNCTION ccmax_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'CCMAX: append-only record' USING ERRCODE='23514'; END $$`);
  for (const table of ['ledger','audits','invoice_items']) {
    await tx.query(`CREATE TRIGGER ${table}_append_only BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ccmax_reject_change()`);
  }
  await tx.query(`CREATE FUNCTION ccmax_guard_usage() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.state='final' THEN RAISE EXCEPTION 'CCMAX: finalized usage is immutable' USING ERRCODE='23514'; END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$`);
  await tx.query(`CREATE TRIGGER usage_sealed BEFORE UPDATE OR DELETE ON usage_days FOR EACH ROW EXECUTE FUNCTION ccmax_guard_usage()`);
  await tx.query(`CREATE FUNCTION ccmax_guard_earning() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS(SELECT 1 FROM invoice_items WHERE earning_id=OLD.id)
        OR EXISTS(SELECT 1 FROM usage_days WHERE id=OLD.usage_id AND state='final') THEN
        RAISE EXCEPTION 'CCMAX: sealed earning is immutable' USING ERRCODE='23514';
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$`);
  await tx.query(`CREATE TRIGGER earnings_sealed BEFORE UPDATE OR DELETE ON earnings FOR EACH ROW EXECUTE FUNCTION ccmax_guard_earning()`);
  await tx.query(`CREATE FUNCTION ccmax_guard_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CCMAX: invoices cannot be deleted' USING ERRCODE='23514'; END IF;
      IF OLD.state='confirmed' OR (NEW.id,NEW.user_id,NEW.payer_id,NEW.gross_usd,NEW.downstream_usd,NEW.profit_usd,NEW.date_from,NEW.date_to)
        IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.payer_id,OLD.gross_usd,OLD.downstream_usd,OLD.profit_usd,OLD.date_from,OLD.date_to) THEN
        RAISE EXCEPTION 'CCMAX: invoice amount and confirmed records are immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`);
  await tx.query(`CREATE TRIGGER invoices_sealed BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION ccmax_guard_invoice()`);
  await tx.query(`CREATE FUNCTION ccmax_guard_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CCMAX: withdrawals cannot be deleted' USING ERRCODE='23514'; END IF;
      IF OLD.state<>'pending' OR (NEW.id,NEW.user_id,NEW.payer_id,NEW.amount_usd,NEW.method,NEW.destination,NEW.idempotency_key)
        IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.payer_id,OLD.amount_usd,OLD.method,OLD.destination,OLD.idempotency_key) THEN
        RAISE EXCEPTION 'CCMAX: withdrawal identity and processed records are immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`);
  await tx.query(`CREATE TRIGGER withdrawals_sealed BEFORE UPDATE OR DELETE ON withdrawals FOR EACH ROW EXECUTE FUNCTION ccmax_guard_withdrawal()`);
  await tx.query(`ALTER TABLE earnings ADD CONSTRAINT earning_arithmetic CHECK(profit_usd=gross_usd-downstream_usd AND rate BETWEEN 0 AND 1 AND downstream_rate BETWEEN 0 AND 1)`);
  await tx.query(`ALTER TABLE invoices ADD CONSTRAINT invoice_arithmetic CHECK(profit_usd=gross_usd-downstream_usd AND date_from<=date_to)`);
  await tx.query(`CREATE FUNCTION ccmax_guard_identity() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_TABLE_NAME='users' AND (NEW.id,NEW.parent_id,NEW.role) IS DISTINCT FROM (OLD.id,OLD.parent_id,OLD.role) THEN
        RAISE EXCEPTION 'CCMAX: agent hierarchy is immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`);
  await tx.query(`CREATE TRIGGER user_hierarchy BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION ccmax_guard_identity()`);
  await tx.query(`CREATE FUNCTION ccmax_guard_account() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.ownership_verified AND (NEW.id,NEW.owner_id,NEW.email,NEW.ownership_verified)
        IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.email,OLD.ownership_verified) THEN
        RAISE EXCEPTION 'CCMAX: verified ownership is immutable' USING ERRCODE='23514';
      END IF;
      IF (NEW.owner_id,NEW.email) IS DISTINCT FROM (OLD.owner_id,OLD.email) AND EXISTS(
        SELECT 1 FROM bindings b JOIN usage_days u ON u.binding_id=b.id WHERE b.account_id=OLD.id AND u.state='final') THEN
        RAISE EXCEPTION 'CCMAX: ownership with finalized history is immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`);
  await tx.query(`CREATE TRIGGER account_ownership BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION ccmax_guard_account()`);
  await tx.query(`CREATE INDEX accounts_owner ON accounts(owner_id)`);
  await tx.query(`CREATE INDEX bindings_account ON bindings(account_id)`);
  await tx.query(`CREATE INDEX invoices_payer ON invoices(payer_id)`);
  await tx.query(`CREATE INDEX withdrawals_payer ON withdrawals(payer_id,state)`);
}
