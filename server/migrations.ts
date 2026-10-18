import type { DB } from './db.js';
import { PROVIDER_KEYS } from './providers.js';

export async function financialSources(tx: DB) {
  // Apply to new writes only; legacy balances are reconciled before withdrawal.
  // Do not rewrite or manufacture source documents for historical ledger rows.
  await tx.query(`CREATE FUNCTION ccmax_guard_earning_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM id FROM usage_days WHERE id=NEW.usage_id FOR UPDATE;
      IF EXISTS(SELECT 1 FROM usage_days WHERE id=NEW.usage_id AND state='final') THEN
        RAISE EXCEPTION 'CCMAX: sealed earning is immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`);
  await tx.query('CREATE TRIGGER earnings_insert_sealed BEFORE INSERT ON earnings FOR EACH ROW EXECUTE FUNCTION ccmax_guard_earning_insert()');
  await tx.query(`CREATE FUNCTION ccmax_guard_invoice_item() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE bill invoices%ROWTYPE; item earnings%ROWTYPE; usage_day date; usage_state text;
    BEGIN
      SELECT * INTO bill FROM invoices WHERE id=NEW.invoice_id FOR UPDATE;
      SELECT * INTO item FROM earnings WHERE id=NEW.earning_id;
      SELECT day,state INTO usage_day,usage_state FROM usage_days WHERE id=item.usage_id;
      IF bill.id IS NULL OR bill.state<>'pending' OR item.id IS NULL OR item.user_id<>bill.user_id
        OR item.payer_id IS DISTINCT FROM bill.payer_id OR usage_state IS DISTINCT FROM 'final'
        OR usage_day NOT BETWEEN bill.date_from AND bill.date_to THEN
        RAISE EXCEPTION 'CCMAX: invoice item source mismatch or confirmed invoice' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`);
  await tx.query('CREATE TRIGGER invoice_item_source BEFORE INSERT ON invoice_items FOR EACH ROW EXECUTE FUNCTION ccmax_guard_invoice_item()');
  await tx.query(`CREATE FUNCTION ccmax_guard_ledger_source() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind='settlement' THEN
        IF NOT EXISTS(SELECT 1 FROM invoices i WHERE i.id=NEW.reference_id AND i.user_id=NEW.user_id
          AND i.state='confirmed' AND i.profit_usd=NEW.amount_usd AND NEW.amount_usd>=0) THEN
          RAISE EXCEPTION 'CCMAX: settlement ledger source mismatch' USING ERRCODE='23514';
        END IF;
      ELSIF NEW.kind='withdrawal_hold' THEN
        IF NOT EXISTS(SELECT 1 FROM withdrawals w WHERE w.id=NEW.reference_id AND w.user_id=NEW.user_id
          AND w.state='pending' AND -w.amount_usd=NEW.amount_usd) THEN
          RAISE EXCEPTION 'CCMAX: withdrawal hold source mismatch' USING ERRCODE='23514';
        END IF;
      ELSIF NEW.kind='withdrawal_release' THEN
        IF NOT EXISTS(SELECT 1 FROM withdrawals w JOIN ledger h ON h.reference_id=w.id AND h.kind='withdrawal_hold'
          WHERE w.id=NEW.reference_id AND w.user_id=NEW.user_id AND w.state='rejected' AND w.amount_usd=NEW.amount_usd
            AND h.user_id=w.user_id AND h.amount_usd=-w.amount_usd) THEN
          RAISE EXCEPTION 'CCMAX: withdrawal release source mismatch' USING ERRCODE='23514';
        END IF;
      END IF;
      RETURN NEW;
    END $$`);
  await tx.query('CREATE TRIGGER ledger_source BEFORE INSERT ON ledger FOR EACH ROW EXECUTE FUNCTION ccmax_guard_ledger_source()');
  await tx.query('CREATE INDEX invoice_items_invoice ON invoice_items(invoice_id)');
}

export async function integrationKeys(tx: DB) {
  await tx.query(`CREATE TABLE api_keys (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id),
    name text NOT NULL,
    prefix text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    scopes text[] NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    last_used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await tx.query('CREATE INDEX api_keys_user ON api_keys(user_id,created_at DESC)');
}

export async function accountProxies(tx:DB) {
  await tx.query('ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check');
  await tx.query("ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('sync','reconcile','oauth_start','oauth_exchange','import_rt','set_enabled','set_proxy'))");
  await tx.query('DROP INDEX jobs_one_submission');
  await tx.query(`CREATE UNIQUE INDEX jobs_one_submission ON jobs(connection_id,subject_id)
    WHERE subject_id IS NOT NULL AND kind IN ('oauth_start','oauth_exchange','import_rt','set_proxy') AND state IN ('queued','running')`);
  await tx.query(`CREATE TABLE proxies (
    id text PRIMARY KEY,owner_id text NOT NULL REFERENCES users(id),name text NOT NULL,
    endpoint text NOT NULL,secret text NOT NULL,fingerprint text NOT NULL UNIQUE,
    enabled boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now())`);
  await tx.query('ALTER TABLE accounts ADD COLUMN proxy_id text UNIQUE REFERENCES proxies(id)');
  await tx.query('ALTER TABLE bindings ADD COLUMN proxy_id text REFERENCES proxies(id)');
  await tx.query(`CREATE TABLE proxy_bindings (
    id text PRIMARY KEY,proxy_id text NOT NULL REFERENCES proxies(id),connection_id text NOT NULL REFERENCES connections(id),
    external_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(proxy_id,connection_id),UNIQUE(connection_id,external_id))`);
  await tx.query(`CREATE FUNCTION ccmax_guard_proxy() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_TABLE_NAME='accounts' THEN
        IF OLD.proxy_id IS NOT NULL AND NEW.proxy_id IS DISTINCT FROM OLD.proxy_id THEN
          RAISE EXCEPTION 'CCMAX: account proxy is immutable' USING ERRCODE='23514';
        END IF;
      ELSIF (NEW.id,NEW.owner_id,NEW.secret,NEW.fingerprint,NEW.endpoint) IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.secret,OLD.fingerprint,OLD.endpoint) THEN
        RAISE EXCEPTION 'CCMAX: proxy identity is immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`);
  await tx.query('CREATE TRIGGER account_proxy BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION ccmax_guard_proxy()');
  await tx.query('CREATE TRIGGER proxy_identity BEFORE UPDATE ON proxies FOR EACH ROW EXECUTE FUNCTION ccmax_guard_proxy()');
  await tx.query(`CREATE FUNCTION ccmax_guard_binding_proxy() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.proxy_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.account_id AND proxy_id=NEW.proxy_id) THEN
        RAISE EXCEPTION 'CCMAX: binding proxy differs from account proxy' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`);
  await tx.query('CREATE TRIGGER binding_proxy BEFORE INSERT OR UPDATE ON bindings FOR EACH ROW EXECUTE FUNCTION ccmax_guard_binding_proxy()');
  await tx.query('CREATE INDEX proxies_owner ON proxies(owner_id)');
}

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
