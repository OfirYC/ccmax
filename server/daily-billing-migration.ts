import type { DB } from './db.js';

export async function dailyBillingMigration(tx: DB) {
  await tx.query('ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check');
  await tx.query(`ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN
    ('sync','reconcile','daily_billing','billing_snapshot','oauth_start','oauth_exchange','import_rt','set_enabled','set_proxy'))`);
  await tx.query(`CREATE UNIQUE INDEX jobs_one_daily_bill ON jobs(connection_id,subject_id)
    WHERE kind='daily_billing' AND state IN ('queued','running')`);
  await tx.query('ALTER TABLE invoices ADD COLUMN automatic boolean NOT NULL DEFAULT false');
  await tx.query('ALTER TABLE invoices ADD COLUMN estimated boolean NOT NULL DEFAULT false');
  await tx.query('ALTER TABLE usage_days ADD COLUMN source_at timestamptz');
  await tx.query('ALTER TABLE jobs ADD COLUMN heartbeat_at timestamptz');
  await tx.query('ALTER TABLE connections ADD COLUMN snapshot_billing boolean NOT NULL DEFAULT false');
  await tx.query("UPDATE connections SET snapshot_billing=true WHERE provider='gatelink'");
  await tx.query(`CREATE UNIQUE INDEX jobs_one_billing_snapshot ON jobs(connection_id) WHERE kind='billing_snapshot' AND state IN ('queued','running')`);
  await tx.query(`CREATE TABLE billing_snapshots (
    binding_id text NOT NULL REFERENCES bindings(id),day date NOT NULL, collected_at timestamptz NOT NULL,
    source_at timestamptz NOT NULL, raw_usd numeric(24,8) NOT NULL CHECK(raw_usd>=0),
    PRIMARY KEY(binding_id,collected_at)
  )`);
  await tx.query('CREATE INDEX billing_snapshots_latest ON billing_snapshots(binding_id,day,source_at DESC,collected_at DESC)');
  await tx.query(`CREATE TRIGGER billing_snapshots_append_only BEFORE UPDATE OR DELETE ON billing_snapshots
    FOR EACH ROW EXECUTE FUNCTION ccmax_reject_change()`);
  // Keep every distinct upstream revision, including bills awaiting ownership or
  // pricing. Only normalized identifiers and amounts are retained, never tokens.
  await tx.query(`CREATE TABLE upstream_statements (
    id text PRIMARY KEY, connection_id text NOT NULL REFERENCES connections(id), day date NOT NULL,
    checksum text NOT NULL, basis text NOT NULL CHECK(basis IN ('upstream','snapshot')), rows jsonb NOT NULL, account_count integer NOT NULL CHECK(account_count>=0),
    raw_usd numeric(38,8) NOT NULL CHECK(raw_usd>=0), created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(connection_id,day,checksum)
  )`);
  await tx.query(`CREATE TRIGGER upstream_statements_append_only BEFORE UPDATE OR DELETE ON upstream_statements
    FOR EACH ROW EXECUTE FUNCTION ccmax_reject_change()`);
  await tx.query(`CREATE TABLE billing_days (
    connection_id text NOT NULL REFERENCES connections(id), day date NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed','needs_attention')),
    statement_id text REFERENCES upstream_statements(id), basis text CHECK(basis IN ('upstream','snapshot')), job_id text REFERENCES jobs(id),
    attempts integer NOT NULL DEFAULT 0, account_count integer NOT NULL DEFAULT 0,
    finalized_count integer NOT NULL DEFAULT 0, issue_count integer NOT NULL DEFAULT 0,
    issues jsonb NOT NULL DEFAULT '[]', error text, last_attempt_at timestamptz,
    next_attempt_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
    PRIMARY KEY(connection_id,day)
  )`);
  await tx.query('CREATE INDEX billing_days_retry ON billing_days(next_attempt_at)');
  await tx.query(`CREATE TABLE billing_entries (
    connection_id text NOT NULL, day date NOT NULL, external_id text NOT NULL,
    usage_id text REFERENCES usage_days(id), state text NOT NULL CHECK(state IN ('pending','recorded','blocked')),
    error text, PRIMARY KEY(connection_id,day,external_id),
    FOREIGN KEY(connection_id,day) REFERENCES billing_days(connection_id,day)
  )`);
  await tx.query('CREATE INDEX billing_entries_usage ON billing_entries(usage_id)');
  await tx.query('CREATE INDEX upstream_statements_day ON upstream_statements(day,connection_id)');
}
