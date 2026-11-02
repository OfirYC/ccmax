import type { DB } from './db.js';
import { id } from './core.js';

// Remove only open Platform A estimates that are demonstrably a carried-over
// counter: the account is disabled and the exact positive amount already
// existed on the immediately preceding Beijing billing day. Finalized or
// invoiced records are never touched.
export async function applyStaleLiveSnapshotReconciliation(tx:DB) {
  const stale=await tx.query(`SELECT u.id FROM usage_days u
    JOIN bindings b ON b.id=u.binding_id JOIN connections c ON c.id=b.connection_id
    JOIN usage_days previous ON previous.binding_id=u.binding_id
      AND previous.day=(u.day-interval '1 day')::date AND previous.raw_usd=u.raw_usd
    WHERE c.provider='gatelink' AND (b.status='disabled' OR NOT b.local_enabled)
      AND u.state='provisional' AND u.source='live_snapshot' AND u.raw_usd>0
      AND previous.source IN ('live_snapshot','daily_snapshot')
      AND NOT EXISTS(SELECT 1 FROM invoice_items x JOIN earnings e ON e.id=x.earning_id WHERE e.usage_id=u.id)
    ORDER BY u.id`);
  if(!stale.length)return {removed:0};
  const usageIds=stale.map(row=>row.id);
  await tx.query('DELETE FROM earnings WHERE usage_id=ANY($1::text[])',[usageIds]);
  await tx.query("DELETE FROM usage_days WHERE id=ANY($1::text[]) AND state='provisional'",[usageIds]);
  await tx.query(`INSERT INTO audits(id,actor_id,action,details) VALUES($1,NULL,'usage.stale_live_snapshot_reconcile',$2)`,
    [id(),JSON.stringify({usageIds,reason:'disabled Gatelink account repeated the prior-day live estimate'})]);
  return {removed:usageIds.length};
}
