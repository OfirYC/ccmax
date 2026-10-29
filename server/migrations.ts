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
        IF OLD.proxy_id IS NOT NULL AND NEW.proxy_id IS DISTINCT FROM OLD.proxy_id AND NOT OLD.ownership_verified THEN
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

// Compatibility upgrade: verified accounts can rotate their fixed proxy without deleting the
// account. Existing proxy bindings are cleared before synchronization jobs are
// queued, so a failed upstream write cannot leave a binding claiming the old
// account proxy. Unverified placeholder accounts retain the original
// immutable behavior until ownership is confirmed.
export async function accountProxyRotation(tx:DB) {
  await tx.query('DROP TRIGGER IF EXISTS account_proxy ON accounts');
  await tx.query(`CREATE OR REPLACE FUNCTION ccmax_guard_proxy() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_TABLE_NAME='accounts' THEN
        IF OLD.proxy_id IS NOT NULL AND NEW.proxy_id IS DISTINCT FROM OLD.proxy_id AND NOT OLD.ownership_verified THEN
          RAISE EXCEPTION 'CCMAX: account proxy is immutable' USING ERRCODE='23514';
        END IF;
      ELSIF (NEW.id,NEW.owner_id,NEW.secret,NEW.fingerprint,NEW.endpoint) IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.secret,OLD.fingerprint,OLD.endpoint) THEN
        RAISE EXCEPTION 'CCMAX: proxy identity is immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END
  $$`);
  await tx.query('CREATE TRIGGER account_proxy BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION ccmax_guard_proxy()');
}

// Compatibility upgrade: upstream status and local CCMAX usage are independent. This lets a
// CCMAX owner pause Platform A usage when the upstream account credentials do
// not have permission to change the upstream account itself.
export async function bindingUsageControls(tx:DB) {
  await tx.query('ALTER TABLE bindings ADD COLUMN IF NOT EXISTS local_enabled boolean NOT NULL DEFAULT true');
  await tx.query('CREATE INDEX IF NOT EXISTS bindings_local_enabled ON bindings(local_enabled)');
}

