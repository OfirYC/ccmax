import type { DB } from './db.js';

export async function snapshotRecoveryMigration(tx: DB) {
  // Older live-usage rows record when CCMAX observed a daily counter, but do
  // not retain the upstream timestamp. Preserve that distinction on recovery.
  await tx.query('ALTER TABLE billing_snapshots ALTER COLUMN source_at DROP NOT NULL');
  await tx.query("ALTER TABLE billing_snapshots ADD COLUMN origin text NOT NULL DEFAULT 'upstream' CHECK(origin IN ('upstream','usage_archive'))");
  await tx.query("ALTER TABLE billing_snapshots ADD CONSTRAINT billing_snapshot_timestamp CHECK(source_at IS NOT NULL OR origin='usage_archive')");
  await tx.query('CREATE INDEX billing_snapshots_observed_latest ON billing_snapshots(binding_id,day,(COALESCE(source_at,collected_at)) DESC,collected_at DESC)');
  await tx.query('ALTER TABLE billing_days ADD COLUMN source_error text');
  await tx.query('ALTER TABLE billing_days DROP CONSTRAINT billing_days_state_check');
  await tx.query(`ALTER TABLE billing_days ADD CONSTRAINT billing_days_state_check
    CHECK(state IN ('queued','running','succeeded','failed','needs_attention','awaiting_data'))`);
  // A denied history endpoint is an expected source fallback, not a failed
  // snapshot bill. Revisit pre-upgrade days immediately to recover old data.
  await tx.query(`UPDATE billing_days d SET source_error=d.error,error=NULL,basis='snapshot',
    state=CASE WHEN d.state='failed' THEN 'awaiting_data' ELSE d.state END,next_attempt_at=now()
    FROM connections c WHERE c.id=d.connection_id AND c.snapshot_billing
    AND (d.basis='snapshot' OR d.error ~ 'HTTP (403|404)')`);
}