export async function extendProviders(tx: DB, tables:('connections'|'rates'|'invitation_rates')[]=['connections','rates']) {
  // Existing deployments retain their connections, rates and financial history.
  // New platform prices require an explicit contract; never copy another rate.
  const allowed=PROVIDER_KEYS.map(p=>`'${p}'`).join(',');
  for(const table of tables) {
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

// Preserve signed contractual losses while keeping invoice-source and hold/release guards.
// Existing finalized amounts and append-only history are never rewritten.
export async function signedSettlementSources(tx: DB) {
  await tx.query(`CREATE OR REPLACE FUNCTION ccmax_guard_ledger_source() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind='settlement' THEN
        IF NOT EXISTS(SELECT 1 FROM invoices i WHERE i.id=NEW.reference_id AND i.user_id=NEW.user_id
          AND i.state='confirmed' AND i.profit_usd=NEW.amount_usd) THEN
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
}

// Key supply workspace: task-scoped New API connections, encrypted supplier
// keys and append-only usage/settlement observations. This is deliberately
// separate from the Claude account tables so existing financial history keeps
// its original meaning and constraints.
export async function keyMarket(tx: DB) {
  await tx.query('ALTER TABLE ledger DROP CONSTRAINT IF EXISTS ledger_kind_check');
  await tx.query(`ALTER TABLE ledger ADD CONSTRAINT ledger_kind_check CHECK(kind IN ('settlement','task_settlement','task_adjustment','withdrawal_hold','withdrawal_release'))`);
  await tx.query('ALTER TABLE ledger DROP CONSTRAINT IF EXISTS ledger_direction');
  await tx.query(`ALTER TABLE ledger ADD CONSTRAINT ledger_direction CHECK(
    kind IN ('settlement','task_settlement','task_adjustment') OR
    (kind='withdrawal_hold' AND amount_usd<0) OR (kind='withdrawal_release' AND amount_usd>0))`);
  await tx.query(`CREATE TABLE workspaces (
    id text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('earnings','key_market')),
    name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(kind)
  )`);
  await tx.query(`CREATE TABLE workspace_members (
    workspace_id text NOT NULL REFERENCES workspaces(id), user_id text NOT NULL REFERENCES users(id),
    role text NOT NULL CHECK(role IN ('owner','agent','supplier','viewer')),
    active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(workspace_id,user_id)
  )`);
  await tx.query('CREATE INDEX workspace_members_user ON workspace_members(user_id,active)');
  await tx.query(`CREATE TABLE new_api_connections (
    id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), name text NOT NULL,
    base_url text NOT NULL, auth_type text NOT NULL CHECK(auth_type IN ('password','access_token')),
    credentials text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','connected','error','disabled')),
    quota_per_unit numeric(24,8), last_sync_at timestamptz, last_error text,
    created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(workspace_id,base_url)
  )`);
  await tx.query(`CREATE TABLE key_tasks (
    id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id),
    new_api_connection_id text NOT NULL REFERENCES new_api_connections(id),
    name text NOT NULL, resource_type text NOT NULL, provider text NOT NULL, models text[] NOT NULL DEFAULT '{}',
    description text NOT NULL DEFAULT '', root_rate numeric(5,4) NOT NULL DEFAULT 1 CHECK(root_rate>=0 AND root_rate<=1),
    state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published','paused','closed')),
    published_at timestamptz, closed_at timestamptz, created_by text NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await tx.query(`CREATE TABLE task_rates (
    id text PRIMARY KEY, task_id text NOT NULL REFERENCES key_tasks(id), user_id text NOT NULL REFERENCES users(id),
    rate numeric(5,4) NOT NULL CHECK(rate>=0 AND rate<=1), effective_date date NOT NULL,
    created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(task_id,user_id,effective_date)
  )`);
  await tx.query('CREATE INDEX task_rates_lookup ON task_rates(task_id,user_id,effective_date DESC)');
  await tx.query(`CREATE TABLE task_channels (
    id text PRIMARY KEY, task_id text NOT NULL REFERENCES key_tasks(id), supplier_user_id text NOT NULL REFERENCES users(id),
    secret text NOT NULL, fingerprint text NOT NULL, token_masked text NOT NULL, external_channel_id text,
    name text NOT NULL DEFAULT '', site text NOT NULL DEFAULT '', resource_type text NOT NULL DEFAULT '',
    models text[] NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','testing','active','paused','auto_disabled','rejected','deleted','error')),
    used_quota bigint NOT NULL DEFAULT 0, used_usd numeric(24,8) NOT NULL DEFAULT 0,
    last_sync_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(task_id,fingerprint), UNIQUE(task_id,external_channel_id)
  )`);
  await tx.query('CREATE INDEX task_channels_supplier ON task_channels(supplier_user_id,status)');
  await tx.query(`CREATE TABLE task_usage_snapshots (
    id text PRIMARY KEY, channel_id text NOT NULL REFERENCES task_channels(id), external_channel_id text NOT NULL,
    used_quota bigint NOT NULL CHECK(used_quota>=0), quota_per_unit numeric(24,8) NOT NULL CHECK(quota_per_unit>0),
    used_usd numeric(24,8) NOT NULL CHECK(used_usd>=0), delta_quota bigint NOT NULL DEFAULT 0,
    delta_usd numeric(24,8) NOT NULL DEFAULT 0, observed_at timestamptz NOT NULL,
    source_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(channel_id,source_hash)
  )`);
  await tx.query(`CREATE TABLE task_settlement_entries (
    id text PRIMARY KEY, snapshot_id text NOT NULL REFERENCES task_usage_snapshots(id),
    user_id text NOT NULL REFERENCES users(id), payer_id text REFERENCES users(id), next_user_id text REFERENCES users(id),
    rate numeric(5,4) NOT NULL, downstream_rate numeric(5,4) NOT NULL,
    gross_usd numeric(24,8) NOT NULL, downstream_usd numeric(24,8) NOT NULL,
    profit_usd numeric(24,8) NOT NULL, kind text NOT NULL CHECK(kind IN ('task_settlement','task_adjustment')),
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(snapshot_id,user_id,kind)
  )`);
  await tx.query('CREATE INDEX task_settlement_user ON task_settlement_entries(user_id,created_at DESC)');
  await tx.query(`CREATE TRIGGER task_settlement_append_only BEFORE UPDATE OR DELETE ON task_settlement_entries
    FOR EACH ROW EXECUTE FUNCTION ccmax_reject_change()`);
  await tx.query(`CREATE OR REPLACE FUNCTION ccmax_guard_ledger_source() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind='settlement' THEN
        IF NOT EXISTS(SELECT 1 FROM invoices i WHERE i.id=NEW.reference_id AND i.user_id=NEW.user_id
          AND i.state='confirmed' AND i.profit_usd=NEW.amount_usd) THEN
          RAISE EXCEPTION 'CCMAX: settlement ledger source mismatch' USING ERRCODE='23514';
        END IF;
      ELSIF NEW.kind IN ('task_settlement','task_adjustment') THEN
        IF NOT EXISTS(SELECT 1 FROM task_settlement_entries e WHERE e.id=NEW.reference_id
          AND e.user_id=NEW.user_id AND e.kind=NEW.kind AND e.profit_usd=NEW.amount_usd) THEN
          RAISE EXCEPTION 'CCMAX: task settlement ledger source mismatch' USING ERRCODE='23514';
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
}

// A single New API instance may host several independently priced tasks.  The
// task owns the binding; the connection itself is reusable across tasks.
export async function keyMarketSharedConnections(tx: DB) {
  await tx.query('ALTER TABLE key_tasks DROP CONSTRAINT IF EXISTS key_tasks_new_api_connection_id_key');
}

// Store the observed counter increment explicitly so a financial reviewer can
// reconcile a settlement entry without reconstructing it from later snapshots.
export async function keyMarketSnapshotDeltas(tx: DB) {
  await tx.query('ALTER TABLE task_usage_snapshots ADD COLUMN IF NOT EXISTS delta_quota bigint NOT NULL DEFAULT 0');
  await tx.query('ALTER TABLE task_usage_snapshots ADD COLUMN IF NOT EXISTS delta_usd numeric(24,8) NOT NULL DEFAULT 0');
  await tx.query(`WITH ordered AS (
    SELECT id,used_quota,quota_per_unit,LAG(used_quota,1,0) OVER(PARTITION BY channel_id ORDER BY observed_at,created_at,id) AS previous_quota
    FROM task_usage_snapshots
  ) UPDATE task_usage_snapshots s SET delta_quota=o.used_quota-o.previous_quota,
    delta_usd=ROUND((o.used_quota-o.previous_quota)::numeric/o.quota_per_unit,8) FROM ordered o WHERE s.id=o.id`);
  await tx.query(`CREATE TRIGGER task_usage_snapshot_append_only BEFORE UPDATE OR DELETE ON task_usage_snapshots
    FOR EACH ROW EXECUTE FUNCTION ccmax_reject_change()`);
}

export async function keyMarketSubmissionIdempotency(tx: DB) {
  await tx.query('ALTER TABLE task_channels ADD COLUMN IF NOT EXISTS idempotency_key text');
  await tx.query('CREATE UNIQUE INDEX IF NOT EXISTS task_channels_submission_idempotency ON task_channels(task_id,supplier_user_id,idempotency_key) WHERE idempotency_key IS NOT NULL');
}

// KeyMan is a tenant-aware NewAPI derivative. Keep its connection and form
// settings in the same isolated key-market tables while making the adapter
// choice explicit and preserving all existing standard New API rows.
export async function keyManTemplate(tx: DB) {
  await tx.query("ALTER TABLE new_api_connections ADD COLUMN IF NOT EXISTS adapter_type text NOT NULL DEFAULT 'standard_new_api'");
  await tx.query("ALTER TABLE new_api_connections DROP CONSTRAINT IF EXISTS new_api_connections_adapter_type_check");
  await tx.query("ALTER TABLE new_api_connections ADD CONSTRAINT new_api_connections_adapter_type_check CHECK(adapter_type IN ('standard_new_api','keyman_newapi'))");
  await tx.query('ALTER TABLE new_api_connections ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT \'1\'');
  await tx.query('ALTER TABLE key_tasks ADD COLUMN IF NOT EXISTS template_type text NOT NULL DEFAULT \'standard_new_api\'');
  await tx.query("ALTER TABLE key_tasks DROP CONSTRAINT IF EXISTS key_tasks_template_type_check");
  await tx.query("ALTER TABLE key_tasks ADD CONSTRAINT key_tasks_template_type_check CHECK(template_type IN ('standard_new_api','keyman_newapi'))");
  await tx.query('ALTER TABLE key_tasks ADD COLUMN IF NOT EXISTS gateway_id text');
  await tx.query('ALTER TABLE key_tasks ADD COLUMN IF NOT EXISTS template_config text NOT NULL DEFAULT \'{}\'');
  await tx.query('ALTER TABLE task_channels ADD COLUMN IF NOT EXISTS channel_type integer');
  await tx.query('ALTER TABLE task_channels ADD COLUMN IF NOT EXISTS base_url text NOT NULL DEFAULT \'\'');
  await tx.query('ALTER TABLE task_channels ADD COLUMN IF NOT EXISTS groups text[] NOT NULL DEFAULT \'{default}\'');
  await tx.query('ALTER TABLE task_channels ADD COLUMN IF NOT EXISTS model_mapping text NOT NULL DEFAULT \'{}\'');
  await tx.query('ALTER TABLE task_channels ADD COLUMN IF NOT EXISTS openai_organization text NOT NULL DEFAULT \'\'');
  await tx.query('ALTER TABLE task_channels ADD COLUMN IF NOT EXISTS test_model text NOT NULL DEFAULT \'\'');
  await tx.query('ALTER TABLE task_channels ADD COLUMN IF NOT EXISTS remark text NOT NULL DEFAULT \'\'');
  await tx.query('ALTER TABLE task_channels ADD COLUMN IF NOT EXISTS socks5_proxy_level text NOT NULL DEFAULT \'medium\'');
  await tx.query('ALTER TABLE task_channels ADD COLUMN IF NOT EXISTS auto_ban boolean NOT NULL DEFAULT true');
  await tx.query('ALTER TABLE task_channels ADD COLUMN IF NOT EXISTS settings text NOT NULL DEFAULT \'{}\'');
  await tx.query('ALTER TABLE task_channels ADD COLUMN IF NOT EXISTS setting text NOT NULL DEFAULT \'{}\'');
  await tx.query('ALTER TABLE task_channels ADD COLUMN IF NOT EXISTS param_override text NOT NULL DEFAULT \'\'');
  await tx.query('ALTER TABLE task_channels ADD COLUMN IF NOT EXISTS other text NOT NULL DEFAULT \'\'');
  await tx.query('ALTER TABLE task_channels ADD COLUMN IF NOT EXISTS status_code_mapping text NOT NULL DEFAULT \'\'');
  await tx.query('ALTER TABLE task_channels ADD COLUMN IF NOT EXISTS multi_key_mode text');
  await tx.query('ALTER TABLE task_channels ADD COLUMN IF NOT EXISTS key_mode text');
  await tx.query('CREATE INDEX IF NOT EXISTS key_tasks_template ON key_tasks(template_type,state)');
}

// Confirmed upstream gross includes both the member's profit and cash they must
// pass to their direct team. Keep the pass-through source separate internally,
// while allowing both sources to fund the same withdrawal request.
export async function combinedWithdrawableFunds(tx: DB) {
  await tx.query('ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS team_amount_usd numeric(24,8) NOT NULL DEFAULT 0');
  await tx.query('ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_team_amount_check');
  await tx.query(`ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_team_amount_check
    CHECK(team_amount_usd>=0 AND team_amount_usd<=amount_usd)`);
  await tx.query(`CREATE TABLE IF NOT EXISTS team_fund_ledger (
    id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),
    kind text NOT NULL CHECK(kind IN ('funding','withdrawal_hold','withdrawal_release')),
    amount_usd numeric(24,8) NOT NULL,reference_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(kind,reference_id))`);
  await tx.query('CREATE INDEX IF NOT EXISTS team_fund_ledger_user ON team_fund_ledger(user_id)');
  await tx.query('DROP TRIGGER IF EXISTS team_fund_ledger_append_only ON team_fund_ledger');
  await tx.query(`CREATE TRIGGER team_fund_ledger_append_only BEFORE UPDATE OR DELETE ON team_fund_ledger
    FOR EACH ROW EXECUTE FUNCTION ccmax_reject_change()`);
  await tx.query('DROP TRIGGER IF EXISTS team_fund_source ON team_fund_ledger');
  await tx.query(`CREATE OR REPLACE FUNCTION ccmax_guard_team_fund_source() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind='funding' THEN
        IF NOT EXISTS(SELECT 1 FROM invoices i WHERE i.id=NEW.reference_id AND i.user_id=NEW.user_id
          AND i.state='confirmed' AND i.downstream_usd=NEW.amount_usd AND NEW.amount_usd>0) THEN
          RAISE EXCEPTION 'CCMAX: team funding source mismatch' USING ERRCODE='23514';
        END IF;
      ELSIF NEW.kind='withdrawal_hold' THEN
        IF NOT EXISTS(SELECT 1 FROM withdrawals w WHERE w.id=NEW.reference_id AND w.user_id=NEW.user_id
          AND w.state='pending' AND w.team_amount_usd>0 AND -w.team_amount_usd=NEW.amount_usd) THEN
          RAISE EXCEPTION 'CCMAX: team funding hold source mismatch' USING ERRCODE='23514';
        END IF;
      ELSIF NEW.kind='withdrawal_release' THEN
        IF NOT EXISTS(SELECT 1 FROM withdrawals w JOIN team_fund_ledger h
          ON h.reference_id=w.id AND h.kind='withdrawal_hold' WHERE w.id=NEW.reference_id
          AND w.user_id=NEW.user_id AND w.state='rejected' AND w.team_amount_usd=NEW.amount_usd
          AND h.user_id=w.user_id AND h.amount_usd=-w.team_amount_usd) THEN
          RAISE EXCEPTION 'CCMAX: team funding release source mismatch' USING ERRCODE='23514';
        END IF;
      END IF;
      RETURN NEW;
    END $$`);
  await tx.query(`CREATE TRIGGER team_fund_source BEFORE INSERT ON team_fund_ledger
    FOR EACH ROW EXECUTE FUNCTION ccmax_guard_team_fund_source()`);
  await tx.query('DROP TRIGGER IF EXISTS withdrawals_sealed ON withdrawals');
  await tx.query(`CREATE OR REPLACE FUNCTION ccmax_guard_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CCMAX: withdrawals cannot be deleted' USING ERRCODE='23514'; END IF;
      IF OLD.state<>'pending' OR (NEW.id,NEW.user_id,NEW.payer_id,NEW.amount_usd,NEW.team_amount_usd,NEW.method,NEW.destination,NEW.idempotency_key)
        IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.payer_id,OLD.amount_usd,OLD.team_amount_usd,OLD.method,OLD.destination,OLD.idempotency_key) THEN
        RAISE EXCEPTION 'CCMAX: withdrawal identity and processed records are immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`);
  await tx.query(`CREATE TRIGGER withdrawals_sealed BEFORE UPDATE OR DELETE ON withdrawals
    FOR EACH ROW EXECUTE FUNCTION ccmax_guard_withdrawal()`);
  await tx.query(`CREATE OR REPLACE FUNCTION ccmax_guard_ledger_source() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind='settlement' THEN
        IF NOT EXISTS(SELECT 1 FROM invoices i WHERE i.id=NEW.reference_id AND i.user_id=NEW.user_id
          AND i.state='confirmed' AND i.profit_usd=NEW.amount_usd) THEN
          RAISE EXCEPTION 'CCMAX: settlement ledger source mismatch' USING ERRCODE='23514';
        END IF;
      ELSIF NEW.kind IN ('task_settlement','task_adjustment') THEN
        IF NOT EXISTS(SELECT 1 FROM task_settlement_entries e WHERE e.id=NEW.reference_id
          AND e.user_id=NEW.user_id AND e.kind=NEW.kind AND e.profit_usd=NEW.amount_usd) THEN
          RAISE EXCEPTION 'CCMAX: task settlement ledger source mismatch' USING ERRCODE='23514';
        END IF;
      ELSIF NEW.kind='withdrawal_hold' THEN
        IF NOT EXISTS(SELECT 1 FROM withdrawals w WHERE w.id=NEW.reference_id AND w.user_id=NEW.user_id
          AND w.amount_usd>w.team_amount_usd AND w.state='pending'
          AND -(w.amount_usd-w.team_amount_usd)=NEW.amount_usd) THEN
          RAISE EXCEPTION 'CCMAX: withdrawal hold source mismatch' USING ERRCODE='23514';
        END IF;
      ELSIF NEW.kind='withdrawal_release' THEN
        IF NOT EXISTS(SELECT 1 FROM withdrawals w JOIN ledger h ON h.reference_id=w.id AND h.kind='withdrawal_hold'
          WHERE w.id=NEW.reference_id AND w.user_id=NEW.user_id AND w.state='rejected'
            AND w.amount_usd-w.team_amount_usd=NEW.amount_usd AND h.user_id=w.user_id
            AND h.amount_usd=-(w.amount_usd-w.team_amount_usd)) THEN
          RAISE EXCEPTION 'CCMAX: withdrawal release source mismatch' USING ERRCODE='23514';
        END IF;
      END IF;
      RETURN NEW;
    END $$`);
  await tx.query(`INSERT INTO team_fund_ledger(id,user_id,kind,amount_usd,reference_id,created_at)
    SELECT md5(i.id||':team-funding'),i.user_id,'funding',i.downstream_usd,i.id,COALESCE(i.confirmed_at,i.created_at)
    FROM invoices i WHERE i.state='confirmed' AND i.downstream_usd>0 ON CONFLICT(kind,reference_id) DO NOTHING`);
}
